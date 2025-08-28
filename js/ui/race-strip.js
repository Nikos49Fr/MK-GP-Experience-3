/**
 * Race Strip — composant autonome (MK GP Experience 3)
 * ----------------------------------------------------
 * Bandeau de tuiles représentant les courses d'une phase (MK8/MKW).
 * >>> Aligne sa logique "courses" strictement avec control-panel.js (listeners + calculs).
 *
 * API:
 *  export function initRaceStrip(container, options = {}) -> {
 *      host, ready, destroy, update, setData,
 *      setPhaseView(phase), getPhaseView()
 *  }
 */

/* ========================================================================== */
/* Constantes, classes, options par défaut                                     */
/* ========================================================================== */

const DEFAULTS = Object.freeze({
    controller: 'firebase',            // 'firebase' (par défaut) ou 'external'
    mode: 'simple',                    // 'simple' | 'admin'
    phase: 'mk8',                      // vue locale initiale
    races: null,                       // si null → déduit de phase
    activeRaceId: null,                // affichage (sera piloté par context)
    inspectedRaceId: null,             // sélection de vue
    // Maps d’états PAR PHASE (strict, évite les fuites MK8<->MKW)
    statusByRace: { mk8: {}, mkw: {} },        // { phase: { raceId: 'filled'|'conflict'|'complete'|'activeEmpty'|null } }
    finalizedByRace: { mk8: {}, mkw: {} },     // { phase: { raceId: boolean } }
    // Callbacks (optionnels)
    onSelect: null,                    // (raceId)=>void
    onFinalize: null,                  // async (raceId)=>void (controller 'external')
    showPhaseNav: false,               // nav consultative MK8 ⇄ MKW intégrée
    onPhaseViewChange: null            // (phase)=>void — notification côté hôte
});

const CLASSNAMES = Object.freeze({
    ROOT: 'race-strip',
    INNER: 'race-strip__inner',
    ROW: 'race-strip__row',
    CELL: 'race-strip__cell',
    TILE: 'race-strip__tile',
    FINALIZE: 'race-strip__finalize',
    NAV: 'race-strip__nav',
    NAV_BTN: 'race-strip__nav-btn',
    NAV_LABEL: 'race-strip__nav-label',
    STATE: {
        INSPECTED: 'is-inspected',
        ACTIVE: 'is-active',
        FILLED: 'is-filled',
        CONFLICT: 'is-conflict',
        ACTIVE_EMPTY: 'is-active-empty',
        COMPLETE_PENDING: 'is-complete-pending', // complete (non finalisée)
        COMPLETE_FINAL: 'is-complete-final'       // complete + finalisée
    }
});

/* ========================================================================== */
/* Utilitaires DOM                                                             */
/* ========================================================================== */

function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === 'class') n.className = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, String(v));
    }
    children.forEach(c => n.append(c));
    return n;
}

/* ========================================================================== */
/* Helpers “données” (alignés avec control-panel.js)                           */
/* ========================================================================== */

function GRID_SIZE(phase) {
    return (String(phase).toLowerCase() === 'mkw') ? 24 : 12;
}

