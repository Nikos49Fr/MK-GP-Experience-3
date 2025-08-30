// js/home-teams.js
import { dbFirestore, dbRealtime } from "./firebase-config.js";
import {
    collection, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* --------- helpers --------- */
const grid = document.getElementById("teams-grid");

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === "class") el.className = v;
        else if (k === "dataset" && v && typeof v === "object") {
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

function resolveAssetPath(storedPath) {
    if (!storedPath) return "";
    // Laisser passer les URLs absolues
    if (/^(https?:|data:|blob:)/i.test(storedPath)) return storedPath;

    // Ce fichier est /js/home-teams.js → racine projet = ../
    const projectRoot = new URL("../", import.meta.url);

    // Normalisation
    let p = String(storedPath).trim();

    // 1) enlever les "./" ou "/" en tête
    if (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/")) p = p.slice(1);

    // 2) supprimer tous les "../" initiaux pour éviter de sortir du repo sur GH Pages
    p = p.replace(/^(\.\.\/)+/g, "");

    // 3) compléter les formes courantes
    //    - "assets/..." → OK
    //    - "images/..." → préfixer "assets/"
    //    - "team-2/hanamarou.png" → préfixer "assets/images/"
    if (p.startsWith("assets/")) {
        // rien
    } else if (p.startsWith("images/")) {
        p = "assets/" + p;
    } else if (!p.startsWith("assets/images/")) {
        p = "assets/images/" + p;
    }

    return new URL(p, projectRoot).href;
}

function safeIdFromTag(tag) {
    return `team-${String(tag || "").toLowerCase()}`;
}
function ensureAnchor(id) {
    if (!document.getElementById(id)) {
        const marker = document.createElement("div");
        marker.id = id;
        // top: au tout début du body, bottom: à la fin
        if (id === "top") {
            document.body.prepend(marker);
        } else {
            document.body.appendChild(marker);
        }
    }
}

function buildTeamNav(teams) {
    const nav = document.getElementById("team-nav");
    if (!nav) return;

    // Assure l'existence des ancres #top / #bottom
    ensureAnchor("top");
    ensureAnchor("bottom");

    nav.innerHTML = "";

    // Flèche haut
    const up = document.createElement("a");
    up.href = "#top";
    up.className = "nav-arrow up";
    up.textContent = "▲";
    nav.appendChild(up);

    // Équipes visibles (on suppose triées par Firestore 'order' + filtrées isSecret=false dans loadData)
    teams.forEach(t => {
        const a = document.createElement("a");
        a.href = `#${safeIdFromTag(t.tag)}`;

        const img = document.createElement("img");
        img.src = resolveAssetPath(t.urlLogo || "");
        img.alt = t.tag || t.name || "TEAM";

        a.appendChild(img);
        nav.appendChild(a);
    });

    // Flèche bas
    const down = document.createElement("a");
    down.href = "#bottom";
    down.className = "nav-arrow down";
    down.textContent = "▼";
    nav.appendChild(down);

    // Scroll doux
    nav.querySelectorAll('a[href^="#"]').forEach(link => {
        link.addEventListener("click", (e) => {
            const hash = link.getAttribute("href");
            if (!hash || hash === "#") return;
            const id = hash.slice(1);
            const target = document.getElementById(id);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });
}

/* --------- state (reveal) --------- */
let _allTeams = [];
let _allPilots = [];
let _phase = null;          // "mk8" | "mkw" | null
let _reveal = false;        // context/reveal.enabled

function shouldApplyReveal() {
    return _reveal && String(_phase || "").toLowerCase() === "mkw";
}

function normalizeGame(v) {
    return String(v || "").toLowerCase();
}

/**
 * Appartenance visuelle d’un pilote à une équipe
 * - reveal actif: dans team si pilot.secretTeamName === team.name
 *                 ou (traitorMode==="double" && pilot.teamName === team.name)  (double → visible aussi dans l’équipe d’origine)
 * - sinon:        dans team si pilot.teamName === team.name
 */
function isPartOfTeam(team, pilot, applyReveal) {
    const tname = team.name || "";
    const mode = String(pilot.traitorMode || "").toLowerCase();
    if (applyReveal) {
        if ((pilot.secretTeamName || "") === tname) return true;
        if (mode === "double" && (pilot.teamName || "") === tname) return true;
        return false;
    }
    return (pilot.teamName || "") === tname;
}

/**
 * Construit un roster compact visible :
 * - Sans reveal : 6 pilotes Firestore “naturels” (ton BDD a 6 par team → OK)
 * - Avec reveal : 2 MK8 + 3 MKW (max) en respectant l’ordre Firestore
 */
function buildRosterForTeam(team, pilots, applyReveal) {
    const part = pilots.filter(p => isPartOfTeam(team, p, applyReveal));

    // tri par 'order' déjà présent en BDD
    const byOrder = (a, b) => (Number(a.order || 0) - Number(b.order || 0));

    if (!applyReveal) {
        // Avant reveal, on renvoie simplement tous les pilotes de la team (ton BDD en a 6)
        return part.sort(byOrder);
    }

    // Reveal actif → forcer 2 MK8 + 3 MKW
    const mk8 = part.filter(p => normalizeGame(p.game) === "mk8").sort(byOrder).slice(0, 2);
    const mkw = part.filter(p => normalizeGame(p.game) === "mkw").sort(byOrder).slice(0, 3);
    return [...mk8, ...mkw];
}

/* --------- rendu team card (structure exacte demandée) --------- */
function renderTeamCard(team, pilots) {
    // Pilotes de l’écurie (pas de tri additionnel ici)
    const teamPilots = buildRosterForTeam(team, pilots, shouldApplyReveal());

    const header = h("header", { class: "team-header" },
        h("img", {
            class: "team-logo",
            src: resolveAssetPath(team.urlLogo || ""),
            alt: team.name || ""
        }),
        h("h2", { class: "team-name" }, team.name || ""),
        h("span", { class: "team-tag" }, team.tag || "")
    );

    const pilotsGrid = h("div", { class: "team-pilots" },
        teamPilots.map(p =>
            h("div", {
                class: "pilot-card",
                "data-pilot": p.tag || ""
            },
                h("figure", null,
                    h("div", { class: "img-wrap" },
                        h("span", { class: "pilot-num" },
                            (p.num ?? "").toString().padStart(2, "0")
                        ),
                        h("img", {
                            src: resolveAssetPath(p.urlPhoto || ""),
                            alt: p.name || p.tag || "Nom Pilote"
                        })
                    ),
                    h("figcaption", { class: "pilot-name" }, p.name || p.tag || "")
                )
            )
        )
    );

    // La card entière devient un lien vers la page équipe
    const section = h("a", {
        id: safeIdFromTag(team.tag),
        class: "team-card",
        "data-team": team.tag || "",
        href: `pages/team.html?id=${encodeURIComponent(team.tag || "")}`
    }, header, pilotsGrid);

    return section;
}

/* --------- chargement Firestore --------- */
async function loadData() {
    // Équipes — tri Firestore par 'order' (inclut secrètes)
    const tq = query(
        collection(dbFirestore, "teams"),
        orderBy("order")
    );
    const tsnap = await getDocs(tq);
    const teams = tsnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Pilotes — tri Firestore par 'order'
    const pq = query(
        collection(dbFirestore, "pilots"),
        orderBy("order")
    );
    const psnap = await getDocs(pq);
    const pilots = psnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return { teams, pilots };
}

function renderGridConditional() {
    if (!grid || !_allTeams.length) return;
    const applyReveal = shouldApplyReveal();

    // 6 teams avant reveal, 8 après
    const teamsToShow = applyReveal
        ? _allTeams
        : _allTeams.filter(t => !t.isSecret);

    grid.innerHTML = "";
    teamsToShow.forEach(team => {
        grid.appendChild(renderTeamCard(team, _allPilots));
    });
    buildTeamNav(teamsToShow);
}

function subscribeRevealAndPhase() {
    onValue(ref(dbRealtime, "context/current"), (snap) => {
        const ctx = snap.val() || {};
        _phase = (ctx.phase || null);
        renderGridConditional();
    });
    onValue(ref(dbRealtime, "context/reveal"), (snap) => {
        const v = snap.val() || {};
        _reveal = !!v.enabled;
        renderGridConditional();
    });
}

/* --------- init --------- */
(async function init() {
    if (!grid) {
        console.warn('[home] Conteneur "#teams-grid" introuvable.');
        return;
    }

    try {
        const { teams, pilots } = await loadData();

        // cache local
        _allTeams = teams;
        _allPilots = pilots;

        // 1er rendu sans reveal (6 teams visibles)
        renderGridConditional();

        // écoutes reveal/phase → re-render auto
        subscribeRevealAndPhase();
    } catch (err) {
        console.error("[home] Erreur chargement équipes/pilotes:", err);
        grid.innerHTML = `<p style="opacity:.7">Impossible de charger les équipes pour le moment.</p>`;
    }
    
})();
