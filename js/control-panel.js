// /js/control-panel.js
// Switch MK8/MKW + bande courses + panneau gauche pilotes (tri par team.order puis pilot.order)

import { dbRealtime, dbFirestore } from './firebase-config.js';
import {
    ref,
    onValue,
    update,
    serverTimestamp,
    off,
    get as rtdbGet,
    set as rtdbSet
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

import {
    collection,
    getDocs,
    query,
    where,
    orderBy
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

// Helpers DOM
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

let lastResults = {};
let lastPhase = 'mk8';
let lastGridSize = 12;
let lastFinalized = {};
let lastCtx = {};
// Inspection / sélection de course
let lastSelectedRaceKey = null;
let lastSelectedByPhase = { mk8: null, mkw: null };

// Listener finalisations
let racesListenerRef = null;
let racesListenerCb = null;

// État par phase pour calculer la couleur de chaque tuile sans dépendre du focus
let historyByRace = {}; // { raceKey: { results: { pilotId: {rank} }, ... } }
let editsByRace   = {}; // { raceKey: { pilotId: {rank} } }

let historyPhaseListenerRef = null;
let historyPhaseListenerCb  = null;
let editsPhaseListenerRef   = null;
let editsPhaseListenerCb    = null;

// RTDB path
const PATH_CONTEXT = 'context/current';

// ---------- Phase switch (header) ----------
async function setPhase(phase) {
    await update(ref(dbRealtime, PATH_CONTEXT), {
        phase,
        updatedAt: serverTimestamp()
    });
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
        { class: 'cp-phase-switch', role: 'group', 'aria-label': 'Phase du tournoi' },
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

    // -> on utilise applyPhaseSwitch pour écrire phase + race + gridSize cohérents
    $('#cp-btn-mk8', group).addEventListener('click', () => applyPhaseSwitch('mk8').catch(console.error));
    $('#cp-btn-mkw', group).addEventListener('click', () => applyPhaseSwitch('mkw').catch(console.error));

    // Réactivité UI pilotée par le contexte
    onValue(ref(dbRealtime, PATH_CONTEXT), (snap) => {
        const ctx = snap.val() || {};
        const phase = (ctx.phase || 'mk8').toLowerCase();
        const btnMk8 = $('#cp-btn-mk8', group);
        const btnMkw = $('#cp-btn-mkw', group);

        const setActive = (btn, active) => {
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        };

        setActive(btnMk8, phase === 'mk8');
        setActive(btnMkw, phase === 'mkw');
    });
}

// Applique un switch de phase + positionne une course cohérente dans le contexte
async function applyPhaseSwitch(newPhase) {
    const phase = (newPhase || 'mk8').toLowerCase();
    const nextGrid = (phase === 'mkw' ? 24 : 12);

    // On ne touche PAS au label 'race' ici (évite de forcer C1 par accident).
    await update(ref(dbRealtime, 'context/current'), {
        phase,
        gridSize: nextGrid,
        updatedAt: serverTimestamp()
    });

    // Laisse les listeners recalculer proprement
    lastSelectedRaceKey = null; // forcera un recalcul de la sélection
    updateRaceTilesStatus();
    refreshPilotListView();
}

// ---------- Races strip (main top) ----------
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

// Remplacer entièrement renderRaceStrip par ceci
function renderRaceStrip(phase) {
    const host = $('#cp-races');
    if (!host) return;

    const races = buildRacesForPhase(phase);
    const titleText = (phase === 'mkw') ? 'Mario Kart World' : 'Mario Kart 8';

    const inner   = el('div', { class: 'cp-races-inner' });
    const titleEl = el('div', { class: 'cp-races-title' }, titleText);

    // ---- Colonne de droite : piste + rangée de tuiles ----
    const right = el('div', { class: 'cp-races-right' });

    // Piste (au-dessus)
    const track = el('div', { class: 'cp-races-track' });
    races.forEach(r => {
        const seg = el('div', { class: 'cp-track-segment', 'data-key': r.key });
        track.appendChild(seg);
    });

    // Rangée de tuiles (checkbox / tile / radio)
    const row = el('div', { class: 'cp-races-row' });
    races.forEach((r, idx) => {
        const wrap = el('div', { class: 'cp-race-wrap', 'data-key': r.key, 'data-idx': String(idx) });

        // Checkbox (au-dessus)
        const checkWrap = el('div', { class: 'cp-race-check' });
        const input = el('input', {
            type: 'checkbox',
            class: 'cp-race-check-input',
            'data-key': r.key
        });
        input.addEventListener('change', async (e) => {
            if (e.target.checked) {
                try {
                    await finalizeRaceTile(r.key);
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

        // Radio (en-dessous)
        const radioWrap = el('div', { class: 'cp-race-radio' });
        const radio = el('input', {
            type: 'radio',
            class: 'cp-race-radio-input',
            name: 'cp-race-select',
            'data-key': r.key
        });
        radio.addEventListener('change', () => selectRaceForInspection(r.key));
        radioWrap.appendChild(radio);

        wrap.append(checkWrap, tile, radioWrap);
        row.appendChild(wrap);
    });

    right.append(track, row);
    inner.append(titleEl, right);
    host.replaceChildren(inner);

    updateRaceTilesStatus();
}

function mountRaceSection() {
    onValue(ref(dbRealtime, PATH_CONTEXT), (snap) => {
        const ctx = snap.val() || {};
        const phase = (ctx.phase || 'mk8').toLowerCase();
        lastCtx = ctx;

        renderRaceStrip(phase);

        // sélection par défaut = course active
        const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);
        const order = raceOrderForPhase(phase);
        let sel = lastSelectedByPhase[phase];

        // si pas encore de sélection pour cette phase, on part sur l'active calculée
        if (!sel || !order.includes(sel)) sel = activeKey;

        // on mémorise et on applique
        lastSelectedByPhase[phase] = sel;
        lastSelectedRaceKey = sel;
        selectRaceForInspection(sel);

        // (ré)abonner aux finalisations de la phase
        if (racesListenerRef && racesListenerCb) {
            off(racesListenerRef, 'value', racesListenerCb);
        }
        racesListenerRef = ref(dbRealtime, `live/races/${phase}`);
        racesListenerCb = async (s2) => {
            lastFinalized = s2.val() || {};

            // 1) Calcule la course "active" à partir des finalisations de CETTE phase
            const computedActive = getActiveRaceKeyFromContext(lastCtx, phase);

            // 2) Mémorise une sélection par phase si on n'en a pas encore (ou si invalide)
            if (!lastSelectedByPhase?.[phase] || !order.includes(lastSelectedByPhase[phase])) {
                lastSelectedByPhase[phase] = computedActive;
                lastSelectedRaceKey = computedActive;
            }

            // 3) Si le label 'race' du contexte ne correspond pas à la phase courante, ou n'est pas aligné,
            //    on l'aligne une seule fois (évite C1 par défaut).
            const ctxKey = raceKeyFromLabel(phase, lastCtx?.race);
            if (ctxKey !== computedActive) {
                try {
                    await update(ref(dbRealtime, 'context/current'), {
                        race: labelForRaceKey(phase, computedActive),
                        updatedAt: serverTimestamp()
                    });
                } catch (e) {
                    console.warn('Race label reconcile skipped:', e);
                }
            }

            updateRaceTilesStatus();
            refreshPilotListView();
        };

        onValue(racesListenerRef, racesListenerCb);

        // (ré)abonner à l'historique de la phase (toutes les courses)
        if (historyPhaseListenerRef && historyPhaseListenerCb) {
            off(historyPhaseListenerRef, 'value', historyPhaseListenerCb);
        }
        historyPhaseListenerRef = ref(dbRealtime, `live/results/${phase}/history`);
        historyPhaseListenerCb = (sH) => {
            const tree = sH.val() || {};
            historyByRace = {};
            Object.entries(tree).forEach(([raceKey, node]) => {
                historyByRace[raceKey] = node || {};
            });
            // IMPORTANT : mettre à jour la liste pilotes quand l'historique change
            refreshPilotListView();
            updateRaceTilesStatus();
        };
        onValue(historyPhaseListenerRef, historyPhaseListenerCb);

        // (ré)abonner aux edits de la phase (toutes les courses)
        if (editsPhaseListenerRef && editsPhaseListenerCb) {
            off(editsPhaseListenerRef, 'value', editsPhaseListenerCb);
        }
        editsPhaseListenerRef = ref(dbRealtime, `live/edits/${phase}`);
        editsPhaseListenerCb = (sE) => {
            editsByRace = sE.val() || {};
            // IMPORTANT : rafraîchir immédiat des badges pilotes en mode édition
            refreshPilotListView();
            updateRaceTilesStatus();
        };
        onValue(editsPhaseListenerRef, editsPhaseListenerCb);
    });
}

// ---------- Pilots left panel ----------
let cachedTeams = null; // cache des teams triées

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
    // index par teamName
    const byTeam = new Map(teams.map(t => [t.name, { team: t, pilots: [] }]));
    pilots.forEach(p => {
        const bucket = byTeam.get(p.teamName);
        if (bucket) bucket.pilots.push(p);
    });
    return teams.map(t => byTeam.get(t.name)); // conserve l'ordre teams
}

function renderPilotsPanel(groups) {
    const host = $('#cp-pilots-panel');
    if (!host) return;

    const container = el('div', { class: 'cp-pilots-scroll' });

    groups.forEach((g, idx) => {
        if (!g || g.pilots.length === 0) return;

        const block = el('div', { class: 'cp-team-block' });

        // Colonne logo (centrage vertical via CSS, on ne met que l'img ici)
        const logoWrap = el('div', { class: 'cp-team-logo' });
        const logoUrl = g.team?.urlLogo || '';
        if (logoUrl) {
            logoWrap.appendChild(el('img', { src: logoUrl, alt: g.team?.name || 'Team', loading: 'lazy' }));
        }
        block.appendChild(logoWrap);

        // Liste verticale de pilotes : badge + nom
        const list = el('div', { class: 'cp-team-pilots' });
        g.pilots.forEach(p => {
            const item = el('div', { class: 'cp-pilot-item', 'data-pilot-id': p.id, title: p.name || '' },
                el('span', { class: 'cp-rank-badge' }), // rempli en temps réel
                el('span', { class: 'cp-pilot-name' }, p.name || '—')
            );
            const badgeEl = item.querySelector('.cp-rank-badge');
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                openRankModal(p.id, item);
            });
            list.appendChild(item);
        });
        block.appendChild(list);

        container.appendChild(block);
        if (idx < groups.length - 1) container.appendChild(el('div', { class: 'cp-team-sep' }));
    });

    host.replaceChildren(container);
}

let resultsListenerRef = null;
let resultsListenerCb = null;

function applyResultsToUI(resultsMap, gridSize) {
    const items = Array.from(document.querySelectorAll('.cp-pilot-item'));
    const rankCount = new Map();
    let filledCount = 0;

    // 1) Remplir badges (et compter)
    items.forEach(it => {
        const pilotId = it.dataset.pilotId;
        const badge = it.querySelector('.cp-rank-badge');
        if (!badge) return;

        const rank = resultsMap?.[pilotId]?.rank ?? null;

        // reset classes & text
        badge.classList.remove('is-empty', 'is-filled', 'is-conflict', 'is-complete');
        badge.textContent = '';

        if (rank == null || rank === '') {
            badge.classList.add('is-empty');
        } else {
            const r = Number(rank);
            badge.textContent = String(rank);
            // on note rempli pour l’instant
            badge.classList.add('is-filled');
            filledCount++;
            if (Number.isInteger(r) && r > 0) {
                rankCount.set(r, (rankCount.get(r) || 0) + 1);
            }
        }
    });

    // 2) Conflits
    const conflicts = new Set([...rankCount.entries()].filter(([_, n]) => n >= 2).map(([r]) => r));
    if (conflicts.size > 0) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            const rankText = badge?.textContent?.trim();
            if (!rankText) return;
            const r = Number(rankText);
            if (conflicts.has(r)) {
                badge.classList.remove('is-empty', 'is-filled', 'is-complete');
                badge.classList.add('is-conflict');
            }
        });
    }

    // 3) Complet & valide → passer tout en vert (et enlever is-filled/is-conflict)
    const isCompleteValid = (gridSize && filledCount === Number(gridSize) && conflicts.size === 0);
    if (isCompleteValid) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            if (!badge) return;
            badge.classList.remove('is-empty', 'is-filled', 'is-conflict');
            badge.classList.add('is-complete');
        });
    }
}

