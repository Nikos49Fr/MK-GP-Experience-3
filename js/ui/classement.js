// /js/ui/classement.js
// ----------------------------------------------------
// Classement Widget — MK GP Experience 3
// - Modes d’affichage (pilotes 12/24, équipes 6/8, messages)
// - Texte d’état + défilement (marquee)
// - Données: Firestore (teams/pilots), RTDB (context, totals, finals, overrides)
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
// Marquee (texte défilant)
// ----------------------
// Gestion timers/listeners pour éviter les fuites entre changements de texte
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

/**
 * Affiche le texte du state sur une seule ligne, sans overflow visible.
 * Si le texte déborde, on anime:
 *   - pause 2s au début (on voit le début du texte)
 *   - scroll linéaire 5s vers la gauche (pour révéler la suite)
 *   - pause 2s en fin
 *   - retour 5s au point de départ
 * …et on boucle ainsi.
 */

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

        // Décalage initial : décale toute la piste de +GUTTER
        track.style.transform = `translateX(${GUTTER}px)`;

        // SI PAS DE DÉBORDEMENT → CENTRER + MARGES
        if (overflow <= 0) {
            // Centre le contenu
            $state.style.justifyContent = 'center';
            // remets une petite marge visuelle sur le conteneur
            $state.style.padding = `0 ${GUTTER}px`;
            // neutralise toute transition/translation du track
            track.style.transition = 'none';
            track.style.transform = 'translateX(0)';
            return;
        }

        const START_DELAY = 2000;
        const END_DELAY = 2000;
        const DURATION = 2000;
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
    $list.innerHTML = '';
    for (let i = 0; i < rowCount; i++) {
        $list.appendChild(buildRowSkeleton(i + 1));
    }
}

function renderMessageBlock(htmlString) {
    const $list = document.getElementById('cw-list');
    if (!$list) return;
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
    pilotsById: new Map(),
    teamsByName: new Map(),
    totals: new Map(),
    unsubTotals: null,

    // finals
    mk8LastFinalized: false,  // live/races/mk8/8/finalized
    mkwFinalFinalized: false, // live/races/mkw/SF/finalized

    // mode courant calculé ou forcé
    modeKey: 'mkw-24',

    // overrides (Direction de course)
    viewModeOverride: null,   // 'auto' | <un des MODES> | null
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
            game: data.game || '' // "MK8" | "MKW"
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

    // Overrides de vue (Direction de course)
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
        return 'Tournoi terminé';
    }

    if (state.phase === 'mkw') {
        const rid = state.raceId;
        if (!rid) {
            // Après final MKW: rester sur scores finaux tant qu’on n’a pas quitté la phase
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
            // Après final MK8: rester sur scores finaux tant qu’on n’a pas basculé sur MKW
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
    // Scope équipe prioritaire si demandé
    if (state.viewScope === 'team') {
        // MK8 => base 6 équipes, MKW => 8 équipes (avec équipes secrètes)
        return (state.phase === 'mk8') ? 'teams-6' : 'teams-8';
    }

    // Scope pilote (auto)
    if (state.phase === 'mk8') {
        const rid = state.raceId;
        if (!rid) {
            // Si MK8 finalisé et pas encore basculé MKW -> rester sur scores finaux MK8
            return state.mk8LastFinalized ? 'mk8-12' : 'msg-prestart';
        }
        // En course MK8
        if (totalsAllZeroOrEmpty(state.totals)) {
            return 'msg-mk8-noscores';
        }
        return 'mk8-12';
    }

    if (state.phase === 'mkw') {
        const rid = state.raceId;
        if (!rid) {
            // Si MKW finalisé -> rester sur scores finaux MKW
            return state.mkwFinalFinalized ? 'mkw-24' : 'msg-mkw-noscores';
        }
        // En course MKW (numérique, S, SF)
        if (totalsAllZeroOrEmpty(state.totals)) {
            return 'msg-mkw-noscores';
        }
        return 'mkw-24';
    }

    // Fallback
    return 'mkw-24';
}

function computeModeKey() {
    // 1) Override local (debug) via window force ?
    if (window.__CL_FORCE_MODE && MODES[window.__CL_FORCE_MODE]) {
        return window.__CL_FORCE_MODE;
    }
    // 2) Override via RTDB (Direction de course)
    const ov = state.viewModeOverride;
    if (ov && ov !== 'auto' && MODES[ov]) {
        return ov;
    }
    // 3) Auto
    return computeModeKeyAuto();
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
        if (modeKey === 'msg-prestart') {
            renderMessageBlock(`
                <h2>Mario Kart<br/>GP Expérience</h2>
                <span>3</span>
                <p>A venir :</p>
                <h3>Tournoi MK 8 :</h3>
                <span>8 courses</span>
                <h3>Tournoi MKWorld :</h3>
                <span>6 courses</span>
                <span>1 survie</span>
                <span>6 courses</span>
                <span>1 survie finale</span>
            `);
        } else if (modeKey === 'msg-mk8-noscores') {
            renderMessageBlock(`
                <h2>Mario Kart<br/>GP Expérience</h2>
                <span>3</span>
                <h3>Phase 1 - MK 8 :</h3>
                <span>8 courses</span>
            `);
        } else if (modeKey === 'msg-mkw-noscores') {
            renderMessageBlock(`
                <h2>Mario Kart<br/>GP Expérience</h2>
                <span>3</span>
                <h3>Phase 2 - MK World :</h3>
                <span>6 courses + 1 survie + 6 courses + 1 survie finale</span>
            `);
        }
        return;
    }

    // Sinon: lignes
    renderRowsSkeleton(m.rows);
    renderList();
}

function chooseAndApplyMode() {
    const key = computeModeKey();
    if (key !== state.modeKey) {
        applyMode(key);
    } else {
        const m = MODES[key] || MODES['mkw-24'];
        if (m.type !== 'message') renderList();
    }
}

// Expose helpers (debug / autres pages)
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
            points: Number(points) || 0
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
    }
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

    if ($tag) $tag.textContent = tag || '';
    if ($bonus) $bonus.innerHTML = bonusContent || '';
    if ($pts) $pts.textContent = pointsText || '';
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
