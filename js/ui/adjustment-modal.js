// /js/ui/adjustment-modal.js
// Modale Bonus/Malus (compacte, actions immédiates), tableau par équipes
// Conventions projet : ES modules, indentation 4 espaces, aucune CSS inline

import { dbFirestore, dbRealtime } from "../firebase-config.js";
import {
    collection, getDocs
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import {
    ref, get, onValue, off, update
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

/* ============================================================================================
   Utils DOM
   ============================================================================================ */
function $(sel, root = document) { return root.querySelector(sel); }
function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") n.className = v;
        else if (k === "dataset") Object.assign(n.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    for (const c of children) {
        if (c == null) continue;
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
}
function resolveAssetPath(path) {
    if (!path) return "";
    // Les logos/portraits stockés avec "./assets/images/..." côté BDD
    // Ici le control panel est dans /pages/, donc on remonte d'un niveau
    if (path.startsWith("./")) return ".." + path.slice(1);
    if (path.startsWith("/")) return ".." + path; // si jamais
    return path;
}

/* ============================================================================================
   Lecture contexte phase + reveal
   ============================================================================================ */
async function readCurrentPhase() {
    const snap = await get(ref(dbRealtime, "context/current"));
    const ctx = snap.val() || {};
    const raw = (ctx.phase || "").toString().toLowerCase();
    return raw === "mkw" ? "mkw" : (raw === "mk8" ? "mk8" : null);
}
async function readRevealEnabled() {
    const snap = await get(ref(dbRealtime, "context/reveal/enabled"));
    return !!(snap.val());
}

/* ============================================================================================
   Firestore: lecture teams + pilots
   ============================================================================================ */
async function fetchTeamsAndPilots() {
    const [teamsSnap, pilotsSnap] = await Promise.all([
        getDocs(collection(dbFirestore, "teams")),
        getDocs(collection(dbFirestore, "pilots"))
    ]);

    const teams = [];
    const teamsByName = new Map();
    teamsSnap.forEach(doc => {
        const d = doc.data() || {};
        const t = {
            id: doc.id,
            name: d.name || "",
            tag: d.tag || "",
            order: Number(d.order ?? 0),
            urlLogo: d.urlLogo || "",
            color1: d.color1 || "#ffffff",
            color2: d.color2 || "#ffffff",
            isSecret: !!d.isSecret
        };
        teams.push(t);
        teamsByName.set(t.name, t);
    });
    teams.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));

    const pilots = [];
    pilotsSnap.forEach(doc => {
        const d = doc.data() || {};
        pilots.push({
            id: doc.id,
            name: d.name || "",
            tag: d.tag || "",
            num: d.num || "",
            game: (d.game || "").toString().toUpperCase(), // "MK8" | "MKW"
            teamName: d.teamName || "",
            secretTeamName: d.secretTeamName || d.teamName || "",
            traitorMode: d.traitorMode || null, // "double" | "transfer" | null
            order: Number(d.order ?? 0)
        });
    });

    return { teams, teamsByName, pilots };
}

/* ============================================================================================
   Grouping par équipe selon phase + reveal
   ============================================================================================ */
function groupPilotsForPhase(pilots, phase, reveal) {
    // Filtrer par phase
    const gameKey = phase === "mk8" ? "MK8" : "MKW";
    const list = pilots.filter(p => (p.game || "").toUpperCase() === gameKey);

    // Choix du champ d'équipe
    // MK8 → teamName ; MKW → teamName ou secretTeamName si reveal actif
    const useSecret = (phase === "mkw" && reveal);

    // Groupe: Map(teamName -> array pilotes)
    const groups = new Map();
    for (const p of list) {
        const key = useSecret ? (p.secretTeamName || p.teamName) : p.teamName;
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
    }
    // Tri interne par order, puis tag
    for (const arr of groups.values()) {
        arr.sort((a, b) => (a.order - b.order) || a.tag.localeCompare(b.tag));
    }
    return groups;
}

/* ============================================================================================
   RTDB adjustments
   Structure:
   live/adjustments/{phase}/pilot/{pilotId} = { cosplay:boolean, jury:boolean, bonus:number, malus:number, total:number }
   live/adjustments/{phase}/juryWinner = pilotId
   ============================================================================================ */
async function readAdjustments(phase) {
    const baseRef = ref(dbRealtime, `live/adjustments/${phase}`);
    const [pilotSnap, winnerSnap] = await Promise.all([
        get(ref(dbRealtime, `live/adjustments/${phase}/pilot`)),
        get(ref(dbRealtime, `live/adjustments/${phase}/juryWinner`))
    ]);
    const byPilot = pilotSnap.val() || {};
    const winner = winnerSnap.val() || null;

    // Normalisation
    const map = new Map();
    Object.entries(byPilot).forEach(([pid, v]) => {
        map.set(pid, {
            cosplay: !!v?.cosplay,
            jury: !!v?.jury,
            bonus: Number(v?.bonus || 0),
            malus: Number(v?.malus || 0),
            total: Number(v?.total || 0)
        });
    });
    return { byPilot: map, juryWinner: winner };
}

function computeTotal(adj) {
    const base = (adj?.bonus || 0) - (adj?.malus || 0);
    const cosplay5 = adj?.cosplay ? 5 : 0;
    const jury5 = adj?.jury ? 5 : 0;
    return base + cosplay5 + jury5;
}

async function applyPilotDelta(phase, pilotId, kind /*"bonus"|"malus"*/, delta /*positive int*/) {
    const baseRef = ref(dbRealtime, `live/adjustments/${phase}/pilot/${pilotId}`);
    const snap = await get(baseRef);
    const cur = snap.val() || {};
    const next = {
        cosplay: !!cur.cosplay,
        jury: !!cur.jury,
        bonus: Number(cur.bonus || 0),
        malus: Number(cur.malus || 0)
    };
    if (kind === "bonus") next.bonus += delta;
    else next.malus += delta;
    next.total = computeTotal(next);
    await update(baseRef, next);
    return next;
}

async function setCosplay(phase, pilotId, checked) {
    const baseRef = ref(dbRealtime, `live/adjustments/${phase}/pilot/${pilotId}`);
    const snap = await get(baseRef);
    const cur = snap.val() || {};
    const next = {
        cosplay: !!checked,
        jury: !!cur.jury,
        bonus: Number(cur.bonus || 0),
        malus: Number(cur.malus || 0)
    };
    next.total = computeTotal(next);
    await update(baseRef, next);
    return next;
}

async function setJuryWinner(phase, newPilotId) {
    const winnerRef = ref(dbRealtime, `live/adjustments/${phase}/juryWinner`);
    const curWinnerSnap = await get(winnerRef);
    const prev = curWinnerSnap.val() || null;

    const updates = {};
    updates[`live/adjustments/${phase}/juryWinner`] = newPilotId || null;
    if (prev && prev !== newPilotId) {
        updates[`live/adjustments/${phase}/pilot/${prev}/jury`] = false;
        // Recompute total prev
        // (Lecture rapide — on ne surcharge pas : on laisse la prochaine lecture corriger le visuel
        //  ou bien on remet total ici si on veut stricte cohérence immédiate)
    }
    if (newPilotId) {
        updates[`live/adjustments/${phase}/pilot/${newPilotId}/jury`] = true;
    }
    await update(ref(dbRealtime), updates);
    return { prev, next: newPilotId };
}

async function applyTeamDelta(phase, pilotIds /*array*/, kind, delta) {
    const base = {};
    for (const pid of pilotIds) {
        // lecture actuelle
        const snap = await get(ref(dbRealtime, `live/adjustments/${phase}/pilot/${pid}`));
        const cur = snap.val() || {};
        const next = {
            cosplay: !!cur.cosplay,
            jury: !!cur.jury,
            bonus: Number(cur.bonus || 0),
            malus: Number(cur.malus || 0)
        };
        if (kind === "bonus") next.bonus += delta;
        else next.malus += delta;
        next.total = computeTotal(next);
        base[`live/adjustments/${phase}/pilot/${pid}`] = next;
    }
    await update(ref(dbRealtime), base);
}

/* ============================================================================================
   Rendu modale (structure tableau)
   Colonnes : Pilote | Cosplay | Jury | Bonus | Total | Malus | [Logo équipe] | [Bonus/Malus équipe]
   Le dernier header "Bonus/Malus équipe" est un <th colspan="2"> (logo + contrôles)
   ============================================================================================ */
function renderHeaderRow() {
    const tr = el("tr", {},
        el("th", { class: "am-col am-col--pilot" }, "Pilote"),
        el("th", { class: "am-col am-col--cosplay" }, "Cosplay"),
        el("th", { class: "am-col am-col--jury" }, "Jury"),
        el("th", { class: "am-col am-col--bonus" }, "Bonus"),
        el("th", { class: "am-col am-col--total" }, "Total"),
        el("th", { class: "am-col am-col--malus" }, "Malus"),
        el("th", { class: "am-col am-col--teamgroup", colspan: "2" }, "Bonus/Malus équipe")
    );
    return tr;
}

function buttonGroup(kind /*"plus"|"minus"*/, size = "sm") {
    // Trois boutons: 1 5 10 — la *couleur* (vert/rouge) vient de am-btns--plus / am-btns--minus
    const wrap = el("div", { class: `am-btns am-btns--${kind} am-btns--${size}` },
        el("button", { type: "button", class: "am-btn",  "data-delta": (kind === "plus" ? "1"   : "-1")  }, "1"),
        el("button", { type: "button", class: "am-btn",  "data-delta": (kind === "plus" ? "5"   : "-5")  }, "5"),
        el("button", { type: "button", class: "am-btn",  "data-delta": (kind === "plus" ? "10"  : "-10") }, "10")
    );
    return wrap;
}

function renderTeamCellLogo(team) {
    const src = resolveAssetPath(team?.urlLogo || "");
    const alt = team?.tag || team?.name || "Team";
    return el("td", { class: "am-td am-td--teamlogo", rowspan: "1" }, // rowspan ajusté ensuite
        el("div", { class: "am-teamlogo" },
            src ? el("img", { src, alt }) : el("span", { class: "am-teamlogo--placeholder" }, (team?.tag || "—"))
        )
    );
}

function renderTeamCellControls() {
    // Deux lignes : bonus puis malus
    const td = el("td", { class: "am-td am-td--teamctrls", rowspan: "1" },
        el("div", { class: "am-teamctrls" },
            el("div", { class: "am-teamctrls-row am-teamctrls-row--bonus" },
                buttonGroup("plus", "lg")
            ),
            el("div", { class: "am-teamctrls-row am-teamctrls-row--malus" },
                buttonGroup("minus", "lg")
            )
        )
    );
    return td;
}

function renderPilotRow(pilot, adj, juryWinnerId) {
    const cosplayChecked = !!adj?.cosplay;
    const juryChecked = (pilot.id === juryWinnerId);

    const totalVal = Number(adj?.total || 0);
    const totalClass = totalVal === 0 ? "is-zero" : (totalVal > 0 ? "is-pos" : "is-neg");
    const totalText = totalVal === 0 ? "0" : (totalVal > 0 ? `+${totalVal}` : `${totalVal}`);

    const tr = el("tr", { class: "am-row", dataset: { pilotId: pilot.id } },
        el("td", { class: "am-td am-td--pilot" }, pilot.name || pilot.tag || "—"),
        el("td", { class: "am-td am-td--cosplay" },
            el("label", { class: "am-check" },
                el("input", { type: "checkbox", class: "am-cb-cosplay", checked: cosplayChecked ? "checked" : null }),
                el("span", { class: "am-check__label" }, "+5")
            )
        ),
        el("td", { class: "am-td am-td--jury" },
            el("label", { class: "am-radio" },
                el("input", {
                    type: "radio",
                    name: "am-jury",
                    class: "am-rb-jury",
                    checked: juryChecked ? "checked" : null
                }),
                el("span", { class: "am-radio__label" }, "+5")
            )
        ),
        el("td", { class: "am-td am-td--bonus" },
            buttonGroup("plus", "sm")
        ),
        el("td", { class: `am-td am-td--total ${totalClass}` },
            el("span", { class: "am-total" }, totalText)
        ),
        el("td", { class: "am-td am-td--malus" },
            buttonGroup("minus", "sm")
        )
        // Les deux dernières colonnes (logo + team-ctrls) sont ajoutées sur la première ligne du groupe (rowspan)
    );
    return tr;
}

/* ============================================================================================
   Ouverture modale
   ============================================================================================ */
let unsubscribeLive = null;

export async function openAdjustmentsModal() {
    // Nettoie ancienne modale si ouverte
    closeAdjustmentsModal();

    // Phase + reveal
    const [phase, reveal] = await Promise.all([readCurrentPhase(), readRevealEnabled()]);
    if (!phase) {
        alert("Aucune phase active.");
        return;
    }

    // Données Firestore
    const { teams, teamsByName, pilots } = await fetchTeamsAndPilots();
    const groups = groupPilotsForPhase(pilots, phase, reveal);

    // Ajustements courants
    const { byPilot, juryWinner } = await readAdjustments(phase);

    // Overlay
    const overlay = el("div", { class: "am-modal", role: "dialog", "aria-modal": "true" },
        el("div", { class: "am-modal__backdrop", onclick: () => closeAdjustmentsModal() }),
        el("div", { class: "am-modal__dialog" },
            el("div", { class: "am-modal__header" },
                el("h2", { class: "am-modal__title" }, `Bonus / Malus — ${phase.toUpperCase()}`),
                el("button", { type: "button", class: "am-modal__close", onclick: () => closeAdjustmentsModal(), "aria-label": "Fermer" }, "×")
            ),
            el("div", { class: "am-modal__body" })
        )
    );
    document.body.appendChild(overlay);
    document.documentElement.classList.add('am-modal-open');

    const body = $(".am-modal__body", overlay);

    // Table
    const table = el("table", { class: "am-table" });
    const thead = el("thead", {}, renderHeaderRow());
    const tbody = el("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    body.appendChild(table);

    // Construire les groupes dans l’ordre des équipes (selon teams.order)
    const groupEntries = Array.from(groups.entries())
        .sort((a, b) => {
            const tA = teamsByName.get(a[0]);
            const tB = teamsByName.get(b[0]);
            const oA = tA ? Number(tA.order || 0) : 0;
            const oB = tB ? Number(tB.order || 0) : 0;
            return (oA - oB) || a[0].localeCompare(b[0]);
        });

    for (const [teamName, arr] of groupEntries) {
        const team = teamsByName.get(teamName) || { name: teamName, tag: teamName };
        const n = arr.length || 1;

        arr.forEach((pilot, idx) => {
            const adj = byPilot.get(pilot.id) || { cosplay: false, jury: false, bonus: 0, malus: 0, total: 0 };
            const tr = renderPilotRow(pilot, adj, juryWinner);

            // Insère les deux cellules fusionnées sur la première ligne du groupe
            if (idx === 0) {
                const tdLogo = renderTeamCellLogo(team);
                tdLogo.setAttribute("rowspan", String(n));
                const tdCtrl = renderTeamCellControls();
                tdCtrl.setAttribute("rowspan", String(n));

                tr.appendChild(tdLogo);
                tr.appendChild(tdCtrl);

                // Data pour actions d'équipe
                tdCtrl.dataset.team = team.name || teamName;
                tdCtrl.dataset.pilots = JSON.stringify(arr.map(p => p.id));
            }

            // Data pour listeners individuels
            tr.dataset.team = team.name || teamName;
            tr.dataset.pilotId = pilot.id;

            tbody.appendChild(tr);
        });
    }

    // Listeners délégués (individuels)
    tbody.addEventListener("click", async (ev) => {
        // bouton cliqué ?
        const btn = ev.target.closest(".am-btn");
        if (!btn) return;

        // si le bouton est dans la colonne des contrôles d'équipe, on sort :
        const cell = btn.closest("td");
        if (cell && cell.classList.contains("am-td--teamctrls")) return;

        // ligne pilote concernée
        const tr = btn.closest("tr.am-row");
        if (!tr) return;

        const pilotId = tr.dataset.pilotId;
        if (!pilotId) return;

        const deltaStr = btn.getAttribute("data-delta");
        const delta = Number(deltaStr || 0);
        if (!Number.isFinite(delta) || delta === 0) return;

        try {
            const kind = delta > 0 ? "bonus" : "malus";
            const next = await applyPilotDelta(phase, pilotId, kind, Math.abs(delta));
            // MAJ visuelle du total
            const tdTotal = $(".am-td--total .am-total", tr) || $(".am-td--total", tr);
            if (tdTotal) {
                const val = Number(next.total || 0);
                tdTotal.textContent = val === 0 ? "0" : (val > 0 ? `+${val}` : `${val}`);
                const td = tdTotal.closest(".am-td--total");
                if (td) {
                    td.classList.toggle("is-zero", val === 0);
                    td.classList.toggle("is-pos", val > 0);
                    td.classList.toggle("is-neg", val < 0);
                }
            }
        } catch (e) {
            console.error("[am] applyPilotDelta error", e);
        }
    });

    tbody.addEventListener("change", async (ev) => {
        const tr = ev.target.closest("tr.am-row");
        if (!tr) return;
        const pilotId = tr.dataset.pilotId;

        if (ev.target.classList.contains("am-cb-cosplay")) {
            try {
                const next = await setCosplay(phase, pilotId, !!ev.target.checked);
                const tdTotal = $(".am-td--total .am-total", tr);
                if (tdTotal) {
                    const v = Number(next.total || 0);
                    tdTotal.textContent = v === 0 ? "0" : (v > 0 ? `+${v}` : `${v}`);
                    const td = tdTotal.closest(".am-td--total");
                    td.classList.toggle("is-zero", v === 0);
                    td.classList.toggle("is-pos", v > 0);
                    td.classList.toggle("is-neg", v < 0);
                }
            } catch (e) {
                console.error("[am] setCosplay error", e);
            }
        } else if (ev.target.classList.contains("am-rb-jury")) {
            try {
                // Décocher les autres radios dans le tbody (visuel immédiat)
                tbody.querySelectorAll(".am-rb-jury").forEach(r => { if (r !== ev.target) r.checked = false; });
                await setJuryWinner(phase, pilotId);
                // La MAJ du total se fera via prochaine lecture ou on pourrait relire pilot pour recalculer
                // (optionnel) On force un +5 visuel immédiat en lisant la cellule total et en ajustant
                // Pour simplicité : relire l'item et mettre à jour
                const snap = await get(ref(dbRealtime, `live/adjustments/${phase}/pilot/${pilotId}`));
                const cur = snap.val() || { bonus: 0, malus: 0, cosplay: false, jury: true };
                cur.jury = true;
                cur.total = computeTotal(cur);
                const tdTotal = $(".am-td--total .am-total", tr);
                if (tdTotal) {
                    const v = Number(cur.total || 0);
                    tdTotal.textContent = v === 0 ? "0" : (v > 0 ? `+${v}` : `${v}`);
                    const td = tdTotal.closest(".am-td--total");
                    td.classList.toggle("is-zero", v === 0);
                    td.classList.toggle("is-pos", v > 0);
                    td.classList.toggle("is-neg", v < 0);
                }
            } catch (e) {
                console.error("[am] setJuryWinner error", e);
            }
        }
    });

    // Listeners délégués (équipe)
    tbody.addEventListener("click", async (ev) => {
        ev.stopPropagation(); // évite que le handler individuel capte aussi le clic
        const row = ev.target.closest("td.am-td--teamctrls");
        if (!row) return;

        const pilotsJson = row.dataset.pilots || "[]";
        let pilotIds = [];
        try { pilotIds = JSON.parse(pilotsJson) || []; } catch (_) { pilotIds = []; }

        const btn = ev.target.closest(".am-btn");
        if (!btn) return;
        const deltaStr = btn.getAttribute("data-delta");
        const delta = Number(deltaStr || 0);
        if (!Number.isFinite(delta) || delta === 0) return;

        try {
            const kind = delta > 0 ? "bonus" : "malus";
            await applyTeamDelta(phase, pilotIds, kind, Math.abs(delta));
            // MAJ visuelle des totaux du groupe
            pilotIds.forEach(async (pid) => {
                const tr = tbody.querySelector(`tr.am-row[data-pilot-id="${pid}"]`);
                if (!tr) return;
                const snap = await get(ref(dbRealtime, `live/adjustments/${phase}/pilot/${pid}`));
                const cur = snap.val() || {};
                const v = Number(cur.total || 0);
                const tdTotal = $(".am-td--total .am-total", tr);
                if (tdTotal) {
                    tdTotal.textContent = v === 0 ? "0" : (v > 0 ? `+${v}` : `${v}`);
                    const td = tdTotal.closest(".am-td--total");
                    td.classList.toggle("is-zero", v === 0);
                    td.classList.toggle("is-pos", v > 0);
                    td.classList.toggle("is-neg", v < 0);
                }
            });
        } catch (e) {
            console.error("[am] applyTeamDelta error", e);
        }
    });

    // (Optionnel) écoute live des ajustements pour rafraîchir “Total” en cas d’actions concurrentes
    const liveRef = ref(dbRealtime, `live/adjustments/${phase}/pilot`);
    const liveCb = (snap) => {
        const data = snap.val() || {};
        Object.entries(data).forEach(([pid, v]) => {
            const tr = tbody.querySelector(`tr.am-row[data-pilot-id="${pid}"]`);
            if (!tr) return;
            const val = Number((v && v.total) || 0);
            const tdTotal = $(".am-td--total .am-total", tr);
            if (tdTotal) {
                tdTotal.textContent = val === 0 ? "0" : (val > 0 ? `+${val}` : `${val}`);
                const td = tdTotal.closest(".am-td--total");
                td.classList.toggle("is-zero", val === 0);
                td.classList.toggle("is-pos", val > 0);
                td.classList.toggle("is-neg", val < 0);
            }
            // Cosplay/jury visuels (si MAJ côté ailleurs)
            const cb = $(".am-cb-cosplay", tr);
            if (cb) cb.checked = !!v?.cosplay;
            const rb = $(".am-rb-jury", tr);
            if (rb) rb.checked = !!v?.jury;
        });
    };
    onValue(liveRef, liveCb);
    unsubscribeLive = () => { try { off(liveRef, "value", liveCb); } catch {} };
}

export function closeAdjustmentsModal() {
    document.documentElement.classList.remove('am-modal-open');
    if (unsubscribeLive) { try { unsubscribeLive(); } catch {} unsubscribeLive = null; }
    const ov = $(".am-modal");
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
}

// Rendre accessible depuis control-panel.js (appel sans import)
window.openAdjustmentsModal = openAdjustmentsModal;
window.closeAdjustmentsModal = closeAdjustmentsModal;
