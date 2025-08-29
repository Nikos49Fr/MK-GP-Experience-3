/**
 * MK GP Experience 3 — Control Panel (nettoyé)
 * --------------------------------------------
 * - L’UI "races" (tiles/checkbox/radio/track) est désormais gérée exclusivement
 *   par le composant autonome /js/ui/race-strip.js.
 * - Ce fichier conserve :
 *   • la gestion du contexte & du Start switch,
 *   • les listeners RTDB (pour le panneau pilotes),
 *   • le panneau pilotes (badges, modale d’édition),
 *   • l’intégration du composant race-strip (montage + sync inspection → pilotes).
 */

import { dbRealtime, dbFirestore } from './firebase-config.js';
import {
    ref, onValue, off, get, set, update, remove
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js';

import {
    collection, getDocs
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js';

// Composant autonome race-strip
import { initRaceStrip } from './ui/race-strip.js';

/* ============================================================
   Helpers DOM
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.substring(2), v);
        else node.setAttribute(k, v);
    });
    children.forEach(c => node.append(c));
    return node;
};

/* ============================================================
   HELPER PHASE DEV
   ============================================================ */
// === Dev helpers ===
const DEV_ENABLE_FILL_BUTTON = true; // ← passe à false pour masquer complètement le bouton
// Bouton "fill" (dev-only) : remplit des rangs aléatoires dans live/results/{phase}/current/*
// - Visible/actif uniquement si DEV_ENABLE_FILL_BUTTON = true et si context/current a bien { phase, raceId }.
// - Ecrase les rangs existants sans états d’âme (usage dev/debug).
function mountDevFillButton() {
    if (!DEV_ENABLE_FILL_BUTTON) return;

    const headerCenter = document.querySelector('.cp-header-center');
    if (!headerCenter) return;

    // Eviter doublons si re-mount
    let btn = document.querySelector('#cp-dev-fill');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'cp-dev-fill';
        btn.type = 'button';
        btn.textContent = 'fill';
        // pas de design volontairement (dev-only)
        headerCenter.appendChild(btn);
    }

    // Etat actif/inactif en fonction du contexte
    const ctxRef = ref(dbRealtime, PATH_CONTEXT);
    const onCtx = (snap) => {
        const ctx = snap.val() || {};
        const hasPhase = !!ctx.phase;
        const hasRace  = !!ctx.raceId;
        btn.disabled = !(hasPhase && hasRace);
    };
    onValue(ctxRef, onCtx);

    // Click = remplir des rangs aléatoires 1..gridSize sans doublon pour tous les pilotes de la phase
    btn.addEventListener('click', async () => {
        try {
            const ctx = (typeof lastContext === 'object' && lastContext) ? lastContext : {};
            const phase = (ctx.phase || '').toLowerCase();
            const raceId = ctx.raceId;
            const rid = ctx.rid || (phase && raceId ? `${phase}-${raceId}` : '');

            if (!phase || !raceId) {
                console.warn('[dev fill] Pas de phase/course courante — action ignorée.');
                return;
            }

            const gridSize = (phase === 'mkw') ? 24 : 12;
            const gameLabel = (phase === 'mkw') ? 'MKW' : 'MK8';

            // Récupère les pilotes de la phase (ordre par défaut) et ne garde que gridSize max
            const pilots = await fetchPilotsByGameOrdered(gameLabel);
            const pilotIds = pilots.map(p => p.id).slice(0, gridSize);
            const N = pilotIds.length;
            if (N === 0) {
                console.warn('[dev fill] Aucun pilote trouvé pour', gameLabel);
                return;
            }

            // Génére 1..N puis shuffle (Fisher-Yates)
            const ranks = Array.from({ length: Math.max(N, gridSize) }, (_, i) => i + 1).slice(0, N);
            for (let i = N - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
            }

            // Multiloc update: live/results/{phase}/current/{pilotId} = { rank }
            const updates = {};
            for (let i = 0; i < N; i++) {
                const pid = pilotIds[i];
                const r = ranks[i];
                updates[`live/results/${phase}/current/${pid}`] = { rank: r };
            }

            await update(ref(dbRealtime), updates);
            console.log(`Ranks course ${rid} filled`);
        } catch (err) {
            console.error('[dev fill] Echec du remplissage:', err);
        }
    });
}

/* ============================================================
   État global (phase active, vue locale, caches)
   ============================================================ */
const PATH_CONTEXT = 'context/current';

let activeTournamentPhase = 'mk8'; // phase réelle du tournoi (global)
let activeRaceId = '1';            // "1".."12" | "S" | "SF"
let viewPhase = null;              // switch local d’affichage 'mk8' | 'mkw'

// Saisies live (seulement sur la phase active)
let currentResultsByPhase = { mk8: {}, mkw: {} }; // /live/results/{phase}/current

// Résultats figés par course (toute la phase vue)
let byRaceResultsByPhase = { mk8: {}, mkw: {} };  // /live/results/{phase}/byRace/{raceId}/{ranks|doubles}

// Statut de finalisation par course (par phase) — objet { raceId: { finalized: bool } }
let lastFinalizedByPhase = { mk8: {}, mkw: {} };  // /live/races/{phase}/{raceId}.finalized

// Listeners
const listeners = {
    context: null,
    currentPhase: { ref: null, cb: null }, // live/results/{activePhase}/current
    races: { ref: null, cb: null },        // live/races/{viewPhase}
    byRace: { ref: null, cb: null }        // live/results/{viewPhase}/byRace
};

// API race-strip (monté une seule fois)
let raceStripApi = null;

// --- Bonus window (doublesLocked) ---
const BONUS_WINDOW_SECONDS = 120;  // timer de sécurité (2 minutes)

let bonusTimer = {
    rid: null,           // "mk8-1", "mkw-8", etc.
    expiresAt: 0,        // timestamp ms
    intervalId: null     // setInterval handle
};

/* ============================================================
   Constantes utilitaires
   ============================================================ */
const GRID_SIZE = (phase) => phase === 'mkw' ? 24 : 12;

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

function isSurvivalRaceId(rid) {
    const v = String(rid || '').toUpperCase();
    return v === 'S' || v === 'SF';
}

function doublesLockedOf(phase, raceId) {
    return !!(byRaceResultsByPhase?.[phase]?.[raceId]?.doublesLocked);
}

async function setDoublesLocked(phase, raceId, locked) {
    if (!phase || !raceId) return;
    try {
        await update(ref(dbRealtime, `live/results/${phase}/byRace/${raceId}`), { doublesLocked: !!locked });
    } catch (e) {
        console.error('[CP] setDoublesLocked error', e);
    }
}

function stopBonusTimer() {
    if (bonusTimer.intervalId) {
        clearInterval(bonusTimer.intervalId);
    }
    bonusTimer = { rid: null, expiresAt: 0, intervalId: null };
    const t = document.getElementById('cp-bonus-timer');
    if (t) t.textContent = '';
}

function startBonusTimerFor(rid) {
    stopBonusTimer();
    bonusTimer.rid = rid;
    bonusTimer.expiresAt = Date.now() + BONUS_WINDOW_SECONDS * 1000;

    const t = document.getElementById('cp-bonus-timer');
    const tick = async () => {
        const ms = Math.max(0, bonusTimer.expiresAt - Date.now());
        const s = Math.ceil(ms / 1000);
        if (t) {
            const mm = String(Math.floor(s / 60)).padStart(1, '0');
            const ss = String(s % 60).padStart(2, '0');
            t.textContent = `⏳ ${mm}:${ss}`;
        }
        if (s <= 0) {
            stopBonusTimer();
            // Auto-fermeture à l’expiration, si on est toujours sur la même course
            const curRid = `${activeTournamentPhase}-${activeRaceId}`;
            if (curRid === rid && !isSurvivalRaceId(activeRaceId)) {
                await setDoublesLocked(activeTournamentPhase, activeRaceId, true);
            }
        }
    };
    tick();
    bonusTimer.intervalId = setInterval(tick, 250);
}

async function openBonusWindowForCurrent(auto = false) {
    if (!activeTournamentPhase || !activeRaceId) return;
    if (isSurvivalRaceId(activeRaceId)) return; // pas de bonus en S/SF
    const rid = `${activeTournamentPhase}-${activeRaceId}`;
    await setDoublesLocked(activeTournamentPhase, activeRaceId, false);
    startBonusTimerFor(rid);
    if (auto) {
        // Optionnel: log ou petit feedback visuel plus tard
        // console.log('[CP] Fenêtre bonus auto-ouverte pour', rid);
    }
}

async function closeBonusWindowForCurrent() {
    if (!activeTournamentPhase || !activeRaceId) return;
    await setDoublesLocked(activeTournamentPhase, activeRaceId, true);
    stopBonusTimer();
}

function updateBonusToggleUI() {
    const btn = document.getElementById('cp-bonus-toggle');
    const timer = document.getElementById('cp-bonus-timer');
    if (!btn) return;

    const phase = activeTournamentPhase;
    const raceId = activeRaceId;
    const rid = (phase && raceId) ? `${phase}-${raceId}` : '';

    // indisponible si pas de contexte ou S/SF
    const disabled = !(phase && raceId) || isSurvivalRaceId(raceId);
    btn.disabled = disabled;
    btn.title = disabled
        ? (isSurvivalRaceId(raceId) ? 'Bonus indisponible en Survie' : 'Pas de course active')
        : '';

    // état lock/unlock
    const locked = doublesLockedOf(phase, raceId);
    const isOpen = !locked && !disabled;

    btn.classList.toggle('is-on', isOpen);
    btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');

    // timer visible uniquement si ouvert
    if (timer) {
        timer.style.visibility = isOpen ? 'visible' : 'hidden';
        // redémarrer un timer local si ouvert sans timer (ou si course a changé)
        const currentRid = bonusTimer.rid;
        if (isOpen && currentRid !== rid) {
            startBonusTimerFor(rid);
        }
        if (!isOpen) {
            stopBonusTimer();
        }
    }
}

/* ============================================================
   Phase active & course active
   ============================================================ */
let lastContext = {};
let lastSelectedByPhase = { mk8: null, mkw: null };

function attachContextListener() {
    if (listeners.context) {
        off(listeners.context.ref, 'value', listeners.context.cb);
        listeners.context = null;
    }

    const ctxRef = ref(dbRealtime, PATH_CONTEXT);
    const cb = (snap) => {
        const ctx = snap.val() || {};

        // Mémoriser l'état précédent pour savoir si on doit "suivre" l'avancée
        const prevActivePhase = activeTournamentPhase;
        const prevActiveRace  = activeRaceId;

        // Phase/course actives du tournoi depuis le contexte
        activeTournamentPhase = (ctx.phase || 'mk8').toLowerCase();
        activeRaceId = (ctx.raceId != null && ctx.raceId !== '') ? String(ctx.raceId).toUpperCase() : null;

        // Garantir un gridSize cohérent avec la phase (utile si ancien contexte)
        const desiredGrid = (activeTournamentPhase === 'mkw') ? 24 : 12;
        if (ctx.gridSize !== desiredGrid) {
            update(ref(dbRealtime, PATH_CONTEXT), { gridSize: desiredGrid }).catch(() => {});
        }

        // Vue locale par défaut = phase active si non initialisée
        if (!viewPhase) viewPhase = activeTournamentPhase;

        // --- 🔁 Suivi d’inspection “soft follow” ---
        // Si on inspectait l’ancienne course active (ou rien), on bascule l’inspection sur la nouvelle.
        // On n’écrase pas si l’utilisateur a explicitement sélectionné une autre course.
        if (viewPhase === activeTournamentPhase) {
            const wasFollowing =
                (lastSelectedByPhase[viewPhase] == null) ||
                (prevActivePhase === viewPhase && lastSelectedByPhase[viewPhase] === prevActiveRace);

            if (wasFollowing && activeRaceId) {
                lastSelectedByPhase[viewPhase] = activeRaceId;
            }
        }

        updatePhaseSwitchUI();
        updateStartSwitchUI();

        // UI du bouton bonus mise à jour à chaque changement de contexte
        updateBonusToggleUI();

        // Auto ouverture si la course vient de changer (start ou post-finalisation)
        const raceChanged = (prevActivePhase !== activeTournamentPhase) || (prevActiveRace !== activeRaceId);
        if (raceChanged && activeRaceId && !isSurvivalRaceId(activeRaceId)) {
            // On n’ouvre que si la fenêtre est verrouillée ou non définie
            const locked = doublesLockedOf(activeTournamentPhase, activeRaceId);
            if (locked || typeof locked === 'undefined') {
                openBonusWindowForCurrent(true);
            }
        }

        // Synchroniser la vue du composant race-strip
        window.__cpRaceStrip?.api?.()?.setPhaseView?.(viewPhase);

        // Rebrancher les listeners alignés
        ensureCurrentResultsListener(activeTournamentPhase);
        ensurePhaseViewListeners(viewPhase);

        // Rafraîchir le panneau pilotes (badges)
        refreshPilotListView();
    };

    onValue(ctxRef, cb);
    listeners.context = { ref: ctxRef, cb };
}

// Détermine la course "active" pour une phase donnée
function getActiveRaceIdForPhase(phase) {
    if (phase === activeTournamentPhase) return activeRaceId;
    const order = buildRaceList(phase);
    const finals = lastFinalizedByPhase[phase] || {};
    for (const k of order) {
        const isFinalized = !!(finals[k] && finals[k].finalized === true);
        if (!isFinalized) return k;
    }
    return order[order.length - 1];
}

function isPhaseStarted(phase) {
    return !!(lastContext && lastContext.phase === phase && lastContext.raceId);
}

/* ============================================================
   Listeners: current (phase active) + byRace & races (phase vue)
   ============================================================ */
function ensureCurrentResultsListener(phase) {
    if (listeners.currentPhase.ref && listeners.currentPhase.cb) {
        off(listeners.currentPhase.ref, 'value', listeners.currentPhase.cb);
    }
    const r = ref(dbRealtime, `live/results/${phase}/current`);
    const cb = (s) => {
        currentResultsByPhase[phase] = s.val() || {};
        if (viewPhase === phase) {
            refreshPilotListView();
        }
    };
    onValue(r, cb);
    listeners.currentPhase = { ref: r, cb };

    get(r).then(s => {
        currentResultsByPhase[phase] = s.val() || {};
        if (viewPhase === phase) {
            refreshPilotListView();
        }
    }).catch(() => {});
}

function ensurePhaseViewListeners(phase) {
    // races/{phase}
    if (listeners.races.ref && listeners.races.cb) {
        off(listeners.races.ref, 'value', listeners.races.cb);
    }
    const racesRef = ref(dbRealtime, `live/races/${phase}`);
    const racesCb = (snap) => {
        const raw = snap.val() || {};
        // 🔧 Normalisation stricte en objet { finalized: boolean }
        const normalized = {};
        for (const [rid, v] of Object.entries(raw)) {
            if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'finalized')) {
                normalized[rid] = { finalized: !!v.finalized };
            } else {
                // compat ancienne donnée bool → on bascule côté UI en objet
                normalized[rid] = { finalized: !!v };
            }
        }
        lastFinalizedByPhase[phase] = normalized;
        updateStartSwitchUI();
        updateBonusToggleUI();
    };
    onValue(racesRef, racesCb);
    listeners.races = { ref: racesRef, cb: racesCb };

    // results/{phase}/byRace
    if (listeners.byRace.ref && listeners.byRace.cb) {
        off(listeners.byRace.ref, 'value', listeners.byRace.cb);
    }
    const byRaceRef = ref(dbRealtime, `live/results/${phase}/byRace`);
    const byRaceCb = (snap) => {
        byRaceResultsByPhase[phase] = snap.val() || {};
        refreshPilotListView();
        updateStartSwitchUI();
        updateBonusToggleUI();
    };
    onValue(byRaceRef, byRaceCb);
    listeners.byRace = { ref: byRaceRef, cb: byRaceCb };

    // init
    get(racesRef).then(s => {
        const raw = s.val() || {};
        const normalized = {};
        for (const [rid, v] of Object.entries(raw)) {
            if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'finalized')) {
                normalized[rid] = { finalized: !!v.finalized };
            } else {
                normalized[rid] = { finalized: !!v };
            }
        }
        lastFinalizedByPhase[phase] = normalized;
    }).catch(()=>{});

    get(byRaceRef).then(s => {
        byRaceResultsByPhase[phase] = s.val() || {};
        refreshPilotListView();
    }).catch(()=>{});
}

