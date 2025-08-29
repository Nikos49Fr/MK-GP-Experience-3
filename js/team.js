/**
 * MK GP Experience 3 — RTDB schema (PROD)
 *
 * PHASE  : "mk8" | "mkw"
 * RACE   : "1".."12" | "S" | "SF"
 * PILOT  : id Firestore
 *
 * context/current: { phase, raceId, rid }
 * meta/pilotsAllowed/{phase}/{pilotId}: boolean
 * live/results/{phase}/current/{pilotId}: { rank }
 * live/races/{phase}/{raceId}: { finalized:true }
 * live/points/{phase}/byRace/{raceId}/{pilotId}: { base, doubled, final, rank }
 */

import { dbFirestore, dbRealtime } from "./firebase-config.js";
import {
    collection, getDocs, query, where, limit
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import {
    ref, onValue, set, update
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

import { initRaceStrip } from "./ui/race-strip.js";

/* ============================================================
   Helpers
   ============================================================ */
function qs(sel, root = document) { return root.querySelector(sel); }
function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "dataset" && typeof v === "object") {
            Object.entries(v).forEach(([dk, dv]) => (el.dataset[dk] = dv));
        } else el.setAttribute(k, v);
    }
    children.flat().forEach(c => {
        if (c == null) return;
        if (typeof c === "string") el.appendChild(document.createTextNode(c));
        else el.appendChild(c);
    });
    return el;
}
function getParam(name) { return new URL(location.href).searchParams.get(name); }
function resolveAssetUrl(bddUrl = "") { return (bddUrl || "").replace(/^\.\//, "../"); }

function sortByOrderSafe(arr) {
    return [...arr].sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : 9999;
        const bo = Number.isFinite(b?.order) ? b.order : 9999;
        if (ao !== bo) return ao - bo;
        return (a?.name || "").localeCompare(b?.name || "");
    });
}

/* Split by game */
function splitPilotsByGame(pilots = []) {
    const mk8 = pilots.filter(p => (p.game || "").toUpperCase() === "MK8");
    const mkw = pilots.filter(p => (p.game || "").toUpperCase() === "MKW");
    return { mk8: sortByOrderSafe(mk8), mkw: sortByOrderSafe(mkw) };
}

/* ============================================================
   Firestore: load team + pilots
   ============================================================ */
async function loadTeamByTag(tag) {
    const qTeam = query(collection(dbFirestore, "teams"), where("tag", "==", tag), limit(1));
    const snap = await getDocs(qTeam);
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function loadPilotsForTeam(teamName) {
    if (!teamName) return [];
    const qPilots = query(collection(dbFirestore, "pilots"), where("teamName", "==", teamName));
    const snap = await getDocs(qPilots);
    return sortByOrderSafe(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

/* ============================================================
   UI render left column (non-active pilots)
   ============================================================ */
function renderLeftColumn(pilots, phase = null) {
    const col = qs("#team-pilots");
    if (!col) return;
    col.innerHTML = "";

    const { mk8, mkw } = splitPilotsByGame(pilots);
    let list = pilots;
    if (phase === "mk8") list = mkw; // MK8 actifs => colonne = MKW
    else if (phase === "mkw") list = mk8; // MKW actifs => colonne = MK8

    list.forEach(p => {
        const card = h("article", { class: "pilot-card", "data-pilot": p.id },
            h("div", { class: "img-wrap" },
                h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || p.tag || "Pilote" }),
                h("span", { class: "pilot-num" }, p.num ?? "")
            ),
            h("div", { class: "pilot-caption" },
                h("span", { class: "pilot-name" }, p.name || "—"),
                h("span", { class: "pilot-tag" }, p.tag || "")
            )
        );
        col.appendChild(card);
    });
}

/* ============================================================
   Active pilots + mosaics
   ============================================================ */
const activeTiles = new Map(); // pilotId -> { rootEl, gridSize }

function renderActivePilots(pilots, phase, allowedMap = {}, finalized = false, currentRanks = {}) {
    const container = qs("#active-pilots");
    if (!container) return;
    container.innerHTML = "";
    activeTiles.clear();

    const { mk8, mkw } = splitPilotsByGame(pilots);
    const active = phase === "mkw" ? mkw.slice(0, 4) : mk8.slice(0, 2);
    const gridSize = (phase === "mkw") ? 24 : 12;

    active.forEach(p => {
        const myRank = Number(currentRanks[p.id] ?? null);
        const card = h("div", { class: "active-pilot-card", "data-pilot": p.id },
            h("figure", { class: "pilot-figure" },
                h("div", { class: "img-wrap" },
                    h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || "Pilote" }),
                    h("span", { class: "pilot-num" }, p.num ?? "")
                ),
                h("figcaption", { class: "pilot-caption" },
                    h("span", { class: "pilot-name" }, p.name || "—"),
                    h("span", { class: "pilot-tag" }, p.tag || "")
                )
            ),
            h("div", { class: "bonus-bar" },
                h("button", { class: "bonus-btn", type: "button", "data-pilot": p.id }, 
                    h("span", { class: "bonus-label" }, "Bonus"),
                    h("span", { class: "bonus-badge" }, "x1")
                )
            ),
            buildTiles(p.id, phase, gridSize, myRank, allowedMap[p.id], finalized)
        );
        container.appendChild(card);
    });
}

