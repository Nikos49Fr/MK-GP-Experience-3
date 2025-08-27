// /js/ui/classement-bootstrap.js
// Bootstrap "factory" pour le widget classement en mode standalone (overlay)
// - désactive l’autoboot du module avant chargement
// - monte le widget via initClassement() dans <main>

(function () {
    // On attend que le DOM soit prêt
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }

    async function mount() {
        // Désactiver l’autoboot AVANT de charger le module
        window.__CL_FACTORY_MODE = true;
        const { initClassement } = await import('./classement.js');

        // Conteneur : <main> si présent, sinon body
        const main = document.querySelector('main') || document.body;

        // Monter via la factory
        const api = initClassement(main, { forceMode: 'auto' });

        // (optionnel) attendre le 1er rendu si besoin
        // if (api?.ready) { try { await api.ready; } catch {} }
    }
})();
