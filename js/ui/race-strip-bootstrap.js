// /js/ui/race-strip-bootstrap.js
import { initRaceStrip } from './race-strip.js';

window.__FACTORY_MODE = true; // facultatif ; empêche d’autres autoboots éventuels

const container =
    document.querySelector('.race-strip-host') ||
    document.querySelector('main') ||
    document.body;

initRaceStrip(container, {
    controller: 'firebase',
    mode: 'simple',
    showPhaseNav: true
});
// Pas d’injection d’états “démo” ici.
