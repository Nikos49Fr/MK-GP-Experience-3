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

// ----------------------
// Config timings (ajustables)
// ----------------------
const CFG = {
    // swap TAG ↔ FICHE
    tagStandbyMs: 15000,        // 15000
    pilotScrollMs: 8000,        // 8000
    pilotPauseEndMs: 3000,      // 5000
    pilotBackPauseMs: 3000,     // 5000
    pilotStartDelayMs: 3000,    // 5000

    // marges visuelles du swap
    stateGutterPx: 26,   // au lieu de gutterPx
    stateEdgePadPx: 12,  // au lieu de edgePadPx

    // STATE (texte défilant)
    stateStartDelayMs: 3000,
    stateEndDelayMs: 2000,
    stateDurationMs: 5000,
    
    // Indicateur de changement de rang (triangle ↑/↓)
    // Spécification: 6000ms pour la phase de dev (1 min en prod)
    changeIndicatorMs: 30000,

    // NEW: debounce pour lisser les mises à jour partielles de totals
    totalsDebounceMs: 200,

    // NEW: mode strict — n'activer les triangles que lorsqu'une course passe finalized=true
    indicatorsOnFinalizeOnly: false
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
// Helpers
// ----------------------
// ----------------------
// Helpers
// ----------------------
function resolveAssetPath(storedPath) {
    if (!storedPath) return '';

    // URL absolues (http/https/data/blob) → laisser tel quel
    if (/^(https?:|data:|blob:)/i.test(storedPath)) {
        return storedPath;
    }

    // 1) Définir la racine du projet depuis ce fichier JS:
    //    /js/ui/classement.js  →  ../../  = racine du repo (où se trouve /assets)
    const projectRoot = new URL('../../', import.meta.url); // ex: https://.../MK-GP-Experience-3/

    // 2) Gérer les différentes formes de chemins stockés:
    //    - "/assets/..." (racine projet voulue)    → new URL('assets/...', projectRoot)
    //    - "./assets/..." (racine projet)          → new URL('assets/...', projectRoot)
    //    - "assets/..." (racine projet)            → new URL('assets/...', projectRoot)
    //    - "../..." (rare)                         → new URL(storedPath, projectRoot)

    if (storedPath.startsWith('/')) {
        return new URL(storedPath.slice(1), projectRoot).href;
    }
    if (storedPath.startsWith('./')) {
        return new URL(storedPath.slice(2), projectRoot).href;
    }
    return new URL(storedPath, projectRoot).href;
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

function totalsAllZeroOrEmpty(map) {
    if (!map || map.size === 0) return true;
    for (const [, v] of map) {
        if ((Number(v) || 0) > 0) return false;
    }
    return true;
}

// Phase TAG: texte simple (ellipsis géré par CSS)
function renderTagTextInto($tagCell, tag) {
    $tagCell.classList.remove('mode-pilot');
    $tagCell.innerHTML = '';
    $tagCell.textContent = tag || '';
}

// Phase PILOT: scroller "num. NOM" (sans photo ici — la photo est dans .col-team)
function renderPilotNameInto($tagCell, { num, name }) {
    const safeNum = (num || '').toString();
    const safeName = (name || '')
        .toString()
        .toUpperCase()
        .replace(/\s+/g, ''); // <-- tous les espaces supprimés

    $tagCell.classList.add('mode-pilot');
    // Important : le scroller doit être “intrinsèque” et non contraint
    $tagCell.innerHTML = `
        <div class="tagcard-scroller" style="
            display:inline-flex;align-items:center;gap:6px;
            will-change: transform;
            transform: translateX(${CFG.gutterPx}px);
            transition: none;
            flex: 0 0 auto;          /* NE PAS shrinker */
            width: max-content;       /* largeur intrinsèque */
            max-width: none;          /* pas de contrainte */
        ">
            ${safeNum ? `<span class="tagcard-num" style="font-weight:700;">${safeNum}.</span>` : ''}
            <span class="tagcard-name" style="white-space:nowrap;display:inline-block;">${safeName}</span>
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

function setRaceStateTextWithMarquee($state, text) {
    _clearMarqueeRuntime();

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

    const span = document.createElement('span');
    span.textContent = text;
    span.style.padding = `0 ${CFG.stateEdgePadPx}px`;
    track.appendChild(span);
    $state.appendChild(track);

    // Mesures & animation — ATTENDRE polices + layout stables
    _afterFontsAndLayout(() => {
        const gutter = CFG.stateGutterPx;
        const visible = $state.clientWidth - (gutter * 2);
        const full = track.scrollWidth;
        const overflow = Math.max(0, full - visible);

        if (overflow <= 0) {
            $state.style.justifyContent = 'center';
            track.style.transition = 'none';
            track.style.transform = `translateX(${CFG.stateGutterPx}px)`;
            return;
        }

        track.style.transition = 'none';
        track.style.transform = `translateX(${gutter}px)`;
        void track.getBoundingClientRect();

        const leftTarget = -overflow + gutter;
        let toLeft = true;

        function animateOnce() {
            track.style.transition = `transform ${CFG.stateDurationMs}ms linear`;
            const targetX = toLeft ? leftTarget : gutter;
            void track.getBoundingClientRect();
            requestAnimationFrame(() => {
                track.style.transform = `translateX(${targetX}px)`;
            });

            const onEnd = () => {
                track.removeEventListener('transitionend', onEnd);
                _marqueeOnEnd = null;
                const t = setTimeout(() => {
                    toLeft = !toLeft;
                    track.style.transition = 'none';
                    track.style.transform = toLeft ? `translateX(${gutter}px)` : `translateX(${leftTarget}px)`;
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
    indicatorSweepTimer: null
};

// ----------------------
// Firestore preload
// ----------------------
async function preloadFirestore() {
    const teamsSnap = await getDocs(collection(dbFirestore, 'teams'));
    teamsSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        state.teamsByName.set(data.name, { urlLogo: data.urlLogo || '' });
    });

    const pilotsSnap = await getDocs(collection(dbFirestore, 'pilots'));
    pilotsSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        state.pilotsById.set(docSnap.id, {
            tag: data.tag || '',
            teamName: data.teamName || '',
            game: (data.game || '').toString(), // "MK8" | "MKW"
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

        const phaseChanged = phase !== state.phase;
        state.phase = phase;
        state.raceId = raceId;

        updateRaceStateDisplay();
        chooseAndApplyMode();

        if (phaseChanged) {
            // reset snapshot pour éviter triangles à la 1ʳᵉ course
            state.lastOrderKey = null;
            state.lastRanksSnapshot.clear();
            state.indicatorUntil.clear();
            state.lastDeltaDir.clear();

            // NEW: annuler sweep TTL en cours
            if (state.indicatorSweepTimer) {
                clearTimeout(state.indicatorSweepTimer);
                state.indicatorSweepTimer = null;
            }

            resubscribeTotals();
        }
    });

    const viewModeRef = ref(dbRealtime, 'context/viewMode');
    onValue(viewModeRef, (snap) => {
        const val = snap.val();
        state.viewModeOverride = val || null;
        chooseAndApplyMode();
    });

    const viewScopeRef = ref(dbRealtime, 'context/viewScope');
    onValue(viewScopeRef, (snap) => {
        const val = snap.val();
        state.viewScope = (val === 'team') ? 'team' : 'pilot';
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
    const $state = document.getElementById('race-state');
    if (!$state) return;

    const text = computeRaceStateText();
    setRaceStateTextWithMarquee($state, text);
}

// ----------------------
// Sélection du mode
// ----------------------
function computeModeKeyAuto() {
    if (state.viewScope === 'team') {
        return (state.phase === 'mk8') ? 'teams-6' : 'teams-8';
    }

    if (state.phase === 'mk8') {
        const rid = state.raceId;
        if (!rid) {
            return state.mk8LastFinalized ? 'mk8-12' : 'msg-prestart';
        }
        if (totalsAllZeroOrEmpty(state.totals)) {
            return 'msg-mk8-noscores';
        }
        return 'mk8-12';
    }

    if (state.phase === 'mkw') {
        const rid = state.raceId;
        if (!rid) {
            return state.mkwFinalFinalized ? 'mkw-24' : 'msg-mkw-noscores';
        }
        if (totalsAllZeroOrEmpty(state.totals)) {
            return 'msg-mkw-noscores';
        }
        return 'mkw-24';
    }

    return 'mkw-24';
}

function computeModeKey() {
    if (window.__CL_FORCE_MODE && MODES[window.__CL_FORCE_MODE]) {
        return window.__CL_FORCE_MODE;
    }
    const ov = state.viewModeOverride;
    if (ov && ov !== 'auto' && MODES[ov]) {
        return ov;
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
              `
        );
        return;
    }

    // Sinon: lignes
    renderRowsSkeleton(m.rows);
    renderList();
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
    if (m.type === 'message') return;

    // Construire la liste des items
    const items = [];
    state.totals.forEach((points, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toLowerCase();
        if (state.modeKey === 'mk8-12' && gameNorm !== 'mk8') return;
        if (state.modeKey === 'mkw-24' && gameNorm !== 'mkw') return;

        const team = state.teamsByName.get(p.teamName) || {};
        const logo = team.urlLogo ? resolveAssetPath(team.urlLogo) : '';

        items.push({
            pilotId,
            tag: p.tag || '',
            teamName: p.teamName || '',
            logo,
            points: Number(points) || 0,
            name: p.name || '',
            num: p.num || '',
            urlPhoto: p.urlPhoto ? resolveAssetPath(p.urlPhoto) : '',
            bonuses: 0 // (autres bonus à venir)
        });
    });

    // --- Tri avancé
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

        // Nouveau changement d'ordre ?
        if (strictOk && state.lastOrderKey && state.lastOrderKey !== currentOrderKey) {
            if (prevRank != null) {
                const delta = prevRank - (i + 1);
                if (delta !== 0) {
                    state.indicatorUntil.set(entry.pilotId, now + CFG.changeIndicatorMs);
                    state.lastDeltaDir.set(entry.pilotId, Math.sign(delta)); // -1 ou +1
                }
            }
        }

        // Vérifier TTL en cours
        const ttl = state.indicatorUntil.get(entry.pilotId) || 0;
        if (ttl > now) {
            const dir = state.lastDeltaDir.get(entry.pilotId) || 0;
            variation = dir;
        } else {
            state.indicatorUntil.delete(entry.pilotId);
            state.lastDeltaDir.delete(entry.pilotId);
            variation = 0;
        }

        setRow($row, {
            position: i + 1,
            logo: entry.logo,
            tag: entry.tag,
            bonusContent: '',
            pointsText: formatPoints(entry.points),
            variation
        });
    }

    // snapshot
    state.lastOrderKey = currentOrderKey;
    state.lastRanksSnapshot = currentRanks;
    
    // planifier un sweep pour la fin du TTL la plus proche
    scheduleIndicatorSweep();
    
    restartSwapCycle();
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
    // Si mode "message", on ne schedule rien
    const m = MODES[state.modeKey] || MODES['mkw-24'];
    if (m.type === 'message') return;
    // Si aucune ligne, on ne schedule pas
    const $list = document.getElementById('cw-list');
    if (!$list || !$list.querySelector('.cw-row')) return;

    // Démarre un cycle : attendre TAG puis passer à la fiche pour tout le monde
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

    subscribeContext();
    subscribeFinals();
    resubscribeTotals();

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