function buildTiles(pilotId, phase, gridSize, myRank, allowed, finalized) {
    const root = h("div", { class: "race-tiles" });
    for (let r = 1; r <= gridSize; r++) {
        const btn = h("button", {
            class: "race-tile is-blank",
            type: "button",
            "data-rank": r,
            disabled: finalized || !allowed
        }, String(r));

        if (myRank === r) btn.classList.add("is-selected");
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            const next = (myRank === r) ? null : r;
            try {
                await set(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), { rank: next });
            } catch (e) { console.error("set rank error", e); }
        });

        root.appendChild(btn);
    }
    activeTiles.set(pilotId, { rootEl: root, gridSize });
    return root;
}

/* ============================================================
   Update tiles state (conflits, complet, couleurs)
   ============================================================ */
function updateTilesState(phase, currentRanks = {}, allowedMap = {}, finalized = false) {
    const gridSize = (phase === "mkw") ? 24 : 12;
    const counts = Array(gridSize + 1).fill(0);
    for (const val of Object.values(currentRanks)) {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 1 && n <= gridSize) counts[n]++;
    }
    const taken = new Set();
    const conflicts = new Set();
    let filledCount = 0;
    for (let r = 1; r <= gridSize; r++) {
        if (counts[r] > 0) {
            taken.add(r);
            filledCount++;
        }
        if (counts[r] >= 2) conflicts.add(r);
    }
    const isComplete = (filledCount === gridSize && conflicts.size === 0);

    activeTiles.forEach((obj, pilotId) => {
        const root = obj.rootEl;
        const myRank = Number(currentRanks[pilotId] ?? null);
        root.classList.toggle("race-tiles--complete", isComplete);

        root.querySelectorAll(".race-tile").forEach(btn => {
            const rank = Number(btn.dataset.rank);
            btn.classList.remove("is-blank","is-selected","is-conflict");
            btn.disabled = finalized || !allowedMap[pilotId];
            if (myRank === rank) {
                btn.classList.add("is-selected");
            } else if (conflicts.has(rank)) {
                btn.classList.add("is-conflict");
            } else if (taken.has(rank) && !isComplete) {
                // pas de jaune : on laisse par défaut
            } else {
                btn.classList.add("is-blank");
            }
        });
    });
}

/* ============================================================
   Bonus button (toggle doubled)
   ============================================================ */
function wireBonusButtons(phase, raceId) {
    qs("#active-pilots")?.querySelectorAll(".bonus-btn").forEach(btn => {
        const pid = btn.dataset.pilot;
        btn.onclick = async () => {
            if (["S","SF"].includes(raceId)) return; // interdit en survies
            try {
                const path = `live/points/${phase}/byRace/${raceId}/${pid}`;
                await update(ref(dbRealtime, path), { doubled: true });
                btn.classList.add("is-used");
                btn.disabled = true;
            } catch (e) {
                console.error("bonus toggle error", e);
            }
        };
    });
}

/* ============================================================
   Subscriptions
   ============================================================ */
function subscribeContext(onChange) {
    return onValue(ref(dbRealtime, "context/current"), snap => onChange(snap.val()||null));
}
function subscribeCurrent(phase, cb) {
    return onValue(ref(dbRealtime, `live/results/${phase}/current`), snap => cb(snap.val()||{}));
}
function subscribeAllowed(phase, cb) {
    return onValue(ref(dbRealtime, `meta/pilotsAllowed/${phase}`), snap => cb(snap.val()||{}));
}
function subscribeFinalized(phase, raceId, cb) {
    return onValue(ref(dbRealtime, `live/races/${phase}/${raceId}`), snap => cb(!!(snap.val()?.finalized)));
}

/* ============================================================
   Init
   ============================================================ */
(async function init() {
    const tag = getParam("id");
    const team = await loadTeamByTag(tag);
    if (!team) { qs("#content").innerHTML = "Équipe introuvable"; return; }
    const pilots = await loadPilotsForTeam(team.name);

    renderLeftColumn(pilots, null);

    // Race strip viewer
    const stripHost = qs("#race-strip-host");
    const strip = initRaceStrip(stripHost, { mode:"viewer", controller:"firebase" });

    let phase=null, raceId=null, allowed={}, ranks={}, finalized=false;

    subscribeContext(ctx => {
        if (!ctx) {
            renderLeftColumn(pilots, null);
            qs("#active-pilots").innerHTML="";
            return;
        }
        phase = ctx.phase; raceId=ctx.raceId;
        renderLeftColumn(pilots, phase);
        renderActivePilots(pilots, phase, allowed, finalized, ranks);
        wireBonusButtons(phase, raceId);
    });
    subscribeAllowed("mk8", v => { if (phase==="mk8"){allowed=v; updateTilesState(phase,ranks,allowed,finalized);} });
    subscribeAllowed("mkw", v => { if (phase==="mkw"){allowed=v; updateTilesState(phase,ranks,allowed,finalized);} });
    subscribeCurrent("mk8", v => { if (phase==="mk8"){ranks=v; updateTilesState(phase,ranks,allowed,finalized);} });
    subscribeCurrent("mkw", v => { if (phase==="mkw"){ranks=v; updateTilesState(phase,ranks,allowed,finalized);} });
    subscribeFinalized("mk8", "1", v => { if (phase==="mk8"){finalized=v; updateTilesState(phase,ranks,allowed,finalized);} });
    subscribeFinalized("mkw", "1", v => { if (phase==="mkw"){finalized=v; updateTilesState(phase,ranks,allowed,finalized);} });
})();