function buildRaceList(phase) {
    phase = String(phase).toLowerCase();
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

function pickDefaultInspected(phase, activeId, finalizedByRace) {
    const order = buildRaceList(phase);
    if (activeId && order.includes(activeId)) return activeId;
    const allFinalized = order.every(id => !!finalizedByRace?.[id]?.finalized === true);
    return allFinalized ? order[order.length - 1] : order[0];
}

/* ========================================================================== */
/* Rendu                                                                       */
/* ========================================================================== */

function computeLayout(phaseView) {
    const p = String(phaseView || '').toLowerCase();
    if (p === 'mkw') {
        return [
            ['1','2','3','4','5','6','S'],
            ['7','8','9','10','11','12','SF']
        ];
    }
    return [['1','2','3','4','5','6','7','8']];
}

function renderHeaderNav(host, state, getPhaseView, setPhaseView) {
    if (!state.showPhaseNav) {
        host.querySelector(`.${CLASSNAMES.NAV}`)?.remove();
        return;
    }
    let $nav = host.querySelector(`.${CLASSNAMES.NAV}`);
    if (!$nav) {
        $nav = el('div', { class: CLASSNAMES.NAV, role: 'toolbar', 'aria-label': 'Navigation de phase' });
        host.prepend($nav);
    } else {
        $nav.replaceChildren();
    }

    const current = String(getPhaseView() || 'mk8').toLowerCase();
    const $btnPrev = el('button', { class: CLASSNAMES.NAV_BTN, type: 'button', 'aria-label': 'Phase précédente' }, '‹');
    const $label  = el('div', { class: CLASSNAMES.NAV_LABEL }, current.toUpperCase());
    const $btnNext = el('button', { class: CLASSNAMES.NAV_BTN, type: 'button', 'aria-label': 'Phase suivante' }, '›');

    const togglePhase = () => setPhaseView(current === 'mk8' ? 'mkw' : 'mk8');
    $btnPrev.addEventListener('click', togglePhase);
    $btnNext.addEventListener('click', togglePhase);

    $nav.append($btnPrev, $label, $btnNext);
}

function renderRows(host, state, getPhaseView) {
    const phaseView = String(getPhaseView() || 'mk8').toLowerCase();
    const rows = computeLayout(phaseView);

    // Maps par phase (alignement strict)
    const statusMap    = state.statusByRace?.[phaseView] || {};
    const finalizedMap = state.finalizedByRace?.[phaseView] || {};

    const inner = el('div', { class: CLASSNAMES.INNER });

    rows.forEach((raceIds, rowIdx) => {
        const $row = el('div', { class: CLASSNAMES.ROW, 'data-row': String(rowIdx + 1) });

        raceIds.forEach((raceId) => {
            const status = statusMap[raceId] ?? null;
            const isFinalized = !!(finalizedMap[raceId]?.finalized === true);

            // Libellé pour MKW (8..13 affiché pour ids 7..12)
            let label = raceId;
            if (phaseView === 'mkw') {
                const n = Number(raceId);
                if (Number.isInteger(n) && n >= 7 && n <= 12) label = String(n + 1);
                if (raceId === 'S')  label = 'S';
                if (raceId === 'SF') label = 'SF';
            }

            const $btn = el('button', {
                class: CLASSNAMES.TILE,
                type: 'button',
                'data-race-id': raceId,
                'aria-pressed': state.inspectedRaceId === raceId ? 'true' : 'false',
                'aria-label': `Course ${label} (${phaseView.toUpperCase()})`
            }, label);

            if (state.inspectedRaceId === raceId) $btn.classList.add(CLASSNAMES.STATE.INSPECTED);
            if (state.activeRaceId === raceId)    $btn.classList.add(CLASSNAMES.STATE.ACTIVE);

            if (status === 'conflict') {
                $btn.classList.add(CLASSNAMES.STATE.CONFLICT);
            } else if (status === 'filled') {
                $btn.classList.add(CLASSNAMES.STATE.FILLED);
            } else if (status === 'activeEmpty') {
                $btn.classList.add(CLASSNAMES.STATE.ACTIVE_EMPTY);
            } else if (status === 'complete') {
                if (isFinalized) $btn.classList.add(CLASSNAMES.STATE.COMPLETE_FINAL);
                else             $btn.classList.add(CLASSNAMES.STATE.COMPLETE_PENDING);
            }

            $btn.addEventListener('click', () => {
                // Lock inspection côté utilisateur
                state._inspectLocked = true;
                state.__lastSelectedByPhase[phaseView] = raceId;

                if (state.inspectedRaceId !== raceId) {
                    state.inspectedRaceId = raceId;
                    if (typeof state.onSelect === 'function') {
                        try { state.onSelect(raceId); } catch (e) { console.error(e); }
                    }
                    inner.querySelectorAll(`.${CLASSNAMES.TILE}`).forEach(t => {
                        const isMe = t.dataset.raceId === raceId;
                        t.classList.toggle(CLASSNAMES.STATE.INSPECTED, isMe);
                        t.setAttribute('aria-pressed', isMe ? 'true' : 'false');
                    });
                }
            });

            // Bouton Finaliser (mode admin)
            const $cellChildren = [$btn];
            if (state.mode === 'admin') {
                const $finalize = el('button', {
                    class: CLASSNAMES.FINALIZE,
                    type: 'button',
                    title: isFinalized ? 'Course déjà finalisée' : 'Finaliser la course'
                }, isFinalized ? '✔' : '✓');

                let can = false;
                if (state.controller === 'firebase') {
                    const started = isPhaseStarted(state, phaseView);
                    can = (started && status === 'complete' && !isFinalized);
                } else {
                    can = (status === 'complete' && !isFinalized);
                }

                if (!can) {
                    $finalize.disabled = true;
                    $finalize.setAttribute('aria-disabled', 'true');
                }

                $finalize.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    if ($finalize.disabled) return;

                    $finalize.disabled = true;
                    $finalize.setAttribute('aria-busy', 'true');

                    try {
                        if (state.controller === 'firebase' && state.__fb?.runFinalize) {
                            await state.__fb.runFinalize(raceId);
                        } else if (typeof state.onFinalize === 'function') {
                            await state.onFinalize(raceId);
                        } else {
                            throw new Error('Finalize controller unavailable');
                        }
                    } catch (e) {
                        console.error('[race-strip] finalize error:', e);
                        $finalize.disabled = false;
                    } finally {
                        $finalize.removeAttribute('aria-busy');
                    }
                });

                $cellChildren.push($finalize);
            }

            const $cell = el('div', { class: CLASSNAMES.CELL }, ...$cellChildren);
            $row.appendChild($cell);
        });

        inner.appendChild($row);
    });

    const currentInner = host.querySelector(`.${CLASSNAMES.INNER}`);
    if (currentInner) host.replaceChild(inner, currentInner);
    else host.appendChild(inner);
}

