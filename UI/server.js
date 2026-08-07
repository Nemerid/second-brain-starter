#!/usr/bin/env node
'use strict';
/* =============================================================================
 * MODÈLE DE MENACE — À LIRE AVANT TOUTE MODIFICATION DE CE FICHIER
 * =============================================================================
 * Ce serveur donne à une PAGE WEB le pouvoir de lire des fichiers du disque et
 * de lancer `open` sur la machine de l'utilisateur. Toute page ouverte dans le même
 * navigateur — y compris un site hostile — peut tenter de lui parler. Les six
 * garde-fous ci-dessous sont donc STRUCTURELS, pas cosmétiques. Aucun ne doit
 * être retiré « pour déboguer plus vite ».
 *
 *  1. ÉCOUTE LOCALE   — bind sur 127.0.0.1 uniquement, jamais 0.0.0.0. Le
 *                       serveur n'est pas joignable depuis le réseau local.
 *  2. ANTI DNS-REBIND  — l'en-tête `Host` doit valoir exactement
 *                       `localhost:PORT` ou `127.0.0.1:PORT`. Sans cela, un nom
 *                       de domaine hostile résolvant vers 127.0.0.1 contourne la
 *                       politique d'origine du navigateur.
 *  3. ORIGINE          — tout POST sans `Origin`, ou avec un `Origin` différent
 *                       de l'origine du serveur, est refusé (403). Sur GET, un
 *                       `Origin` étranger est également refusé.
 *  4. JETON DE SESSION — jeton aléatoire de 32 octets généré au démarrage,
 *                       injecté dans la page servie, exigé en `X-Brain-Token`
 *                       sur `/api/*` (et en `?token=` sur `/events`, EventSource
 *                       ne sachant pas poser d'en-tête). Il ne survit pas au
 *                       redémarrage : un onglet oublié ne peut pas resservir.
 *  5. CONFINEMENT      — tout chemin reçu passe par `path.resolve` puis
 *                       `fs.realpathSync`, et doit rester sous une racine
 *                       déclarée dans `brain.config.json`. Les liens
 *                       symboliques sont donc neutralisés. Extensions lisibles
 *                       limitées à .md .json .txt .html .js .csv.
 *  6. PAS DE SHELL     — `execFile` exclusivement, jamais `exec`, jamais
 *                       `{shell:true}`. Les arguments passent en tableau : une
 *                       requête contenant `; rm -rf ~` reste une chaîne de
 *                       caractères inerte.
 *
 * En prime : aucune valeur de `env` de ~/.claude.json n'est jamais renvoyée
 * (elle contient des jetons en clair), et les erreurs ne divulguent pas de
 * chemins hors périmètre.
 * =============================================================================
 *
 * Usage :  node UI/server.js [--port 4321] [--snapshot] [--no-watch] [--open]
 *   --snapshot   écrit UI/data/snapshot.js (mode hors-ligne, double-clic
 *                sur index.html) puis sort, sans démarrer de serveur.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const P = require('./lib/paths');
const Layers = require('./lib/layers');
const Graph = require('./lib/graph');
const Snapshot = require('./lib/snapshot');

/* ------------------------------------------------------------- arguments */

function lireArguments(argv) {
  const a = { port: null, snapshot: false, watch: true, open: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port' || v === '-p') a.port = Number(argv[++i]);
    else if (v.startsWith('--port=')) a.port = Number(v.slice(7));
    else if (v === '--snapshot') a.snapshot = true;
    else if (v === '--no-watch') a.watch = false;
    else if (v === '--open') a.open = true;
    else if (v === '--help' || v === '-h') a.aide = true;
  }
  return a;
}

const args = lireArguments(process.argv.slice(2));

if (args.aide) {
  process.stdout.write(
    'Visualiseur 4 couches du second cerveau.\n\n' +
    '  node UI/server.js [--port 4321]   démarre l\'observatoire\n' +
    '  node UI/server.js --snapshot      écrit UI/data/snapshot.js (mode hors-ligne)\n' +
    '  node UI/server.js --no-watch      sans surveillance de fichiers ni réindexation\n' +
    '  node UI/server.js --open          ouvre la page dans le navigateur au démarrage\n'
  );
  process.exit(0);
}