/* ============================================================
   Switch de vue (header)
   ============================================================ */
function updatePhaseSwitchUI() {
    const grp = $('.cp-phase-switch');
    if (!grp) return;
    const btnMk8 = $('#cp-btn-mk8', grp);
    const btnMkw = $('#cp-btn-mkw', grp);
    const setActive = (btn, active) => {
        btn?.classList.toggle('is-active', active);
        btn?.setAttribute('aria-pressed', active ? 'true' : 'false');
    };
    setActive(btnMk8, viewPhase === 'mk8');
    setActive(btnMkw, viewPhase === 'mkw');
}

function mountPhaseSwitch() {
    const header = $('.cp-header');
    const right = $('.cp-header-right', header);
    if (!header || !right) return;

    let center = $('.cp-header-center', header);
    if (!center) {
        center = el('div', { class: 'cp-header-center' });
        header.insertBefore(center, right);
    }

    // Groupe phase MK8/MKW
    const group = el(
        'div',
        { class: 'cp-phase-switch', role: 'group', 'aria-label': 'Phase du tournoi (vue locale)' },
        el('button', {
            id: 'cp-btn-mk8',
            class: 'cp-switch-btn',
            type: 'button',
            'aria-pressed': 'false',
            'data-phase': 'mk8'
        }, 'MK8'),
        el('button', {
            id: 'cp-btn-mkw',
            class: 'cp-switch-btn',
            type: 'button',
            'aria-pressed': 'false',
            'data-phase': 'mkw'
        }, 'MKW')
    );

    // Switch "Start"
    const startWrap = el('div', { class: 'cp-start-toggle' },
        el('input', {
            id: 'cp-start-input',
            class: 'cp-start-input',
            type: 'checkbox',
            role: 'switch',
            'aria-checked': 'false'
        }),
        el('label', { for: 'cp-start-input', class: 'cp-start-label' }, 'Start')
    );

    // Toggle "Fenêtre Bonus" (doré) + timer
    const bonusWrap = el('div', { class: 'cp-bonus-toggle-wrap' },
        el('button', {
            id: 'cp-bonus-toggle',
            class: 'cp-bonus-toggle',
            type: 'button',
            'aria-pressed': 'false',
            title: ''
        }, 'Bonus'),
        el('span', { id: 'cp-bonus-timer', class: 'cp-bonus-timer', 'aria-live': 'polite' }, '')
    );

    center.replaceChildren(group, startWrap, bonusWrap);

    $('#cp-btn-mk8', group).addEventListener('click', () => setViewPhase('mk8'));
    $('#cp-btn-mkw', group).addEventListener('click', () => setViewPhase('mkw'));

    const startInput = $('#cp-start-input', startWrap);
    startInput.addEventListener('change', async (e) => {
        if (e.target.checked === false) {
            e.preventDefault();
            updateStartSwitchUI();
            return;
        }
        if (computeStartEnabledForView(viewPhase)) {
            try {
                await startPhase(viewPhase);
            } catch (err) {
                console.error('Start phase échoué:', err);
                e.target.checked = false;
            }
        } else {
            e.preventDefault();
            e.target.checked = false;
        }
        updateStartSwitchUI();
    });

    // Toggle clic
    $('#cp-bonus-toggle', bonusWrap).addEventListener('click', async () => {
        if (!activeTournamentPhase || !activeRaceId) return;
        if (isSurvivalRaceId(activeRaceId)) return;

        const locked = doublesLockedOf(activeTournamentPhase, activeRaceId);
        try {
            if (locked) {
                await openBonusWindowForCurrent(false);
            } else {
                await closeBonusWindowForCurrent();
            }
        } catch (e) {
            console.error('[CP] toggle bonus error', e);
        }
        updateBonusToggleUI();
    });

    updatePhaseSwitchUI();
    updateStartSwitchUI();
    mountDevFillButton();
    updateBonusToggleUI();
}

