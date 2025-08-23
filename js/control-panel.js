/**
 * MK GP Experience 3 — RTDB schema (PROD)
 *
 * Conventions de clés
 * -------------------
 * PHASE  : "mk8" | "mkw"                  // toujours en minuscules
 * RACE   : "1".."12" | "S" | "SF"         // identifiant lisible côté UI
 * PILOT  : id Firestore d'un pilote (ex: "E3zXtYEtrCvbvgARbBAi")
 *
 * Racine
 * ------
 * context/
 *   current/
 *     phase  : "mk8" | "mkw"              // phase en cours
 *     raceId : "1".."12" | "S" | "SF"     // id de course dans sa phase (format UI)
 *     rid    : string                     // identifiant global `${phase}-${raceId}` (ex: "mk8-2")
 *
 * meta/
 *   pilotsAllowed/
 *     {phase}/                        // "mk8" | "mkw"
 *       {pilotId} : boolean           // true = ce pilote peut écrire son résultat live
 *                                     // (absence ou false => pas d'autorisation)
 *
 * live/
 *   results/
 *     {phase}/                          // "mk8" | "mkw" (toujours en minuscules)
 *       current/                        // saisies temporaires par pilote (objet)
 *         {pilotId}: {
 *           rank: number                // 1..12 (mk8) | 1..24 (mkw) ; aucun timestamp
 *         }
 *
 *       byRace/                         // résultats figés par course
 *         {raceId}/                     // "1".."12" | "S" | "SF"
 *           ranks/
 *             {pilotId}: {
 *               rank: number            // rang final figé (même forme que current)
 *             }
 *           doubles/
 *             {pilotId}: true           // bonus "double points" activé AVANT la course
 *
 * live/
 *   races/
 *     {phase}/                          // "mk8" | "mkw"
 *       {raceId}/                       // "1".."12" | "S" | "SF"
 *         finalized: boolean            // true = course figée (résultats copiés dans byRace)
 *
 *   points/
 *     {phase}/
 *       byRace/
 *         {raceId}/
 *           {pilotId}: {
 *             rank    : number
 *             base    : number
 *             doubled : boolean
 *             final   : number           // base * (doubled ? 2 : 1)
 *           }
 *       totals/
 *         {pilotId} : number
 *       extras/
 *         cosplay/
 *           public : { pilotId: string } // +8
 *           jury   : { pilotId: string } // +10
 *         awards/
 *           viewers : { pilotId: string } // +3
 *           hosts   : { pilotId: string } // +2
 *
 * Notes:
 * - Pas de timestamps en BDD.
 * - Reset par course: supprimer results/byRace/{raceId} + points/byRace/{raceId}, recalculer totals,
 *   et remettre races/{phase}/{raceId}.finalized=false.
 */

