// js/admin.js
import { dbFirestore } from "./firebase-config.js";
import {
    collection, doc, addDoc, updateDoc, deleteDoc,
    onSnapshot, query, orderBy, setDoc
    } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

/* ----------------------- Helpers ----------------------- */

const IMG_PREFIX = "./assets/images/";
const TWITCH_PREFIX = "https://twitch.tv/";

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const byId = (id) => document.getElementById(id);

function ensureImagePath(path) {
    if (!path) return "";
    const trimmed = path.trim();
    if (trimmed.startsWith(IMG_PREFIX)) return trimmed;
    return IMG_PREFIX + trimmed.replace(/^\.?\/?assets\/images\/?/i, "");
}
function stripImagePrefix(path) {
    if (!path) return "";
    return path.replace(/^\.?\/?assets\/images\/?/i, "");
}

function ensureTwitchUrl(nameOrUrl) {
    const v = (nameOrUrl || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    return TWITCH_PREFIX + v.replace(/^@/, "");
}
function stripTwitchPrefix(url) {
    if (!url) return "";
    return url.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "");
}

function twoDigits(str) {
    const s = (str ?? "").toString().trim();
    if (!s) return "";
    const digits = s.replace(/\D/g, "");
    if (digits === "") return "";
    return digits.padStart(2, "0").slice(-2);
}