function setViewPhase(phase) {
    const p = (phase || 'mk8').toLowerCase();
    if (p !== 'mk8' && p !== 'mkw') return;
    if (viewPhase === p) return;
    viewPhase = p;

    const order = buildRaceList(viewPhase);
    const active = getActiveRaceIdForPhase(viewPhase);
    if (!lastSelectedByPhase[viewPhase] || !order.includes(lastSelectedByPhase[viewPhase])) {
        lastSelectedByPhase[viewPhase] = active || order[0];
    }

    ensurePhaseViewListeners(viewPhase);
    updatePhaseSwitchUI();
    window.__cpRaceStrip?.api?.()?.setPhaseView?.(viewPhase);
    refreshPilotListView();
    updateStartSwitchUI();

    window.__reloadPilotsForView && window.__reloadPilotsForView();
}

// --- Start switch: logique d'activation ---
function computeStartEnabledForView(phase) {
    if (!phase) return false;
    const hasCurrent = !!(lastContext && lastContext.raceId);
    const finals = lastFinalizedByPhase[phase] || {};
    const anyFinalized = Object.values(finals).some(v => !!(v && v.finalized === true));
    return !hasCurrent && !anyFinalized;
}

async function startPhase(phase) {
    const firstId = buildRaceList(phase)[0];
    const gridSize = (phase === 'mkw') ? 24 : 12; // requis par les règles RTDB
    await update(ref(dbRealtime, PATH_CONTEXT), {
        phase,
        raceId: firstId,
        rid: `${phase}-${firstId}`,
        gridSize
    });
}