/* ========================================================================== */
/* Logique alignée control-panel: active & statuts                             */
/* ========================================================================== */

// Phase démarrée = context/current pointe cette phase ET une raceId est définie
function isPhaseStarted(state, phase) {
    const p = String(phase || '').toLowerCase();
    const activeP = String(state.__activeTournamentPhase || '').toLowerCase();
    return (p === activeP) && !!state.__activeRaceId; // ne lit plus state.__ctx
}

// Détermine la course "active" pour une phase donnée (exact cp)
function getActiveRaceIdForPhase_cp(state, phase) {
    const activeTournamentPhase = String(state.__activeTournamentPhase || 'mk8');
    const activeRaceId = state.__activeRaceId || null;

    if (phase === activeTournamentPhase) return activeRaceId;

    const order = buildRaceList(phase);
    const finals = state.finalizedByRace?.[phase] || {};
    for (const k of order) {
        const isFinal = !!(finals[k]?.finalized === true);
        if (!isFinal) return k;
    }
    return order[order.length - 1];
}

// Statut déterministe (exact cp)
function getRaceStatusDeterministic_cp(state, caches, phase, raceId) {
    const grid = GRID_SIZE(phase);
    const activeId = getActiveRaceIdForPhase_cp(state, phase);
    const activeTournamentPhase = String(state.__activeTournamentPhase || 'mk8');
    const finals = state.finalizedByRace?.[phase] || {};

    // Course ACTIVE de la phase ACTIVE
    if (phase === activeTournamentPhase && raceId === activeId) {
        const current = caches.currentResultsByPhase?.[phase] || {};
        const hasCurrent = Object.values(current).some(v => v && Number(v.rank) > 0);
        if (hasCurrent) return computeRaceStatusFromResults(current, grid);

        const ranks = caches.byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
        const hasRanks = Object.values(ranks).some(v => v && Number(v.rank) > 0);
        if (hasRanks) return computeRaceStatusFromResults(ranks, grid) || 'filled';

        return finals[raceId]?.finalized ? 'complete' : 'activeEmpty';
    }

    // NON active → byRace/ranks uniquement
    const ranks = caches.byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
    const hasAny = Object.values(ranks).some(v => v && Number(v.rank) > 0);
    if (!hasAny) return finals[raceId]?.finalized ? 'complete' : null;
    return computeRaceStatusFromResults(ranks, grid) || 'filled';
}

/* ========================================================================== */
/* Contrôleur Firebase (écoutes strictement alignées)                          */
/* ========================================================================== */

async function loadPointsMatrices(fb, pointsMatrices) {
    // Aligne strictement control-panel : Firestore "points/{mk8|mkw}" avec "ranks"
    if (pointsMatrices.__loaded && pointsMatrices.mk8 && pointsMatrices.mkw) return;

    // Docs Firestore
    const mk8Doc = await fb.getDoc(fb.doc(fb.dbFirestore, 'points', 'mk8')).catch(() => null);
    const mkwDoc = await fb.getDoc(fb.doc(fb.dbFirestore, 'points', 'mkw')).catch(() => null);

    pointsMatrices.mk8 = (mk8Doc && mk8Doc.exists()) ? (mk8Doc.data() || {}) : {};
    pointsMatrices.mkw = (mkwDoc && mkwDoc.exists()) ? (mkwDoc.data() || {}) : {};

    // Marque "chargé" si on a bien quelque chose (même objet vide est ok)
    pointsMatrices.__loaded = true;
}

function basePointsFor(pointsMatrices, phase, raceId, rank) {
    const r = String(Number(rank));
    if (!/^\d+$/.test(r)) return 0;

    if (phase === 'mk8') {
        // control-panel : points.mk8.ranks[rank] -> number
        const table = pointsMatrices.mk8?.ranks || {};
        return Number(table[r] ?? 0);
    }

    // phase mkw : points.mkw.ranks[rank] -> { race, s1, s2 }
    const row = pointsMatrices.mkw?.ranks?.[r];
    if (!row) return 0;
    if (raceId === 'S')  return Number(row.s1 ?? 0);
    if (raceId === 'SF') return Number(row.s2 ?? 0);
    return Number(row.race ?? 0);
}