const CONFIG = P.lireConfigUI();
const SOURCES = P.lireSources();
const RACINES = P.calculerRacinesReelles(SOURCES);
const PORT = args.port || CONFIG.port;
const HOTE = '127.0.0.1';
const JETON = crypto.randomBytes(32).toString('hex');

if (!RACINES.length) {
  process.stderr.write(
    'Aucune racine de source accessible : vérifier brain.config.json.\n'
  );
  process.exit(1);
}

/* ------------------------------------------------------------- mode snapshot */

if (args.snapshot) {
  try {
    const r = Snapshot.ecrire({ sources: SOURCES });
    process.stdout.write(
      'Instantané écrit : ' + r.fichier + '\n' +
      '  ' + r.noeuds + ' nœuds, ' + r.liens + ' liens, ' +
      r.applications + ' applications, ' + r.routines + ' routines, ' +
      r.skills + ' skills (graphe : ' + r.origine + ').\n' +
      'La page UI/index.html s’ouvre désormais en double-clic (mode dégradé).\n'
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write('Échec de l’instantané : ' + e.message + '\n');
    process.exit(1);
  }
}

/* --------------------------------------------------------------- réponses */

const TYPES_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** En-têtes communs : rien ne doit être mis en cache ni encadré ailleurs. */
function entetes(type) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}

function repondreJson(res, statut, objet) {
  const corps = Buffer.from(JSON.stringify(objet), 'utf8');
  res.writeHead(statut, Object.assign(entetes('application/json; charset=utf-8'), {
    'Content-Length': corps.length,
  }));
  res.end(corps);
}

function repondreErreur(res, statut, message) {
  repondreJson(res, statut, { erreur: message, statut });
}

/* ----------------------------------------------------------- durcissement */

const HOTES_AUTORISES = new Set([
  'localhost:' + PORT,
  '127.0.0.1:' + PORT,
  '[::1]:' + PORT,
]);
const ORIGINES_AUTORISEES = new Set([
  'http://localhost:' + PORT,
  'http://127.0.0.1:' + PORT,
  'http://[::1]:' + PORT,
]);

/** Garde-fou 2 : anti DNS rebinding. */
function hoteValide(req) {
  return HOTES_AUTORISES.has(String(req.headers.host || '').toLowerCase());
}

/** Garde-fou 3 : origine. Absente en navigation simple (GET), interdite ailleurs. */
function origineValide(req) {
  const o = req.headers.origin;
  if (req.method === 'POST') return typeof o === 'string' && ORIGINES_AUTORISEES.has(o);
  if (o === undefined || o === null) return true;
  return ORIGINES_AUTORISEES.has(o);
}

/** Garde-fou 4 : jeton, comparé en temps constant. */
function jetonValide(fourni) {
  if (typeof fourni !== 'string' || fourni.length !== JETON.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(fourni), Buffer.from(JETON));
  } catch (_) {
    return false;
  }
}

/* -------------------------------------------------------------- brain.js */

function brainDisponible() {
  return fs.existsSync(P.BRAIN_JS);
}

/**
 * Garde-fou 6 : `execFile` sur l'exécutable Node courant, arguments en tableau.
 * Aucune interpolation de chaîne, donc aucune injection possible.
 */
function lancerBrain(argsBrain, timeoutMs) {
  return new Promise((resolve) => {
    if (!brainDisponible()) {
      resolve({ ok: false, code: 'ABSENT', stdout: '', stderr: '' });
      return;
    }
    execFile(
      process.execPath,
      [P.BRAIN_JS].concat(argsBrain),
      {
        cwd: P.KB_DIR,
        timeout: timeoutMs || 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            code: err.killed ? 'TIMEOUT' : 'ECHEC',
            message: err.message,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
          });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });
}

/* ------------------------------------------------------------------- SSE */

const abonnes = new Set();
let compteurEvenement = 0;

function diffuser(type, donnees) {
  compteurEvenement += 1;
  const charge = JSON.stringify(Object.assign({ at: new Date().toISOString() }, donnees || {}));
  const trame = 'id: ' + compteurEvenement + '\nevent: ' + type + '\ndata: ' + charge + '\n\n';
  for (const res of abonnes) {
    try { res.write(trame); } catch (_) { abonnes.delete(res); }
  }
}

/* -------------------------------------------------------------- routes */

function routeGraph(res) {
  const r = Graph.charger(SOURCES);
  repondreJson(res, 200, r.graphe);
}

