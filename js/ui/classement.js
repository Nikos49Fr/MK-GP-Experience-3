// /js/ui/classement.js
// ----------------------------------------------------
// Classement Widget — MK GP Experience 3 (Factory version)
// - Réutilisable : initClassement(container, options) → { destroy, refresh, setMode, setScope }
// - Aucune dépendance au document global pour le rendu (scope DOM limité au container)
// - SCSS conservé tel quel (classes .classement-widget, .cw-list, .cw-row, etc.)
// ----------------------------------------------------

import { dbFirestore, dbRealtime } from '../firebase-config.js';
import {
    collection,
    getDocs,
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';
import {
    ref,
    onValue
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

// ----------------------
// Factory root scoping (injection par conteneur)
// ----------------------
let __CL_ROOT__ = null; // Conteneur racine de l'instance du widget

function __setRoot(el) {
    __CL_ROOT__ = el || null;
}

function __qs(sel) {
    return __CL_ROOT__ ? __CL_ROOT__.querySelector(sel) : document.querySelector(sel);
}

// ----------------------
// Config (modifiable via options)
// ----------------------
const CFG = {
    // comportement texte d’état
    stateGutterPx: 8,

    // affichage
    rowHeightPx: 64,

    // debounce totals
    totalsDebounceMs: 150,

    // header
    headerLogo: './assets/images/MK_Grand_Prix-Experience_redim.png'
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
    // Si l'URL est absolue, on ne touche pas
    if (/^https?:\/\//i.test(storedPath)) return storedPath;

    // Cas le plus fréquent : Firestore stocke "./assets/images/..."
    // Sur /pages/* on doit remonter d'un cran → "../assets/..."
    if (storedPath.startsWith('./assets/')) {
        const onPages = location.pathname.includes('/pages/');
        return onPages ? ('../' + storedPath.slice(2)) : storedPath;
    }

    // Si on nous donne déjà "../assets/...", on garde
    if (storedPath.startsWith('../assets/')) return storedPath;

    // Fallback : construire une URL relative au dossier courant
    try {
        const base = new URL('.', location.href);
        return new URL(storedPath, base).href;
    } catch {
        return storedPath;
    }
}

function formatPoints(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v === 1) return '1 pt';
    return `${v} pts`;
}

function simpleRaceLabel(phase, raceId) {
    if (!phase) return '—';
    const up = String(phase).toUpperCase();
    if (!raceId) return `${up}`;
    if (raceId === 'S') return `${up} — Survie`;
    if (raceId === 'SF') return `${up} — Survie Finale`;
    return `${up} — Course ${raceId}`;
}

function totalsAllZeroOrEmpty(map) {
    if (!map || map.size === 0) return true;
    for (const [, v] of map) {
        if ((Number(v) || 0) > 0) return false;
    }
    return true;
}

// ----------------------
// DOM scaffold
// ----------------------
function ensureScaffold($root) {
    $root.innerHTML = '';
    $root.classList.add('classement-widget');

    const $header = document.createElement('div');
    $header.className = 'cw-header';

    const $logo = document.createElement('img');
    $logo.alt = 'MK Grand Prix Experience';
    $logo.src = resolveAssetPath(CFG.headerLogo);
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

// ----------------------
// State
// ----------------------
const state = {
    // contexte course
    phase: 'mk8',      // 'mk8' | 'mkw'
    raceId: null,      // '1'..'12' | 'S' | 'SF' | null

    // données
    pilotsById: new Map(), // { id -> { tag, teamName, game, name, num, urlPhoto } }
    teamsByName: new Map(), // { teamName -> { urlLogo, color1, color2 } }
    totals: new Map(), // { pilotId -> points }
    unsubTotals: null,

    // finals
    mk8LastFinalized: false,
    mkwFinalFinalized: false,
    mk8FinalizedRaceIds: new Set(),
    mkwFinalizedRaceIds: new Set(),

    // mode courant calculé ou forcé
    modeKey: 'mk8-12',
    viewModeOverride: null,   // 'auto' | explicit
    viewScope: 'pilot',       // 'pilot' | 'team'

    // listeners RTDB
    unsubs: []
};

// ----------------------
// Firestore preload
// ----------------------
async function preloadFirestore() {
    // Teams
    try {
        const teamsSnap = await getDocs(collection(dbFirestore, 'teams'));
        teamsSnap.forEach(doc => {
            const d = doc.data() || {};
            const name = d.name || '';
            state.teamsByName.set(name, {
                name,
                tag: d.tag || '',
                urlLogo: d.urlLogo || '',
                color1: d.color1 || '#000',
                color2: d.color2 || '#000'
            });
        });
    } catch (e) {
        console.warn('[classement] Firestore teams inaccessibles:', e);
    }

    // Pilots
    try {
        const pilotsSnap = await getDocs(collection(dbFirestore, 'pilots'));
        pilotsSnap.forEach(doc => {
            const d = doc.data() || {};
            state.pilotsById.set(doc.id, {
                id: doc.id,
                tag: d.tag || '',
                teamName: d.teamName || '',
                game: (d.game || '').toString().toUpperCase(), // MK8 | MKW
                name: d.name || '',
                num: d.num || '',
                urlPhoto: d.urlPhoto || ''
            });
        });
    } catch (e) {
        console.warn('[classement] Firestore pilots inaccessibles:', e);
    }
}

// ----------------------
// RTDB subscriptions
// ----------------------
function subscribeContext() {
    const ctxRef = ref(dbRealtime, 'context/current');
    const u1 = onValue(ctxRef, (snap) => {
        const v = snap.val() || {};
        const phase = (v.phase || 'mk8').toString().toLowerCase();
        const raceId = v.raceId || null;

        const phaseChanged = phase !== state.phase;
        state.phase = phase;
        state.raceId = raceId;

        updateRaceStateDisplay();
        chooseAndApplyMode();

        if (phaseChanged) {
            // re-souscrire aux totals sur la phase
            resubscribeTotals();
        }
    });
    state.unsubs.push(u1);
}

function subscribeFinals() {
    const mk8ref = ref(dbRealtime, 'live/races/mk8');
    const u2 = onValue(mk8ref, (snap) => {
        const data = snap.val() || {};
        const finals = Object.entries(data).filter(([rid, v]) => v && v.finalized);
        state.mk8LastFinalized = Boolean(data['8'] && data['8'].finalized);
        state.mk8FinalizedRaceIds = new Set(finals.map(([rid]) => rid));
        updateRaceStateDisplay();
        chooseAndApplyMode();
    });
    state.unsubs.push(u2);

    const mkwref = ref(dbRealtime, 'live/races/mkw');
    const u3 = onValue(mkwref, (snap) => {
        const data = snap.val() || {};
        const finals = Object.entries(data).filter(([rid, v]) => v && v.finalized);
        state.mkwFinalFinalized = Boolean(data['SF'] && data['SF'].finalized);
        state.mkwFinalizedRaceIds = new Set(finals.map(([rid]) => rid));
        updateRaceStateDisplay();
        chooseAndApplyMode();
    });
    state.unsubs.push(u3);
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
            chooseAndApplyMode(); // déclenche (re)rendu
        }, CFG.totalsDebounceMs);
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
        return simpleRaceLabel('MKW', rid);
    }

    // MK8
    const rid = state.raceId;
    if (!rid) {
        return state.mk8LastFinalized
            ? 'MK8 - Session précédente terminée'
            : 'MK8 - En attente de départ';
    }
    return simpleRaceLabel('MK8', rid);
}

