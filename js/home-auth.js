// js/home-auth.js
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    setPersistence,
    browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ⚙️ Config Firebase (identique à ton projet)
const firebaseConfig = {
    apiKey: "AIzaSyDLYpsehSj_Ff0v6hjqlG0D_hXVCkUo0wo",
    authDomain: "mk-gp-experience-3.firebaseapp.com",
    projectId: "mk-gp-experience-3",
    storageBucket: "mk-gp-experience-3.firebasestorage.app",
    messagingSenderId: "508365171020",
    appId: "1:508365171020:web:88314bc84375991fa087e9"
};

// Init app (évite réinit si déjà fait ailleurs)
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

// Provider Google
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

// Whitelist des comptes autorisés
const ALLOWED_EMAILS = ["nicolas4980@gmail.com"]; // ajouter d'autres emails plus tard

// UI refs
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const adminLink = document.getElementById("admin-link");
const directionLink = document.getElementById("direction-link");

// Ajuste les libellés
if (loginBtn) loginBtn.textContent = "Login";
if (logoutBtn) logoutBtn.textContent = "Logout";

// Persistance locale
setPersistence(auth, browserLocalPersistence).catch(() => { /* noop */ });

// Anti double-clic
let signing = false;

// Détection d’environnement
const host = location.hostname;
const isLocal = host === "localhost" || host === "127.0.0.1";
const isGithubPages = host.endsWith(".github.io");

// Handlers
async function doLogin() {
    if (signing) return;
    signing = true;
    try {
        // Popup d'abord (souhaité). Sur GitHub Pages, ça peut afficher un warning COOP,
        // mais on tente quand même pour garder l’expérience "popup".
        await signInWithPopup(auth, provider);
        // onAuthStateChanged se déclenchera et mettra l'UI à jour
    } catch (e) {
        // Fallback en redirect si popup bloquée
        try {
            await signInWithRedirect(auth, provider);
        } catch {
            signing = false;
            alert("Impossible d'ouvrir la connexion. Réessaie.");
        }
    } finally {
        // La fin effective se gère via onAuthStateChanged
    }
}

async function doLogout() {
    try {
        await signOut(auth);
    } finally {
        toggleUiForUser(null);
    }
}

// Écoute retour d’un éventuel redirect (silencieux sinon)
getRedirectResult(auth).catch(() => { /* noop */ });

// Clics
if (loginBtn) loginBtn.addEventListener("click", doLogin);
if (logoutBtn) logoutBtn.addEventListener("click", doLogout);

// Réagit aux changements d’état
onAuthStateChanged(auth, (user) => {
    signing = false; // réarme le bouton login
    toggleUiForUser(user);
});

// Met à jour l'interface
function toggleUiForUser(user) {
    const allowed = !!user && ALLOWED_EMAILS.includes(user.email);

    if (loginBtn) loginBtn.hidden = !!user;
    if (logoutBtn) logoutBtn.hidden = !user;

    if (adminLink) adminLink.hidden = !allowed;
    if (directionLink) directionLink.hidden = !allowed;

    try {
        if (user) localStorage.setItem("mk_user_email", user.email || "");
        else localStorage.removeItem("mk_user_email");
    } catch {}

    // Optionnel: ajoute une classe sur <body> si connecté/autorisé (utile pour du style conditionnel)
    document.documentElement.classList.toggle("is-logged-in", !!user);
    document.documentElement.classList.toggle("is-admin", allowed);
}