function routeLayers(res) {
  let couches;
  try {
    couches = Layers.collecterCouches();
  } catch (e) {
    repondreErreur(res, 500, 'Introspection impossible : ' + e.message);
    return;
  }
  couches.moteur = {
    present: brainDisponible(),
    chemin: P.BRAIN_JS,
    graphe: fs.existsSync(Graph.FICHIER_GRAPHE) ? 'index' : 'exemple',
  };
  repondreJson(res, 200, couches);
}

async function routeSearch(res, params) {
  const q = (params.get('q') || '').trim();
  if (!q) { repondreErreur(res, 400, 'Requête vide.'); return; }
  if (q.length > 400) { repondreErreur(res, 400, 'Requête trop longue.'); return; }
  const k = Math.min(Math.max(parseInt(params.get('k'), 10) || CONFIG.recherche.k, 1), 50);

  const r = await lancerBrain(['search', q, '--json', '--k', String(k)], CONFIG.recherche.timeoutMs);
  if (r.code === 'ABSENT') {
    repondreJson(res, 503, {
      erreur: 'Le moteur brain.js n’est pas encore présent à la racine du second cerveau.',
      indisponible: true, query: q, results: [],
    });
    return;
  }
  if (!r.ok) {
    repondreJson(res, 502, {
      erreur: r.code === 'TIMEOUT'
        ? 'Le moteur n’a pas répondu dans le temps imparti.'
        : 'Le moteur a échoué : ' + (r.stderr || r.message || '').split('\n')[0],
      query: q, results: [],
    });
    return;
  }
  let sortie;
  try {
    sortie = JSON.parse(r.stdout);
  } catch (_) {
    repondreJson(res, 502, {
      erreur: 'Sortie du moteur illisible (JSON attendu).',
      query: q, results: [],
    });
    return;
  }
  repondreJson(res, 200, sortie);
}

function routeFile(res, params) {
  let cible;
  try {
    cible = P.resoudreConfine(params.get('path') || '', RACINES, {
      extensions: CONFIG.fichier.extensions,
    });
  } catch (e) {
    repondreErreur(res, e.statut || 400, e.message);
    return;
  }
  if (cible.stat.size > CONFIG.fichier.maxOctets * 8) {
    repondreErreur(res, 413, 'Fichier trop volumineux pour être affiché ici.');
    return;
  }
  let texte;
  try {
    texte = fs.readFileSync(cible.reel, 'utf8');
  } catch (_) {
    repondreErreur(res, 500, 'Lecture impossible.');
    return;
  }
  const toutes = texte.split('\n');
  const from = Math.max(parseInt(params.get('from'), 10) || 1, 1);
  const maxLignes = CONFIG.fichier.maxLignes;
  const to = Math.min(
    parseInt(params.get('to'), 10) || from + maxLignes - 1,
    toutes.length,
    from + maxLignes - 1
  );
  let extrait = toutes.slice(from - 1, to).join('\n');
  let tronque = to < toutes.length || from > 1;
  if (Buffer.byteLength(extrait, 'utf8') > CONFIG.fichier.maxOctets) {
    extrait = Buffer.from(extrait, 'utf8').slice(0, CONFIG.fichier.maxOctets).toString('utf8');
    tronque = true;
  }
  repondreJson(res, 200, {
    path: P.cheminAffichable(cible.reel, RACINES),
    abs: cible.reel,
    from, to,
    lignesTotales: toutes.length,
    octets: cible.stat.size,
    modifie: cible.stat.mtime.toISOString(),
    tronque,
    contenu: extrait,
  });
}

/**
 * `/api/pdftext` — extrait texte d'un PDF, lu depuis le cache que le moteur
 * écrit en `.brain/pdftext/<sha1(id)>.txt`. La liseuse s'en sert pour montrer
 * un aperçu d'un PDF sans jamais rendre le binaire.
 *
 * Durcissement : jeton exigé (route `/api/`), Host/Origin déjà vérifiés par le
 * répartiteur. L'identifiant reçu est HACHÉ (sha1) : même un `../` y devient une
 * chaîne hexadécimale inerte — aucun parcours de dossier possible. Le chemin
 * dérivé repasse malgré tout par `resoudreConfine` (realpath + périmètre +
 * extension .txt) ; l'absence de cache renvoie `{disponible:false}`, pas une
 * fuite. On ne lit que des `.pdf` connus, jamais un chemin arbitraire.
 */
