
import { dbFirestore, dbRealtime } from "./firebase-config.js";
import {
    collection, getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { ref, onValue, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* ----------------------- Helpers DOM ----------------------- */
function qs(sel, root = document) {
    return root.querySelector(sel);
}
function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "dataset" && typeof v === "object") {
            Object.entries(v).forEach(([dk, dv]) => el.dataset[dk] = dv);
        } else el.setAttribute(k, v);
    }
    children.flat().forEach(c => {
        if (c == null) return;
        if (typeof c === "string") el.appendChild(document.createTextNode(c));
        else el.appendChild(c);
    });
    return el;
}
function resolveAssetUrl(bddUrl = "") {
    const clean = bddUrl.trim().replace(/^\.\//, ""); // enlève le "./" initial
    const prefix = location.pathname.includes("/pages/") ? "../" : "./";
    return prefix + clean; // "../assets/images/…" ou "./assets/images/…"
}
function getTeamTagFromURL() {
    const u = new URL(window.location.href);
    return (u.searchParams.get("id") || "").trim().toUpperCase();
}

/* ----- Contexte (UI) : jeu / course / taille grille -------- */

let currentGridSize = 12; // défaut local (sera piloté par RTDB)
let currentTeamTag = null; // défini après chargement de l’équipe
// Portée de saisie: cohorte (ici MK8 uniquement)
let currentPhaseKey = "mk8";   // "mk8" | "mkw" (on branche MKW plus tard)
let phasePilotsCache = [];     // 12 pilotes du tournoi MK8 (toutes équipes)

/**
 * Met à jour les 2 pills dans la topbar.
 * @param {Object} ctx
 * @param {string} [ctx.game]    ex: "MK8" ou "MKW"
 * @param {string} [ctx.race]    ex: "Course 3/8" ou "Survie 1"
 */
function applyContextUI(ctx = {}) {
    const gameEl = qs("#ctx-game");
    const raceEl = qs("#ctx-race");

    if (gameEl) gameEl.textContent = ctx.game ?? "—";
    if (raceEl) raceEl.textContent = ctx.race ?? "Course —";
}

/**
 * Met à jour toutes les listes de classement (1..gridSize) en conservant
 * la sélection si encore valide ; sinon on remet "—".
 */
function refreshAllRankSelects(gridSize = 12) {
    currentGridSize = gridSize;

    const all = document.querySelectorAll(".rank-select");
    const ranks = Array.from({ length: gridSize }, (_, i) => i + 1);

    all.forEach(select => {
        const prev = select.value; // "" ou "1".."24"
        // Reconstruit proprement les options
        select.innerHTML = "";
        select.appendChild(h("option", { value: "" }, "—"));
        ranks.forEach(r => {
            select.appendChild(h("option", { value: String(r) }, String(r)));
        });
        // Ré-applique si encore dans l’intervalle
        if (prev && Number(prev) >= 1 && Number(prev) <= gridSize) {
            select.value = prev;
        } else {
            select.value = "";
        }
    });
}

/**
 * Applique un contexte complet (UI + taille des selects)
 * @param {Object} ctx
 * @param {string} [ctx.game] 
 * @param {string} [ctx.race]
 * @param {number} [ctx.gridSize] 12 ou 24
 */
function applyContext(ctx = {}) {
    applyContextUI(ctx);
    const size = Number(ctx.gridSize);
    refreshAllRankSelects(Number.isFinite(size) ? size : 12);
}

/* ----------------------- Fetch Firestore ----------------------- */
async function fetchTeamByTag(tag) {
    const q = query(
        collection(dbFirestore, "teams"),
        where("tag", "==", tag),
        limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) throw new Error(`Équipe introuvable pour le tag "${tag}"`);
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
}
async function fetchPilotsOfTeam(teamName) {
    // Pas de tri Firestore nécessaire ici ; on laissera l'ordre naturel,
    // ou on triera côté client si "order" est présent.
    const q = query(
        collection(dbFirestore, "pilots"),
        where("teamName", "==", teamName)
    );
    const snap = await getDocs(q);
    const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Si un "order" numérique est présent, on l’utilise pour un affichage cohérent
    arr.sort((a, b) => {
        const ao = Number.isFinite(a.order) ? a.order : 9999;
        const bo = Number.isFinite(b.order) ? b.order : 9999;
        return ao - bo;
    });
    return arr;
}

/* ----------------------- Apply theme & header ----------------------- */
function applyTeamTheme(team) {
    document.body.style.setProperty("--c1", team.color1 || "#bdbdbd");
    document.body.style.setProperty("--c2", team.color2 || "#e0e0e0");

    const logoEl = qs("#team-logo");
    const tagEl  = qs("#team-tag");
    const nameEl = qs("#team-name");

    if (logoEl) {
        logoEl.src = resolveAssetUrl(team.urlLogo || "");
        logoEl.alt = team.name || team.tag || "Logo équipe";
    }
    if (tagEl)  tagEl.textContent  = team.tag || "—";
    if (nameEl) nameEl.textContent = team.name || "Équipe";
}

/* ----------------------- Render pilots grid ----------------------- */
// Construit le contrôle "classement" (UI seule pour l'instant)
function rankControl(pilotId, gridSize = 12, currentRank = "") {
    const ranks = Array.from({ length: gridSize }, (_, i) => i + 1);

    const label = h("span", { class: "rank-label" }, "Classement");
    const select = h("select", {
        class: "rank-select",
        "data-pilot": pilotId
    }, 
        h("option", { value: "" }, "—")
    );
    ranks.forEach(r => {
        const opt = h("option", { value: String(r) }, String(r));
        if (String(currentRank) === String(r)) opt.selected = true;
        select.appendChild(opt);
    });

    // Événement local (on branchera la RTDB plus tard)
    select.addEventListener("blur", () => {
        const value = select.value; // "" ou "1".."24"
        const detail = { pilotId, rank: value ? Number(value) : null };
        document.dispatchEvent(new CustomEvent("pilot-rank-change", { detail }));
    });

    const hint = h("span", { class: "rank-hint" }, "sortie = envoi");

    return h("div", { class: "rank-control" }, label, select, hint);
}
function pilotCard(p) {
    // image & numéro
    const fig = h("figure", null,
        h("div", { class: "img-wrap" },
            h("span", { class: "pilot-num" },
                (p.num ?? "").toString().padStart(2, "0")
            ),
            h("img", {
                src: resolveAssetUrl(p.urlPhoto || ""),
                alt: p.name || p.tag || "Pilote"
            })
        ),
        h("figcaption", { class: "pilot-name" }, p.name || p.tag || "")
    );

    // pour l’instant : uniquement la carte visuelle (sélecteur au prochain bout)
    const card = h("div", { class: "pilot-card", "data-pilot": p.id }, fig);

    // conteneur item
    const item = h("div", { class: "pilot-item", "data-pilot": p.id }, 
        card,
        // par défaut on prépare pour 12; on remplacera par la vraie taille via contexte RTDB
        rankControl(p.id, 12, /* currentRank */ "")
    );
    return item;
}
function renderPilotsGrid(pilots) {
    const grid = qs("#pilots-grid");
    if (!grid) return;
    grid.innerHTML = "";
    pilots.forEach(p => grid.appendChild(pilotCard(p)));
}

/* ----------------------- Context placeholders ----------------------- */
function setContextPlaceholders() {
    const game = qs("#ctx-game");
    const race = qs("#ctx-race");
    if (game) game.textContent = "—";      // sera mis à jour via RTDB au prochain bout
    if (race) race.textContent = "Course —";
}
// ----- RTDB: écoute du contexte global (jeu / course / taille grille) -----
function startContextListener() {
    const ctxRef = ref(dbRealtime, "context/current");

    onValue(ctxRef, (snap) => {
        const v = snap.val() || {};
        // champs attendus dans RTDB:
        //   game: "MK8" | "MKW"
        //   race: "Course 3/8" | "Survie 1" | ...
        //   gridSize: 12 | 24
        const ctx = {
            game: v.game ?? "—",
            race: v.race ?? v.raceLabel ?? "Course —",
            gridSize: Number.isFinite(Number(v.gridSize)) ? Number(v.gridSize) : 12
        };
        applyContext(ctx);
    }, (err) => {
        console.error("[team] RTDB context error:", err);
        // fallback visuel doux si besoin
        applyContext({ game: "—", race: "Course —", gridSize: 12 });
    });
}
// ----- RTDB: écriture par PHASE (mk8/mkw), pas par équipe -----
// live/results/<PHASE>/current/<pilotId> => { rank, updatedAt }
async function writePilotRank(pilotId, rank) {
    const node = ref(dbRealtime, `live/results/${currentPhaseKey}/current/${pilotId}`);
    const payload = {
        rank: rank ?? null,
        updatedAt: serverTimestamp()
    };
    try {
        await update(node, payload);
    } catch (err) {
        console.error("[team] RTDB write error:", err);
    }
}

// Met à jour le <select> d'un pilote depuis une valeur RTDB (sans déclencher d'événement)
function updateSelectForPilot(pilotId, rank) {
    const sel = document.querySelector(`.rank-select[data-pilot="${pilotId}"]`);
    if (!sel) return;
    const val = (rank == null) ? "" : String(rank);
    sel.value = val;

    // feedback visuel discret
    pulsePilotCard(pilotId);
}
// Écoute live des classements pour la COHORTE (mk8/mkw)
function startRanksListener() {
    const node = ref(dbRealtime, `live/results/${currentPhaseKey}/current`);
    onValue(node, (snap) => {
        const data = snap.val() || {};
        // data = { <pilotId>: { rank: Number|null, updatedAt: ... }, ... }

        // MAJ des selects visibles
        Object.entries(data).forEach(([pilotId, entry]) => {
            updateSelectForPilot(pilotId, entry && entry.rank);
        });

        // Calcul des statuts cohorte → on colorera/lockera juste après
        applyStatusesFromRTDB(data);
    }, (err) => {
        console.error("[team] RTDB ranks error:", err);
    });
}

// Ajoute un petit "pulse" sur la carte d'un pilote (feedback visuel)
function pulsePilotCard(pilotId) {
    const card = document.querySelector(`.pilot-item[data-pilot="${pilotId}"] .pilot-card`);
    if (!card) return;
    card.classList.add("just-updated");
    setTimeout(() => card.classList.remove("just-updated"), 800);
}
/**
 * Calcule l'état de chaque pilote à l'échelle de la COHORTE courante.
 * Règles:
 * - "empty"    : pas de rang
 * - "conflict" : >= 2 pilotes de la cohorte ont le même rang
 * - "final"    : tous les pilotes de la cohorte ont un rang ET tous les rangs sont uniques
 * - "pending"  : a un rang mais on n'est pas encore en "final" (manque des rangs ailleurs ou conflit)
 *
 * @param {Object} data  ex: { pid: {rank:number|null}, ... } (RTDB)
 * @returns {Map<string, {state:string, rank:number|null}>}
 */
function computeCohortStatuses(data = {}) {
    const byPilot = new Map();

    // rangs remplis
    const filled = [];
    phasePilotsCache.forEach(p => {
        const entry = data[p.id] || {};
        const rank = (entry.rank == null) ? null : Number(entry.rank);
        byPilot.set(p.id, { state: "empty", rank });
        if (Number.isFinite(rank)) filled.push({ pilotId: p.id, rank });
    });

    // buckets pour détecter les conflits
    const buckets = new Map(); // rank -> pilotIds[]
    filled.forEach(({ pilotId, rank }) => {
        const arr = buckets.get(rank) || [];
        arr.push(pilotId);
        buckets.set(rank, arr);
    });

    const cohortSize = phasePilotsCache.length; // 12 pour MK8
    const allHaveRank = filled.length === cohortSize;

    let hasConflict = false;
    buckets.forEach(arr => { if (arr.length > 1) hasConflict = true; });

    phasePilotsCache.forEach(p => {
        const cur = byPilot.get(p.id);
        if (!Number.isFinite(cur.rank)) {
            cur.state = "empty";
        } else if (buckets.get(cur.rank)?.length > 1) {
            cur.state = "conflict";
        } else if (allHaveRank && !hasConflict) {
            cur.state = "final";
        } else {
            cur.state = "pending";
        }
        byPilot.set(p.id, cur);
    });

    return byPilot;
}
function applyStatusesFromRTDB(ranksData) {
    const statuses = computeCohortStatuses(ranksData);

    // 1) Applique classes sur cartes visibles (seulement les pilotes de CE TEAM sont dans le DOM)
    statuses.forEach((info, pilotId) => {
        const root = document.querySelector(`.pilot-item[data-pilot="${pilotId}"]`);
        if (!root) return; // ce pilote n'appartient pas à l'équipe affichée
        root.dataset.state = info.state; // CSS: [data-state="pending|conflict|final|empty"]

        const select = root.querySelector(".rank-select");
        if (select) {
            // verrouillage si final
            select.disabled = (info.state === "final");
        }
    });
}

/* ----------------------- Init ----------------------- */
(async function init() {
    try {
        setContextPlaceholders();
        startContextListener(); // ← branche le contexte live (RTDB)

        const tag = getTeamTagFromURL();
        if (!tag) throw new Error("Paramètre ?id=TAG manquant dans l’URL.");

        const team = await fetchTeamByTag(tag);
        currentTeamTag = tag; // mémorise le TAG pour le chemin RTDB
        applyTeamTheme(team);

        const pilots = await fetchPilotsOfTeam(team.name);
        renderPilotsGrid(pilots);
        startRanksListener();
        
        // ----- Charger la cohorte MK8 (12 pilotes) filtrée + triée -----
        const mk8Snap = await getDocs(
            query(
                collection(dbFirestore, "pilots"),
                where("game", "==", "MK8"),
                orderBy("order"),
                limit(12)
            )
        );
        phasePilotsCache = mk8Snap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Au blur de n’importe quel select: on pousse vers RTDB
        document.addEventListener("pilot-rank-change", (e) => {
            const { pilotId, rank } = e.detail || {};
            writePilotRank(pilotId, rank);
        });

    } catch (err) {
        console.error("[team] init error:", err);
        const grid = qs("#pilots-grid");
        if (grid) grid.innerHTML = `<p style="opacity:.7">Impossible de charger l’équipe.</p>`;
    }
})();
// DEBUG local: log quand un pilote change son rang (aucun write RTDB encore)
document.addEventListener("pilot-rank-change", (e) => {
    const { pilotId, rank } = e.detail || {};
    pulsePilotCard(pilotId);     // feedback immédiat (optimiste)
    writePilotRank(pilotId, rank);
});

