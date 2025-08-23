// js/admin-dev-autofill.js
//
// Helper DEV autonome : remplit toutes les courses depuis la course courante
//   - pour chaque course sauf la dernière : écrit live/results/{phase}/current/*, finalise (byRace/points/totals), avance context/current
//   - pour la dernière : écrit SEULEMENT live/results/{phase}/current/* (pas de finalisation)
// Objectif : reproduire exactement le flux "manuel" (pilotes -> current -> finalisation).
//
// Dépendances : js/firebase-config.js (exporte dbRealtime, dbFirestore)

import { dbRealtime, dbFirestore } from './firebase-config.js';
import {
    ref, get, set, update, remove
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';
import {
    collection, getDocs, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

/* ======================== Utils ======================== */
const PATH_CONTEXT = 'context/current';
const GRID_SIZE = (phase) => phase === 'mkw' ? 24 : 12;
const $ = (sel, root = document) => root.querySelector(sel);

/* Courses d’une phase */
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

/* Statut d’un set de rangs */
function computeRaceStatusFromResults(results, gridSize) {
    const rankCount = new Map();
    let filled = 0;
    Object.values(results || {}).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            filled++;
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });
    const hasConflict = [...rankCount.values()].some(n => n >= 2);
    if (hasConflict) return 'conflict';
    if (gridSize && filled === Number(gridSize)) return 'complete';
    if (filled > 0) return 'filled';
    return null;
}