function routePdftext(res, params) {
  const id = String(params.get('id') || '');
  if (!id || id.length > 512 || id.indexOf('\0') !== -1) {
    repondreErreur(res, 400, 'Identifiant invalide.');
    return;
  }
  if (!/\.pdf$/i.test(id)) {
    repondreErreur(res, 400, 'Identifiant non-PDF.');
    return;
  }
  const cle = crypto.createHash('sha1').update(id).digest('hex');
  const derive = path.join(P.KB_DIR, '.brain', 'pdftext', cle + '.txt');
  let cible;
  try {
    cible = P.resoudreConfine(derive, RACINES, { extensions: ['.txt'] });
  } catch (_) {
    repondreJson(res, 200, { disponible: false });
    return;
  }
  let texte;
  try {
    texte = fs.readFileSync(cible.reel, 'utf8');
  } catch (_) {
    repondreJson(res, 200, { disponible: false });
    return;
  }
  const toutes = texte.split('\n');
  const maxLignes = CONFIG.fichier.maxLignes;
  let extrait = toutes.slice(0, maxLignes).join('\n');
  let tronque = toutes.length > maxLignes;
  if (Buffer.byteLength(extrait, 'utf8') > CONFIG.fichier.maxOctets) {
    extrait = Buffer.from(extrait, 'utf8').slice(0, CONFIG.fichier.maxOctets).toString('utf8');
    tronque = true;
  }
  repondreJson(res, 200, {
    disponible: true,
    contenu: extrait,
    tronque,
    lignesTotales: toutes.length,
  });
}

function lireCorps(req, maxOctets) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    const morceaux = [];
    req.on('data', (c) => {
      taille += c.length;
      if (taille > maxOctets) {
        reject(Object.assign(new Error('Corps trop volumineux.'), { statut: 413 }));
        req.destroy();
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', reject);
  });
}

async function routeOpen(req, res) {
  let corps;
  try {
    corps = JSON.parse(await lireCorps(req, 8192) || '{}');
  } catch (e) {
    repondreErreur(res, e.statut || 400, 'Corps JSON invalide.');
    return;
  }
  const mode = corps.mode === 'edit' ? 'edit' : 'reveal';
  let cible;
  try {
    cible = P.resoudreConfine(String(corps.path || ''), RACINES, {
      dossierAutorise: true,
      extensions: mode === 'edit' ? CONFIG.fichier.extensions : null,
    });
  } catch (e) {
    repondreErreur(res, e.statut || 400, e.message);
    return;
  }

  // Garde-fou 6 : `open` reçoit ses arguments en tableau, jamais via un shell.
  let argsOpen;
  if (mode === 'reveal') {
    argsOpen = ['-R', cible.reel];
  } else if (CONFIG.editeur.application) {
    argsOpen = ['-a', CONFIG.editeur.application, cible.reel];
  } else {
    argsOpen = ['-t', cible.reel];
  }

  execFile('/usr/bin/open', argsOpen, { timeout: 8000 }, (err) => {
    if (err && mode === 'edit' && CONFIG.editeur.application) {
      // Repli documenté : éditeur de texte par défaut si l'application manque.
      execFile('/usr/bin/open', ['-t', cible.reel], { timeout: 8000 }, (err2) => {
        if (err2) { repondreErreur(res, 500, 'Ouverture impossible.'); return; }
        repondreJson(res, 200, { ok: true, mode, repli: true, path: cible.reel });
      });
      return;
    }
    if (err) { repondreErreur(res, 500, 'Ouverture impossible : ' + err.message); return; }
    repondreJson(res, 200, { ok: true, mode, path: cible.reel });
  });
}

/**
 * `POST /api/promote` — promeut une fiche brouillon en canon (boucle de
 * relecture, DESIGN §2/§6). Même durcissement que `/api/open` : jeton exigé
 * (route `/api/`), Host/Origin déjà vérifiés par le répartiteur, chemin confiné
 * aux racines des sources par `resoudreConfine` (realpath + périmètre) et limité
 * à l'extension `.md`. La promotion elle-même est déléguée à `brain.js promote`
 * via `execFile` (aucun shell) : c'est LUI qui vérifie que la fiche est bien un
 * brouillon et qui écrit atomiquement — le serveur ne réécrit jamais de fiche.
 */