async function recomputeTotalsForPhase(fb, phase) {
    const totals = {};
    const byRaceSnap = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/byRace`)).catch(()=>null);
    const byRace = byRaceSnap && byRaceSnap.exists() ? (byRaceSnap.val() || {}) : {};
    Object.values(byRace).forEach((raceObj) => {
        Object.entries(raceObj || {}).forEach(([pilotId, obj]) => {
            const val = Number(obj?.final ?? 0);
            totals[pilotId] = (totals[pilotId] || 0) + val;
        });
    });

    // Extras (optionnels)
    const cosplayPublic = (await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/cosplay/public`)).catch(()=>null));
    const cosplayJury   = (await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/cosplay/jury`)).catch(()=>null));
    const viewers       = (await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/awards/viewers`)).catch(()=>null));
    const hosts         = (await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/awards/hosts`)).catch(()=>null));

    const cvPub = cosplayPublic && cosplayPublic.exists() ? cosplayPublic.val() : null;
    const cvJur = cosplayJury   && cosplayJury.exists()   ? cosplayJury.val()   : null;
    const vw    = viewers       && viewers.exists()       ? viewers.val()       : null;
    const hs    = hosts         && hosts.exists()         ? hosts.val()         : null;

    if (cvPub?.pilotId) totals[cvPub.pilotId] = (totals[cvPub.pilotId] || 0) + 8;
    if (cvJur?.pilotId) totals[cvJur.pilotId] = (totals[cvJur.pilotId] || 0) + 10;
    if (vw?.pilotId)    totals[vw.pilotId]    = (totals[vw.pilotId]    || 0) + 3;
    if (hs?.pilotId)    totals[hs.pilotId]    = (totals[hs.pilotId]    || 0) + 2;

    await fb.set(fb.ref(fb.dbRealtime, `live/points/${phase}/totals`), totals);
}

async function finalizeRaceFirebase(fb, state, caches, raceId) {
    if (!raceId) throw new Error('raceId manquant.');
    const phase = state.phase;
    const grid = GRID_SIZE(phase);

    // 0) Matrices de points (Firestore)
    await loadPointsMatrices(fb, state.__pointsMatrices);

    const isActivePhase = (String(state.__activeTournamentPhase || 'mk8') === phase);
    const activeId = getActiveRaceIdForPhase_cp(state, phase);
    const useCurrent = isActivePhase && (activeId === raceId);

    // 1) Vérifier complétude + récupérer les rangs source
    let ranksSource = null;
    if (useCurrent) {
        const cur = caches.currentResultsByPhase?.[phase] || {};
        const st  = computeRaceStatusFromResults(cur, grid);
        if (st !== 'complete') throw new Error('Classements incomplets/invalides (current).');
        ranksSource = cur;
    } else {
        const ranksSnap = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`)).catch(()=>null);
        const ranksNode = ranksSnap && ranksSnap.exists() ? (ranksSnap.val() || {}) : {};
        const st  = computeRaceStatusFromResults(ranksNode, grid);
        if (st !== 'complete') throw new Error('Classements incomplets/invalides (byRace).');
        ranksSource = ranksNode;
    }

    // 2) Copier current → byRace/ranks si course active
    if (useCurrent) {
        const updates = {};
        Object.entries(ranksSource).forEach(([pilotId, obj]) => {
            const rank = Number(obj?.rank);
            if (Number.isInteger(rank) && rank > 0) {
                updates[`live/results/${phase}/byRace/${raceId}/ranks/${pilotId}`] = { rank };
            }
        });
        if (Object.keys(updates).length) {
            await fb.update(fb.ref(fb.dbRealtime, '/'), updates);
        }
    }

    // 3) Calcul points byRace (rank/base/doubled/final)
    const ranksSnap2 = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`)).catch(()=>null);
    const doublesSnap = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/doubles`)).catch(()=>null);
    const ranks = ranksSnap2 && ranksSnap2.exists() ? (ranksSnap2.val() || {}) : {};
    const doubles = doublesSnap && doublesSnap.exists() ? (doublesSnap.val() || {}) : {};

    const pointsUpdates = {};
    Object.entries(ranks).forEach(([pilotId, v]) => {
        const rank = Number(v?.rank ?? 0);
        const base = basePointsFor(state.__pointsMatrices, phase, raceId, rank);
        const doubled = !!doubles[pilotId];
        const final = base * (doubled ? 2 : 1);
        pointsUpdates[`live/points/${phase}/byRace/${raceId}/${pilotId}`] = { rank, base, doubled, final };
    });
    if (Object.keys(pointsUpdates).length) {
        await fb.update(fb.ref(fb.dbRealtime, '/'), pointsUpdates);
    }

    // 4) Totaux de phase
    await recomputeTotalsForPhase(fb, phase);

    // 5) Marquer finalisée — OBJET { finalized:true }
    await fb.set(fb.ref(fb.dbRealtime, `live/races/${phase}/${raceId}`), { finalized: true });

    // 6) Si course active: nettoyer current et avancer context/current
    if (useCurrent) {
        await fb.remove(fb.ref(fb.dbRealtime, `live/results/${phase}/current`)).catch(()=>{});
        const order = buildRaceList(phase);
        const idx   = order.indexOf(raceId);
        const next  = (idx >= 0 && idx < order.length - 1) ? order[idx + 1] : null;
        if (next) {
            await fb.update(fb.ref(fb.dbRealtime, `context/current`), { phase, raceId: next, rid: `${phase}-${next}` });
        } else {
            await fb.update(fb.ref(fb.dbRealtime, `context/current`), { phase, raceId: null, rid: null });
        }
    }
}

