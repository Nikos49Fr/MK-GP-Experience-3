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

// ./js/team.js
import { app, dbFirestore, dbRealtime } from "./firebase-config.js";
import {
    getAuth,
    onAuthStateChanged,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
const auth = getAuth(app);
import {
    collection, getDocs, query, where, limit
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import {
    ref, onValue, set, update
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// Race-strip (viewer)
import { initRaceStrip } from "./ui/race-strip.js";

// Classement (auto-boot sur .classement-widget)
import "./ui/classement.js";

/* ============================================================
   Helpers
   ============================================================ */

async function ensureAnonymousAuth() {
    try {
        if (!auth.currentUser) {
            await signInAnonymously(auth);
        }
    } catch (err) {
        console.warn("[team] signInAnonymously failed:", err?.code || err);
    }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "dataset" && typeof v === "object") {
            Object.entries(v).forEach(([dk, dv]) => (el.dataset[dk] = dv));
        } else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null) continue;
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
}

function getParam(name) { return new URL(location.href).searchParams.get(name); }

function sortByOrderSafe(arr) {
    return [...arr].sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : 9999;
        const bo = Number.isFinite(b?.order) ? b.order : 9999;
        if (ao !== bo) return ao - bo;
        return (a?.name || "").localeCompare(b?.name || "");
    });
}

function splitPilotsByGame(pilots = []) {
    const mk8 = pilots.filter(p => (p.game || "").toUpperCase() === "MK8");
    const mkw = pilots.filter(p => (p.game || "").toUpperCase() === "MKW");
    return { mk8: sortByOrderSafe(mk8), mkw: sortByOrderSafe(mkw) };
}

function phaseGridSize(phase) { return phase === "mkw" ? 24 : 12; }
function activeCountForPhase(phase) { return phase === "mkw" ? 4 : 2; }

/**
 * Résolution d'assets (pour GitHub Pages ou paths BDD "./assets/...").
 * - Support d’un préfixe global optionnel window.__ASSET_BASE__ (ex: "/repo/").
 * - Normalise "./assets/..." -> "../assets/..." depuis /pages/.
 */
function resolveAssetUrl(path = "") {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;
    const base = (window.__ASSET_BASE__ || "");
    if (path.startsWith("./")) return base + "../" + path.slice(2); // ../assets/...
    if (path.startsWith("/")) return base + path.slice(1);
    return base + "../" + path;
}

// -- Pilot grid columns (2|3|4) pilotées par var CSS sur #active-pilots
function applyPilotGridColumns(phase, reveal = false) {
    const grid = $("#active-pilots");
    if (!grid) return;
    const cols = reveal ? 3 : (phase === "mk8" ? 2 : 4);
    grid.style.setProperty("--pilot-cols", String(cols));

    // (optionnel) états de confort si tu veux cibler en CSS
    grid.classList.toggle("mode-mk8", !reveal && phase === "mk8");
    grid.classList.toggle("mode-mkw", !reveal && phase === "mkw");
    grid.classList.toggle("mode-reveal", !!reveal);
}

function buildPilotCard(team, p) {
    const $card = h("article", { class: "pilot-card", "data-pilot": p.id });

    // Couleurs d’équipe (portées sur la card, pour être indépendantes du conteneur)
    if (team?.color1) $card.style.setProperty("--team-c1", team.color1);
    if (team?.color2) $card.style.setProperty("--team-c2", team.color2);

    const $photo = h("div", { class: "pilot-card__photo" },
        h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || "Pilote" })
    );

    const $meta = h("div", { class: "pilot-meta" },
        h("span", { class: "pilot-num" }, (p.num ?? "").toString().padStart(2, "0")),
        h("span", { class: "pilot-tag" }, p.tag || "")
    );

    const $info = h("div", { class: "pilot-card__info" },
        $meta,
        h("div", { class: "pilot-name" }, p.name || "—")
    );

    $card.appendChild($photo);
    $card.appendChild($info);
    return $card;
}

function getLeftPilotCardHeight() {
    const leftCard = document.querySelector("#team-pilots .pilot-card");
    return leftCard ? leftCard.offsetHeight : 127; // fallback
}

