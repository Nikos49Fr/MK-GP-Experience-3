import { dbRealtime } from "./firebase-config.js";
import { ref, set } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

// Récup param URL
const params = new URLSearchParams(location.search);
const pilotId = params.get("id");     // ex. ENS
const token   = params.get("token");  // ex. 8kX2pQwZ

// raceId peut venir d’un select, d’une variable globale admin, etc.
const raceId = "mk8-01"; // ex: mk8-01 ... mk8-08, mkw-01..06, mkw-S1, mkw-07..12, mkw-S2

async function submitPosition(position, doublePoints) {
    const path = `currentRace/${raceId}/${pilotId}`;
    await set(ref(dbRealtime, path), {
        position: Number(position),
        double: Boolean(doublePoints),
        ts: Date.now(),
        token
    });
}