function attachFirebaseController(state, getPhaseView, setPhaseView, setStateAndRender) {
    // Refs et caches strictement alignés
    let fb = null;

    // Variables “globales” du control-panel (scopées à l’instance)
    state.__activeTournamentPhase = 'mk8';
    state.__activeRaceId = '1';
    state.__pointsMatrices = { mk8: null, mkw: null, __loaded: false };

    // Sélection inspectée mémorisée par phase (alignement cp)
    state.__lastSelectedByPhase = state.__lastSelectedByPhase || { mk8: null, mkw: null };

    // Caches RTDB
    const caches = {
        currentResultsByPhase: { mk8: {}, mkw: {} }, // live/results/{phase}/current
        byRaceResultsByPhase:  { mk8: {}, mkw: {} }, // live/results/{phase}/byRace
        lastFinalizedByPhase:  { mk8: {}, mkw: {} }  // live/races/{phase}/{raceId}.finalized
    };

    // Suivi automatique du contexte en viewer (simple), comme convenu
    const followContext = (state.mode !== 'admin');

    // Listeners en cours
    const unsub = { context: null, currentPhase: {ref:null,cb:null}, byRace: {ref:null,cb:null}, races: {ref:null,cb:null}, phaseKey: null };

    // Applique les maps pour une phase (exact cp) et déclenche le render
    const applyMaps = (phaseLike) => {
        const phase = (String(phaseLike || state.phase).toLowerCase() === 'mkw') ? 'mkw' : 'mk8';

        // active + inspected
        const activeId = getActiveRaceIdForPhase_cp(state, phase);
        const inspected = state._inspectLocked
            ? state.inspectedRaceId
            : (state.__lastSelectedByPhase[phase] || activeId || buildRaceList(phase)[0]);

        // Statuts par course (via getRaceStatusDeterministic)
        const order = buildRaceList(phase);
        const statusByRacePhase = {};
        order.forEach((rid) => {
            statusByRacePhase[rid] = getRaceStatusDeterministic_cp(state, caches, phase, rid);
        });

        // Merge PAR PHASE (strict)
        const mergedStatus = { ...(state.statusByRace || { mk8:{}, mkw:{} }) };
        const mergedFinal  = { ...(state.finalizedByRace || { mk8:{}, mkw:{} }) };
        mergedStatus[phase] = statusByRacePhase;
        mergedFinal[phase]  = (state.finalizedByRace?.[phase] || {}); // déjà mis à jour via listener .races

        // Déterminer inspected par défaut si pas de lock
        let finalInspected = inspected;
        if (!state._inspectLocked) {
            const finals = mergedFinal[phase] || {};
            finalInspected = pickDefaultInspected(phase, activeId, finals);
            state.__lastSelectedByPhase[phase] = finalInspected;
        }

        // Active locale (affichage)
        state.activeRaceId = activeId;

        setStateAndRender({
            phase,
            activeRaceId: activeId,
            statusByRace: mergedStatus,
            finalizedByRace: mergedFinal,
            inspectedRaceId: finalInspected
        });
    };

    // Intercepte la nav consultative
    const originalOnPhaseViewChange = state.onPhaseViewChange;
    state.onPhaseViewChange = (phase) => {
        // En admin on peut “verrouiller” la vue; en viewer on suit toujours le contexte
        const lockAllowed = (state.mode === 'admin');
        if (!lockAllowed) state._inspectLocked = false; // viewer: pas de lock

        // Changement de vue → oublier lock d’inspection
        state._inspectLocked = false;

        ensurePhaseViewListeners(phase);
        applyMaps(phase);

        if (typeof originalOnPhaseViewChange === 'function') {
            try { originalOnPhaseViewChange(phase); } catch {}
        }
    };

    // Import dynamique Firebase + bootstrap des listeners
    (async () => {
        try {
            const cfg = await import('../firebase-config.js'); // export { dbRealtime, dbFirestore }
            const dbRealtime = cfg.dbRealtime;
            const dbFirestore = cfg.dbFirestore;

            const { ref, onValue, off, get, set, update, remove } =
                await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js');
            const { doc, getDoc } =
                await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js');

            fb = { dbRealtime, dbFirestore, ref, onValue, off, get, set, update, remove, doc, getDoc };

            // ✅ Expose finalize & offAll AVANT tout listener/rendu
            state.__fb = {
                runFinalize: async (raceId) => {
                    if (!fb) throw new Error('Firebase non initialisé.');
                    await finalizeRaceFirebase(fb, state, caches, raceId);
                    // On s’appuie sur les listeners pour rafraîchir (évite “tout blanc”)
                },
                offAll: () => {
                    try {
                        if (unsub.currentPhase.ref && unsub.currentPhase.cb) off(unsub.currentPhase.ref, 'value', unsub.currentPhase.cb);
                        if (unsub.byRace.ref && unsub.byRace.cb)             off(unsub.byRace.ref, 'value', unsub.byRace.cb);
                        if (unsub.races.ref && unsub.races.cb)               off(unsub.races.ref, 'value', unsub.races.cb);
                        if (unsub.context?.ref && unsub.context?.cb)        off(unsub.context.ref, 'value', unsub.context.cb);
                    } catch {}
                }
            };
            console.log('[race-strip] firebase controller ready');

            // Listener: context/current
            const ctxRef = ref(dbRealtime, 'context/current');
            const ctxCb = (snap) => {
                const ctx = snap.val() || null;
                state.__ctx = ctx;
                state.__activeTournamentPhase = (ctx?.phase || 'mk8').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
                state.__activeRaceId = ctx?.raceId || null;

                // Suivre le contexte en viewer (ou si pas de lock admin)
                if (followContext) {
                    const nextPhase = state.__activeTournamentPhase;
                    if (state.phase !== nextPhase) {
                        setPhaseView(nextPhase);
                        return; // render via setPhaseView → on ré-attache ensuite ci-dessous
                    }
                }

                // Phase visible courante
                ensurePhaseViewListeners(state.phase);
                applyMaps(state.phase);
            };
            onValue(ctxRef, ctxCb);
            unsub.context = { ref: ctxRef, cb: ctxCb };

            // Listeners pour la phase visible (premier attach + premier render)
            ensurePhaseViewListeners(state.phase);
            applyMaps(state.phase);

        } catch (err) {
            console.error('[race-strip] Firebase init error:', err);
        }
    })();

    function ensureCurrentResultsListener(phase) {
        // current (uniquement sur la phase active)
        if (unsub.currentPhase.ref && unsub.currentPhase.cb) {
            fb.off(unsub.currentPhase.ref, 'value', unsub.currentPhase.cb);
            unsub.currentPhase = { ref: null, cb: null };
        }
        const r = fb.ref(fb.dbRealtime, `live/results/${phase}/current`);
        const cb = (s) => {
            caches.currentResultsByPhase[phase] = s.val() || {};
            if (state.phase === phase) applyMaps(phase);
        };
        fb.onValue(r, cb);
        unsub.currentPhase = { ref: r, cb };

        // init
        fb.get(r).then(s => {
            caches.currentResultsByPhase[phase] = s.val() || {};
            if (state.phase === phase) applyMaps(phase);
        }).catch(()=>{});
    }

    function ensurePhaseViewListeners(phase) {
        const p = String(phase).toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
        if (unsub.byRace.ref && unsub.byRace.cb) {
            fb.off(unsub.byRace.ref, 'value', unsub.byRace.cb);
            unsub.byRace = { ref: null, cb: null };
        }
        if (unsub.races.ref && unsub.races.cb) {
            fb.off(unsub.races.ref, 'value', unsub.races.cb);
            unsub.races = { ref: null, cb: null };
        }

        // current: suivre la phase active réelle
        ensureCurrentResultsListener(state.__activeTournamentPhase);

        // races/{phase} — lecture normalisée en OBJET { finalized: boolean }
        const racesRef = fb.ref(fb.dbRealtime, `live/races/${p}`);
        const racesCb = (snap) => {
            const raw = snap.val() || {};
            const mapObj = {};
            for (const [rid, v] of Object.entries(raw)) {
                if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'finalized')) {
                    mapObj[rid] = { finalized: !!v.finalized };
                } else {
                    // compat ancienne donnée bool → on présente comme objet
                    mapObj[rid] = { finalized: !!v };
                }
            }
            state.finalizedByRace = { ...(state.finalizedByRace || { mk8:{}, mkw:{} }), [p]: mapObj };
            caches.lastFinalizedByPhase[p] = mapObj;
            if (state.phase === p) applyMaps(p);
        };
        fb.onValue(racesRef, racesCb);
        unsub.races = { ref: racesRef, cb: racesCb };

        // results/{phase}/byRace
        const byRaceRef = fb.ref(fb.dbRealtime, `live/results/${p}/byRace`);
        const byRaceCb = (snap) => {
            caches.byRaceResultsByPhase[p] = snap.val() || {};
            if (state.phase === p) applyMaps(p);
        };
        fb.onValue(byRaceRef, byRaceCb);
        unsub.byRace = { ref: byRaceRef, cb: byRaceCb };

        // init (fetch uniques)
        fb.get(racesRef).then(s => {
            const raw = s.val() || {};
            const mapObj = {};
            for (const [rid, v] of Object.entries(raw)) {
                if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'finalized')) {
                    mapObj[rid] = { finalized: !!v.finalized };
                } else {
                    mapObj[rid] = { finalized: !!v };
                }
            }
            state.finalizedByRace = { ...(state.finalizedByRace || { mk8:{}, mkw:{} }), [p]: mapObj };
            caches.lastFinalizedByPhase[p] = mapObj;
            if (state.phase === p) applyMaps(p);
        }).catch(()=>{});
        fb.get(byRaceRef).then(s => {
            caches.byRaceResultsByPhase[p] = s.val() || {};
            if (state.phase === p) applyMaps(p);
        }).catch(()=>{});
    }
}