function textCell(text = "") {
    const td = document.createElement("td");
    td.textContent = text ?? "";
    return td;
}
function actionBtn(label, className, title) {
    const b = document.createElement("button");
    b.className = `btn icon ${className}`;
    b.textContent = label;
    if (title) b.title = title;
    return b;
}
// --- Icons (SVG inline) ---
function iconSvg(name) {
    const map = {
        edit:  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 1.83H5v-.92l9.06-9.06.92.92L5.92 19.08zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>`,
        delete:`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 7h12v2H6V7zm2 3h8l-1 9H9L8 10zm3-6h2v2h-2V4z"/></svg>`,
        add:   `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>`,
        save:  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14l4-4h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>`,
        cancel:`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`
    };
    return map[name] || "";
}
function iconBtn(type, className, title) {
    const b = document.createElement("button");
    b.className = `btn icon ${className}`;
    b.innerHTML = iconSvg(type);
    if (title) b.title = title;
    return b;
}
// --- Color contrast helpers ---
function hexToRgb(hex) {
    const h = hex.replace("#","").trim();
    if (h.length === 3) {
        const r = parseInt(h[0]+h[0],16), g = parseInt(h[1]+h[1],16), b = parseInt(h[2]+h[2],16);
        return {r,g,b};
    }
    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return {r,g,b};
}
function relLuminance({r,g,b}) {
    // sRGB -> linear
    const srgb = [r,g,b].map(v => {
        const c = v/255;
        return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
    });
    return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
}
function pickTextColor(bgHex, light="#ffffff", dark="#0c0616") {
    if (!/^#([a-f0-9]{3}|[a-f0-9]{6})$/i.test(bgHex || "")) return light;
    const lum = relLuminance(hexToRgb(bgHex));
    // seuil ~0.5, si fond clair → texte sombre, sinon texte clair
    return lum > 0.5 ? dark : light;
}
function colorCell(hex) {
    const td = document.createElement("td");
    const v = (hex || "").trim();

    if (!v) {
        td.textContent = "";
        return td;
    }

    const span = document.createElement("span");
    span.className = "color-badge";
    span.textContent = v;

    // Si c'est un hex valide -> fond + texte contrasté
    if (/^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/.test(v)) {
        span.style.background = v;
        span.style.color = pickTextColor(v); // #fff sur fond sombre, #0c0616 sur fond clair
    } else {
        // Valeur non hex : petit fallback neutre
        span.style.background = "rgba(255,255,255,0.10)";
        span.style.color = "#fff";
    }

    td.appendChild(span);
    return td;
}
function imageCell(url, alt, cls = "logo-thumb") {
    const td = document.createElement("td");
    if (url) {
        const img = document.createElement("img");
        img.src = url;
        img.alt = alt || "image";
        img.className = cls; // pour pilotes tu peux garder .logo-thumb ou créer .pilot-thumb côté CSS
        td.appendChild(img);
    } else {
        td.textContent = "";
    }
    return td;
}
function upgradeAddButtonsIcons() {
    const teamAdd = document.getElementById("team-add-btn");
    if (teamAdd) teamAdd.innerHTML = iconSvg("add");

    const pilotAdd = document.getElementById("pilot-add-btn");
    if (pilotAdd) pilotAdd.innerHTML = iconSvg("add");
}
function upgradePointsButtonsIcons() {
  const e = document.getElementById("points-edit-btn");
  const s = document.getElementById("points-save-btn");
  const c = document.getElementById("points-cancel-btn");

  if (e) { e.innerHTML = iconSvg("edit");   e.setAttribute("aria-label","Éditer"); }
  if (s) { s.innerHTML = iconSvg("save");   s.setAttribute("aria-label","Sauvegarder"); }
  if (c) { c.innerHTML = iconSvg("cancel"); c.setAttribute("aria-label","Annuler"); }
}
function twitchCell(url) {
    const td = document.createElement("td");
    const full = (url || "").trim();
    if (!full) { td.textContent = ""; return td; }

    const pseudo = stripTwitchPrefix(full) || full;
    const a = document.createElement("a");
    a.href = full;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "twitch-link";
    a.textContent = pseudo;        // n’affiche que le nom, pas l’URL
    td.appendChild(a);
    return td;
}
function teamChipCell(teamName) {
    const td = document.createElement("td");
    if (!teamName) { td.textContent = ""; return td; }

    const t = teams.find(x => (x.name || "") === teamName);
    if (!t) { td.textContent = teamName; return td; } // fallback: nom brut

    const wrap = document.createElement("span");
    wrap.className = "team-chip";

    if (t.urlLogo) {
        const img = document.createElement("img");
        img.src = t.urlLogo;
        img.alt = `${t.tag || t.name || "team"} logo`;
        wrap.appendChild(img);
    }

    const tag = document.createElement("span");
    tag.className = "team-tag";
    tag.textContent = t.tag || "";
    wrap.appendChild(tag);

    td.appendChild(wrap);
    return td;
}
function numInput(value, maxWidth = 70) {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "1";
    inp.value = Number.isFinite(value) ? String(value) : (value ?? "");
    inp.style.width = maxWidth + "px";
    inp.style.textAlign = "center";
    inp.min = "-999"; // autorise négatifs si besoin un jour
    inp.max = "9999";
    return inp;
}
function th(text = "") {
    const th = document.createElement("th");
    th.textContent = text;
    return th;
}

/* ----------------------- Points defaults ----------------------- */
// MK8: 12 rangs
const DEFAULT_MK8 = {
    ranks: {
        "1": 15, "2": 12, "3": 10, "4": 9, "5": 8, "6": 7,
        "7": 6, "8": 5, "9": 4, "10": 3, "11": 2, "12": 1
    }
};

// MKW: 24 rangs (course / s1 / s2)
const DEFAULT_MKW = {
    ranks: {
        "1":  { race: 15, s1: 30, s2: 60 },
        "2":  { race: 12, s1: 24, s2: 48 },
        "3":  { race: 10, s1: 20, s2: 40 },
        "4":  { race: 9,  s1: 18, s2: 36 },
        "5":  { race: 9,  s1: 16, s2: 32 },
        "6":  { race: 8,  s1: 15, s2: 30 },
        "7":  { race: 8,  s1: 14, s2: 28 },
        "8":  { race: 7,  s1: 13, s2: 26 },
        "9":  { race: 7,  s1: 10, s2: 20 },
        "10": { race: 6,  s1: 10, s2: 20 },
        "11": { race: 6,  s1: 10, s2: 20 },
        "12": { race: 6,  s1: 10, s2: 20 },
        "13": { race: 5,  s1: 8,  s2: 16 },
        "14": { race: 5,  s1: 8,  s2: 16 },
        "15": { race: 5,  s1: 8,  s2: 16 },
        "16": { race: 4,  s1: 8,  s2: 16 },
        "17": { race: 4,  s1: 6,  s2: 12 },
        "18": { race: 4,  s1: 6,  s2: 12 },
        "19": { race: 3,  s1: 6,  s2: 12 },
        "20": { race: 3,  s1: 6,  s2: 12 },
        "21": { race: 3,  s1: 3,  s2: 6  },
        "22": { race: 2,  s1: 3,  s2: 6  },
        "23": { race: 2,  s1: 3,  s2: 6  },
        "24": { race: 1,  s1: 3,  s2: 6  }
    }
};

/* ----------------------- State ----------------------- */

let teams = [];   // {id, name, tag, color1, color2, urlLogo}
let pilots = [];  // {id, name, tag, num, game, streamer, urlTwitch, urlPhoto, teamName}
// Points state (synchro Firestore)
let pointsMK8 = { ...DEFAULT_MK8 }; // { ranks: { "1":number, ... } }
let pointsMKW = { ...DEFAULT_MKW }; // { ranks: { "1":{race,s1,s2}, ... } }
let isPointsEdit = false; // mode édition global pour la grille des points

/* ----------------------- DOM refs (helpers) ----------------------- */

function getTeamAddInputs() {
    return {
        name:   document.getElementById("team-name-new"),
        tag:    document.getElementById("team-tag-new"),
        color1: document.getElementById("team-color1-new"),
        color2: document.getElementById("team-color2-new"),
        logo:   document.getElementById("team-logo-new"),
        addBtn: document.getElementById("team-add-btn")
    };
}

function getPilotAddInputs() {
    return {
        name:     document.getElementById("pilot-name-new"),
        tag:      document.getElementById("pilot-tag-new"),
        num:      document.getElementById("pilot-num-new"),
        game:     document.getElementById("pilot-game-new"),
        streamer: document.getElementById("pilot-streamer-new"),
        twitch:   document.getElementById("pilot-twitch-new"),
        photo:    document.getElementById("pilot-photo-new"),
        team:     document.getElementById("pilot-team-new"),
        addBtn:   document.getElementById("pilot-add-btn")
    };
}

/* ----------------------- Rendering ----------------------- */

function renderPointsGrid() {
    const table = document.getElementById("points-grid-table");
    if (!table) return;

    const theadRow = table.querySelector("thead tr");
    const tbody = table.querySelector("tbody");
    if (!theadRow || !tbody) return;

    // -- Header 0..24 (0 = vide, 1..24 = rangs)
    theadRow.innerHTML = "";
    theadRow.appendChild(th("Position")); // coin haut-gauche
    for (let r = 1; r <= 24; r++) {
        theadRow.appendChild(th(String(r)));
    }

    // Helper: crée une cellule lecture/édition
    const mkCell = (value, opts = {}) => {
        const td = document.createElement("td");
        if (opts.disabled) {
        td.textContent = "—";
        td.style.opacity = "0.5";
        return td;
        }
        if (!isPointsEdit) {
        td.textContent = (value ?? "") === "" ? "" : String(value);
        return td;
        }
        const inp = numInput(value, 56);
        if (opts.dsKind) inp.dataset.kind = opts.dsKind;
        if (opts.dsRank) inp.dataset.rank = String(opts.dsRank);
        td.appendChild(inp);
        return td;
    };

    // -- Corps (4 lignes)
    tbody.innerHTML = "";

    // Ligne 1: MK8 course (1..12 actifs, 13..24 désactivés)
    {
        const tr = document.createElement("tr");
        tr.appendChild(textCell("MK8 course")); // 1ère colonne

        for (let r = 1; r <= 24; r++) {
        if (r <= 12) {
            const v = pointsMK8?.ranks?.[String(r)] ?? DEFAULT_MK8.ranks[String(r)];
            tr.appendChild(mkCell(v, { dsKind: "mk8", dsRank: r }));
        } else {
            tr.appendChild(mkCell("", { disabled: true }));
        }
        }
        tbody.appendChild(tr);
    }

    // Ligne 2: MKW course (1..24)
    {
        const tr = document.createElement("tr");
        tr.appendChild(textCell("MKW course"));

        for (let r = 1; r <= 24; r++) {
        const row = pointsMKW?.ranks?.[String(r)] ?? DEFAULT_MKW.ranks[String(r)];
        tr.appendChild(mkCell(row?.race ?? "", { dsKind: "mkw-race", dsRank: r }));
        }
        tbody.appendChild(tr);
    }

    // Ligne 3: MKW Survie 1 (S1)
    {
        const tr = document.createElement("tr");
        tr.appendChild(textCell("MKW Survie 1 (S1)"));

        for (let r = 1; r <= 24; r++) {
        const row = pointsMKW?.ranks?.[String(r)] ?? DEFAULT_MKW.ranks[String(r)];
        tr.appendChild(mkCell(row?.s1 ?? "", { dsKind: "mkw-s1", dsRank: r }));
        }
        tbody.appendChild(tr);
    }

    // Ligne 4: MKW Survie finale (S2)
    {
        const tr = document.createElement("tr");
        tr.appendChild(textCell("MKW Survie finale (S2)"));

        for (let r = 1; r <= 24; r++) {
        const row = pointsMKW?.ranks?.[String(r)] ?? DEFAULT_MKW.ranks[String(r)];
        tr.appendChild(mkCell(row?.s2 ?? "", { dsKind: "mkw-s2", dsRank: r }));
        }
        tbody.appendChild(tr);
    }

    // -- Boutons Edit/Save/Cancel
    const btnEdit   = document.getElementById("points-edit-btn");
    const btnSave   = document.getElementById("points-save-btn");
    const btnCancel = document.getElementById("points-cancel-btn");
    if (btnEdit && btnSave && btnCancel) {
        btnEdit.hidden   = isPointsEdit;
        btnSave.hidden   = !isPointsEdit;
        btnCancel.hidden = !isPointsEdit;
    }
}
function enterPointsEditMode() {
    isPointsEdit = true;
    renderPointsGrid();
}

function cancelPointsEdit() {
    isPointsEdit = false;
    renderPointsGrid(); // re-render depuis l'état actuel (qui reflète Firestore via onSnapshot)
}

async function savePointsGrid() {
    const table = document.getElementById("points-grid-table");
    if (!table) return;

    const inputs = table.querySelectorAll("tbody input[type=number][data-kind][data-rank]");
    const mk8 = { ...pointsMK8.ranks };
    const mkw = { ...(pointsMKW.ranks || {}) };

    for (let r = 1; r <= 24; r++) {
        const k = String(r);
        mkw[k] = mkw[k] || { ...DEFAULT_MKW.ranks[k] };
    }

    inputs.forEach(inp => {
        const kind = inp.dataset.kind;
        const rank = String(inp.dataset.rank || "");
        const val  = parseInt(inp.value, 10);
        const v    = Number.isFinite(val) ? val : 0;

        if (kind === "mk8") {
            mk8[rank] = v;
        } else if (kind === "mkw-race") {
            mkw[rank].race = v;
        } else if (kind === "mkw-s1") {
            mkw[rank].s1 = v;
        } else if (kind === "mkw-s2") {
            mkw[rank].s2 = v;
        }
    });

    try {
        await Promise.all([
        setDoc(doc(dbFirestore, "points", "mk8"), { ranks: mk8 }, { merge: false }),
        setDoc(doc(dbFirestore, "points", "mkw"), { ranks: mkw }, { merge: false }),
        ]);
    } catch (err) {
        console.error("Erreur sauvegarde matrices de points:", err);
        alert("Échec de sauvegarde des matrices de points.");
    } finally {
        // Quitter le mode édition dans tous les cas
        isPointsEdit = false;
        renderPointsGrid(); // Affichage standard immédiat (onSnapshot raffermira derrière si besoin)
    }
}

function renderTeamAddRowOptions() {
    // Rien à faire ici pour les écuries
}

function renderPilotAddRowTeamSelect() {
    // Récupère le <select> à la volée pour éviter toute référence manquante
    const select = document.getElementById("pilot-team-new");
    if (!select) return;

    const current = select.value; // mémorise la sélection courante si l’élément existait déjà
    select.innerHTML = `<option value="">—</option>`;

    teams
        .slice()
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = `${t.tag} — ${t.name}`;
        select.appendChild(opt);
        });

    // Restaure la sélection si encore présente
    if (current) {
        select.value = current;
        if (select.value !== current) {
            // l’ancienne valeur n’existe plus
            select.value = "";
        }
    }
}

function renderTeamsTable() {
    const table = document.getElementById("teams-table");
    if (!table) return;
    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    const addRow = tbody.querySelector("tr.row-add");
    tbody.innerHTML = "";
    if (addRow) tbody.appendChild(addRow);

    teams
        .slice()
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .forEach(team => {
        const tr = document.createElement("tr");
        tr.dataset.id = team.id;

        // Nom + Tag
        tr.appendChild(textCell(team.name));
        tr.appendChild(textCell(team.tag));

        // Couleurs avec fond + texte contrasté
        tr.appendChild(colorCell(team.color1 || ""));
        tr.appendChild(colorCell(team.color2 || ""));

        // Logo en IMG (au lieu de l’URL brute)
        const logoTd = document.createElement("td");
        if (team.urlLogo) {
            const img = document.createElement("img");
            img.src = team.urlLogo;
            img.alt = `${team.tag || team.name || "logo"} logo`;
            img.className = "logo-thumb";
            logoTd.appendChild(img);
        } else {
            logoTd.textContent = "";
        }
        tr.appendChild(logoTd);

        // Actions (icônes)
        const actions = document.createElement("td");
        actions.className = "cell-actions";

        const editBtn = iconBtn("edit", "warning", "Modifier");
        const delBtn  = iconBtn("delete", "danger", "Supprimer");

        editBtn.addEventListener("click", () => enterEditTeamRow(tr, team));
        delBtn.addEventListener("click", () => deleteTeam(team.id));

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        tr.appendChild(actions);

        tbody.appendChild(tr);
        });

    renderPilotAddRowTeamSelect();
}

function renderPilotsTable() {
    const table = document.getElementById("pilots-table");
    if (!table) return;

    const tbody = table.querySelector("tbody");
    if (!tbody) return;

    const addRow = tbody.querySelector("tr.row-add");
    tbody.innerHTML = "";
    if (addRow) tbody.appendChild(addRow);

    pilots
        .slice()
        .sort((a, b) => a.tag.localeCompare(b.tag))
        .forEach(p => {
            const tr = document.createElement("tr");
            tr.dataset.id = p.id;

            tr.appendChild(textCell(p.name));
            tr.appendChild(textCell(p.tag));
            tr.appendChild(textCell(p.num || ""));
            tr.appendChild(textCell(p.game || ""));
            tr.appendChild(textCell(p.streamer ? "Oui" : "Non"));

            // Twitch: lien cliquable avec seulement le pseudo en texte
            tr.appendChild(twitchCell(p.urlTwitch || ""));

            // Photo: vignette
            tr.appendChild(imageCell(p.urlPhoto || "", `${p.tag || p.name || "pilot"} photo`, "logo-thumb"));

            // Écurie: logo + tag (team-chip), basé sur teamName
            tr.appendChild(teamChipCell(p.teamName || ""));

            // Actions (icônes)
            const actions = document.createElement("td");
            actions.className = "cell-actions";

            const editBtn = iconBtn("edit", "warning", "Modifier");
            const delBtn  = iconBtn("delete", "danger", "Supprimer");

            editBtn.addEventListener("click", () => enterEditPilotRow(tr, p));
            delBtn.addEventListener("click", () => deletePilot(p.id));

            actions.appendChild(editBtn);
            actions.appendChild(delBtn);
            tr.appendChild(actions);

            tbody.appendChild(tr);
        });
}

/* ----------------------- Edit rows ----------------------- */

function enterEditTeamRow(tr, team) {
    tr.innerHTML = ""; // reset

    const nameTd = document.createElement("td");
    const tagTd = document.createElement("td");
    const c1Td = document.createElement("td");
    const c2Td = document.createElement("td");
    const logoTd = document.createElement("td");
    const actionsTd = document.createElement("td");
    actionsTd.className = "cell-actions";

    const nameInput = document.createElement("input");
    nameInput.value = team.name || "";
    const tagInput = document.createElement("input");
    tagInput.value = team.tag || "";

    const c1Input = document.createElement("input");
    c1Input.type = "text";
    c1Input.value = team.color1 || "";

    const c2Input = document.createElement("input");
    c2Input.type = "text";
    c2Input.value = team.color2 || "";

    const logoInput = document.createElement("input");
    logoInput.type = "text";
    logoInput.placeholder = "ex: teams/MMM.png";
    logoInput.value = stripImagePrefix(team.urlLogo || "");

    nameTd.appendChild(nameInput);
    tagTd.appendChild(tagInput);
    c1Td.appendChild(c1Input);
    c2Td.appendChild(c2Input);
    logoTd.appendChild(logoInput);

    const saveBtn = iconBtn("save", "success", "Enregistrer");
    const cancelBtn = iconBtn("cancel", "danger", "Annuler");

    saveBtn.addEventListener("click", async () => {
        const payload = {
        name: nameInput.value.trim(),
        tag: tagInput.value.trim(),
        color1: c1Input.value.trim(),
        color2: c2Input.value.trim(),
        urlLogo: ensureImagePath(logoInput.value)
        };
        await updateDoc(doc(dbFirestore, "teams", team.id), payload);
    });

    cancelBtn.addEventListener("click", () => renderTeamsTable());

    actionsTd.appendChild(saveBtn);
    actionsTd.appendChild(cancelBtn);

    tr.appendChild(nameTd);
    tr.appendChild(tagTd);
    tr.appendChild(c1Td);
    tr.appendChild(c2Td);
    tr.appendChild(logoTd);
    tr.appendChild(actionsTd);
}

function enterEditPilotRow(tr, p) {
    tr.innerHTML = "";

    // cells
    const nameTd = document.createElement("td");
    const tagTd = document.createElement("td");
    const numTd = document.createElement("td");
    const gameTd = document.createElement("td");
    const streamerTd = document.createElement("td");
    const twitchTd = document.createElement("td");
    const photoTd = document.createElement("td");
    const teamTd = document.createElement("td");
    const actionsTd = document.createElement("td");
    actionsTd.className = "cell-actions";

    // inputs
    const nameInput = document.createElement("input");
    nameInput.value = p.name || "";

    const tagInput = document.createElement("input");
    tagInput.value = p.tag || "";

    const numInput = document.createElement("input");
    numInput.value = p.num || "";
    numInput.maxLength = 2;

    const gameSelect = document.createElement("select");
    ["MK8", "MKW"].forEach(val => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = val;
        if (p.game === val) opt.selected = true;
        gameSelect.appendChild(opt);
    });

    const streamerSelect = document.createElement("select");
    [["true","Oui"],["false","Non"]].forEach(([val,label]) => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        if ((p.streamer ? "true" : "false") === val) opt.selected = true;
        streamerSelect.appendChild(opt);
    });

    const twitchInput = document.createElement("input");
    twitchInput.placeholder = "Nom chaîne Twitch";
    twitchInput.value = stripTwitchPrefix(p.urlTwitch || "");

    const photoInput = document.createElement("input");
    photoInput.placeholder = "ex: pilots/ENS.png";
    photoInput.value = stripImagePrefix(p.urlPhoto || "");

    const teamSelect = document.createElement("select");
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "—";
    teamSelect.appendChild(emptyOpt);
    teams
        .slice().sort((a,b)=>a.tag.localeCompare(b.tag))
        .forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = `${t.tag} — ${t.name}`;
        if ((p.teamName || "") === t.name) opt.selected = true;
        teamSelect.appendChild(opt);
        });

    // mount
    nameTd.appendChild(nameInput);
    tagTd.appendChild(tagInput);
    numTd.appendChild(numInput);
    gameTd.appendChild(gameSelect);
    streamerTd.appendChild(streamerSelect);
    twitchTd.appendChild(twitchInput);
    photoTd.appendChild(photoInput);
    teamTd.appendChild(teamSelect);

    const saveBtn = iconBtn("save", "success", "Enregistrer");
    const cancelBtn = iconBtn("cancel", "danger", "Annuler");

    saveBtn.addEventListener("click", async () => {
        const payload = {
        name: nameInput.value.trim(),
        tag: tagInput.value.trim(),
        num: twoDigits(numInput.value),
        game: gameSelect.value,
        streamer: streamerSelect.value === "true",
        urlTwitch: ensureTwitchUrl(twitchInput.value),
        urlPhoto: ensureImagePath(photoInput.value),
        teamName: teamSelect.value || ""
        };
        await updateDoc(doc(dbFirestore, "pilots", p.id), payload);
    });

    cancelBtn.addEventListener("click", () => renderPilotsTable());

    actionsTd.appendChild(saveBtn);
    actionsTd.appendChild(cancelBtn);

    // append to row
    tr.appendChild(nameTd);
    tr.appendChild(tagTd);
    tr.appendChild(numTd);
    tr.appendChild(gameTd);
    tr.appendChild(streamerTd);
    tr.appendChild(twitchTd);
    tr.appendChild(photoTd);
    tr.appendChild(teamTd);
    tr.appendChild(actionsTd);
}

/* ----------------------- CRUD ----------------------- */

async function resetMK8() {
    if (!confirm("Remettre le barème par défaut pour MK8 ?")) return;
    await setDoc(doc(dbFirestore, "points", "mk8"), DEFAULT_MK8, { merge: false });
}

async function resetMKW() {
    if (!confirm("Remettre le barème par défaut pour MKW ?")) return;
    await setDoc(doc(dbFirestore, "points", "mkw"), DEFAULT_MKW, { merge: false });
}

// Add team
async function addTeam() {
    const $ = getTeamAddInputs();
    if (!$.name || !$.tag || !$.color1 || !$.color2 || !$.logo) {
        console.error("Ligne d'ajout (teams) introuvable ou IDs manquants.");
        alert("Impossible d'ajouter l'écurie : champs introuvables.");
        return;
    }

    const payload = {
        name: ($.name.value || "").trim(),
        tag: ($.tag.value || "").trim(),
        color1: ($.color1.value || "").trim(),
        color2: ($.color2.value || "").trim(),
        urlLogo: ensureImagePath($.logo.value || "")
    };

    try {
        await addDoc(collection(dbFirestore, "teams"), payload);
        // reset
        $.name.value = "";
        $.tag.value = "";
        $.color1.value = "";
        $.color2.value = "";
        $.logo.value = "";
    } catch (err) {
        console.error("Erreur ajout équipe:", err);
        alert("Erreur lors de l'ajout de l'écurie.");
    }
}

// Add pilot
async function addPilot() {
    const $ = getPilotAddInputs();
    if (!$.name || !$.tag || !$.num || !$.game || !$.streamer || !$.twitch || !$.photo || !$.team) {
        console.error("Ligne d'ajout (pilots) introuvable ou IDs manquants.");
        alert("Impossible d'ajouter le pilote : champs introuvables.");
        return;
    }

    const payload = {
        name: ($.name.value || "").trim(),
        tag: ($.tag.value || "").trim(),
        num: twoDigits($.num.value || ""),
        game: $.game.value || "MK8",
        streamer: !!($.streamer && $.streamer.checked),
        urlTwitch: ensureTwitchUrl($.twitch.value || ""),
        urlPhoto: ensureImagePath($.photo.value || ""),
        teamName: $.team.value || ""
    };

    try {
        await addDoc(collection(dbFirestore, "pilots"), payload);
        // reset minimal
        $.name.value = "";
        $.tag.value = "";
        $.num.value = "";
        if ($.streamer) $.streamer.checked = false;
        $.twitch.value = "";
        $.photo.value = "";
        $.team.value = "";
    } catch (err) {
        console.error("Erreur ajout pilote:", err);
        alert("Erreur lors de l'ajout du pilote.");
    }
}

// Delete team (and optionally detach pilots referencing it)
async function deleteTeam(id) {
    if (!confirm("Supprimer cette écurie ?")) return;
    await deleteDoc(doc(dbFirestore, "teams", id));
    // Optionnel : détacher les pilotes dont teamName == deleted team name
    // On ne le fait pas ici pour rester simple (sinon, il faut une requête et des updates).
}

async function deletePilot(id) {
    if (!confirm("Supprimer ce pilote ?")) return;
    await deleteDoc(doc(dbFirestore, "pilots", id));
}

/* ----------------------- Listeners ----------------------- */

function listenPoints() {
    // MK8
    onSnapshot(doc(dbFirestore, "points", "mk8"), (snap) => {
        if (snap.exists()) {
            const data = snap.data() || {};
            pointsMK8 = { ranks: { ...DEFAULT_MK8.ranks, ...(data.ranks || {}) } };
        } else {
            pointsMK8 = { ...DEFAULT_MK8 };
        }
        if (!isPointsEdit) renderPointsGrid();
    }, (err) => console.error("Erreur Firestore (points mk8):", err));

    // MKW
    onSnapshot(doc(dbFirestore, "points", "mkw"), (snap) => {
        if (snap.exists()) {
            const data = snap.data() || {};
            const merged = {};
            for (let r = 1; r <= 24; r++) {
                const k = String(r);
                const base = DEFAULT_MKW.ranks[k];
                const fromDb = data.ranks?.[k] || {};
                merged[k] = { race: base.race, s1: base.s1, s2: base.s2, ...fromDb };
            }
            pointsMKW = { ranks: merged };
        } else {
            pointsMKW = { ...DEFAULT_MKW };
        }
        if (!isPointsEdit) renderPointsGrid();
    }, (err) => console.error("Erreur Firestore (points mkw):", err));
}

function listenTeams() {
    const q = query(collection(dbFirestore, "teams"), orderBy("tag"));
    onSnapshot(q, (snap) => {
        teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTeamsTable();
    }, (err) => {
        console.error("Erreur Firestore (teams):", err);
    });
}

function listenPilots() {
    const q = query(collection(dbFirestore, "pilots"), orderBy("tag"));
    onSnapshot(q, (snap) => {
        pilots = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderPilotsTable();
    }, (err) => {
        console.error("Erreur Firestore (pilots):", err);
    });
}

/* ----------------------- Wire UI ----------------------- */

function wireAddRowButtons() {
    const t = getTeamAddInputs();
    if (t.addBtn) t.addBtn.addEventListener("click", addTeam);

    const p = getPilotAddInputs();
    if (p.addBtn) p.addBtn.addEventListener("click", addPilot);
}

document.addEventListener("DOMContentLoaded", () => {
    // Brancher les boutons d’ajout (écuries/pilotes)
    wireAddRowButtons();

    // Firestore live listeners
    listenTeams();
    listenPilots();
    listenPoints();

    // UI dépendantes des données
    renderTeamAddRowOptions();
    renderPilotAddRowTeamSelect();

    // Icônes des boutons (+, edit/save/cancel points)
    upgradeAddButtonsIcons();
    upgradePointsButtonsIcons();

    // Points grid: boutons d’action
    const btnEdit   = document.getElementById("points-edit-btn");
    const btnSave   = document.getElementById("points-save-btn");
    const btnCancel = document.getElementById("points-cancel-btn");

    if (btnEdit)   btnEdit.addEventListener("click", enterPointsEditMode);
    if (btnSave)   btnSave.addEventListener("click", savePointsGrid);
    if (btnCancel) btnCancel.addEventListener("click", cancelPointsEdit);
});
