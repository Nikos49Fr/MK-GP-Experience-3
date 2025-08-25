// /js/ui/classement.js
// ----------------------------------------------------
// Classement Widget — MK GP Experience 3
// - Remplit la <section.classement-widget> (250x800)
// - Logo header (chemin relatif robuste)
// - État de course (RTDB: /context/current)
// - Classement 24 lignes (RTDB: /live/points/{phase}/totals), logos d'équipe (Firestore: teams), tags pilotes (Firestore: pilots)
// - Colonne bonus (vide pour l’instant) avant la colonne points
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
// Helpers
// ----------------------

/**
 * Retourne un chemin asset correct quel que soit le niveau de sous-dossier.
 * La BDD/constantes stockent des chemins du type "./assets/images/…"
 * - Depuis /index.html => "./assets/images/…"
 * - Depuis /pages/*.html => "../assets/images/…"
 */
function resolveAssetPath(storedPath) {
    if (!storedPath) return '';
    const stripped = storedPath.replace(/^\.\//, ''); // "assets/images/…"
    const segments = window.location.pathname.replace(/\/+$/, '').split('/');
    const depth = Math.max(0, segments.length - 2);
    const prefix = depth > 0 ? '../'.repeat(depth) : './';
    return prefix + stripped;
}

/** Format points: 0=>"", 1=>"1 pt", n=>"n pts" */
function formatPoints(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '';
    if (v === 1) return '1 pt';
    return `${v} pts`;
}

/** Affichage simple phase/course */
function formatRaceState({ phase, raceId }) {
    if (!phase) return '—';
    const up = String(phase).toUpperCase();
    if (!raceId) return `${up}`;
    if (raceId === 'S') return `${up} — Survie`;
    if (raceId === 'SF') return `${up} — Survie Finale`;
    return `${up} — Course ${raceId}`;
}

// ----------------------
// DOM construction
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

    // 24 lignes vides
    for (let i = 0; i < 24; i++) {
        $list.appendChild(buildRowSkeleton(i + 1));
    }

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
    // (sera rempli plus tard quand la logique bonus sera branchée)

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
// State & data
// ----------------------
const state = {
    phase: 'mk8',
    raceId: null,
    pilotsById: new Map(),   // { id -> { tag, teamName, game } }
    teamsByName: new Map(),  // { teamName -> { urlLogo } }
    totals: new Map(),       // { pilotId -> number }
    unsubTotals: null
};

async function preloadFirestore() {
    // Teams
    const teamsSnap = await getDocs(collection(dbFirestore, 'teams'));
    teamsSnap.forEach(docSnap => {
        const data = docSnap.data() || {};
        state.teamsByName.set(data.name, {
            urlLogo: data.urlLogo || ''
        });
    });

    // Pilots
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

function subscribeContext() {
    const ctxRef = ref(dbRealtime, 'context/current');
    onValue(ctxRef, (snap) => {
        const v = snap.val() || {};
        const phase = (v.phase || 'mk8').toString().toLowerCase();
        const raceId = v.raceId || null;

        const changedPhase = phase !== state.phase;
        state.phase = phase;
        state.raceId = raceId;

        const $state = document.getElementById('race-state');
        if ($state) $state.textContent = formatRaceState({ phase, raceId });

        if (changedPhase) resubscribeTotals();
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
        renderList();
    });
    state.unsubTotals = unsubscribe;
}

// ----------------------
// Rendering
// ----------------------
function renderList() {
    const $list = document.getElementById('cw-list');
    if (!$list) return;

    const items = [];
    state.totals.forEach((points, pilotId) => {
        const p = state.pilotsById.get(pilotId);
        if (!p) return;

        const gameNorm = (p.game || '').toString().toLowerCase(); // "mk8" | "mkw"
        if (state.phase === 'mk8' && gameNorm !== 'mk8') return;
        if (state.phase === 'mkw' && gameNorm !== 'mkw') return;

        const team = state.teamsByName.get(p.teamName) || {};
        const logo = team.urlLogo ? resolveAssetPath(team.urlLogo) : '';

        items.push({
            pilotId,
            tag: p.tag || '',
            teamName: p.teamName || '',
            logo,
            points: Number(points) || 0,
            // bonus: (future value) // placeholder
        });
    });

    items.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        const ta = a.tag || '';
        const tb = b.tag || '';
        return ta.localeCompare(tb);
    });

    const rows = $list.children;
    for (let i = 0; i < 24; i++) {
        const $row = rows[i];
        if (!$row) continue;

        const entry = items[i];
        if (!entry) {
            $row.classList.add('is-empty');
            setRow($row, {
                position: i + 1,
                logo: '',
                tag: '',
                bonusContent: '', // vide
                pointsText: ''
            });
            continue;
        }

        $row.classList.remove('is-empty');
        setRow($row, {
            position: i + 1,
            logo: entry.logo,
            tag: entry.tag,
            bonusContent: '', // à remplir plus tard (icône/flag bonus)
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

    if ($bonus) {
        // Pour l’instant, rien. On garde la place disponible.
        // Si besoin, on pourra y injecter une <img> ou une icône SVG plus tard.
        $bonus.innerHTML = bonusContent || '';
    }

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
    resubscribeTotals();
})();
