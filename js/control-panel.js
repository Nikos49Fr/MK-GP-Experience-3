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
 * Notes:
 * - Forme objet {rank} partout → permet d’ajouter plus tard d’autres champs (ex: DNF, pénalité)
 *   sans migration de schéma.
 * - Reset par course: supprimer `live/results/{phase}/byRace/{raceId}` ; optionnel: vider
 *   `current/` de la même phase si on veut repartir proprement.
 *
 * live/
 *   races/
 *     {phase}/                          // "mk8" | "mkw"
 *       {raceId}/                       // "1".."12" | "S" | "SF"
 *         finalized: boolean            // true = course figée (résultats copiés dans byRace)
 *
 *   points/
 *     {phase}/                              // "mk8" | "mkw"
 * 
 *       byRace/                             // points calculés et stockés par course
 *         {raceId}/                         // "1".."12" | "S" | "SF"
 *           {pilotId}: {
 *             rank    : number              // rang final de la course (copie pratique de results.byRace)
 *             base    : number              // points de base issus du barème de la phase
 *             doubled : boolean             // true si bonus "double" activé pour ce pilote sur cette course
 *             final   : number              // points comptés pour cette course (= base * (doubled ? 2 : 1))
 *           }
 *
 *       totals/                             // cumul de la phase (cache recomputable)
 *         {pilotId} : number                // somme( final sur toutes les courses ) + bonus de phase
 *
 *       extras/                             // bonus de phase (non liés à une course précise)
 *         cosplay/                          // 1 gagnant "public" (+8) et 1 gagnant "jury" (+10) par phase
 *           public : { pilotId: string }    // peut être le même pilote que jury → +18 si cumulé
 *           jury   : { pilotId: string }
 *         awards/                           // autres bonus de phase confirmés
 *           viewers : { pilotId: string }   // gagnant vote viewers → +3
 *           hosts   : { pilotId: string }   // gagnant animateurs     → +2
 *
 * Notes:
 * - Le calcul des points par course vit dans `byRace/{raceId}/{pilotId}` (rank/base/doubled/final).
 * - Les bonus "cosplay public" (+8) et "cosplay jury" (+10) sont au niveau phase → `extras/cosplay`.
 *   S’il s’agit du même pilote, il cumule les deux (total +18).
 * - Les bonus viewers (+3) et hosts (+2) sont également au niveau phase → `extras/awards`.
 * - `totals` = somme des `final` de `byRace` + points des `extras`. `totals` est un cache :
 *   il peut être recalculé à tout moment à partir de `byRace` + `extras`.
 * - Reset par course: supprimer `byRace/{raceId}` puis recalculer/ajuster `totals`
 *   (les `extras` restent inchangés car ils sont de phase).
 * - Après avoir supprimé live/results/{phase}/byRace/{raceId} et ajusté live/points,
 *   remets aussi live/races/{phase}/{raceId}.finalized à false (ou supprime ce nœud) pour rouvrir proprement la course.
 * - Pas de timestamps en BDD. Clés harmonisées avec `live/results` (mêmes {phase} et {raceId}).
 *
 */


// /js/control-panel.js (fixed)

// ATTENTION : commentaires en dessous à réviser suite à nouvelle structuration de la BDD.

// Direction de course — UI robuste par phase (vue locale) + écouteurs isolés.
// - Switch MK8/MKW = change UNIQUEMENT la **vue** locale (viewPhase), sans toucher au contexte global
// - La phase tournoi **active** = context/current.phase (utilisée pour les saisies "current")
// - Statuts/couleurs des tuiles calculés **par phase** sans mélange
// - Radios (œil), checkboxes, modale d'édition : tout fonctionne par phase, indépendamment
// - Finaliser une course sur la phase **active** gère "current" + avance le contexte à la course suivante
//   Sinon (phase non active), on met à jour l'historique/points de cette phase sans toucher au contexte global

