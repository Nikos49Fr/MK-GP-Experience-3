/**
 * Race Strip — composant autonome (MK GP Experience 3)
 * ----------------------------------------------------
 * Bandeau de tuiles représentant les courses d'une phase (MK8/MKW).
 *
 * Modes de contrôle:
 *  - controller: 'external'  → l’hôte pousse les données via setData/update.
 *  - controller: 'firebase'  → le composant se branche à Firebase, calcule les statuts, gère la finalisation.
 *
 * API (factory):
 *  export function initRaceStrip(container, options = {}) -> {
 *      host, ready, destroy, update, setData,
 *      setPhaseView(phase), getPhaseView()
 *  }
 */

/* ========================================================================== */
/* Imports (facultatifs, lazy dans controller Firebase)                        */
/* ========================================================================== */
// NOTE: Pas d’import direct ici. En mode 'firebase', on fera des imports dynamiques
// dans attachFirebaseController() pour éviter d’imposer Firebase aux intégrations externes.

/* ========================================================================== */
/* Constantes, classes, options par défaut                                     */
/* ========================================================================== */

const DEFAULTS = Object.freeze({
    controller: 'external',           // 'external' | 'firebase'
    mode: 'simple',                   // 'simple' | 'admin'
    phase: 'mk8',                     // vue locale initiale
    races: null,                      // si null → déduit de phase
    activeRaceId: null,               // course "courante" globale (info affichage)
    inspectedRaceId: null,            // sélection de vue
    statusByRace: {},                 // map { raceId: 'filled'|'conflict'|'complete'|'activeEmpty'|null }
    finalizedByRace: {},              // map { raceId: boolean }
    onSelect: null,                   // (raceId)=>void
    onFinalize: null,                 // async (raceId)=>void (utilisé en controller 'external')
    showPhaseNav: false,              // nav consultative MK8 ⇄ MKW intégrée
    onPhaseViewChange: null           // (phase)=>void — notification côté hôte
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
        COMPLETE_PENDING: 'is-complete-pending',
        COMPLETE_FINAL: 'is-complete-final'
    }
});

/* ========================================================================== */
/* Utilitaires DOM basiques                                                    */
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
/* Helpers “données”                                                           */
/* ========================================================================== */

function buildDefaultRaces(phase) {
    const p = String(phase || '').toLowerCase();
    if (p === 'mkw') {
        const arr = [];
        for (let i = 1; i <= 6; i++) arr.push(String(i)); // 1..6
        arr.push('S');                                    // Survie 1
        for (let i = 7; i <= 12; i++) arr.push(String(i)); // 7..12
        arr.push('SF');                                   // Survie Finale
        return arr;
    }
    // MK8 : 1..8
    return Array.from({ length: 8 }, (_, i) => String(i + 1));
}

function GRID_SIZE(phase) {
    const p = String(phase || '').toLowerCase();
    return p === 'mkw' ? 24 : 12;
}

function normalizeOptions(opts) {
    const input = opts || {};
    const o = { ...DEFAULTS, ...input };

    // Phase normalisée
    const phaseKey = String(o.phase || 'mk8').toLowerCase();
    o.phase = (phaseKey === 'mkw') ? 'mkw' : 'mk8';

    // Flag interne : la phase a-t-elle été fournie explicitement par l'hôte ?
    // (utile pour ne pas écraser la vue avec context/current tant que l’hôte force une phase)
    o._phaseLockedByOptions = Object.prototype.hasOwnProperty.call(input, 'phase');

    // Normalisation des ids → 'S'/'SF' en uppercase
    const normalizeId = (v) => (v == null ? v : String(v).toUpperCase());

    o.activeRaceId = normalizeId(o.activeRaceId);
    o.inspectedRaceId = normalizeId(o.inspectedRaceId);

    // Races par défaut si non fournies
    if (!Array.isArray(o.races) || o.races.length === 0) {
        o.races = buildDefaultRaces(o.phase);
    } else {
        o.races = o.races.map(normalizeId);
    }

    // status/finalized → maps propres (copie superficielle)
    o.statusByRace = { ...(o.statusByRace || {}) };
    o.finalizedByRace = { ...(o.finalizedByRace || {}) };

    // inspectedRaceId prioritaire: inspected valide → sinon active si valide → sinon 1ère
    if (!o.inspectedRaceId || !o.races.includes(o.inspectedRaceId)) {
        o.inspectedRaceId = (o.activeRaceId && o.races.includes(o.activeRaceId))
            ? o.activeRaceId
            : o.races[0];
    }

    return o;
}