async function routePromote(req, res) {
  let corps;
  try {
    corps = JSON.parse(await lireCorps(req, 8192) || '{}');
  } catch (e) {
    repondreErreur(res, e.statut || 400, 'Corps JSON invalide.');
    return;
  }
  let cible;
  try {
    cible = P.resoudreConfine(String(corps.path || ''), RACINES, { extensions: ['.md'] });
  } catch (e) {
    repondreErreur(res, e.statut || 400, e.message);
    return;
  }
  const r = await lancerBrain(['promote', cible.reel, '--json'], 15000);
  if (r.code === 'ABSENT') {
    repondreJson(res, 503, { ok: false, erreur: 'Le moteur brain.js n’est pas présent.' });
    return;
  }
  let sortie = null;
  try { sortie = JSON.parse(r.stdout); } catch (_) { sortie = null; }
  if (sortie && sortie.ok) { repondreJson(res, 200, sortie); return; }
  if (sortie && sortie.ok === false) {
    // Refus métier : introuvable (404), hors périmètre (403), pas un brouillon (409).
    const code = sortie.code === 'introuvable' ? 404
      : (sortie.code === 'hors-perimetre' ? 403 : 409);
    repondreJson(res, code, { ok: false, erreur: sortie.erreur, code: sortie.code });
    return;
  }
  repondreJson(res, 502, {
    ok: false,
    erreur: (r.stderr || r.message || 'Échec de la promotion.').split('\n')[0].slice(0, 300),
  });
}

/**
 * `POST /api/save` — enregistre le markdown édité dans la liseuse. Même
 * durcissement que les autres routes POST : jeton (route `/api/`), Host/Origin
 * vérifiés par le répartiteur, chemin confiné aux racines par `resoudreConfine`
 * (realpath + périmètre) et limité à `.md`. Refuse d'écrire dans une zone `raw/`
 * (immuable par doctrine). Filet de sécurité : l'ancien contenu est copié dans
 * `.brain/edits/` AVANT l'écrasement, qui est atomique (fichier temporaire +
 * renommage dans le même dossier). C'est la SEULE route où le serveur réécrit
 * lui-même une fiche — introduite pour l'éditeur intégré, derrière tous les
 * garde-fous, en local uniquement.
 */
async function routeSave(req, res) {
  let corps;
  try {
    corps = JSON.parse(await lireCorps(req, 4 * 1024 * 1024) || '{}');
  } catch (e) {
    repondreErreur(res, e.statut || 400, 'Corps JSON invalide.');
    return;
  }
  if (typeof corps.contenu !== 'string') {
    repondreErreur(res, 400, 'Contenu manquant ou invalide.');
    return;
  }
  if (Buffer.byteLength(corps.contenu, 'utf8') > 4 * 1024 * 1024) {
    repondreErreur(res, 413, 'Contenu trop volumineux.');
    return;
  }
  let cible;
  try {
    cible = P.resoudreConfine(String(corps.path || ''), RACINES, { extensions: ['.md'] });
  } catch (e) {
    repondreErreur(res, e.statut || 400, e.message);
    return;
  }
  // Refus d'écrire dans une zone brute (`raw/`) : immuable par doctrine.
  for (const s of P.lireSources()) {
    for (const rawDir of s.raw || []) {
      let racineRaw;
      try { racineRaw = fs.realpathSync(path.join(s.root, rawDir)); } catch (_) { continue; }
      if (cible.reel === racineRaw || cible.reel.startsWith(racineRaw + path.sep)) {
        repondreErreur(res, 403, 'Zone brute immuable : édition interdite ici.');
        return;
      }
    }
  }
  // Filet : copie de l'ancien contenu dans .brain/edits/ avant écrasement.
  try {
    const editsDir = path.join(P.KB_DIR, '.brain', 'edits');
    fs.mkdirSync(editsDir, { recursive: true });
    const tag = crypto.createHash('sha1').update(cible.reel).digest('hex').slice(0, 10);
    fs.copyFileSync(cible.reel, path.join(editsDir, tag + '-' + cible.stat.mtime.getTime() + '.md'));
  } catch (_) { /* si la sauvegarde échoue, on écrit quand même : mieux vaut sauver que perdre */ }
  // Écriture atomique : fichier temporaire dans le même dossier + renommage.
  try {
    const tmp = cible.reel + '.tmp-' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(tmp, corps.contenu, 'utf8');
    fs.renameSync(tmp, cible.reel);
  } catch (e) {
    repondreErreur(res, 500, 'Écriture impossible : ' + e.message);
    return;
  }
  const st = fs.statSync(cible.reel);
  repondreJson(res, 200, {
    ok: true,
    path: P.cheminAffichable(cible.reel, RACINES),
    abs: cible.reel,
    octets: st.size,
    modifie: st.mtime.toISOString(),
  });
}