function updateStartSwitchUI() {
    const input = document.getElementById('cp-start-input');
    if (!input) return;
    const isOn = !!(lastContext && lastContext.raceId) && (lastContext.phase === viewPhase);
    input.checked = isOn;
    input.disabled = isOn || !computeStartEnabledForView(viewPhase);
    input.setAttribute('aria-checked', isOn ? 'true' : 'false');
}

/* ============================================================
   Panneau pilotes (Firestore + RTDB)
   ============================================================ */
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
function groupPilotsByTeam(teams, pilots) {
    const byTeam = new Map(teams.map(t => [t.name, { team: t, pilots: [] }]));
    pilots.forEach(p => {
        const bucket = byTeam.get(p.teamName);
        if (bucket) bucket.pilots.push(p);
    });
    return teams.map(t => byTeam.get(t.name));
}
function renderPilotsPanel(groups) {
    const host = $('#cp-pilots-panel');
    if (!host) return;
    const container = el('div', { class: 'cp-pilots-scroll' });

    groups.forEach((g, idx) => {
        if (!g || g.pilots.length === 0) return;
        const block = el('div', { class: 'cp-team-block' });

        const logoWrap = el('div', { class: 'cp-team-logo' });
        const logoUrl = g.team?.urlLogo || '';
        if (logoUrl) {
            logoWrap.appendChild(el('img', { src: logoUrl, alt: g.team?.name || 'Team', loading: 'lazy' }));
        }
        block.appendChild(logoWrap);

        const list = el('div', { class: 'cp-team-pilots' });
        g.pilots.forEach(p => {
            const item = el('div', { class: 'cp-pilot-item', 'data-pilot-id': p.id, title: p.name || '' },
                el('span', { class: 'cp-rank-badge' }),
                el('span', { class: 'cp-pilot-name' }, p.name || '—')
            );
            const badgeEl = item.querySelector('.cp-rank-badge');
            badgeEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isPhaseStarted(viewPhase)) return; // phase non démarrée → pas d’édition
                openRankModal(viewPhase, p.id, item);
            });
            list.appendChild(item);
        });
        block.appendChild(list);
        container.appendChild(block);
        if (idx < groups.length - 1) container.appendChild(el('div', { class: 'cp-team-sep' }));
    });

    host.replaceChildren(container);
}