import { dbRealtime, dbFirestore } from './firebase-config.js';
import {
    ref,
    onValue,
    update,
    off,
    serverTimestamp,
    get as rtdbGet,
    set as rtdbSet,
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

import {
    collection,
    getDocs,
    query,
    where,
    orderBy
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

/* ----------------------------- Helpers DOM ----------------------------- */
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

/* ----------------------------- État global ----------------------------- */
const PATH_CONTEXT = 'context/current';

// Phase tournoi réellement active (écrite par l'orga, lue en readonly ici)
let activeTournamentPhase = 'mk8'; // 'mk8' | 'mkw' (issu de context/current.phase)
let activeGridSize = 12;           // issu de context/current.gridSize

// Phase **vue** dans l'UI du panel (switch local)
let viewPhase = null;              // 'mk8' | 'mkw'

// Sélections radio mémorisées par phase
let lastSelectedByPhase = { mk8: null, mkw: null };

// Données runtime scindées par phase pour éviter tout mélange
let currentResultsByPhase = { mk8: {}, mkw: {} }; // /live/results/{phase}/current
let lastFinalizedByPhase  = { mk8: {}, mkw: {} }; // /live/races/{phase}
let historyByPhase        = { mk8: {}, mkw: {} }; // /live/results/{phase}/history
let editsByPhase          = { mk8: {}, mkw: {} }; // /live/edits/{phase}

// Teams/pilots cache Firestore
let cachedTeams = null;

// Listeners en cours (pour nettoyage)
const listeners = {
    context:      null,
    currentPhase: { ref: null, cb: null }, // écoute /live/results/{activeTournamentPhase}/current
    races:        { ref: null, cb: null }, // écoute /live/races/{viewPhase}
    history:      { ref: null, cb: null }, // écoute /live/results/{viewPhase}/history
    edits:        { ref: null, cb: null },  // écoute /live/edits/{viewPhase}
};

/* ----------------------------- Utilitaires tournoi ----------------------------- */
function raceOrderForPhase(phase) {
    return (phase === 'mkw')
        ? ['c1','c2','c3','c4','c5','c6','s','c7','c8','c9','c10','c11','c12','sf']
        : ['c1','c2','c3','c4','c5','c6','c7','c8'];
}
function labelForRaceKey(phase, key) {
    if (phase === 'mkw') {
        if (key === 's')  return 'Survie 1';
        if (key === 'sf') return 'Survie Finale';
        const n = Number(key.slice(1)); return `Course ${n}/12`;
    } else {
        const n = Number(key.slice(1)); return `Course ${n}/8`;
    }
}
function getNextRaceKey(phase, key) {
    const order = raceOrderForPhase(phase);
    const i = order.indexOf(key);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}
function raceKeyFromLabel(phase, label) {
    if (!label || typeof label !== 'string') return null;
    const l = label.toLowerCase().trim();
    const order = raceOrderForPhase(phase) || [];

    if (phase === 'mk8') {
        const m = l.match(/(\d+)\s*\/\s*8/);
        if (m) {
            const n = parseInt(m[1], 10);
            const key = `c${n}`;
            return order.includes(key) ? key : null;
        }
    } else {
        if (l.includes('finale') || /\bsf\b/.test(l)) return order.includes('sf') ? 'sf' : null;
        if (l.includes('survie')) return order.includes('s') ? 's' : null;
        const m = l.match(/(\d+)\s*\/\s*6|(\d+)\s*\/\s*12/);
        if (m) {
            const n = parseInt(m[1] || m[2], 10);
            const key = `c${n}`;
            return order.includes(key) ? key : null;
        }
    }
    const maybe = l.replace(/\s+/g, '');
    return order.includes(maybe) ? maybe : null;
}
function tileTypeFromKey(phase, key) {
    if (phase === 'mkw') {
        if (key === 's') return 'survival';
        if (key === 'sf') return 'survival-final';
    }
    return 'race';
}
/* Active course (clé) calculée **dans une phase donnée** */
function getActiveRaceKeyForPhase(phase) {
    const order = raceOrderForPhase(phase);
    if (!order || order.length === 0) return null;

    // Priorité au label du contexte si la phase correspond
    if (phase === activeTournamentPhase) {
        const keyFromCtx = raceKeyFromLabel(phase, lastContext?.race);
        if (keyFromCtx && order.includes(keyFromCtx)) return keyFromCtx;
    }

    // Sinon: première non finalisée (sur les finalisations de CETTE phase), sinon dernière
    const finals = lastFinalizedByPhase[phase] || {};
    for (const k of order) {
        if (!finals?.[k]?.finalized) return k;
    }
    return order[order.length - 1];
}

/* ----------------------------- Contexte global ----------------------------- */
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
        activeGridSize = Number(ctx.gridSize || (activeTournamentPhase === 'mkw' ? 24 : 12));

        // Init viewPhase si pas encore choisi (premier chargement)
        if (!viewPhase) viewPhase = activeTournamentPhase;

        // UI : highlight switch selon **viewPhase**, pas la phase globale
        updatePhaseSwitchUI();

        // (ré)abonnements : currentResults = phase active seulement
        ensureCurrentResultsListener(activeTournamentPhase);

        // Render/refresh
        renderRaceStrip(viewPhase);
        updateRaceTilesStatus();
        refreshPilotListView();
    };
    onValue(ctxRef, cb);
    listeners.context = { ref: ctxRef, cb };
}

