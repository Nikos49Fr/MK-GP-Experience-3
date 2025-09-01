// /js/ui/classement.js
// ----------------------------------------------------
// Classement Widget — MK GP Experience 3
// - Modes d’affichage (pilotes 12/24, équipes 6/8, messages)
// - Texte d’état + défilement (marquee)
// - Données: Firestore (teams/pilots), RTDB (context, totals, finals, overrides)
// - Swap périodique TAG ↔ FICHE PILOTE (photo + numéro + nom défilant)
// ----------------------------------------------------

import { dbFirestore, dbRealtime } from '../firebase-config.js';
import {
    collection,
    getDocs
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';
import {
    ref,
    onValue
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

// ---- DEBUG overlay classement ----
const __CL_DEBUG = true;
function clDebug(...args) { if (__CL_DEBUG) console.log('[classement]', ...args); }

// ---- Auth (lecture RTDB sans éjecter un Google user) ----
import { app } from "../firebase-config.js";

const _authReady = (async () => {
    try {
        const { getAuth, onAuthStateChanged, signInAnonymously } =
            await import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js");

        const auth = getAuth(app);

        // 1) Attendre *le tout premier* état (inclut la restauration éventuelle d'une session Google)
        const firstUser = await new Promise((resolve) => {
            const unsub = onAuthStateChanged(auth, (user) => {
                unsub();
                resolve(user);
            });
        });

        if (firstUser) {
            clDebug('auth OK (restored) →', firstUser.isAnonymous ? 'anonymous' : (firstUser.email || 'google'));
        } else {
            clDebug('no user after initial restore → signing in anonymously…');
            await signInAnonymously(auth);
            clDebug('anonymous sign-in done');
        }

        // 2) Logs de suivi pour les changements *après* la restauration / l’anonymous
        onAuthStateChanged(auth, (user) => {
            clDebug('auth change →', user ? (user.isAnonymous ? 'anonymous' : (user.email || 'google')) : 'null');
        });
    } catch (e) {
        console.warn('[classement] auth bootstrap failed:', e);
    }
})();

// ----------------------
// Config timings (ajustables)
// ----------------------
const CFG = {
    // swap TAG ↔ FICHE
    tagStandbyMs: 15000,
    pilotScrollMs: 8000,
    pilotPauseEndMs: 3000,
    pilotBackPauseMs: 3000,
    pilotStartDelayMs: 3000,

    // marges visuelles du scroll (STATE header)
    stateGutterLeftPx: 20,
    stateGutterRightPx: 20,
    stateGutterPx: 0,
    stateEdgePadPx: 12,

    // 👉 alias pour le moteur de scroll des cellules (pilote/équipe)
    //    (avant on utilisait CFG.gutterPx / CFG.edgePadPx sans les définir)
    gutterPx: 12,
    edgePadPx: 12,

    // STATE (texte défilant)
    stateStartDelayMs: 3000,
    stateEndDelayMs: 2000,
    stateDurationMs: 5000,

    // Indicateur variation de rang
    changeIndicatorMs: 30000,

    // Lissage des updates
    totalsDebounceMs: 200,

    // Triangles stricts seulement si finalized
    indicatorsOnFinalizeOnly: false,
};

// ----------------------
// Modes / Presets
// ----------------------
const MODES = {
    'mk8-12':   { rows: 12, className: 'classement-widget--mk8-12', type: 'pilot'  },
    'mkw-24':   { rows: 24, className: 'classement-widget--mkw-24', type: 'pilot'  },
    'teams-6':  { rows: 6,  className: 'classement-widget--teams-6', type: 'team'  },
    'teams-8':  { rows: 8,  className: 'classement-widget--teams-8', type: 'team'  },

    // Messages
    'msg-prestart':      { rows: 0, className: 'classement-widget--msg-prestart', type: 'message' },
    'msg-mk8-noscores':  { rows: 0, className: 'classement-widget--msg-mk8-noscores', type: 'message' },
    'msg-mkw-noscores':  { rows: 0, className: 'classement-widget--msg-mkw-noscores', type: 'message' }
};

// ----------------------
// State global
// ----------------------
const state = {
    // contexte course
    phase: 'mk8',
    raceId: null,

    // données
    pilotsById: new Map(), // { id -> { tag, teamName, game, name, num, urlPhoto } }
    teamsByName: new Map(),
    totals: new Map(),
    unsubTotals: null,

    // finals
    mk8LastFinalized: false,
    mkwFinalFinalized: false,

    // sets d'ids de courses finalisées par phase
    mk8FinalizedRaceIds: new Set(),
    mkwFinalizedRaceIds: new Set(),

    // mode courant calculé ou forcé
    modeKey: 'mkw-24',

    // overrides (Direction de course)
    viewModeOverride: null,   // 'auto' | explicit
    viewScope: 'pilot',       // 'pilot' | 'team'

    // suivi des ordres/rangs pour afficher les triangles
    lastOrderKey: null,               // string | null (ex: "p1,p7,p4,...")
    lastRanksSnapshot: new Map(),     // Map<pilotId, rankNumber)

    // TTL par pilote (pilotId → timestamp ms jusqu'à quand afficher l’icône)
    indicatorUntil: new Map(),

    // mémorise la direction du dernier delta pendant le TTL (pilotId → -1 | +1)
    lastDeltaDir: new Map(),

    // --- snapshots tie-breaks
    byRaceSnapshot: {},
    posCounts: new Map(),       // Map<pilotId, Map<rank, count>>
    bonusDoubles: new Map(),    // Map<pilotId, number>

    // --- NEW: timer pour balayer les TTL et forcer un re-render à expiration
    indicatorSweepTimer: null,

    // --- race-state render guard (dédup + coalescing)
    raceStateLastText: null,
    raceStateRaf: null,

        // --- bonus (RTDB: live/results/...)
    unsubResultsBonus: null,     // unsubscribe byRace/{raceId}
    unsubBonusUsage: null,       // unsubscribe bonusUsage
    doublesLocked: false,        // fenêtre bonus fermée ?
    doublesSet: new Set(),       // Set<pilotId> armés sur la course courante
    bonusUsed: new Set(),        // Set<pilotId> bonus déjà consommé (définitif)

    adjustTotals: new Map(),      // Map<pilotId, number> — somme des ajustements (bonus/malus)
    unsubAdjustments: null,       // unsubscribe live/adjustments/... listener
};
// ---- Reveal ----
const PATH_REVEAL = 'context/reveal';
state.revealEnabled = false;

function subReveal(onChange) {
    const r = ref(dbRealtime, PATH_REVEAL);
    return onValue(r, (snap) => {
        const v = snap.val() || {};
        state.revealEnabled = !!v.enabled;
        if (typeof onChange === 'function') onChange(state.revealEnabled);
    });
}

// ----------------------
// Helpers
// ----------------------
function resolveAssetPath(storedPath) {
    if (!storedPath) return '';
    // Laisser passer les URLs absolues
    if (/^(https?:|data:|blob:)/i.test(storedPath)) return storedPath;

    // Ce fichier est /js/ui/classement.js → racine projet = ../../
    const projectRoot = new URL('../../', import.meta.url);

    // Normalisation forte
    let p = String(storedPath).trim();

    // Enlever ./ et / en tête
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('/'))  p = p.slice(1);

    // ⚠️ Neutraliser tous les ../ initiaux pour ne pas sortir du repo sur GH Pages
    p = p.replace(/^(\.\.\/)+/g, '');

    // Compléter les formes courantes :
    // - "assets/..." → OK
    // - "images/..." → préfixer "assets/"
    // - "team-1/ensuri.png" → préfixer "assets/images/"
    if (p.startsWith('assets/')) {
        // ok tel quel
    } else if (p.startsWith('images/')) {
        p = 'assets/' + p;
    } else if (!p.startsWith('assets/images/')) {
        p = 'assets/images/' + p;
    }

    return new URL(p, projectRoot).href;
}

function formatPoints(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v === 1) return '1 pt';
    return `${v} pts`;
}

function simpleRaceLabel({ phase, raceId }) {
    if (!phase) return '—';
    const up = String(phase).toUpperCase();
    if (!raceId) return `${up}`;
    if (raceId === 'S') return `${up} — Survie`;
    if (raceId === 'SF') return `${up} — Survie Finale`;
    return `${up} — Course ${raceId}`;
}

function isNumericRaceId(rid) {
    return typeof rid === 'string' && /^[0-9]+$/.test(rid);
}