/* ============================================================
   Montage panneau pilotes + phase switch
   ============================================================ */
function mountPilotsPanelSection() {
    const main = $('#cp-main');
    if (!main) return;

    // Nouveau layout: [aside gauche: pilotes] | [centre] | [aside droite: leaderboard]
    let layout = $('.cp-layout', main);
    if (!layout) {
        layout = el('div', { class: 'cp-layout' },
            el('aside', { id: 'cp-pilots-panel', class: 'cp-pilots-panel' }),
            el('section', { class: 'cp-main-center' },
                el('header', { class: 'cp-center-header' },
                    el('div', { id: 'cp-races', class: 'cp-races-section' },
                        el('div', { class: 'cp-races-inner' })
                    )
                ),
                el('section', { class: 'cp-center-body' })
            ),
            el('aside', { id: 'cp-leaderboard', class: 'cp-leaderboard' })
        );
        main.replaceChildren(layout);
    }

    // Expose un reloader basé sur la PHASE DE VUE (switch MK8/MKW)
    window.__reloadPilotsForView = async function() {
        const phaseView = (viewPhase || 'mk8').toLowerCase();
        const gameLabel = phaseView === 'mkw' ? 'MKW' : 'MK8';

        document.body.classList.toggle('phase-mkw', phaseView === 'mkw');
        document.body.classList.toggle('phase-mk8', phaseView === 'mk8');

        const [teams, pilots] = await Promise.all([
            fetchTeamsOrdered(),
            fetchPilotsByGameOrdered(gameLabel)
        ]);
        const groups = groupPilotsByTeam(teams, pilots);
        renderPilotsPanel(groups);
        window.__cpRaceStrip?.api?.()?.setPhaseView?.(phaseView);

        refreshPilotListView();
    };

    // RTDB context
    onValue(ref(dbRealtime, PATH_CONTEXT), async (snap) => {
        try {
            lastContext = snap.val() || {};
            await window.__reloadPilotsForView();
        } catch (err) {
            console.error('Erreur rendu layout:', err);
        }
    });
}

