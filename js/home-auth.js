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

// Whitelist des comptes autorisés (ajoute le ou les casters ici)
const ALLOWED_EMAILS = ["nicolas4980@gmail.com"];

// ---- UI refs ----
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const adminLink = document.getElementById("admin-link");
const directionLink = document.getElementById("direction-link");

// Libellés
if (loginBtn) loginBtn.textContent = "Login";
if (logoutBtn) logoutBtn.textContent = "Logout";

// Persistance locale (reste connecté entre sessions)
setPersistence(auth, browserLocalPersistence).catch(() => { /* noop */ });

// Anti double-clic
let signing = false;

// ---- Helpers ----
async function ensureAnonymousAuth() {
    // Si personne n'est connecté, on ouvre une session anonyme (zéro UI)
    try {
        if (!auth.currentUser) {
            await signInAnonymously(auth);
        }
    } catch (err) {
        // Si l'anonymous n'est pas activé, on se contente de ne rien faire.
        // (Tu l'as activé, donc on ne devrait pas passer ici.)
        console.warn("[auth] signInAnonymously failed:", err?.code || err);
    }
}

function isAdminOrCaster(user) {
    return !!user && !!user.email && ALLOWED_EMAILS.includes(user.email);
}

// ---- Actions ----
async function doLogin() {
    if (signing) return;
    signing = true;
    try {
        // Essaye en pop-up d’abord
        await signInWithPopup(auth, provider);
        // onAuthStateChanged mettra l'UI à jour
    } catch (e) {
        // Fallback en redirect si la popup échoue/bloquée
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
        // Après un logout (y compris depuis un compte Google), on rétablit
        // automatiquement une session anonyme pour garder l'accès en lecture.
        ensureAnonymousAuth();
    }
}

// Écoute silencieuse d’un éventuel retour de signInWithRedirect
getRedirectResult(auth).catch(() => { /* noop */ });

// ---- Wire UI ----
if (loginBtn) loginBtn.addEventListener("click", doLogin);
if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

// ---- Réagit aux changements d'état ----
onAuthStateChanged(auth, (user) => {
    signing = false; // réarme le bouton login

    // Si aucun user -> on bascule en anonyme immédiatement
    if (!user) {
        ensureAnonymousAuth();
        // toggle UI quand même (état "non connecté" transitoire)
        toggleUiForUser(null);
        return;
    }

    toggleUiForUser(user);
});

// ---- Mise à jour de l’interface ----
function toggleUiForUser(user) {
    const isAnon = !!user && user.isAnonymous === true;
    const allowed = isAdminOrCaster(user);

    // Boutons
    // - Login : visible si non connecté OU si anonyme (pour upgrade Google)
    // - Logout : visible si connecté avec compte "non anonyme" (ex. Google)
    if (loginBtn)  loginBtn.hidden = !!user && !isAnon;
    if (logoutBtn) logoutBtn.hidden = !user || isAnon;

    // Liens Admin / Direction (seulement pour emails autorisés)
    if (adminLink)     adminLink.hidden = !allowed;
    if (directionLink) directionLink.hidden = !allowed;

    // Persist email (si présent)
    try {
        if (user && user.email) localStorage.setItem("mk_user_email", user.email);
        else localStorage.removeItem("mk_user_email");
    } catch {}

    // Classes root (conservées pour compat CSS éventuel)
    document.documentElement.classList.toggle("is-logged-in", !!user);
    document.documentElement.classList.toggle("is-admin", allowed);
}