function mountPilotsPanelSection() {
    const main = $('#cp-main');
    if (!main) return;

    // Nouveau layout : [pilotes] | [right: races + workspace]
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

    onValue(ref(dbRealtime, PATH_CONTEXT), async (snap) => {
        try {
            const ctx = snap.val() || {};
            lastCtx = ctx;
            const phase = (ctx.phase || 'mk8').toLowerCase();
            const gridSize = Number(ctx.gridSize || (phase === 'mkw' ? 24 : 12));
            const gameLabel = phase === 'mkw' ? 'MKW' : 'MK8';

            // Toggle classe sur <body> pour styles spécifiques
            document.body.classList.toggle('phase-mkw', phase === 'mkw');
            document.body.classList.toggle('phase-mk8', phase === 'mk8');

            const [teams, pilots] = await Promise.all([
                fetchTeamsOrdered(),
                fetchPilotsByGameOrdered(gameLabel)
            ]);

            const groups = groupPilotsByTeam(teams, pilots);
            renderPilotsPanel(groups);
            // Force l’update des badges maintenant que le DOM est prêt
            refreshPilotListView();
            updateRaceTilesStatus();

            // (ré)abonnement résultats live
            if (resultsListenerRef && resultsListenerCb) {
                off(resultsListenerRef, 'value', resultsListenerCb);
            }
            resultsListenerRef = ref(dbRealtime, `live/results/${phase}/current`);
            resultsListenerCb = (resSnap) => {
                const results = resSnap.val() || {};
                lastResults = results;
                lastGridSize = gridSize;
                lastPhase = phase;
                refreshPilotListView();
                updateRaceTilesStatus();
            };
            onValue(resultsListenerRef, resultsListenerCb);

            // Affichage immédiat (avant le 1er onValue) pour éviter les tuiles blanches au premier rendu
            try {
                const first = await rtdbGet(resultsListenerRef);
                const initial = first.val() || {};
                lastResults = initial;
                lastGridSize = gridSize;
                lastPhase = phase;
                refreshPilotListView();
                updateRaceTilesStatus();
            } catch (e) {
                console.warn('Init résultats current échouée (fallback onValue)', e);
            }
        } catch (err) {
            console.error('Erreur rendu pilotes:', err);
        }
    });
}
function openRankModal(pilotId, anchorEl) {
    // Construire la carte + backdrop
    const backdrop = el('div', { class: 'cp-modal-backdrop', 'data-modal': 'rank' });
    const card = el('div', { class: 'cp-modal-card' });

    const closeBtn = el('button', { class: 'cp-modal-close', 'aria-label': 'Fermer' }, '×');
    closeBtn.addEventListener('click', () => backdrop.remove());

    // Bouton Reset en haut à gauche (miroir de la croix)
    const resetBtn = el('button', { class: 'cp-modal-reset', type: 'button' }, 'Reset');
    resetBtn.addEventListener('click', async () => {
        try {
            const phase = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
            const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);
            if (lastSelectedRaceKey && lastSelectedRaceKey !== activeKey) {
                await update(ref(dbRealtime, `live/edits/${phase}/${lastSelectedRaceKey}/${pilotId}`), {
                    rank: null,
                    updatedAt: serverTimestamp()
                });
            } else {
                await update(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), {
                    rank: null,
                    updatedAt: serverTimestamp()
                });
            }
            backdrop.remove();
        } catch (err) {
            console.error('Reset rang échouée:', err);
        }
    });

    // Titre centré : nom du pilote
    const nameText =
        anchorEl?.querySelector('.cp-pilot-name')?.textContent?.trim() ||
        anchorEl?.dataset?.pilotName ||
        '';
    const titleEl = el('div', { class: 'cp-modal-title' }, nameText);

    // On ajoute les deux contrôles “header” de la modale
    card.append(resetBtn, titleEl, closeBtn);

    // Déterminer la source des rangs pour coloriser la grille
    const phase = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
    const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);
    const isEditingPast = lastSelectedRaceKey && lastSelectedRaceKey !== activeKey;

    const resultsForGrid = isEditingPast
        ? mergedResultsForRace(phase, lastSelectedRaceKey)
        : (lastResults || {});

    // Calcul de l’occupation des rangs
    const rankCount = new Map();
    Object.values(resultsForGrid).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });

    // Taille de grille
    const count = Number(lastCtx?.gridSize || (phase === 'mkw' ? 24 : 12));
    const grid = el('div', { class: 'cp-rank-grid' });
    
    for (let i = 1; i <= count; i++) {
        const taken = rankCount.get(i) || 0;
        const cell = el('button', {
            class: 'cp-rank-cell ' + (taken >= 2 ? 'is-conflict' : taken === 1 ? 'is-filled' : 'is-empty'),
            type: 'button',
            'data-rank': String(i)
        }, String(i));

        cell.addEventListener('click', async () => {
            try {
                const phase = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
                const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);
                if (lastSelectedRaceKey && lastSelectedRaceKey !== activeKey) {
                    await update(ref(dbRealtime, `live/edits/${phase}/${lastSelectedRaceKey}/${pilotId}`), {
                        rank: i,
                        updatedAt: serverTimestamp()
                    });
                } else {
                    await update(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), {
                        rank: i,
                        updatedAt: serverTimestamp()
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
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove(); // clic hors modale = fermer
    });
    // On doit mesurer la carte => on l'ajoute d'abord (invisible), puis on calcule
    document.body.appendChild(backdrop);
    card.style.visibility = 'hidden';
    card.style.position = 'fixed';

    // Positionner la carte à droite de la ligne pilote (ancre)
    const GAP = 8;
    const fallbackMargin = 12;
    const aRect = anchorEl ? anchorEl.getBoundingClientRect() : null;

    // Taille de la carte (une fois dans le DOM)
    const cRect = card.getBoundingClientRect();
    const cardW = cRect.width;
    const cardH = cRect.height;

    // Calcul gauche/droite
    let left;
    if (aRect) {
        left = aRect.right + GAP; // collée à droite du nom/pilote
        // si dépasse à droite, on colle à gauche de la ligne pilote
        if (left + cardW + fallbackMargin > window.innerWidth) {
            left = Math.max(fallbackMargin, aRect.left - GAP - cardW);
        }
    } else {
        left = fallbackMargin;
    }

    // Calcul top (aligné verticalement avec la ligne pilote)
    let top;
    if (aRect) {
        top = aRect.top + (aRect.height / 2) - (cardH / 2);
    } else {
        top = fallbackMargin;
    }

    // Clamp dans le viewport
    top = Math.max(fallbackMargin, Math.min(top, window.innerHeight - cardH - fallbackMargin));
    left = Math.max(fallbackMargin, Math.min(left, window.innerWidth - cardW - fallbackMargin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = 'visible';
}

function getActiveRaceKeyFromContext(ctx, phase) {
    const order = raceOrderForPhase(phase);
    if (!order || order.length === 0) return null;

    // 1) Si le contexte a un label de course cohérent → on le suit
    const fromCtx = raceKeyFromLabel(phase, ctx?.race);
    if (fromCtx && order.includes(fromCtx)) return fromCtx;

    // 2) Sinon, première non finalisée de CETTE phase (sinon la dernière)
    for (const k of order) {
        if (!lastFinalized?.[k]?.finalized) return k;
    }
    return order[order.length - 1];
}

function computeRaceStatusFromResults(results, gridSize) {
    // Retourne: 'conflict' | 'complete' | 'filled' | null
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

function updateRaceTilesStatus() {
    const host = document.querySelector('#cp-races');
    if (!host) return;

    const phase        = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
    const activeKey    = getActiveRaceKeyFromContext(lastCtx, phase);
    const inspectedKey = lastSelectedRaceKey || activeKey;
    const order        = raceOrderForPhase(phase);
    const activeIdx    = Math.max(0, order.indexOf(activeKey));
    const wraps        = Array.from(host.querySelectorAll('.cp-race-wrap'));

    // MAJ de la piste (segments)
    const trackHost = document.querySelector('#cp-races');
    const segs = trackHost ? trackHost.querySelectorAll('.cp-track-segment') : [];
    segs.forEach(s => s.classList.remove('is-active', 'is-first', 'is-last'));

    const firstKey = order[0];
    const lastKey  = order[order.length - 1];

    const segActive = trackHost?.querySelector(`.cp-track-segment[data-key="${activeKey}"]`);
    const segFirst  = trackHost?.querySelector(`.cp-track-segment[data-key="${firstKey}"]`);
    const segLast   = trackHost?.querySelector(`.cp-track-segment[data-key="${lastKey}"]`);

    if (segFirst)  segFirst.classList.add('is-first');
    if (segLast)   segLast.classList.add('is-last');
    if (segActive) segActive.classList.add('is-active');

    const classFor = (st) =>
        st === 'conflict' ? 'is-conflict' :
        st === 'complete' ? 'is-complete' :
        st === 'filled'   ? 'is-filled'   : null;

    wraps.forEach(w => {
        const key   = w.dataset.key;
        const tile  = w.querySelector('.cp-race-tile');
        const check = w.querySelector('.cp-race-check-input');
        const radio = w.querySelector('.cp-race-radio-input');

        // reset
        tile.classList.remove('is-filled','is-conflict','is-complete','is-active','is-inspected');
        if (radio) radio.checked = (key === inspectedKey);

        // 1) Couleur déterministe par course (indépendante du focus)
        const st  = getRaceStatusDeterministic(phase, key);               // 'conflict' | 'complete' | 'filled' | null
        const cls = classFor(st);
        if (cls) tile.classList.add(cls);

        // Décorations non-couleur
        if (key === activeKey)    tile.classList.add('is-active');
        if (key === inspectedKey) tile.classList.add('is-inspected');

        // 2) Checkbox : toujours visible
        //    - activable si la course est 'complete' (même avec edits)
        //    - cochée+grisée si déjà finalisée et sans edits
        //    - décochée dès qu'il y a des edits (lecture vs édition)
        if (check) {
            const isActive   = (key === activeKey);
            const hasEdits   = !isActive && !!(editsByRace?.[key] && Object.keys(editsByRace[key]).length > 0);
            const isComplete = (st === 'complete');
            const isFinalized = !!(lastFinalized?.[key]?.finalized);

            if (hasEdits) {
                check.checked  = false;
                check.disabled = !isComplete; // redevient cliquable quand 'complete'
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
function tileTypeFromKey(phase, key) {
    if (phase === 'mkw') {
        if (key === 's') return 'survival';
        if (key === 'sf') return 'survival-final';
    }
    return 'race';
}

let matricesCache = null;

async function fetchPointMatrices() {
    if (matricesCache) return matricesCache;
    // On prend le 1er doc de la collection pointMatrices
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

async function finalizeRaceTile(raceKey) {
    const phase = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
    const gridSize = Number(lastCtx?.gridSize || (phase === 'mkw' ? 24 : 12));
    const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);

    const type = tileTypeFromKey(phase, raceKey);
    const matrices = await fetchPointMatrices();
    const mKey = matrixKeyForTile(phase, type);
    const matrix = matrices?.[mKey] || [];

    let resultsToUse = {};

    if (raceKey === activeKey) {
        // Finalisation de la course active (saisies en cours)
        const status = computeRaceStatusFromResults(lastResults, gridSize);
        if (status !== 'complete') {
            throw new Error('Les classements ne sont pas complets/valides.');
        }
        resultsToUse = lastResults;
    } else {
        // Re-finalisation d’une course passée : history + edits (fusion globale)
        const merged = mergedResultsForRace(phase, raceKey);
        const status = computeRaceStatusFromResults(merged, gridSize);
        if (status !== 'complete') {
            throw new Error('La course sélectionnée n’est pas complète/valide.');
        }
        resultsToUse = merged;
    }

    // Calcul des points
    const pointsMap = computePointsMap(resultsToUse, matrix, gridSize);

    // Écrit l’historique complet de la course
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

    // Flag de finalisation de la course
    await update(ref(dbRealtime, `live/races/${phase}/${raceKey}`), {
        finalized: true,
        finalizedAt: serverTimestamp(),
        matrixKey: mKey
    });

    // Mises à jour multiples (points par course, reset current ou purge edits)
    const updates = {};
    Object.entries(pointsMap).forEach(([pilotId, obj]) => {
        updates[`live/points/${phase}/byRace/${raceKey}/${pilotId}`] = obj;
    });

    if (raceKey === activeKey) {
        // Reset des rangs "current" et passage à la course suivante
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
        // Re-finalisation d’une course passée : purge des edits
        updates[`live/edits/${phase}/${raceKey}`] = null;
    }

    await update(ref(dbRealtime, '/'), updates);
    // Avance le focus radio dans LA phase concernée
    const nextKey = (raceKey === activeKey) ? getNextRaceKey(phase, raceKey) : activeKey;
    if (raceKey === activeKey && nextKey) {
        lastSelectedByPhase[phase] = nextKey;
        lastSelectedRaceKey = nextKey;
    } else if (raceKey !== activeKey) {
        // Pour une re-finalisation d'une course passée, on revient au "en cours"
        lastSelectedByPhase[phase] = activeKey;
        lastSelectedRaceKey = activeKey;
    }

    // Recalcul des totaux
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

    // Maj locale & UI
    lastFinalized = { ...(lastFinalized || {}), [raceKey]: { finalized: true } };
    if (raceKey !== activeKey) {
        lastSelectedRaceKey = activeKey; // retour à l’état “en cours”
    }

    updateRaceTilesStatus();
    refreshPilotListView();
}

function refreshPilotListView() {
    const phase = (lastCtx?.phase || lastPhase || 'mk8').toLowerCase();
    const grid  = Number(lastCtx?.gridSize || (phase === 'mkw' ? 24 : 12));
    const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);

    if (!lastSelectedRaceKey || lastSelectedRaceKey === activeKey) {
        applyResultsToUI(lastResults, grid);
    } else {
        const merged = mergedResultsForRace(phase, lastSelectedRaceKey);
        applyResultsToUI(merged, grid);
    }
}

function selectRaceForInspection(raceKey) {
    lastSelectedRaceKey = raceKey;
    updateRaceTilesStatus();
    refreshPilotListView();
}

function mergedResultsForRace(phase, raceKey) {
    if (!raceKey) return {};
    const base   = (historyByRace?.[raceKey]?.results) || {};
    const edits  = (editsByRace?.[raceKey]) || {};
    const merged = { ...base };
    Object.entries(edits).forEach(([pid, v]) => {
        merged[pid] = { ...(merged[pid] || {}), rank: v?.rank ?? null };
    });
    return merged;
}

function getRaceStatusDeterministic(phase, raceKey) {
    const grid = Number(lastCtx?.gridSize || (phase === 'mkw' ? 24 : 12));
    const activeKey = getActiveRaceKeyFromContext(lastCtx, phase);

    // 1) Course active: se base sur lastResults (saisies en cours)
    if (raceKey === activeKey) {
        return computeRaceStatusFromResults(lastResults, grid); // 'conflict' | 'complete' | 'filled' | null
    }

    // 2) Courses passées: history + edits (si edits absents et finalisée -> 'complete')
    const merged = mergedResultsForRace(phase, raceKey);
    const hasAnyValue = Object.values(merged).some(v => v && v.rank != null);

    if (!hasAnyValue) {
        // rien en merged → si finalisée on laisse 'complete', sinon null
        return lastFinalized?.[raceKey]?.finalized ? 'complete' : null;
    }

    const st = computeRaceStatusFromResults(merged, grid);
    // Si 'null' mais on a des valeurs → au moins 'filled'
    return st || 'filled';
}
function raceKeyFromLabel(phase, label) {
    if (!label || typeof label !== 'string') return null;
    const l = label.toLowerCase().trim();
    const order = raceOrderForPhase(phase) || [];

    if (phase === 'mk8') {
        // ex: "Course 5/8"
        const m = l.match(/(\d+)\s*\/\s*8/);
        if (m) {
            const n = parseInt(m[1], 10);
            const key = `c${n}`;
            return order.includes(key) ? key : null;
        }
    } else {
        // MKW ex: "Course 4/6", "Survie 1", "Survie finale"
        if (l.includes('finale') || /\bsf\b/.test(l)) return order.includes('sf') ? 'sf' : null;
        if (l.includes('survie')) return order.includes('s') ? 's' : null;
        const m = l.match(/(\d+)\s*\/\s*6/);
        if (m) {
            const n = parseInt(m[1], 10);
            const key = `c${n}`;
            return order.includes(key) ? key : null;
        }
    }
    // fallback : si le label est déjà "c5", "s", "sf"
    const maybe = l.replace(/\s+/g, '');
    return order.includes(maybe) ? maybe : null;
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
    mountPhaseSwitch();
    mountPilotsPanelSection(); // crée #cp-races dans la colonne droite
    mountRaceSection();        // rend les courses dans #cp-races
});
