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
    tagStandbyMs: 15000,     // temps d’attente en affichage TAG avant bascule sur fiche
    pilotScrollMs: 8000,     // durée du défilement (aller) de la fiche
    pilotPauseEndMs: 5000,   // pause en fin de défilement (avant retour au TAG)
    pilotBackPauseMs: 5000,   // pause après le défilement retour, avant de réafficher le TAG
    pilotStartDelayMs: 5000,   // délai avant de lancer le défilement aller
    gutterPx: 6,             // marge visuelle à gauche/droite dans la cellule tag
    edgePadPx: 2             // micro pad anti-overhang sur le scroller
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
function resolveAssetPath(storedPath) {
    if (!storedPath) return '';
    const stripped = storedPath.replace(/^\.\//, '');
    const segments = window.location.pathname.replace(/\/+$/, '').split('/');
    const depth = Math.max(0, segments.length - 2);
    const prefix = depth > 0 ? '../'.repeat(depth) : './';
    return prefix + stripped;
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

function setRaceStateTextWithMarquee($state, text) {
    _clearMarqueeRuntime();

    const GUTTER = 8;     // marge visible à gauche et à droite
    const EDGE_PAD = 3;   // anti-rognage des glyphes

    // Reset visuel
    $state.classList.remove('marquee');
    $state.innerHTML = '';
    $state.style.whiteSpace = 'nowrap';
    $state.style.overflow = 'hidden';
    $state.style.alignItems = 'center';
    $state.style.justifyContent = 'flex-start';
    $state.style.padding = '0'; // on ne s’appuie plus sur padding ici

    // Piste
    const track = document.createElement('div');
    track.className = 'marquee-track';
    track.style.display = 'inline-block';
    track.style.willChange = 'transform';
    track.style.transition = 'none';

    // Texte
    const span = document.createElement('span');
    span.textContent = text;
    span.style.padding = `0 ${EDGE_PAD}px`;

    track.appendChild(span);
    $state.appendChild(track);

    requestAnimationFrame(() => {
        const visible = $state.clientWidth - (GUTTER * 2);
        const full = track.scrollWidth;
        const overflow = Math.max(0, full - visible);

        // Décalage initial : gouttière gauche
        track.style.transform = `translateX(${GUTTER}px)`;

        // Si pas de débordement → centrer + petite marge
        if (overflow <= 0) {
            $state.style.justifyContent = 'center';
            $state.style.padding = `0 ${GUTTER}px`;
            track.style.transition = 'none';
            track.style.transform = 'translateX(0)';
            return;
        }

        // Timings (tu peux ajuster)
        const START_DELAY = 4000;
        const END_DELAY = 2000;
        const DURATION = 3000;
        let directionLeft = true;

        function goOnce() {
            track.style.transition = `transform ${DURATION}ms linear`;
            const targetX = directionLeft ? -(overflow - EDGE_PAD) : GUTTER;
            requestAnimationFrame(() => {
                track.style.transform = `translateX(${targetX}px)`;
            });

            const onEnd = () => {
                track.removeEventListener('transitionend', onEnd);
                _marqueeOnEnd = null;
                const t2 = setTimeout(() => {
                    directionLeft = !directionLeft;
                    track.style.transition = 'none';
                    track.style.transform = directionLeft
                        ? `translateX(${GUTTER}px)`
                        : `translateX(${-(overflow - EDGE_PAD)}px)`;
                    requestAnimationFrame(goOnce);
                }, END_DELAY);
                _marqueeTimers.push(t2);
            };
            _marqueeOnEnd = { el: track, fn: onEnd };
            track.addEventListener('transitionend', onEnd);
        }

        const t1 = setTimeout(goOnce, START_DELAY);
        _marqueeTimers.push(t1);
    });
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

    // mode courant calculé ou forcé
    modeKey: 'mkw-24',

    // overrides (Direction de course)
    viewModeOverride: null,   // 'auto' | explicit
    viewScope: 'pilot'        // 'pilot' | 'team'
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

        if (phaseChanged) resubscribeTotals();
    });

    const viewModeRef = ref(dbRealtime, 'context/viewMode'); // 'auto' | explicit
    onValue(viewModeRef, (snap) => {
        const val = snap.val();
        state.viewModeOverride = val || null;
        chooseAndApplyMode();
    });

    const viewScopeRef = ref(dbRealtime, 'context/viewScope'); // 'pilot' | 'team'
    onValue(viewScopeRef, (snap) => {
        const val = snap.val();
        state.viewScope = (val === 'team') ? 'team' : 'pilot';
        chooseAndApplyMode();
    });
}