/* ========================================================================== */
/* Factory init                                                                */
/* ========================================================================== */

function normalizeOptions(opts) {
    const input = opts || {};
    const o = { ...DEFAULTS, ...input };

    // Phase normalisée
    const phaseKey = String(o.phase || 'mk8').toLowerCase();
    o.phase = (phaseKey === 'mkw') ? 'mkw' : 'mk8';

    // Flag “phase forcée par l’hôte”
    o._phaseLockedByOptions = Object.prototype.hasOwnProperty.call(input, 'phase');

    const normalizeId = (v) => (v == null ? v : String(v).toUpperCase());
    o.activeRaceId = normalizeId(o.activeRaceId);
    o.inspectedRaceId = normalizeId(o.inspectedRaceId);

    // Races par défaut
    if (!Array.isArray(o.races) || o.races.length === 0) {
        o.races = buildRaceList(o.phase);
    } else {
        o.races = o.races.map(normalizeId);
    }

    // Maps par phase: normalisation (nested only)
    const toPhaseMap = (val, phase) => {
        if (val && typeof val === 'object' && (val.mk8 || val.mkw)) {
            return { mk8: { ...(val.mk8 || {}) }, mkw: { ...(val.mkw || {}) } };
        }
        // sinon flat → on n’importe que sur la phase passée (compat)
        const flat = {};
        if (val && typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) flat[normalizeId(k)] = v;
        }
        return { mk8: phase === 'mk8' ? flat : {}, mkw: phase === 'mkw' ? flat : {} };
    };
    o.statusByRace    = toPhaseMap(input.statusByRace,    o.phase);
    o.finalizedByRace = toPhaseMap(input.finalizedByRace, o.phase);

    // inspected: inspected valide → active valide → première
    if (!o.inspectedRaceId || !o.races.includes(o.inspectedRaceId)) {
        o.inspectedRaceId = (o.activeRaceId && o.races.includes(o.activeRaceId))
            ? o.activeRaceId
            : o.races[0];
    }

    // mémoire sélection par phase
    o.__lastSelectedByPhase = o.__lastSelectedByPhase || { mk8: null, mkw: null };

    return o;
}