function syncActivePilotCardHeight() {
    const h = getLeftPilotCardHeight();
    const grid = $("#active-pilots");
    if (grid) grid.style.setProperty("--pilot-card-h", `${h}px`);
}

// -- Bonus helpers (fenêtre + UI) -------------------------------------------
function ensureInfoBanner() {
    const body = document.querySelector("#panel-center .panel__body");
    if (!body) return null;
    let banner = body.querySelector(".panel__info");
    if (!banner) {
        banner = h("div", { class: "panel__info", id: "info-banner", "aria-live": "polite" });
        body.insertBefore(banner, body.firstChild);
    }
    return banner;
}

function updateInfoBanner(phase, raceId, doublesLocked) {
    const banner = ensureInfoBanner();
    if (!banner) return;
    const isSurvival = isSurvivalRace(raceId);
    const isOpen = !doublesLocked && !isSurvival && !!phase && !!raceId;
    banner.hidden = !isOpen;
    if (isOpen) {
        banner.textContent = `Fenêtre bonus ouverte — Course ${raceId}. Active ton bonus avant la fin de la course.`;
    } else {
        banner.textContent = "";
    }
}

// Applique les états visuels du bouton Bonus pour chaque pilote
function updateBonusButtonsUI(phase, raceId, allowedMap, bonusUsageMap, doublesLocked, doublesMap) {
    const isSurvival = isSurvivalRace(raceId);
    document.querySelectorAll("#active-pilots .bonus-btn").forEach(btn => {
        const pid = btn.dataset.pilot;
        const used   = !!bonusUsageMap?.[pid];          // bonus déjà consommé (appliqué après finalisation)
        const locked = !!doublesLocked || isSurvival;   // fenêtre fermée OU survie
        const armed  = !!doublesMap?.[pid];             // armé pour la course courante
        const canWrite = !!allowedMap?.[pid];

        // États visuels (on permet .is-armed + .is-locked simultanément)
        btn.classList.toggle("is-used",   used);
        btn.classList.toggle("is-armed", !used && armed);
        btn.classList.toggle("is-locked",!used && locked);

        // Interaction
        const disabled = used || locked || !canWrite;
        btn.disabled = disabled;

        // Titres
        btn.title =
            used        ? "Bonus utilisé (appliqué)" :
            isSurvival  ? "Bonus indisponible en Survie" :
            (locked && armed) ? "Fenêtre fermée — bonus armé" :
            locked      ? "Fenêtre bonus fermée" :
            !canWrite   ? "Action non autorisée" :
                          "Activer/annuler le bonus pour cette course";
    });
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
   Header — nom d’équipe à côté du logo (sans augmenter la hauteur)
   ============================================================ */
function setHeaderTeamTitle(team) {
    const header = $("#app-header");
    const inner = header?.querySelector(".app-header__inner");
    if (!inner) return;

    // Couleurs (définies en CSS vars pour le SCSS)
    if (team?.color1) header.style.setProperty("--team-c1", team.color1);
    if (team?.color2) header.style.setProperty("--team-c2", team.color2);

    // Nettoyage d’une éventuelle ancienne version
    inner.querySelector(".app-header__title")?.remove();
    header.querySelector(".app-header__teamname")?.remove();

    const logoUrl = resolveAssetUrl(team?.urlLogo || "");
    const $title = h("div", { class: "app-header__title", role: "heading", "aria-level": "1" },
        h("img", {
            class: "team-title__logo",
            src: logoUrl,
            alt: team?.tag ? `Logo ${team.tag}` : "Logo équipe"
        }),
        h("span", { class: "team-title__text" },
            h("span", { class: "team-title__tag" }, team?.tag || ""),
            h("span", { class: "team-title__sep" }, "—"),
            h("span", { class: "team-title__name" }, team?.name || "")
        )
    );

    // Insertion au centre (absolu centré via SCSS)
    inner.appendChild($title);
}

/* ============================================================
   Colonne gauche — mini-cards (6 visibles sans scroll)
   ============================================================ */
function renderLeftColumn(team, pilots, phase = null) {
    const col = $("#team-pilots");
    if (!col) return;
    col.innerHTML = "";

    // Couleurs d’équipe pour la colonne (CSS vars)
    if (team?.color1) col.style.setProperty("--team-c1", team.color1);
    if (team?.color2) col.style.setProperty("--team-c2", team.color2);

    const { mk8, mkw } = splitPilotsByGame(pilots);

    // Par défaut (avant départ) : tous les 6 (ou moins).
    // Quand une phase est active : colonne = pilotes de l'autre jeu.
    let list = pilots;
    if (phase === "mk8") list = mkw;
    else if (phase === "mkw") list = mk8;

    list.forEach(p => {
        const card = h("article", { class: "pilot-card", "data-pilot": p.id },
            // Photo à gauche (pleine hauteur)
            h("div", { class: "pilot-card__photo" },
                h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || "Pilote" })
            ),
            // Infos à droite : ligne 1 = num + tag, ligne 2 = nom
            h("div", { class: "pilot-card__info" },
                h("div", { class: "pilot-meta" },
                    h("span", { class: "pilot-num" }, (p.num ?? "").toString().padStart(2, "0")),
                    h("span", { class: "pilot-tag" }, p.tag || "")
                ),
                h("div", { class: "pilot-name" }, p.name || "—")
            )
        );
        col.appendChild(card);
    });

    // Ajuste dynamiquement la hauteur pour 6 cards max, sans scroll
    fitLeftColumnForSixCards();
}