import { dbRealtime, dbFirestore } from './firebase-config.js';
import {
    ref, onValue, off, get, set, update, remove
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

import {
    collection, getDocs, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

/* ============================================================
   Helpers DOM
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.substring(2), v);
        else node.setAttribute(k, v);
    });
    children.forEach(c => node.append(c));
    return node;
};

/* ============================================================
   État global (phase active, vue locale, caches)
   ============================================================ */
const PATH_CONTEXT = 'context/current';

let activeTournamentPhase = 'mk8'; // phase réelle du tournoi (global)
let activeRaceId = '1';            // "1".."12" | "S" | "SF"
let viewPhase = null;              // switch local d’affichage 'mk8' | 'mkw'

// Saisies live (seulement sur la phase active)
let currentResultsByPhase = { mk8: {}, mkw: {} }; // /live/results/{phase}/current

// Résultats figés par course (toute la phase vue)
let byRaceResultsByPhase = { mk8: {}, mkw: {} };  // /live/results/{phase}/byRace/{raceId}/{ranks|doubles}

// Statut de finalisation par course (par phase)
let lastFinalizedByPhase = { mk8: {}, mkw: {} };  // /live/races/{phase}/{raceId}.finalized

// Listeners
const listeners = {
    context: null,
    currentPhase: { ref: null, cb: null }, // live/results/{activePhase}/current
    races: { ref: null, cb: null },        // live/races/{viewPhase}
    byRace: { ref: null, cb: null }        // live/results/{viewPhase}/byRace
};

// --- Leaderboard state (par phase) ---
let lbTotalsByPhase = {};          // { phase: { pilotId: totalPts } }
let lbRanksByRaceByPhase = {};     // { phase: { raceId: { pilotId: {rank} } } }

// listeners RTDB (classement)
let lbTotalsRef = null, lbTotalsCb = null;
let lbByRaceRef = null, lbByRaceCb = null;

/* ============================================================
   Constantes utilitaires
   ============================================================ */
const GRID_SIZE = (phase) => phase === 'mkw' ? 24 : 12;

// Construction de la liste des courses (ids = "1".. ou "S"/"SF")
function buildRaceList(phase) {
    if (phase === 'mkw') {
        const list = [];
        for (let i = 1; i <= 6; i++) list.push(String(i));
        list.push('S');
        for (let i = 7; i <= 12; i++) list.push(String(i));
        list.push('SF');
        return list;
    }
    return Array.from({ length: 8 }, (_, i) => String(i + 1));
}
function raceLabel(phase, raceId) {
    if (phase === 'mkw') {
        if (raceId === 'S') return 'Survie 1';
        if (raceId === 'SF') return 'Survie Finale';
        return `Course ${raceId}/12`;
    }
    return `Course ${raceId}/8`;
}

/* ============================================================
   Phase active & course active
   ============================================================ */
let lastContext = {};

function attachContextListener() {
    if (listeners.context) {
        off(listeners.context.ref, 'value', listeners.context.cb);
        listeners.context = null;
    }
    const ctxRef = ref(dbRealtime, PATH_CONTEXT);
    const cb = (snap) => {
        const ctx = snap.val() || {};
        lastContext = ctx;
        activeTournamentPhase = (ctx.phase || 'mk8').toLowerCase();
        activeRaceId = (ctx.raceId != null && ctx.raceId !== '') ? String(ctx.raceId).toUpperCase() : null;

        if (!viewPhase) viewPhase = activeTournamentPhase;

        updatePhaseSwitchUI();
        updateStartSwitchUI();
        ensureCurrentResultsListener(activeTournamentPhase);
        ensurePhaseViewListeners(viewPhase);

        renderRaceStrip(viewPhase);
        updateRaceTilesStatus();
        refreshPilotListView();
    };
    onValue(ctxRef, cb);
    listeners.context = { ref: ctxRef, cb };
}

// Détermine la course "active" pour une phase donnée
function getActiveRaceIdForPhase(phase) {
    if (phase === activeTournamentPhase) return activeRaceId;

    // Sinon: première course NON finalisée dans cette phase, sinon dernière
    const order = buildRaceList(phase);
    const finals = lastFinalizedByPhase[phase] || {};
    for (const k of order) {
        if (!finals?.[k]?.finalized) return k;
    }
    return order[order.length - 1];
}

function isPhaseStarted(phase) {
    // Une phase est "start" seulement si context/current pointe vers cette phase
    // ET qu'une course courante (raceId) est définie.
    return !!(lastContext && lastContext.phase === phase && lastContext.raceId);
}

/* ============================================================
   Listeners: current (phase active) + byRace & races (phase vue)
   ============================================================ */
function ensureCurrentResultsListener(phase) {
    if (listeners.currentPhase.ref && listeners.currentPhase.cb) {
        off(listeners.currentPhase.ref, 'value', listeners.currentPhase.cb);
    }
    const r = ref(dbRealtime, `live/results/${phase}/current`);
    const cb = (s) => {
        currentResultsByPhase[phase] = s.val() || {};
        if (viewPhase === phase) {
            updateRaceTilesStatus();
            refreshPilotListView();
        }
    };
    onValue(r, cb);
    listeners.currentPhase = { ref: r, cb };

    get(r).then(s => {
        currentResultsByPhase[phase] = s.val() || {};
        if (viewPhase === phase) {
            updateRaceTilesStatus();
            refreshPilotListView();
        }
    }).catch(() => {});
}

function ensurePhaseViewListeners(phase) {
    // races/{phase}
    if (listeners.races.ref && listeners.races.cb) {
        off(listeners.races.ref, 'value', listeners.races.cb);
    }
    const racesRef = ref(dbRealtime, `live/races/${phase}`);
    const racesCb = (snap) => {
        lastFinalizedByPhase[phase] = snap.val() || {};
        updateRaceTilesStatus();
        updateStartSwitchUI();
    };
    onValue(racesRef, racesCb);
    listeners.races = { ref: racesRef, cb: racesCb };

    // results/{phase}/byRace
    if (listeners.byRace.ref && listeners.byRace.cb) {
        off(listeners.byRace.ref, 'value', listeners.byRace.cb);
    }
    const byRaceRef = ref(dbRealtime, `live/results/${phase}/byRace`);
    const byRaceCb = (snap) => {
        byRaceResultsByPhase[phase] = snap.val() || {};
        updateRaceTilesStatus();
        refreshPilotListView();
        updateStartSwitchUI();
    };
    onValue(byRaceRef, byRaceCb);
    listeners.byRace = { ref: byRaceRef, cb: byRaceCb };

    // init
    get(racesRef).then(s => { lastFinalizedByPhase[phase] = s.val() || {}; updateRaceTilesStatus(); }).catch(()=>{});
    get(byRaceRef).then(s => { byRaceResultsByPhase[phase] = s.val() || {}; updateRaceTilesStatus(); refreshPilotListView(); }).catch(()=>{});
}

/* ============================================================
   Switch de vue (header)
   ============================================================ */
function updatePhaseSwitchUI() {
    const grp = $('.cp-phase-switch');
    if (!grp) return;
    const btnMk8 = $('#cp-btn-mk8', grp);
    const btnMkw = $('#cp-btn-mkw', grp);
    const setActive = (btn, active) => {
        btn?.classList.toggle('is-active', active);
        btn?.setAttribute('aria-pressed', active ? 'true' : 'false');
    };
    setActive(btnMk8, viewPhase === 'mk8');
    setActive(btnMkw, viewPhase === 'mkw');
}

function mountPhaseSwitch() {
    const header = $('.cp-header');
    const right = $('.cp-header-right', header);
    if (!header || !right) return;

    let center = $('.cp-header-center', header);
    if (!center) {
        center = el('div', { class: 'cp-header-center' });
        header.insertBefore(center, right);
    }

    // Groupe phase MK8/MKW
    const group = el(
        'div',
        { class: 'cp-phase-switch', role: 'group', 'aria-label': 'Phase du tournoi (vue locale)' },
        el('button', {
            id: 'cp-btn-mk8',
            class: 'cp-switch-btn',
            type: 'button',
            'aria-pressed': 'false',
            'data-phase': 'mk8'
        }, 'MK8'),
        el('button', {
            id: 'cp-btn-mkw',
            class: 'cp-switch-btn',
            type: 'button',
            'aria-pressed': 'false',
            'data-phase': 'mkw'
        }, 'MKW')
    );

    // Switch "Start" (une seule direction: OFF -> ON; pas de OFF manuel)
    const startWrap = el('div', { class: 'cp-start-toggle' },
        el('input', {
            id: 'cp-start-input',
            class: 'cp-start-input',
            type: 'checkbox',
            role: 'switch',
            'aria-checked': 'false'
        }),
        el('label', { for: 'cp-start-input', class: 'cp-start-label' }, 'Start')
    );

    center.replaceChildren(group, startWrap);

    $('#cp-btn-mk8', group).addEventListener('click', () => setViewPhase('mk8'));
    $('#cp-btn-mkw', group).addEventListener('click', () => setViewPhase('mkw'));

    // Interactions Start
    const startInput = $('#cp-start-input', startWrap);
    startInput.addEventListener('change', async (e) => {
        // Interdit de passer de ON -> OFF (si tentative, on rétablit ON)
        if (e.target.checked === false) {
            e.preventDefault();
            updateStartSwitchUI();
            return;
        }
        // ON demandé → lancer la phase "vue" si activable
        if (computeStartEnabledForView(viewPhase)) {
            try {
                await startPhase(viewPhase);
            } catch (err) {
                console.error('Start phase échoué:', err);
                e.target.checked = false;
            }
        } else {
            // Non activable → annuler le check
            e.preventDefault();
            e.target.checked = false;
        }
        updateStartSwitchUI();
    });

    updatePhaseSwitchUI();
    updateStartSwitchUI();
}

function setViewPhase(phase) {
    const p = (phase || 'mk8').toLowerCase();
    if (p !== 'mk8' && p !== 'mkw') return;
    if (viewPhase === p) return;
    viewPhase = p;

    // Choisir course "inspectée" par défaut
    const order = buildRaceList(viewPhase);
    const active = getActiveRaceIdForPhase(viewPhase);
    if (!lastSelectedByPhase[viewPhase] || !order.includes(lastSelectedByPhase[viewPhase])) {
        lastSelectedByPhase[viewPhase] = active || order[0];
    }

    ensurePhaseViewListeners(viewPhase);
    renderRaceStrip(viewPhase);
    ensureLeaderboardListeners(viewPhase);
    renderLeaderboardPanel();
    updatePhaseSwitchUI();
    updateRaceTilesStatus();
    refreshPilotListView();

    // IMPORTANT : recalcule l'état du bouton Start pour la phase vue
    updateStartSwitchUI();

    window.__reloadPilotsForView && window.__reloadPilotsForView();
}

// --- Start switch: logique d'activation ---
function computeStartEnabledForView(phase) {
    if (!phase) return false;
    const hasCurrent = !!(lastContext && lastContext.raceId); // une course "courante" existe ?
    const finals = lastFinalizedByPhase[phase] || {};
    const anyFinalized = Object.values(finals).some(v => v && v.finalized === true);
    // Activable seulement s'il n'y a PAS de "current" global ET qu'aucune course de la phase n'est finalisée
    return !hasCurrent && !anyFinalized;
}

async function startPhase(phase) {
    const firstId = buildRaceList(phase)[0]; // "1"
    await update(ref(dbRealtime, PATH_CONTEXT), {
        phase,
        raceId: firstId,
        rid: `${phase}-${firstId}`
    });
}

function updateStartSwitchUI() {
    const input = document.getElementById('cp-start-input');
    if (!input) return;
    const isOn = !!(lastContext && lastContext.raceId) && (lastContext.phase === viewPhase);
    input.checked = isOn;
    input.disabled = isOn || !computeStartEnabledForView(viewPhase);
    input.setAttribute('aria-checked', isOn ? 'true' : 'false');
}

/* ============================================================
   Races strip (UI)
   ============================================================ */
let lastSelectedByPhase = { mk8: null, mkw: null };

function renderRaceStrip(phase) {
    const host = $('#cp-races');
    if (!host) return;

    const ids = buildRaceList(phase);
    const titleText = (phase === 'mkw') ? 'Mario Kart World' : 'Mario Kart 8';

    const inner   = el('div', { class: 'cp-races-inner' });
    const titleEl = el('div', { class: 'cp-races-title' }, titleText);
    const right   = el('div', { class: 'cp-races-right' });

    // Piste
    const track = el('div', { class: 'cp-races-track' });
    ids.forEach(id => {
        const seg = el('div', { class: 'cp-track-segment', 'data-key': id });
        track.appendChild(seg);
    });

    // Rangée de tiles
    const row = el('div', { class: 'cp-races-row' });
    ids.forEach((id) => {
        const type = (phase === 'mkw') ? (id === 'S' ? 'survival' : id === 'SF' ? 'survival-final' : 'race') : 'race';
        const wrap = el('div', { class: 'cp-race-wrap', 'data-key': id });

        // Checkbox (finaliser)
        const checkWrap = el('div', { class: 'cp-race-check' });
        const input = el('input', {
            type: 'checkbox',
            class: 'cp-race-check-input',
            'data-key': id
        });
        input.addEventListener('change', async (e) => {
            // Si la phase vue n’est pas démarrée, on annule toute action
            if (!isPhaseStarted(phase)) {
                e.preventDefault();
                updateRaceTilesStatus();
                return;
            }
            if (e.target.checked) {
                try {
                    await finalizeRaceTile(phase, id);
                } catch (err) {
                    console.error('Finalisation échouée:', err);
                    e.target.checked = false;
                }
            }
        });
        checkWrap.appendChild(input);

        // Tuile
        const tile = el('div', {
            class: 'cp-race-tile',
            'data-type': type,
            'data-key': id,
            title: type.startsWith('survival') ? 'Survie' : 'Course'
        }, id);

        // Radio (inspection)
        const radioWrap = el('div', { class: 'cp-race-radio' });
        const radio = el('input', {
            type: 'radio',
            class: 'cp-race-radio-input',
            name: 'cp-race-select',
            'data-key': id
        });
        radio.addEventListener('change', () => selectRaceForInspection(phase, id));
        radioWrap.appendChild(radio);

        wrap.append(checkWrap, tile, radioWrap);
        row.appendChild(wrap);
    });

    right.append(track, row);
    inner.append(titleEl, right);
    host.replaceChildren(inner);

    updateRaceTilesStatus();
}

/* ============================================================
   Chargement pilotes (Firestore) pour affichage gauche
   ============================================================ */
let cachedTeams = null;

async function fetchTeamsOrdered() {
    if (cachedTeams) return cachedTeams;
    const snap = await getDocs(collection(dbFirestore, 'teams'));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // on suppose qu'ils ont un 'order' : on trie
    list.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    cachedTeams = list;
    return cachedTeams;
}
async function fetchPilotsByGameOrdered(gameLabel /* 'MK8' | 'MKW' */) {
    const snap = await getDocs(collection(dbFirestore, 'pilots'));
    const list = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => (p.game || 'MK8') === gameLabel)
        .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    return list;
}
function groupPilotsByTeam(teams, pilots) {
    const byTeam = new Map(teams.map(t => [t.name, { team: t, pilots: [] }]));
    pilots.forEach(p => {
        const bucket = byTeam.get(p.teamName);
        if (bucket) bucket.pilots.push(p);
    });
    return teams.map(t => byTeam.get(t.name));
}
function renderPilotsPanel(groups) {
    const host = $('#cp-pilots-panel');
    if (!host) return;
    const container = el('div', { class: 'cp-pilots-scroll' });

    groups.forEach((g, idx) => {
        if (!g || g.pilots.length === 0) return;
        const block = el('div', { class: 'cp-team-block' });

        const logoWrap = el('div', { class: 'cp-team-logo' });
        const logoUrl = g.team?.urlLogo || '';
        if (logoUrl) {
            logoWrap.appendChild(el('img', { src: logoUrl, alt: g.team?.name || 'Team', loading: 'lazy' }));
        }
        block.appendChild(logoWrap);

        const list = el('div', { class: 'cp-team-pilots' });
        g.pilots.forEach(p => {
            const item = el('div', { class: 'cp-pilot-item', 'data-pilot-id': p.id, title: p.name || '' },
                el('span', { class: 'cp-rank-badge' }),
                el('span', { class: 'cp-pilot-name' }, p.name || '—')
            );
            const badgeEl = item.querySelector('.cp-rank-badge');
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isPhaseStarted(viewPhase)) return; // phase non démarrée → pas d’édition
                openRankModal(viewPhase, p.id, item);
            });
            list.appendChild(item);
        });
        block.appendChild(list);
        container.appendChild(block);
        if (idx < groups.length - 1) container.appendChild(el('div', { class: 'cp-team-sep' }));
    });

    host.replaceChildren(container);
}

