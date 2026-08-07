'use strict';
/**
 * snapshot.js — mode dégradé (DESIGN.md §4).
 *
 * Écrit `UI/data/snapshot.js`, un simple `window.__BRAIN__ = {...}` chargé par
 * un `<script src>` classique. C'est ce qui permet d'ouvrir `UI/index.html`
 * en DOUBLE-CLIC : une page `file://` a une origine opaque et ne peut ni
 * `fetch()`, ni XHR, ni importer un module ES voisin — seul le script
 * classique passe. Dans ce mode il n'y a ni SSE, ni /api/open : l'ouverture
 * de fichier retombe sur le schéma `vscode://file/...`, le seul qui fonctionne
 * aussi bien depuis http://localhost que depuis file://.
 *
 * Rien de sensible n'entre ici : ce sont les mêmes données que /api/graph et
 * /api/layers, dont les jetons MCP sont déjà exclus par lib/layers.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');
const Graph = require('./graph');
const Layers = require('./layers');

function construire(options) {
  const opts = options || {};
  const sources = opts.sources || P.lireSources();
  const r = Graph.charger(sources);
  const couches = Layers.collecterCouches();
  couches.moteur = {
    present: fs.existsSync(P.BRAIN_JS),
    chemin: P.BRAIN_JS,
    graphe: r.origine,
  };
  return {
    generatedAt: new Date().toISOString(),
    mode: 'snapshot',
    avertissement: r.avertissement,
    config: { editeur: P.lireConfigUI().editeur, graphe: P.lireConfigUI().graphe },
    graph: r.graphe,
    layers: couches,
  };
}

function ecrire(options) {
  const donnees = construire(options);
  const fichier = path.join(P.DATA_DIR, 'snapshot.js');
  const entete =
    '/* Instantané du second cerveau — généré par `node UI/server.js --snapshot`.\n' +
    '   Fichier RÉGÉNÉRÉ : ne pas le modifier à la main.\n' +
    '   Il permet d’ouvrir UI/index.html en double-clic, sans serveur. */\n';
  fs.mkdirSync(P.DATA_DIR, { recursive: true });
  fs.writeFileSync(
    fichier,
    entete + 'window.__BRAIN__ = ' + JSON.stringify(donnees, null, 1) + ';\n',
    'utf8'
  );
  return {
    fichier,
    origine: donnees.layers.moteur.graphe,
    noeuds: donnees.graph.nodes.length,
    liens: donnees.graph.links.length,
    applications: donnees.layers.applications.length,
    routines: donnees.layers.routines.length,
    skills: donnees.layers.skills.length,
  };
}

module.exports = { construire, ecrire };