function fitLeftColumnForSixCards() {
    const panel = $("#panel-left");
    const list = $("#team-pilots");
    const header = panel?.querySelector(".panel__header");
    if (!panel || !list) return;

    const panelRect = panel.getBoundingClientRect();
    const headerH = header ? header.getBoundingClientRect().height : 0;
    // Limite dure à 800px d’espace utile (comme demandé)
    const available = Math.min(800, panelRect.height) - headerH - 8; // marge sécurité
    const rowH = Math.max(96, Math.floor(available / 6)); // garde un minimum visuel

    list.style.maxHeight = "800px";
    list.style.overflow = "hidden";
    list.style.display = "grid";
    list.style.gridAutoRows = `${rowH}px`;
}

/* ============================================================
   Colonne centrale — actifs + mosaïques 12/24 + bonus
   ============================================================ */
const activeTiles = new Map(); // pilotId -> { rootEl, gridSize }

function renderActivePilots(team, pilots, phase, allowed, finalized, ranks) {
    const host = $("#active-pilots");
    if (!host) return;
    host.innerHTML = "";
    activeTiles.clear(); // important : on repart propre

    // Détermine les pilotes actifs
    const getById = new Map(pilots.map(x => [x.id, x]));
    const allowedList = Object.keys(allowed || {})
        .filter(id => allowed[id])
        .map(id => getById.get(id))
        .filter(Boolean);

    let list = allowedList;
    if (list.length === 0) {
        const { mk8, mkw } = splitPilotsByGame(pilots);
        list = (phase === "mk8") ? mk8.slice(0, 2) : mkw.slice(0, 4);
    }

    const gridSize = phaseGridSize(phase);

    list.forEach((p) => {
        const $col = h("div", { class: "active-pilot-card", "data-pilot": p.id });

        // 1) Card pilote (identique col. gauche)
        const $pilotCard = buildPilotCard(team, p);
        $col.appendChild($pilotCard);

        // 2) Bonus
        const $bonus = h("div", { class: "bonus-bar" },
            h("button", { class: "bonus-btn", type: "button", "data-pilot": p.id },
                h("span", { class: "bonus-label" }, "Bonus"),
                h("span", { class: "bonus-badge" }, "x2")
            )
        );
        $col.appendChild($bonus);

        // 3) Mosaïque (enregistrée dans activeTiles + clic -> RTDB)
        const myRank = Number(ranks?.[p.id]?.rank ?? ranks?.[p.id] ?? null);
        const $tiles = buildTiles(p.id, phase, gridSize, myRank, !!allowed?.[p.id], finalized);
        $col.appendChild($tiles);

        host.appendChild($col);
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

        // Clic = set/unset rank dans RTDB
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            const next = (myRank === r) ? null : r;
            try {
                await set(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), { rank: next });
            } catch (e) {
                console.error("[team] set rank error", e);
            }
        });

        root.appendChild(btn);
    }

    // Registre pour mise à jour visuelle via updateTilesState
    activeTiles.set(pilotId, { rootEl: root, gridSize });
    return root;
}