/* ----------------------------- Listeners phase-isolés ----------------------------- */
function ensureCurrentResultsListener(phase) {
    // Détache précédent
    if (listeners.currentPhase.ref && listeners.currentPhase.cb) {
        off(listeners.currentPhase.ref, 'value', listeners.currentPhase.cb);
    }
    // Abonne au 'current' de la phase ACTUELLE du tournoi
    const r = ref(dbRealtime, `live/results/${phase}/current`);
    const cb = (s) => {
        currentResultsByPhase[phase] = s.val() || {};
        // Si on regarde la phase active → mettre les badges/tiles à jour
        if (viewPhase === phase) {
            updateRaceTilesStatus();
            refreshPilotListView();
        }
    };
    onValue(r, cb);
    listeners.currentPhase = { ref: r, cb };

    // Init immédiate, pour éviter l'écran blanc
    rtdbGet(r).then(s => {
        currentResultsByPhase[phase] = s.val() || {};
        if (viewPhase === phase) {
            updateRaceTilesStatus();
            refreshPilotListView();
        }
    }).catch(() => {});
}
function ensureHistoryAndEditsListeners(phase) {
    // Détache anciens listeners liés à la **vue**
    if (listeners.races.ref && listeners.races.cb)  off(listeners.races.ref, 'value', listeners.races.cb);
    if (listeners.history.ref && listeners.history.cb) off(listeners.history.ref, 'value', listeners.history.cb);
    if (listeners.edits.ref && listeners.edits.cb) off(listeners.edits.ref, 'value', listeners.edits.cb);

    // Finalisations (de la phase VUE)
    const racesRef = ref(dbRealtime, `live/races/${phase}`);
    const racesCb = (s2) => {
        lastFinalizedByPhase[phase] = s2.val() || {};
        updateRaceTilesStatus();
        refreshPilotListView();
    };
    onValue(racesRef, racesCb);
    listeners.races = { ref: racesRef, cb: racesCb };

    // Historique (de la phase VUE)
    const histRef = ref(dbRealtime, `live/results/${phase}/history`);
    const histCb = (sH) => {
        const tree = sH.val() || {};
        historyByPhase[phase] = tree || {};
        updateRaceTilesStatus();
        refreshPilotListView();
    };
    onValue(histRef, histCb);
    listeners.history = { ref: histRef, cb: histCb };

    // Edits (de la phase VUE)
    const edRef = ref(dbRealtime, `live/edits/${phase}`);
    const edCb = (sE) => {
        editsByPhase[phase] = sE.val() || {};
        updateRaceTilesStatus();
        refreshPilotListView();
    };
    onValue(edRef, edCb);
    listeners.edits = { ref: edRef, cb: edCb };

    // Inits
    rtdbGet(racesRef).then(s => { lastFinalizedByPhase[phase] = s.val() || {}; updateRaceTilesStatus(); }).catch(()=>{});
    rtdbGet(histRef).then(s => { historyByPhase[phase]   = s.val() || {}; updateRaceTilesStatus(); }).catch(()=>{});
    rtdbGet(edRef).then(s => { editsByPhase[phase]       = s.val() || {}; updateRaceTilesStatus(); }).catch(()=>{});
}