/* ============================================================
   Application des résultats à l’UI (badges)
   ============================================================ */
function computeRaceStatusFromResults(results, gridSize) {
    const rankCount = new Map();
    let filledCount = 0;
    Object.values(results || {}).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            filledCount++;
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });
    const hasConflict = [...rankCount.values()].some(n => n >= 2);
    if (hasConflict) return 'conflict';
    if (gridSize && filledCount === Number(gridSize)) return 'complete';
    if (filledCount > 0) return 'filled';
    return null;
}

function getResultsForDisplay(phase, raceId) {
    if (phase === activeTournamentPhase && raceId === activeRaceId) {
        const current = currentResultsByPhase[phase] || {};
        const hasCurrent = Object.values(current).some(v => v && v.rank != null);
        if (hasCurrent) return current;

        const ranks = byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
        const hasRanks = Object.values(ranks).some(v => v && v.rank != null);
        if (hasRanks) return ranks;

        return {};
    }
    return byRaceResultsByPhase?.[phase]?.[raceId]?.ranks || {};
}

function applyResultsToUI(phase, resultsMap, gridSize) {
    const items = Array.from(document.querySelectorAll('.cp-pilot-item'));
    const rankCount = new Map();
    let filledCount = 0;

    items.forEach(it => {
        const pilotId = it.dataset.pilotId;
        const badge = it.querySelector('.cp-rank-badge');
        if (!badge) return;

        const rank = resultsMap?.[pilotId]?.rank ?? null;

        badge.classList.remove('is-empty','is-filled','is-conflict','is-complete');
        badge.textContent = '';

        if (rank == null || rank === '') {
            badge.classList.add('is-empty');
        } else {
            const r = Number(rank);
            badge.textContent = String(rank);
            badge.classList.add('is-filled');
            filledCount++;
            if (Number.isInteger(r) && r > 0) {
                rankCount.set(r, (rankCount.get(r) || 0) + 1);
            }
        }
    });

    const conflicts = new Set([...rankCount.entries()].filter(([_, n]) => n >= 2).map(([r]) => r));
    if (conflicts.size > 0) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            const rankText = badge?.textContent?.trim();
            if (!rankText) return;
            const r = Number(rankText);
            if (conflicts.has(r)) {
                badge.classList.remove('is-empty','is-filled','is-complete');
                badge.classList.add('is-conflict');
            }
        });
    }

    const isCompleteValid = (gridSize && filledCount === Number(gridSize) && conflicts.size === 0);
    if (isCompleteValid) {
        items.forEach(it => {
            const badge = it.querySelector('.cp-rank-badge');
            if (!badge) return;
            badge.classList.remove('is-empty','is-filled','is-conflict');
            badge.classList.add('is-complete');
        });
    }
}

