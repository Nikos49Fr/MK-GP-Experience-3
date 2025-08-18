// js/home-auth.js
import { app } from "./firebase-config.js";
import {
    getAuth, GoogleAuthProvider, setPersistence,
    browserLocalPersistence, signInWithPopup, signInWithRedirect,
    getRedirectResult, signOut, onAuthStateChanged
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
            // Après retour, getRedirectResult() + onAuthStateChanged() s’exécutent
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
    toggleUiForUser(user);
});

// ---- Mise à jour de l’interface ----
function toggleUiForUser(user) {
    const allowed = !!user && ALLOWED_EMAILS.includes(user.email);

    if (loginBtn)  loginBtn.hidden = !!user;
    if (logoutBtn) logoutBtn.hidden = !user;

    if (adminLink)     adminLink.hidden = !allowed;
    if (directionLink) directionLink.hidden = !allowed;

    try {
        if (user) localStorage.setItem("mk_user_email", user.email || "");
        else localStorage.removeItem("mk_user_email");
    } catch {}

    document.documentElement.classList.toggle("is-logged-in", !!user);
    document.documentElement.classList.toggle("is-admin", allowed);
}