function updateRaceStateDisplay() {
    const $state = __qs('#race-state');
    if (!$state) return;
    const text = computeRaceStateText();
    $state.textContent = text;
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

    // MKW
    const rid = state.raceId;
    if (!rid) {
        return state.mkwFinalFinalized ? 'mkw-24' : 'msg-prestart';
    }
    if (totalsAllZeroOrEmpty(state.totals)) {
        return 'msg-mkw-noscores';
    }
    return 'mkw-24';
}

function chooseAndApplyMode() {
    const modeKey = state.viewModeOverride || computeModeKeyAuto();
    state.modeKey = modeKey;
    applyMode(modeKey);
}

function applyMode(modeKey) {
    const $root = __CL_ROOT__;
    if (!$root) return;

    // classes modifieurs
    Object.values(MODES).forEach(m => $root.classList.remove(m.className));
    const mode = MODES[modeKey] || MODES['mk8-12'];
    $root.classList.add(mode.className);

    // Construire squelette si nécessaire
    const $list = __qs('#cw-list');
    if ($list) {
        $list.innerHTML = '';
        for (let i = 1; i <= mode.rows; i++) {
            $list.appendChild(buildRowSkeleton(i));
        }
    }

    // Rendu selon type
    if (mode.type === 'message') {
        renderMessage(modeKey);
    } else if (mode.type === 'team') {
        renderTeams(mode.rows);
    } else {
        renderPilots(mode.rows);
    }
}

