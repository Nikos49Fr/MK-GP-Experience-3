// js/firebase-config.js

// Import Firebase modules (ES Modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// 1) Exporte la config (une seule source de vérité)
export const firebaseConfig = {
    apiKey: "AIzaSyCejBxSJkPZvS0wVtEcjawkbMGSrX_oXkc",
    authDomain: "mk-gp-experience-3.firebaseapp.com",
    databaseURL: "https://mk-gp-experience-3-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "mk-gp-experience-3",
    storageBucket: "mk-gp-experience-3.firebasestorage.app",
    messagingSenderId: "508365171020",
    appId: "1:508365171020:web:88314bc84375991fa087e9"
};

// 2) Initialise l’app et exporte-la
export const app = initializeApp(firebaseConfig);

// 3) Exporte les instances (auth + DB) à partir de CETTE app
export const auth = getAuth(app);
export const dbFirestore = getFirestore(app);
export const dbRealtime  = getDatabase(app);

// --- Helpers optionnels (déjà présents) ---

// Helper commun : préfère une session existante (Google) ; sinon signe en anonyme.
// Attend le 1er onAuthStateChanged AVANT de décider (évite d’écraser Google par anon).
export async function ensureAuthPrefersExisting(options = {}) {
    const { debug = false } = options;
    try {
        const {
            onAuthStateChanged, signInAnonymously,
            setPersistence, browserLocalPersistence
        } = await import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js");

        try { await setPersistence(auth, browserLocalPersistence); } catch {}

        // Attendre le 1er état restauré
        const firstUser = await new Promise((resolve) => {
            const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
        });

        if (debug) {
            console.log("[ensureAuth] first state:",
                firstUser ? (firstUser.isAnonymous ? "anonymous" : (firstUser.email || "google")) : "null");
        }

        if (firstUser) return auth; // session restaurée (Google ou anon) → on garde

        // Pas de session → anonyme
        await signInAnonymously(auth);
        if (debug) console.log("[ensureAuth] signed in anonymously");
        return auth;
    } catch (e) {
        console.warn("[ensureAuth] bootstrap failed:", e);
        return null;
    }
}

// Petit util pour tracer les (re)connexions sur une page donnée (facultatif).
export async function traceAuthState(label = "page") {
    try {
        const { onAuthStateChanged } =
            await import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js");
        onAuthStateChanged(auth, (u) => {
            if (u) console.log(`[${label}] auth:`, u.isAnonymous ? "anonymous" : (u.email || "google"));
            else   console.log(`[${label}] auth: null`);
        });
    } catch {}
}