function totalsWithAdjAllZeroOrEmpty() {
    // Si aucun total + aucun ajustement → vide
    if ((!state.totals || state.totals.size === 0) && (!state.adjustTotals || state.adjustTotals.size === 0)) {
        return true;
    }
    // Union des pilotes présents dans totals OU dans adjustments
    const unionIds = new Set();
    if (state.totals)       state.totals.forEach((_, pid) => unionIds.add(pid));
    if (state.adjustTotals) state.adjustTotals.forEach((_, pid) => unionIds.add(pid));

    for (const pid of unionIds) {
        const base = Number(state.totals?.get(pid) || 0);
        const adj  = Number(state.adjustTotals?.get?.(pid) || 0);
        if (base + adj > 0) return false;
    }
    return true;
}

// Phase TAG: texte simple (ellipsis géré par CSS)
function renderTagTextInto($tagCell, tag) {
    $tagCell.classList.remove('mode-pilot');
    $tagCell.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = tag || '';
    // teinte par équipe (injectée sur la ligne via --team-c1)
    span.style.color = 'var(--team-c1)';
    $tagCell.appendChild(span);
}

function renderTeamNameInto($tagCell, teamName) {
    const safeName = (teamName || '').toString().toUpperCase();

    $tagCell.classList.remove('mode-pilot'); // on s’assure d’un état propre
    $tagCell.innerHTML = `
        <div class="tagcard-scroller" style="
            display:inline-flex;align-items:center;gap:6px;
            will-change: transform;
            transform: translateX(${CFG.gutterPx}px);
            transition: none;
            flex: 0 0 auto;
            width: max-content;
            max-width: none;
            color: var(--team-c1);
        ">
            <span class="tagcard-name" style="white-space:nowrap;display:inline-block;">${safeName}</span>
        </div>
    `;
}

// Phase PILOT: scroller "num. NOM" (sans photo ici — la photo est dans .col-team)
function renderPilotNameInto($tagCell, { num, name }) {
    const safeNum = (num || '').toString();
    const safeName = (name || '').toString().toUpperCase().replace(/\s+/g, '');

    $tagCell.classList.add('mode-pilot');
    $tagCell.innerHTML = `
        <div class="tagcard-scroller" style="
            display:inline-flex;align-items:center;gap:6px;
            will-change: transform;
            transform: translateX(${CFG.gutterPx}px);
            transition: none;
            flex: 0 0 auto;
            width: max-content;
            max-width: none;
        ">
            ${safeNum ? `<span class="tagcard-num" style="font-weight:700;color: var(--team-c1);">${safeNum}.</span>` : ''}
            <span class="tagcard-name" style="white-space:nowrap;display:inline-block;color: var(--team-c1);">${safeName}</span>
        </div>
    `;
}

function measureIntrinsicWidth(el) {
    if (!el) return 0;
    const clone = el.cloneNode(true);
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    clone.style.transform = 'none';
    clone.style.transition = 'none';
    clone.style.whiteSpace = 'nowrap';
    clone.style.maxWidth = 'none';
    clone.style.width = 'max-content';
    document.body.appendChild(clone);
    const w = Math.max(clone.scrollWidth, clone.getBoundingClientRect().width);
    document.body.removeChild(clone);
    return Math.ceil(w);
}

// Met à jour uniquement les icônes de bonus dans la liste, sans rerender complet
let __bonusRafQueued = false;
function updateBonusCellsOnly() {
    if (__bonusRafQueued) return;
    __bonusRafQueued = true;
    requestAnimationFrame(() => {
        __bonusRafQueued = false;

        const $list = document.getElementById('cw-list');
        if (!$list) return;

        const rid = state.raceId;
        const isSurv = (() => {
            const s = String(rid || '').toUpperCase();
            return s === 'S' || s === 'SF';
        })();

        const usedSet    = state.bonusUsed || new Set();
        const doublesSet = state.doublesSet || new Set();

        const rows = $list.children;
        for (let i = 0; i < rows.length; i++) {
            const $row = rows[i];
            if (!$row || $row.classList.contains('is-empty')) continue;

            const pid = $row.dataset.pilotId;
            if (!pid) continue;

            // Priorité: used > armed > unavailable > available
            const isUsed  = usedSet.has(pid);
            const isArmed = !isUsed && !isSurv && doublesSet.has(pid);
            const isUnav  = !isUsed && isSurv;

            let bonusKey = 'available';
            let bonusAlt = 'Bonus disponible';
            if (isUsed)            { bonusKey = 'used';        bonusAlt = 'Bonus utilisé'; }
            else if (isArmed)      { bonusKey = 'armed';       bonusAlt = 'Bonus armé'; }
            else if (isUnav)       { bonusKey = 'unavailable'; bonusAlt = 'Indisponible (Survie)'; }

            // Trouver/Créer le conteneur .bonus-icon
            let $cell = $row.querySelector('.col-bonus');
            if (!$cell) continue;

            let $icon = $cell.querySelector('.bonus-icon');
            if (!$icon) {
                $icon = document.createElement('span');
                $icon.className = 'bonus-icon';
                $icon.setAttribute('role', 'img');
                $cell.innerHTML = ''; // on contrôle le contenu
                $cell.appendChild($icon);
            }

            // Si l’état est inchangé, ne rien faire
            const prevKey = $icon.getAttribute('data-bonus');
            if (prevKey === bonusKey) continue;

            // Sinon, toggler proprement les classes & attributs
            $icon.classList.remove('bonus--used', 'bonus--armed', 'bonus--unavailable', 'bonus--available');
            $icon.classList.add(`bonus--${bonusKey}`);
            $icon.setAttribute('data-bonus', bonusKey);
            $icon.setAttribute('aria-label', bonusAlt);
        }
    });
}

function effectiveTeamName(pilot) {
    // En MKW, si reveal actif → on bascule sur secretTeamName (si présent)
    if (state.phase === 'mkw' && state.revealEnabled) {
        return pilot.secretTeamName || pilot.teamName || '';
    }
    return pilot.teamName || '';
}

function teamKeysForPilot(p) {
    const game = (p.game || '').toLowerCase();
    const phase = state.phase;

    // Phase MK8 → on crédite toujours l’équipe "classique"
    if (phase === 'mk8') {
        return [p.teamName || ''];
    }

    // Phase MKW
    if (!state.revealEnabled) {
        // avant reveal → on crédite l’équipe "classique"
        return [p.teamName || ''];
    }

    // Après reveal (MKW)
    // - Les pilotes MKW → secretTeamName
    // - Les pilotes MK8 "double" → 2 équipes (teamName + secretTeamName)
    // - Les pilotes MK8 non double → teamName uniquement
    if (game === 'mkw') {
        return [p.secretTeamName || p.teamName || ''];
    }

    // game === 'mk8'
    const isDouble = (p.traitorMode === 'double') && p.secretTeamName && p.secretTeamName !== p.teamName;
    if (isDouble) return [p.teamName || '', p.secretTeamName || ''];
    return [p.teamName || ''];
}

// ----------------------
// Marquee (texte défilant pour le state)
// ----------------------
let _marqueeTimers = [];
let _marqueeOnEnd = null;

function _clearMarqueeRuntime() {
    _marqueeTimers.forEach(t => clearTimeout(t));
    _marqueeTimers = [];
    if (_marqueeOnEnd && _marqueeOnEnd.el) {
        _marqueeOnEnd.el.removeEventListener('transitionend', _marqueeOnEnd.fn);
    }
    _marqueeOnEnd = null;
}

function _afterFontsAndLayout(cb, el) {
    // Attendre que les polices soient prêtes (si supporté) + 2 frames pour stabiliser la largeur
    const doMeasure = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => cb());
        });
    };
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
        document.fonts.ready.then(doMeasure).catch(doMeasure);
    } else {
        doMeasure();
    }

    // BONUS: si la largeur du conteneur change après coup (ex: CSS async),
    // on relance une passe de calcul une seule fois.
    if (el && 'ResizeObserver' in window) {
        const ro = new ResizeObserver(() => {
            ro.disconnect();
            _afterFontsAndLayout(cb, null);
        });
        ro.observe(el);
    }
}