/* ========== Firestore : équipes / pilotes ========== */
let cachedTeams = null;
async function fetchTeamsOrdered() {
    if (cachedTeams) return cachedTeams;
    const snap = await getDocs(collection(dbFirestore, 'teams'));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

/* ========== Firestore : matrices de points ========== */
let pointsMatrices = { mk8: null, mkw: null };
async function loadPointsMatrices() {
    if (pointsMatrices.mk8 && pointsMatrices.mkw) return pointsMatrices;
    const mk8Doc = await getDoc(doc(dbFirestore, 'points', 'mk8'));
    pointsMatrices.mk8 = mk8Doc.exists() ? (mk8Doc.data() || {}) : {};
    const mkwDoc = await getDoc(doc(dbFirestore, 'points', 'mkw'));
    pointsMatrices.mkw = mkwDoc.exists() ? (mkwDoc.data() || {}) : {};
    return pointsMatrices;
}
function basePointsFor(phase, raceId, rank) {
    if (phase === 'mk8') {
        const table = pointsMatrices.mk8?.ranks || {};
        return Number(table[String(rank)] ?? 0);
    }
    const row = pointsMatrices.mkw?.ranks?.[String(rank)];
    if (!row) return 0;
    if (raceId === 'S')  return Number(row.s1 ?? 0);
    if (raceId === 'SF') return Number(row.s2 ?? 0);
    return Number(row.race ?? 0);
}

/* ========== Totaux ========== */
async function recomputeTotalsForPhase(phase) {
    const byRaceRoot = await get(ref(dbRealtime, `live/points/${phase}/byRace`));
    const exCosP = await get(ref(dbRealtime, `live/points/${phase}/extras/cosplay/public`));
    const exCosJ = await get(ref(dbRealtime, `live/points/${phase}/extras/cosplay/jury`));
    const exView = await get(ref(dbRealtime, `live/points/${phase}/extras/awards/viewers`));
    const exHost = await get(ref(dbRealtime, `live/points/${phase}/extras/awards/hosts`));

    const totals = {};
    if (byRaceRoot.exists()) {
        const byRace = byRaceRoot.val() || {};
        Object.values(byRace).forEach(raceObj => {
            Object.entries(raceObj || {}).forEach(([pilotId, obj]) => {
                const final = Number(obj?.final ?? 0);
                totals[pilotId] = (totals[pilotId] || 0) + final;
            });
        });
    }
    const cosplayPublic = exCosP.exists() ? exCosP.val() : null;
    const cosplayJury   = exCosJ.exists() ? exCosJ.val() : null;
    const viewers       = exView.exists() ? exView.val() : null;
    const hosts         = exHost.exists() ? exHost.val() : null;

    if (cosplayPublic?.pilotId) totals[cosplayPublic.pilotId] = (totals[cosplayPublic.pilotId] || 0) + 8;
    if (cosplayJury?.pilotId)   totals[cosplayJury.pilotId]   = (totals[cosplayJury.pilotId]   || 0) + 10;
    if (viewers?.pilotId)       totals[viewers.pilotId]       = (totals[viewers.pilotId]       || 0) + 3;
    if (hosts?.pilotId)         totals[hosts.pilotId]         = (totals[hosts.pilotId]         || 0) + 2;

    await set(ref(dbRealtime, `live/points/${phase}/totals`), totals);
}

/* ========== Dev ops : seed, fill, finalize ========== */

/** Active l’autorisation d’écriture current pour tous les pilotes de la phase (pilotsAllowed=true) */
async function seedPilotsAllowed(phase, pilotIds) {
    const updates = {};
    pilotIds.forEach(pid => {
        updates[`meta/pilotsAllowed/${phase}/${pid}`] = true;
    });
    await update(ref(dbRealtime, '/'), updates);
}

/** Écrit les rangs 1..N dans current pour la phase (écrase l’existant) */
async function writeCurrentRanks(phase, orderedPilotIds) {
    await remove(ref(dbRealtime, `live/results/${phase}/current`)).catch(() => {});
    const updates = {};
    orderedPilotIds.forEach((pid, i) => {
        updates[`live/results/${phase}/current/${pid}`] = { rank: i + 1 };
    });
    await update(ref(dbRealtime, '/'), updates);
}

/** Copie current -> byRace/ranks pour une course */
async function copyCurrentToByRace(phase, raceId) {
    const currSnap = await get(ref(dbRealtime, `live/results/${phase}/current`));
    const curr = currSnap.exists() ? (currSnap.val() || {}) : {};
    const status = computeRaceStatusFromResults(curr, GRID_SIZE(phase));
    if (status !== 'complete') throw new Error('current incomplet/incorrect');

    const updates = {};
    Object.entries(curr).forEach(([pid, obj]) => {
        const rank = Number(obj?.rank ?? 0);
        if (rank > 0) {
            updates[`live/results/${phase}/byRace/${raceId}/ranks/${pid}`] = { rank };
        }
    });
    await update(ref(dbRealtime, '/'), updates);
}

/** Calcule points/byRace puis totals pour une course */
async function computePointsForRace(phase, raceId) {
    await loadPointsMatrices();
    const ranksSnap   = await get(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}/ranks`));
    const doublesSnap = await get(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}/doubles`));
    const ranks   = ranksSnap.exists() ? (ranksSnap.val() || {}) : {};
    const doubles = doublesSnap.exists() ? (doublesSnap.val() || {}) : {};

    const updates = {};
    Object.entries(ranks).forEach(([pid, v]) => {
        const rank = Number(v?.rank ?? 0);
        const base = basePointsFor(phase, raceId, rank);
        const doubled = !!doubles[pid];
        const final = base * (doubled ? 2 : 1);
        updates[`live/points/${phase}/byRace/${raceId}/${pid}`] = { rank, base, doubled, final };
    });
    await update(ref(dbRealtime, '/'), updates);
    await recomputeTotalsForPhase(phase);
}

/** Finalise une course (flag + nettoyage current) et avance le contexte */
async function finalizeAndAdvance(phase, raceId, nextRaceIdOrNull) {
    await set(ref(dbRealtime, `live/races/${phase}/${raceId}`), { finalized: true });
    await remove(ref(dbRealtime, `live/results/${phase}/current`)).catch(()=>{});

    if (nextRaceIdOrNull) {
        await update(ref(dbRealtime, PATH_CONTEXT), {
            phase,
            raceId: nextRaceIdOrNull,
            rid: `${phase}-${nextRaceIdOrNull}`
        });
    } else {
        await update(ref(dbRealtime, PATH_CONTEXT), { raceId: null, rid: null });
    }
}