/* ----------------------------- Switch de vue (header) ----------------------------- */
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
    center.replaceChildren(group);

    // Switch **local** de vue. Ne modifie pas context/current.phase
    $('#cp-btn-mk8', group).addEventListener('click', () => setViewPhase('mk8'));
    $('#cp-btn-mkw', group).addEventListener('click', () => setViewPhase('mkw'));
    updatePhaseSwitchUI();
}
function setViewPhase(phase) {
    const p = (phase || 'mk8').toLowerCase();
    if (p !== 'mk8' && p !== 'mkw') return;
    if (viewPhase === p) return;
    viewPhase = p;

    // Init sélection par phase si absente
    const order = raceOrderForPhase(viewPhase);
    if (!lastSelectedByPhase[viewPhase] || !order.includes(lastSelectedByPhase[viewPhase])) {
        lastSelectedByPhase[viewPhase] = getActiveRaceKeyForPhase(viewPhase) || order[0];
    }

    // (ré)abonnements liés à la vue
    ensureHistoryAndEditsListeners(viewPhase);

    // Renders
    renderRaceStrip(viewPhase);
    updatePhaseSwitchUI();
    updateRaceTilesStatus();
    refreshPilotListView();

    // Recharger les pilotes pour la vue
    window.__reloadPilotsForView && window.__reloadPilotsForView();
}

/* ----------------------------- Races strip (titre+piste+rangée) ----------------------------- */
function buildRacesForPhase(phase) {
    if (phase === 'mkw') {
        const list = [];
        for (let i = 1; i <= 6; i++) list.push({ key: `c${i}`, label: String(i), type: 'race' });
        list.push({ key: 's', label: 'S', type: 'survival' });
        for (let i = 7; i <= 12; i++) list.push({ key: `c${i}`, label: String(i), type: 'race' });
        list.push({ key: 'sf', label: 'SF', type: 'survival-final' });
        return list;
    }
    return Array.from({ length: 8 }, (_, i) => ({
        key: `c${i + 1}`,
        label: String(i + 1),
        type: 'race'
    }));
}
function renderRaceStrip(phase) {
    const host = $('#cp-races');
    if (!host) return;

    const races = buildRacesForPhase(phase);
    const titleText = (phase === 'mkw') ? 'Mario Kart World' : 'Mario Kart 8';

    const inner   = el('div', { class: 'cp-races-inner' });
    const titleEl = el('div', { class: 'cp-races-title' }, titleText);

    const right = el('div', { class: 'cp-races-right' });

    // Piste
    const track = el('div', { class: 'cp-races-track' });
    races.forEach(r => {
        const seg = el('div', { class: 'cp-track-segment', 'data-key': r.key });
        track.appendChild(seg);
    });

    // Rangée (checkbox / tile / radio)
    const row = el('div', { class: 'cp-races-row' });
    races.forEach((r) => {
        const wrap = el('div', { class: 'cp-race-wrap', 'data-key': r.key });

        // Checkbox
        const checkWrap = el('div', { class: 'cp-race-check' });
        const input = el('input', {
            type: 'checkbox',
            class: 'cp-race-check-input',
            'data-key': r.key
        });
        input.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    await finalizeRaceTile(viewPhase, r.key);
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
            'data-type': r.type,
            'data-key': r.key,
            title: r.type.startsWith('survival') ? 'Survie' : 'Course'
        }, r.label);

        // Radio
        const radioWrap = el('div', { class: 'cp-race-radio' });
        const radio = el('input', {
            type: 'radio',
            class: 'cp-race-radio-input',
            name: 'cp-race-select',
            'data-key': r.key
        });
        radio.addEventListener('change', () => selectRaceForInspection(viewPhase, r.key));
        radioWrap.appendChild(radio);

        wrap.append(checkWrap, tile, radioWrap);
        row.appendChild(wrap);
    });

    right.append(track, row);
    inner.append(titleEl, right);
    host.replaceChildren(inner);

    updateRaceTilesStatus();
}