function computeRaceStatusFromResults(results, gridSize) {
    if (!results || typeof results !== 'object') return null;

    let filledCount = 0;
    const rankCount = new Map();

    for (const obj of Object.values(results)) {
        const r = Number(obj?.rank);
        if (Number.isInteger(r) && r > 0) {
            filledCount++;
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    }

    // Conflits : au moins deux pilotes avec le même rang
    const hasConflict = [...rankCount.values()].some(n => n >= 2);
    if (hasConflict) return 'conflict';

    // Complète : toutes les places sont remplies
    if (gridSize && filledCount === gridSize) return 'complete';

    // Partiellement remplie
    if (filledCount > 0) return 'filled';

    // Vide
    return null;
}

/* ========================================================================== */
/* Rendu & interactions                                                        */
/* ========================================================================== */

function computeLayout(phaseView) {
    const p = String(phaseView || '').toLowerCase();
    if (p === 'mkw') {
        // Deux lignes: 6 courses, Survie 1, puis 6 courses, Survie Finale
        // IDs BDD conservés: '1'..'6','S','7'..'12','SF'
        return [
            ['1','2','3','4','5','6','S'],
            ['7','8','9','10','11','12','SF']
        ];
    }
    // MK8 : une ligne 1..8
    return [['1','2','3','4','5','6','7','8']];
}

function ensureRacesForPhase(state, phaseView) {
    const pv = String(phaseView || '').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
    state.phase = pv;

    // Liste de courses standardisée selon la vue
    const races = buildDefaultRaces(pv);
    state.races = races;

    // Active: ne garder que si elle existe encore dans cette vue
    if (state.activeRaceId && !races.includes(state.activeRaceId)) {
        state.activeRaceId = null;
    }

    // Inspected: priorité à l’existante valide → sinon active → sinon 1ère
    if (!state.inspectedRaceId || !races.includes(state.inspectedRaceId)) {
        state.inspectedRaceId = (state.activeRaceId && races.includes(state.activeRaceId))
            ? state.activeRaceId
            : races[0];
    }
}

function renderHeaderNav(host, state, getPhaseView, setPhaseView) {
    // Nettoyer la nav si option désactivée
    if (!state.showPhaseNav) {
        const old = host.querySelector(`.${CLASSNAMES.NAV}`);
        if (old) old.remove();
        return;
    }

    // Créer ou réutiliser le conteneur
    let $nav = host.querySelector(`.${CLASSNAMES.NAV}`);
    if (!$nav) {
        $nav = el('div', {
            class: CLASSNAMES.NAV,
            role: 'toolbar',
            'aria-label': 'Navigation de phase'
        });
        host.prepend($nav);
    } else {
        $nav.replaceChildren();
    }

    const current = String(getPhaseView() || 'mk8').toLowerCase();
    const $btnPrev = el('button', {
        class: CLASSNAMES.NAV_BTN,
        type: 'button',
        'aria-label': 'Phase précédente'
    }, '‹');

    const $label = el('div', { class: CLASSNAMES.NAV_LABEL }, current.toUpperCase());

    const $btnNext = el('button', {
        class: CLASSNAMES.NAV_BTN,
        type: 'button',
        'aria-label': 'Phase suivante'
    }, '›');

    // Logique simple : alterne entre mk8 et mkw
    const togglePhase = () => {
        const next = (current === 'mk8') ? 'mkw' : 'mk8';
        setPhaseView(next);
    };

    $btnPrev.addEventListener('click', togglePhase);
    $btnNext.addEventListener('click', togglePhase);

    $nav.append($btnPrev, $label, $btnNext);
}

function renderRows(host, state, getPhaseView) {
    const phaseView = String(getPhaseView() || 'mk8').toLowerCase();
    const rows = computeLayout(phaseView);

    // Construit un inner neuf pour remplacer l'ancien (supprime les anciens listeners)
    const inner = el('div', { class: CLASSNAMES.INNER });

    rows.forEach((raceIds, rowIdx) => {
        const $row = el('div', { class: CLASSNAMES.ROW, 'data-row': String(rowIdx + 1) });

        raceIds.forEach((raceId) => {
            const status = state.statusByRace?.[raceId] ?? null;
            const finalized = !!state.finalizedByRace?.[raceId];

            // Libellé affiché : en MKW, on montre 8..13 pour les IDs 7..12 (BDD intacte)
            let label = raceId;
            if (phaseView === 'mkw') {
                const n = Number(raceId);
                if (Number.isInteger(n) && n >= 7 && n <= 12) {
                    label = String(n + 1); // affichage décalé
                }
            }

            // Tuile (bouton)
            const $btn = el('button', {
                class: CLASSNAMES.TILE,
                type: 'button',
                'data-race-id': raceId,
                'aria-pressed': state.inspectedRaceId === raceId ? 'true' : 'false',
                'aria-label': `Course ${label} (${phaseView.toUpperCase()})`
            }, label);

            // États visuels
            if (state.inspectedRaceId === raceId) $btn.classList.add(CLASSNAMES.STATE.INSPECTED);
            if (state.activeRaceId === raceId)    $btn.classList.add(CLASSNAMES.STATE.ACTIVE);

            if (status === 'conflict') {
                $btn.classList.add(CLASSNAMES.STATE.CONFLICT);
            } else if (status === 'filled') {
                $btn.classList.add(CLASSNAMES.STATE.FILLED);
            } else if (status === 'activeEmpty') {
                $btn.classList.add(CLASSNAMES.STATE.ACTIVE_EMPTY);
            } else if (status === 'complete') {
                // Distinction pending/final
                if (finalized) $btn.classList.add(CLASSNAMES.STATE.COMPLETE_FINAL);
                else           $btn.classList.add(CLASSNAMES.STATE.COMPLETE_PENDING);
            }

            // Clic = inspect
            $btn.addEventListener('click', () => {
                if (state.inspectedRaceId !== raceId) {
                    state.inspectedRaceId = raceId;
                    if (typeof state.onSelect === 'function') {
                        try { state.onSelect(raceId); } catch (e) { console.error(e); }
                    }
                    // micro-maj locales
                    inner.querySelectorAll(`.${CLASSNAMES.TILE}`).forEach(t => {
                        const isMe = t.dataset.raceId === raceId;
                        t.classList.toggle(CLASSNAMES.STATE.INSPECTED, isMe);
                        t.setAttribute('aria-pressed', isMe ? 'true' : 'false');
                    });
                }
            });

            // Cellule + bouton Finaliser (si mode admin)
            const $cellChildren = [$btn];
            if (state.mode === 'admin') {
                const $finalize = el('button', {
                    class: CLASSNAMES.FINALIZE,
                    type: 'button',
                    title: finalized ? 'Course déjà finalisée' : 'Finaliser la course'
                }, finalized ? '✔' : '✓');

                // Règle d'activation selon le contrôleur
                let can = false;
                if (state.controller === 'firebase') {
                    // s'appuie sur la logique interne de statut/finalisation
                    can = canFinalizeFirebase(state, raceId);
                } else {
                    // contrôleur 'external' : simple heuristique
                    can = (status === 'complete' && finalized !== true);
                }

                if (!can) {
                    $finalize.disabled = true;
                    $finalize.setAttribute('aria-disabled', 'true');
                }

                $finalize.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    if ($finalize.disabled) return;

                    try {
                        $finalize.disabled = true;
                        $finalize.setAttribute('aria-busy', 'true');

                        if (state.controller === 'firebase' && state.__fb?.runFinalize) {
                            await state.__fb.runFinalize(raceId);
                        } else if (typeof state.onFinalize === 'function') {
                            await state.onFinalize(raceId);
                            // En mode external, on laisse l'hôte pousser la mise à jour via setData()
                        }
                    } catch (e) {
                        console.error('[race-strip] finalize error:', e);
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

    // Remplace l’inner existant
    const currentInner = host.querySelector(`.${CLASSNAMES.INNER}`);
    if (currentInner) host.replaceChild(inner, currentInner);
    else host.appendChild(inner);
}

function attachEventHandlers(host, state) {
    // No-op volontaire :
    // - Pas de navigation clavier requise pour ce composant.
    // - Les listeners click sont déjà attachés au moment du rendu des tiles.
    // - On garde cette fonction pour une éventuelle extension future (tooltips, etc.).
}

function detachHandlers(detachBag) {
    if (Array.isArray(detachBag)) {
        detachBag.forEach(fn => { try { fn(); } catch {} });
        detachBag.length = 0;
    }
}

/* ========================================================================== */
/* Contrôleur Firebase                                                         */
/* ========================================================================== */

function getActiveRaceIdForPhase(context, caches, phase) {
    const p = String(phase || '').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
    const order = buildDefaultRaces(p);
    const finals = (caches && caches.races && caches.races[p]) ? caches.races[p] : {};

    // 1) Si le context pointe explicitement cette phase avec une raceId valide → priorité
    if (context && String(context.phase).toLowerCase() === p) {
        const rid = context.raceId != null ? String(context.raceId).toUpperCase() : null;
        if (rid && order.includes(rid)) {
            return rid;
        }
        // sinon heuristique ci-dessous
    }

    // 2) Heuristique pré/pendant/après phase :
    for (const rid of order) {
        const f = finals && finals[rid];
        const isFinalized = !!(f && f.finalized);
        if (!isFinalized) return rid; // première non finalisée
    }

    // 3) Tout finalisé → dernière (inclut la finale)
    return order[order.length - 1];
}

function computeMapsForPhase(context, caches, phase) {
    const p = String(phase || '').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
    const order = buildDefaultRaces(p);
    const gridSize = GRID_SIZE(p);

    const activeId = getActiveRaceIdForPhase(context, caches, p);
    const statusByRace = {};
    const finalizedByRace = {};

    const finalsTree   = (caches && caches.races && caches.races[p]) || {};
    const currentTree  = (caches && caches.currentResults && caches.currentResults[p]) || {};
    const byRaceTree   = (caches && caches.byRace && caches.byRace[p]) || {};

    order.forEach((raceId) => {
        // finalized map
        finalizedByRace[raceId] = !!(finalsTree[raceId] && finalsTree[raceId].finalized);

        let status = null;

        // Course active du context → lire "current"
        if (context && String(context.phase).toLowerCase() === p && String(context.raceId || '').toUpperCase() === raceId) {
            const hasAnyCurrent = Object.values(currentTree || {}).some(v => v && v.rank != null);
            if (!hasAnyCurrent) {
                status = 'activeEmpty';
            } else {
                status = computeRaceStatusFromResults(currentTree, gridSize) || 'filled';
            }
        } else {
            // Sinon lire byRace/ranks
            const ranks = (byRaceTree[raceId] && byRaceTree[raceId].ranks) || {};
            const hasAny = Object.values(ranks).some(v => v && v.rank != null);
            if (hasAny) {
                status = computeRaceStatusFromResults(ranks, gridSize) || 'filled';
            } else {
                status = null;
            }
        }

        statusByRace[raceId] = status;
    });

    return { activeId, statusByRace, finalizedByRace };
}

async function loadPointsMatrices(fb, pointsMatrices) {
    // Charge une seule fois les matrices depuis Firestore (pointMatrices/default).
    if (pointsMatrices.__loaded) return;
    const docRef = fb.doc(fb.dbFirestore, 'pointMatrices', 'default');
    arequire(docRef); // évite l’avertissement de variable non utilisée si bundler strict
    const snap = await fb.getDoc(docRef);
    const data = snap.exists() ? (snap.data() || {}) : {};

    pointsMatrices.mk8 = Array.isArray(data.mk8) ? data.mk8 : [];
    pointsMatrices.mkwRace = Array.isArray(data.mkwRace) ? data.mkwRace : [];
    pointsMatrices.mkwSurvival1 = Array.isArray(data.mkwSurvival1) ? data.mkwSurvival1 : [];
    pointsMatrices.mkwSurvival2 = Array.isArray(data.mkwSurvival2) ? data.mkwSurvival2 : [];
    pointsMatrices.__loaded = true;

    function arequire(_) {}
}

function basePointsFor(pointsMatrices, phase, raceId, rank) {
    // Retourne les points de base pour un rank (1-indexé).
    const r = Number(rank);
    if (!Number.isInteger(r) || r <= 0) return 0;

    if (phase === 'mk8') {
        // mk8: tableau 12 cases indexées [0..11]
        return Number(pointsMatrices.mk8?.[r - 1] ?? 0);
    }

    // MKW: selon type de course
    if (raceId === 'S') {
        return Number(pointsMatrices.mkwSurvival1?.[r - 1] ?? 0);
    }
    if (raceId === 'SF') {
        return Number(pointsMatrices.mkwSurvival2?.[r - 1] ?? 0);
    }
    // Courses "classiques" MKW
    return Number(pointsMatrices.mkwRace?.[r - 1] ?? 0);
}

function canFinalizeFirebase(state, raceId) {
    const st = state.statusByRace?.[raceId];
    const isFinal = !!state.finalizedByRace?.[raceId];
    return (st === 'complete' && !isFinal);
}

async function recomputeTotalsForPhase(fb, phase) {
    // Recalcule live/points/{phase}/totals à partir de byRace + extras (cosplay/awards)
    const totals = {};

    // Agrège byRace
    const byRaceSnap = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/byRace`));
    if (byRaceSnap.exists()) {
        const byRace = byRaceSnap.val() || {};
        Object.values(byRace).forEach((raceObj) => {
            Object.entries(raceObj || {}).forEach(([pilotId, obj]) => {
                const val = Number(obj?.final ?? 0);
                totals[pilotId] = (totals[pilotId] || 0) + val;
            });
        });
    }

    // Extras
    const cosplayPublicSnap = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/cosplay/public`));
    const cosplayJurySnap   = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/cosplay/jury`));
    const viewersSnap       = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/awards/viewers`));
    const hostsSnap         = await fb.get(fb.ref(fb.dbRealtime, `live/points/${phase}/extras/awards/hosts`));

    const cosplayPublic = cosplayPublicSnap.exists() ? cosplayPublicSnap.val() : null;
    const cosplayJury   = cosplayJurySnap.exists()   ? cosplayJurySnap.val()   : null;
    const viewers       = viewersSnap.exists()       ? viewersSnap.val()       : null;
    const hosts         = hostsSnap.exists()         ? hostsSnap.val()         : null;

    if (cosplayPublic?.pilotId) totals[cosplayPublic.pilotId] = (totals[cosplayPublic.pilotId] || 0) + 8;
    if (cosplayJury?.pilotId)   totals[cosplayJury.pilotId]   = (totals[cosplayJury.pilotId]   || 0) + 10;
    if (viewers?.pilotId)       totals[viewers.pilotId]       = (totals[viewers.pilotId]       || 0) + 3;
    if (hosts?.pilotId)         totals[hosts.pilotId]         = (totals[hosts.pilotId]         || 0) + 2;

    await fb.set(fb.ref(fb.dbRealtime, `live/points/${phase}/totals`), totals);
}

async function finalizeRaceFirebase(fb, context, caches, pointsMatrices, state, raceId, setStateAndRender) {
    // Finalise une course: copie ranks, calcule points, met à jour totals et flags, avance context si nécessaire.
    if (!raceId) throw new Error('raceId manquant.');
    const phase = state.phase;
    const grid  = GRID_SIZE(phase);

    // Matrices points (lazy load)
    await loadPointsMatrices(fb, pointsMatrices);

    // Course active ?
    const isActivePhase = (context && String(context.phase).toLowerCase() === phase);
    const activeId = getActiveRaceIdForPhase(context, caches, phase);
    const useCurrent = isActivePhase && (activeId === raceId);

    // 1) S'assurer que la course est complète et sans conflit
    let ranksSource = null;
    if (useCurrent) {
        const status = computeRaceStatusFromResults(caches.currentResults?.[phase] || {}, grid);
        if (status !== 'complete') throw new Error('Classements incomplets/invalides (current).');
        ranksSource = caches.currentResults?.[phase] || {};
    } else {
        const ranksNodeSnap = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`));
        const ranksNode = ranksNodeSnap.exists() ? (ranksNodeSnap.val() || {}) : {};
        const status = computeRaceStatusFromResults(ranksNode, grid);
        if (status !== 'complete') throw new Error('Classements incomplets/invalides (byRace).');
        ranksSource = ranksNode;
    }

    // 2) Si course active: copier current → byRace/ranks
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

    // 3) Calculer points byRace
    const ranksSnap = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`));
    const doublesSnap = await fb.get(fb.ref(fb.dbRealtime, `live/results/${phase}/byRace/${raceId}/doubles`));
    const ranks = ranksSnap.exists() ? (ranksSnap.val() || {}) : {};
    const doubles = doublesSnap.exists() ? (doublesSnap.val() || {}) : {};

    const pointsUpdates = {};
    Object.entries(ranks).forEach(([pilotId, v]) => {
        const rank = Number(v?.rank ?? 0);
        const base = basePointsFor(pointsMatrices, phase, raceId, rank);
        const doubled = !!doubles[pilotId];
        const final = base * (doubled ? 2 : 1);
        pointsUpdates[`live/points/${phase}/byRace/${raceId}/${pilotId}`] = { rank, base, doubled, final };
    });
    if (Object.keys(pointsUpdates).length) {
        await fb.update(fb.ref(fb.dbRealtime, '/'), pointsUpdates);
    }

    // 4) Totaux phase
    await recomputeTotalsForPhase(fb, phase);

    // 5) Marquer course finalisée
    await fb.set(fb.ref(fb.dbRealtime, `live/races/${phase}/${raceId}`), { finalized: true });

    // 6) Si active: nettoyer current et avancer context/current
    if (useCurrent) {
        await fb.remove(fb.ref(fb.dbRealtime, `live/results/${phase}/current`)).catch(()=>{});
        const order = buildDefaultRaces(phase);
        const idx   = order.indexOf(raceId);
        const next  = (idx >= 0 && idx < order.length - 1) ? order[idx + 1] : null;
        if (next) {
            await fb.update(fb.ref(fb.dbRealtime, `context/current`), {
                phase, raceId: next, rid: `${phase}-${next}`
            });
            // Mise à jour locale de la sélection
            state.inspectedRaceId = next;
        } else {
            // Fin de phase : on garde la dernière, on nettoie raceId
            await fb.update(fb.ref(fb.dbRealtime, `context/current`), {
                phase, raceId: null, rid: null
            });
        }
    }

    // 7) Refresh local via caches → maps → render
    const maps = computeMapsForPhase(context, caches, phase);
    setStateAndRender({
        activeRaceId: maps.activeId,
        statusByRace: maps.statusByRace,
        finalizedByRace: maps.finalizedByRace
    });
}

function attachFirebaseController(state, getPhaseView, setPhaseView, setStateAndRender) {
    // --- Flags & caches internes ---
    let fb = null; // { dbRealtime, dbFirestore, ref, onValue, off, get, set, update, remove, doc, getDoc }
    let context = null; // snapshot de context/current
    let userPhaseOverridden = false; // l’utilisateur a changé la vue via la nav du composant
    const unsub = { context: null, current: null, byRace: null, races: null, phaseKey: null };

    // Caches pour calculer les maps sans relire tout à chaque fois
    const caches = {
        currentResults: { mk8: {}, mkw: {} }, // live/results/{phase}/current
        byRace:         { mk8: {}, mkw: {} }, // live/results/{phase}/byRace
        races:          { mk8: {}, mkw: {} }  // live/races/{phase}/{raceId}: { finalized }
    };

    // Matrices de points Firestore (lazy-loaded)
    const pointsMatrices = { mk8: null, mkwRace: null, mkwSurvival1: null, mkwSurvival2: null, __loaded: false };

    // Intercepter les changements de phase vue (provenant de la nav du composant)
    // pour ne plus écraser la vue utilisateur quand le contexte change.
    const originalOnPhaseViewChange = state.onPhaseViewChange;
    state.onPhaseViewChange = (phase) => {
        userPhaseOverridden = true;
        // (ré)attacher les listeners sur la phase choisie
        ensurePhaseListeners(phase);
        // recalc + render immédiat
        const maps = computeMapsForPhase(context, caches, phase);
        setStateAndRender({
            phase,
            activeRaceId: maps.activeId,
            statusByRace: maps.statusByRace,
            finalizedByRace: maps.finalizedByRace
        });
        if (typeof originalOnPhaseViewChange === 'function') {
            try { originalOnPhaseViewChange(phase); } catch {}
        }
    };

    // Expose l’action de finalisation pour renderRows()
    state.__fb = {
        runFinalize: async (raceId) => {
            if (!fb) throw new Error('Firebase non initialisé.');
            await finalizeRaceFirebase(fb, context, caches, pointsMatrices, state, raceId, setStateAndRender);
        },
        offAll: () => {
            // Detach listeners si attachés
            try {
                const p = unsub.phaseKey;
                if (p && fb) {
                    if (unsub.current)  fb.off(fb.ref(fb.dbRealtime, `live/results/${p}/current`), 'value', unsub.current);
                    if (unsub.byRace)   fb.off(fb.ref(fb.dbRealtime, `live/results/${p}/byRace`),  'value', unsub.byRace);
                    if (unsub.races)    fb.off(fb.ref(fb.dbRealtime, `live/races/${p}`),           'value', unsub.races);
                }
                if (unsub.context && fb) {
                    fb.off(fb.ref(fb.dbRealtime, 'context/current'), 'value', unsub.context);
                }
            } catch {}
        }
    };

    // Import dynamique + bootstrap des listeners
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

            // Listener principal: context/current
            const ctxRef = ref(dbRealtime, 'context/current');
            unsub.context = (snap) => {
                context = snap.val() || null;

                // Par défaut, on suit la phase du context tant que l’utilisateur n’a pas “forcé” une vue
                if (!userPhaseOverridden) {
                    const nextPhase = (context?.phase || 'mk8').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';
                    if (getPhaseView() !== nextPhase) {
                        setPhaseView(nextPhase);
                        return; // render sera fait par setPhaseView()
                    }
                }

                // (Ré)attacher les listeners pour la phase visible actuelle
                ensurePhaseListeners(getPhaseView());

                // Recalcul immédiat sur changement de contexte (même si la vue n’a pas changé)
                const maps = computeMapsForPhase(context, caches, state.phase);
                setStateAndRender({
                    activeRaceId: maps.activeId,
                    statusByRace: maps.statusByRace,
                    finalizedByRace: maps.finalizedByRace
                });
            };
            onValue(ctxRef, unsub.context);

            // Premier attach selon la vue initiale
            ensurePhaseListeners(getPhaseView());

            // Premier recalc
            const maps = computeMapsForPhase(context, caches, state.phase);
            setStateAndRender({
                activeRaceId: maps.activeId,
                statusByRace: maps.statusByRace,
                finalizedByRace: maps.finalizedByRace
            });

        } catch (err) {
            console.error('[race-strip] Firebase init error:', err);
        }
    })();

    // Attache les listeners RTDB pour la phase donnée, en nettoyant l’ancienne phase
    function ensurePhaseListeners(phaseLike) {
        if (!fb) return;
        const p = String(phaseLike || '').toLowerCase() === 'mkw' ? 'mkw' : 'mk8';

        // Si on change de phase, détacher les anciens
        if (unsub.phaseKey && unsub.phaseKey !== p) {
            try {
                if (unsub.current)  fb.off(fb.ref(fb.dbRealtime, `live/results/${unsub.phaseKey}/current`), 'value', unsub.current);
                if (unsub.byRace)   fb.off(fb.ref(fb.dbRealtime, `live/results/${unsub.phaseKey}/byRace`),  'value', unsub.byRace);
                if (unsub.races)    fb.off(fb.ref(fb.dbRealtime, `live/races/${unsub.phaseKey}`),           'value', unsub.races);
            } catch {}
            unsub.current = unsub.byRace = unsub.races = null;
        }

        unsub.phaseKey = p;

        // current
        const rCurrent = fb.ref(fb.dbRealtime, `live/results/${p}/current`);
        unsub.current = (s) => {
            caches.currentResults[p] = s.val() || {};
            const maps = computeMapsForPhase(context, caches, state.phase);
            setStateAndRender({
                activeRaceId: maps.activeId,
                statusByRace: maps.statusByRace,
                finalizedByRace: maps.finalizedByRace
            });
        };
        fb.onValue(rCurrent, unsub.current);

        // byRace
        const rByRace = fb.ref(fb.dbRealtime, `live/results/${p}/byRace`);
        unsub.byRace = (s) => {
            caches.byRace[p] = s.val() || {};
            const maps = computeMapsForPhase(context, caches, state.phase);
            setStateAndRender({
                activeRaceId: maps.activeId,
                statusByRace: maps.statusByRace,
                finalizedByRace: maps.finalizedByRace
            });
        };
        fb.onValue(rByRace, unsub.byRace);

        // races (finalized)
        const rRaces = fb.ref(fb.dbRealtime, `live/races/${p}`);
        unsub.races = (s) => {
            caches.races[p] = s.val() || {};
            const maps = computeMapsForPhase(context, caches, state.phase);
            setStateAndRender({
                activeRaceId: maps.activeId,
                statusByRace: maps.statusByRace,
                finalizedByRace: maps.finalizedByRace
            });
        };
        fb.onValue(rRaces, unsub.races);
    }
}

