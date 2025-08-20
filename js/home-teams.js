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

/* --------- rendu team card (structure exacte demandée) --------- */
function renderTeamCard(team, pilots) {
  // Pilotes de l’écurie (affichés tels quels, triés par tag)
  const teamPilots = pilots
    .filter(p => (p.teamName || "") === team.name)
    .sort((a, b) => (a.tag || "").localeCompare(b.tag || ""));

  const header = h("header", { class: "team-header" },
    h("span", { class: "team-tag" }, team.tag || ""),
    h("img", {
      class: "team-logo",
      src: (team.urlLogo || "").replace(/^\.\//, ""),
      alt: team.name || ""
    }),
    h("h2", { class: "team-name" }, team.name || "")
  );

  const pilotsGrid = h("div", { class: "team-pilots" },
    teamPilots.map(p =>
      h("a", {
        class: "pilot-card",
        href: `pilot.html?id=${encodeURIComponent(p.tag || "")}`,
        "data-pilot": p.tag || ""
      },
        h("figure", null,
          h("div", { class: "img-wrap" },
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

  const section = h("section", {
    id: safeIdFromTag(team.tag),
    class: "team-card",
    "data-team": team.tag || ""
  }, header, pilotsGrid);

  return section;
}

/* --------- chargement Firestore --------- */
async function loadData() {
  // Équipes visibles (on ignore les secrètes ici)
  const tq = query(collection(dbFirestore, "teams"), orderBy("tag"));
  const tsnap = await getDocs(tq);
  const teams = tsnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => !t.isSecret);

  // Pilotes
  const pq = query(collection(dbFirestore, "pilots"), orderBy("tag"));
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
  } catch (err) {
    console.error("[home] Erreur chargement équipes/pilotes:", err);
    grid.innerHTML = `<p style="opacity:.7">Impossible de charger les équipes pour le moment.</p>`;
  }
})();