/* ----------------------------- Pilotes (colonne gauche) ----------------------------- */
async function fetchTeamsOrdered() {
    if (cachedTeams) return cachedTeams;
    const qTeams = query(collection(dbFirestore, 'teams'), orderBy('order', 'asc'));
    const snap = await getDocs(qTeams);
    cachedTeams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return cachedTeams;
}
async function fetchPilotsByGameOrdered(gameLabel /* 'MK8' | 'MKW' */) {
    const qPilots = query(
        collection(dbFirestore, 'pilots'),
        where('game', '==', gameLabel),
        orderBy('order', 'asc')
    );
    const snap = await getDocs(qPilots);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

/* ----------------------------- Badges pilotes ----------------------------- */
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
    const gridSize = Number(viewPhase === 'mkw' ? 24 : 12);
    const activeKey = getActiveRaceKeyForPhase(viewPhase);
    const inspectedKey = lastSelectedByPhase[viewPhase] || activeKey;

    if (viewPhase === activeTournamentPhase && inspectedKey === activeKey) {
        applyResultsToUI(viewPhase, currentResultsByPhase[viewPhase], activeGridSize);
    } else {
        const merged = mergedResultsForRace(viewPhase, inspectedKey);
        applyResultsToUI(viewPhase, merged, gridSize);
    }
}

/* ----------------------------- Calculs de statuts tuiles ----------------------------- */
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
function mergedResultsForRace(phase, raceKey) {
    if (!raceKey) return {};
    const node = historyByPhase?.[phase]?.[raceKey] || {};
    const base = node?.results || {};
    const edits = (editsByPhase?.[phase]?.[raceKey]) || {};
    const merged = { ...base };
    Object.entries(edits).forEach(([pid, v]) => {
        merged[pid] = { ...(merged[pid] || {}), rank: v?.rank ?? null };
    });
    return merged;
}
function getRaceStatusDeterministic(phase, raceKey) {
    const grid = Number(phase === 'mkw' ? 24 : 12);
    const activeKey = getActiveRaceKeyForPhase(phase);

    if (phase === activeTournamentPhase && raceKey === activeKey) {
        return computeRaceStatusFromResults(currentResultsByPhase[phase], activeGridSize);
    }
    const merged = mergedResultsForRace(phase, raceKey);
    const hasAny = Object.values(merged).some(v => v && v.rank != null);
    if (!hasAny) {
        const finals = lastFinalizedByPhase[phase] || {};
        return finals?.[raceKey]?.finalized ? 'complete' : null;
    }
    return computeRaceStatusFromResults(merged, grid) || 'filled';
}
function updateRaceTilesStatus() {
    const host = document.querySelector('#cp-races');
    if (!host || !viewPhase) return;

    const phase        = viewPhase;
    const activeKey    = getActiveRaceKeyForPhase(phase);
    const inspectedKey = lastSelectedByPhase[phase] || activeKey;
    const order        = raceOrderForPhase(phase);

    // Piste (kart uniquement si on regarde la phase active du tournoi)
    const segs = host.querySelectorAll('.cp-track-segment');
    segs.forEach(s => s.classList.remove('is-active', 'is-first', 'is-last'));
    const firstKey = order[0];
    const lastKey  = order[order.length - 1];
    const segFirst = host.querySelector(`.cp-track-segment[data-key="${firstKey}"]`);
    const segLast  = host.querySelector(`.cp-track-segment[data-key="${lastKey}"]`);
    if (segFirst) segFirst.classList.add('is-first');
    if (segLast)  segLast.classList.add('is-last');
    if (phase === activeTournamentPhase) {
        const segActive = host.querySelector(`.cp-track-segment[data-key="${activeKey}"]`);
        if (segActive) segActive.classList.add('is-active');
    }

    // Tuiles + radios + checkboxes
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
        radio.checked = (key === inspectedKey);

        const st  = getRaceStatusDeterministic(phase, key);
        const cls = classFor(st);
        if (cls) tile.classList.add(cls);

        if (phase === activeTournamentPhase && key === activeKey) tile.classList.add('is-active');
        if (key === inspectedKey) tile.classList.add('is-inspected');

        // Checkbox rules (par phase)
        if (check) {
            const isComplete  = (st === 'complete');
            const finals      = lastFinalizedByPhase[phase] || {};
            const isFinalized = !!finals?.[key]?.finalized;
            const edits       = (editsByPhase?.[phase]?.[key]) || {};
            const hasEdits    = Object.keys(edits).length > 0;

            if (hasEdits) {
                check.checked  = false;
                check.disabled = !isComplete;
            } else if (isFinalized) {
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
    });
}