let _marqueeRunSeq = 0; // identifiant d'exécution pour annuler les callbacks obsolètes
function setRaceStateTextWithMarquee($state, text) {
    _clearMarqueeRuntime();

    // Chaque init prend un nouvel id et invalide les anciens callbacks
    const runId = ++_marqueeRunSeq;

    // Hard reset
    $state.innerHTML = '';
    $state.style.display = 'flex';
    $state.style.alignItems = 'center';
    $state.style.justifyContent = 'flex-start';
    $state.style.whiteSpace = 'nowrap';
    $state.style.overflow = 'hidden';
    $state.style.padding = '0';
    $state.style.margin = '0';
    $state.style.gap = '0';
    $state.style.minWidth = '0';

    // Piste
    const track = document.createElement('div');
    track.className = 'marquee-track';
    track.style.display = 'inline-flex';
    track.style.alignItems = 'center';
    track.style.transition = 'none';
    track.style.willChange = 'transform';
    track.style.position = 'relative'; // sécurise le positionnement local
    track.style.marginLeft = '0';
    track.style.left = '0';
    track.style.translate = '0';

    const span = document.createElement('span');
    span.textContent = text;
    const edgePad = (typeof CFG.stateEdgePadPx === 'number') ? CFG.stateEdgePadPx : 0;
    span.style.padding = `0 ${edgePad}px`;
    track.appendChild(span);
    $state.appendChild(track);

    // Mesures & animation — ATTENDRE polices + layout stables
    _afterFontsAndLayout(() => {
        // 👉 IGNORER si un nouvel init a eu lieu entre temps
        if (runId !== _marqueeRunSeq || !track.isConnected) return;

        // Gutters asymétriques avec fallback
        const baseGutter = (typeof CFG.stateGutterPx === 'number') ? CFG.stateGutterPx : 0;
        const gutterL = (typeof CFG.stateGutterLeftPx === 'number') ? CFG.stateGutterLeftPx : baseGutter;
        const gutterR = (typeof CFG.stateGutterRightPx === 'number') ? CFG.stateGutterRightPx : baseGutter;

        // Baseline : neutraliser tout transform avant mesure
        track.style.transition = 'none';
        track.style.transform = 'none';
        void track.getBoundingClientRect();

        // Mesure de l’écart structurel (ex: -69 ou -1206)
        const rs = $state.getBoundingClientRect();
        const rt = track.getBoundingClientRect();
        const baseGap = Math.round(rt.left - rs.left);

        // Point de départ effectif = CFG (gauche) corrigé
        const startX = gutterL - baseGap;

        // Appliquer le départ corrigé
        track.style.transform = `translateX(${startX}px)`;
        void track.getBoundingClientRect();

        // Mesures pour le défilement
        const visible = $state.clientWidth - (gutterL + gutterR);
        const full = track.scrollWidth;
        const overflow = Math.max(0, full - visible);

        if (overflow <= 0) {
            if (runId !== _marqueeRunSeq || !track.isConnected) return;
            $state.style.justifyContent = 'center';
            track.style.transition = 'none';
            track.style.transform = 'none'; // (au lieu de translateX(startX))
            return;
        }

        // Cible gauche (on respecte startX pour conserver la marge gauche voulue)
        const leftTarget = -overflow + startX;
        let toLeft = true;

        function animateOnce() {
            if (runId !== _marqueeRunSeq || !track.isConnected) return;
            track.style.transition = `transform ${CFG.stateDurationMs}ms linear`;
            const targetX = toLeft ? leftTarget : startX;
            void track.getBoundingClientRect();
            requestAnimationFrame(() => {
                if (runId !== _marqueeRunSeq || !track.isConnected) return;
                track.style.transform = `translateX(${targetX}px)`;
            });

            const onEnd = () => {
                track.removeEventListener('transitionend', onEnd);
                _marqueeOnEnd = null;
                const t = setTimeout(() => {
                    if (runId !== _marqueeRunSeq || !track.isConnected) return;
                    toLeft = !toLeft;
                    track.style.transition = 'none';
                    track.style.transform = toLeft ? `translateX(${startX}px)` : `translateX(${leftTarget}px)`;
                    void track.getBoundingClientRect();
                    requestAnimationFrame(animateOnce);
                }, CFG.stateEndDelayMs);
                _marqueeTimers.push(t);
            };

            _marqueeOnEnd = { el: track, fn: onEnd };
            track.addEventListener('transitionend', onEnd);
        }

        const t0 = setTimeout(animateOnce, CFG.stateStartDelayMs);
        _marqueeTimers.push(t0);
    }, $state);
}

// ----------------------
// DOM scaffold
// ----------------------
function ensureScaffold($root) {
    $root.innerHTML = '';

    // Reset du cache "dernier texte" pour forcer un rerender propre
    state.raceStateLastText = null;

    const $header = document.createElement('div');
    $header.className = 'cw-header';

    const $logo = document.createElement('img');
    $logo.alt = 'MK Grand Prix Experience';
    const HEADER_LOGO = './assets/images/MK_Grand_Prix-Experience_redim.png';
    $logo.src = resolveAssetPath(HEADER_LOGO);
    $header.appendChild($logo);

    const $state = document.createElement('div');
    $state.className = 'race-state';
    $state.id = 'race-state';
    $state.textContent = '—';

    const $list = document.createElement('div');
    $list.className = 'cw-list';
    $list.id = 'cw-list';

    $root.appendChild($header);
    $root.appendChild($state);
    $root.appendChild($list);
}

function buildRowSkeleton(position) {
    const $row = document.createElement('div');
    $row.className = 'cw-row is-empty';
    $row.setAttribute('role', 'listitem');

    const $colRank = document.createElement('div');
    $colRank.className = 'col-rank';
    $colRank.textContent = String(position);

    const $colTeam = document.createElement('div');
    $colTeam.className = 'col-team';
    const $img = document.createElement('img');
    $img.className = 'team-logo';
    $img.alt = '';
    $colTeam.appendChild($img);

    const $colTag = document.createElement('div');
    $colTag.className = 'col-tag';
    $colTag.textContent = '';

    const $colBonus = document.createElement('div');
    $colBonus.className = 'col-bonus';

    const $colPts = document.createElement('div');
    $colPts.className = 'col-points';
    $colPts.textContent = '';

    $row.appendChild($colRank);
    $row.appendChild($colTeam);
    $row.appendChild($colTag);
    $row.appendChild($colBonus);
    $row.appendChild($colPts);

    return $row;
}

function renderRowsSkeleton(rowCount) {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    stopSwapCycle(); // <-- stoppe le cycle sync avant de reconstruire

    $list.innerHTML = '';
    for (let i = 0; i < rowCount; i++) {
        $list.appendChild(buildRowSkeleton(i + 1));
    }
}

function renderMessageBlock(htmlString) {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    stopSwapCycle(); // <-- stoppe le cycle sync si on passe en mode message

    $list.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'cw-message';
    wrap.innerHTML = htmlString;
    $list.appendChild(wrap);
}

// ----------------------
// Firestore preload
// ----------------------
async function preloadFirestore() {
    const teamsSnap = await getDocs(collection(dbFirestore, 'teams'));
    teamsSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        state.teamsByName.set(data.name, {
            urlLogo: data.urlLogo || '',
            // couleurs si dispo (fallbacks doux)
            c1: data.color1 || data.c1 || '#ffd43b',
            c2: data.color2 || data.c2 || '#00b4d8',
            // tag court si dispo, sinon dérive du nom
            tag: (data.tag || data.shortTag || (data.name || '').slice(0,3)).toString().toUpperCase()
        });
    });

    const pilotsSnap = await getDocs(collection(dbFirestore, 'pilots'));
    pilotsSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        state.pilotsById.set(docSnap.id, {
            tag: data.tag || '',
            teamName: data.teamName || '',
            secretTeamName: data.secretTeamName || '',
            traitorMode: (data.traitorMode ?? null),     // "double" | "transfer" | null
            game: (data.game || '').toString(),          // "MK8" | "MKW"
            name: data.name || '',
            num: data.num || '',
            urlPhoto: data.urlPhoto || ''
        });
    });
}

