// js/admin-auth.js
import {
    getAuth,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

const ALLOWED_EMAILS = ["nicolas4980@gmail.com"]; // ajouter d'autres emails plus tard

const auth = getAuth(); // l'app Firebase est déjà initialisée par firebase-config.js

onAuthStateChanged(auth, (user) => {
    const allowed = !!user && ALLOWED_EMAILS.includes(user.email);

    if (!allowed) {
        // Pas connecté ou pas autorisé → retour à l'accueil
        window.location.href = "index.html";
        return;
    }

    // Optionnel: si un bouton Logout est présent dans l'admin, on l'active
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) {
        logoutBtn.hidden = false;
        logoutBtn.textContent = "Logout";
        logoutBtn.addEventListener("click", async () => {
            await signOut(auth);
            window.location.href = "index.html";
        });
    }

    // Tu peux aussi marquer le DOM (utile pour du style conditionnel)
    document.documentElement.classList.add("is-admin");
});