/**
 * `POST /api/delete` — retire une fiche de la base. JAMAIS une suppression
 * définitive : la fiche est DÉPLACÉE dans une corbeille récupérable
 * (`.brain/corbeille/`) avec une ligne de manifeste qui note son emplacement
 * d'origine (donc restaurable). Mêmes garde-fous que les autres routes :
 * jeton, Host/Origin (répartiteur), chemin confiné + `.md`, refus des zones
 * brutes immuables. Le retrait du fichier déclenche le fs.watch → réindexation.
 */
async function routeDelete(req, res) {
  let corps;
  try {
    corps = JSON.parse(await lireCorps(req, 8192) || '{}');
  } catch (e) {
    repondreErreur(res, e.statut || 400, 'Corps JSON invalide.');
    return;
  }
  let cible;
  try {
    cible = P.resoudreConfine(String(corps.path || ''), RACINES, { extensions: ['.md'] });
  } catch (e) {
    repondreErreur(res, e.statut || 400, e.message);
    return;
  }
  // Pas de suppression en zone brute (`raw/`) : immuable par doctrine.
  for (const s of P.lireSources()) {
    for (const rawDir of s.raw || []) {
      let racineRaw;
      try { racineRaw = fs.realpathSync(path.join(s.root, rawDir)); } catch (_) { continue; }
      if (cible.reel === racineRaw || cible.reel.startsWith(racineRaw + path.sep)) {
        repondreErreur(res, 403, 'Zone brute immuable : suppression interdite ici.');
        return;
      }
    }
  }
  // Déplacement vers la corbeille récupérable + manifeste (jamais de rm définitif).
  try {
    const corbeille = path.join(P.KB_DIR, '.brain', 'corbeille');
    fs.mkdirSync(corbeille, { recursive: true });
    const stamp = Date.now();
    const dest = path.join(corbeille, stamp + '-' + path.basename(cible.reel));
    fs.copyFileSync(cible.reel, dest);
    fs.appendFileSync(
      path.join(corbeille, 'manifest.jsonl'),
      JSON.stringify({ at: new Date(stamp).toISOString(), original: cible.reel, corbeille: dest }) + '\n'
    );
    fs.unlinkSync(cible.reel);
    repondreJson(res, 200, {
      ok: true,
      path: P.cheminAffichable(cible.reel, RACINES),
      corbeille: dest,
    });
  } catch (e) {
    repondreErreur(res, 500, 'Suppression impossible : ' + e.message);
  }
}

function routeEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('event: hello\ndata: ' + JSON.stringify({
    at: new Date().toISOString(),
    surveillance: args.watch && CONFIG.indexation.auto,
    moteur: brainDisponible(),
  }) + '\n\n');
  abonnes.add(res);
  const battement = setInterval(() => {
    try { res.write(': battement\n\n'); } catch (_) { /* ignoré */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(battement);
    abonnes.delete(res);
  });
}

/**
 * `/` (index.html) et `/univers` (univers.html) — page HTML avec le jeton de
 * session injecté à la volée. Les deux pages partagent le même régime : même
 * jeton, mêmes en-têtes, même repli hors-ligne via `data/snapshot.js`.
 */
function routePage(res, nom) {
  const fichier = path.join(P.UI_DIR, nom);
  let html;
  try {
    html = fs.readFileSync(fichier, 'utf8');
  } catch (_) {
    repondreErreur(res, 500, nom + ' introuvable.');
    return;
  }
  html = html
    .replace('"__JETON_DE_SESSION__"', JSON.stringify(JETON))
    .replace('"__PORT_DU_SERVEUR__"', JSON.stringify(String(PORT)));
  const corps = Buffer.from(html, 'utf8');
  res.writeHead(200, Object.assign(entetes(TYPES_MIME['.html']), {
    'Content-Length': corps.length,
  }));
  res.end(corps);
}