/* ============================================================
   Mise à jour mosaïques
   ============================================================ */
function updateTilesState(phase, currentRanks = {}, allowedMap = {}, finalized = false) {
    const gridSize = phaseGridSize(phase);

    // Comptes & ensembles de choix par rang
    const chosenByRank = Array.from({ length: gridSize + 1 }, () => new Set());
    for (const [pid, val] of Object.entries(currentRanks || {})) {
        const n = Number(val?.rank ?? val);
        if (Number.isFinite(n) && n >= 1 && n <= gridSize) chosenByRank[n].add(pid);
    }

    const conflicts = new Set();
    let filledCount = 0;
    for (let r = 1; r <= gridSize; r++) {
        const c = chosenByRank[r].size;
        if (c > 0) filledCount++;
        if (c >= 2) conflicts.add(r);
    }
    const allFilled = (filledCount === gridSize);
    const noConflict = (conflicts.size === 0);
    const isCompleteOk = allFilled && noConflict;

    // Parcourt seulement les mosaïques présentes à l'écran
    activeTiles.forEach(({ rootEl }, pilotId) => {
        const myRank = Number(currentRanks?.[pilotId]?.rank ?? currentRanks?.[pilotId] ?? null);

        // État conteneur
        rootEl.classList.toggle("tiles--all-filled", allFilled);
        rootEl.classList.toggle("tiles--ok", isCompleteOk);
        rootEl.classList.toggle("tiles--has-conflict", conflicts.size > 0);

        // Boutons (tuiles)
        rootEl.querySelectorAll(".race-tile").forEach(btn => {
            const rank = Number(btn.dataset.rank);
            // reset classes
            btn.classList.remove(
                "is-blank", "is-self", "is-other", "is-conflict-self", "is-conflict-other"
            );

            // disabled selon finalized/allowed
            btn.disabled = finalized || !allowedMap?.[pilotId];

            const c = chosenByRank[rank].size;
            const iAmOnThisRank = (myRank === rank);

            // Priorité: red (self conflict) > blue (self) > yellow (other conflict) > green (other) > white
            if (iAmOnThisRank && c >= 2) {
                btn.classList.add("is-conflict-self");      // rouge
            } else if (iAmOnThisRank && c === 1) {
                btn.classList.add("is-self");               // bleu
            } else if (!iAmOnThisRank && c >= 2) {
                btn.classList.add("is-conflict-other");     // jaune
            } else if (!iAmOnThisRank && c === 1) {
                btn.classList.add("is-other");              // vert
            } else {
                btn.classList.add("is-blank");              // blanc
            }
        });
    });
}

/* ============================================================
   Bonus — état initial + clic (doubled:true), bloqué en S/SF
   ============================================================ */
function isSurvivalRace(raceId) { return raceId === "S" || raceId === "SF"; }

async function wireBonusButtonsInitial(team, phase, activePilots) {
    // Si des points existent déjà (bonus déjà utilisé), on reflète l'état visuel
    const ctxSnap = await new Promise(res =>
        onValue(ref(dbRealtime, "context/current"), s => res(s.val()), { onlyOnce: true })
    );
    const raceId = ctxSnap?.raceId;
    if (!phase || !raceId) return;

    activePilots.forEach(async (p) => {
        const path = `live/points/${phase}/byRace/${raceId}/${p.id}`;
        onValue(ref(dbRealtime, path), (snap) => {
            const val = snap.val() || {};
            const btn = $(`.bonus-btn[data-pilot="${p.id}"]`);
            if (!btn) return;
            if (val.doubled) {
                btn.classList.add("is-used");
                btn.disabled = true;
            } else {
                btn.classList.remove("is-used");
                btn.disabled = isSurvivalRace(raceId); // interdit en S/SF
            }
        });
    });
}

