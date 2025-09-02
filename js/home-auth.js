// js/home-auth.js
import { app } from "./firebase-config.js";
import {
    getAuth, GoogleAuthProvider, setPersistence,
    browserLocalPersistence, signInWithPopup, signInWithRedirect,
    getRedirectResult, signOut, onAuthStateChanged, signInAnonymously
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ---- Auth init ----
const auth = getAuth(app);

// Provider Google
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

// ---------------- Page flags (où l’anonyme est autorisé ?) ----------------
// Public: index.html (ou racine) → autoriser l’anonyme
// Privé: /pages/admin.html, /pages/control-panel.html → interdire l’anonyme
const PATH = location.pathname || "/";
const IS_ADMIN_PAGE = /\/pages\/admin\.html$/i.test(PATH);
const IS_CONTROL_PAGE = /\/pages\/control-panel\.html$/i.test(PATH);
const ALLOW_ANON = !(IS_ADMIN_PAGE || IS_CONTROL_PAGE); // true seulement hors pages protégées

// Whitelist (emails normalisés)
const ALLOWED_EMAILS = new Set(
    ["nicolas4980@gmail.com", "guillaume.b.fouche@gmail.com"].map(e => e.trim().toLowerCase())
);

function isAllowedEmail(email) {
    if (!email) return false;
    return ALLOWED_EMAILS.has(String(email).trim().toLowerCase());
}

// ---- Sélecteurs UI ----
// Compat : on accepte soit des IDs (#admin-link / #direction-link), soit des data-roles
function $allAdminLinks() {
    return [
        ...document.querySelectorAll('#admin-link, [data-role="link-admin"]'),
        ...document.querySelectorAll('a[href*="admin.html"][data-nav="admin"]')
    ];
}
function $allDirectionLinks() {
    return [
        ...document.querySelectorAll('#direction-link, [data-role="link-control"]'),
        ...document.querySelectorAll('a[href*="control-panel.html"][data-nav="control"]')
    ];
}
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");

// Libellés (fallback)
if (loginBtn) loginBtn.textContent = "Login";
if (logoutBtn) logoutBtn.textContent = "Logout";

// Persistance locale (reste connecté entre sessions)
setPersistence(auth, browserLocalPersistence).catch(() => { /* noop */ });

// Anti double-clic
let signing = false;

// ---- Helpers ----
async function ensureAnonymousAuthIfAllowed() {
    if (!ALLOW_ANON) return; // ⛔️ interdit ici
    try {
        if (!auth.currentUser) {
            await signInAnonymously(auth);
            console.info("[home-auth] opened anonymous session");
        }
    } catch (err) {
        console.warn("[home-auth] signInAnonymously failed:", err?.code || err);
    }
}

function isAdminOrCaster(user) {
    return !!user && !!user.email && isAllowedEmail(user.email);
}

function setHidden(el, hidden) {
    if (!el) return;
    el.hidden = !!hidden;
    el.classList.toggle("hidden", !!hidden);
}

// ---- Actions ----
async function doLogin() {
    if (signing) return;
    signing = true;
    try {
        await signInWithPopup(auth, provider);
        // onAuthStateChanged mettra l'UI à jour
    } catch (e) {
        try {
            await signInWithRedirect(auth, provider);
        } catch {
            signing = false;
            alert("Impossible d'ouvrir la connexion. Réessaie.");
        }
    }
}

async function doLogout() {
    try {
        await signOut(auth);
    } finally {
        toggleUiForUser(null);
        // ⚠️ Ne relance l’anonyme qu’en pages publiques
        ensureAnonymousAuthIfAllowed();
    }
}

// Écoute silencieuse d’un éventuel retour de signInWithRedirect
getRedirectResult(auth).catch(() => { /* noop */ });

// ---- Wire UI ----
if (loginBtn) loginBtn.addEventListener("click", doLogin);
if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

// ---- Réagit aux changements d'état (source unique de vérité UI) ----
onAuthStateChanged(auth, (user) => {
    signing = false; // réarme le bouton login

    if (!user) {
        // Si aucun user :
        // - page publique → session anonyme ok
        // - page protégée → rester déconnecté, montrer CTA Login
        ensureAnonymousAuthIfAllowed();
        toggleUiForUser(null);
        return;
    }

    toggleUiForUser(user);
});

// ---- Mise à jour de l’interface ----
function toggleUiForUser(user) {
    const isAnon = !!user && user.isAnonymous === true;
    const email = (user && user.email) ? String(user.email).trim() : null;
    const allowed = isAdminOrCaster(user);

    console.log("[home-auth] state:",
        { email, isAnon, allowed, uid: user?.uid || null }
    );

    // Boutons
    // - si anonyme → montrer Login, cacher Logout
    // - si connecté normal → cacher Login, montrer Logout
    if (loginBtn)  setHidden(loginBtn, !!user && !isAnon ? true : false);
    if (logoutBtn) setHidden(logoutBtn, !user || isAnon ? true : false);

    // Liens Admin / Direction (emails autorisés uniquement)
    const adminLinks = $allAdminLinks();
    const controlLinks = $allDirectionLinks();
    adminLinks.forEach(el => setHidden(el, !allowed));
    controlLinks.forEach(el => setHidden(el, !allowed));

    // Persist email (si présent)
    try {
        if (email) localStorage.setItem("mk_user_email", email);
        else localStorage.removeItem("mk_user_email");
    } catch {}

    // Classes root (compat CSS éventuel)
    document.documentElement.classList.toggle("is-logged-in", !!user && !isAnon);
    document.documentElement.classList.toggle("is-anon", isAnon);
    document.documentElement.classList.toggle("is-admin", allowed);

    // Sur page protégée : si anonyme, on force l’affichage du CTA Login
    if (!ALLOW_ANON) {
        if (loginBtn) setHidden(loginBtn, !!user && !isAnon);
        if (logoutBtn) setHidden(logoutBtn, !user || isAnon);
    }
}