// ----------------------
// Subscriptions RTDB
// ----------------------
function subscribeContext() {
    const ctxRef = ref(dbRealtime, 'context/current');
    onValue(ctxRef, (snap) => {
        const v = snap.val() || {};
        const phase = (v.phase || 'mk8').toString().toLowerCase();
        const raceId = v.raceId || null;

        const prevPhase = state.phase;
        const phaseChanged = phase !== prevPhase;

        state.phase = phase;
        state.raceId = raceId;

        // UI racestate + mode
        updateRaceStateDisplay();
        chooseAndApplyMode();

        // Flux bonus (usage + armements) — dépend de phase/race
        resubscribeBonusChannels();

        // Si la phase change → reset + rebrancher totals
        if (phaseChanged) {
            state.lastOrderKey = null;
            state.lastRanksSnapshot.clear();
            state.indicatorUntil.clear();
            state.lastDeltaDir.clear();
            if (state.indicatorSweepTimer) {
                clearTimeout(state.indicatorSweepTimer);
                state.indicatorSweepTimer = null;
            }
            resubscribeTotals();
        }

        // Ajustements (cosplay/jury/manu) — au premier boot ou changement de phase
        if (phaseChanged || !state.unsubAdjustments) {
            resubscribeAdjustments();
        }
    });

    // 👇 NOUVEAU : source unique du mode d’affichage (2 valeurs seulement)
    const clModeRef = ref(dbRealtime, 'context/classementMode/mode');
    onValue(clModeRef, (snap) => {
        const raw = snap.val();
        const mode = (typeof raw === 'string' ? raw.toLowerCase() : 'indiv');
        // Map : 'indiv' → 'pilot' | 'team' → 'team'
        state.viewScope = (mode === 'team') ? 'team' : 'pilot';
        // On ne force plus un mode clé (on laisse l’auto décider messages / 6/8 / 12/24)
        state.viewModeOverride = null;
        chooseAndApplyMode();
    });
}

function subscribeFinals() {
    const mk8ref = ref(dbRealtime, 'live/races/mk8');
    onValue(mk8ref, (snap) => {
        const data = snap.val() || {};
        const finals = Object.entries(data).filter(([rid, v]) => v && v.finalized);
        state.mk8LastFinalized = Boolean(data['8'] && data['8'].finalized);

        // NEW: stocker ids de courses mk8 finalisées
        state.mk8FinalizedRaceIds = new Set(finals.map(([rid]) => rid));

        updateRaceStateDisplay();
        chooseAndApplyMode();
    });

    const mkwref = ref(dbRealtime, 'live/races/mkw');
    onValue(mkwref, (snap) => {
        const data = snap.val() || {};
        const finals = Object.entries(data).filter(([rid, v]) => v && v.finalized);
        state.mkwFinalFinalized = Boolean(data['SF'] && data['SF'].finalized);

        // NEW: stocker ids de courses mkw finalisées
        state.mkwFinalizedRaceIds = new Set(finals.map(([rid]) => rid));

        updateRaceStateDisplay();
        chooseAndApplyMode();
    });
}

function resubscribeTotals() {
    if (state.unsubTotals) {
        try { state.unsubTotals(); } catch (_) {}
        state.unsubTotals = null;
    }

    const totalsRef = ref(dbRealtime, `live/points/${state.phase}/totals`);

    let debounceTimer = null;
    const unsubscribe = onValue(totalsRef, (snap) => {
        if (debounceTimer) clearTimeout(debounceTimer);

        debounceTimer = setTimeout(() => {
            const obj = snap.val() || {};
            state.totals.clear();
            Object.entries(obj).forEach(([pilotId, pts]) => {
                state.totals.set(pilotId, Number(pts) || 0);
            });

            // NEW: relancer aussi l'abonnement byRace
            subscribeByRace();

            chooseAndApplyMode();
            renderList(); // si mode lignes
        }, CFG.totalsDebounceMs);
    });

    state.unsubTotals = unsubscribe;
}

function resubscribeBonusChannels() {
    // Couper anciens
    if (state.unsubResultsBonus) { try { state.unsubResultsBonus(); } catch(_) {} state.unsubResultsBonus = null; }
    if (state.unsubBonusUsage)   { try { state.unsubBonusUsage(); }   catch(_) {} state.unsubBonusUsage   = null; }

    const phase = state.phase;
    const raceId = state.raceId;
    if (!phase) return;

    // 1) Usage définitif (par phase)
    {
        const usageRef = ref(dbRealtime, `live/results/${phase}/bonusUsage`);
        const unsub = onValue(usageRef, (snap) => {
            const obj = snap.val() || {};
            const used = new Set();
            Object.keys(obj).forEach(pid => used.add(pid));
            state.bonusUsed = used;
            updateBonusCellsOnly();
        });
        state.unsubBonusUsage = unsub;
    }

    // 2) État "fenêtre + armements" pour la course courante
    if (raceId) {
        const byRaceRef = ref(dbRealtime, `live/results/${phase}/byRace/${raceId}`);
        const unsub = onValue(byRaceRef, (snap) => {
            const data = snap.val() || {};
            state.doublesLocked = !!data.doublesLocked;
            const doubles = data.doubles || {};
            const set = new Set();
            Object.keys(doubles).forEach(pid => {
                if (doubles[pid] === true) set.add(pid);
            });
            state.doublesSet = set;
            updateBonusCellsOnly();
        });
        state.unsubResultsBonus = unsub;
    } else {
        // reset visuel si pas de course
        state.doublesLocked = false;
        state.doublesSet = new Set();
        updateBonusCellsOnly();
    }
}

function subscribeByRace() {
    const byRaceRef = ref(dbRealtime, `live/points/${state.phase}/byRace`);
    onValue(byRaceRef, (snap) => {
        state.byRaceSnapshot = snap.val() || {};
        recomputeTieBreaks();
        renderList(); // relancer le rendu avec nouveaux tie-breaks
    });
}

function recomputeTieBreaks() {
    state.posCounts.clear();
    state.bonusDoubles.clear();

    const races = state.byRaceSnapshot || {};
    for (const [raceId, data] of Object.entries(races)) {
        const ranks = data || {};
        for (const [pilotId, res] of Object.entries(ranks)) {
            if (!res || typeof res.rank !== 'number') continue;

            const r = res.rank;
            if (!state.posCounts.has(pilotId)) {
                state.posCounts.set(pilotId, new Map());
            }
            const m = state.posCounts.get(pilotId);
            m.set(r, (m.get(r) || 0) + 1);

            if (res.doubled) {
                state.bonusDoubles.set(pilotId, (state.bonusDoubles.get(pilotId) || 0) + 1);
            }
        }
    }
}

// --- render throttle (unique point d'entrée pour rafraîchir l'affichage)
let __renderQueued = false;
function requestRender() {
  if (__renderQueued) return;
  __renderQueued = true;

  const schedule = (window.requestAnimationFrame || window.setTimeout);
  schedule(() => {
    __renderQueued = false;
    try {
      renderList();
    } catch (e) {
      console.error(e);
    }
  });
}

function resubscribeAdjustments() {
    // Couper ancien listener si besoin
    if (state.unsubAdjustments) {
        try { state.unsubAdjustments(); } catch(_) {}
        state.unsubAdjustments = null;
    }

    const phase = state.phase;
    if (!phase) {
        state.adjustTotals.clear();
        requestRender();
        return;
    }

    // On lit UNIQUEMENT le total cumulé par pilote :
    // /live/adjustments/{phase}/pilot/{pilotId}/total
    const adjRef = ref(dbRealtime, `live/adjustments/${phase}/pilot`);
    const unsub = onValue(adjRef, (snap) => {
        const obj = snap.val() || {};
        state.adjustTotals.clear();

        for (const [pid, v] of Object.entries(obj)) {
            if (!v || typeof v !== 'object') continue;
            const t = (v.total != null) ? Number(v.total) : 0;
            if (t !== 0 && Number.isFinite(t)) {
                state.adjustTotals.set(pid, t);
            }
        }

        // (log debug non bloquant)
        clDebug('adjustments totals updated → size:', state.adjustTotals.size);

        requestRender();
    });

    state.unsubAdjustments = unsub;
}

// ----------------------
// Texte d’état
// ----------------------
function computeRaceStateText() {
    if (state.mkwFinalFinalized) {
        return 'MK World - Tournoi terminé - Scores finaux';
    }

    if (state.phase === 'mkw') {
        const rid = state.raceId;
        if (!rid) {
            return state.mkwFinalFinalized
                ? 'MK World - Tournoi terminé - Scores finaux'
                : 'MK World - En attente de départ';
        }
        if (rid === 'S') return 'MK World - Survie 1';
        if (rid === 'SF') return 'MK World - Survie Finale';

        if (isNumericRaceId(rid)) {
            const n = parseInt(rid, 10);
            if (n >= 1 && n <= 6) return `MK World - Course ${n} / 14`;
            if (n >= 7 && n <= 12) return `MK World - Course ${n + 1} / 14`;
        }
        return simpleRaceLabel({ phase: 'mkw', raceId: rid });
    }

    if (state.phase === 'mk8') {
        const rid = state.raceId;
        if (!rid) {
            return state.mk8LastFinalized
                ? 'MK 8 - Phase 1 terminée - Scores finaux'
                : 'MK 8 - Le tournoi va commencer';
        }
        if (isNumericRaceId(rid)) {
            const n = parseInt(rid, 10);
            if (n >= 1 && n <= 8) return `MK 8 - Course ${n} / 8`;
        }
        return simpleRaceLabel({ phase: 'mk8', raceId: rid });
    }

    return simpleRaceLabel({ phase: state.phase, raceId: state.raceId });
}