function wireBonusButtons(phase, raceId, allowedMap, doublesLocked, doublesMap) {
    $("#active-pilots")?.querySelectorAll(".bonus-btn").forEach(btn => {
        const pid = btn.dataset.pilot;
        btn.onclick = async () => {
            // garde-fous runtime
            if (!phase || !raceId || isSurvivalRace(raceId)) return;
            if (btn.disabled) return;

            // toggle armement : /live/results/{phase}/byRace/{raceId}/doubles/{pilotId}
            const path = `live/results/${phase}/byRace/${raceId}/doubles/${pid}`;
            const isArmedNow = btn.classList.contains("is-armed") || !!doublesMap?.[pid];
            try {
                if (isArmedNow) {
                    await set(ref(dbRealtime, path), null);   // désarmer = delete
                } else {
                    await set(ref(dbRealtime, path), true);   // armer
                }
            } catch (e) {
                console.error("[team] bonus toggle error", e);
            }
        };
    });
}

/* ============================================================
   Subscriptions — context / phase deps (allowed, current, finalized)
   ============================================================ */
function subContext(cb) {
    return onValue(ref(dbRealtime, "context/current"), snap => cb(snap.val() || null));
}
function subAllowed(phase, cb) {
    return onValue(ref(dbRealtime, `meta/pilotsAllowed/${phase}`), s => cb(s.val() || {}));
}
function subCurrent(phase, cb) {
    return onValue(ref(dbRealtime, `live/results/${phase}/current`), s => cb(s.val() || {}));
}
function subFinalized(phase, raceId, cb) {
    return onValue(ref(dbRealtime, `live/races/${phase}/${raceId}`), s => cb(!!(s.val()?.finalized)));
}
function subByRace(phase, raceId, cb) {
    return onValue(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}`), s => cb(s.val() || {}));
}
function subBonusUsage(phase, cb) {
    return onValue(ref(dbRealtime, `live/results/${phase}/bonusUsage`), s => cb(s.val() || {}));
}

/* ============================================================
   INIT
   ============================================================ */
(async function init() {
    // --- Assure une session avant toute lecture RTDB, sans "downgrader" un compte Google ---
    // Idée : on attend d'abord la restauration éventuelle d'une session Google.
    // Si, après un court délai, il n'y a toujours aucun user, on bascule en anonyme.
    await new Promise((resolve) => {
        let resolved = false;

        const off = onAuthStateChanged(auth, async (user) => {
            off();
            if (!resolved) {
                resolved = true;
                // Si un user (Google) est déjà là, on démarre immédiatement.
                resolve();
            }
        });

        // Petit délai de grâce pour laisser le temps à la session Google de se restaurer
        setTimeout(async () => {
            if (!resolved) {
                // Heuristique : si on voit un email stocké (accueil), on prolonge un peu l'attente
                const maybeAdminEmail = localStorage.getItem("mk_user_email");
                if (maybeAdminEmail) {
                    // On attend encore un peu avant de tenter l'anonyme
                    setTimeout(async () => {
                        if (!auth.currentUser) {
                            try { await signInAnonymously(auth); } catch (e) { console.warn("[team] anon fallback failed:", e); }
                        }
                        if (!resolved) { resolved = true; resolve(); }
                    }, 400); // 400 ms additionnels
                } else {
                    // Pas d'indice admin → on tente directement l'anonyme
                    if (!auth.currentUser) {
                        try { await signInAnonymously(auth); } catch (e) { console.warn("[team] anon fallback failed:", e); }
                    }
                    if (!resolved) { resolved = true; resolve(); }
                }
            }
        }, 300); // 300 ms de grâce initiale
    });

    const tag = getParam("id");
    if (!tag) {
        $("#content").innerHTML = "<p class='muted'>Paramètre ?id=TAG manquant.</p>";
        return;
    }

    try {
        const team = await loadTeamByTag(tag);
        if (!team) {
            $("#content").innerHTML = `<p class='muted'>Équipe introuvable pour le tag "${tag}".</p>`;
            return;
        }
        const pilots = await loadPilotsForTeam(team.name);
        setHeaderTeamTitle(team);
        renderLeftColumn(team, pilots, null);

        // Race-strip viewer (piloté par Firebase)
        const stripHost = $("#race-strip-host");
        const strip = initRaceStrip(stripHost, { mode: "viewer", controller: "firebase" });
        // strip.ready?.then(() => { /* ok */ });

        // State local
        let phase = null, raceId = null;
        let allowed = {}, ranks = {}, finalized = false;
        let doublesLocked = true;      // fenêtre fermée par défaut
        let doubles = {};              // { pilotId: true }
        let bonusUsage = {};           // { pilotId: raceId }

        // Unsubs
        let unAllowed = null, unCurrent = null, unFinalized = null, unByRace = null, unUsage = null;
        const resubPhaseDeps = () => {
            if (typeof unAllowed === "function") unAllowed(); unAllowed = null;
            if (typeof unCurrent === "function") unCurrent(); unCurrent = null;
            if (typeof unFinalized === "function") unFinalized(); unFinalized = null;
            if (typeof unByRace === "function") unByRace(); unByRace = null;
            if (typeof unUsage === "function") unUsage(); unUsage = null;

            if (!phase) return;

            unAllowed = subAllowed(phase, (v) => {
                allowed = v || {};
                updateTilesState(phase, ranks, allowed, finalized);
                updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                // ⬇️ Re-render des pilotes actifs dès que la whitelist change pour la phase courante
                renderActivePilots(team, pilots, phase, allowed, finalized, ranks);
                applyPilotGridColumns(phase, /* reveal */ false);
                wireBonusButtons(phase, raceId, allowed, doublesLocked, doubles);
                syncActivePilotCardHeight();
            });

            unCurrent = subCurrent(phase, (v) => {
                // Tolère {pilotId:n} et {pilotId:{rank:n}}
                ranks = v || {};
                updateTilesState(phase, ranks, allowed, finalized);
            });

            if (raceId) {
                unFinalized = subFinalized(phase, raceId, (v) => {
                    finalized = !!v;
                    updateTilesState(phase, ranks, allowed, finalized);
                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                });

                unByRace = subByRace(phase, raceId, (v) => {
                    doublesLocked = !!v?.doublesLocked;     // undefined => false ? on choisit "fermé" par défaut
                    doubles = v?.doubles || {};
                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                    updateInfoBanner(phase, raceId, doublesLocked);
                });
            }

            unUsage = subBonusUsage(phase, (v) => {
                bonusUsage = v || {};
                updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
            });
        };

        // Contexte global
        subContext((ctx) => {
            if (!ctx || !ctx.phase) {
                phase = null; raceId = null;
                renderLeftColumn(team, pilots, null);
                syncActivePilotCardHeight();
                $("#active-pilots").innerHTML = "";
                applyPilotGridColumns("mk8", /* reveal */ false);
                updateInfoBanner(null, null, true);
                updateBonusButtonsUI(null, null, {}, {}, true, {});
                resubPhaseDeps();
                return;
            }

            const nextPhase = (String(ctx.phase).toLowerCase() === "mkw") ? "mkw" : "mk8";
            const nextRaceId = String(ctx.raceId ?? "1");
            const phaseChanged = phase !== nextPhase;
            const raceChanged = raceId !== nextRaceId;
            phase = nextPhase; raceId = nextRaceId;
            // ⬇️ On purge les caches locaux pour éviter d'utiliser les valeurs MK8 en MKW
            if (phaseChanged) {
                allowed = {};
                ranks = {};
            }

            renderLeftColumn(team, pilots, phase);
            syncActivePilotCardHeight();
            renderActivePilots(team, pilots, phase, allowed, finalized, ranks);
            applyPilotGridColumns(nextPhase, /* reveal */ false);
            wireBonusButtons(phase, raceId, allowed, doublesLocked, doubles);
            updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
            updateInfoBanner(phase, raceId, doublesLocked);
            updateTilesState(phase, ranks, allowed, finalized);

            if (phaseChanged || raceChanged) resubPhaseDeps();
        });

        // Ajustement "six cartes sans scroll" au resize
        window.addEventListener("resize", () => {
            fitLeftColumnForSixCards();
            syncActivePilotCardHeight();
        });

    } catch (err) {
        console.error("[team] init error:", err);
        $("#content").innerHTML = `<p class='muted'>Erreur de chargement.</p>`;
    }
})();
