// js/home-teams.js
import { dbFirestore } from "./firebase-config.js";
import {
  collection, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

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
        img.src = (t.urlLogo || "").replace(/^\.\//, "");
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

/* --------- rendu team card (structure exacte demandée) --------- */
function renderTeamCard(team, pilots) {
    // Pilotes de l’écurie (pas de tri additionnel ici)
    const teamPilots = pilots.filter(p => (p.teamName || "") === team.name);

    const header = h("header", { class: "team-header" },
        h("img", {
            class: "team-logo",
            src: (team.urlLogo || "").replace(/^\.\//, ""),
            alt: team.name || ""
        }),
        h("h2", { class: "team-name" }, team.name || ""),
        h("span", { class: "team-tag" }, team.tag || "")
    );

    const pilotsGrid = h("div", { class: "team-pilots" },
        teamPilots.map(p =>
            h("div", {                         // ← plus de lien ici
                class: "pilot-card",
                "data-pilot": p.tag || ""
            },
                h("figure", null,
                    h("div", { class: "img-wrap" },
                        h("span", { class: "pilot-num" },
                            (p.num ?? "").toString().padStart(2, "0")
                        ),
                        h("img", {
                            src: (p.urlPhoto || "").replace(/^\.\//, ""),
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
    // Équipes visibles — tri Firestore par 'order'
    const tq = query(
        collection(dbFirestore, "teams"),
        orderBy("order")
    );
    const tsnap = await getDocs(tq);
    const teams = tsnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => !t.isSecret);

    // Pilotes — tri Firestore par 'order'
    const pq = query(
        collection(dbFirestore, "pilots"),
        orderBy("order")
    );
    const psnap = await getDocs(pq);
    const pilots = psnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return { teams, pilots };
}

/* --------- init --------- */
(async function init() {
  if (!grid) {
    console.warn('[home] Conteneur "#teams-grid" introuvable.');
    return;
  }

  try {
    const { teams, pilots } = await loadData();

    // Nettoyage et injection
    grid.innerHTML = "";
    teams.forEach(team => {
      grid.appendChild(renderTeamCard(team, pilots));
    });
    buildTeamNav(teams);
  } catch (err) {
    console.error("[home] Erreur chargement équipes/pilotes:", err);
    grid.innerHTML = `<p style="opacity:.7">Impossible de charger les équipes pour le moment.</p>`;
  }
})();