function updateRaceStateDisplay() {
    const $host = document.querySelector('.classement-widget');
    if (!$host) return;
    const $state = $host.querySelector('.race-state'); // ← scope local au widget
    if (!$state) return;

    const text = computeRaceStateText();

    // Dédup strict
    if (text === state.raceStateLastText) return;
    state.raceStateLastText = text;

    // Coalescing par frame
    if (state.raceStateRaf) cancelAnimationFrame(state.raceStateRaf);
    state.raceStateRaf = requestAnimationFrame(() => {
        state.raceStateRaf = null;
        setRaceStateTextWithMarquee($state, text);
    });
}

// ----------------------
// Sélection du mode
// ----------------------
function computeModeKeyAuto() {
    // 1) État "pas de phase active"
    if (!state.raceId) {
        // Quel que soit le mode (indiv/team), pas de course → message "pré tournoi"
        return 'msg-prestart';
    }

    // 2) Pas de scores agrégés (totaux + ajustements == 0 partout)
    if (totalsWithAdjAllZeroOrEmpty()) {
        return (state.phase === 'mk8') ? 'msg-mk8-noscores' : 'msg-mkw-noscores';
    }

    // 3) Il y a des scores → on rend selon le scope
    if (state.viewScope === 'team') {
        if (state.phase === 'mk8') {
            return 'teams-6';
        }
        // MKW → 6 avant reveal, 8 après reveal
        return state.revealEnabled ? 'teams-8' : 'teams-6';
    }

    // 4) Scope "pilot"
    return (state.phase === 'mk8') ? 'mk8-12' : 'mkw-24';
}

function computeModeKey() {
    if (window.__CL_FORCE_MODE && MODES[window.__CL_FORCE_MODE]) {
        return window.__CL_FORCE_MODE;
    }
    return computeModeKeyAuto();
}

function chooseAndApplyMode() {
    const key = computeModeKey();
    applyMode(key);
}

function applyMode(modeKey) {
    const $host = document.querySelector('.classement-widget');
    const $list = document.getElementById('cw-list');
    if (!$host || !$list) return;

    // Nettoie anciennes classes
    Object.values(MODES).forEach(m => $host.classList.remove(m.className));

    const m = MODES[modeKey] || MODES['mkw-24'];
    $host.classList.add(m.className);
    state.modeKey = modeKey;

    if (m.type === 'message') {
        renderMessageBlock(
            modeKey === 'msg-prestart'
            ? `
                <h2>Mario Kart Grand Prix Expérience</h2>
                <span>3</span>
                <p>🏁🏁🏁 Phase 1 🏁🏁🏁</p>
                <h3>Tournoi Mario Kart 8</h3>
                <span>🔴 8 courses</span>
                <p>🏁🏁🏁 Phase 2 🏁🏁🏁</p>
                <h3>Tournoi Mario Kart World</h3>
                <span>🔴 6 courses</span>
                <span>🔴 1 survie</span>
                <span>🔴 6 courses</span>
                <span>🔴 1 survie finale</span>
              `
            : modeKey === 'msg-mk8-noscores'
            ? `
                <h2>Mario Kart Grand Prix Expérience</h2>
                <span>3</span>
                <p>🏁🏁🏁 Phase 1 🏁🏁🏁</p>
                <h3>Tournoi Mario Kart 8</h3>
                <span>🔴 8 courses</span>
                <p>🏁 Course 1 en cours 🏁</p>
                <span>⚡ En attente des résultats.⚡</span>
              `
            : `
                <h2>Mario Kart Grand Prix Expérience</h2>
                <span>3</span>
                <p>🏁🏁🏁 Phase 2 🏁🏁🏁</p>
                <h3>Tournoi Mario Kart World</h3>
                <span>🔴 6 courses</span>
                <span>🔴 1 survie</span>
                <span>🔴 6 courses</span>
                <span>🔴 1 survie finale</span>
                <p>🏁 Course 1 en cours 🏁</p>
                <span>⚡ En attente des résultats.⚡</span>
              `
        );
        updateRaceStateDisplay();
        collapseBonusColumn(false); // messages → layout normal
        return;
    }

    // Lignes
    renderRowsSkeleton(m.rows);

    // Ré-applique le state dès que le DOM est prêt
    updateRaceStateDisplay();

    // NEW: compacter la colonne bonus en mode Équipe
    collapseBonusColumn(m.type === 'team');

    if (m.type === 'team') {
        renderTeamList();
    } else {
        renderList();
    }
}

function collapseBonusColumn(enable) {
    const $host = document.querySelector('.classement-widget');
    if (!$host) return;
    const $cells = $host.querySelectorAll('.col-bonus');
    $cells.forEach(($c) => {
        if (enable) {
            $c.style.flex = '0 0 0px';
            $c.style.width = '0';
            $c.style.padding = '0';
            $c.style.margin = '0';
            $c.textContent = ''; // sécurité: aucun contenu résiduel
        } else {
            $c.style.flex = '';
            $c.style.width = '';
            $c.style.padding = '';
            $c.style.margin = '';
        }
    });
}

// Debug helpers
window.CLASSEMENT_forceMode = function (key) {
    if (!MODES[key]) {
        console.warn('[classement] Mode inconnu:', key);
        return;
    }
    window.__CL_FORCE_MODE = key;
    applyMode(key);
};
window.CLASSEMENT_clearForce = function () {
    delete window.__CL_FORCE_MODE;
    chooseAndApplyMode();
};

// ----------------------
// Rendering liste (modes pilotes actuels)
// ----------------------
function sortPilotsAdvanced(a, b) {
    // 1. Points totaux
    if (b.points !== a.points) return b.points - a.points;

    // 2+. Comptage des positions (1er, 2e, 3e, …)
    const maxPos = 24; // couvre MKW
    const ma = state.posCounts.get(a.pilotId) || new Map();
    const mb = state.posCounts.get(b.pilotId) || new Map();
    for (let pos = 1; pos <= maxPos; pos++) {
        const ca = ma.get(pos) || 0;
        const cb = mb.get(pos) || 0;
        if (cb !== ca) return cb - ca; // plus de top-pos = mieux classé
    }

    // 5. Bonus (ex: doubles, cosplay, défis …)
    const ba = state.bonusDoubles.get(a.pilotId) || 0;
    const bb = state.bonusDoubles.get(b.pilotId) || 0;
    if (bb !== ba) return bb - ba;

    // Fallback déterministe : tag
    return (a.tag || '').localeCompare(b.tag || '');
}

