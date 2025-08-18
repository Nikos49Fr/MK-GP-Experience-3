// js/firebase-config.js

// Import Firebase modules (ES Modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

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

// 3) Exporte les instances DB à partir de CETTE app
export const dbFirestore = getFirestore(app);
export const dbRealtime  = getDatabase(app);