// ----------------------
// Rendu
// ----------------------
function renderMessage(modeKey) {
    const $list = __qs('#cw-list');
    if (!$list) return;
    $list.innerHTML = '';

    const $msg = document.createElement('div');
    $msg.className = 'cw-row cw-message';
    const $tag = document.createElement('div');
    $tag.className = 'col-tag';
    $tag.textContent = (modeKey.includes('mk8')) ? 'MK8 — En attente de scores' :
                       (modeKey.includes('mkw')) ? 'MK World — En attente de scores' :
                       'En attente de départ';
    $msg.appendChild(document.createElement('div')).className = 'col-rank';
    $msg.appendChild(document.createElement('div')).className = 'col-team';
    $msg.appendChild($tag);
    $msg.appendChild(document.createElement('div')).className = 'col-bonus';
    $msg.appendChild(document.createElement('div')).className = 'col-points';
    $list.appendChild($msg);
}

function renderPilots(rowCount) {
    const $list = __qs('#cw-list');
    if (!$list) return;

    // Construire la liste des pilotes de la phase
    const items = [];
    state.totals.forEach((points, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toUpperCase();
        if (state.phase === 'mk8' && gameNorm !== 'MK8') return;
        if (state.phase === 'mkw' && gameNorm !== 'MKW') return;

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
            urlPhoto: p.urlPhoto ? resolveAssetPath(p.urlPhoto) : ''
        });
    });

    // Tri : points desc, puis tag
    items.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return a.tag.localeCompare(b.tag);
    });

    const rows = Array.from($list.children);
    const n = Math.min(rowCount, rows.length);

    for (let i = 0; i < n; i++) {
        const item = items[i] || null;
        const $row = rows[i];
        if (!$row) continue;

        if (!item) {
            $row.classList.add('is-empty');
            $row.querySelector('.col-team .team-logo').style.visibility = 'hidden';
            $row.querySelector('.col-tag').textContent = '';
            $row.querySelector('.col-points').textContent = '';
            continue;
        }

        $row.classList.remove('is-empty');

        // Rang
        const $rank = $row.querySelector('.col-rank');
        $rank.textContent = String(i + 1);

        // Logo équipe
        const $img = $row.querySelector('.col-team .team-logo');
        if (item.logo) {
            $img.src = item.logo;
            $img.alt = 'Logo équipe';
            $img.style.visibility = 'visible';
        } else {
            $img.removeAttribute('src');
            $img.alt = '';
            $img.style.visibility = 'hidden';
        }

        // Tag (pas d’animation ici — version factory simple)
        const $tag = $row.querySelector('.col-tag');
        $tag.textContent = item.tag;

        // Points
        const $pts = $row.querySelector('.col-points');
        $pts.textContent = formatPoints(item.points);
    }
}

