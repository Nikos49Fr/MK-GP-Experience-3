// /js/ui/classement-bootstrap.js
// Bootstrap "factory" pour le widget classement en mode standalone (overlay)
// - n'altère pas le fonctionnement auto existant de classement.js
// - si l'IIFE de classement.js a déjà rendu, on ne fait rien
// - sinon, on appelle initClassement() proprement.

import { initClassement } from './classement.js';

(function () {
    // On attend que le DOM soit là
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }

    function mount() {
        // Si l'IIFE a déjà construit l'arbre (présence d'éléments internes), on ne double pas
        const hasAutoBoot =
            !!document.querySelector('.classement-widget .cw-header') ||
            !!document.querySelector('.classement-widget .cw-list');

        if (hasAutoBoot) {
            // mode "legacy overlay" : on laisse l’IIFE de classement.js faire le job
            return;
        }

        // Sinon, on démarre via la factory sur le conteneur existant (ou on le crée si absent)
        const main = document.querySelector('main') || document.body;
        const api = initClassement(main, { forceMode: 'auto' });

        // (optionnel) attendre le 1er rendu si besoin
        // api.ready.then(() => console.log('[classement] prêt'));
    }
})();