function subscribeFinals() {
    const mk8ref = ref(dbRealtime, 'live/races/mk8/8/finalized');
    onValue(mk8ref, (snap) => {
        state.mk8LastFinalized = Boolean(snap.val());
        updateRaceStateDisplay();
        chooseAndApplyMode();
    });

    const mkwref = ref(dbRealtime, 'live/races/mkw/SF/finalized');
    onValue(mkwref, (snap) => {
        state.mkwFinalFinalized = Boolean(snap.val());
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
    const unsubscribe = onValue(totalsRef, (snap) => {
        const obj = snap.val() || {};
        state.totals.clear();
        Object.entries(obj).forEach(([pilotId, pts]) => {
            state.totals.set(pilotId, Number(pts) || 0);
        });
        chooseAndApplyMode();
        renderList(); // si mode lignes
    });
    state.unsubTotals = unsubscribe;
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
function renderList() {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    const m = MODES[state.modeKey] || MODES['mkw-24'];
    if (m.type === 'message') return;

    const items = [];
    state.totals.forEach((points, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toLowerCase(); // "mk8" | "mkw"
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
            // extra pour swap fiche
            name: p.name || '',
            num: p.num || '',
            urlPhoto: p.urlPhoto ? resolveAssetPath(p.urlPhoto) : ''
        });
    });

    items.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        const ta = a.tag || '';
        const tb = b.tag || '';
        return ta.localeCompare(tb);
    });

    const rows = $list.children;
    const rowCount = rows.length;

    for (let i = 0; i < rowCount; i++) {
        const $row = rows[i];
        if (!$row) continue;

        const entry = items[i];
        if (!entry) {
            $row.classList.add('is-empty');
            setRow($row, {
                position: i + 1,
                logo: '',
                tag: '',
                bonusContent: '',
                pointsText: ''
            });
            // aussi nettoyer dataset
            $row.dataset.pilotId = '';
            continue;
        }

        $row.classList.remove('is-empty');
        setRow($row, {
            position: i + 1,
            logo: entry.logo,
            tag: entry.tag,
            bonusContent: '',
            pointsText: formatPoints(entry.points)
        });

        // stocke les infos utiles pour le swap
        $row.dataset.pilotId = entry.pilotId;
        $row.dataset.pilotName = entry.name;
        $row.dataset.pilotNum = entry.num;
        $row.dataset.pilotPhoto = entry.urlPhoto || '';
    }

    // (Ré)lance le cycle synchronisé après le rendu
    restartSwapCycle();
}

function setRow($row, { position, logo, tag, bonusContent, pointsText }) {
    const $rank = $row.querySelector('.col-rank');
    const $team = $row.querySelector('.col-team .team-logo');
    const $tag = $row.querySelector('.col-tag');
    const $bonus = $row.querySelector('.col-bonus');
    const $pts = $row.querySelector('.col-points');

    if ($rank) $rank.textContent = String(position);

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

    // Mise à jour de la colonne tag :
    // - si on est actuellement en mode "fiche", on MAJ la fiche
    // - sinon, on affiche le tag simple
    if ($tag) {
        if ($tag.classList.contains('mode-pilot')) {
            // on reconstruit la fiche avec les datasets courants
            renderPilotCardInto($tag, {
                name: $row.dataset.pilotName || '',
                num: $row.dataset.pilotNum || '',
                urlPhoto: $row.dataset.pilotPhoto || ''
            });
        } else {
            $tag.textContent = tag || '';
        }
    }

    if ($bonus) $bonus.innerHTML = bonusContent || '';
    if ($pts) $pts.textContent = pointsText || '';
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

    // Rendu des fiches pour toutes les lignes (position de départ = gouttière)
    rows.forEach(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        if (!$tagCell) return;
        renderPilotCardInto($tagCell, {
            name: ($row.dataset.pilotName || '').toString(),
            num: ($row.dataset.pilotNum || '').toString(),
            urlPhoto: ($row.dataset.pilotPhoto || '').toString()
        });
    });

    // Mesures d’overflow
    const overflows = rows.map(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        return getOverflowForCell($tagCell);
    });
    const maxOverflow = Math.max(...overflows, 0);

    // Démarre l’aller pour toutes les lignes APRÈS un délai commun
    setTimeout(() => {
        rows.forEach(($row, idx) => {
            const $tagCell = $row.querySelector('.col-tag');
            runPilotScrollWithGlobal($tagCell, overflows[idx], maxOverflow, CFG.pilotScrollMs);
        });
    }, CFG.pilotStartDelayMs);

    // Planifie la PHASE RETOUR synchronisée (aller + pause fin)
    swapCtrl.tStartBackPhase = setTimeout(
        startPilotBackPhaseAll,
        CFG.pilotStartDelayMs + CFG.pilotScrollMs + CFG.pilotPauseEndMs
    );

    // Planifie le retour au TAG (aller + pause fin + retour + pause avant TAG)
    swapCtrl.tBackToTag = setTimeout(
        backToTagAll,
        CFG.pilotStartDelayMs + CFG.pilotScrollMs + CFG.pilotPauseEndMs + CFG.pilotScrollMs + CFG.pilotBackPauseMs
    );
}

function startPilotBackPhaseAll() {
    swapCtrl.tStartBackPhase = null;

    const rows = getActiveRows();
    if (rows.length === 0) return;

    // Mesure overflows de nouveau (au cas où la largeur a changé)
    const overflows = rows.map(($row) => {
        const $tagCell = $row.querySelector('.col-tag');
        return getOverflowForCell($tagCell);
    });
    const maxOverflow = Math.max(...overflows, 0);

    // Lancer le scroll "retour" pour chaque ligne (durée proportionnelle, même vitesse commune)
    rows.forEach(($row, idx) => {
        const $tagCell = $row.querySelector('.col-tag');
        runPilotScrollBackWithGlobal($tagCell, overflows[idx], maxOverflow, CFG.pilotScrollMs);
    });
}