function renderTeams(rowCount) {
    const $list = __qs('#cw-list');
    if (!$list) return;

    // Agrégation par équipe
    const teamMap = new Map(); // name -> { name, tag, logo, points }
    state.totals.forEach((pts, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toUpperCase();
        if (state.phase === 'mk8' && gameNorm !== 'MK8') return;
        if (state.phase === 'mkw' && gameNorm !== 'MKW') return;

        const t = state.teamsByName.get(p.teamName) || {};
        const key = p.teamName || t.name || '???';
        const prev = teamMap.get(key) || {
            name: key,
            tag: t.tag || key,
            logo: t.urlLogo ? resolveAssetPath(t.urlLogo) : '',
            points: 0
        };
        prev.points += Number(pts) || 0;
        teamMap.set(key, prev);
    });

    const items = Array.from(teamMap.values());
    items.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return a.tag.localeCompare(b.tag);
    });

    const rows = Array.from($list.children);
    const n = Math.min(rowCount, rows.length);

    for (let i = 0; i < n; i++) {
        const item = items[i] || null;
        const $row = rows[i];
        if (!$row) continue;

        if (!item) {
            $row.classList.add('is-empty');
            $row.querySelector('.col-team .team-logo').style.visibility = 'hidden';
            $row.querySelector('.col-tag').textContent = '';
            $row.querySelector('.col-points').textContent = '';
            continue;
        }

        $row.classList.remove('is-empty');

        // Rang
        const $rank = $row.querySelector('.col-rank');
        $rank.textContent = String(i + 1);

        // Logo équipe
        const $img = $row.querySelector('.col-team .team-logo');
        if (item.logo) {
            $img.src = item.logo;
            $img.alt = 'Logo équipe';
            $img.style.visibility = 'visible';
        } else {
            $img.removeAttribute('src');
            $img.alt = '';
            $img.style.visibility = 'hidden';
        }

        // Tag (nom d’équipe)
        const $tag = $row.querySelector('.col-tag');
        $tag.textContent = item.tag || item.name;

        // Points
        const $pts = $row.querySelector('.col-points');
        $pts.textContent = formatPoints(item.points);
    }
}

// ----------------------
// Destroy (désabonnements et nettoyage DOM)
// ----------------------
function destroy() {
    try {
        if (state.unsubTotals) {
            try { state.unsubTotals(); } catch (_) {}
            state.unsubTotals = null;
        }
        if (Array.isArray(state.unsubs)) {
            for (const u of state.unsubs) {
                try { if (typeof u === 'function') u(); } catch (_) {}
            }
            state.unsubs = [];
        }
    } finally {
        if (__CL_ROOT__) {
            __CL_ROOT__.innerHTML = '';
        }
        __setRoot(null);
    }
}

// ----------------------
// Factory API
// ----------------------
export async function initClassement(container, options = {}) {
    const el = (typeof container === 'string') ? document.querySelector(container) : container;
    if (!el) {
        console.warn('[classement] Conteneur introuvable pour initClassement().');
        return { destroy(){} };
    }
    __setRoot(el);
    ensureScaffold(el);

    // Options utilisateur (override non destructif)
    try {
        Object.assign(CFG, options || {});
    } catch (_) {}

    try {
        await preloadFirestore();
    } catch (err) {
        console.error('[classement] Erreur Firestore:', err);
    }

    subscribeContext();
    subscribeFinals();
    resubscribeTotals();

    chooseAndApplyMode();

    return {
        destroy,
        refresh() { chooseAndApplyMode(); },
        setMode(key) {
            state.viewModeOverride = key || null;
            chooseAndApplyMode();
        },
        setScope(scope) {
            state.viewScope = (scope === 'team') ? 'team' : 'pilot';
            chooseAndApplyMode();
        }
    };
}
