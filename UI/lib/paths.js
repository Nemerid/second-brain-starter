'use strict';
/**
 * paths.js — racines, configuration et périmètre de confiance du visualiseur.
 *
 * Ce module est la SEULE autorité sur « quels chemins le serveur a le droit de
 * lire ou d'ouvrir ». Tout le reste du serveur passe par `dansLePerimetre()`.
 * Il est volontairement défensif : `brain.config.json` est produit par le moteur
 * (autre composant, construit en parallèle) et peut être absent ou incomplet.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const UI_DIR = path.resolve(__dirname, '..');
const KB_DIR = path.resolve(UI_DIR, '..');
const DATA_DIR = path.join(UI_DIR, 'data');
const VENDOR_DIR = path.join(UI_DIR, 'vendor');
const BRAIN_JS = path.join(KB_DIR, 'brain.js');

/** Repli conforme au DESIGN.md §1 si `brain.config.json` n'existe pas encore. */
const SOURCES_PAR_DEFAUT = [
  {
    id: 'kb', label: 'Knowledge Base', color: '#4ade80', root: '.',
    distilled: ['wiki'], raw: ['raw'], outputs: ['outputs'],
  },
];

function lireJson(fichier, defaut) {
  try {
    return JSON.parse(fs.readFileSync(fichier, 'utf8'));
  } catch (_) {
    return defaut;
  }
}

/** Configuration du visualiseur (UI/config.json), fusionnée avec des valeurs sûres. */
function lireConfigUI() {
  const brut = lireJson(path.join(UI_DIR, 'config.json'), {});
  const c = brut && typeof brut === 'object' ? brut : {};
  return {
    port: Number(c.port) || 4321,
    hote: typeof c.hote === 'string' ? c.hote : '127.0.0.1',
    editeur: Object.assign(
      { application: '', repli: 'open -t', schemaUrl: 'vscode://file/{chemin}:{ligne}' },
      c.editeur || {}
    ),
    indexation: Object.assign(
      { auto: true, debounceMs: 300, timeoutMs: 60000 }, c.indexation || {}
    ),
    recherche: Object.assign({ k: 8, timeoutMs: 15000 }, c.recherche || {}),
    fichier: Object.assign(
      {
        maxLignes: 2000, maxOctets: 524288,
        extensions: ['.md', '.json', '.txt', '.html', '.js', '.csv'],
      },
      c.fichier || {}
    ),
    graphe: Object.assign(
      { tailleMin: 3, tailleMax: 26, ticksAvantRelache: 90, autoPauseRedraw: true },
      c.graphe || {}
    ),
  };
}

/** Sources fédérées, telles que déclarées par le moteur (ou repli DESIGN §1). */
function lireSources() {
  const brut = lireJson(path.join(KB_DIR, 'brain.config.json'), null);
  const sources = brut && Array.isArray(brut.sources) && brut.sources.length
    ? brut.sources
    : SOURCES_PAR_DEFAUT;
  const out = [];
  for (const s of sources) {
    if (!s || typeof s.id !== 'string') continue;
    const racine = path.resolve(KB_DIR, typeof s.root === 'string' ? s.root : '.');
    out.push({
      id: s.id,
      label: typeof s.label === 'string' ? s.label : s.id,
      color: typeof s.color === 'string' ? s.color : '#94a3b8',
      root: racine,
      distilled: Array.isArray(s.distilled) ? s.distilled : [],
      raw: Array.isArray(s.raw) ? s.raw : [],
      outputs: Array.isArray(s.outputs) ? s.outputs : [],
    });
  }
  return out;
}

/**
 * Racines réelles autorisées : `fs.realpathSync` appliqué une fois au démarrage,
 * pour que la comparaison ultérieure porte sur des chemins canoniques (un lien
 * symbolique planté dans une source ne peut pas faire sortir du périmètre).
 */
function calculerRacinesReelles(sources) {
  const brutes = [KB_DIR].concat(sources.map((s) => s.root));
  const vues = new Set();
  const reelles = [];
  for (const r of brutes) {
    let reel;
    try { reel = fs.realpathSync(r); } catch (_) { continue; }
    if (vues.has(reel)) continue;
    vues.add(reel);
    reelles.push(reel);
  }
  return reelles;
}

/** Vrai si `reel` (chemin déjà canonicalisé) est à l'intérieur d'une racine. */
function dansLePerimetre(reel, racines) {
  for (const racine of racines) {
    if (reel === racine || reel.startsWith(racine + path.sep)) return true;
  }
  return false;
}

/**
 * Canonicalise un chemin fourni par le client et vérifie qu'il reste confiné.
 * Lève une erreur portant `.statut` (403/404) — jamais de fuite du chemin réel.
 */
function resoudreConfine(chemin, racines, options) {
  const opts = options || {};
  if (typeof chemin !== 'string' || !chemin.trim()) {
    throw Object.assign(new Error('Chemin manquant.'), { statut: 400 });
  }
  if (chemin.indexOf('\0') !== -1) {
    throw Object.assign(new Error('Chemin invalide.'), { statut: 400 });
  }
  const absolu = path.isAbsolute(chemin) ? path.resolve(chemin) : path.resolve(KB_DIR, chemin);
  let reel;
  try {
    reel = fs.realpathSync(absolu);
  } catch (_) {
    throw Object.assign(new Error('Fichier introuvable.'), { statut: 404 });
  }
  if (!dansLePerimetre(reel, racines)) {
    throw Object.assign(
      new Error('Chemin hors du périmètre autorisé.'), { statut: 403 }
    );
  }
  const st = fs.statSync(reel);
  if (opts.dossierAutorise !== true && st.isDirectory()) {
    throw Object.assign(new Error('Ce chemin est un dossier.'), { statut: 400 });
  }
  if (Array.isArray(opts.extensions) && st.isFile()) {
    const ext = path.extname(reel).toLowerCase();
    if (opts.extensions.indexOf(ext) === -1) {
      throw Object.assign(
        new Error('Extension non autorisée en lecture : ' + (ext || '(aucune)')), { statut: 403 }
      );
    }
  }
  return { reel, stat: st };
}

/** Chemin affichable, relatif à la racine connue la plus proche. */
function cheminAffichable(reel, racines) {
  let meilleur = null;
  for (const racine of racines) {
    if (reel === racine || reel.startsWith(racine + path.sep)) {
      if (!meilleur || racine.length > meilleur.length) meilleur = racine;
    }
  }
  if (!meilleur) return reel;
  return path.basename(meilleur) + '/' + path.relative(meilleur, reel);
}

module.exports = {
  UI_DIR, KB_DIR, DATA_DIR, VENDOR_DIR, BRAIN_JS,
  HOME: os.homedir(),
  SOURCES_PAR_DEFAUT,
  lireJson, lireConfigUI, lireSources,
  calculerRacinesReelles, dansLePerimetre, resoudreConfine, cheminAffichable,
};
