// Import Firebase modules (en mode ES Modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// Config de ton projet Firebase (à remplir avec tes infos)
const firebaseConfig = {
    apiKey: "TA_CLE_API",
    authDomain: "TON_PROJET.firebaseapp.com",
    databaseURL: "https://TON_PROJET-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "TON_PROJET",
    storageBucket: "TON_PROJET.appspot.com",
    messagingSenderId: "XXX",
    appId: "XXX"
};

// Initialisation Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db };