function ensureRacesForPhase(state, phaseView) {
    const pv = String(phaseView || '').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
    state.phase = pv;
    state.races = buildRaceList(pv);

    if (state.activeRaceId && !state.races.includes(state.activeRaceId)) state.activeRaceId = null;

    if (!state.inspectedRaceId || !state.races.includes(state.inspectedRaceId)) {
        state.inspectedRaceId = (state.activeRaceId && state.races.includes(state.activeRaceId))
            ? state.activeRaceId
            : state.races[0];
    }
}

export function initRaceStrip(container, options = {}) {
    if (!(container instanceof HTMLElement)) {
        throw new Error('[race-strip] container invalide (HTMLElement requis).');
    }

    let state = normalizeOptions(options);
    let destroyed = false;

    // Vue consultative
    let phaseView = state.phase;
    function getPhaseView() { return phaseView; }
    function setPhaseView(p) {
        const next = (String(p).toLowerCase() === 'mkw') ? 'mkw' : 'mk8';
        if (phaseView === next) return;
        phaseView = next;

        // reset lock d’inspection à chaque vue
        state._inspectLocked = false;

        ensureRacesForPhase(state, phaseView);
        if (typeof state.onPhaseViewChange === 'function') {
            try { state.onPhaseViewChange(phaseView); } catch {}
        }
        render();
    }

    const host = el('div', { class: CLASSNAMES.ROOT, role: 'group', 'aria-label': 'Courses' });
    container.appendChild(host);

    const detachBag = [];

    function render() {
        if (destroyed) return;
        ensureRacesForPhase(state, phaseView);
        renderHeaderNav(host, state, getPhaseView, setPhaseView);
        renderRows(host, state, getPhaseView);
    }

    function setStateAndRender(patch) {
        // ⚠️ Ne pas perdre les handles internes (ex: state.__fb)
        const fbHandle = state && state.__fb;
        state = { ...state, ...(patch || {}) };
        if (fbHandle) state.__fb = fbHandle;
        render();
    }

    function setData(patch = {}) {
        if (!patch || typeof patch !== 'object') return;

        const normPhase = Object.prototype.hasOwnProperty.call(patch, 'phase')
            ? (String(patch.phase).toLowerCase() === 'mkw' ? 'mkw' : 'mk8')
            : null;

        const normalizeId = (v) => (v == null ? v : String(v).toUpperCase());

        const phaseTarget = normPhase || state.phase;

        const nextActive    = Object.prototype.hasOwnProperty.call(patch, 'activeRaceId') ? normalizeId(patch.activeRaceId) : undefined;
        const nextInspected = Object.prototype.hasOwnProperty.call(patch, 'inspectedRaceId') ? normalizeId(patch.inspectedRaceId) : undefined;

        let nextRaces = undefined;
        if (Array.isArray(patch.races)) nextRaces = patch.races.map(normalizeId);

        const mergePhaseMap = (curr, incoming, phase) => {
            const dst = { mk8: { ...(curr?.mk8 || {}) }, mkw: { ...(curr?.mkw || {}) } };
            if (!incoming) return dst;
            if (incoming.mk8 || incoming.mkw) {
                if (incoming.mk8 && typeof incoming.mk8 === 'object') Object.entries(incoming.mk8).forEach(([k, v]) => dst.mk8[normalizeId(k)] = v);
                if (incoming.mkw && typeof incoming.mkw === 'object') Object.entries(incoming.mkw).forEach(([k, v]) => dst.mkw[normalizeId(k)] = v);
            } else if (typeof incoming === 'object') {
                const flat = {};
                Object.entries(incoming).forEach(([k, v]) => flat[normalizeId(k)] = v);
                Object.assign(dst[phase], flat);
            }
            return dst;
        };

        const mergedStatus = mergePhaseMap(state.statusByRace, patch.statusByRace, phaseTarget);
        const mergedFinal  = mergePhaseMap(state.finalizedByRace, patch.finalizedByRace, phaseTarget);

        const merged = {
            ...state,
            ...(patch || {}),
            ...(normPhase ? { phase: normPhase } : {}),
            ...(nextRaces ? { races: nextRaces } : {}),
            ...(nextActive !== undefined ? { activeRaceId: nextActive } : {}),
            ...(nextInspected !== undefined ? { inspectedRaceId: nextInspected } : {}),
            statusByRace: mergedStatus,
            finalizedByRace: mergedFinal
        };

        if (normPhase) merged._phaseLockedByOptions = true;

        // Met à jour l’état sans perdre __fb
        const fbHandle2 = state && state.__fb;
        state = merged;
        if (fbHandle2) state.__fb = fbHandle2;

        if (normPhase) {
            setPhaseView(normPhase);
            return;
        }
        ensureRacesForPhase(state, state.phase);
        render();
    }

    function update(partialOptions = {}) { setData(partialOptions); return api; }

    function destroy() {
        destroyed = true;
        try { state.__fb?.offAll?.(); } catch {}
        try { host.replaceChildren(); } catch {}
        try { host.parentNode && host.parentNode.removeChild(host); } catch {}
        try { state = null; } catch {}
    }

    // Contrôleur Firebase AVANT premier rendu (pour que state.__fb soit prêt)
    if (state.controller === 'firebase') {
        attachFirebaseController(state, getPhaseView, setPhaseView, setStateAndRender);
    }

    // Premier rendu (le contrôleur appellera aussi render via applyMaps)
    render();

    const ready = Promise.resolve();
    const api = { host, ready, destroy, update, setData, setPhaseView, getPhaseView };
    return api;
}