/* ========== Orchestrateur DEV ========== */

/**
 * Lance l’auto-fill :
 *  - récupère phase/race courante depuis context/current (démarre sur la 1re si vide)
 *  - autorise les pilotes (pilotsAllowed)
 *  - pour chaque course :
 *      - écrit current avec 1..N
 *      - si pas la dernière : finalise + avance
 *      - sinon : laisse current rempli (pas de finalisation)
 */
export async function mkDevAutofillRun() {
    try {
        // Contexte
        const ctxSnap = await get(ref(dbRealtime, PATH_CONTEXT));
        const ctx = ctxSnap.exists() ? (ctxSnap.val() || {}) : {};
        const phase = (ctx.phase || 'mk8').toLowerCase();
        const order = buildRaceList(phase);

        let raceId = ctx.raceId ? String(ctx.raceId).toUpperCase() : null;
        if (!raceId || !order.includes(raceId)) {
            raceId = order[0];
            await update(ref(dbRealtime, PATH_CONTEXT), {
                phase,
                raceId,
                rid: `${phase}-${raceId}`
            });
        }

        // Pilotes de la phase (ordre Firestore: équipes puis pilotes)
        const gameLabel = (phase === 'mkw') ? 'MKW' : 'MK8';
        const [teams, pilots] = await Promise.all([fetchTeamsOrdered(), fetchPilotsByGameOrdered(gameLabel)]);
        const pilotIds = pilots.map(p => p.id).slice(0, GRID_SIZE(phase));
        if (pilotIds.length < GRID_SIZE(phase)) {
            throw new Error(`Pilotes insuffisants pour ${phase.toUpperCase()} (${pilotIds.length}/${GRID_SIZE(phase)}).`);
        }

        // Autoriser les écritures "current" pour tous ces pilotes
        await seedPilotsAllowed(phase, pilotIds);

        const startIx = Math.max(0, order.indexOf(raceId));
        const lastIx  = order.length - 1;

        for (let i = startIx; i <= lastIx; i++) {
            const id = order[i];

            // 1) current = 1..N
            await writeCurrentRanks(phase, pilotIds);

            if (i < lastIx) {
                // 2) copie current -> byRace/ranks
                await copyCurrentToByRace(phase, id);

                // 3) points + totals
                await computePointsForRace(phase, id);

                // 4) finalize + advance
                const nextId = order[i + 1];
                await finalizeAndAdvance(phase, id, nextId);
            } else {
                // Dernière : laisser current rempli, sans finaliser (pour test manuel)
                await update(ref(dbRealtime, PATH_CONTEXT), {
                    phase,
                    raceId: id,
                    rid: `${phase}-${id}`
                });
            }
        }

        console.info('[DEV] Auto-fill terminé (dernière course non finalisée).');
    } catch (err) {
        console.error('[DEV] Auto-fill échec:', err);
        throw err;
    }
}

/* ========== Hook bouton optionnel (admin) ========== */
// Si un bouton #dev-autofill-run est présent dans la page admin, on s’y branche.
document.addEventListener('DOMContentLoaded', () => {
    const btn = $('#dev-autofill-run');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'DEV • En cours...';
        try {
            await mkDevAutofillRun();
            btn.textContent = 'DEV • Terminé ✔';
        } catch {
            btn.textContent = 'DEV • Échec ✖';
        } finally {
            setTimeout(() => {
                btn.textContent = 'DEV • Auto-fill';
                btn.disabled = false;
            }, 1400);
        }
    });
});

// Expose en global si besoin (console / autres scripts)
window.mkDevAutofillRun = mkDevAutofillRun;