/* ----------------------------- Sélection radio ----------------------------- */
function selectRaceForInspection(phase, raceKey) {
    const order = raceOrderForPhase(phase);
    if (!order.includes(raceKey)) return;
    lastSelectedByPhase[phase] = raceKey;
    updateRaceTilesStatus();
    refreshPilotListView();
}

/* ----------------------------- Modale édition rang ----------------------------- */
function openRankModal(phase, pilotId, anchorEl) {
    const backdrop = el('div', { class: 'cp-modal-backdrop', 'data-modal': 'rank' });
    const card = el('div', { class: 'cp-modal-card' });

    const closeBtn = el('button', { class: 'cp-modal-close', 'aria-label': 'Fermer' }, '×');
    closeBtn.addEventListener('click', () => backdrop.remove());

    const resetBtn = el('button', { class: 'cp-modal-reset', type: 'button' }, 'Reset');
    resetBtn.addEventListener('click', async () => {
        try {
            const activeKey = getActiveRaceKeyForPhase(phase);
            const inspectedKey = lastSelectedByPhase[phase] || activeKey;
            if (phase === activeTournamentPhase && inspectedKey === activeKey) {
                await update(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), {
                    rank: null, updatedAt: serverTimestamp()
                });
            } else {
                await update(ref(dbRealtime, `live/edits/${phase}/${inspectedKey}/${pilotId}`), {
                    rank: null, updatedAt: serverTimestamp()
                });
            }
            backdrop.remove();
        } catch (err) {
            console.error('Reset rang échouée:', err);
        }
    });

    const nameText =
        anchorEl?.querySelector('.cp-pilot-name')?.textContent?.trim() ||
        anchorEl?.dataset?.pilotName || '';
    const titleEl = el('div', { class: 'cp-modal-title' }, nameText);

    card.append(resetBtn, titleEl, closeBtn);

    const activeKey = getActiveRaceKeyForPhase(phase);
    const inspectedKey = lastSelectedByPhase[phase] || activeKey;
    const useCurrent = (phase === activeTournamentPhase && inspectedKey === activeKey);
    const resultsForGrid = useCurrent ? (currentResultsByPhase[phase] || {}) : mergedResultsForRace(phase, inspectedKey);

    const rankCount = new Map();
    Object.values(resultsForGrid).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });

    const gridSize = Number(phase === 'mkw' ? 24 : 12);
    const grid = el('div', { class: 'cp-rank-grid' });

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
                    await update(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), {
                        rank: i, updatedAt: serverTimestamp()
                    });
                } else {
                    await update(ref(dbRealtime, `live/edits/${phase}/${inspectedKey}/${pilotId}`), {
                        rank: i, updatedAt: serverTimestamp()
                    });
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

/* ----------------------------- Finalisation ----------------------------- */
let matricesCache = null;
async function fetchPointMatrices() {
    if (matricesCache) return matricesCache;
    const snap = await getDocs(collection(dbFirestore, 'pointMatrices'));
    const doc = snap.docs[0];
    matricesCache = doc ? doc.data() : {};
    return matricesCache;
}
function matrixKeyForTile(phase, type) {
    if (phase === 'mk8') return 'mk8';
    if (type === 'race') return 'mkwRace';
    if (type === 'survival') return 'mkwSurvival1';
    if (type === 'survival-final') return 'mkwSurvival2';
    return 'mkwRace';
}
function computePointsMap(results, matrix, gridSize) {
    const arr = Array.isArray(matrix) ? matrix : [];
    const map = {};
    Object.entries(results || {}).forEach(([pilotId, v]) => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r >= 1 && r <= (gridSize || arr.length || 12)) {
            map[pilotId] = { rank: r, points: Number(arr[r - 1] || 0) };
        } else {
            map[pilotId] = { rank: null, points: 0 };
        }
    });
    return map;
}