function getOverflowForCell($tagCell) {
    if (!$tagCell) return 0;
    const scroller = $tagCell.querySelector('.tagcard-scroller');
    if (!scroller) return 0;

    // largeur visible dispo dans la cellule (moins gouttières visuelles)
    const visible = Math.max(0, $tagCell.clientWidth - (CFG.gutterPx * 2));
    // largeur totale du bloc défilant (image+num+nom)
    const full = scroller.scrollWidth;

    // NE PAS toucher à transform/transition ici (sinon on casse l'état courant)
    return Math.max(0, full - visible);
}

function runPilotScrollBackWithGlobal($tagCell, overflow, maxOverflow, maxDurationMs) {
    const scroller = $tagCell ? $tagCell.querySelector('.tagcard-scroller') : null;
    if (!scroller) return;

    if (overflow <= 0 || maxOverflow <= 0) {
        scroller.style.transition = 'none';
        scroller.style.transform = `translateX(${CFG.gutterPx}px)`;
        return;
    }

    const durationMs = Math.max(50, Math.round((overflow / maxOverflow) * maxDurationMs));
    const startX = - (overflow - CFG.edgePadPx);
    const targetX = CFG.gutterPx;

    // Place explicitement le point de départ (fin d’aller)
    scroller.style.transition = 'none';
    scroller.style.transform = `translateX(${startX}px)`;

    // ⚠️ Reflow avant de définir la transition retour
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
        const $tagCell = $row.querySelector('.col-tag');
        if (!$tagCell) return;
        $tagCell.classList.remove('mode-pilot');
        // remet le tag textuel
        const p = state.pilotsById.get($row.dataset.pilotId || '');
        $tagCell.textContent = (p && p.tag) ? p.tag : '';
    });

    // Puis on relance un cycle complet
    restartSwapCycle();
}

function getActiveRows() {
    const $list = document.getElementById('cw-list');
    if (!$list) return [];
    const rows = Array.from($list.querySelectorAll('.cw-row')).filter(el => !el.classList.contains('is-empty'));
    return rows;
}

/**
 * Rend la fiche pilote DANS un scroller horizontal (image + numéro + nom)
 * L’ensemble défile comme un bloc.
 */
function renderPilotCardInto($container, { name, num, urlPhoto }) {
    $container.classList.add('mode-pilot');
    const safeName = (name || '').toUpperCase();
    const safeNum = (num || '').toString();
    const photo = urlPhoto ? resolveAssetPath(urlPhoto) : '';

    // scroller = élément qui se translate; on lui applique des paddings anti-overhang
    $container.innerHTML = `
        <div class="tagcard-scroller" style="
            display:inline-flex;align-items:center;gap:6px;
            transform: translateX(0); transition: none;
            padding: 0 ${CFG.edgePadPx}px;
        ">
            <img class="tagcard-photo" alt="" src="${photo}" style="
                width:24px;height:24px;object-fit:cover;border-radius:3px;${photo ? '' : 'display:none;'}
            " />
            <div class="tagcard-line" style="display:inline-flex;align-items:center;gap:4px;">
                ${safeNum ? `<span class="tagcard-num" style="font-weight:700;">${safeNum}.</span>` : ''}
                <span class="tagcard-name" style="white-space:nowrap;display:inline-block;">${safeName}</span>
            </div>
        </div>
    `;
    // Position de départ sûre (gouttière)
    const scroller = $container.querySelector('.tagcard-scroller');
    if (scroller) {
        scroller.style.transition = 'none';
        scroller.style.transform = `translateX(${CFG.gutterPx}px)`;
    }
}

/**
 * Fait défiler le scroller à gauche (aller) en durée fixe; s’il n’y a pas d’overflow
 * on ne bouge pas mais on attend la même durée (synchro globale).
 */
function runPilotScrollWithGlobal($tagCell, overflow, maxOverflow, maxDurationMs) {
    const scroller = $tagCell ? $tagCell.querySelector('.tagcard-scroller') : null;
    if (!scroller) return;

    // Position de départ (gouttière gauche) — déjà posée par renderPilotCardInto,
    // mais on s’assure de l’état:
    scroller.style.transition = 'none';
    scroller.style.transform = `translateX(${CFG.gutterPx}px)`;

    if (overflow <= 0 || maxOverflow <= 0) {
        return; // rien à défiler pour cette ligne, elle attendra les autres
    }

    const durationMs = Math.max(50, Math.round((overflow / maxOverflow) * maxDurationMs));
    const targetX = - (overflow - CFG.edgePadPx);

    // ⚠️ Force un reflow pour garantir l’application du transform de départ
    // avant de poser la transition, sinon certains navigateurs sautent directement à la fin
    // (ce qui donnait l’effet “instantané”).
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