/**
 * Statique : uniquement `vendor/` et `data/`. Le code serveur (`lib/`) et les
 * fichiers de configuration ne sont pas servis — la page n'en a pas besoin.
 */
const DOSSIERS_SERVIS = ['vendor', 'data'];

function routeStatique(res, urlPath) {
  const relatif = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const premier = relatif.split('/')[0];
  if (DOSSIERS_SERVIS.indexOf(premier) === -1) {
    repondreErreur(res, 404, 'Ressource introuvable.');
    return;
  }
  const absolu = path.resolve(P.UI_DIR, relatif);
  let reel;
  try { reel = fs.realpathSync(absolu); } catch (_) {
    repondreErreur(res, 404, 'Ressource introuvable.');
    return;
  }
  const racineUI = fs.realpathSync(P.UI_DIR);
  if (reel !== racineUI && !reel.startsWith(racineUI + path.sep)) {
    repondreErreur(res, 403, 'Ressource hors du dossier UI.');
    return;
  }
  const ext = path.extname(reel).toLowerCase();
  if (!TYPES_MIME[ext]) { repondreErreur(res, 403, 'Type de ressource non servi.'); return; }
  let st;
  try { st = fs.statSync(reel); } catch (_) {
    repondreErreur(res, 404, 'Ressource introuvable.'); return;
  }
  if (!st.isFile()) { repondreErreur(res, 404, 'Ressource introuvable.'); return; }
  res.writeHead(200, Object.assign(entetes(TYPES_MIME[ext]), { 'Content-Length': st.size }));
  fs.createReadStream(reel).pipe(res);
}

/* ------------------------------------------------------------- répartiteur */

