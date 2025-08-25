// /js/ui/classement.js
// ----------------------------------------------------
// Classement Widget — MK GP Experience 3
// - Remplit la <section.classement-widget> (250x800)
// - Logo header (chemin relatif robuste)
// - État de course (RTDB: /context/current + live/races finals) avec texte défilant si besoin
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

/** Affichage simple phase/course pour fallback */
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

// ----------------------
// Marquee (texte défilant) — injecte du CSS depuis le JS
// ----------------------
let marqueeStyleEl = null;
function ensureMarqueeStyles() {
    if (marqueeStyleEl) return;
    const css = `
.classement-widget .race-state.marquee { overflow: hidden; position: relative; }
.classement-widget .race-state .marquee-track { display: inline-flex; align-items: center; gap: 48px; will-change: transform; }
@keyframes rs-marquee-{ID} { from { transform: translateX(0); } to { transform: translateX(-{DIST}px); } }
`.trim();
    marqueeStyleEl = document.createElement('style');
    marqueeStyleEl.id = 'classement-marquee-style';
    document.head.appendChild(marqueeStyleEl);
}

/**
 * Active un défilement continu gauche si le texte dépasse.
 * Crée un @keyframes unique avec la distance exacte.
 */
function setRaceStateTextWithMarquee($state, text) {
    // Réinitialise
    $state.classList.remove('marquee');
    $state.textContent = text;

    // Mesure si ça déborde
    // Laisse le browser rendre d’abord :
    requestAnimationFrame(() => {
        const needsMarquee = $state.scrollWidth > $state.clientWidth + 4; // petite tolérance
        if (!needsMarquee) return;

        ensureMarqueeStyles();

        // Construit la structure
        $state.classList.add('marquee');
        const track = document.createElement('div');
        track.className = 'marquee-track';

        const span1 = document.createElement('span');
        span1.className = 'marquee-item';
        span1.textContent = text;

        const span2 = document.createElement('span');
        span2.className = 'marquee-item';
        span2.textContent = text;
        span2.setAttribute('aria-hidden', 'true');

        track.appendChild(span1);
        track.appendChild(span2);

        // Remplace le contenu
        $state.innerHTML = '';
        $state.appendChild(track);

        // Mesure la distance de demi-cycle (largeur d’un item + gap ~ 48px)
        requestAnimationFrame(() => {
            const itemWidth = span1.offsetWidth;
            // distance = itemWidth + gap (48)
            const dist = Math.max(64, itemWidth + 48);

            // Crée une règle @keyframes dédiée avec un ID unique (évite conflits)
            const animId = `rs-marquee-${Math.random().toString(36).slice(2, 8)}`;
            const css = marqueeStyleEl.textContent || '';
            // Retire ancienne règle si besoin (on garde simple : on concatène)
            marqueeStyleEl.textContent = css + `\n@keyframes ${animId} { from { transform: translateX(0); } to { transform: translateX(-${dist}px); } }`;

            // Durée proportionnelle à la longueur (plus long => plus long à lire)
            const pxPerSec = 40; // vitesse ~ 40px/s (agréable)
            const duration = Math.max(8, Math.round((dist / pxPerSec)));

            track.style.animationName = animId;
            track.style.animationDuration = `${duration}s`;
            track.style.animationTimingFunction = 'linear';
            track.style.animationIterationCount = 'infinite';
        });
    });
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
    unsubTotals: null,

    // Finals
    mk8LastFinalized: false, // live/races/mk8/8/finalized
    mkwFinalFinalized: false // live/races/mkw/SF/finalized
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

// ---- subscriptions
function subscribeContext() {
    const ctxRef = ref(dbRealtime, 'context/current');
    onValue(ctxRef, (snap) => {
        const v = snap.val() || {};
        const phase = (v.phase || 'mk8').toString().toLowerCase();
        const raceId = v.raceId || null;

        const changedPhase = phase !== state.phase;
        state.phase = phase;
        state.raceId = raceId;

        // MAJ affichage état
        updateRaceStateDisplay();

        // Resubscribe totals si la phase change
        if (changedPhase) resubscribeTotals();
    });
}

function subscribeFinals() {
    // MK8 — course 8 finalized
    const mk8ref = ref(dbRealtime, 'live/races/mk8/8/finalized');
    onValue(mk8ref, (snap) => {
        state.mk8LastFinalized = Boolean(snap.val());
        updateRaceStateDisplay();
    });

    // MKW — Survie Finale finalized
    const mkwref = ref(dbRealtime, 'live/races/mkw/SF/finalized');
    onValue(mkwref, (snap) => {
        state.mkwFinalFinalized = Boolean(snap.val());
        updateRaceStateDisplay();
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
// Race state rendering logic
// ----------------------
function computeRaceStateText() {
    // Priorité 1: tournoi fini
    if (state.mkwFinalFinalized) {
        return 'Tournois terminé';
    }

    // MKW en cours
    if (state.phase === 'mkw') {
        const rid = state.raceId;
        if (!rid) {
            // pas encore démarré (après MK8 terminé ?)
            return state.mk8LastFinalized
                ? 'MK 8 - Phase 1 terminée. À suivre... Tournoi MK World'
                : 'MK World - En attente de départ';
        }
        if (rid === 'S') return 'MK World - Survie 1';
        if (rid === 'SF') return 'MK World - Survie Finale';

        if (isNumericRaceId(rid)) {
            const n = parseInt(rid, 10);
            if (n >= 1 && n <= 6) {
                // Affiche "Course X / 14"
                return `MK World - Course ${n} / 14`;
            }
            if (n >= 8 && n <= 13) {
                // Décalage voulu : 8 => Course 7 / 14 ... 13 => Course 12 / 14
                return `MK World - Course ${n - 1} / 14`;
            }
        }
        // fallback lisible
        return simpleRaceLabel({ phase: 'mkw', raceId: rid });
    }

    // MK8 / entre phases
    if (state.phase === 'mk8') {
        const rid = state.raceId;

        if (!rid) {
            // Avant départ OU après phase 1 terminée (en attente MKW)
            return state.mk8LastFinalized
                ? 'MK 8 - Phase 1 terminée. À suivre... Tournois MK World'
                : 'MK 8 - Le tournoi va commencer';
        }

        if (isNumericRaceId(rid)) {
            const n = parseInt(rid, 10);
            if (n >= 1 && n <= 8) {
                return `MK 8 - Course ${n} / 8`;
            }
        }

        // fallback
        return simpleRaceLabel({ phase: 'mk8', raceId: rid });
    }

    // Autres phases (sécurité)
    return simpleRaceLabel({ phase: state.phase, raceId: state.raceId });
}

function updateRaceStateDisplay() {
    const $state = document.getElementById('race-state');
    if (!$state) return;

    const text = computeRaceStateText();
    setRaceStateTextWithMarquee($state, text);
}

// ----------------------
// Classement rendering
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
            points: Number(points) || 0
        });
    });

    // points desc, puis tag asc
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

    if ($bonus) {
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
    subscribeFinals();  // <- écoute les fins de phase/courses importantes
    resubscribeTotals();
})();