/* ============================================================
   Montage panneau pilotes + phase switch
   ============================================================ */
function mountPilotsPanelSection() {
    const main = $('#cp-main');
    if (!main) return;

    let layout = $('.cp-layout', main);
    if (!layout) {
        layout = el('div', { class: 'cp-layout' },
            el('aside', { id: 'cp-pilots-panel', class: 'cp-pilots-panel' }),
            el('section', { class: 'cp-right' },
                el('div', { id: 'cp-races', class: 'cp-races-section' }),
                el('section', { class: 'cp-workspace' })
            )
        );
        main.replaceChildren(layout);
    }

    const load = async () => {
        if (!viewPhase) return;
        const gameLabel = viewPhase === 'mkw' ? 'MKW' : 'MK8';
        const [teams, pilots] = await Promise.all([fetchTeamsOrdered(), fetchPilotsByGameOrdered(gameLabel)]);
        const groups = groupPilotsByTeam(teams, pilots);
        renderPilotsPanel(groups);
        refreshPilotListView();
    };

    window.__reloadPilotsForView = load;
    load();
}

/* ============================================================
   Application des résultats à l’UI (badges)
   ============================================================ */
function computeRaceStatusFromResults(results, gridSize) {
    const rankCount = new Map();
    let filledCount = 0;
    Object.values(results || {}).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            filledCount++;
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });
    const hasConflict = [...rankCount.values()].some(n => n >= 2);
    if (hasConflict) return 'conflict';
    if (gridSize && filledCount === Number(gridSize)) return 'complete';
    if (filledCount > 0) return 'filled';
    return null;
}