const serveur = http.createServer(async (req, res) => {
  try {
    if (!hoteValide(req)) {
      repondreErreur(res, 403, 'En-tête Host refusé (protection anti DNS rebinding).');
      return;
    }
    if (!origineValide(req)) {
      repondreErreur(res, 403, 'Origine refusée.');
      return;
    }
    const url = new URL(req.url, 'http://' + HOTE + ':' + PORT);
    const chemin = url.pathname;

    if (chemin.startsWith('/api/')) {
      if (!jetonValide(req.headers['x-brain-token'])) {
        repondreErreur(res, 403, 'Jeton de session absent ou invalide (X-Brain-Token).');
        return;
      }
      if (chemin === '/api/graph' && req.method === 'GET') return routeGraph(res);
      if (chemin === '/api/layers' && req.method === 'GET') return routeLayers(res);
      if (chemin === '/api/search' && req.method === 'GET') return routeSearch(res, url.searchParams);
      if (chemin === '/api/file' && req.method === 'GET') return routeFile(res, url.searchParams);
      if (chemin === '/api/pdftext' && req.method === 'GET') return routePdftext(res, url.searchParams);
      if (chemin === '/api/open' && req.method === 'POST') return routeOpen(req, res);
      if (chemin === '/api/promote' && req.method === 'POST') return routePromote(req, res);
      if (chemin === '/api/save' && req.method === 'POST') return routeSave(req, res);
      if (chemin === '/api/delete' && req.method === 'POST') return routeDelete(req, res);
      repondreErreur(res, 404, 'Route inconnue.');
      return;
    }

    if (chemin === '/events') {
      // EventSource ne sait pas poser d'en-tête : le jeton passe en paramètre.
      if (!jetonValide(url.searchParams.get('token'))) {
        repondreErreur(res, 403, 'Jeton de session absent ou invalide.');
        return;
      }
      return routeEvents(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      repondreErreur(res, 405, 'Méthode non autorisée.');
      return;
    }
    if (chemin === '/' || chemin === '/index.html') return routePage(res, 'index.html');
    if (chemin === '/univers' || chemin === '/univers.html') return routePage(res, 'univers.html');
    return routeStatique(res, chemin);
  } catch (e) {
    repondreErreur(res, 500, 'Erreur interne : ' + e.message);
  }
});

/* --------------------------------------------------- surveillance + index */

const IGNORES = /(^|[\\/])(\.git|\.brain|node_modules|\.DS_Store|\.vscode)([\\/]|$)/;
const IGNORES_SORTIES = /(^|[\\/])UI[\\/]data[\\/]/;

let minuterie = null;
let indexationEnCours = false;
let indexationEnAttente = false;

function planifierIndexation(raison) {
  if (minuterie) clearTimeout(minuterie);
  minuterie = setTimeout(() => {
    minuterie = null;
    lancerIndexation(raison);
  }, Math.max(Number(CONFIG.indexation.debounceMs) || 300, 50));
}

async function lancerIndexation(raison) {
  if (indexationEnCours) { indexationEnAttente = true; return; }
  indexationEnCours = true;
  diffuser('indexation', { etat: 'debut', raison });
  const r = await lancerBrain(['index'], CONFIG.indexation.timeoutMs);
  indexationEnCours = false;
  if (r.code === 'ABSENT') {
    // Le moteur n'est pas encore là : on rafraîchit quand même la page,
    // le graphe d'exemple ou l'ancien graph.json restant valables.
    diffuser('refresh', { moteur: false, raison });
  } else if (r.ok) {
    diffuser('refresh', { moteur: true, raison });
  } else {
    diffuser('refresh', {
      moteur: true, raison,
      erreur: (r.stderr || r.message || '').split('\n')[0].slice(0, 300),
    });
  }
  if (indexationEnAttente) {
    indexationEnAttente = false;
    planifierIndexation('reprise');
  }
}

const surveillants = [];

function surveiller() {
  if (!args.watch || !CONFIG.indexation.auto) return;
  for (const racine of RACINES) {
    try {
      const w = fs.watch(racine, { recursive: true, persistent: false }, (type, nom) => {
        const rel = nom ? String(nom) : '';
        // Un événement fs.watch isolé n'est pas fiable (doublons, `filename`
        // parfois absent) : il ne sert que de déclencheur, l'état est toujours
        // relu ensuite via brain.js puis graph.json.
        if (rel && (IGNORES.test(rel) || IGNORES_SORTIES.test(rel))) return;
        planifierIndexation(rel || 'modification');
      });
      w.on('error', () => { /* volume externe démonté : on n'insiste pas */ });
      surveillants.push(w);
    } catch (_) {
      process.stderr.write('Surveillance impossible sur ' + racine + '\n');
    }
  }
}

/* ---------------------------------------------------------------- démarrage */

serveur.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    process.stderr.write(
      'Le port ' + PORT + ' est déjà pris. Relancer avec --port <autre port>.\n'
    );
    process.exit(1);
  }
  process.stderr.write('Erreur du serveur : ' + e.message + '\n');
  process.exit(1);
});

serveur.listen(PORT, HOTE, () => {
  const url = 'http://127.0.0.1:' + PORT + '/';
  const g = Graph.charger(SOURCES);
  process.stdout.write(
    'Observatoire du second cerveau\n' +
    '  Adresse    : ' + url + '\n' +
    '  Racines    : ' + RACINES.length + ' (' +
      SOURCES.filter((s) => {
        try { return RACINES.indexOf(fs.realpathSync(s.root)) !== -1; } catch (_) { return false; }
      }).map((s) => s.id).join(', ') + ')\n' +
    '  Moteur     : ' + (brainDisponible() ? 'brain.js présent' : 'brain.js ABSENT (recherche indisponible)') + '\n' +
    '  Graphe     : ' + g.origine + ' — ' + g.graphe.nodes.length + ' nœuds, ' +
      g.graphe.links.length + ' liens\n' +
    '  Surveillance : ' + (args.watch && CONFIG.indexation.auto ? 'active (debounce ' +
      CONFIG.indexation.debounceMs + ' ms)' : 'désactivée') + '\n' +
    '  Jeton      : ' + JETON + '\n' +
    '  (le jeton est injecté dans la page ; il change à chaque démarrage)\n' +
    'Ctrl+C pour arrêter.\n'
  );
  surveiller();
  if (args.open) execFile('/usr/bin/open', [url], () => {});
});

function arreter() {
  for (const w of surveillants) { try { w.close(); } catch (_) { /* ignoré */ } }
  for (const res of abonnes) { try { res.end(); } catch (_) { /* ignoré */ } }
  serveur.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', arreter);
process.on('SIGTERM', arreter);