function refreshPilotListView() {
    if (!viewPhase) return;
    const gridSize = GRID_SIZE(viewPhase);
    const activeId = getActiveRaceIdForPhase(viewPhase);
    const inspectedId = lastSelectedByPhase[viewPhase] || activeId;

    const results = getResultsForDisplay(viewPhase, inspectedId);
    applyResultsToUI(viewPhase, results, gridSize);
}

/* ============================================================
   Modale d’édition (choix du rang / reset)
   - Active phase + active race => écrit dans results/{phase}/current
   - Sinon => écrit directement dans results/{phase}/byRace/{raceId}/ranks
   - En cas d’édition d’une course finalisée → remet finalized=false
   ============================================================ */
function openRankModal(phase, pilotId, anchorEl) {
    if (!isPhaseStarted(phase)) return;
    const backdrop = el('div', { class: 'cp-modal-backdrop', 'data-modal': 'rank' });
    const card = el('div', { class: 'cp-modal-card' });

    const closeBtn = el('button', { class: 'cp-modal-close', 'aria-label': 'Fermer' }, '×');
    closeBtn.addEventListener('click', () => backdrop.remove());

    const resetBtn = el('button', { class: 'cp-modal-reset', type: 'button' }, 'Reset');
    resetBtn.addEventListener('click', async () => {
        try {
            const activeId = getActiveRaceIdForPhase(phase);
            const inspectedId = lastSelectedByPhase[phase] || activeId;
            if (phase === activeTournamentPhase && inspectedId === activeId) {
                await remove(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`));
            } else {
                await remove(ref(dbRealtime, `live/results/${phase}/byRace/${inspectedId}/ranks/${pilotId}`));
                // 🔒 Un-finalize explicite en OBJET
                await update(ref(dbRealtime, `live/races/${phase}/${inspectedId}`), { finalized: false });
                refreshPilotListView();
            }
            backdrop.remove();
        } catch (err) {
            console.error('Reset rang échoué:', err);
        }
    });

    const nameText =
        anchorEl?.querySelector('.cp-pilot-name')?.textContent?.trim() ||
        anchorEl?.dataset?.pilotName || '';
    const titleEl = el('div', { class: 'cp-modal-title' }, nameText);

    card.append(resetBtn, titleEl, closeBtn);

    const activeId = getActiveRaceIdForPhase(phase);
    const inspectedId = lastSelectedByPhase[phase] || activeId;
    const useCurrent = (phase === activeTournamentPhase && inspectedId === activeId);
    const resultsForGrid = useCurrent
        ? (currentResultsByPhase[phase] || {})
        : (byRaceResultsByPhase?.[phase]?.[inspectedId]?.ranks || {});

    const rankCount = new Map();
    Object.values(resultsForGrid).forEach(v => {
        const r = Number(v?.rank);
        if (Number.isInteger(r) && r > 0) {
            rankCount.set(r, (rankCount.get(r) || 0) + 1);
        }
    });

    const grid = el('div', { class: 'cp-rank-grid' });
    const gridSize = GRID_SIZE(phase);
    for (let i = 1; i <= gridSize; i++) {
        const taken = rankCount.get(i) || 0;
        const cell = el('button', {
            class: 'cp-rank-cell ' + (taken >= 2 ? 'is-conflict' : taken === 1 ? 'is-filled' : 'is-empty'),
            type: 'button',
            'data-rank': String(i)
        }, String(i));

        cell.addEventListener('click', async () => {
            try {
                if (useCurrent) {
                    await set(ref(dbRealtime, `live/results/${phase}/current/${pilotId}`), { rank: i });
                } else {
                    await set(ref(dbRealtime, `live/results/${phase}/byRace/${inspectedId}/ranks/${pilotId}`), { rank: i });
                    // 🔒 Un-finalize explicite en OBJET
                    await update(ref(dbRealtime, `live/races/${phase}/${inspectedId}`), { finalized: false });
                    refreshPilotListView();
                }
                backdrop.remove();
            } catch (err) {
                console.error('Maj rang échouée:', err);
            }
        });

        grid.appendChild(cell);
    }

    card.append(closeBtn, grid);
    backdrop.appendChild(card);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

    document.body.appendChild(backdrop);
    card.style.visibility = 'hidden';
    card.style.position = 'fixed';

    // Positionnement
    const GAP = 8;
    const fallbackMargin = 12;
    const aRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const cRect = card.getBoundingClientRect();
    const cardW = cRect.width;
    const cardH = cRect.height;
    let left = aRect ? aRect.right + GAP : fallbackMargin;
    if (left + cardW + fallbackMargin > window.innerWidth) {
        left = Math.max(fallbackMargin, (aRect ? aRect.left : 0) - GAP - cardW);
    }
    let top = aRect ? (aRect.top + (aRect.height / 2) - (cardH / 2)) : fallbackMargin;
    top = Math.max(fallbackMargin, Math.min(top, window.innerHeight - cardH - fallbackMargin));
    left = Math.max(fallbackMargin, Math.min(left, window.innerWidth - cardW - fallbackMargin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = 'visible';
}

/* ============================================================
   Montage global
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
    mountPhaseSwitch();
    mountPilotsPanelSection();
    attachContextListener();
});

/* ============================================================
   Intégration "classement" (inchangé)
   ============================================================ */
(function integrateClassementIntoControlPanel() {
    const HOST_ID = 'cp-classement-host';
    let api = null;

    function ensureHostInAside() {
        const aside = document.getElementById('cp-leaderboard');
        if (!aside) return null;
        let host = aside.querySelector('#' + HOST_ID);
        if (!host) {
            host = document.createElement('div');
            host.id = HOST_ID;
            host.className = 'cp-classement-host';
            aside.appendChild(host);
        }
        return host;
    }

    async function mountClassementOnce() {
        const host = ensureHostInAside();
        if (!host || host.__classementMounted) return;

        window.__CL_FACTORY_MODE = true;
        const { initClassement } = await import('./ui/classement.js');

        api = initClassement(host, { forceMode: 'auto' });
        if (api?.ready) { try { await api.ready; } catch {} }
        host.__classementMounted = true;
    }

    function whenAsideReady(cb, tries = 20) {
        const tick = () => {
            const aside = document.getElementById('cp-leaderboard');
            if (aside) {
                cb();
            } else if (tries > 0) {
                setTimeout(() => whenAsideReady(cb, tries - 1), 100);
            } else {
                console.warn('[CP] Aside #cp-leaderboard introuvable, classement non monté.');
            }
        };
        tick();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => whenAsideReady(mountClassementOnce), { once: true });
    } else {
        whenAsideReady(mountClassementOnce);
    }

    window.__cpClassement = {
        remount: () => { const h = document.getElementById(HOST_ID); if (h) h.__classementMounted = false; return mountClassementOnce(); },
        destroy: () => { try { api?.destroy?.(); } catch {} }
    };
})();

/* ============================================================
   Intégration "race-strip" — montage dans #cp-races (mode Firebase)
   ============================================================ */
(function integrateRaceStripIntoControlPanel() {
    const HOST_ID = 'cp-race-strip-host';
    let api = null;

    function ensureHostInHeader() {
        const root = document.getElementById('cp-races'); // créé dans mountPilotsPanelSection()
        if (!root) return null;
        let host = root.querySelector('#' + HOST_ID);
        if (!host) {
            host = document.createElement('div');
            host.id = HOST_ID;
            host.className = 'cp-race-strip-host';
            // on remplace le contenu existant (ancien DOM .cp-races-inner inutilisé)
            root.replaceChildren(host);
        }
        return host;
    }

    async function mountOnce() {
        const host = ensureHostInHeader();
        if (!host || host.__raceStripMounted) return;

        window.__RS_FACTORY_MODE = true;

        const { initRaceStrip } = await import('./ui/race-strip.js');
        api = initRaceStrip(host, {
            controller: 'firebase', // écoute RTDB + calcule statuts + finalisation intégrée
            mode: 'admin',
            showPhaseNav: false,
            onPhaseViewChange: (phase) => {
                // si un jour showPhaseNav:true, on peut synchroniser la vue CP
                // setViewPhase(phase);
            },
            onSelect: (raceId) => {
                // Mémoriser l’inspection côté CP (utilisé par le panneau pilotes)
                try {
                    lastSelectedByPhase[viewPhase] = String(raceId);
                    refreshPilotListView();
                } catch (e) {
                    console.error('[CP] onSelect race-strip -> update inspected:', e);
                }
            }
        });

        if (api?.ready) { try { await api.ready; } catch {} }
        host.__raceStripMounted = true;
    }

    function whenRacesContainerReady(cb, tries = 20) {
        const tick = () => {
            const el = document.getElementById('cp-races');
            if (el) cb();
            else if (tries > 0) setTimeout(() => whenRacesContainerReady(cb, tries - 1), 100);
            else console.warn('[CP] #cp-races introuvable, race-strip non monté.');
        };
        tick();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => whenRacesContainerReady(mountOnce), { once: true });
    } else {
        whenRacesContainerReady(mountOnce);
    }

    window.__cpRaceStrip = {
        api: () => api,
        remount: () => { const h = document.getElementById(HOST_ID); if (h) h.__raceStripMounted = false; return mountOnce(); },
        destroy: () => { try { api?.destroy?.(); } catch {} }
    };
})();