function getResultsForDisplay(phase, raceId) {
    // Si on regarde la course active de la phase active
    if (phase === activeTournamentPhase && raceId === activeRaceId) {
        const current = currentResultsByPhase[phase] || {};
        const hasCurrent = Object.values(current).some(v => v && v.rank != null);
        if (hasCurrent) return current;

        // Fallback : si current est vide (p.ex. après validation de la dernière course),
        // on lit les rangs figés dans byRace/ranks
        const ranks = byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
        const hasRanks = Object.values(ranks).some(v => v && v.rank != null);
        if (hasRanks) return ranks;

        return {};
    }

    // Autres phases / autres courses → lecture directe byRace/ranks
    return byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
}

function applyResultsToUI(phase, resultsMap, gridSize) {
    const items = Array.from(document.querySelectorAll('.cp-pilot-item'));
    const rankCount = new Map();
    let filledCount = 0;

    items.forEach(it => {
        const pilotId = it.dataset.pilotId;
        const badge = it.querySelector('.cp-rank-badge');
        if (!badge) return;

        const rank = resultsMap?.[pilotId]?.rank ?? null;

        badge.classList.remove('is-empty','is-filled','is-conflict','is-complete');
        badge.textContent = '';

        if (rank == null || rank === '') {
            badge.classList.add('is-empty');
        } else {
            const r = Number(rank);
            badge.textContent = String(rank);
            badge.classList.add('is-filled');
            filledCount++;
            if (Number.isInteger(r) && r > 0) {
                rankCount.set(r, (rankCount.get(r) || 0) + 1);
            }
        }
    });

    const conflicts = new Set([...rankCount.entries()].filter(([_, n]) => n >= 2).map(([r]) => r));
    if (conflicts.size > 0) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            const rankText = badge?.textContent?.trim();
            if (!rankText) return;
            const r = Number(rankText);
            if (conflicts.has(r)) {
                badge.classList.remove('is-empty','is-filled','is-complete');
                badge.classList.add('is-conflict');
            }
        });
    }

    const isCompleteValid = (gridSize && filledCount === Number(gridSize) && conflicts.size === 0);
    if (isCompleteValid) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            if (!badge) return;
            badge.classList.remove('is-empty','is-filled','is-conflict');
            badge.classList.add('is-complete');
        });
    }
}

function refreshPilotListView() {
    if (!viewPhase) return;
    const gridSize = GRID_SIZE(viewPhase);
    const activeId = getActiveRaceIdForPhase(viewPhase);
    const inspectedId = lastSelectedByPhase[viewPhase] || activeId;

    const results = getResultsForDisplay(viewPhase, inspectedId);
    applyResultsToUI(viewPhase, results, gridSize);
}

/* ============================================================
   Statuts tuiles (filled/conflict/complete/active/inspected)
   ============================================================ */
