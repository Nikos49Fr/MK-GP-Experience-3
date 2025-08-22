// js/admin-auth.js
import { app } from "./firebase-config.js";
import {
  getAuth, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// Ajoute ici les e-mails autorisés à accéder à l'admin
const ALLOWED_EMAILS = ["nicolas4980@gmail.com"];

const auth = getAuth(app);

// Garde l'admin fermé tant qu'on ne sait pas si l'utilisateur est ok
document.documentElement.classList.remove("is-admin");

onAuthStateChanged(auth, (user) => {
  const allowed = !!user && ALLOWED_EMAILS.includes(user.email);

  if (!allowed) {
    // Non connecté OU non autorisé → retour à l'accueil
    window.location.replace("../index.html");
    return;
  }

  // OK admin
  document.documentElement.classList.add("is-admin");

  // Bouton logout si présent
  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.hidden = false;
    logoutBtn.textContent = "Logout";
    logoutBtn.onclick = async () => {
      try { await signOut(auth); } finally {
        window.location.replace("../index.html");
      }
    };
  }
});