function renderList() {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    const m = MODES[state.modeKey] || MODES['mkw-24'];
    if (m.type === 'team') {
        // on délègue au renderer "équipe"
        return renderTeamList();
    }
    if (m.type === 'message') return;

    // Construire la liste des items
    const items = [];
    state.totals.forEach((basePoints, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toLowerCase();
        if (state.modeKey === 'mk8-12' && gameNorm !== 'mk8') return;
        if (state.modeKey === 'mkw-24' && gameNorm !== 'mkw') return;

        // Équipe affichée (reveal)
        const teamNameShown = effectiveTeamName(p);
        const team = state.teamsByName.get(teamNameShown) || {};
        const logo = team.urlLogo ? resolveAssetPath(team.urlLogo) : '';

        // ✅ Points ajustés = base + ajustements
        const base = Number(basePoints) || 0;                        // total RTDB des points (byRace → totals)
        const adj  = Number(state.adjustTotals.get(pilotId) || 0); // total des ajustements (déjà cumulé)
        const effective = base + adj;

        items.push({
            pilotId,
            tag: p.tag || '',
            teamName: p.teamName || '',
            logo,
            points: effective,                  // <-- on affiche base + ajustements
            name: p.name || '',
            num: p.num || '',
            urlPhoto: p.urlPhoto ? resolveAssetPath(p.urlPhoto) : '',
            bonuses: 0
        });
    });

    // Tri avancé (utilise items[].points déjà ajustés)
    items.sort(sortPilotsAdvanced);

    const rows = $list.children;
    const rowCount = rows.length;

    const currentRanks = new Map();
    const currentOrderKey = items.map(i => i.pilotId).join(',');

    for (let i = 0; i < rowCount; i++) {
        const $row = rows[i];
        if (!$row) continue;

        const entry = items[i];
        if (!entry) {
            $row.classList.add('is-empty');
            const $tagEl = $row.querySelector('.col-tag');
            if ($tagEl) {
                $tagEl.classList.remove('mode-pilot');
                renderTagTextInto($tagEl, '');
            }
            setRow($row, {
                position: i + 1,
                logo: '',
                tag: '',
                bonusContent: '',
                pointsText: '',
                variation: 0
            });
            continue;
        }

        $row.classList.remove('is-empty');
        // Couleurs d’équipe sur la ligne (pour styliser le nom défilant)
        const teamShown = effectiveTeamName(state.pilotsById.get(entry.pilotId) || {});
        const teamConf  = state.teamsByName.get(teamShown) || {};
        $row.style.setProperty('--team-c1', teamConf.c1 || '#ffd43b');
        $row.style.setProperty('--team-c2', teamConf.c2 || '#00b4d8');
        $row.dataset.pilotId    = entry.pilotId;
        $row.dataset.pilotName  = entry.name;
        $row.dataset.pilotNum   = entry.num;
        $row.dataset.pilotPhoto = entry.urlPhoto || '';
        $row.dataset.teamLogo   = entry.logo || '';

        const $tagEl = $row.querySelector('.col-tag');
        if ($tagEl) {
            $tagEl.classList.remove('mode-pilot');
            renderTagTextInto($tagEl, entry.tag || '');
        }

        currentRanks.set(entry.pilotId, i + 1);

        let variation = 0;
        const now = Date.now();

        const prevRank = state.lastRanksSnapshot.get(entry.pilotId) ?? null;

        const strictOk = !CFG.indicatorsOnFinalizeOnly ||
            (state.phase === 'mk8' && state.mk8FinalizedRaceIds?.has(state.raceId)) ||
            (state.phase === 'mkw' && state.mkwFinalizedRaceIds?.has(state.raceId));

        if (strictOk && state.lastOrderKey && state.lastOrderKey !== currentOrderKey) {
            if (prevRank != null) {
                const delta = prevRank - (i + 1);
                if (delta !== 0) {
                    state.indicatorUntil.set(entry.pilotId, now + CFG.changeIndicatorMs);
                    state.lastDeltaDir.set(entry.pilotId, Math.sign(delta));
                }
            }
        }

        const ttl = state.indicatorUntil.get(entry.pilotId) || 0;
        if (ttl > now) {
            const dir = state.lastDeltaDir.get(entry.pilotId) || 0;
            variation = dir;
        } else {
            state.indicatorUntil.delete(entry.pilotId);
            state.lastDeltaDir.delete(entry.pilotId);
            variation = 0;
        }

        // --- BONUS: état visuel du bonus (inchangé)
        const rid = state.raceId;
        const isSurv = (() => {
            const s = String(rid || '').toUpperCase();
            return s === 'S' || s === 'SF';
        })();

        const usedSet    = state.bonusUsed || new Set();
        const doublesSet = state.doublesSet || new Set();

        const isUsed  = usedSet.has(entry.pilotId);
        const isArmed = !isUsed && !isSurv && doublesSet.has(entry.pilotId);
        const isUnav  = !isUsed && isSurv;

        let bonusKey = 'available';
        let bonusAlt = 'Bonus disponible';
        if (isUsed)            { bonusKey = 'used';        bonusAlt = 'Bonus utilisé'; }
        else if (isArmed)      { bonusKey = 'armed';       bonusAlt = 'Bonus armé'; }
        else if (isUnav)       { bonusKey = 'unavailable'; bonusAlt = 'Indisponible (Survie)'; }

        const bonusContent =
            `<span class="bonus-icon bonus--${bonusKey}" data-bonus="${bonusKey}" role="img" aria-label="${bonusAlt}"></span>`;

        setRow($row, {
            position: i + 1,
            logo: entry.logo,
            tag: entry.tag,
            bonusContent,
            pointsText: formatPoints(entry.points),  // <-- affiche les points ajustés
            variation
        });
    }

    state.lastOrderKey = currentOrderKey;
    state.lastRanksSnapshot = currentRanks;

    scheduleIndicatorSweep();
    restartSwapCycle();
}

function renderTeamList() {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    // 1) Aggrégat par équipe à partir des totaux (base + ajustements)
    const teamAgg = new Map(); // teamName => { name, tag, logo, c1, c2, points }

    state.totals.forEach((basePoints, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        // Filtre MK8/MKW selon le mode actif (6 ou 8 équipes → toujours toutes équipes)
        // On agrège tous les pilotes de la phase (MK8 & MKW) — logique définie par teamKeysForPilot
        const base = Number(basePoints) || 0;
        const adj  = Number(state.adjustTotals.get(pilotId) || 0);
        const eff  = base + adj;
        if (eff <= 0) return; // optionnel : ignorer 0

        const keys = teamKeysForPilot(p);
        keys.forEach((teamName) => {
            if (!teamName) return;
            if (!teamAgg.has(teamName)) {
                const t = state.teamsByName.get(teamName) || {};
                teamAgg.set(teamName, {
                    name: teamName,
                    tag: t.tag || teamName.slice(0,3).toUpperCase(),
                    logo: t.urlLogo ? resolveAssetPath(t.urlLogo) : '',
                    c1: t.c1 || '#ffd43b',
                    c2: t.c2 || '#00b4d8',
                    points: 0
                });
            }
            const obj = teamAgg.get(teamName);
            obj.points += eff;
        });
    });

    // 2) Liste triée
    const items = Array.from(teamAgg.values());
    items.sort((a, b) => b.points - a.points);

    // 3) Rendu dans les lignes existantes
    const rows = $list.children;
    const rowCount = rows.length;

    for (let i = 0; i < rowCount; i++) {
        const $row = rows[i];
        if (!$row) continue;

        const entry = items[i];
        if (!entry) {
            $row.classList.add('is-empty');
            setTeamRow($row, {
                position: i + 1,
                logo: '',
                tag: '',
                name: '',
                pointsText: ''
            });
            continue;
        }

        $row.classList.remove('is-empty');

        // Couleurs d’équipe dispo sur la ligne
        $row.style.setProperty('--team-c1', entry.c1);
        $row.style.setProperty('--team-c2', entry.c2);

        setTeamRow($row, {
            position: i + 1,
            logo: entry.logo,
            tag: entry.tag,
            name: entry.name,
            pointsText: formatPoints(entry.points)
        });
    }

    // (ré)initialise le cycle de swap "équipe"
    restartSwapCycle();
}

function setTeamRow($row, { position, logo, tag, name, pointsText }) {
    const $rank  = $row.querySelector('.col-rank');
    const $team  = $row.querySelector('.col-team .team-logo');
    const $tagEl = $row.querySelector('.col-tag');
    const $bonus = $row.querySelector('.col-bonus');
    const $pts   = $row.querySelector('.col-points');

    if ($rank) {
        $rank.innerHTML = '';
        const $num = document.createElement('span');
        $num.textContent = String(position);
        $rank.appendChild($num);
    }

    // Logo d’équipe
    if ($team) {
        if (logo) {
            $team.src = logo;
            $team.alt = 'Logo équipe';
            $team.style.visibility = 'visible';
        } else {
            $team.removeAttribute('src');
            $team.alt = '';
            $team.style.visibility = 'hidden';
        }
    }

    // Phase TAG (par défaut) → col-tag = tag ; col-bonus = vide (pas de nom au premier rendu)
    if ($tagEl) {
        renderTagTextInto($tagEl, (tag || '').toString().toUpperCase());
    }
    if ($bonus) {
        $bonus.innerHTML = ''; // pas de nom ici au premier cycle
    }

    if ($pts) $pts.textContent = pointsText || '';

    // datasets pour les cycles
    $row.dataset.teamTag = (tag || '').toString().toUpperCase();
    $row.dataset.teamName = (name || '').toString();
}

function scheduleIndicatorSweep() {
    if (state.indicatorSweepTimer) {
        clearTimeout(state.indicatorSweepTimer);
        state.indicatorSweepTimer = null;
    }

    const now = Date.now();
    let nextExpiry = Infinity;

    state.indicatorUntil.forEach((ts) => {
        if (ts > now && ts < nextExpiry) {
            nextExpiry = ts;
        }
    });

    if (nextExpiry !== Infinity) {
        const delay = Math.max(50, nextExpiry - now);
        state.indicatorSweepTimer = setTimeout(() => {
            state.indicatorSweepTimer = null;
            renderList();
        }, delay);
    }
}