function getRaceStatusDeterministic(phase, raceId) {
    const grid = GRID_SIZE(phase);
    const activeId = getActiveRaceIdForPhase(phase);

    // Cas "course active de la phase active"
    if (phase === activeTournamentPhase && raceId === activeId) {
        const current = currentResultsByPhase[phase] || {};
        const hasCurrent = Object.values(current).some(v => v && v.rank != null);
        if (hasCurrent) {
            return computeRaceStatusFromResults(current, grid);
        }

        // Fallback : current vide → regarder les rangs figés byRace/ranks
        const ranks = byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
        const hasRanks = Object.values(ranks).some(v => v && v.rank != null);
        if (hasRanks) {
            // calcule l'état réel (complete/filled/conflict) sur le figé
            return computeRaceStatusFromResults(ranks, grid) || 'filled';
        }

        // si rien, on regarde quand même l'état "finalized"
        const finals = lastFinalizedByPhase[phase] || {};
        return finals?.[raceId]?.finalized ? 'complete' : null;
    }

    // Autres cas : logique inchangée (lecture byRace/ranks)
    const ranks = byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
    const hasAny = Object.values(ranks).some(v => v && v.rank != null);
    if (!hasAny) {
        const finals = lastFinalizedByPhase[phase] || {};
        return finals?.[raceId]?.finalized ? 'complete' : null;
    }
    return computeRaceStatusFromResults(ranks, grid) || 'filled';
}

function updateRaceTilesStatus() {
    const host = document.querySelector('#cp-races');
    if (!host || !viewPhase) return;

    const phase        = viewPhase;
    const activeId     = getActiveRaceIdForPhase(phase);
    const inspectedId  = lastSelectedByPhase[phase] || activeId;
    const order        = buildRaceList(phase);

    const segs = host.querySelectorAll('.cp-track-segment');
    segs.forEach(s => s.classList.remove('is-active', 'is-first', 'is-last'));
    const firstKey = order[0];
    const lastKey  = order[order.length - 1];
    host.querySelector(`.cp-track-segment[data-key="${firstKey}"]`)?.classList.add('is-first');
    host.querySelector(`.cp-track-segment[data-key="${lastKey}"]`)?.classList.add('is-last');
    if (phase === activeTournamentPhase) {
        host.querySelector(`.cp-track-segment[data-key="${activeId}"]`)?.classList.add('is-active');
    }

    const wraps = Array.from(host.querySelectorAll('.cp-race-wrap'));
    const classFor = (st) =>
        st === 'conflict' ? 'is-conflict' :
        st === 'complete' ? 'is-complete' :
        st === 'filled'   ? 'is-filled'   : null;

    wraps.forEach(w => {
        const key   = w.dataset.key;
        const tile  = w.querySelector('.cp-race-tile');
        const check = w.querySelector('.cp-race-check-input');
        const radio = w.querySelector('.cp-race-radio-input');

        tile.classList.remove('is-filled','is-conflict','is-complete','is-active','is-inspected');
        radio.checked = (key === inspectedId);

        const st  = getRaceStatusDeterministic(phase, key);
        const cls = classFor(st);
        if (cls) tile.classList.add(cls);

        if (phase === activeTournamentPhase && key === activeId) tile.classList.add('is-active');
        if (key === inspectedId) tile.classList.add('is-inspected');

        // Checkbox enable/checked
        if (check) {
            // Gate global : phase non démarrée → tout disabled (lecture seule)
            if (!isPhaseStarted(phase)) {
                check.checked  = !!(lastFinalizedByPhase[phase]?.[key]?.finalized); // on reflète visuellement l’historique
                check.disabled = true;
            } else {
                const isComplete  = (st === 'complete');
                const finals      = lastFinalizedByPhase[phase] || {};
                const isFinalized = !!finals?.[key]?.finalized;

                if (isFinalized) {
                    check.checked  = true;
                    check.disabled = true;
                } else if (isComplete) {
                    check.checked  = false;
                    check.disabled = false;
                } else {
                    check.checked  = false;
                    check.disabled = true;
                }
            }
        }
    });
}

/* ============================================================
   Sélection radio
   ============================================================ */
function selectRaceForInspection(phase, raceId) {
    const order = buildRaceList(phase);
    if (!order.includes(raceId)) return;
    lastSelectedByPhase[phase] = raceId;
    updateRaceTilesStatus();
    refreshPilotListView();
}

/* ============================================================
   Modale d’édition (choix du rang / reset)
   - Active phase + active race => écrit dans results/{phase}/current
   - Sinon => écrit directement dans results/{phase}/byRace/{raceId}/ranks
   ============================================================ */