async function finalizeRaceTile(phase, raceKey) {
    const gridSize = Number(phase === 'mkw' ? 24 : 12);
    const activeKey = getActiveRaceKeyForPhase(phase);

    const type = tileTypeFromKey(phase, raceKey);
    const matrices = await fetchPointMatrices();
    const mKey = matrixKeyForTile(phase, type);
    const matrix = matrices?.[mKey] || [];

    let resultsToUse = {};
    if (phase === activeTournamentPhase && raceKey === activeKey) {
        const status = computeRaceStatusFromResults(currentResultsByPhase[phase], activeGridSize);
        if (status !== 'complete') throw new Error('Les classements ne sont pas complets/valides.');
        resultsToUse = currentResultsByPhase[phase];
    } else {
        const merged = mergedResultsForRace(phase, raceKey);
        const status = computeRaceStatusFromResults(merged, gridSize);
        if (status !== 'complete') throw new Error('La course sélectionnée n’est pas complète/valide.');
        resultsToUse = merged;
    }

    const pointsMap = computePointsMap(resultsToUse, matrix, gridSize);

    await rtdbSet(ref(dbRealtime, `live/results/${phase}/history/${raceKey}`), {
        context: {
            phase,
            raceKey,
            raceLabel: labelForRaceKey(phase, raceKey),
            gridSize,
            finalizedAt: serverTimestamp()
        },
        results: resultsToUse,
        points: pointsMap
    });
    await update(ref(dbRealtime, `live/races/${phase}/${raceKey}`), {
        finalized: true,
        finalizedAt: serverTimestamp(),
        matrixKey: mKey
    });

    const updates = {};
    Object.entries(pointsMap).forEach(([pilotId, obj]) => {
        updates[`live/points/${phase}/byRace/${raceKey}/${pilotId}`] = obj;
    });

    if (phase === activeTournamentPhase && raceKey === activeKey) {
        // Reset "current" + avancer dans le contexte à la prochaine course **de la phase active**
        Object.keys(resultsToUse || {}).forEach((pilotId) => {
            updates[`live/results/${phase}/current/${pilotId}/rank`] = null;
            updates[`live/results/${phase}/current/${pilotId}/updatedAt`] = serverTimestamp();
        });
        const nextKey = getNextRaceKey(phase, raceKey);
        if (nextKey) {
            updates[`context/current/race`] = labelForRaceKey(phase, nextKey);
            updates[`context/current/updatedAt`] = serverTimestamp();
        }
    } else {
        // Re-finalisation/validation d'une course dans une phase non active → purge edits uniquement
        updates[`live/edits/${phase}/${raceKey}`] = null;
    }

    await update(ref(dbRealtime, '/'), updates);

    // Recalcul totaux points (par phase)
    const byRaceSnap = await rtdbGet(ref(dbRealtime, `live/points/${phase}/byRace`));
    const totals = {};
    if (byRaceSnap.exists()) {
        byRaceSnap.forEach((raceSnap) => {
            const racePoints = raceSnap.val() || {};
            Object.entries(racePoints).forEach(([pilotId, obj]) => {
                totals[pilotId] = (totals[pilotId] || 0) + Number(obj?.points || 0);
            });
        });
    }
    await update(ref(dbRealtime, `live/points/${phase}`), { totals });

    // Avancer le focus radio **dans la phase de la tuile** ou revenir au "en cours"
    if (phase === activeTournamentPhase && raceKey === activeKey) {
        const nextKey = getNextRaceKey(phase, raceKey);
        if (nextKey) {
            lastSelectedByPhase[phase] = nextKey;
        }
    } else {
        // Retour au "en cours" pour cette phase
        lastSelectedByPhase[phase] = getActiveRaceKeyForPhase(phase);
    }

    updateRaceTilesStatus();
    refreshPilotListView();
}

/* ----------------------------- Montage global ----------------------------- */
function mountRaceSection() {
    attachContextListener();
}
document.addEventListener('DOMContentLoaded', async () => {
    mountPhaseSwitch();
    mountPilotsPanelSection();
    mountRaceSection();

    const tryInit = setInterval(() => {
        if (viewPhase) {
            ensureHistoryAndEditsListeners(viewPhase);
            clearInterval(tryInit);
            window.__reloadPilotsForView && window.__reloadPilotsForView();
            renderRaceStrip(viewPhase);
            updateRaceTilesStatus();
            refreshPilotListView();
        }
    }, 50);
    setTimeout(() => clearInterval(tryInit), 2000);
});
