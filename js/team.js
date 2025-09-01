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
    ref, onValue, set, get, goOnline, goOffline
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// Race-strip (viewer)
import { initRaceStrip } from "./ui/race-strip.js";

// Classement (auto-boot sur .classement-widget)
import "./ui/classement.js";

/* ============================================================
   Helpers
   ============================================================ */
function applyTeamThemeVars(team) {
    const root = document.documentElement;
    const c1 = team?.color1 || "#ffd166";
    const c2 = team?.color2 || "#06d6a0";
    root.style.setProperty("--team-c1", c1);
    root.style.setProperty("--team-c2", c2);
}

const $ = (sel, root = document) => root.querySelector(sel);

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

/**
 * Résolution d'assets depuis n'importe quelle page (local + GitHub Pages).
 * - BDD stocke typiquement "./assets/images/…"
 * - Si on est sous /pages/, on remonte d’un cran → "../assets/…"
 * - Sinon on reste relatif à la racine du site → "assets/…"
 * - URLs absolues (http/https) inchangées.
 */
function resolveAssetUrl(path = "") {
    if (!path) return "";
    if (/^https?:\/\//i.test(path)) return path;

    // Normalise l’input: enlève "./" et les "/" initiaux
    let clean = String(path)
        .replace(/^\.\//, "")   // "./assets/…" -> "assets/…"
        .replace(/^\/+/, "");   // "/assets/…"   -> "assets/…"

    // Si la BDD a mis autre chose que "assets/…", on force le préfixe "assets/"
    if (!/^assets\//i.test(clean)) clean = `assets/${clean}`;

    // Sommes-nous dans /pages/ ? → on remonte d’un niveau
    const inPages = window.location.pathname.includes("/pages/");
    const prefix = inPages ? "../" : "";

    return prefix + clean;
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

    // Couleurs d’équipe sur la card (indépendant du conteneur)
    if (team?.color1) $card.style.setProperty("--team-c1", team.color1);
    if (team?.color2) $card.style.setProperty("--team-c2", team.color2);

    // Photo
    const $photo = h("div", { class: "pilot-card__photo" },
        h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || "Pilote" })
    );

    // Bloc texte (nom uniquement)
    const $info = h("div", { class: "pilot-card__info" },
        h("div", { class: "pilot-name" }, p.name || "—")
    );

    // Badges (num + tag) — au même niveau que photo/info
    const $meta = h("div", { class: "pilot-meta" },
        h("span", { class: "pilot-num" }, (p.num ?? "").toString().padStart(2, "0")),
        h("span", { class: "pilot-tag" }, p.tag || "")
    );

    $card.appendChild($photo);
    $card.appendChild($info);
    $card.appendChild($meta);

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
function updateInfoBanner(phase, raceId, doublesLocked) {
    const el = document.getElementById("info-banner");
    if (!el) return;

    // Si pas de phase → masquer
    if (!phase) {
        el.hidden = true;
        el.textContent = "";
        el.classList.remove("is-open", "is-locked");
        return;
    }

    // Affiche seulement quand la fenêtre bonus est ouverte
    const open = (doublesLocked === false);
    el.hidden = !open;
    el.textContent = open ? "Fenêtre bonus ouverte : vous pouvez armer votre bonus pour la course en cours." : "";
    el.classList.toggle("is-open", open);
    el.classList.toggle("is-locked", !open);
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

// ---- Reveal (RTDB) ----
function subReveal(cb) {
    return onValue(ref(dbRealtime, "context/reveal"), snap => {
        const v = snap.val() || {};
        cb(!!v.enabled);
    });
}

// ---- Fetch pilotes MKW mappés par secretTeamName (pour REVEAL) ----
async function loadSecretMkwPilotsForTeam(teamName) {
    if (!teamName) return [];
    const q = query(
        collection(dbFirestore, "pilots"),
        where("secretTeamName", "==", teamName),
        where("game", "==", "MKW")
    );
    const snap = await getDocs(q);
    return sortByOrderSafe(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

// ---- Rendu centre selon phase + reveal (évite d’alourdir subContext) ----
function renderCenterForPhase(team, pilotsDefault, phase, allowed, finalized, ranks, revealEnabled) {
    // MK8 → inchangé
    if (phase === "mk8" || !revealEnabled) {
        renderActivePilots(team, pilotsDefault, phase, allowed, finalized, ranks);
        applyPilotGridColumns(phase, /* reveal */ false);
        return;
    }
    // MKW + reveal → 3 pilotes issus de secretTeamName
    loadSecretMkwPilotsForTeam(team.name).then((mkwSecretPilots) => {
        const pool = Array.isArray(mkwSecretPilots) ? mkwSecretPilots : [];
        renderActivePilots(team, pool, "mkw", allowed, finalized, ranks);
        applyPilotGridColumns("mkw", /* reveal */ true);
    }).catch(() => {
        // fallback (sécurité)
        renderActivePilots(team, pilotsDefault, "mkw", allowed, finalized, ranks);
        applyPilotGridColumns("mkw", /* reveal */ false);
    });
}

// ---- Fetch pilotes MK8 mappés par secretTeamName (pour REVEAL, colonne gauche) ----
async function loadSecretMk8PilotsForTeam(teamName) {
    if (!teamName) return [];
    const q = query(
        collection(dbFirestore, "pilots"),
        where("secretTeamName", "==", teamName),
        where("game", "==", "MK8")
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // tri par 'order' si dispo
    return typeof sortByOrderSafe === "function"
        ? sortByOrderSafe(rows)
        : rows.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
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
async function renderLeftColumn(team, pilots, phase = null, revealOn = false) {
    const col = $("#team-pilots");
    if (!col) return;
    col.innerHTML = "";

    // Couleurs d’équipe (CSS vars sur la colonne)
    if (team?.color1) col.style.setProperty("--team-c1", team.color1);
    if (team?.color2) col.style.setProperty("--team-c2", team.color2);

    const { mk8, mkw } = splitPilotsByGame(pilots);

    // Par défaut : liste d’origine
    let list = pilots;

    if (phase === "mk8") {
        // En phase MK8, on affiche les MKW (comportement historique)
        list = mkw;
    } else if (phase === "mkw") {
        // En phase MKW, on affiche les MK8
        if (revealOn) {
            // REVEAL : on ajoute les MK8 dont secretTeamName === team.name (agents double)
            let base = mk8.slice();
            try {
                const extras = await loadSecretMk8PilotsForTeam(team.name); // helper déjà ajouté
                if (Array.isArray(extras) && extras.length) {
                    const seen = new Set(base.map(p => p.id));
                    for (const p of extras) {
                        if (!seen.has(p.id)) {
                            base.push(p);
                            seen.add(p.id);
                        }
                    }
                    // tri final par order (cohérent avec ta helper)
                    base = sortByOrderSafe(base);
                }
            } catch {
                // fallback: on garde base
            }
            list = base;
        } else {
            // Pas de reveal : MK8 de l’équipe par teamName (ton comportement d’origine)
            list = mk8;
        }
    } else {
        // Pas de phase (avant départ) : tous
        list = pilots;
    }

    // Rendu mini-cards (inchangé)
    list.forEach(p => {
        const card = h("article", { class: "pilot-card", "data-pilot": p.id },
            // Photo
            h("div", { class: "pilot-card__photo" },
                h("img", { src: resolveAssetUrl(p.urlPhoto || ""), alt: p.name || "Pilote" })
            ),
            // Infos (nom)
            h("div", { class: "pilot-card__info" },
                h("div", { class: "pilot-name" }, p.name || "—")
            ),
            // Badges (num + tag) — sortis de __info
            h("div", { class: "pilot-meta" },
                h("span", { class: "pilot-num" }, (p.num ?? "").toString().padStart(2, "0")),
                h("span", { class: "pilot-tag" }, p.tag || "")
            )
        );
        // ⚠️ Filigrane "Agent double" UNIQUEMENT pendant le reveal
        if (revealOn && String(p.traitorMode || "").toLowerCase() === "double") {
            card.appendChild(h("div", { class: "pilot-badge pilot-badge--double" }, "Agent double"));
        }
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
                //h("span", { class: "bonus-badge" }, "")
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

    // Enregistre la mosaïque + rang initial (sera tenu à jour par updateTilesState)
    activeTiles.set(pilotId, { rootEl: root, gridSize, lastRank: Number.isFinite(myRank) ? myRank : null });

    for (let r = 1; r <= gridSize; r++) {
        const btn = h("button", {
            class: "race-tile is-blank",
            type: "button",
            "data-rank": r,
            disabled: finalized || !allowed
        }, String(r));

        // Clic = set/unset rank dans RTDB (toggle si on reclic la même tuile)
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;

            // Récupère le rang courant *à jour* depuis le registre
            const rec = activeTiles.get(pilotId);
            const current = Number.isFinite(rec?.lastRank) ? rec.lastRank : null;
            const next = (current === r) ? null : r;

            try {
                await set(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), (next == null ? { rank: null } : { rank: next }));
            } catch (e) {
                console.error("[team] set rank error", e);
            }
        });

        root.appendChild(btn);
    }

    return root;
}

function renderActivePilotsEnded(team, pilots, phase, allowed, finalRanks) {
    const host = $("#active-pilots");
    if (!host) return;
    host.innerHTML = "";

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

    list.forEach((p) => {
        const $col = h("div", { class: "active-pilot-card", "data-pilot": p.id });

        // 1) Card pilote (identique au panel gauche)
        const $pilotCard = buildPilotCard(team, p);
        $col.appendChild($pilotCard);

        // 2) Rang final de phase (agrégé)
        const pos = (finalRanks && finalRanks[p.id]) || null;
        const label = (pos === 1) ? "1st"
                   : (pos === 2) ? "2nd"
                   : (pos === 3) ? "3rd"
                   : (Number.isFinite(pos) ? `${pos}th` : "—");

        const res = h("div", { class: "phase-result" }, label);
        $col.appendChild(res);

        host.appendChild($col);
    });
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
    activeTiles.forEach((rec, pilotId) => {
        const { rootEl } = rec;
        const myRank = Number(currentRanks?.[pilotId]?.rank ?? currentRanks?.[pilotId] ?? null);

        // 🔁 Mémorise le dernier rang connu pour ce pilote (utilisé par le handler de clic)
        rec.lastRank = Number.isFinite(myRank) ? myRank : null;

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

function wireBonusButtons(phase, raceId, allowedMap, doublesLocked, doublesMap) {
    $("#active-pilots")?.querySelectorAll(".bonus-btn").forEach(btn => {
        const pid = btn.dataset.pilot;
        btn.onclick = async () => {
            // garde-fous runtime
            if (!phase || !raceId || isSurvivalRace(raceId)) return;
            if (btn.disabled) return;

            // toggle armement : /live/results/{phase}/byRace/{raceId}/doubles/{pilotId}
            const path = `live/results/${phase}/byRace/${raceId}/doubles/${pid}`;
            const isArmedNow = btn.classList.contains("is-armed");
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
        applyTeamThemeVars(team);
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
        let revealEnabled = false;
        // Gel d'UI : fige la colonne centrale en "fin de phase" jusqu'au changement de phase
        let freezeCenter = false;
        let finalRanksByPilot = {};   // { pilotId: 1..N }
        let unTotals = null;          // unsub listener des totaux de la phase
        let initFreezeKnown = true;   // au boot: true (sera remis à false lors d’un changement de phase/course)

        // ============================================================
        // Résilience RTDB (reco/refresh) + logs horodatés
        // ============================================================
        const RES = {
            lastEventAt: Date.now(),
            unsubConnected: null,
            watchdogId: null
        };

        function nowHHMMSS() {
            const d = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
        function markEvent() { RES.lastEventAt = Date.now(); }

        async function syncNow(reason = "manual") {
            try {
                // 1) Contexte
                const sCtx = await get(ref(dbRealtime, "context/current"));
                const ctx = sCtx.val() || {};
                const nextPhase  = (String(ctx.phase || "mk8").toLowerCase() === "mkw") ? "mkw" : "mk8";
                const nextRaceId = ctx.raceId != null && ctx.raceId !== "" ? String(ctx.raceId).toUpperCase() : null;

                const phaseChanged = (phase !== nextPhase);
                const raceChanged  = (raceId !== nextRaceId);

                phase  = nextPhase;
                raceId = nextRaceId;

                // 2) Reveal
                const sRev = await get(ref(dbRealtime, "context/reveal"));
                const rv = sRev.val() || {};
                const revealNow = !!rv.enabled;
                if (revealEnabled !== revealNow) revealEnabled = revealNow;

                // 3) Déterminer gel fin de phase
                initFreezeKnown = false;
                try {
                    const sR = await get(ref(dbRealtime, `live/races/${phase}`));
                    const racesObj = sR.val() || {};
                    const lastKey = (phase === "mk8") ? "8" : "SF";
                    freezeCenter = !!(racesObj?.[lastKey]?.finalized);
                } catch {} finally {
                    initFreezeKnown = true;
                }

                // 4) Relancer les souscriptions phase-dépendantes si besoin
                if (phaseChanged || raceChanged) resubPhaseDeps();

                // 5) Snaps clés pour l’état courant (évite d’attendre des events)
                const [sAllowed, sCurrent, sUsage, sByRace] = await Promise.all([
                    get(ref(dbRealtime, `meta/pilotsAllowed/${phase}`)),
                    get(ref(dbRealtime, `live/results/${phase}/current`)),
                    get(ref(dbRealtime, `live/results/${phase}/bonusUsage`)),
                    raceId ? get(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}`)) : Promise.resolve({ val:()=>null })
                ]);

                allowed = sAllowed.val() || {};
                ranks   = sCurrent.val() || {};
                bonusUsage = sUsage.val() || {};
                {
                    const br = (typeof sByRace.val === "function") ? (sByRace.val() || {}) : {};
                    doublesLocked = !!br?.doublesLocked;
                    const dset = new Set();
                    const doublesObj = br?.doubles || {};
                    Object.keys(doublesObj).forEach(pid => { if (doublesObj[pid] === true) dset.add(pid); });
                    doubles = Object.fromEntries(Array.from(dset).map(x => [x, true]));
                }

                // 6) Rendu (gauche + centre)
                renderLeftColumn(team, pilots, phase, /* revealOn */ (phase === "mkw" && revealEnabled));
                syncActivePilotCardHeight();
                if (freezeCenter) {
                    // Totaux → rangs finaux
                    try {
                        const st = await get(ref(dbRealtime, `live/points/${phase}/byRace`));
                        const root = st.val() || {};
                        const totals = new Map();
                        for (const perRace of Object.values(root)) {
                            if (!perRace || typeof perRace !== "object") continue;
                            for (const [pid, obj] of Object.entries(perRace)) {
                                const pts = Number(obj?.final ?? 0);
                                if (!Number.isFinite(pts)) continue;
                                totals.set(pid, (totals.get(pid) || 0) + pts);
                            }
                        }
                        const sorted = Array.from(totals.entries())
                            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
                        const rankMap = {};
                        let pos = 1; for (const [pid] of sorted) rankMap[pid] = pos++;
                        finalRanksByPilot = rankMap;
                    } catch {}
                    renderActivePilotsEnded(team, pilots, phase, allowed, finalRanksByPilot);
                    updateInfoBanner(null, null, true);
                } else {
                    renderCenterForPhase(team, pilots, phase, allowed, /*finalized*/ false, ranks, revealEnabled);
                    wireBonusButtons(phase, raceId, allowed, doublesLocked, doubles);
                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                    updateInfoBanner(phase, raceId, doublesLocked);
                    updateTilesState(phase, ranks, allowed, /*finalized*/ false);
                }

                console.log(`[team] resync done (${reason}) @ ${nowHHMMSS()}`);
            } catch (e) {
                console.warn("[team] syncNow error:", e);
            }
        }

        function setupResilience() {
            // .info/connected → logs + resync à la reconnexion
            try {
                const infoRef = ref(dbRealtime, ".info/connected");
                RES.unsubConnected = onValue(infoRef, (snap) => {
                    const isConn = !!snap.val();
                    if (isConn) {
                        console.log(`[team] RTDB connected @ ${nowHHMMSS()}`);
                        markEvent();
                        syncNow("connected");
                    } else {
                        console.log(`[team] RTDB disconnected @ ${nowHHMMSS()}`);
                    }
                });
            } catch (e) {
                console.warn("[team] setupResilience .info/connected:", e);
            }

            // Visibilité → resync au retour visible
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    console.log(`[team] tab visible → resync @ ${nowHHMMSS()}`);
                    syncNow("visible");
                }
            });

            // Réseau navigateur
            window.addEventListener("online", () => {
                console.log(`[team] navigator online → goOnline+resync @ ${nowHHMMSS()}`);
                try { goOnline(dbRealtime); } catch {}
                syncNow("online");
            });
            window.addEventListener("offline", () => {
                console.log(`[team] navigator offline @ ${nowHHMMSS()}`);
            });

            // Watchdog anti-sommeil (1 min) : si >2 min sans event & onglet visible → cycle connexion + resync
            if (RES.watchdogId) { clearInterval(RES.watchdogId); RES.watchdogId = null; }
            RES.watchdogId = setInterval(() => {
                const idleMs = Date.now() - RES.lastEventAt;
                if (document.visibilityState === "visible" && idleMs > 120000) {
                    console.log(`[team] watchdog: stale ${Math.round(idleMs/1000)}s → cycle conn @ ${nowHHMMSS()}`);
                    try {
                        goOffline(dbRealtime);
                        setTimeout(() => {
                            try { goOnline(dbRealtime); } catch {}
                            syncNow("watchdog");
                        }, 250);
                    } catch (e) {
                        console.warn("[team] watchdog error:", e);
                    }
                }
            }, 60000);
        }

        function isLastRaceOfPhase(p, rid) {
            const ph = String(p || '').toLowerCase();
            const r  = String(rid || '').toUpperCase();
            return (ph === 'mk8' && r === '8') || (ph === 'mkw' && r === 'SF');
        }
        function lastRaceKeyOfPhase(p) {
            const ph = String(p || '').toLowerCase();
            return (ph === 'mk8') ? '8' : 'SF';
        }

        // Unsubs
        let unAllowed = null, unCurrent = null, unFinalized = null, unByRace = null, unUsage = null;
        const resubPhaseDeps = () => {
            if (typeof unAllowed === "function") unAllowed(); unAllowed = null;
            if (typeof unCurrent === "function") unCurrent(); unCurrent = null;
            if (typeof unFinalized === "function") unFinalized(); unFinalized = null;
            if (typeof unByRace === "function") unByRace(); unByRace = null;
            if (typeof unUsage === "function") unUsage(); unUsage = null;
            if (typeof unTotals === "function")   unTotals();   unTotals = null;

            if (!phase) return;

            unAllowed = subAllowed(phase, (v) => {
                markEvent();
                allowed = v || {};

                // Tant que l’on ne sait pas si on doit geler, ne pas rendre.
                if (!initFreezeKnown) return;
                // Si la phase est terminée, on ne re-rend rien au centre
                if (freezeCenter) {
                    renderActivePilotsEnded(team, pilots, phase, allowed, finalRanksByPilot);
                    updateInfoBanner(null, null, true);
                    return;
                }

                // 1) (Re)crée les colonnes actives AVANT d'appliquer les états
                renderActivePilots(team, pilots, phase, allowed, finalized, ranks);
                applyPilotGridColumns(phase, /* reveal */ false);
                wireBonusButtons(phase, raceId, allowed, doublesLocked, doubles);
                syncActivePilotCardHeight();

                // 2) Puis applique les états (tiles + bonus) sur le DOM fraîchement recréé
                updateTilesState(phase, ranks, allowed, finalized);
                updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
            });

            unCurrent = subCurrent(phase, (v) => {
                markEvent();
                // Tolère {pilotId:n} et {pilotId:{rank:n}}
                ranks = v || {};
                updateTilesState(phase, ranks, allowed, finalized);
            });

            if (raceId) {
                unFinalized = subFinalized(phase, raceId, (v) => {
                    markEvent();
                    finalized = !!v;

                    // Mises à jour visuelles de base (n’affectent pas la structure centrale)
                    updateTilesState(phase, ranks, allowed, finalized);
                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);

                    // Si dernière course finalisée → geler l'UI
                    if (finalized && isLastRaceOfPhase(phase, raceId)) {
                        freezeCenter = true;
                        renderActivePilotsEnded(team, pilots, phase, allowed, finalRanksByPilot);
                        updateInfoBanner(null, null, true); // bandeau masqué
                    } else {
                        // NE PAS dé-geler ici : le dégèle se fait uniquement au changement de phase
                        updateInfoBanner(phase, raceId, doublesLocked);
                    }
                });

                unByRace = subByRace(phase, raceId, (v) => {
                    markEvent();
                    doublesLocked = !!v?.doublesLocked;
                    doubles = v?.doubles || {};

                    if (freezeCenter) {
                        // Fin de phase : on maintient le rendu final et masque le bandeau
                        updateInfoBanner(null, null, true);
                        return;
                    }
                    
                    // Si on n’a pas encore décidé du gel (boot), on ne rend rien
                    if (!initFreezeKnown) return;

                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                    updateInfoBanner(phase, raceId, doublesLocked);
                });
            }

            unUsage = subBonusUsage(phase, (v) => {
                markEvent();
                bonusUsage = v || {};
                updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
            });

            // Reveal (global) → influe uniquement sur le centre en MKW
            subReveal((en) => {
                markEvent();
                revealEnabled = !!en;
                // adapte le nombre de colonnes au cas où
                applyPilotGridColumns(phase || "mk8", revealEnabled && phase === "mkw");
                // re-rendre le centre si une phase est active
                if (phase) {
                    renderCenterForPhase(team, pilots, phase, allowed, finalized, ranks, revealEnabled);
                }
            });

            // ⬇️ NOUVEAU : agrégation des points de phase -> rangs finaux
            unTotals = onValue(ref(dbRealtime, `live/points/${phase}/byRace`), (snap) => {
                markEvent();
                const root = snap.val() || {};

                // Somme des points "final" par pilote
                const totals = new Map(); // pilotId -> total points
                for (const perRace of Object.values(root)) {
                    if (!perRace || typeof perRace !== "object") continue;
                    for (const [pid, obj] of Object.entries(perRace)) {
                        const pts = Number(obj?.final ?? 0);
                        if (!Number.isFinite(pts)) continue;
                        totals.set(pid, (totals.get(pid) || 0) + pts);
                    }
                }

                // Classement global (desc par points, tie-break simple par id)
                const sorted = Array.from(totals.entries())
                    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));

                const rankMap = {};
                let pos = 1;
                for (const [pid] of sorted) rankMap[pid] = pos++;
                finalRanksByPilot = rankMap;

                // Si on est dans l'état gelé (fin de phase), on re-rend la vue finale avec les bons rangs
                if (freezeCenter) {
                    renderActivePilotsEnded(team, pilots, phase, allowed, finalRanksByPilot);
                }
            });
        };

        // Contexte global
        subContext((ctx) => {
            markEvent();
            // Aucun contexte actif → reset complet
            if (!ctx || !ctx.phase) {
                freezeCenter = false;
                initFreezeKnown = true;
                phase = null; raceId = null;

                renderLeftColumn(team, pilots, null, /* revealOn */ false);
                syncActivePilotCardHeight();
                $("#active-pilots").innerHTML = "";
                applyPilotGridColumns("mk8", /* reveal */ false);
                updateInfoBanner(null, null, true);
                updateBonusButtonsUI(null, null, {}, {}, true, {});
                resubPhaseDeps();
                return;
            }

            // Phase / course courantes issues du contexte
            const nextPhase  = (String(ctx.phase).toLowerCase() === "mkw") ? "mkw" : "mk8";
            const nextRaceId = String(ctx.raceId ?? "1");

            const phaseChanged = (phase !== nextPhase);
            const raceChanged  = (raceId !== nextRaceId);

            // Applique la nouvelle phase/course
            phase  = nextPhase;
            raceId = nextRaceId;

            // Changement de phase → dé-gel & reset caches
            if (phaseChanged) {
                freezeCenter = false;
                allowed = {};
                ranks   = {};
            }

            // Bloque le rendu central tant qu’on ne sait pas si la dernière course de la phase est finalisée
            initFreezeKnown = false;

            // (Ré)abonnements : leurs callbacks sont inoffensifs tant que initFreezeKnown === false
            if (phaseChanged || raceChanged) resubPhaseDeps();

            // Rendu différé après lecture one-shot de "live/races/{phase}"
            const doRender = () => {
                renderLeftColumn(team, pilots, phase, /* revealOn */ (phase === "mkw" && revealEnabled));
                syncActivePilotCardHeight();
                applyPilotGridColumns(phase, /* reveal */ false);

                if (freezeCenter) {
                    renderActivePilotsEnded(team, pilots, phase, allowed, finalRanksByPilot);
                    updateInfoBanner(null, null, true);
                } else {
                    renderCenterForPhase(team, pilots, phase, allowed, finalized, ranks, revealEnabled);
                    wireBonusButtons(phase, raceId, allowed, doublesLocked, doubles);
                    updateBonusButtonsUI(phase, raceId, allowed, bonusUsage, doublesLocked, doubles);
                    updateInfoBanner(phase, raceId, doublesLocked);
                    updateTilesState(phase, ranks, allowed, finalized);
                }
            };

            (async () => {
                try {
                    // ⬇️ On ne dépend plus de context.raceId ici.
                    const snap = await get(ref(dbRealtime, `live/races/${phase}`));
                    const racesObj = snap.val() || {};
                    const lastKey = lastRaceKeyOfPhase(phase);
                    const fin = !!(racesObj?.[lastKey]?.finalized);
                    freezeCenter = fin;
                } catch {
                    // en cas d’erreur réseau, on laisse freezeCenter tel quel (probablement false)
                } finally {
                    initFreezeKnown = true;
                    doRender();
                }
            })();
        });

        // Ajustement "six cartes sans scroll" au resize
        window.addEventListener("resize", () => {
            fitLeftColumnForSixCards();
            syncActivePilotCardHeight();
        });
        // Noyau de résilience (détection déco/reco, resync actif, watchdog)
        setupResilience();

    } catch (err) {
        console.error("[team] init error:", err);
        $("#content").innerHTML = `<p class='muted'>Erreur de chargement.</p>`;
    }
})();