/* ========================================================================== */
/* Factory: initRaceStrip                                                      */
/* ========================================================================== */

export function initRaceStrip(container, options = {}) {
    if (!(container instanceof HTMLElement)) {
        throw new Error('[race-strip] container invalide (HTMLElement requis).');
    }

    // État interne minimal
    let state = normalizeOptions(options);
    let destroyed = false;

    // Vue de phase consultative (décorrélée du context Firebase)
    let phaseView = state.phase; // 'mk8' | 'mkw'
    function getPhaseView() { return phaseView; }
    function setPhaseView(p) {
        const next = (String(p).toLowerCase() === 'mkw') ? 'mkw' : 'mk8';
        if (phaseView === next) return;
        phaseView = next;
        ensureRacesForPhase(state, phaseView);
        if (typeof state.onPhaseViewChange === 'function') {
            try { state.onPhaseViewChange(phaseView); } catch {}
        }
        render(); // re-render consultatif
    }

    // Hôte du composant
    const host = el('div', { class: CLASSNAMES.ROOT, role: 'group', 'aria-label': 'Courses' });
    container.appendChild(host);

    // Sac de détachement (listeners, observers…)
    const detachBag = [];

    function render() {
        if (destroyed) return;
        // 1) recalcul “races” pour la phase courante
        ensureRacesForPhase(state, phaseView);

        // 2) header nav (optionnel)
        renderHeaderNav(host, state, getPhaseView, setPhaseView);

        // 3) lignes & cellules
        renderRows(host, state, getPhaseView);

        // 4) handlers additionnels si besoin
        attachEventHandlers(host, state);
    }

    function setStateAndRender(patch) {
        // Utilitaire interne pour le contrôleur Firebase (et autres)
        state = { ...state, ...(patch || {}) };
        render();
    }

    function setData(patch = {}) {
        if (!patch || typeof patch !== 'object') return;

        // Normalisation légère du patch
        const normPhase = Object.prototype.hasOwnProperty.call(patch, 'phase')
            ? (String(patch.phase).toLowerCase() === 'mkw' ? 'mkw' : 'mk8')
            : null;

        const normalizeId = (v) => (v == null ? v : String(v).toUpperCase());

        // Normaliser IDs simples
        const nextActive    = normalizeId(patch.activeRaceId);
        const nextInspected = normalizeId(patch.inspectedRaceId);

        // Normaliser races si fournies
        let nextRaces = undefined;
        if (Array.isArray(patch.races)) {
            nextRaces = patch.races.map(normalizeId);
        }

        // Normaliser maps status/finalized (clés en IDs uppercased)
        const nextStatus = {};
        if (patch.statusByRace && typeof patch.statusByRace === 'object') {
            for (const [k, v] of Object.entries(patch.statusByRace)) {
                nextStatus[normalizeId(k)] = v;
            }
        }
        const nextFinalized = {};
        if (patch.finalizedByRace && typeof patch.finalizedByRace === 'object') {
            for (const [k, v] of Object.entries(patch.finalizedByRace)) {
                nextFinalized[normalizeId(k)] = !!v;
            }
        }

        // Fusion contrôlée
        const merged = {
            ...state,
            ...(patch || {}),
            ...(normPhase ? { phase: normPhase } : {}),
            ...(nextRaces ? { races: nextRaces } : {}),
            ...(nextActive !== undefined ? { activeRaceId: nextActive } : {}),
            ...(nextInspected !== undefined ? { inspectedRaceId: nextInspected } : {}),
            statusByRace: { ...state.statusByRace, ...nextStatus },
            finalizedByRace: { ...state.finalizedByRace, ...nextFinalized }
        };

        // Si la phase est passée par patch, on considère que l’hôte force la vue
        if (normPhase) {
            merged._phaseLockedByOptions = true;
        }

        // Met à jour l’état
        state = merged;

        // Si on reçoit une phase dans le patch, on synchronise la vue consultative
        if (normPhase) {
            setPhaseView(normPhase);
            return;
        }

        // Sinon, on s’assure que races/inspected sont cohérents, puis on rend
        ensureRacesForPhase(state, state.phase);
        render();
    }

    function update(partialOptions = {}) {
        // Permet de mettre à jour l’instance (callbacks, mode, phase, maps…)
        // Retourne l’API pour chaîner: api.update(...).update(...)
        setData(partialOptions);
        return api;
    }

    function destroy() {
        // Marque le composant comme démonté
        destroyed = true;

        // Détache tous les listeners internes connus (nav/inner, etc.)
        try { detachHandlers(detachBag); } catch {}

        // Détache les listeners Firebase si présents
        try { state.__fb?.offAll?.(); } catch {}

        // Vide et retire le host du DOM
        try { host.replaceChildren(); } catch {}
        try { host.parentNode && host.parentNode.removeChild(host); } catch {}

        // Optionnel: libérer quelques refs
        try { state = null; } catch {}
    }

    // Rendu initial
    render();

    // Contrôleur Firebase (optionnel)
    if (state.controller === 'firebase') {
        attachFirebaseController(state, getPhaseView, setPhaseView, setStateAndRender);
    }

    const ready = Promise.resolve();

    const api = {
        host, ready, destroy, update, setData,
        setPhaseView, getPhaseView
    };
    return api;
}