function openRankModal(phase, pilotId, anchorEl) {
    if (!isPhaseStarted(phase)) return;
    const backdrop = el('div', { class: 'cp-modal-backdrop', 'data-modal': 'rank' });
    const card = el('div', { class: 'cp-modal-card' });

    const closeBtn = el('button', { class: 'cp-modal-close', 'aria-label': 'Fermer' }, '×');
    closeBtn.addEventListener('click', () => backdrop.remove());

    const resetBtn = el('button', { class: 'cp-modal-reset', type: 'button' }, 'Reset');
    resetBtn.addEventListener('click', async () => {
        try {
            const activeId = getActiveRaceIdForPhase(phase);
            const inspectedId = lastSelectedByPhase[phase] || activeId;
            if (phase === activeTournamentPhase && inspectedId === activeId) {
                await remove(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`));
            } else {
                // ÉDITION d'une course NON active → on modifie byRace/ranks et on dé-finalise
                await remove(ref(dbRealtime, `live/results/${phase}/byRace/${inspectedId}/ranks/${pilotId}`));
                // NEW: repasser la course en "non finalisée"
                await update(ref(dbRealtime, `live/races/${phase}/${inspectedId}`), { finalized: false });

                // MàJ locale immédiate (en attendant les listeners)
                lastFinalizedByPhase[phase] = lastFinalizedByPhase[phase] || {};
                lastFinalizedByPhase[phase][inspectedId] = { finalized: false };
                updateRaceTilesStatus();
                refreshPilotListView();
            }
            backdrop.remove();
        } catch (err) {
            console.error('Reset rang échoué:', err);
        }
    });

    const nameText =
        anchorEl?.querySelector('.cp-pilot-name')?.textContent?.trim() ||
        anchorEl?.dataset?.pilotName || '';
    const titleEl = el('div', { class: 'cp-modal-title' }, nameText);

    card.append(resetBtn, titleEl, closeBtn);

    const activeId = getActiveRaceIdForPhase(phase);
    const inspectedId = lastSelectedByPhase[phase] || activeId;
    const useCurrent = (phase === activeTournamentPhase && inspectedId === activeId);
    const resultsForGrid = useCurrent
        ? (currentResultsByPhase[phase] || {})
        : (byRaceResultsByPhase?.[phase]?.[inspectedId]?.ranks || {});

    const rankCount = new Map();
    Object.values(resultsForGrid).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });

    const grid = el('div', { class: 'cp-rank-grid' });
    const gridSize = GRID_SIZE(phase);
    for (let i = 1; i <= gridSize; i++) {
        const taken = rankCount.get(i) || 0;
        const cell = el('button', {
            class: 'cp-rank-cell ' + (taken >= 2 ? 'is-conflict' : taken === 1 ? 'is-filled' : 'is-empty'),
            type: 'button',
            'data-rank': String(i)
        }, String(i));

        cell.addEventListener('click', async () => {
            try {
                if (useCurrent) {
                    await set(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), { rank: i });
                } else {
                    // ÉDITION d'une course NON active → on écrit directement dans byRace/ranks
                    await set(ref(dbRealtime, `live/results/${phase}/byRace/${inspectedId}/ranks/${pilotId}`), { rank: i });
                    // NEW: repasser la course en "non finalisée"
                    await update(ref(dbRealtime, `live/races/${phase}/${inspectedId}`), { finalized: false });

                    // MàJ locale immédiate (en attendant les listeners)
                    lastFinalizedByPhase[phase] = lastFinalizedByPhase[phase] || {};
                    lastFinalizedByPhase[phase][inspectedId] = { finalized: false };
                    updateRaceTilesStatus();
                    refreshPilotListView();
                }
                backdrop.remove();
            } catch (err) {
                console.error('Maj rang échouée:', err);
            }
        });

        grid.appendChild(cell);
    }

    card.append(closeBtn, grid);
    backdrop.appendChild(card);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

    document.body.appendChild(backdrop);
    card.style.visibility = 'hidden';
    card.style.position = 'fixed';

    // Positionnement proche de l’ancre
    const GAP = 8;
    const fallbackMargin = 12;
    const aRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const cRect = card.getBoundingClientRect();
    const cardW = cRect.width;
    const cardH = cRect.height;
    let left = aRect ? aRect.right + GAP : fallbackMargin;
    if (left + cardW + fallbackMargin > window.innerWidth) {
        left = Math.max(fallbackMargin, (aRect ? aRect.left : 0) - GAP - cardW);
    }
    let top = aRect ? (aRect.top + (aRect.height / 2) - (cardH / 2)) : fallbackMargin;
    top = Math.max(fallbackMargin, Math.min(top, window.innerHeight - cardH - fallbackMargin));
    left = Math.max(fallbackMargin, Math.min(left, window.innerWidth - cardW - fallbackMargin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = 'visible';
}

/* ============================================================
   Matrices de points (Firestore "points/{mk8|mkw}")
   ============================================================ */
let pointsMatrices = { mk8: null, mkw: null };

async function loadPointsMatrices() {
    if (pointsMatrices.mk8 && pointsMatrices.mkw) return pointsMatrices;

    // mk8
    const mk8Doc = await getDoc(doc(dbFirestore, 'points', 'mk8'));
    pointsMatrices.mk8 = mk8Doc.exists() ? (mk8Doc.data() || {}) : {};

    // mkw
    const mkwDoc = await getDoc(doc(dbFirestore, 'points', 'mkw'));
    pointsMatrices.mkw = mkwDoc.exists() ? (mkwDoc.data() || {}) : {};

    return pointsMatrices;
}

// Retourne les points "base" pour un rang et un type de course
function basePointsFor(phase, raceId, rank) {
    if (phase === 'mk8') {
        const table = pointsMatrices.mk8?.ranks || {};
        return Number(table[String(rank)] ?? 0);
    }
    // MKW
    const row = pointsMatrices.mkw?.ranks?.[String(rank)];
    if (!row) return 0;
    if (raceId === 'S')  return Number(row.s1 ?? 0);
    if (raceId === 'SF') return Number(row.s2 ?? 0);
    return Number(row.race ?? 0);
}

/* ============================================================
   Finalisation d’une course
   - Phase active + course active : copie current → byRace/ranks
   - Sinon : on considère que byRace/ranks contient déjà un classement complet
   - On calcule live/points/{phase}/byRace/{raceId} puis totals
   - On marque races/{phase}/{raceId}.finalized = true
   - Si active: on efface current et on avance context/current
   ============================================================ */
async function finalizeRaceTile(phase, raceId) {
    if (!isPhaseStarted(phase)) {
        throw new Error('Phase non démarrée : aucune validation possible.');
    }
    const gridSize = GRID_SIZE(phase);
    const activeId = getActiveRaceIdForPhase(phase);
    const useCurrent = (phase === activeTournamentPhase && raceId === activeId);

    // Charger matrices de points
    await loadPointsMatrices();

    // 1) Préparer les rangs finaux
    if (useCurrent) {
        // Vérifier que current est complet/sans conflit
        const status = computeRaceStatusFromResults(currentResultsByPhase[phase], gridSize);
        if (status !== 'complete') throw new Error('Les classements ne sont pas complets/valides.');

        // Copier current -> byRace/ranks
        const updates = {};
        Object.entries(currentResultsByPhase[phase] || {}).forEach(([pilotId, obj]) => {
            if (obj && Number.isInteger(Number(obj.rank))) {
                updates[`live/results/${phase}/byRace/${raceId}/ranks/${pilotId}`] = { rank: Number(obj.rank) };
            }
        });
        await update(ref(dbRealtime, '/'), updates);
    } else {
        // Non active : on exige que byRace/ranks existe et soit complet
        const ranks = (byRaceResultsByPhase?.[phase]?.[raceId]?.ranks) || {};
        const status = computeRaceStatusFromResults(ranks, gridSize);
        if (status !== 'complete') throw new Error('La course sélectionnée n’est pas complète/valide.');
    }

    // 2) Calculer points/byRace/{raceId}
    //    - lire ranks finaux & doubles
    const ranksSnap = await get(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`));
    const doublesSnap = await get(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}/doubles`));
    const ranks = ranksSnap.exists() ? (ranksSnap.val() || {}) : {};
    const doubles = doublesSnap.exists() ? (doublesSnap.val() || {}) : {};

    const pointsUpdates = {};
    Object.entries(ranks).forEach(([pilotId, v]) => {
        const rank = Number(v?.rank ?? 0);
        const base = basePointsFor(phase, raceId, rank);
        const doubled = !!doubles[pilotId];
        const final = base * (doubled ? 2 : 1);

        pointsUpdates[`live/points/${phase}/byRace/${raceId}/${pilotId}`] = {
            rank, base, doubled, final
        };
    });
    await update(ref(dbRealtime, '/'), pointsUpdates);

    // 3) Recalcul totals = somme des finals + extras
    await recomputeTotalsForPhase(phase);

    // 4) Marquer finalized=true
    await set(ref(dbRealtime, `live/races/${phase}/${raceId}`), { finalized: true });

    // 5) Si active: effacer current et gérer le contexte
    if (useCurrent) {
        // Vider les saisies courantes
        await remove(ref(dbRealtime, `live/results/${phase}/current`)).catch(()=>{});

        const order = buildRaceList(phase);
        const idx = order.indexOf(raceId);
        const hasNext = (idx >= 0 && idx < order.length - 1);
        const nextId = hasNext ? order[idx + 1] : null;

        if (hasNext) {
            // Avance à la course suivante
            await update(ref(dbRealtime, `context/current`), {
                phase: phase,
                raceId: nextId,
                rid: `${phase}-${nextId}`
            });
            lastSelectedByPhase[phase] = nextId; // focus avance aussi
        } else {
            // DERNIÈRE course : aucune "current"
            // On garde la phase, mais on retire raceId / rid
            await update(ref(dbRealtime, `context/current`), {
                raceId: null,
                rid: null
            });
            // Focus UI: rester sur la dernière tuile validée
            lastSelectedByPhase[phase] = raceId;
        }
    } else {
        // Réédition d’une course non active -> on reste focalisé sur cette course
        lastSelectedByPhase[phase] = raceId;
    }

    // rafraîchir l’UI
    updateStartSwitchUI();
    updateRaceTilesStatus();
    refreshPilotListView();
}

/* ============================================================
   Recalcul des totaux (somme finals + extras)
   ============================================================ */
async function recomputeTotalsForPhase(phase) {
    const byRaceRoot = await get(ref(dbRealtime, `live/points/${phase}/byRace`));
    const extrasCosplayPublicSnap = await get(ref(dbRealtime, `live/points/${phase}/extras/cosplay/public`));
    const extrasCosplayJurySnap   = await get(ref(dbRealtime, `live/points/${phase}/extras/cosplay/jury`));
    const extrasViewersSnap       = await get(ref(dbRealtime, `live/points/${phase}/extras/awards/viewers`));
    const extrasHostsSnap         = await get(ref(dbRealtime, `live/points/${phase}/extras/awards/hosts`));

    const totals = {};

    if (byRaceRoot.exists()) {
        const byRaceTree = byRaceRoot.val() || {};
        Object.values(byRaceTree).forEach((raceObj) => {
            Object.entries(raceObj || {}).forEach(([pilotId, obj]) => {
                const final = Number(obj?.final ?? 0);
                totals[pilotId] = (totals[pilotId] || 0) + final;
            });
        });
    }

    // extras
    const cosplayPublic = extrasCosplayPublicSnap.exists() ? extrasCosplayPublicSnap.val() : null;
    const cosplayJury   = extrasCosplayJurySnap.exists()   ? extrasCosplayJurySnap.val()   : null;
    const viewers       = extrasViewersSnap.exists()       ? extrasViewersSnap.val()       : null;
    const hosts         = extrasHostsSnap.exists()         ? extrasHostsSnap.val()         : null;

    if (cosplayPublic?.pilotId) totals[cosplayPublic.pilotId] = (totals[cosplayPublic.pilotId] || 0) + 8;
    if (cosplayJury?.pilotId)   totals[cosplayJury.pilotId]   = (totals[cosplayJury.pilotId]   || 0) + 10;
    if (viewers?.pilotId)       totals[viewers.pilotId]       = (totals[viewers.pilotId]       || 0) + 3;
    if (hosts?.pilotId)         totals[hosts.pilotId]         = (totals[hosts.pilotId]         || 0) + 2;

    await set(ref(dbRealtime, `live/points/${phase}/totals`), totals);
}

/* ============================================================
   Panneau des classements
   ============================================================ */
function getTeamByNameMap(teams) {
    const map = new Map();
    (teams || []).forEach(t => map.set((t.name || '').toLowerCase(), t));
    return map;
}
function teamLogoUrl(team) {
    if (!team || !team.urlLogo) return '';
    // BDD stocke "./../assets/images/..." ; depuis /pages/ => "../assets/images/..."
    return team.urlLogo.replace(/^\.\//, '').replace(/^\.\.\//, '../').replace(/^\.\/\.\.\//, '../');
}

function computeTieBreakCounters(phase) {
    const byRace = lbRanksByRaceByPhase?.[phase] || {};
    const counters = {}; // pilotId -> {1:cnt,2:cnt,...}
    Object.values(byRace).forEach(ranksObj => {
        Object.entries(ranksObj || {}).forEach(([pid, v]) => {
            const r = Number(v?.rank);
            if (!Number.isInteger(r) || r <= 0) return;
            if (!counters[pid]) counters[pid] = {};
            counters[pid][r] = (counters[pid][r] || 0) + 1;
        });
    });
    return counters;
}

function sortPilotsForLeaderboard(phase, pilots, totals, tieCounters, gridSize, defaultOrderIndex) {
    const hasAnyPoints = totals && Object.values(totals).some(n => Number(n) > 0);
    if (!hasAnyPoints) {
        // aucun point → tri par ordre par défaut (équipes puis pilotes)
        return [...pilots];
    }
    const maxRank = gridSize || 24;
    return [...pilots].sort((a, b) => {
        const ta = Number(totals?.[a.id] || 0);
        const tb = Number(totals?.[b.id] || 0);
        if (tb !== ta) return tb - ta; // points décroissant

        const ca = tieCounters[a.id] || {};
        const cb = tieCounters[b.id] || {};
        for (let r = 1; r <= maxRank; r++) {
            const cbr = Number(cb[r] || 0);
            const car = Number(ca[r] || 0);
            if (cbr !== car) return cbr - car; // plus de 1ères, puis 2èmes, etc.
        }

        // fallback ordre par défaut
        const ia = defaultOrderIndex.get(a.id) ?? 99999;
        const ib = defaultOrderIndex.get(b.id) ?? 99999;
        return ia - ib;
    });
}

function formatPts(n) {
    const v = Number(n || 0);
    if (v === 0) return '0 pt';      // affichage homogène si on est dans un contexte "points existants"
    return v + (v === 1 ? ' pt' : ' pts');
}

/* ============================================================
   Rendu DOM (panel)
   ============================================================ */

async function renderLeaderboardPanel() {
    // conteneur : on réutilise la zone droite .cp-right .cp-workspace comme section classement
    const right = document.querySelector('.cp-right');
    if (!right) return;
    let panel = right.querySelector('#cp-leaderboard');
    if (!panel) {
        panel = document.createElement('section');
        panel.id = 'cp-leaderboard';
        panel.className = 'cp-leaderboard';
        // remplace l'ancien workspace si présent
        const ws = right.querySelector('.cp-workspace');
        if (ws) ws.replaceWith(panel);
        else right.appendChild(panel);
    }

    const phase = viewPhase || 'mk8';
    const gridSize = GRID_SIZE(phase);
    const gameLabel = (phase === 'mkw') ? 'MKW' : 'MK8';

    const [teams, pilots] = await Promise.all([
        fetchTeamsOrdered(),
        fetchPilotsByGameOrdered(gameLabel)
    ]);
    // index par défaut (ordre équipes puis pilotes)
    const defaultIndex = new Map(pilots.map((p, i) => [p.id, i]));
    const teamMapByName = getTeamByNameMap(teams);

    const totals = lbTotalsByPhase?.[phase] || {};
    const tieCounters = computeTieBreakCounters(phase);
    const hasAnyPoints = totals && Object.values(totals).some(n => Number(n) > 0);

    const sortedPilots = sortPilotsForLeaderboard(phase, pilots, totals, tieCounters, gridSize, defaultIndex);

    // Build DOM
    const header = document.createElement('div');
    header.className = 'cp-lb-header';
    header.textContent = (phase === 'mkw') ? 'Classement — Mario Kart Wii' : 'Classement — Mario Kart 8';

    const list = document.createElement('div');
    list.className = 'cp-lb-list';

    sortedPilots.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'cp-lb-row';

        const rankCell = document.createElement('div');
        rankCell.className = 'cp-lb-rank';
        if (hasAnyPoints) {
            rankCell.textContent = String(idx + 1);
        } else {
            rankCell.textContent = ''; // pas de classement affiché en début de phase
        }

        const teamCell = document.createElement('div');
        teamCell.className = 'cp-lb-team';
        const t = teamMapByName.get((p.teamName || '').toLowerCase());
        if (t && t.urlLogo) {
            const img = document.createElement('img');
            img.alt = t.name || 'Team';
            img.src = teamLogoUrl(t);
            teamCell.appendChild(img);
        }

        const nameCell = document.createElement('div');
        nameCell.className = 'cp-lb-name';
        nameCell.textContent = p.name || '';

        const ptsCell = document.createElement('div');
        ptsCell.className = 'cp-lb-pts';
        if (hasAnyPoints) {
            const v = Number(totals?.[p.id] || 0);
            ptsCell.textContent = formatPts(v);
        } else {
            ptsCell.textContent = ''; // pas d’affichage de points en début de phase
        }

        row.append(rankCell, teamCell, nameCell, ptsCell);
        list.appendChild(row);
    });

    panel.replaceChildren(header, list);
}

/* ============================================================
   Listeners RTDB (totaux & détails par course) — attach/detach selon la phase vue
   ============================================================ */

function ensureLeaderboardListeners(phase) {
    // Detach anciens
    if (lbTotalsRef && lbTotalsCb) {
        off(lbTotalsRef, 'value', lbTotalsCb);
        lbTotalsRef = lbTotalsCb = null;
    }
    if (lbByRaceRef && lbByRaceCb) {
        off(lbByRaceRef, 'value', lbByRaceCb);
        lbByRaceRef = lbByRaceCb = null;
    }

    // Totaux
    lbTotalsRef = ref(dbRealtime, `live/points/${phase}/totals`);
    lbTotalsCb = (snap) => {
        lbTotalsByPhase[phase] = snap.exists() ? (snap.val() || {}) : {};
        renderLeaderboardPanel();
    };
    onValue(lbTotalsRef, lbTotalsCb);

    // Points par course (pour tie-break via "rank")
    lbByRaceRef = ref(dbRealtime, `live/points/${phase}/byRace`);
    lbByRaceCb = (snap) => {
        lbRanksByRaceByPhase[phase] = {};
        if (snap.exists()) {
            const byRace = snap.val() || {};
            Object.entries(byRace).forEach(([raceId, perPilot]) => {
                // on récupère seulement le champ "rank" pour chaque pilote
                const ranksOnly = {};
                Object.entries(perPilot || {}).forEach(([pid, obj]) => {
                    const r = Number(obj?.rank ?? 0);
                    if (r > 0) ranksOnly[pid] = { rank: r };
                });
                lbRanksByRaceByPhase[phase][raceId] = ranksOnly;
            });
        }
        renderLeaderboardPanel();
    };
    onValue(lbByRaceRef, lbByRaceCb);
}

   /* ============================================================
   Montage global
   ============================================================ */
function mountRaceSection() {
    attachContextListener();
}

document.addEventListener('DOMContentLoaded', async () => {
    mountPhaseSwitch();
    mountPilotsPanelSection();
    mountRaceSection();

    const tryInit = setInterval(() => {
        if (viewPhase) {
            ensurePhaseViewListeners(viewPhase);
            clearInterval(tryInit);
            window.__reloadPilotsForView && window.__reloadPilotsForView();
            renderRaceStrip(viewPhase);
            updateRaceTilesStatus();
            refreshPilotListView();
            ensureLeaderboardListeners(viewPhase);
            renderLeaderboardPanel();
        }
    }, 50);
    setTimeout(() => clearInterval(tryInit), 2000);
});
