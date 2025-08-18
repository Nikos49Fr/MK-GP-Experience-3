// Import Firebase modules (ES Modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// Config Firebase
const firebaseConfig = {
    apiKey: "AIzaSyA5QtPvvLNlgS9rd3zGGgR3tqFFoL0vObk",
    authDomain: "mk-gp-experience-3.firebaseapp.com",
    projectId: "mk-gp-experience-3",
    storageBucket: "mk-gp-experience-3.firebasestorage.app",
    messagingSenderId: "508365171020",
    appId: "1:508365171020:web:88314bc84375991fa087e9",
    databaseURL: "https://mk-gp-experience-3-default-rtdb.europe-west1.firebasedatabase.app/"
};

// Initialisation Firebase
const app = initializeApp(firebaseConfig);

// Initialisation Firestore (pour admin/config)
const dbFirestore = getFirestore(app);

// Initialisation Realtime Database (pour temps réel overlays)
const dbRealtime = getDatabase(app);

export { dbFirestore, dbRealtime };