function setRow($row, { position, logo, tag, bonusContent, pointsText, variation = 0 }) {
    const $rank  = $row.querySelector('.col-rank');
    const $team  = $row.querySelector('.col-team .team-logo');
    const $tagEl = $row.querySelector('.col-tag');
    const $bonus = $row.querySelector('.col-bonus');
    const $pts   = $row.querySelector('.col-points');

    if ($rank) {
        // Réinitialiser le contenu du rank (icône + numéro)
        $rank.innerHTML = '';

        // Icône de variation (pilotée par renderList via indicatorUntil)
        if (variation !== 0) {
            const $icon = document.createElement('span');
            $icon.className = 'rank-delta ' + (variation > 0 ? 'up' : 'down');
            $rank.appendChild($icon);
        }

        // Numéro de rang
        const $num = document.createElement('span');
        $num.textContent = String(position);
        $rank.appendChild($num);
    }

    // Image .col-team — logo ou photo selon phase courante (mode-pilot sur .col-tag)
    if ($team) {
        const usePhoto = $tagEl && $tagEl.classList.contains('mode-pilot');
        const src = usePhoto ? ($row.dataset.pilotPhoto || '') : ($row.dataset.teamLogo || logo || '');
        if (src) {
            $team.src = src;
            $team.alt = usePhoto ? 'Photo pilote' : 'Logo équipe';
            $team.style.visibility = 'visible';
        } else {
            $team.removeAttribute('src');
            $team.alt = '';
            $team.style.visibility = 'hidden';
        }
    }

    // Colonne tag — scroller pilote ou tag simple
    if ($tagEl) {
        if ($tagEl.classList.contains('mode-pilot')) {
            renderPilotNameInto($tagEl, {
                num:  $row.dataset.pilotNum  || '',
                name: $row.dataset.pilotName || ''
            });
        } else {
            renderTagTextInto($tagEl, tag || '');
        }
    }

    if ($bonus) $bonus.innerHTML = bonusContent || '';
    if ($pts)   $pts.textContent = pointsText || '';
}

// ----------------------
// Tag swapper (synchronisé pour toutes les lignes)
// ----------------------

// Contrôleur global — un seul cycle pour toutes les lignes visibles
const swapCtrl = {
    tNextPilotStart: null,
    tStartBackPhase: null,
    tBackToTag: null
};

function stopSwapCycle() {
    if (swapCtrl.tNextPilotStart) { clearTimeout(swapCtrl.tNextPilotStart); swapCtrl.tNextPilotStart = null; }
    if (swapCtrl.tStartBackPhase) { clearTimeout(swapCtrl.tStartBackPhase); swapCtrl.tStartBackPhase = null; }
    if (swapCtrl.tBackToTag) { clearTimeout(swapCtrl.tBackToTag); swapCtrl.tBackToTag = null; }
}

function restartSwapCycle() {
    stopSwapCycle();

    const m = MODES[state.modeKey] || MODES['mkw-24'];
    if (m.type === 'message') return;

    const $list = document.getElementById('cw-list');
    if (!$list || !$list.querySelector('.cw-row')) return;

    // MODE ÉQUIPE → on alterne TAG ↔ NOM (dans col-tag) + nom statique en col-bonus en phase TAG
    if (m.type === 'team') {
        swapCtrl.tNextPilotStart = setTimeout(startTeamNamePhaseAll, CFG.tagStandbyMs);
        return;
    }

    // MODE PILOTE (existant)
    swapCtrl.tNextPilotStart = setTimeout(startPilotPhaseAll, CFG.tagStandbyMs);
}

function startPilotPhaseAll() {
    swapCtrl.tNextPilotStart = null;

    const rows = getActiveRows();
    if (rows.length === 0) {
        restartSwapCycle();
        return;
    }

    // Phase PILOT: col-tag → scroller ; col-team → photo pilote
    rows.forEach(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        if ($tagCell) {
            renderPilotNameInto($tagCell, {
                num:  ($row.dataset.pilotNum  || '').toString(),
                name: ($row.dataset.pilotName || '').toString()
            });
        }

        // --- NEW: bascule logo → photo dans .col-team
        const $img = $row.querySelector('.col-team .team-logo'); 
        const $teamCell = $row.querySelector('.col-team');
        const photo = $row.dataset.pilotPhoto || '';
        if ($img) {
            if (photo) { $img.src = photo; $img.alt = 'Photo pilote'; $img.style.visibility = 'visible'; }
            else { $img.removeAttribute('src'); $img.alt = ''; $img.style.visibility = 'hidden'; }
        }
        if ($teamCell) $teamCell.classList.add('is-pilot');
    });

    // mesurer overflow par ligne sur .col-tag
    const overflows = rows.map(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        return getOverflowForCell($tagCell);
    });
    const maxOverflow = Math.max(...overflows, 0);

    // lancer l'aller après délai global
    setTimeout(() => {
        rows.forEach(($row, idx) => {
            const $tagCell = $row.querySelector('.col-tag');
            runPilotScrollWithGlobal($tagCell, overflows[idx], maxOverflow, CFG.pilotScrollMs);
        });
    }, CFG.pilotStartDelayMs);

    // planifier retour + back to tag
    swapCtrl.tStartBackPhase = setTimeout(
        startPilotBackPhaseAll,
        CFG.pilotStartDelayMs + CFG.pilotScrollMs + CFG.pilotPauseEndMs
    );
    swapCtrl.tBackToTag = setTimeout(
        backToTagAll,
        CFG.pilotStartDelayMs + CFG.pilotScrollMs + CFG.pilotPauseEndMs + CFG.pilotScrollMs + CFG.pilotBackPauseMs
    );
}

function startPilotBackPhaseAll() {
    swapCtrl.tStartBackPhase = null;

    const rows = getActiveRows();
    if (rows.length === 0) return;

    const overflows = rows.map(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        return getOverflowForCell($tagCell);
    });
    const maxOverflow = Math.max(...overflows, 0);

    rows.forEach(($row, idx) => {
        const $tagCell = $row.querySelector('.col-tag');
        runPilotScrollBackWithGlobal($tagCell, overflows[idx], maxOverflow, CFG.pilotScrollMs);
    });
}

function getOverflowForCell($tagCell) {
    if (!$tagCell) return 0;
    const scroller = $tagCell.querySelector('.tagcard-scroller');
    if (!scroller) return 0;

    // Largeur visible (moins la gouttière visuelle)
    const visible = Math.max(0, $tagCell.clientWidth - (CFG.gutterPx * 2));

    // Largeur intrinsèque du scroller (hors contraintes de layout)
    const full = measureIntrinsicWidth(scroller);

    return Math.max(0, full - visible);
}

function runPilotScrollBackWithGlobal($tagCell, overflow, maxOverflow, maxDurationMs) {
    const scroller = $tagCell ? $tagCell.querySelector('.tagcard-scroller') : null;
    if (!scroller) return;

    // Garanties contre le shrink/contraintes
    scroller.style.flex = '0 0 auto';
    scroller.style.width = 'max-content';
    scroller.style.maxWidth = 'none';

    if (overflow <= 0 || maxOverflow <= 0) {
        scroller.style.transition = 'none';
        scroller.style.transform = `translateX(${CFG.gutterPx}px)`;
        return;
    }

    const durationMs = Math.max(50, Math.round((overflow / maxOverflow) * maxDurationMs));
    const startX = - (overflow - CFG.edgePadPx);
    const targetX = CFG.gutterPx;

    scroller.style.transition = 'none';
    scroller.style.transform = `translateX(${startX}px)`;

    void scroller.getBoundingClientRect();

    requestAnimationFrame(() => {
        scroller.style.transition = `transform ${durationMs}ms linear`;
        scroller.style.transform = `translateX(${targetX}px)`;
    });
}

function backToTagAll() {
    swapCtrl.tBackToTag = null;

    const rows = getActiveRows();
    rows.forEach(($row) => {
        // 1) Revenir au TAG dans .col-tag
        const $tagCell = $row.querySelector('.col-tag');
        if ($tagCell) {
            $tagCell.classList.remove('mode-pilot');
            const p = state.pilotsById.get($row.dataset.pilotId || '');
            renderTagTextInto($tagCell, (p && p.tag) ? p.tag : '');
        }

        // 2) Revenir au LOGO dans .col-team
        const $teamCell = $row.querySelector('.col-team');            // NEW: retirer le flag "is-pilot"
        if ($teamCell) $teamCell.classList.remove('is-pilot');

        const $img = $row.querySelector('.col-team .team-logo');
        if ($img) {
            const logo = $row.dataset.teamLogo || '';
            if (logo) {
                $img.src = logo;
                $img.alt = 'Logo équipe';
                $img.style.visibility = 'visible';
            } else {
                $img.removeAttribute('src');
                $img.alt = '';
                $img.style.visibility = 'hidden';
            }
        }
    });

    // 3) Relancer un cycle
    restartSwapCycle();
}

function getActiveRows() {
    const $list = document.getElementById('cw-list');
    if (!$list) return [];
    const rows = Array.from($list.querySelectorAll('.cw-row')).filter(el => !el.classList.contains('is-empty'));
    return rows;
}

function startTeamNamePhaseAll() {
    const rows = getActiveRows();
    if (rows.length === 0) {
        restartSwapCycle();
        return;
    }

    // 1) col-tag → NOM (scroller), col-bonus → vide
    rows.forEach(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        const $bnCell  = $row.querySelector('.col-bonus');
        const name = $row.dataset.teamName || '';
        if ($tagCell) renderTeamNameInto($tagCell, name);
        if ($bnCell)  $bnCell.innerHTML = '';
    });

    // 2) mesures d’overflow + lancement synchro
    const overflows = rows.map(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        return getOverflowForCell($tagCell);
    });
    const maxOverflow = Math.max(...overflows, 0);

    setTimeout(() => {
        rows.forEach(($row, idx) => {
            const $tagCell = $row.querySelector('.col-tag');
            runPilotScrollWithGlobal($tagCell, overflows[idx], maxOverflow, CFG.pilotScrollMs);
        });
    }, CFG.pilotStartDelayMs);

    // 3) planifier retour à TAG
    swapCtrl.tStartBackPhase = setTimeout(
        backToTeamTagAll,
        CFG.pilotStartDelayMs + CFG.pilotScrollMs + CFG.pilotPauseEndMs
    );
}

function backToTeamTagAll() {
    swapCtrl.tStartBackPhase = null;

    const rows = getActiveRows();
    rows.forEach(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        const $bnCell  = $row.querySelector('.col-bonus');
        const tag      = $row.dataset.teamTag || '';

        // col-tag → TAG (en conservant la teinte équipe)
        if ($tagCell) {
            $tagCell.classList.remove('mode-pilot');
            renderTagTextInto($tagCell, tag);
        }

        // BONUS désormais inutilisé en mode équipe → le laisser vide
        if ($bnCell) {
            $bnCell.innerHTML = '';
        }
    });

    restartSwapCycle();
}

/**
 * Fait défiler le scroller à gauche (aller) en durée fixe; s’il n’y a pas d’overflow
 * on ne bouge pas mais on attend la même durée (synchro globale).
 */
function runPilotScrollWithGlobal($tagCell, overflow, maxOverflow, maxDurationMs) {
    const scroller = $tagCell ? $tagCell.querySelector('.tagcard-scroller') : null;
    if (!scroller) return;

    // Garanties contre le shrink/contraintes
    scroller.style.flex = '0 0 auto';
    scroller.style.width = 'max-content';
    scroller.style.maxWidth = 'none';

    // Position de départ (gouttière gauche)
    scroller.style.transition = 'none';
    scroller.style.transform = `translateX(${CFG.gutterPx}px)`;

    if (overflow <= 0 || maxOverflow <= 0) {
        return;
    }

    const durationMs = Math.max(50, Math.round((overflow / maxOverflow) * maxDurationMs));
    const targetX = - (overflow + CFG.edgePadPx);

    // Reflow pour fiabiliser l'animation
    void scroller.getBoundingClientRect();

    requestAnimationFrame(() => {
        scroller.style.transition = `transform ${durationMs}ms linear`;
        scroller.style.transform = `translateX(${targetX}px)`;
    });
}

// ----------------------
// Boot
// ----------------------
(async function init() {
    // Désactive l’autoboot quand on utilise la factory
    if (typeof window !== 'undefined' && window.__CL_FACTORY_MODE) {
        return; // le montage se fera via initClassement()
    }

    const $host = document.querySelector('.classement-widget');
    if (!$host) {
        console.warn('[classement] Élément .classement-widget introuvable.');
        return;
    }

    ensureScaffold($host);

    try {
        await preloadFirestore();
    } catch (err) {
        console.error('[classement] Erreur Firestore:', err);
    }
    
    // ✅ S’assurer que l’auth (Google restauré *ou* anonyme) est prête avant les reads RTDB
    await _authReady;

    subscribeContext();
    subscribeFinals();
    resubscribeTotals();
    // Flux bonus (usage + état byRace) dépend du contexte → initialisation
    resubscribeAdjustments();
    resubscribeBonusChannels();
    // (re)brancher le reveal → re-render immédiat
    if (state.unsubReveal) { try { state.unsubReveal(); } catch(_) {} state.unsubReveal = null; }
    state.unsubReveal = subReveal(() => {
        try { chooseAndApplyMode(); } catch(_) {}
        try { renderList(); } catch(_) {}
    });
    // Premier choix
    chooseAndApplyMode();
})();

// ----------------------------------------------------
// Factory API (append-only) — initClassement(container, options)
// - n'altère pas l'IIFE existante
// - réutilise les fonctions internes (ensureScaffold, subscribe*, renderList, ...)
// - options.forceMode: 'mk8-12' | 'mkw-24' | 'teams-6' | 'teams-8' | 'msg-prestart' | 'msg-mk8-noscores' | 'msg-mkw-noscores'
// ----------------------------------------------------
export function initClassement(container, options = {}) {
    if (typeof _authReady?.then === 'function') {
        _authReady.then(() => clDebug('auth ready → safe to subscribe'));
    }

    const host = _resolveClassementHost(container);
    if (!host) {
        console.warn('[classement] initClassement: conteneur introuvable', container);
        return {
            host: null,
            ready: Promise.resolve(false),
            destroy() {},
            setForcedMode() {}
        };
    }

    // Scaffolding DOM local au host
    try { ensureScaffold(host); } catch (err) {
        console.error('[classement] ensureScaffold:', err);
    }

    // Option: forcer un mode d'affichage
    if (options.forceMode && typeof options.forceMode === 'string') {
        window.__CL_FORCE_MODE = options.forceMode;
    }

    // Si l'IIFE n'a pas booté (ex: pas de .classement-widget au chargement),
    // on lance le boot minimal ici (préload + subscriptions).
    const needBoot = !state.unsubTotals; // heuristique suffisante pour éviter les doubles abonnements
    const ready = (async () => {
        if (needBoot) {
            try { await preloadFirestore(); } catch (err) { console.error('[classement] Erreur Firestore:', err); }
            try { subscribeContext(); } catch (err) { console.error('[classement] subscribeContext:', err); }
            try { subscribeFinals(); } catch (err) { console.error('[classement] subscribeFinals:', err); }
            try { resubscribeTotals(); } catch (err) { console.error('[classement] resubscribeTotals:', err); }
            // Brancher aussi le reveal si on boote via la factory
            try { if (state.unsubReveal) { state.unsubReveal(); } } catch (_) {}
            try {
                state.unsubReveal = subReveal(() => {
                    try { chooseAndApplyMode(); } catch (_) {}
                    try { renderList(); } catch (_) {}
                });
            } catch (err) {
                console.error('[classement] subReveal (factory):', err);
            }
        }

        // 1er rendu
        try { chooseAndApplyMode(); } catch (_) {}
        try { renderList(); } catch (_) {}

        return true;
    })();

    return {
        host,
        ready, // Promise<boolean>
        destroy() {
            try { stopSwapCycle(); } catch (_) {}
            try { host.innerHTML = ''; } catch (_) {}
            // Note: on ne coupe pas ici les abonnements globaux (context/finals/totals)
            // pour ne pas impacter d'autres vues éventuelles.
        },
        setForcedMode(modeKey) {
            window.__CL_FORCE_MODE = modeKey;
            try { chooseAndApplyMode(); } catch (_) {}
        }
    };
}

// Résout/crée le host local (.classement-widget) dans le container donné
function _resolveClassementHost(container) {
    let el = null;
    if (!container) return null;

    if (typeof container === 'string') {
        el = document.querySelector(container);
    } else if (container instanceof Element) {
        el = container;
    }

    if (!el) return null;

    let host = el.querySelector('.classement-widget');
    if (!host) {
        host = document.createElement('div');
        host.className = 'classement-widget';
        el.appendChild(host);
    }
    return host;
}
