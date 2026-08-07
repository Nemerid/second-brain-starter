#!/usr/bin/env node
// =============================================================================
// brain.js — moteur de recherche du Second Brain Agentic OS
//
// Contrat : knowledge_base/DESIGN.md §1, §2, §3, §5.
// Zéro dépendance : uniquement node:fs, node:path, node:zlib, node:crypto, node:util.
// Point de départ : .design/proto3.mjs (BM25F + chaîne FR validés sur corpus réel).
//
// Principe directeur : ne JAMAIS renvoyer de contenu intégral par défaut.
// La sortie est un jeu d'identifiants légers (fichier + plage de lignes) et de
// snippets courts ; c'est l'agent qui décide ensuite quoi ouvrir.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
// node:child_process — builtin, PAS une dépendance npm. Sert UNIQUEMENT à shell-outer
// vers un extracteur de texte PDF déjà présent sur la machine (pdftotext / mutool /
// python3). Le moteur reste pur : il n'indexe que du texte (DESIGN §1, §2).
const { spawnSync, execFileSync } = require('node:child_process');

const BRAIN_DIR = __dirname;
const CONFIG_PATH = path.join(BRAIN_DIR, 'brain.config.json');
// v4 : le tuple « fichier » de l'index porte désormais format / textAbs / pdfok
// (extraction PDF, DESIGN §1). Un index v3 est reconstruit sans bruit (probeIndex).
const INDEX_VERSION = 4;

// =============================================================================
// 1. CONFIGURATION
// =============================================================================

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    fail(`Configuration introuvable : ${CONFIG_PATH}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    fail(`Configuration illisible (${CONFIG_PATH}) : ${e.message}`);
  }
  cfg.extensions = cfg.extensions || ['.md', '.markdown', '.txt'];
  cfg.ignore = new Set(cfg.ignore || ['node_modules', '.git', '.brain']);
  cfg.indexDir = path.resolve(BRAIN_DIR, cfg.indexDir || '.brain');
  cfg.uiDataDir = path.resolve(BRAIN_DIR, cfg.uiDataDir || 'UI/data');
  for (const s of cfg.sources) {
    s.rootAbs = path.resolve(BRAIN_DIR, s.root);
    s.zones = {
      distilled: s.distilled || [],
      raw: s.raw || [],
      outputs: s.outputs || [],
    };
    s.available = fs.existsSync(s.rootAbs);
  }
  // Carte de contexte (DESIGN §1) : préfixe de chemin → ce que ce dossier EST.
  // Triée du plus général au plus spécifique : les descriptions se concatènent
  // dans cet ordre, comme une adresse qu'on précise.
  cfg.contextMap = Object.entries(cfg.context || {})
    .map(([prefix, text]) => ({ prefix, text: String(text) }))
    .sort((a, b) => a.prefix.length - b.prefix.length || a.prefix.localeCompare(b.prefix));
  return cfg;
}

const ZONE_WEIGHT = { distilled: 1, raw: 1, outputs: 0.7 };

/**
 * Contexte d'un fichier : concaténation des descriptions de tous les préfixes
 * qui matchent son identifiant `<source>/<chemin>`, du plus général au plus
 * spécifique. Le score dit qu'un résultat vaut moins ; le contexte dit POURQUOI.
 */
function contextForFile(cfg, fileId) {
  const parts = [];
  for (const { prefix, text } of cfg.contextMap || []) {
    if (prefix === '' || fileId === prefix || fileId.startsWith(prefix)) parts.push(text);
  }
  return parts.join(' — ');
}

function fail(msg, code = 2) {
  process.stderr.write(`brain.js : ${msg}\n`);
  process.exit(code);
}

// =============================================================================
// 1 bis. SANITISATION DES CHAÎNES ISSUES DES FICHIERS INDEXÉS
//
// Tout ce qui sort d'un fichier du disque et entre dans une sortie LUE PAR LE
// MODÈLE (snippet, titre, fil d'ariane, chemin, terme, synopsis) est de la
// DONNÉE, pas une consigne. `raw/` contient des transcriptions et des pages web
// collées, et `raw/sessions/` est alimenté automatiquement : une phrase du type
// « ignore les instructions précédentes » y remonterait telle quelle jusque dans
// le contexte, sans que personne l'ait lue.
//
// Honnêteté de portée : ceci ne rend pas l'injection impossible. Ça la fait
// passer de « marche du premier coup » à « demande une évasion ».
// =============================================================================

// Jetons de gabarit de chat et balises d'enveloppe : ce sont EUX qui donnent à
// un texte le pouvoir de se faire passer pour un tour de conversation.
const SENTINELLES = /<\|[^|>\n]{0,40}\|>|\[\/?INST\]|<<\/?SYS>>|###\s*(?:System|Instruction|Human|Assistant|Système|Consigne)\s*:|<\/?(?:source_non_verifiee|untrusted_source|system|assistant|human)\b[^>\n]{0,120}>/gi;
// Séquences ANSI (un snippet ne repeint pas le terminal de l'utilisateur).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Contrôles, et surtout les inverseurs bidirectionnels (« trojan source ») :
// un texte qui s'affiche autrement qu'il ne se lit est un piège, pas une donnée.
const CONTROLES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const LIMITE = { snippet: 420, heading: 200, breadcrumb: 300, file: 300, term: 60, contexte: 400, synopsis: 220 };

/**
 * Neutralise une chaîne venue d'un fichier indexé.
 * Le défangeage insère une espace de largeur nulle après le premier caractère :
 * lisible à l'œil pour l'utilisateur, méconnaissable pour un parseur de gabarit.
 */
function assainir(s, max = 512) {
  if (s == null) return '';
  let t = String(s).replace(ANSI, '').replace(CONTROLES, '');
  t = t.replace(SENTINELLES, (m) => m[0] + '\u200B' + m.slice(1));
  if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

// =============================================================================
// 1 ter. EXTRACTION DU TEXTE DES PDF (DESIGN §1)
//
// Le moteur reste PUR : il indexe du texte, jamais des octets de PDF. Pour un
// `.pdf`, on extrait son texte vers un cache `.brain/pdftext/<sha1-du-chemin>.txt`
// via un OUTIL SYSTÈME déjà installé (zéro dépendance npm), dans cet ordre :
//   1. pdftotext (poppler)  — `pdftotext -layout -enc UTF-8 <pdf> <out>`
//   2. mutool draw -F txt (mupdf)
//   3. python3 + pdfminer / PyPDF2 / fitz (seulement si le module s'importe)
// Aucun outil → repli GRACIEUX : le PDF est listé « non extractible » par `lint`,
// jamais une erreur bloquante. Le cache s'invalide par le couple (mtimeMs, size),
// comme le reste de l'index. `abs`/`file` d'un résultat pointent le PDF d'origine ;
// seul le TEXTE indexé/relu vient du cache.
// =============================================================================

// Scripts python3, un par module. Lisent argv[1] (pdf), écrivent argv[2] (txt).
// Le caractère \f (form feed) sépare les pages : la conversion en markdown s'en sert.
const PY_EXTRACT = {
  pdfminer:
    "import sys\nfrom pdfminer.high_level import extract_text\n"
    + "open(sys.argv[2],'w',encoding='utf-8').write(extract_text(sys.argv[1]) or '')\n",
  PyPDF2:
    "import sys\nfrom PyPDF2 import PdfReader\nr=PdfReader(sys.argv[1])\n"
    + "open(sys.argv[2],'w',encoding='utf-8').write('\\f'.join((p.extract_text() or '') for p in r.pages))\n",
  fitz:
    "import sys,fitz\nd=fitz.open(sys.argv[1])\n"
    + "open(sys.argv[2],'w',encoding='utf-8').write('\\f'.join(p.get_text() for p in d))\n",
};

// Détection mémoïsée par valeur de l'override d'environnement (les tests forcent
// `BRAIN_PDF_TOOL=none` pour éprouver le repli, ou un outil précis).
const _extractorCache = new Map();
function detectExtractor() {
  const override = process.env.BRAIN_PDF_TOOL || '';
  if (_extractorCache.has(override)) return _extractorCache.get(override);
  const r = _detectExtractor(override);
  _extractorCache.set(override, r);
  return r;
}
function _which(name) {
  try {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${name} 2>/dev/null`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim().split('\n')[0];
    return p || null;
  } catch { return null; }
}
function _tryTool(kind) {
  if (kind === 'pdftotext') { const b = _which('pdftotext'); return b ? { kind, bin: b } : null; }
  if (kind === 'mutool') { const b = _which('mutool'); return b ? { kind, bin: b } : null; }
  if (kind === 'python') {
    const py = _which('python3');
    if (!py) return null;
    for (const mod of ['pdfminer', 'PyPDF2', 'fitz']) {
      const t = spawnSync(py, ['-c', `import ${mod}`], { encoding: 'utf8' });
      if (t.status === 0) return { kind: 'python', bin: py, module: mod };
    }
    return null;
  }
  return null;
}
function _detectExtractor(override) {
  if (override === 'none') return null;
  if (override) return _tryTool(override);   // outil forcé ; absent → null (repli)
  return _tryTool('pdftotext') || _tryTool('mutool') || _tryTool('python');
}

/** Lance l'outil détecté vers `out`. Renvoie true si un fichier a bien été écrit. */
function extractPdfRaw(tool, pdf, out) {
  try {
    if (tool.kind === 'pdftotext') {
      execFileSync(tool.bin, ['-layout', '-enc', 'UTF-8', pdf, out], { stdio: 'ignore', timeout: 60000 });
    } else if (tool.kind === 'mutool') {
      execFileSync(tool.bin, ['draw', '-F', 'txt', '-o', out, pdf], { stdio: 'ignore', timeout: 60000 });
    } else if (tool.kind === 'python') {
      execFileSync(tool.bin, ['-c', PY_EXTRACT[tool.module], pdf, out], { stdio: 'ignore', timeout: 120000 });
    } else {
      return false;
    }
    return fs.existsSync(out);
  } catch { return false; }
}

/**
 * Transforme le texte brut d'un PDF en markdown synthétique : le PDF n'a pas de
 * titres, on lui en fabrique. Une section `## Page N` par page (séparateur \f) ;
 * à défaut de séparateur, des blocs `## Bloc N` de ~1500 caractères. Un `# titre`
 * (nom de fichier) chapeaute l'ensemble pour que le champ « titre » reste juste.
 */
function pdfTextToMarkdown(raw, base) {
  const title = base.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const clean = String(raw || '').replace(/\r\n?/g, '\n');
  const out = [`# ${title}`, ''];
  let emitted = 0, pageNo = 0;
  for (const pg of clean.split('\f')) {
    pageNo++;
    const t = pg.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!t) continue;
    out.push(`## Page ${pageNo}`, '', t, '');
    emitted++;
  }
  if (emitted === 0) {
    const flat = clean.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!flat) {
      return { md: `# ${title}\n\n_(PDF sans texte extractible : probablement une numérisation image, sans couche de texte.)_\n`, ok: false };
    }
    let b = 0;
    for (let i = 0; i < flat.length; i += 1500) { b++; out.push(`## Bloc ${b}`, '', flat.slice(i, i + 1500).trim(), ''); }
  }
  return { md: out.join('\n'), ok: true };
}

function pdftextDir(cfg) { return path.join(cfg.indexDir, 'pdftext'); }

/**
 * Garantit un cache texte à jour pour un PDF. Pose `f.textAbs` (le .txt du cache)
 * et `f.pdfok` (1 si du texte a été extrait, 0 sinon). Invalidation par (mtime+size)
 * via un sidecar `<sha1>.sig` (« <sig>\n<0|1> »). Idempotent et bon marché quand le
 * cache est valide. Ne JETTE jamais : un PDF illisible reste indexable (marqueur).
 */
function ensurePdfText(cfg, f) {
  const dir = pdftextDir(cfg);
  const key = crypto.createHash('sha1').update(f.id).digest('hex');
  const txt = path.join(dir, key + '.txt');
  const sigp = path.join(dir, key + '.sig');
  f.textAbs = txt;
  let cached = null;
  try { cached = fs.readFileSync(sigp, 'utf8').split('\n'); } catch { /* pas de cache */ }
  if (cached && cached[0] === f.sig && fs.existsSync(txt)) {
    const wasOk = cached[1] === '1';
    // Cache valide (même mtime+size) : on le garde. Exception : un marqueur « non
    // extractible » alors qu'un outil est désormais présent — on retente une fois
    // (l'utilisateur a pu installer pdftotext depuis la dernière indexation).
    if (wasOk || !detectExtractor()) { f.pdfok = wasOk ? 1 : 0; return; }
  }
  const tool = detectExtractor();
  const base = path.basename(f.abs);
  let md, ok = false;
  if (!tool) {
    md = `# ${base.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')}\n\n`
      + "_(PDF non extractible : aucun outil d'extraction de texte détecté sur cette machine — "
      + "installer poppler « pdftotext » ou mupdf « mutool ». Le fichier reste listé mais son contenu n'est pas cherchable.)_\n";
  } else {
    fs.mkdirSync(dir, { recursive: true });
    const tmpRaw = path.join(dir, key + '.raw.tmp-' + process.pid);
    const good = extractPdfRaw(tool, f.abs, tmpRaw);
    let raw = '';
    if (good) { try { raw = fs.readFileSync(tmpRaw, 'utf8'); } catch { /* illisible */ } }
    try { fs.unlinkSync(tmpRaw); } catch { /* rien à nettoyer */ }
    const conv = pdfTextToMarkdown(raw, base);
    md = conv.md; ok = conv.ok;
  }
  fs.mkdirSync(dir, { recursive: true });
  ecrireAtomique(txt, Buffer.from(md, 'utf8'));
  ecrireAtomique(sigp, Buffer.from(f.sig + '\n' + (ok ? '1' : '0') + '\n', 'utf8'));
  f.pdfok = ok ? 1 : 0;
  // caches en mémoire indexés par chemin de texte : le cache vient de changer.
  fileTextCache.delete(txt); lineCountCache.delete(txt); synopsisCache.delete(txt);
}

/** Chemin du TEXTE indexable d'un fichier : le PDF passe par son cache extrait. */
function textSrc(file) { return file.textAbs || file.abs; }

/** parseFile en tenant compte des PDF (parse le cache texte, pas les octets). */
function parseIndexable(cfg, f) {
  if (f.format === 'pdf') {
    if (!f.textAbs) ensurePdfText(cfg, f);
    return parseFile(f.textAbs);
  }
  return parseFile(f.abs);
}

// =============================================================================
// 2. CHAÎNE DE TOKENISATION FRANÇAISE  (reprise telle quelle de .design/proto3.mjs,
//    + traitement des mots composés exigé par DESIGN §2)
// =============================================================================

const ELISIONS = new Set(['l', 'd', 'j', 'n', 'm', 't', 's', 'c', 'qu', 'lorsqu', 'puisqu', 'quoiqu', 'jusqu']);

function fold(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Stemmer léger FR (inspiré du FrenchLightStemmer de Lucene, très réduit).
function stemFrLight(w) {
  if (w.length <= 4) return w;
  return w
    .replace(/(aux|eaux)$/, 'al')
    .replace(/(ements|ement)$/, '')
    .replace(/(ations|ation)$/, '')
    .replace(/(ities|ite|ites)$/, 'it')
    .replace(/(euses|euse|eurs|eur)$/, 'eu')
    .replace(/(issement|issant)$/, 'i')
    .replace(/(ives|ive|ifs|if)$/, 'iv')
    .replace(/(ies|ie)$/, 'i')
    .replace(/(es|s|e)$/, '');
}

const SEGMENTER = new Intl.Segmenter('fr', { granularity: 'word' });
// Groupes à trait d'union : « porte-à-porte », « vis-à-vis », « game-dev »…
const HYPHEN_GROUP = /[\p{L}\p{N}]+(?:[-‐‑–][\p{L}\p{N}]+)+/gu;

function tokenize(text, { stem = true } = {}) {
  const out = [];
  if (!text) return out;
  for (const seg of SEGMENTER.segment(text)) {
    if (!seg.isWordLike) continue;
    let w = fold(seg.segment);
    // Élision : l'entreprise -> entreprise
    const m = w.match(/^([a-z]{1,6})['’](.+)$/);
    if (m && ELISIONS.has(m[1])) w = m[2];
    if (w.length < 2) continue;
    out.push(stem ? stemFrLight(w) : w);
  }
  // Mots composés : Intl.Segmenter casse « porte-à-porte » en trois tokens ;
  // on indexe EN PLUS la forme jointe dé-tiretée (porteaporte).
  for (const g of text.matchAll(HYPHEN_GROUP)) {
    const joined = fold(g[0]).replace(/[-‐‑–]/g, '');
    if (joined.length < 2) continue;
    out.push(stem ? stemFrLight(joined) : joined);
  }
  return out;
}

function slugify(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// =============================================================================
// 3. LECTURE ET DÉCOUPAGE DES FICHIERS
// =============================================================================

const WIKILINK = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
// Ouverture/fermeture de bloc de code. Le préfixe `>` est accepté : les gabarits
// de format vivent dans des citations (« > ``` »), et un bloc non reconnu ferait
// passer ses exemples (`[[fiche-a]]`, titres) pour du contenu réel.
const FENCE_RE = /^\s*(?:>\s*)*(?:```|~~~)/;
const MERGE_MIN = 200;    // section < 200 chars : fusionnée dans la précédente
const SPLIT_MAX = 3000;   // section > 3000 chars : scindée aux paragraphes
const NAV_MAX = 400;      // section « Fiches liées » : < 400 chars et > 25 % de wikiliens

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return { fm: {}, start: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') { end = i; break; }
  }
  if (end === -1) return { fm: {}, start: 0 };
  const fm = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const c = line.indexOf(':');
    if (c > 0 && !/^\s/.test(line)) {
      fm[line.slice(0, c).trim()] = line.slice(c + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, start: end + 1 };
}

/** Décalages en caractères du début de chaque ligne (pour des tranches exactes). */
function lineOffsetsOf(lines) {
  const off = new Array(lines.length);
  let o = 0;
  for (let i = 0; i < lines.length; i++) { off[i] = o; o += lines[i].length + 1; }
  return off;
}

/** Numéro de ligne (1-based) contenant le décalage `pos`. */
function lineAt(lineOffsets, pos) {
  let lo = 0, hi = lineOffsets.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineOffsets[mid] <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans + 1;
}

/**
 * Découpe un fichier en sections H1→H6 (DESIGN §2) et en extrait les wikiliens.
 * Les numéros de ligne sont ceux du FICHIER (frontmatter compris), pour que
 * `Read offset/limit` et `brain.js show fichier#ligne` tombent juste.
 */
function parseFile(abs) {
  const rawText = fs.readFileSync(abs, 'utf8');
  const lines = rawText.split('\n');
  const lineOffsets = lineOffsetsOf(lines);
  const { fm, start } = parseFrontmatter(lines);

  // --- wikiliens (hors blocs de code) ---
  const links = [];
  {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      // Un span de code en ligne (`[[liens]]`) est du code, pas un lien : on le
      // neutralise sans décaler la ligne, pour que le numéro de ligne reste juste.
      const ligne = lines[i].replace(/`+[^`\n]*`+/g, (s) => ' '.repeat(s.length));
      WIKILINK.lastIndex = 0;
      let m;
      while ((m = WIKILINK.exec(ligne)) !== null) {
        links.push({
          target: m[1].trim(),
          anchor: (m[2] || '').trim(),
          alias: (m[3] || '').trim(),
          line: i + 1,
        });
      }
    }
  }

  // --- sections ---
  const sections = [];
  let cur = null;
  let crumb = [];
  let inFence = false;
  // `endIdx` = index (0-based) de la première ligne qui n'appartient plus à la section
  const push = (endIdx) => {
    if (!cur) return;
    cur.lineEnd = endIdx;
    cur.sEnd = endIdx < lines.length ? lineOffsets[endIdx] : rawText.length;
    sections.push(cur);
  };

  for (let i = start; i < lines.length; i++) {
    const L = lines[i];
    if (FENCE_RE.test(L)) inFence = !inFence;
    const h = !inFence && L.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const title = h[2].trim().replace(/\s+#+\s*$/, '');
      crumb = crumb.slice(0, lvl - 1);
      crumb[lvl - 1] = title;
      push(i);
      cur = {
        line: i + 1, lineEnd: i + 1, level: lvl, title,
        crumb: crumb.filter(Boolean).join(' > '), text: '',
        sOff: lineOffsets[i], sEnd: lineOffsets[i],
      };
    } else {
      if (!cur) {
        cur = {
          line: start + 1, lineEnd: start + 1, level: 0, title: '(préambule)', crumb: '', text: '',
          sOff: start < lines.length ? lineOffsets[start] : rawText.length, sEnd: rawText.length,
        };
      }
      cur.text += L + '\n';
    }
  }
  push(lines.length);

  // Titre du fichier : premier H1, sinon frontmatter, sinon nom de fichier.
  const h1 = sections.find((s) => s.level === 1);
  const title = (h1 && h1.title) || fm.titre || fm.title || fm.video
    || path.basename(abs).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  if (!h1 && sections.length && sections[0].level === 0) sections[0].title = title;

  return { fm, lines, lineOffsets, sections, links, title, rawText };
}

/** Une section est-elle purement navigationnelle (bloc « Fiches liées ») ? */
function isNavigational(section) {
  const t = section.text.trim();
  if (t.length >= NAV_MAX) return false;
  let linkChars = 0;
  WIKILINK.lastIndex = 0;
  let m;
  while ((m = WIKILINK.exec(t)) !== null) linkChars += m[0].length;
  return linkChars > t.length * 0.25 && linkChars > 0;
}

/**
 * Découpe un texte long en tranches ≤ max, en préférant, dans l'ordre :
 * une frontière de paragraphe, une fin de phrase, une frontière de mot.
 * Nécessaire pour les transcriptions, livrées en UNE seule ligne sans paragraphes.
 */
function splitRanges(t, max) {
  const parts = [];
  let i = 0;
  while (i < t.length) {
    if (t.length - i <= max) { parts.push([i, t.length]); break; }
    const hard = i + max;
    const floor = i + Math.floor(max * 0.4);
    let cut = t.lastIndexOf('\n\n', hard);
    if (cut < floor) cut = -1;
    if (cut === -1) {
      // dernière fin de phrase de la fenêtre (regex gloutonne)
      const m = t.slice(floor, hard).match(/[\s\S]*[.!?…]\s/);
      if (m) cut = floor + m[0].length;
    }
    if (cut === -1 || cut <= i) {
      const sp = t.lastIndexOf(' ', hard);
      cut = sp > floor ? sp + 1 : hard;
    }
    parts.push([i, cut]);
    i = cut;
  }
  return parts;
}

/**
 * Applique exclusion navigationnelle → fusion des courtes → scission des longues.
 * Travaille sur les décalages en caractères du fichier : chaque morceau produit
 * est une tranche EXACTE et contiguë de `rawText`, donc relisible sans re-parsing.
 */
function chunkSections(sections, rawText, lineOffsets) {
  // 1. exclusion des sections navigationnelles (versées au graphe uniquement)
  const kept = sections.filter((s) => !isNavigational(s));

  // 2. fusion des sections < MERGE_MIN dans la section conservée précédente.
  //    Cas particulier : un titre SANS corps (typiquement le H1 d'une fiche) n'est
  //    pas une unité de récupération — il est absorbé par la section SUIVANTE,
  //    dont la tranche est étendue vers l'amont pour englober le titre.
  const merged = [];
  let pending = null;
  for (const s of kept) {
    const copy = { ...s, origOff: s.sOff };
    if (pending) { copy.sOff = pending.sOff; copy.line = pending.line; pending = null; }
    if (!copy.text.trim()) { pending = copy; continue; }
    const prev = merged[merged.length - 1];
    if (copy.text.trim().length < MERGE_MIN && prev) {
      prev.sEnd = Math.max(prev.sEnd, copy.sEnd);
      prev.lineEnd = Math.max(prev.lineEnd, copy.lineEnd);
      continue;
    }
    merged.push(copy);
  }
  // un titre sans corps en fin de fichier : conservé tel quel plutôt que perdu
  if (pending) {
    const prev = merged[merged.length - 1];
    if (prev) { prev.sEnd = Math.max(prev.sEnd, pending.sEnd); prev.lineEnd = Math.max(prev.lineEnd, pending.lineEnd); }
    else merged.push(pending);
  }

  // 3. scission des sections > SPLIT_MAX (fil d'Ariane et titre répétés)
  const out = [];
  for (const s of merged) {
    const slice = rawText.slice(s.sOff, s.sEnd);
    const ranges = slice.length <= SPLIT_MAX ? [[0, slice.length]] : splitRanges(slice, SPLIT_MAX);
    ranges.forEach(([a, b], k) => {
      const text = slice.slice(a, b);
      if (!text.trim()) return;
      const off = s.sOff + a;
      const end = s.sOff + b;
      // les titres ne doivent pas être comptés deux fois (champ `title` ×4 + corps ×1)
      let body = text;
      if (k === 0) {
        while (/^#{1,6}\s/.test(body)) {
          const nl = body.indexOf('\n');
          if (nl === -1) { body = ''; break; }
          body = body.slice(nl + 1);
        }
      }
      out.push({
        line: lineAt(lineOffsets, off),
        lineEnd: lineAt(lineOffsets, Math.max(off, end - 1)),
        level: s.level, title: s.title, crumb: s.crumb, srcOff: s.origOff ?? s.sOff,
        off, end, chars: end - off, text, body,
        part: ranges.length > 1 ? k + 1 : 0, parts: ranges.length,
      });
    });
  }
  return out;
}

// =============================================================================
// 4. PARCOURS DES SOURCES FÉDÉRÉES
// =============================================================================

function walkEntry(absEntry, cfg, acc, rootAbs) {
  let st;
  try { st = fs.statSync(absEntry); } catch { return; }
  if (st.isFile()) {
    if (cfg.extensions.includes(path.extname(absEntry).toLowerCase())) {
      acc.push({ abs: absEntry, rel: path.relative(rootAbs, absEntry), mtimeMs: st.mtimeMs, size: st.size });
    }
    return;
  }
  if (!st.isDirectory()) return;
  let entries;
  try { entries = fs.readdirSync(absEntry, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || cfg.ignore.has(e.name)) continue;
    walkEntry(path.join(absEntry, e.name), cfg, acc, rootAbs);
  }
}

/** Liste tous les fichiers indexables, tous zones et sources confondues. */
function discoverFiles(cfg) {
  const out = [];
  for (const s of cfg.sources) {
    if (!s.available) continue;
    for (const zone of ['distilled', 'raw', 'outputs']) {
      for (const entry of s.zones[zone]) {
        const acc = [];
        walkEntry(path.resolve(s.rootAbs, entry), cfg, acc, s.rootAbs);
        for (const f of acc) {
          const format = path.extname(f.abs).toLowerCase() === '.pdf' ? 'pdf' : '';
          out.push({
            id: `${s.id}/${f.rel.split(path.sep).join('/')}`,
            source: s.id, zone,
            rel: f.rel.split(path.sep).join('/'),
            abs: f.abs,
            sig: `${f.mtimeMs}:${f.size}`,
            size: f.size,
            format,
          });
        }
      }
    }
  }
  // Un fichier listé deux fois (zones qui se recouvrent) : première zone gagne.
  const seen = new Set();
  return out.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}

// =============================================================================
// 5. INDEX BM25F — construction, persistance gzip, incrémental
// =============================================================================

const W = { title: 4, crumb: 1.5, meta: 2, body: 1 };  // pondération AVANT saturation
const K1 = 1.2, B = 0.75, MINLEN = 120;
// NB : `calibrate --tune` propose titre×3 meta×1.5 b=0.9 (MRR +0.01 held-out) mais
// ce réglage casse l'exclusion des sections navigationnelles (b élevé favorise le court)
// et un invariant de classement — écarté le 2026-08-07 après vérification des tests.

/**
 * Champ « meta » (poids 2) : identité du FICHIER, commune à toutes ses sections —
 * slug, chemin, frontmatter, titre du document, et texte d'ancrage entrant.
 * Le titre du document y figure parce qu'il qualifie chacune de ses sections :
 * sans lui, une fiche perd son sujet dès qu'on lit une sous-section.
 */
function metaTextOf(fileRec, fm, anchorText, fileTitle) {
  const slug = path.basename(fileRec.rel).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const fmParts = [];
  for (const key of ['titre', 'title', 'type', 'themes', 'tags', 'source', 'video', 'statut', 'temporalite']) {
    if (fm[key]) fmParts.push(String(fm[key]).replace(/[[\]"]/g, ' '));
  }
  return [slug, fileRec.rel.replace(/[/_-]/g, ' '), fileTitle || '', ...fmParts, anchorText || ''].join(' ');
}

/** Construit les documents (sections) d'un fichier + son enveloppe de graphe. */
function buildFileDocs(cfg, fileRec, anchorText) {
  const parsed = parseIndexable(cfg, fileRec);
  const chunks = chunkSections(parsed.sections, parsed.rawText, parsed.lineOffsets);
  const metaTokens = tokenize(metaTextOf(fileRec, parsed.fm, anchorText, parsed.title));
  const docs = [];
  for (const s of chunks) {
    if (!s.text.trim() && !s.title.trim()) continue;
    const fields = {
      title: tokenize(s.title),
      crumb: tokenize(s.crumb),
      meta: metaTokens,
      body: tokenize(s.body),
    };
    const tf = new Map();
    let len = 0;
    for (const [field, toks] of Object.entries(fields)) {
      const w = W[field];
      for (const t of toks) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
    }
    if (tf.size === 0) continue;
    docs.push({
      file: fileRec.id,
      line: s.line, lineEnd: s.lineEnd,
      off: s.off, end: s.end,
      heading: s.title, crumb: s.crumb,
      chars: s.chars,
      len, tf,
    });
  }
  return {
    docs,
    title: parsed.title,
    fm: parsed.fm,
    links: parsed.links.map((l) => [l.target, l.anchor, l.alias, l.line]),
  };
}

/** Texte d'ancrage entrant par fichier cible (DESIGN §2, poids 2 via le champ meta). */
function computeAnchorText(fileRecs, linksByFile) {
  const resolver = makeResolver(fileRecs);
  const anchors = new Map();
  for (const [fileId, links] of linksByFile) {
    for (const [target, anchor, alias] of links) {
      const tgt = resolver(target, fileId.split('/')[0]);
      if (!tgt) continue;
      const txt = [target.replace(/[/_-]/g, ' '), anchor, alias].filter(Boolean).join(' ');
      anchors.set(tgt, (anchors.get(tgt) || '') + ' ' + txt);
    }
  }
  return anchors;
}

/** Résout une cible de wikilien vers un identifiant de nœud. */
function makeResolver(fileRecs) {
  const byId = new Map();
  const byRel = new Map();
  const byBase = new Map();
  for (const f of fileRecs) {
    byId.set(f.id, f.id);
    const relKey = fold(f.rel.replace(/\.[^.]+$/, ''));
    if (!byRel.has(relKey)) byRel.set(relKey, []);
    byRel.get(relKey).push(f);
    const baseKey = fold(path.basename(f.rel).replace(/\.[^.]+$/, ''));
    if (!byBase.has(baseKey)) byBase.set(baseKey, []);
    byBase.get(baseKey).push(f);
  }
  return function resolve(target, preferSource) {
    const clean = target.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
    const key = fold(clean);
    if (byId.has(target)) return target;
    const pick = (list) => {
      if (!list || !list.length) return null;
      const same = list.find((f) => f.source === preferSource);
      return (same || list[0]).id;
    };
    return pick(byRel.get(key)) || pick(byBase.get(key)) || pick(byBase.get(fold(path.basename(clean))));
  };
}

function sha1File(abs) {
  return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
}

/** Sérialise l'index au format postings inversés compact, puis gzip. */
function serializeIndex(files, docs) {
  const fileIds = files.map((f) => f.id);
  const fileIdx = new Map(fileIds.map((id, i) => [id, i]));
  const post = new Map();
  docs.forEach((d, i) => {
    for (const [t, w] of d.tf) {
      let arr = post.get(t);
      if (!arr) { arr = []; post.set(t, arr); }
      arr.push(i, Math.round(w * 10));
    }
  });
  let totalLen = 0;
  for (const d of docs) totalLen += d.len;
  return {
    v: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    N: docs.length,
    avgLen: docs.length ? totalLen / docs.length : 1,
    files: files.map((f) => [f.id, f.source, f.zone, f.rel, f.abs, f.sig, f.size, f.title || '', f.sha1 || '', f.anchorSig || '',
      f.format || '', f.format === 'pdf' ? (f.textAbs || '') : '', f.pdfok ? 1 : 0]),
    links: files.map((f) => f.links || []),
    docs: docs.map((d) => [fileIdx.get(d.file), d.line, d.lineEnd, d.heading, d.crumb, d.chars, Math.round(d.len * 10), d.off, d.end]),
    post: Object.fromEntries(post),
  };
}

/** Rehydrate l'index sérialisé en structures exploitables. */
function hydrate(raw) {
  const files = raw.files.map((a, i) => ({
    id: a[0], source: a[1], zone: a[2], rel: a[3], abs: a[4], sig: a[5],
    size: a[6], title: a[7], sha1: a[8], anchorSig: a[9], links: raw.links[i] || [],
    format: a[10] || '', textAbs: a[11] || a[4], pdfok: a[12] || 0,
  }));
  const docs = raw.docs.map((a) => ({
    fileIdx: a[0], line: a[1], lineEnd: a[2], heading: a[3], crumb: a[4], chars: a[5], len: a[6] / 10,
    off: a[7], end: a[8],
  }));
  return { v: raw.v, generatedAt: raw.generatedAt, N: raw.N, avgLen: raw.avgLen, files, docs, post: raw.post };
}

/** Reconstitue les tf par document à partir des postings (pour l'incrémental). */
function transposePostings(post, nDocs) {
  const tfs = Array.from({ length: nDocs }, () => new Map());
  for (const t of Object.keys(post)) {
    const arr = post[t];
    for (let j = 0; j < arr.length; j += 2) tfs[arr[j]].set(t, arr[j + 1] / 10);
  }
  return tfs;
}

function indexPath(cfg) { return path.join(cfg.indexDir, 'index.json.gz'); }

/**
 * Écriture atomique : fichier temporaire sur le MÊME volume, puis rename.
 * Sans elle, une réindexation interrompue (volume qui se démonte, machine qui
 * s'endort) laisse un index tronqué à la place d'un index bon.
 */
function ecrireAtomique(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* rien à nettoyer */ }
    throw e;
  }
}

function saveIndex(cfg, payload) {
  ecrireAtomique(indexPath(cfg), zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 6 }));
}

/**
 * État de l'index existant SANS le charger : présent ? lisible ? combien de
 * fichiers ? Un index temporairement illisible ne doit pas laisser une
 * reconstruction partielle écraser un index sain.
 */
function probeIndex(cfg) {
  const p = indexPath(cfg);
  if (!fs.existsSync(p)) return { present: false, readable: true, files: 0 };
  try {
    const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    // Version différente : la reconstruction est ATTENDUE, pas suspecte.
    if (obj.v !== INDEX_VERSION) return { present: true, readable: true, files: 0, version: obj.v };
    return { present: true, readable: true, files: (obj.files || []).length };
  } catch {
    return { present: true, readable: false, files: 0 };
  }
}

/**
 * Garde anti-rétrécissement (DESIGN §2). Une source fédérée vit sur un volume
 * externe : démontée, elle produit un index amputé qui a l'air normal.
 * On préfère un échec bruyant à une perte silencieuse.
 */
const SHRINK_TOL = 0.9;   // perdre plus de 10 % des entrées = suspect

function verifierRetrecissement(quoi, avant, apres, force) {
  if (force || avant <= 0) return;
  if (apres < Math.floor(avant * SHRINK_TOL)) {
    fail(
      `${quoi} : le nouveau jeu compte ${apres} entrées contre ${avant} auparavant `
      + `(perte de ${avant - apres}, soit ${Math.round((1 - apres / avant) * 100)} %).\n`
      + '  Causes probables : volume externe démonté, source fédérée déplacée, '
      + 'dossier vidé par erreur, réindexation lancée pendant un démontage.\n'
      + `  Rien n'a été écrit. Vérifier d'abord « node brain.js stats », puis, si la perte est voulue : `
      + 'node brain.js index --force'
    );
  }
}

function loadIndexRaw(cfg) {
  const p = indexPath(cfg);
  if (!fs.existsSync(p)) return null;
  try {
    const obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
    if (obj.v !== INDEX_VERSION) return null;
    return obj;
  } catch { return null; }
}

/**
 * (Ré)indexation incrémentale : invalidation par le couple (mtimeMs, size),
 * plus le texte d'ancrage entrant (qui dépend des AUTRES fichiers).
 */
function runIndex(cfg, { verify = false, force = false, quiet = false } = {}) {
  const t0 = Date.now();

  // --- garde 1 : une source absente n'est pas une source vide ---------------
  const indisponibles = cfg.sources.filter((s) => !s.available);
  if (indisponibles.length && !force) {
    fail(
      'source(s) fédérée(s) indisponible(s) — indexation refusée :\n'
      + indisponibles.map((s) => `  ${s.id} → ${s.rootAbs} (introuvable)`).join('\n')
      + '\n  Cause la plus probable : le volume externe qui porte cette racine n\'est pas monté.\n'
      + '  Une source absente n\'est pas une source vide : indexer maintenant amputerait l\'index.\n'
      + '  Remonter le volume, ou assumer l\'amputation : node brain.js index --force'
    );
  }

  // --- garde 2 : ne pas écraser un index sain avec une reconstruction partielle
  const avant = probeIndex(cfg);
  if (avant.present && !avant.readable && !force) {
    fail(
      `index existant illisible : ${indexPath(cfg)}\n`
      + '  Un index temporairement illisible (volume en cours de démontage, écriture interrompue) '
      + 'laisserait une reconstruction partielle écraser un index sain.\n'
      + '  Reconstruire délibérément : node brain.js index --force'
    );
  }

  const disk = discoverFiles(cfg);
  verifierRetrecissement('index', avant.files, disk.length, force);
  const prevRaw = force ? null : loadIndexRaw(cfg);
  const prev = prevRaw ? hydrate(prevRaw) : null;
  const prevTfs = prev ? transposePostings(prev.post, prev.docs.length) : null;
  const prevByFile = new Map();
  if (prev) {
    prev.docs.forEach((d, i) => {
      const id = prev.files[d.fileIdx].id;
      if (!prevByFile.has(id)) prevByFile.set(id, []);
      prevByFile.get(id).push({ ...d, tf: prevTfs[i] });
    });
  }
  const prevFileById = new Map((prev ? prev.files : []).map((f) => [f.id, f]));

  // --- passe 1 : wikiliens de chaque fichier (réutilisés si signature intacte) ---
  const linksByFile = new Map();
  const parsedCache = new Map();
  for (const f of disk) {
    // Un PDF passe par son cache texte AVANT tout : ceci pose f.textAbs / f.pdfok
    // (et ré-extrait si la signature mtime+size a changé), même quand ses sections
    // seront réutilisées plus bas — sinon `show`/`search` perdraient le cache.
    if (f.format === 'pdf') ensurePdfText(cfg, f);
    const old = prevFileById.get(f.id);
    const unchangedSig = old && old.sig === f.sig
      && (!verify || old.sha1 === (f.sha1 = sha1File(f.abs)));
    if (unchangedSig) { linksByFile.set(f.id, old.links || []); f.title = old.title; continue; }
    const p = parseIndexable(cfg, f);
    parsedCache.set(f.id, p);
    linksByFile.set(f.id, p.links.map((l) => [l.target, l.anchor, l.alias, l.line]));
    f.title = p.title;
  }

  // --- passe 2 : texte d'ancrage entrant (dépend du graphe complet) ---
  const anchors = computeAnchorText(disk, linksByFile);

  // --- passe 3 : (re)construction des documents ---
  const files = [];
  const docs = [];
  let reused = 0, rebuilt = 0;
  for (const f of disk) {
    const anchorText = (anchors.get(f.id) || '').trim();
    const anchorSig = crypto.createHash('sha1').update(anchorText).digest('hex').slice(0, 12);
    const old = prevFileById.get(f.id);
    const canReuse = old && old.sig === f.sig && old.anchorSig === anchorSig
      && (!verify || old.sha1 === f.sha1) && prevByFile.has(f.id);
    const rec = {
      id: f.id, source: f.source, zone: f.zone, rel: f.rel, abs: f.abs,
      sig: f.sig, size: f.size, sha1: verify ? f.sha1 : (old ? old.sha1 : ''),
      anchorSig, title: f.title, links: linksByFile.get(f.id) || [],
      format: f.format || '', textAbs: textSrc(f), pdfok: f.pdfok ? 1 : 0,
    };
    if (canReuse) {
      reused++;
      for (const d of prevByFile.get(f.id)) docs.push({ ...d, file: f.id });
    } else {
      rebuilt++;
      const built = buildFileDocs(cfg, rec, anchorText);
      rec.title = built.title;
      rec.links = built.links;
      for (const d of built.docs) docs.push(d);
    }
    files.push(rec);
  }

  const payload = serializeIndex(files, docs);
  saveIndex(cfg, payload);
  // graph.json n'est écrit qu'APRÈS le succès de l'index : les deux artefacts
  // ne doivent jamais décrire deux corpus différents.
  const idx = hydrate(payload);
  const graph = buildGraph(cfg, idx);
  writeGraphJson(cfg, idx, graph, { force });

  const ms = Date.now() - t0;
  const bytes = fs.statSync(indexPath(cfg)).size;
  if (!quiet) {
    process.stdout.write(
      `Index reconstruit en ${ms} ms — ${files.length} fichiers (${rebuilt} (re)lus, ${reused} réutilisés), `
      + `${docs.length} sections, ${Object.keys(payload.post).length} termes.\n`
      + `Index : ${indexPath(cfg)} (${(bytes / 1024).toFixed(0)} Ko gzip)\n`
      + `Graphe : ${path.join(cfg.uiDataDir, 'graph.json')} (${graph.nodes.length} nœuds, ${graph.links.length} liens)\n`
    );
  }
  return { idx, graph, ms, rebuilt, reused };
}

/** Charge l'index ; le construit à la volée s'il manque (robustesse des hooks). */
function ensureIndex(cfg) {
  const raw = loadIndexRaw(cfg);
  if (raw) return hydrate(raw);
  process.stderr.write('brain.js : index absent, construction initiale…\n');
  return runIndex(cfg, { quiet: true }).idx;
}

// =============================================================================
// 6. RECHERCHE BM25F
// =============================================================================

/**
 * Seuils du garde-fou anti-faux-positif. Valeurs par défaut = celles du contrat
 * (DESIGN §2) ; `brain.js calibrate` les réajuste au corpus réel et les persiste
 * dans .brain/calibration.json, qui fait alors foi.
 */
const DEFAULT_GUARD = { threshold: 7, ratioMin: 1.5 };

function loadGuard(cfg) {
  const p = path.join(cfg.indexDir, 'calibration.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      threshold: typeof c.threshold === 'number' ? c.threshold : DEFAULT_GUARD.threshold,
      ratioMin: typeof c.ratioMin === 'number' ? c.ratioMin : DEFAULT_GUARD.ratioMin,
    };
  } catch { return { ...DEFAULT_GUARD }; }
}

function defaultThreshold(cfg) { return loadGuard(cfg).threshold; }

function zoneOk(file, opts) {
  if (opts.source && file.source !== opts.source) return false;
  if (file.zone === 'raw' && !opts.raw) return false;
  if (opts.in) {
    const needle = opts.in.replace(/^\/|\/$/g, '');
    if (!file.rel.startsWith(needle) && !file.id.startsWith(needle)) return false;
  }
  return true;
}

function scoreQuery(idx, query, opts) {
  const terms = [...new Set(tokenize(query))];
  const allowed = new Uint8Array(idx.files.length);
  idx.files.forEach((f, i) => { allowed[i] = zoneOk(f, opts) ? 1 : 0; });
  // k1 et b sont injectables UNIQUEMENT pour `calibrate --tune` (A/B hors ligne) :
  // en usage normal ce sont les constantes du contrat (DESIGN §2).
  const k1 = typeof opts.k1 === 'number' ? opts.k1 : K1;
  const bSat = typeof opts.b === 'number' ? opts.b : B;

  const acc = new Map();   // docId -> { score, hits, terms:Set }
  const N = idx.N || idx.docs.length || 1;
  for (const t of terms) {
    const arr = idx.post[t];
    if (!arr) continue;
    const n = arr.length / 2;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (let j = 0; j < arr.length; j += 2) {
      const docId = arr[j];
      const d = idx.docs[docId];
      if (!allowed[d.fileIdx]) continue;
      const f = arr[j + 1] / 10;
      const dl = Math.max(d.len, MINLEN);
      const s = idf * (f * (k1 + 1)) / (f + k1 * (1 - bSat + bSat * dl / idx.avgLen));
      let e = acc.get(docId);
      if (!e) { e = { score: 0, hits: 0, terms: [] }; acc.set(docId, e); }
      e.score += s; e.hits++; e.terms.push(t);
    }
  }

  const results = [];
  for (const [docId, e] of acc) {
    const d = idx.docs[docId];
    const file = idx.files[d.fileIdx];
    // bonus de couverture + pondération de zone (outputs ×0,7)
    const score = e.score * (1 + 0.15 * (e.hits - 1)) * (ZONE_WEIGHT[file.zone] ?? 1);
    results.push({ docId, doc: d, file, score, matched: e.terms });
  }
  results.sort((a, b) => b.score - a.score || a.docId - b.docId);
  return { terms, results };
}

/** Extrait le texte exact d'une section (tranche de caractères mémorisée à l'indexation). */
const fileTextCache = new Map();
function textOf(abs) {
  if (!fileTextCache.has(abs)) {
    try { fileTextCache.set(abs, fs.readFileSync(abs, 'utf8')); }
    catch { fileTextCache.set(abs, ''); }
  }
  return fileTextCache.get(abs);
}
function sectionText(file, doc) {
  const raw = textOf(textSrc(file));
  if (typeof doc.off === 'number' && doc.end > doc.off && doc.end <= raw.length) {
    return raw.slice(doc.off, doc.end);
  }
  // repli : le fichier a changé depuis l'indexation
  return raw.split('\n').slice(doc.line - 1, doc.lineEnd).join('\n');
}

function buildSnippet(text, queryStems, max = 240) {
  const stems = new Set(queryStems);
  // on retire le gras markdown existant : les ** du snippet signalent les termes matchés
  const clean = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__/g, '').replace(/\r/g, '');
  // position du premier terme matché
  let firstPos = -1;
  const marks = [];
  for (const seg of SEGMENTER.segment(clean)) {
    if (!seg.isWordLike) continue;
    let w = fold(seg.segment);
    const m = w.match(/^([a-z]{1,6})['’](.+)$/);
    if (m && ELISIONS.has(m[1])) w = m[2];
    if (stems.has(stemFrLight(w))) {
      marks.push([seg.index, seg.index + seg.segment.length]);
      if (firstPos === -1) firstPos = seg.index;
    }
  }
  const start = firstPos === -1 ? 0 : Math.max(0, firstPos - 60);
  const end = Math.min(clean.length, start + max);
  let out = '';
  let cursor = start;
  for (const [a, b] of marks) {
    if (b <= start || a >= end) continue;
    out += clean.slice(cursor, a) + '**' + clean.slice(a, b) + '**';
    cursor = b;
  }
  out += clean.slice(cursor, end);
  out = out.replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + out + (end < clean.length ? '…' : '');
}

/** Nombre total de lignes d'un fichier (pour l'en-tête façon diff). */
const lineCountCache = new Map();
function fileLineCount(abs) {
  if (!lineCountCache.has(abs)) lineCountCache.set(abs, textOf(abs).split('\n').length);
  return lineCountCache.get(abs);
}

/**
 * Synopsis d'une fiche : UNE ligne, tirée du frontmatter ou du titre du
 * document. JAMAIS du corps — un pointeur qui déverse n'est plus un pointeur.
 */
const synopsisCache = new Map();
function synopsisOf(file) {
  const src = textSrc(file);
  if (synopsisCache.has(src)) return synopsisCache.get(src);
  let out = '';
  try {
    const { fm } = parseFrontmatter(textOf(src).split('\n').slice(0, 60));
    for (const key of ['resume', 'résumé', 'summary', 'synopsis', 'description', 'titre', 'title']) {
      if (fm[key]) { out = String(fm[key]); break; }
    }
  } catch { /* frontmatter illisible : on retombe sur le titre */ }
  if (!out) out = file.title || path.basename(file.rel).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  out = assainir(out.replace(/\s+/g, ' ').trim(), LIMITE.synopsis);
  synopsisCache.set(src, out);
  return out;
}

/** Texte d'ancrage ENTRANT par fichier, reconstruit depuis l'index (pour `alias`). */
const anchorCache = new WeakMap();
function incomingAnchorTokens(idx) {
  if (anchorCache.has(idx)) return anchorCache.get(idx);
  const linksByFile = new Map(idx.files.map((f) => [f.id, f.links || []]));
  const texts = computeAnchorText(idx.files, linksByFile);
  const out = new Map();
  for (const [id, txt] of texts) out.set(id, new Set(tokenize(txt)));
  anchorCache.set(idx, out);
  return out;
}

/**
 * `evidence` — POURQUOI ce résultat a été retenu, sur une échelle ordinale
 * (DESIGN §2). Un score nu de 12,64 ne dit pas à un agent si la fiche existe
 * déjà sous ce nom ; `exact_title` le dit.
 *
 *   exact_title   le titre de la section, celui du document, ou le slug du
 *                 fichier est EXACTEMENT la requête (mêmes tokens, pas un de plus) ;
 *   alias         tous les termes figurent dans le texte d'ancrage des wikiliens
 *                 ENTRANTS : d'autres fiches appellent déjà celle-ci comme ça ;
 *   keyword_exact tous les termes de la requête ont été trouvés dans la section ;
 *   partial       une partie seulement.
 */
const EVIDENCE_ORDRE = ['exact_title', 'alias', 'keyword_exact', 'partial'];
function evidenceOf(idx, r, terms, query) {
  const qSet = new Set(terms);
  if (qSet.size) {
    const memeJeu = (txt) => {
      const t = new Set(tokenize(txt || ''));
      return t.size === qSet.size && [...qSet].every((x) => t.has(x));
    };
    const slugFichier = slugify(path.basename(r.file.rel).replace(/\.[^.]+$/, ''));
    if (memeJeu(r.doc.heading) || memeJeu(r.file.title) || (slugFichier && slugFichier === slugify(query))) {
      return 'exact_title';
    }
    const anchors = incomingAnchorTokens(idx).get(r.file.id);
    if (anchors && anchors.size && [...qSet].every((x) => anchors.has(x))) return 'alias';
    if (new Set(r.matched).size === qSet.size) return 'keyword_exact';
  }
  return 'partial';
}

/**
 * `creation_sure` — la seule question qui compte avant d'écrire une fiche :
 * « est-ce que ça existe déjà ? ». Dérivée de `evidence` et du seuil calibré.
 * L'incident de référence : un agent lit un score de 0,64, en conclut « aucune
 * correspondance » et écrit un doublon d'une fiche déjà nourrie.
 */
function creationSureOf(evidence, score, seuil) {
  if (evidence === 'exact_title' || evidence === 'alias') return 'exists';
  if (score >= seuil) return 'probable';
  return 'unknown';
}

/** Sources déclarées mais absentes de l'index : un silence n'est pas un vide. */
function missingSources(cfg, idx) {
  const presentes = new Set(idx.files.map((f) => f.source));
  const out = [];
  for (const s of cfg.sources) {
    if (!s.available) out.push({ id: s.id, root: s.rootAbs, raison: 'racine introuvable sur le disque (volume démonté ?)' });
    else if (!presentes.has(s.id)) out.push({ id: s.id, root: s.rootAbs, raison: "aucun fichier de cette source dans l'index" });
  }
  return out;
}

/**
 * REQUÊTE STRUCTURÉE (DESIGN §2). Une requête peut être un DOCUMENT de plusieurs
 * lignes. Chaque ligne `lex: …` est une sous-requête classée indépendamment ;
 * toute autre ligne (`intent: …`, prose, ligne vide) est de la note pour l'humain
 * et n'est PAS scorée. Une requête d'une seule ligne sans préfixe `lex:` garde
 * exactement le comportement d'origine — le hook et l'UI n'ont rien à changer.
 *
 * C'est l'AGENT qui écrit les angles : aucune expansion automatique n'est faite
 * ici (qmd a fine-tuné un modèle pour ça et recommande quand même de s'en passer,
 * l'agent appelant étant un meilleur expanseur qu'un modèle embarqué).
 */
const PREFIXE_LIGNE = /^\s*([A-Za-z_]{2,12})\s*:\s*(.*)$/;

function parseQueryDocument(query) {
  const lignes = String(query ?? '').split(/\r?\n/);
  const lex = [];
  const notes = [];
  for (const ligne of lignes) {
    const m = ligne.match(PREFIXE_LIGNE);
    if (m && m[1].toLowerCase() === 'lex') {
      const t = m[2].trim();
      if (t) lex.push(t);
    } else if (ligne.trim()) {
      notes.push(ligne.trim());
    }
  }
  return { structured: lex.length > 0, lex, notes };
}

/**
 * Reciprocal Rank Fusion (qmd — store.ts::reciprocalRankFusion).
 * contribution = poids / (60 + rang), rang à partir de 1 ; +0,05 au n°1 de
 * N'IMPORTE quelle liste et +0,02 aux n°2-3 — sans ce bonus, la RRF pure dilue
 * les correspondances exactes quand une ligne d'angle ne matche rien.
 * Aucun paramètre à calibrer, tolérante aux listes vides, 100 % déterministe.
 *
 * Le `score` conservé reste le MEILLEUR score BM25F du résultat sur l'ensemble
 * des listes : la RRF décide de l'ORDRE, jamais de l'échelle. Sans cela, le
 * garde-fou calibré (seuil ≈ 12) verrait des scores RRF ≈ 0,06 et déclarerait
 * `confidence: low` sur toutes les requêtes structurées.
 */
const RRF_K = 60;
const RRF_BONUS = { 1: 0.05, 2: 0.02, 3: 0.02 };

function reciprocalRankFusion(listes) {
  const acc = new Map();      // clé (source, fichier, ligne) -> entrée fusionnée
  const terms = [];
  const vusTerme = new Set();
  for (const l of listes) {
    for (const t of l.terms) if (!vusTerme.has(t)) { vusTerme.add(t); terms.push(t); }
    l.results.forEach((r, i) => {
      const rang = i + 1;
      const cle = `${r.file.source}\t${r.file.id}\t${r.doc.line}`;
      let e = acc.get(cle);
      if (!e) {
        e = { docId: r.docId, doc: r.doc, file: r.file, score: 0, rrf: 0, matched: [], lists: 0 };
        acc.set(cle, e);
      }
      e.rrf += l.weight / (RRF_K + rang) + (RRF_BONUS[rang] || 0);
      if (r.score > e.score) e.score = r.score;
      for (const t of r.matched) if (!e.matched.includes(t)) e.matched.push(t);
      e.lists++;
    });
  }
  const results = [...acc.values()];
  for (const e of results) e.rrf = Math.round(e.rrf * 1e6) / 1e6;
  results.sort((a, b) => b.rrf - a.rrf || b.score - a.score || a.docId - b.docId);
  return { terms, results };
}

/** Classe chaque ligne `lex:` puis fusionne (RRF). Renvoie la forme de scoreQuery. */
function scoreQueryDocument(idx, doc, opts) {
  const listes = [];
  // La requête TELLE QU'ÉCRITE (toutes les lignes d'angle mises bout à bout)
  // pèse double : c'est elle qui porte l'intention complète de l'agent.
  if (doc.lex.length > 1) {
    listes.push({ label: doc.lex.join(' '), weight: 2, ...scoreQuery(idx, doc.lex.join(' '), opts) });
  }
  for (const ligne of doc.lex) {
    listes.push({ label: ligne, weight: doc.lex.length > 1 ? 1 : 2, ...scoreQuery(idx, ligne, opts) });
  }
  const fused = reciprocalRankFusion(listes);
  fused.sub_queries = listes.map((l) => ({
    lex: assainir(l.label, LIMITE.file),
    weight: l.weight,
    normalized_terms: l.terms,
    matches: l.results.length,
    top: l.results.length ? assainir(l.results[0].file.rel, LIMITE.file) : null,
  }));
  return fused;
}

function search(cfg, idx, query, opts) {
  const k = opts.k ?? 5;
  const perFile = opts.perFile ?? 2;
  const doc = parseQueryDocument(query);
  const { terms, results, sub_queries } = doc.structured
    ? scoreQueryDocument(idx, doc, opts)
    : scoreQuery(idx, query, opts);

  // diversité : au plus `perFile` sections par fichier
  const seen = new Map();
  const diverse = [];
  for (const r of results) {
    const c = seen.get(r.file.id) || 0;
    if (c >= perFile) continue;
    seen.set(r.file.id, c + 1);
    diverse.push(r);
  }
  let top = diverse.slice(0, k);

  // expansion de voisinage (--expand) : voisins du graphe, score × 0,3
  if (opts.expand && top.length) {
    const graph = buildGraph(cfg, idx);
    const present = new Set(top.map((r) => r.file.id));
    const bestByFile = new Map();
    for (const r of results) if (!bestByFile.has(r.file.id)) bestByFile.set(r.file.id, r);
    const firstDocOfFile = new Map();
    idx.docs.forEach((d, i) => { const id = idx.files[d.fileIdx].id; if (!firstDocOfFile.has(id)) firstDocOfFile.set(id, i); });
    const candidates = [];
    for (const r of top.slice(0, 3)) {
      for (const nb of graph.neighbours.get(r.file.id) || []) {
        if (present.has(nb)) continue;
        const deg = (graph.neighbours.get(nb) || new Set()).size;
        candidates.push({ id: nb, deg, base: bestByFile.has(nb) ? bestByFile.get(nb).score : top[0].score });
      }
    }
    candidates.sort((a, b) => b.deg - a.deg);
    for (const c of candidates.slice(0, 2)) {
      if (present.has(c.id)) continue;
      const src = bestByFile.get(c.id);
      const docId = src ? src.docId : firstDocOfFile.get(c.id);
      if (docId === undefined) continue;
      const d = idx.docs[docId];
      const file = idx.files[d.fileIdx];
      if (!zoneOk(file, opts)) continue;
      present.add(c.id);
      top.push({ docId, doc: d, file, score: c.base * 0.3, matched: src ? src.matched : [], expanded: true });
    }
    top.sort((a, b) => b.score - a.score);
  }

  // Mémoire d'usage (--learn, DÉSACTIVÉE par défaut) : TROISIÈME critère de tri,
  // très faible, appliqué APRÈS le score et APRÈS la diversité — il ne fait que
  // réordonner les k résultats déjà retenus, ne modifie aucun score et n'entre
  // pas dans le garde-fou. Le décalage est plafonné à ±0,75 rang : il faut qu'un
  // résultat soit franchement préféré ET son voisin franchement contesté pour
  // qu'ils s'échangent. Une mémoire d'usage n'a pas le droit d'enterrer un
  // meilleur résultat, seulement de départager deux résultats comparables.
  if (opts.learn && top.length) {
    const appris = analyserLearning(cfg, idx, opts.at || new Date().toISOString());
    top.forEach((r, i) => {
      r.learn = appris.parFichier.get(r.file.id) || null;
      r.posTri = i - NUDGE_APPRENTISSAGE * Math.tanh(r.learn ? r.learn.score : 0);
    });
    top.sort((a, b) => a.posTri - b.posTri || a.docId - b.docId);
  }

  // garde-fou anti-faux-positif (DESIGN §2) : score max sous le seuil calibré,
  // ou distribution trop plate (score[0]/score[4]) → confiance faible.
  // Le garde-fou raisonne TOUJOURS sur les scores BM25F triés, jamais sur l'ordre
  // rendu : après une fusion RRF, le 1er résultat n'est plus forcément celui qui
  // porte le score BM25F le plus haut.
  const guard = loadGuard(cfg);
  const scoresTries = diverse.map((r) => r.score).sort((a, b) => b - a);
  const top1 = scoresTries.length ? scoresTries[0] : 0;
  const top5 = scoresTries.length >= 5 ? scoresTries[4] : null;
  let confidence = 'high';
  if (!diverse.length || top1 < guard.threshold) confidence = 'low';
  else if (top5 !== null && top5 > 0 && top1 / top5 < guard.ratioMin) confidence = 'low';

  const payload = {
    query,
    normalized_terms: terms,
    confidence,
    total_matches: results.length,
    results: top.map((r) => {
      const text = sectionText(r.file, r.doc);
      const total = fileLineCount(textSrc(r.file));
      const avant = Math.max(0, r.doc.line - 1);
      const apres = Math.max(0, total - r.doc.lineEnd);
      const span = Math.max(1, r.doc.lineEnd - r.doc.line + 1);
      const evidence = evidenceOf(idx, r, terms, query);
      // En-tête façon diff : l'agent voit d'un coup d'œil quelle PROPORTION du
      // document il tient. Sans lui, il ouvre par prudence ou se contente du
      // snippet en croyant avoir tout lu.
      const entete = `@@ -${r.doc.line},${span} @@ (${avant} avant, ${apres} après) `;
      const out = {
        source: r.file.source,
        file: assainir(r.file.rel, LIMITE.file),
        abs: r.file.abs,
        line_start: r.doc.line,
        line_end: r.doc.lineEnd,
        lines_before: avant,
        lines_after: apres,
        heading: assainir(r.doc.heading, LIMITE.heading),
        breadcrumb: assainir(r.doc.crumb || r.file.title || '', LIMITE.breadcrumb),
        context: assainir(contextForFile(cfg, r.file.id), LIMITE.contexte),
        synopsis: synopsisOf(r.file),
        score: Math.round(r.score * 100) / 100,
        evidence,
        creation_sure: creationSureOf(evidence, r.score, guard.threshold),
        matched_terms: [...new Set(r.matched)].map((t) => assainir(t, LIMITE.term)),
        chars: r.doc.chars,
        snippet: entete + assainir(buildSnippet(text, terms), LIMITE.snippet),
      };
      // Requête structurée : on expose le score de fusion ET le nombre de lignes
      // d'angle qui ont ramené cette section — c'est ça, l'aveu de corroboration.
      // Résultat issu d'un PDF : abs/file pointent le PDF, mais le texte vient du
      // cache extrait. Le champ le signale à l'agent (DESIGN §1).
      if (r.file.format === 'pdf') out.format = 'pdf';
      if (typeof r.rrf === 'number') { out.rrf = r.rrf; out.sub_queries_hit = r.lists; }
      // --learn : ce que l'USAGE a appris de cette fiche. Annotation seulement —
      // le score et la confiance n'en dépendent pas.
      if (opts.learn) out.learning = r.learn ? (r.learn.stale ? 'perimee' : r.learn.statut) : null;
      // Zone brute : le sha1 permet de remonter d'un extrait suspect aux octets exacts.
      if (r.file.zone === 'raw') {
        try { out.sha1 = crypto.createHash('sha1').update(textOf(textSrc(r.file))).digest('hex'); } catch { /* fichier illisible */ }
      }
      if (r.expanded) out.expanded = true;
      if (opts.full) out.text = assainir(text, 200000);
      return out;
    }),
  };
  if (doc.structured) {
    payload.fusion = 'rrf';
    payload.sub_queries = sub_queries;
  }
  const manquantes = missingSources(cfg, idx);
  if (manquantes.length) {
    payload.missing_sources = manquantes;
    payload.warning = 'index incomplet : ' + manquantes.map((m) => `${m.id} (${m.raison})`).join(' ; ')
      + '. Une absence de résultat ne prouve rien pour ces sources.';
  }
  if (confidence === 'low') {
    payload.hint = 'aucun résultat fiable, chercher autrement : reformuler la requête, '
      + 'ajouter --raw, ou utiliser Grep/Read directement sur les sources.';
  }
  logUsage(cfg, payload);
  return payload;
}

function logUsage(cfg, payload) {
  try {
    fs.mkdirSync(cfg.indexDir, { recursive: true });
    const chars = payload.results.reduce((s, r) => s + (r.snippet || '').length + (r.text || '').length, 0);
    const line = [
      new Date().toISOString(),
      payload.query.replace(/[\t\n]/g, ' '),
      payload.confidence,
      payload.results.length,
      chars,
    ].join('\t') + '\n';
    fs.appendFileSync(path.join(cfg.indexDir, 'usage.log'), line);
  } catch { /* la journalisation ne doit jamais faire échouer une recherche */ }
}

// =============================================================================
// 7. GRAPHE DE WIKILIENS
// =============================================================================

function buildGraph(cfg, idx) {
  const resolver = makeResolver(idx.files);
  const nodes = new Map();
  for (const f of idx.files) {
    nodes.set(f.id, {
      id: f.id, label: f.title || path.basename(f.rel), source: f.source, zone: f.zone,
      abs: f.abs, size: f.size, inbound: 0, outbound: 0, orphan: false, unprocessed: false,
      // statut lu au vol (DESIGN §3) : distingue les brouillons dans l'UI ;
      // n'est PAS persisté dans l'index (l'index reste reproductible, DESIGN §9).
      statut: f.zone === 'distilled' ? statutDeFiche(f.abs) : null,
    });
  }
  const links = [];
  const neighbours = new Map();
  const addNb = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  const broken = [];
  for (const f of idx.files) {
    for (const [target, anchor, alias, line] of f.links || []) {
      const tgt = resolver(target, f.source);
      if (tgt) {
        links.push({ source: f.id, target: tgt, broken: false });
        nodes.get(f.id).outbound++;
        if (nodes.has(tgt)) nodes.get(tgt).inbound++;
        addNb(f.id, tgt); addNb(tgt, f.id);
      } else {
        const ghostId = `ghost:${target}`;
        if (!nodes.has(ghostId)) {
          nodes.set(ghostId, {
            id: ghostId, label: target, source: f.source, zone: 'distilled',
            abs: '', size: 0, inbound: 0, outbound: 0, orphan: false, unprocessed: false,
            statut: null, ghost: true,
          });
        }
        nodes.get(ghostId).inbound++;
        nodes.get(f.id).outbound++;
        links.push({ source: f.id, target: ghostId, broken: true });
        broken.push({ from: f.id, target, anchor, alias, line });
        addNb(f.id, ghostId); addNb(ghostId, f.id);
      }
    }
  }
  // orphelines + raw non traité
  const processed = readProcessed(cfg);
  for (const n of nodes.values()) {
    if (n.ghost) continue;
    n.orphan = n.inbound === 0 && n.outbound === 0;
    if (n.source === 'kb' && n.zone === 'raw') {
      const rel = n.id.slice(n.source.length + 1);
      // Le mode d'emploi du dossier n'est pas une source à distiller : le
      // signaler « à ingérer » à perpétuité rendrait l'alerte inaudible.
      const modeDEmploi = /(^|\/)(README|_[^/]*)\.md$/i.test(rel);
      n.unprocessed = !modeDEmploi && !processed.some((p) => p.includes(rel) || rel.includes(p));
    }
  }
  return {
    nodes: [...nodes.values()],
    links,
    neighbours,
    broken,
    orphans: [...nodes.values()].filter((n) => !n.ghost && n.orphan),
  };
}

function readProcessed(cfg) {
  const kb = cfg.sources.find((s) => s.id === 'kb');
  if (!kb) return [];
  const p = path.join(kb.rootAbs, 'wiki', 'processed.md');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/(raw\/[^\s—,;]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

// --- simulation de forces maison (Fruchterman-Reingold, déterministe) --------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Pré-calcule des positions x/y stables (DESIGN §3). ~200 itérations,
 * amorcées par les positions précédentes quand graph.json existe déjà.
 */
const GRAVITY = 0.25;   // rayon d'équilibre ≈ 2 × AIRE (voir la boucle ci-dessous)

function layout(nodes, links, previous) {
  const n = nodes.length;
  if (n === 0) return;
  const AREA = 1000 * Math.sqrt(Math.max(n, 1) / 100);
  const k = Math.sqrt((AREA * AREA) / n);
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const pos = new Float64Array(n * 2);
  let seeded = 0;
  nodes.forEach((nd, i) => {
    const prev = previous && previous.get(nd.id);
    if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
      pos[i * 2] = prev.x; pos[i * 2 + 1] = prev.y; seeded++;
    } else {
      const rnd = mulberry32(hashSeed(nd.id));
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * AREA * 0.5;
      pos[i * 2] = Math.cos(a) * r; pos[i * 2 + 1] = Math.sin(a) * r;
    }
  });

  const edges = [];
  for (const l of links) {
    const a = index.get(l.source), b = index.get(l.target);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  const iterations = 200;
  const warm = seeded > n * 0.8;
  let temp = warm ? AREA / 40 : AREA / 8;
  const cool = temp / (iterations + 1);
  const disp = new Float64Array(n * 2);

  for (let it = 0; it < iterations; it++) {
    disp.fill(0);
    // répulsion O(n²) — suffisant jusqu'à quelques milliers de nœuds
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * 2] - pos[j * 2];
        let dy = pos[i * 2 + 1] - pos[j * 2 + 1];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        const ux = dx / d, uy = dy / d;
        disp[i * 2] += ux * f * d; disp[i * 2 + 1] += uy * f * d;
        disp[j * 2] -= ux * f * d; disp[j * 2 + 1] -= uy * f * d;
      }
    }
    // attraction le long des arêtes
    for (const [a, b] of edges) {
      const dx = pos[a * 2] - pos[b * 2];
      const dy = pos[a * 2 + 1] - pos[b * 2 + 1];
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / k;
      const ux = dx / d, uy = dy / d;
      disp[a * 2] -= ux * f; disp[a * 2 + 1] -= uy * f;
      disp[b * 2] += ux * f; disp[b * 2 + 1] += uy * f;
    }
    // Gravité vers le centre. Elle doit contrer la répulsion CUMULÉE des n nœuds,
    // sinon les composantes isolées (fichiers raw/ sans wikilien) partent à l'infini.
    // À l'équilibre n·k²/R = G·R, donc G = n·k²/R² : avec k² = AIRE²/n, viser un
    // rayon R = AIRE/√GRAVITY revient à poser G = GRAVITY.
    for (let i = 0; i < n; i++) {
      disp[i * 2] -= pos[i * 2] * GRAVITY;
      disp[i * 2 + 1] -= pos[i * 2 + 1] * GRAVITY;
    }
    // déplacement borné par la température
    for (let i = 0; i < n; i++) {
      const dx = disp[i * 2], dy = disp[i * 2 + 1];
      const d = Math.hypot(dx, dy) || 1;
      const m = Math.min(d, temp);
      pos[i * 2] += (dx / d) * m;
      pos[i * 2 + 1] += (dy / d) * m;
    }
    temp -= cool;
  }
  nodes.forEach((nd, i) => {
    nd.x = Math.round(pos[i * 2] * 10) / 10;
    nd.y = Math.round(pos[i * 2 + 1] * 10) / 10;
  });
}

function writeGraphJson(cfg, idx, graph, { force = false } = {}) {
  const out = path.join(cfg.uiDataDir, 'graph.json');
  let previous = null;
  let nAvant = 0;
  if (fs.existsSync(out)) {
    try {
      const old = JSON.parse(fs.readFileSync(out, 'utf8'));
      previous = new Map((old.nodes || []).map((n) => [n.id, { x: n.x, y: n.y }]));
      nAvant = (old.nodes || []).length;
    } catch {
      previous = null;
      // Graphe existant illisible : les positions x/y persistées sont le seul
      // artefact qu'on ne sait pas reconstruire. On refuse de les écraser à
      // l'aveugle (DESIGN §3).
      if (!force) {
        fail(
          `graphe existant illisible : ${out}\n`
          + '  Les positions x/y persistées ne se reconstruisent pas : elles seraient perdues.\n'
          + '  Réécrire quand même : node brain.js graph --force'
        );
      }
    }
  }
  verifierRetrecissement('graphe', nAvant, graph.nodes.length, force);
  layout(graph.nodes, graph.links, previous);
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: cfg.sources.map((s) => ({ id: s.id, label: s.label, color: s.color, root: s.rootAbs })),
    stats: {
      files: idx.files.length,
      sections: idx.docs.length,
      links: graph.links.length,
      orphans: graph.orphans.length,
      broken: graph.broken.length,
      unprocessed: graph.nodes.filter((n) => n.unprocessed).length,
    },
    nodes: graph.nodes,
    links: graph.links,
  };
  ecrireAtomique(out, JSON.stringify(payload, null, 1));
  return payload;
}

// =============================================================================
// 8. RÉSOLUTION D'UN ARGUMENT « fichier »
// =============================================================================

function resolveFileArg(idx, arg) {
  const [rawPath, frag] = String(arg).split('#');
  const p = rawPath.trim();
  const candidates = idx.files;
  let hit = candidates.find((f) => f.id === p)
    || candidates.find((f) => f.abs === path.resolve(p))
    || candidates.find((f) => f.rel === p)
    || candidates.find((f) => f.id.endsWith('/' + p))
    || candidates.find((f) => f.rel.endsWith('/' + p))
    || candidates.find((f) => path.basename(f.rel) === p)
    || candidates.find((f) => path.basename(f.rel).replace(/\.[^.]+$/, '') === p.replace(/\.[^.]+$/, ''));
  if (!hit) {
    const key = fold(p.replace(/\.[^.]+$/, ''));
    hit = candidates.find((f) => fold(path.basename(f.rel).replace(/\.[^.]+$/, '')) === key);
  }
  return { file: hit || null, fragment: frag ? frag.trim() : null };
}

// =============================================================================
// 9. SOUS-COMMANDES
// =============================================================================

/**
 * Lit un document de requête : `--query-file <chemin>`, ou `--query-file -` pour
 * l'entrée standard. Le document est écrit par l'AGENT (une ligne `lex:` par
 * angle), jamais généré par un modèle embarqué.
 */
function lireDocumentRequete(chemin) {
  try {
    return fs.readFileSync(chemin === '-' ? 0 : chemin, 'utf8');
  } catch (e) {
    fail(`document de requête illisible (${chemin}) : ${e.message}`);
  }
}

function cmdSearch(cfg, args, opts) {
  const query = (opts.queryFile ? lireDocumentRequete(opts.queryFile) : args.join(' ')).trim();
  if (!query) fail('usage : brain.js search "<requête>" [--query-file <chemin|->] [--k 5] [--per-file 2] [--raw] [--source <id>] [--in <dossier>] [--expand] [--learn] [--full] [--json]');
  const idx = ensureIndex(cfg);
  const payload = search(cfg, idx, query, opts);
  if (opts.json) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return 0; }
  // rendu texte
  const lines = [];
  if (payload.sub_queries) {
    lines.push(`Requête structurée : ${payload.sub_queries.length} liste(s) fusionnée(s) par RRF`);
    for (const s of payload.sub_queries) {
      lines.push(`   ×${s.weight}  lex: ${s.lex}  →  ${s.matches} candidat(s)${s.top ? `, 1er : ${s.top}` : ''}`);
    }
  } else {
    lines.push(`Requête : « ${payload.query} »  —  termes : ${payload.normalized_terms.join(', ') || '(aucun)'}`);
  }
  lines.push(`Confiance : ${payload.confidence === 'high' ? 'élevée' : 'faible'}  —  ${payload.total_matches} section(s) candidate(s), ${payload.results.length} retenue(s)`);
  if (payload.hint) lines.push(`Indice : ${payload.hint}`);
  if (payload.warning) lines.push(`AVERTISSEMENT : ${payload.warning}`);
  lines.push('');
  if (!payload.results.length) lines.push('Aucun résultat.');
  payload.results.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.source}] ${r.file}:${r.line_start}-${r.line_end}  (score ${r.score}${typeof r.rrf === 'number' ? `, rrf ${r.rrf} sur ${r.sub_queries_hit} liste(s)` : ''}${r.expanded ? ', voisin' : ''})`);
    lines.push(`   ${r.breadcrumb || r.heading}  —  ${r.chars} car.  —  indice : ${r.evidence}, existe déjà : ${r.creation_sure}`);
    if (r.context) lines.push(`   contexte : ${r.context}`);
    lines.push(`   ${r.snippet}`);
    if (r.text) { lines.push('   ---'); lines.push(r.text.split('\n').map((l) => '   ' + l).join('\n')); }
    lines.push('');
  });
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

function cmdShow(cfg, args, opts) {
  if (!args.length) fail('usage : brain.js show <fichier>[#<ligne|slug-de-titre>] | <fichier>:<début>:<nombre>');
  const idx = ensureIndex(cfg);

  // --- lecture par TRANCHE : « fiche.md:120:40 » ----------------------------
  // Les fiches se lisent par le moteur, pas par sed/head/tail : le chemin reste
  // canonique, la section reste l'unité, et le compteur d'usage reste honnête.
  const tranche = String(args[0]).match(/^(.*?):(\d+):(\d+)$/);
  if (tranche) {
    const { file } = resolveFileArg(idx, tranche[1]);
    if (!file) fail(`fichier introuvable dans l'index : ${tranche[1]}`);
    const parsed = parseFile(textSrc(file));
    const total = parsed.lines.length;
    const debut = Math.max(1, Math.min(total, parseInt(tranche[2], 10)));
    const nombre = Math.max(1, parseInt(tranche[3], 10));
    const fin = Math.min(total, debut + nombre - 1);
    const text = parsed.lines.slice(debut - 1, fin).join('\n');
    // Titre de la section qui CONTIENT la tranche : sans lui, la tranche flotte.
    const chunks = chunkSections(parsed.sections, parsed.rawText, parsed.lineOffsets);
    const hote = chunks.find((s) => debut >= s.line && debut <= s.lineEnd);
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        source: file.source, file: file.rel, abs: file.abs,
        line_start: debut, line_end: fin,
        lines_before: debut - 1, lines_after: total - fin,
        heading: assainir(hote ? hote.title : parsed.title, LIMITE.heading),
        breadcrumb: assainir(hote ? hote.crumb : '', LIMITE.breadcrumb),
        context: assainir(contextForFile(cfg, file.id), LIMITE.contexte),
        chars: text.length, text,
        ...pdfShowMeta(file),
      }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(
      `# ${file.source}/${file.rel}  @@ -${debut},${fin - debut + 1} @@ (${debut - 1} avant, ${total - fin} après)\n`
      + (file.format === 'pdf' ? `# ${PDF_SHOW_BANNER}\n` : '')
      + (hote && hote.crumb ? `# ${hote.crumb}\n` : '') + '\n' + text + '\n'
    );
    return 0;
  }

  const { file, fragment } = resolveFileArg(idx, args[0]);
  if (!file) fail(`fichier introuvable dans l'index : ${args[0]}`);
  const parsed = parseFile(textSrc(file));
  const chunks = chunkSections(parsed.sections, parsed.rawText, parsed.lineOffsets);
  let target = null;
  if (!fragment) {
    target = {
      line: 1, lineEnd: parsed.lines.length, title: parsed.title, crumb: '',
      off: 0, end: parsed.rawText.length,
    };
  } else if (/^\d+$/.test(fragment)) {
    const n = parseInt(fragment, 10);
    target = chunks.find((s) => n >= s.line && n <= s.lineEnd)
      || chunks.reduce((best, s) => (!best || Math.abs(s.line - n) < Math.abs(best.line - n) ? s : best), null);
  } else {
    const key = slugify(fragment);
    target = chunks.find((s) => slugify(s.title) === key)
      || chunks.find((s) => slugify(s.title).includes(key));
  }
  if (!target) fail(`section introuvable : ${args[0]}`);
  const text = parsed.rawText.slice(target.off, target.end);
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      source: file.source, file: file.rel, abs: file.abs,
      line_start: target.line, line_end: target.lineEnd,
      lines_before: Math.max(0, target.line - 1),
      lines_after: Math.max(0, parsed.lines.length - target.lineEnd),
      heading: assainir(target.title, LIMITE.heading),
      breadcrumb: assainir(target.crumb || '', LIMITE.breadcrumb),
      context: assainir(contextForFile(cfg, file.id), LIMITE.contexte),
      chars: text.length, text,
      ...pdfShowMeta(file),
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(
    `# ${file.source}/${file.rel}  (lignes ${target.line}-${target.lineEnd})\n`
    + (file.format === 'pdf' ? `# ${PDF_SHOW_BANNER}\n` : '')
    + (target.crumb ? `# ${target.crumb}\n` : '') + '\n' + text + '\n'
  );
  return 0;
}

// Bandeau/champs signalant que le texte rendu par `show` provient de l'extraction
// d'un PDF (DESIGN §1), pas des octets du fichier ouvert par l'UI.
const PDF_SHOW_BANNER = 'texte extrait du PDF (cache .brain/pdftext) — l\'original s\'ouvre via abs';
function pdfShowMeta(file) {
  return file.format === 'pdf' ? { format: 'pdf', extracted: true, note: PDF_SHOW_BANNER } : {};
}

function cmdOutline(cfg, args, opts) {
  if (!args.length) fail('usage : brain.js outline <fichier>');
  const idx = ensureIndex(cfg);
  const { file } = resolveFileArg(idx, args[0]);
  if (!file) fail(`fichier introuvable dans l'index : ${args[0]}`);
  const parsed = parseFile(textSrc(file));
  const chunks = chunkSections(parsed.sections, parsed.rawText, parsed.lineOffsets);
  const rows = parsed.sections.map((s) => ({
    level: s.level, heading: s.title, line_start: s.line, line_end: s.lineEnd,
    chars: s.sEnd - s.sOff, navigational: isNavigational(s),
    indexed_chunks: chunks.filter((c) => c.srcOff === s.sOff).length,
  }));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ source: file.source, file: file.rel, abs: file.abs, title: parsed.title, lines: parsed.lines.length, sections: rows }, null, 2) + '\n');
    return 0;
  }
  const out = [`${file.source}/${file.rel} — « ${parsed.title} » — ${parsed.lines.length} lignes`, ''];
  for (const r of rows) {
    const indent = '  '.repeat(Math.max(0, r.level - 1));
    const flag = r.navigational ? '   (navigation, hors index)'
      : r.indexed_chunks === 0 ? '   (fusionnée)'
        : r.indexed_chunks > 1 ? `   (${r.indexed_chunks} morceaux indexés)` : '';
    out.push(`${String(r.line_start).padStart(5)}–${String(r.line_end).padEnd(5)} ${String(r.chars).padStart(7)} car.  ${indent}${'#'.repeat(Math.max(r.level, 1))} ${r.heading}${flag}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function cmdRelated(cfg, args, opts) {
  if (!args.length) fail('usage : brain.js related <fichier> [--depth 2]');
  const idx = ensureIndex(cfg);
  const { file } = resolveFileArg(idx, args[0]);
  if (!file) fail(`fichier introuvable dans l'index : ${args[0]}`);
  const graph = buildGraph(cfg, idx);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depth = opts.depth ?? 2;
  const dist = new Map([[file.id, 0]]);
  let frontier = [file.id];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of graph.neighbours.get(id) || []) {
        if (dist.has(nb)) continue;
        dist.set(nb, d); next.push(nb);
      }
    }
    frontier = next;
  }
  const rows = [...dist.entries()]
    .filter(([id]) => id !== file.id)
    .map(([id, d]) => {
      const n = byId.get(id) || { label: id, source: '?', inbound: 0, outbound: 0 };
      return { id, depth: d, label: n.label, source: n.source, inbound: n.inbound, outbound: n.outbound, ghost: !!n.ghost };
    })
    .sort((a, b) => a.depth - b.depth || (b.inbound + b.outbound) - (a.inbound + a.outbound));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ file: file.id, abs: file.abs, depth, related: rows }, null, 2) + '\n');
    return 0;
  }
  const out = [`Voisinage de ${file.id} (profondeur ${depth}) — ${rows.length} fiche(s)`, ''];
  for (const r of rows) {
    out.push(`  d${r.depth}  ${r.id}${r.ghost ? '  [lien cassé]' : ''}\n       « ${r.label} »  (${r.inbound} entrant(s), ${r.outbound} sortant(s))`);
  }
  if (!rows.length) out.push('  (aucun voisin — fiche orpheline)');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function cmdGraph(cfg, args, opts) {
  const idx = ensureIndex(cfg);
  const graph = buildGraph(cfg, idx);
  const payload = writeGraphJson(cfg, idx, graph, { force: !!opts.force });
  if (opts.json) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return 0; }
  const out = [];
  out.push(`Graphe de wikiliens — ${payload.stats.files} fichiers, ${payload.stats.sections} sections, ${payload.stats.links} liens`);
  out.push(`Orphelines : ${payload.stats.orphans}   Liens cassés : ${payload.stats.broken}   raw/ non traité : ${payload.stats.unprocessed}`);
  out.push(`Écrit : ${path.join(cfg.uiDataDir, 'graph.json')}`);
  if (opts.orphans) {
    out.push('', 'Fiches orphelines (ni lien entrant, ni lien sortant) :');
    for (const n of graph.orphans) out.push(`  ${n.id}  — « ${n.label} »`);
    if (!graph.orphans.length) out.push('  (aucune)');
  }
  if (opts.broken) {
    out.push('', 'Wikiliens cassés :');
    for (const b of graph.broken) out.push(`  ${b.from}:${b.line}  →  [[${b.target}]]`);
    if (!graph.broken.length) out.push('  (aucun)');
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function cmdIndex(cfg, args, opts) {
  runIndex(cfg, { verify: !!opts.verify, force: !!opts.force });
  return 0;
}

// --- lint (DESIGN §5) --------------------------------------------------------

function cmdLint(cfg, args, opts) {
  const idx = ensureIndex(cfg);
  const graph = buildGraph(cfg, idx);
  const report = {
    generatedAt: new Date().toISOString(),
    broken_links: graph.broken.map((b) => ({ from: b.from, target: b.target, line: b.line })),
    orphans: graph.orphans.filter((n) => n.zone === 'distilled').map((n) => ({ id: n.id, label: n.label })),
    index_drift: { missing_from_index: [], missing_from_disk: [] },
    stale: [],
    duplicates: [],
    index_budget: null,
    claude_budget: null,
    context_missing: [],
    dream_issues: [],
    evidence_trail_missing: [],
    raw_unprocessed: graph.nodes.filter((n) => n.unprocessed).map((n) => n.id),
    pdf_unextractable: [],
    failures: [],
  };

  // --- PDF non extractibles (DESIGN §1) : signalés, JAMAIS un échec bloquant ---
  // Un PDF sans texte indexable (aucun outil d'extraction, ou numérisation image)
  // reste listé — mais l'agent doit savoir que son contenu n'est pas cherchable.
  {
    const outil = detectExtractor();
    for (const f of idx.files) {
      if (f.format === 'pdf' && !f.pdfok) {
        report.pdf_unextractable.push({
          id: f.id,
          raison: outil
            ? 'aucun texte extrait (PDF probablement image/numérisé, sans couche de texte)'
            : 'aucun outil d\'extraction détecté (installer poppler « pdftotext » ou mupdf « mutool »)',
        });
      }
    }
    report.pdf_unextractable.sort((a, b) => a.id.localeCompare(b.id));
  }

  // --- couverture de la carte `context` (DESIGN §1) --------------------------
  // Un dossier sans contexte déclaré est un dossier dont l'agent ne peut pas
  // dire s'il cite du canon ou une capture brute.
  {
    const vus = new Set();
    for (const f of idx.files) {
      const prefixe = `${f.source}/${f.rel.split('/')[0]}${f.rel.includes('/') ? '/' : ''}`;
      if (vus.has(prefixe)) continue;
      vus.add(prefixe);
      if (!contextForFile(cfg, f.id)) report.context_missing.push(prefixe);
    }
    report.context_missing.sort();
  }

  const kb = cfg.sources.find((s) => s.id === 'kb');
  if (kb && kb.available) {
    // --- dérive d'index : wiki/*.md sur disque vs wiki/index.md ---
    const indexMd = path.join(kb.rootAbs, 'wiki', 'index.md');
    let indexText = '';
    if (fs.existsSync(indexMd)) indexText = fs.readFileSync(indexMd, 'utf8');
    const wikiFiles = idx.files.filter((f) => f.source === 'kb' && f.zone === 'distilled'
      && f.rel.startsWith('wiki/') && !/^wiki\/(index|log|processed)\.md$/.test(f.rel));
    for (const f of wikiFiles) {
      const slug = path.basename(f.rel).replace(/\.md$/, '');
      if (!indexText.includes(slug)) report.index_drift.missing_from_index.push(f.rel);
    }
    // Les wikiliens sont relus par `parseFile` (mêmes règles que l'index : blocs
    // de code ignorés, y compris cités, et spans de code en ligne neutralisés),
    // sans quoi un gabarit de format documenté ici passerait pour une dérive.
    const cited = new Set();
    if (fs.existsSync(indexMd)) {
      try {
        for (const l of parseFile(indexMd).links) {
          cited.add(fold(l.target.trim().replace(/\.md$/, '')));
        }
      } catch (_) { /* index illisible : la dérive de citation n'est pas mesurable */ }
    }
    const onDisk = new Set(wikiFiles.map((f) => fold(path.basename(f.rel).replace(/\.md$/, ''))));
    for (const c of cited) if (!onDisk.has(c)) report.index_drift.missing_from_disk.push(c);

    // --- budget dur de wiki/index.md : 200 lignes / 25 Ko ---
    if (indexText) {
      const nLines = indexText.split('\n').length;
      const nBytes = Buffer.byteLength(indexText, 'utf8');
      report.index_budget = { lines: nLines, bytes: nBytes, max_lines: 200, max_bytes: 25600 };
      if (nLines > 200 || nBytes > 25600) {
        report.failures.push(`wiki/index.md dépasse le budget dur (${nLines} lignes, ${(nBytes / 1024).toFixed(1)} Ko ; maximum 200 lignes / 25 Ko). Lancer une passe PRUNE.`);
      }
    }

    // --- budget dur de CLAUDE.md : 200 lignes / 12 Ko (DESIGN §5) ---
    // Une règle écrite cède ; un garde qui échoue tient. CLAUDE.md est chargé
    // INTÉGRALEMENT à chaque session : son enflure se paie à chaque message.
    const claudeMd = path.join(kb.rootAbs, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const t = fs.readFileSync(claudeMd, 'utf8');
      const nLines = t.split('\n').length;
      const nBytes = Buffer.byteLength(t, 'utf8');
      report.claude_budget = { lines: nLines, bytes: nBytes, max_lines: 200, max_bytes: 12288 };
      if (nLines > 200 || nBytes > 12288) {
        report.failures.push(
          `CLAUDE.md dépasse le budget dur (${nLines} lignes, ${(nBytes / 1024).toFixed(1)} Ko ; maximum 200 lignes / 12 Ko). `
          + 'Déplacer les procédures longues vers .claude/skills/ ou .claude/rules/, et l\'historique vers wiki/log.md.'
        );
      }
    }

    // --- fraîcheur + estampille de la Dream Sequence -------------------------
    const now = Date.now();
    const revees = new Set();
    for (const f of wikiFiles) {
      const { fm } = parseFile(f.abs);
      // Estampille machine : `dream: true` dit QUI a écrit, `statut` dit si
      // c'est validé. Sans elle, la Dream Sequence re-digère sa propre
      // production au cycle suivant et dérive.
      // Valeur nettoyée d'un éventuel commentaire YAML en fin de ligne.
      const valeur = (k) => String(fm[k] || '').split('#')[0].trim();
      const reve = valeur('dream').toLowerCase() === 'true';
      if (reve) {
        revees.add(fold(path.basename(f.rel).replace(/\.md$/, '')));
        if (!valeur('dream_date')) {
          report.dream_issues.push({ file: f.rel, reason: 'estampille « dream: true » sans « dream_date »' });
        }
        if (valeur('statut') === 'canon') {
          report.dream_issues.push({ file: f.rel, reason: 'fiche écrite par la Dream Sequence promue en canon sans passer par une validation' });
        }
      }
      // Fiche à deux zones (DESIGN §6) : une fiche entity/topic sans fil de
      // preuves n'a pas d'endroit où accumuler sans risque — la consolidation
      // devra donc écraser ou ne rien toucher. AVERTISSEMENT, jamais un échec :
      // les fiches écrites avant la règle restent valides.
      const type = valeur('type');
      if (type === 'entity' || type === 'topic') {
        const corps = fs.readFileSync(f.abs, 'utf8');
        if (!/^#{2,6}\s+fil de preuves\s*$/im.test(corps)) {
          report.evidence_trail_missing.push({ file: f.rel, type });
        }
      }
      if (!fm.modified) { report.stale.push({ file: f.rel, reason: 'champ « modified » absent' }); continue; }
      const t = Date.parse(fm.modified);
      if (Number.isNaN(t)) { report.stale.push({ file: f.rel, reason: `champ « modified » illisible : ${fm.modified}` }); continue; }
      const days = Math.floor((now - t) / 86400000);
      if (days > 90) report.stale.push({ file: f.rel, reason: `non révisée depuis ${days} jours`, days });
    }
    // Auto-consommation : une fiche qui se source sur une fiche rêvée.
    if (revees.size) {
      for (const f of wikiFiles) {
        const { fm } = parseFile(f.abs);
        const src = fold(String(fm.sources || ''));
        for (const r of revees) {
          if (r && src.includes(r) && fold(path.basename(f.rel).replace(/\.md$/, '')) !== r) {
            report.dream_issues.push({ file: f.rel, reason: `se source sur « ${r} », elle-même écrite par la Dream Sequence` });
          }
        }
      }
    }
  }

  // --- doublons par similarité de slug/titre (toutes sources, zone distilled) ---
  const distilled = idx.files.filter((f) => f.zone === 'distilled');
  const bySlug = new Map();
  for (const f of distilled) {
    const key = slugify(f.title || path.basename(f.rel)).split('-').filter((w) => w.length > 3).sort().join('-');
    if (!key) continue;
    if (!bySlug.has(key)) bySlug.set(key, []);
    bySlug.get(key).push(f.id);
  }
  for (const [key, ids] of bySlug) if (ids.length > 1) report.duplicates.push({ key, files: ids });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.failures.length ? 1 : 0;
  }
  const out = ['Lint du second cerveau (passe déterministe, sans LLM)', ''];
  const block = (titre, items, fmt) => {
    out.push(`${titre} : ${items.length}`);
    for (const it of items.slice(0, 30)) out.push('   ' + fmt(it));
    if (items.length > 30) out.push(`   … et ${items.length - 30} autre(s)`);
    out.push('');
  };
  block('Wikiliens cassés', report.broken_links, (b) => `${b.from}:${b.line} → [[${b.target}]]`);
  block('Fiches orphelines', report.orphans, (o) => `${o.id} — « ${o.label} »`);
  block('Fiches sur disque absentes de wiki/index.md', report.index_drift.missing_from_index, (x) => x);
  block('Fiches citées par wiki/index.md mais absentes du disque', report.index_drift.missing_from_disk, (x) => x);
  block('Fiches non révisées / sans « modified »', report.stale, (s) => `${s.file} — ${s.reason}`);
  block('Doublons probables (titre/slug)', report.duplicates, (d) => d.files.join('  ≈  '));
  block('Fichiers raw/ absents de processed.md', report.raw_unprocessed, (x) => x);
  block('Dossiers sans contexte déclaré (brain.config.json)', report.context_missing, (x) => x);
  block('Estampilles Dream Sequence', report.dream_issues, (d) => `${d.file} — ${d.reason}`);
  block('Fiches sans fil de preuves (avertissement)', report.evidence_trail_missing,
    (e) => `${e.file} [${e.type}] — ajouter une section « ## Fil de preuves » en bas`);
  if (report.index_budget) {
    out.push(`Budget wiki/index.md : ${report.index_budget.lines}/200 lignes, ${(report.index_budget.bytes / 1024).toFixed(1)}/25 Ko`);
  }
  if (report.claude_budget) {
    out.push(`Budget CLAUDE.md     : ${report.claude_budget.lines}/200 lignes, ${(report.claude_budget.bytes / 1024).toFixed(1)}/12 Ko`);
  }
  if (report.index_budget || report.claude_budget) out.push('');
  if (report.failures.length) {
    out.push('ÉCHEC :');
    for (const f of report.failures) out.push('   ' + f);
  } else {
    out.push('Aucun échec bloquant.');
  }
  process.stdout.write(out.join('\n') + '\n');
  return report.failures.length ? 1 : 0;
}

// --- stats -------------------------------------------------------------------

function cmdStats(cfg, args, opts) {
  const idx = ensureIndex(cfg);
  const graph = buildGraph(cfg, idx);
  const nf = (n) => n.toLocaleString('fr-FR');
  const when = idx.generatedAt ? new Date(idx.generatedAt) : new Date();
  const stamp = when.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const orphans = graph.orphans.length;
  const broken = graph.broken.length;

  if (opts.short) {
    process.stdout.write(
      `Second Brain — ${cfg.sources.filter((s) => s.available).length} sources, ${nf(idx.files.length)} fichiers, `
      + `${nf(idx.docs.length)} sections indexées, ${nf(graph.links.length)} wikiliens `
      + `(${broken} cassé(s), ${orphans} orpheline(s)) — index du ${stamp}.\n`
    );
    return 0;
  }

  const perSource = new Map();
  for (const f of idx.files) {
    if (!perSource.has(f.source)) perSource.set(f.source, { files: 0, sections: 0, bytes: 0, zones: {} });
    const e = perSource.get(f.source);
    e.files++; e.bytes += f.size;
    e.zones[f.zone] = (e.zones[f.zone] || 0) + 1;
  }
  for (const d of idx.docs) {
    const s = idx.files[d.fileIdx].source;
    if (perSource.has(s)) perSource.get(s).sections++;
  }
  const out = [];
  out.push(`Second Brain — état de l'index  (${stamp})`);
  out.push('');
  out.push(`  Fichiers indexés   : ${nf(idx.files.length)}`);
  out.push(`  Sections indexées  : ${nf(idx.docs.length)}`);
  out.push(`  Termes uniques     : ${nf(Object.keys(idx.post).length)}`);
  out.push(`  Longueur moyenne   : ${idx.avgLen.toFixed(0)} (unités BM25F)`);
  out.push(`  Wikiliens          : ${nf(graph.links.length)}  dont ${broken} cassé(s)`);
  out.push(`  Fiches orphelines  : ${orphans}`);
  out.push(`  raw/ non traité    : ${graph.nodes.filter((n) => n.unprocessed).length}`);
  out.push(`  Seuil de confiance : ${defaultThreshold(cfg)}`);
  const ip = indexPath(cfg);
  if (fs.existsSync(ip)) out.push(`  Index sur disque   : ${(fs.statSync(ip).size / 1024).toFixed(0)} Ko gzip`);
  out.push('');
  out.push('  Par source :');
  for (const s of cfg.sources) {
    const e = perSource.get(s.id);
    if (!s.available) { out.push(`    ${s.id.padEnd(12)} INDISPONIBLE (${s.rootAbs})`); continue; }
    if (!e) { out.push(`    ${s.id.padEnd(12)} 0 fichier`); continue; }
    const zones = Object.entries(e.zones).map(([z, n]) => `${z}:${n}`).join(', ');
    out.push(`    ${s.id.padEnd(12)} ${String(e.files).padStart(4)} fichiers, ${String(e.sections).padStart(5)} sections, ${(e.bytes / 1024).toFixed(0).padStart(5)} Ko   [${zones}]`);
  }
  const usage = path.join(cfg.indexDir, 'usage.log');
  if (fs.existsSync(usage)) {
    const lines = fs.readFileSync(usage, 'utf8').trim().split('\n').filter(Boolean);
    const low = lines.filter((l) => l.split('\t')[2] === 'low').length;
    out.push('');
    out.push(`  Journal d'usage    : ${nf(lines.length)} recherche(s), ${low} en confiance faible`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// --- calibrate : évaluation (P@1, P@5, MRR), seuil, A/B des poids -----------

/**
 * Une fixture porte une ou plusieurs CIBLES attendues, sous la forme
 * `fichier.md`, `source/chemin/fichier.md` ou `fichier.md#titre-de-section`.
 * `expect` (ancienne forme, simple sous-chaîne) reste accepté.
 */
function ciblesDe(q) {
  if (Array.isArray(q.targets) && q.targets.length) return q.targets;
  return q.expect ? [q.expect] : [];
}

function cibleAtteinte(cible, r) {
  const [chemin, section] = String(cible).split('#');
  const rel = r.file.rel;
  const complet = `${r.file.source}/${rel}`;
  if (!(rel === chemin || complet === chemin || rel.includes(chemin) || complet.includes(chemin))) return false;
  if (!section) return true;
  const h = slugify(r.doc.heading || '');
  const s = slugify(section);
  return h === s || h.includes(s);
}

const EVAL_K = 5;         // profondeur d'évaluation = le --k par défaut de search
const EVAL_PER_FILE = 2;  // même plafond de diversité que search

function rejouerFixture(idx, q, opts) {
  const { terms, results } = scoreQuery(idx, q.q, { raw: false, k1: opts.k1, b: opts.b });
  const seen = new Map();
  const diverse = [];
  for (const r of results) {
    const c = seen.get(r.file.id) || 0;
    if (c >= EVAL_PER_FILE) continue;
    seen.set(r.file.id, c + 1);
    diverse.push(r);
  }
  const top = diverse.slice(0, EVAL_K);
  const cibles = ciblesDe(q);
  let rank = 0;
  for (let i = 0; i < top.length && !rank; i++) {
    if (cibles.some((c) => cibleAtteinte(c, top[i]))) rank = i + 1;
  }
  return {
    q, terms, top, matches: results.length, cibles,
    top1: top.length ? top[0].score : 0,
    top5: top.length >= EVAL_K ? top[EVAL_K - 1].score : null,
    rank: cibles.length ? rank : null,
  };
}

/**
 * Vraie évaluation (gbrain — evals/functional-area-resolver) : P@1, P@5 et MRR
 * sur un jeu de fixtures écrit à la main, dont un sous-ensemble HELD-OUT rédigé
 * sans regarder le moteur. Une distribution de scores dit que le moteur tourne ;
 * seule une mesure de justesse dit qu'il répond JUSTE.
 *
 * `echecs` liste les PIÈGES violés : les 7 requêtes de non-régression de
 * brain.test.mjs transcrites en fixtures, plus la séparation utiles/vides et
 * l'exclusion des sections navigationnelles. Aucun réglage n'a le droit de
 * les casser, quel que soit son MRR.
 */
function evaluerFixtures(idx, queries, opts = {}) {
  const rows = queries.map((q) => rejouerFixture(idx, q, opts));
  const arrondi = (x) => Math.round(x * 1000) / 1000;
  const mesure = (sous) => {
    const n = sous.length;
    if (!n) return { n: 0, p_at_1: null, p_at_5: null, mrr: null };
    return {
      n,
      p_at_1: arrondi(sous.filter((r) => r.rank === 1).length / n),
      p_at_5: arrondi(sous.filter((r) => r.rank >= 1).length / n),
      mrr: arrondi(sous.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n),
    };
  };
  const notes = rows.filter((r) => r.cibles.length);
  const metrics = mesure(notes);
  metrics.held_out = mesure(notes.filter((r) => r.q.held_out));
  // Le PLANCHER de confiance se calibre sur les requêtes utiles que le moteur
  // RÉUSSIT (cible trouvée, ou fixture sans cible). Une requête qu'il rate
  // n'a pas le droit de faire baisser le seuil : sinon le garde-fou apprend à
  // faire confiance à ses propres échecs. Sa justesse, elle, est mesurée par
  // P@1/P@5/MRR — c'est là qu'un échec doit se voir, pas dans le seuil.
  const good = rows.filter((r) => (r.q.kind || 'good') === 'good');
  const goodOk = good.filter((r) => !r.cibles.length || r.rank > 0);
  const weak = rows.filter((r) => r.q.kind === 'weak');
  const goodMin = goodOk.length ? Math.min(...goodOk.map((r) => r.top1)) : 10;
  const weakMax = weak.length ? Math.max(...weak.map((r) => r.top1)) : 0;

  const echecs = [];
  for (const r of rows) {
    if (r.q.trap) {
      const max = r.q.rank_max || 1;
      if (!r.rank || r.rank > max) {
        echecs.push(`piège « ${r.q.q} » : cible attendue au rang ≤ ${max}, obtenue ${r.rank || 'absente'}`);
      }
    }
    if (r.q.kind === 'weak' && r.top1 >= goodMin) {
      echecs.push(`piège « ${r.q.q} » : requête vide au niveau des requêtes utiles (${r.top1.toFixed(2)} ≥ ${goodMin.toFixed(2)})`);
    }
    for (const t of r.top) {
      if (/^(fiches liees|voir aussi)\b/.test(fold(t.doc.heading || ''))) {
        echecs.push(`piège « ${r.q.q} » : section navigationnelle rendue (${t.file.rel})`);
      }
    }
  }
  return { rows, metrics, goodMin, weakMax, echecs };
}

function seuilDepuis(goodMin, weakMax) {
  const t = (weakMax > 0 && weakMax < goodMin) ? Math.sqrt(goodMin * weakMax) : goodMin * 0.8;
  return Math.round(t * 100) / 100;
}

// --- A/B des poids (`calibrate --tune`) --------------------------------------

/**
 * Les poids BM25F sont appliqués À L'INDEXATION (tf pondéré avant saturation) :
 * changer un poids impose de reconstruire l'index. On ne parse donc le corpus
 * QU'UNE FOIS, on garde les tokens par champ, et on recompose un index en
 * mémoire par jeu de poids. k1 et b, eux, agissent au scoring : ils se balayent
 * sans reconstruction. Rien n'est écrit sur le disque : `--tune` RECOMMANDE.
 */
function collecterChamps(cfg) {
  const disk = discoverFiles(cfg);
  const linksByFile = new Map();
  const parsed = new Map();
  for (const f of disk) {
    const p = parseIndexable(cfg, f);
    parsed.set(f.id, p);
    linksByFile.set(f.id, p.links.map((l) => [l.target, l.anchor, l.alias, l.line]));
    f.title = p.title;
  }
  const anchors = computeAnchorText(disk, linksByFile);
  const files = [];
  const sections = [];
  for (const f of disk) {
    const p = parsed.get(f.id);
    const rec = {
      id: f.id, source: f.source, zone: f.zone, rel: f.rel, abs: f.abs,
      sig: f.sig, size: f.size, sha1: '', anchorSig: '', title: p.title,
      links: linksByFile.get(f.id) || [],
    };
    const fileIdx = files.length;
    files.push(rec);
    const metaTokens = tokenize(metaTextOf(rec, p.fm, (anchors.get(f.id) || '').trim(), p.title));
    for (const s of chunkSections(p.sections, p.rawText, p.lineOffsets)) {
      if (!s.text.trim() && !s.title.trim()) continue;
      sections.push({
        fileIdx, line: s.line, lineEnd: s.lineEnd, heading: s.title, crumb: s.crumb,
        chars: s.chars, off: s.off, end: s.end,
        toks: { title: tokenize(s.title), crumb: tokenize(s.crumb), meta: metaTokens, body: tokenize(s.body) },
      });
    }
  }
  return { files, sections };
}

function indexAvecPoids(champs, poids) {
  const docs = [];
  const post = new Map();
  let totalLen = 0;
  for (const c of champs.sections) {
    const tf = new Map();
    let len = 0;
    for (const champ of ['title', 'crumb', 'meta', 'body']) {
      const w = poids[champ];
      for (const t of c.toks[champ]) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
    }
    if (!tf.size) continue;
    const docId = docs.length;
    docs.push({
      fileIdx: c.fileIdx, line: c.line, lineEnd: c.lineEnd, heading: c.heading,
      crumb: c.crumb, chars: c.chars, len, off: c.off, end: c.end,
    });
    for (const [t, w] of tf) {
      let arr = post.get(t);
      if (!arr) { arr = []; post.set(t, arr); }
      arr.push(docId, Math.round(w * 10));
    }
    totalLen += len;
  }
  return {
    v: INDEX_VERSION, generatedAt: '', N: docs.length,
    avgLen: docs.length ? totalLen / docs.length : 1,
    files: champs.files, docs, post: Object.fromEntries(post),
  };
}

const GRILLE = {
  title: [3, 4, 5],
  meta: [1.5, 2, 3],
  crumb: [1, 1.5, 2],
  k1: [1.0, 1.2, 1.5],
  b: [0.6, 0.75, 0.9],
};

function calibrateTune(cfg, queries, opts) {
  const t0 = Date.now();
  const champs = collecterChamps(cfg);
  const essais = [];
  for (const title of GRILLE.title) {
    for (const meta of GRILLE.meta) {
      for (const crumb of GRILLE.crumb) {
        const poids = { title, crumb, meta, body: 1 };
        const idxLocal = indexAvecPoids(champs, poids);
        for (const k1 of GRILLE.k1) {
          for (const b of GRILLE.b) {
            const ev = evaluerFixtures(idxLocal, queries, { k1, b });
            essais.push({
              weights: poids, k1, b,
              mrr: ev.metrics.mrr, p_at_1: ev.metrics.p_at_1, p_at_5: ev.metrics.p_at_5,
              mrr_held_out: ev.metrics.held_out.mrr,
              traps_ok: ev.echecs.length === 0,
              trap_failures: ev.echecs.slice(0, 3),
              threshold: seuilDepuis(ev.goodMin, ev.weakMax),
            });
          }
        }
      }
    }
  }
  const cle = (e) => `${e.weights.title}/${e.weights.meta}/${e.weights.crumb}/${e.k1}/${e.b}`;
  const actuel = essais.find((e) => e.weights.title === W.title && e.weights.meta === W.meta
    && e.weights.crumb === W.crumb && e.k1 === K1 && e.b === B) || null;
  const valides = essais.filter((e) => e.traps_ok);
  // Tri STABLE et totalement déterministe : MRR, puis P@1, puis MRR held-out,
  // puis la clé du jeu de poids — deux runs proposent toujours le même gagnant.
  valides.sort((a, b) => b.mrr - a.mrr || b.p_at_1 - a.p_at_1 || b.mrr_held_out - a.mrr_held_out
    || (cle(a) < cle(b) ? -1 : cle(a) > cle(b) ? 1 : 0));
  const recommande = valides.length ? valides[0] : null;
  const gain = recommande && actuel ? Math.round((recommande.mrr - actuel.mrr) * 1000) / 1000 : null;

  const rapport = {
    generatedAt: new Date().toISOString(),
    ms: Date.now() - t0,
    grille: GRILLE,
    essais: essais.length,
    essais_valides: valides.length,
    actuel,
    recommande,
    gain_mrr: gain,
    top: valides.slice(0, 5),
    applique: false,
    note: 'RECOMMANDATION seulement — rien n\'est écrit. Appliquer un jeu de poids '
      + 'suppose d\'éditer W / K1 / B dans brain.js, puis « node brain.js index » et « node brain.js calibrate ».',
  };
  if (opts.json) { process.stdout.write(JSON.stringify(rapport, null, 2) + '\n'); return 0; }

  const fmt = (e) => `titre ×${e.weights.title}  frontmatter ×${e.weights.meta}  ariane ×${e.weights.crumb}  corps ×1  |  k1=${e.k1}  b=${e.b}`;
  const out = [`A/B des poids BM25F — ${essais.length} combinaisons, ${valides.length} sans piège cassé (${rapport.ms} ms)`, ''];
  if (actuel) {
    out.push(`Réglage ACTUEL   : ${fmt(actuel)}`);
    out.push(`                   MRR ${actuel.mrr}  P@1 ${actuel.p_at_1}  P@5 ${actuel.p_at_5}  held-out MRR ${actuel.mrr_held_out}  pièges ${actuel.traps_ok ? 'ok' : 'CASSÉS'}`);
    out.push('');
  }
  if (!recommande) {
    out.push('Aucune combinaison de la grille ne passe les pièges : ne rien changer.');
  } else {
    out.push(`Meilleur MRR sans casser un piège :`);
    out.push(`  ${fmt(recommande)}`);
    out.push(`  MRR ${recommande.mrr}  P@1 ${recommande.p_at_1}  P@5 ${recommande.p_at_5}  held-out MRR ${recommande.mrr_held_out}  seuil recommandé ${recommande.threshold}`);
    if (gain !== null) out.push(`  Gain de MRR sur le réglage actuel : ${gain >= 0 ? '+' : ''}${gain}`);
    out.push('');
    out.push('  Les 5 meilleurs :');
    for (const e of rapport.top) out.push(`    MRR ${String(e.mrr).padEnd(6)} P@1 ${String(e.p_at_1).padEnd(6)} ${fmt(e)}`);
  }
  out.push('');
  out.push('RIEN N\'A ÉTÉ APPLIQUÉ. Décision humaine : éditer W / K1 / B en tête de brain.js,');
  out.push('puis « node brain.js index && node brain.js calibrate && node --test brain.test.mjs ».');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function cmdCalibrate(cfg, args, opts) {
  const queries = (cfg.calibration && cfg.calibration.queries) || [];
  if (!queries.length) fail('aucune requête de référence dans brain.config.json (clé calibration.queries)');
  if (opts.tune) return calibrateTune(cfg, queries, opts);

  const idx = ensureIndex(cfg);
  const ev = evaluerFixtures(idx, queries);
  const threshold = seuilDepuis(ev.goodMin, ev.weakMax);

  // Le rapport score[0]/score[4] se resserre quand le corpus grossit : le fixer
  // en dur à 1,5 déclarerait « faible » presque toutes les bonnes requêtes.
  // On le calibre donc sur les requêtes utiles, sans jamais dépasser 1,5.
  // Même principe que pour le seuil : seules les requêtes utiles RÉUSSIES
  // calibrent le plancher de rapport.
  const goodRatios = ev.rows
    .filter((r) => (r.q.kind || 'good') === 'good' && r.top5 && (!r.cibles.length || r.rank > 0))
    .map((r) => r.top1 / r.top5);
  const ratioMin = Math.round(
    Math.min(DEFAULT_GUARD.ratioMin, goodRatios.length ? Math.min(...goodRatios) * 0.95 : DEFAULT_GUARD.ratioMin) * 100
  ) / 100;

  // Reçu (gbrain — JSONL liant le run au hash des fixtures) : sans le hash de la
  // config, deux runs comparent deux moteurs différents sans qu'on le sache.
  let configSha1 = '';
  try { configSha1 = crypto.createHash('sha1').update(fs.readFileSync(CONFIG_PATH)).digest('hex'); } catch { /* config lue autrement */ }

  const calibration = {
    generatedAt: new Date().toISOString(),
    config_sha1: configSha1,
    corpus: { files: idx.files.length, sections: idx.docs.length, avgLen: idx.avgLen },
    engine: { weights: { ...W }, k1: K1, b: B, minlen: MINLEN, eval_k: EVAL_K, eval_per_file: EVAL_PER_FILE },
    threshold, ratioMin,
    goodMin: Math.round(ev.goodMin * 100) / 100,
    weakMax: Math.round(ev.weakMax * 100) / 100,
    metrics: ev.metrics,
    traps_ok: ev.echecs.length === 0,
    trap_failures: ev.echecs,
    queries: ev.rows.map((r) => ({
      query: r.q.q, kind: r.q.kind || 'good', held_out: !!r.q.held_out, trap: !!r.q.trap,
      top1: Math.round(r.top1 * 100) / 100,
      ratio: r.top5 ? Math.round((r.top1 / r.top5) * 100) / 100 : null,
      first: r.top.length ? r.top[0].file.rel : null,
      targets: r.cibles, expect: r.q.expect || null,
      rank: r.rank || null, ok: r.cibles.length ? r.rank > 0 : null,
    })),
  };
  fs.mkdirSync(cfg.indexDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.indexDir, 'calibration.json'), JSON.stringify(calibration, null, 2));

  if (opts.json) { process.stdout.write(JSON.stringify(calibration, null, 2) + '\n'); return 0; }
  const pc = (x) => (x === null ? '—' : `${(x * 100).toFixed(0)} %`);
  const out = ['Évaluation du moteur sur les fixtures de brain.config.json', ''];
  for (const r of ev.rows) {
    const verdict = r.rank === null ? '   ' : (r.rank > 0 ? ' ok' : ' KO');
    const etiquettes = [r.q.kind || 'good', r.q.held_out ? 'held-out' : null, r.q.trap ? 'piège' : null]
      .filter(Boolean).join(', ');
    out.push(`${verdict}  [${etiquettes}] « ${r.q.q} »`);
    out.push(`        top1=${r.top1.toFixed(2)}  top5=${r.top5 === null ? '—' : r.top5.toFixed(2)}  candidats=${r.matches}`);
    out.push(`        1er : ${r.top.length ? r.top[0].file.rel : '(aucun)'}${r.cibles.length ? `   cible : ${r.cibles.join(' | ')} (rang ${r.rank || 'absente'})` : ''}`);
  }
  out.push('');
  out.push(`Justesse — ${ev.metrics.n} requête(s) à cible :  P@1 ${pc(ev.metrics.p_at_1)}   P@5 ${pc(ev.metrics.p_at_5)}   MRR ${ev.metrics.mrr}`);
  if (ev.metrics.held_out.n) {
    const h = ev.metrics.held_out;
    out.push(`Dont HELD-OUT (${h.n} requêtes écrites sans regarder le moteur) :  P@1 ${pc(h.p_at_1)}   P@5 ${pc(h.p_at_5)}   MRR ${h.mrr}`);
  }
  out.push(`Pièges de non-régression : ${ev.echecs.length ? `${ev.echecs.length} CASSÉ(S)` : 'tous tenus'}`);
  for (const e of ev.echecs) out.push(`   ${e}`);
  out.push('');
  out.push(`Score minimum des requêtes utiles : ${ev.goodMin.toFixed(2)}`);
  out.push(`Score maximum des requêtes vides  : ${ev.weakMax.toFixed(2)}`);
  out.push(`Seuil retenu : ${threshold}  (règle complémentaire : score[0]/score[4] < ${ratioMin} → confiance faible)`);
  out.push(`Écrit : ${path.join(cfg.indexDir, 'calibration.json')}`);
  out.push('Comparer d\'autres poids sans rien appliquer : node brain.js calibrate --tune');
  process.stdout.write(out.join('\n') + '\n');
  return ev.echecs.length ? 1 : 0;
}

// =============================================================================
// 9 bis. MÉMOIRE D'USAGE — sidecar `.brain/learning.json`
//
// Ce que l'usage apprend ne rentre JAMAIS dans une fiche ni dans
// `.brain/index.json.gz` : le canon doit rester lisible et l'index doit rester
// reproductible par une simple réindexation. La couche apprise vit dans un
// fichier séparé, versionnable, jetable — exactement comme graphify sépare
// `.graphify_learning.json` de son graphe.
// =============================================================================

const DEMI_VIE_JOURS = 30;        // une impasse fraîche pèse plus qu'un « utile » de trois mois
const CORROBORATIONS_MIN = 2;     // « préférée » exige deux requêtes DISTINCTES
const NUDGE_APPRENTISSAGE = 0.75; // décalage de rang maximal sous --learn (voir plus bas)

function learningPath(cfg) { return path.join(cfg.indexDir, 'learning.json'); }

function loadLearning(cfg) {
  try {
    const j = JSON.parse(fs.readFileSync(learningPath(cfg), 'utf8'));
    if (j && Array.isArray(j.events)) return { version: 1, events: j.events };
  } catch { /* sidecar absent ou illisible : la mémoire d'usage repart de zéro */ }
  return { version: 1, events: [] };
}

/**
 * Écriture BYTE-STABLE : tri total, dédoublonnage, et aucune estampille
 * flottante dans le fichier — pas de `generatedAt`, pas de `Date.now()`. Le
 * fichier ne contient que des ÉVÉNEMENTS bruts ; tout ce qui se dérive (score
 * décru, statut, péremption) se recalcule à la lecture. Deux enregistrements
 * identiques rendent donc deux fois le même fichier, octet pour octet.
 */
function saveLearning(cfg, events) {
  const vus = new Set();
  const propres = [];
  for (const e of events) {
    const cle = [e.ts, e.file, e.outcome, e.query].join('\t');
    if (vus.has(cle)) continue;
    vus.add(cle);
    propres.push({ ts: e.ts, file: e.file, outcome: e.outcome, query: e.query, sha1: e.sha1 || '' });
  }
  const rang = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  propres.sort((a, b) => rang(a.ts, b.ts) || rang(a.file, b.file)
    || rang(a.outcome, b.outcome) || rang(a.query, b.query));
  ecrireAtomique(learningPath(cfg), JSON.stringify({ version: 1, events: propres }, null, 2) + '\n');
  return propres;
}

/** Normalise une requête pour compter les corroborations DISTINCTES. */
function cleRequete(q) { return [...new Set(tokenize(String(q || '')))].sort().join(' '); }

/**
 * Dérive le bilan à partir des événements. Déterministe, sans LLM.
 *
 * - décroissance : poids = 0,5^(âge en jours / 30) ;
 * - valeur signée : +poids si le résultat a servi, −poids si ce fut une impasse ;
 * - `stale` : le SHA-1 du fichier au moment de l'enregistrement ne correspond
 *   plus à celui du fichier sur le disque. La leçon n'est pas effacée (le biais
 *   est assumé vers le sur-signalement) mais elle ne compte plus comme
 *   corroboration : une fiche réécrite n'a pas gagné son statut de préférée ;
 * - statut : `preferee` (valeur > 0 ET ≥ 2 requêtes distinctes corroborantes),
 *   `contestee` (valeur ≤ 0), `tentative` (le reste).
 */
function analyserLearning(cfg, idx, maintenant) {
  const events = loadLearning(cfg).events;
  const now = Date.parse(maintenant);
  const absParId = new Map(idx.files.map((f) => [f.id, f.abs]));
  const shaCourant = new Map();
  const shaDe = (fileId) => {
    if (!shaCourant.has(fileId)) {
      const abs = absParId.get(fileId);
      let s = '';
      if (abs) { try { s = sha1File(abs); } catch { s = ''; } }
      shaCourant.set(fileId, s);
    }
    return shaCourant.get(fileId);
  };

  const parFichier = new Map();
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const age = Math.max(0, (now - t) / 86400000);
    const poids = Math.pow(0.5, age / DEMI_VIE_JOURS);
    const perime = !!(e.sha1 && shaDe(e.file) && e.sha1 !== shaDe(e.file));
    let f = parFichier.get(e.file);
    if (!f) {
      f = {
        file: e.file, used: 0, deadend: 0, score: 0, stale: false,
        corroborations: 0, absente: !absParId.has(e.file),
        last_ts: e.ts, requetes: new Set(), impasses: [],
      };
      parFichier.set(e.file, f);
    }
    if (e.outcome === 'used') { f.used++; f.score += poids; if (!perime) f.requetes.add(cleRequete(e.query)); }
    else { f.deadend++; f.score -= poids; f.impasses.push({ ts: e.ts, query: e.query, age_jours: Math.round(age) }); }
    if (perime) f.stale = true;
    if (e.ts > f.last_ts) f.last_ts = e.ts;
  }

  const entrees = [...parFichier.values()].map((f) => {
    const corroborations = f.requetes.size;
    let statut;
    if (f.score > 0 && corroborations >= CORROBORATIONS_MIN) statut = 'preferee';
    else if (f.score <= 0) statut = 'contestee';
    else statut = 'tentative';
    return {
      file: f.file, statut, stale: f.stale, absente: f.absente,
      score: Math.round(f.score * 1000) / 1000,
      used: f.used, deadend: f.deadend, corroborations,
      last_ts: f.last_ts,
      impasses: f.impasses.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 3),
    };
  });
  entrees.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { maintenant, total_events: events.length, entrees, parFichier: new Map(entrees.map((e) => [e.file, e])) };
}

function cmdReflect(cfg, args, opts) {
  const idx = ensureIndex(cfg);
  const maintenant = opts.at || new Date().toISOString();
  if (opts.at && Number.isNaN(Date.parse(opts.at))) fail(`--at : horodatage ISO-8601 attendu, reçu « ${opts.at} »`);

  // --- enregistrement d'un usage ou d'une impasse ---------------------------
  const cible = opts.used || opts.deadend;
  if (cible) {
    if (opts.used && opts.deadend) fail('--used et --deadend s\'excluent : un résultat a servi, ou il n\'a pas servi.');
    if (!opts.query) fail('usage : brain.js reflect --used <fichier> --query "<la requête qui l\'a ramené>"');
    const { file } = resolveFileArg(idx, cible);
    if (!file) fail(`fichier introuvable dans l'index : ${cible}`);
    let sha1 = '';
    try { sha1 = sha1File(file.abs); } catch { /* fichier illisible : leçon sans ancre */ }
    const events = loadLearning(cfg).events.concat([{
      ts: maintenant, file: file.id, outcome: opts.used ? 'used' : 'deadend',
      query: String(opts.query).replace(/\s+/g, ' ').trim(), sha1,
    }]);
    const propres = saveLearning(cfg, events);
    const bilan = analyserLearning(cfg, idx, maintenant);
    const e = bilan.parFichier.get(file.id);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ enregistre: true, file: file.id, outcome: opts.used ? 'used' : 'deadend', total_events: propres.length, entree: e }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(
      `${opts.used ? 'Usage' : 'Impasse'} enregistré : ${file.id}\n`
      + `  requête : « ${opts.query} »\n`
      + `  bilan   : ${e.statut} (valeur ${e.score}, ${e.corroborations} corroboration(s) distincte(s)${e.stale ? ', leçon périmée : le fichier a changé' : ''})\n`
      + `  sidecar : ${learningPath(cfg)} — ${propres.length} événement(s). Rien n'a été écrit dans les fiches.\n`
    );
    return 0;
  }

  // --- bilan ----------------------------------------------------------------
  if (!opts.report) fail('usage : brain.js reflect --used|--deadend <fichier> --query "<requête>" | brain.js reflect --report [--json]');
  const bilan = analyserLearning(cfg, idx, maintenant);
  const preferees = bilan.entrees.filter((e) => e.statut === 'preferee');
  const contestees = bilan.entrees.filter((e) => e.statut === 'contestee');
  const tentatives = bilan.entrees.filter((e) => e.statut === 'tentative');
  const recentes = bilan.entrees.flatMap((e) => e.impasses.map((i) => ({ file: e.file, ...i })))
    .filter((i) => i.age_jours <= DEMI_VIE_JOURS)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, 10);

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      generated_at: maintenant, sidecar: learningPath(cfg),
      demi_vie_jours: DEMI_VIE_JOURS, corroborations_min: CORROBORATIONS_MIN,
      total_events: bilan.total_events,
      preferees, contestees, tentatives, impasses_recentes: recentes,
    }, null, 2) + '\n');
    return 0;
  }
  const out = [`Mémoire d'usage — ${bilan.total_events} événement(s), demi-vie ${DEMI_VIE_JOURS} j (${learningPath(cfg)})`, ''];
  const bloc = (titre, items, fmt) => {
    out.push(`${titre} : ${items.length}`);
    for (const it of items.slice(0, 15)) out.push('   ' + fmt(it));
    out.push('');
  };
  bloc(`Sources préférées (≥ ${CORROBORATIONS_MIN} corroborations distinctes)`, preferees,
    (e) => `${e.file}  — valeur ${e.score}, ${e.corroborations} requête(s)${e.stale ? '  [PÉRIMÉE : le fichier a changé]' : ''}`);
  bloc('Sources contestées', contestees,
    (e) => `${e.file}  — valeur ${e.score}, ${e.used} utile(s) / ${e.deadend} impasse(s)`);
  bloc('Tentatives (une seule corroboration)', tentatives,
    (e) => `${e.file}  — valeur ${e.score}`);
  bloc(`Impasses des ${DEMI_VIE_JOURS} derniers jours`, recentes,
    (i) => `${i.file}  — « ${i.query} » (il y a ${i.age_jours} j)`);
  const usage = path.join(cfg.indexDir, 'usage.log');
  if (fs.existsSync(usage)) {
    const n = fs.readFileSync(usage, 'utf8').trim().split('\n').filter(Boolean).length;
    out.push(`Pour mémoire : ${n} recherche(s) journalisées dans usage.log — elles disent ce qui a été CHERCHÉ,`);
    out.push('jamais ce qui a SERVI. Seul « reflect --used / --deadend » le dit, et il se pilote à la main.');
  }
  out.push('');
  out.push('Cette mémoire ne modifie AUCUNE fiche et n\'entre PAS dans l\'index.');
  out.push('Elle n\'agit sur la recherche que si on le demande : node brain.js search "…" --learn');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// =============================================================================
// 10. CLI
// =============================================================================

// =============================================================================
// 9 bis. BOUCLE DE RELECTURE DES BROUILLONS (DESIGN §2, §6)
//
// L'ingestion et la Dream Sequence écrivent en `statut: draft`. Il faut pouvoir
// les RELIRE puis les VALIDER en `statut: canon` sans risque. Trois verbes :
//   drafts   liste toutes les fiches draft, toutes sources confondues ;
//   promote  draft → canon, sur la SEULE ligne statut, en écriture atomique,
//            avec une ligne datée ajoutée au « ## Fil de preuves » (append-only) ;
//   demote   canon → draft, pour repasser en revue une fiche promue à tort.
// La promotion ne touche QUE la ligne `statut:` et n'AJOUTE qu'au fil de preuves :
// jamais elle ne réécrit la zone haute (DESIGN §6, séparation des deux zones).
// =============================================================================

/** Date du jour au format YYYY-MM-DD (heure locale), ou `--date` si valide. */
function dateDuJour(iso) {
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Racines réelles des sources disponibles (périmètre d'écriture des fiches). */
function racinesSources(cfg) {
  const out = [];
  for (const s of cfg.sources) {
    if (!s.available) continue;
    try { out.push(fs.realpathSync(s.rootAbs)); } catch { /* racine volatile */ }
  }
  return out;
}

/** Identifiant `<source>/<chemin>` d'un chemin absolu, ou null s'il est hors des sources. */
function ficheId(cfg, abs) {
  let reel; try { reel = fs.realpathSync(abs); } catch { reel = path.resolve(abs); }
  for (const s of cfg.sources) {
    let racine; try { racine = fs.realpathSync(s.rootAbs); } catch { continue; }
    if (reel === racine || reel.startsWith(racine + path.sep)) {
      return `${s.id}/${path.relative(racine, reel).split(path.sep).join('/')}`;
    }
  }
  return null;
}

/**
 * Localise une fiche par argument (`<source>/<chemin>`, chemin relatif ou absolu)
 * et la CONFINE aux racines des sources — le même verrou que le serveur UI.
 * Renvoie `{ reel }` en cas de succès, sinon `{ erreur, code }` sans jamais
 * lever : l'appelant décide du canal (texte ou JSON).
 */
function localiserFiche(cfg, arg) {
  const brut = String(arg || '').split('#')[0].trim();
  if (!brut) return { erreur: 'chemin de fiche manquant', code: 'usage' };
  if (brut.indexOf('\0') !== -1) return { erreur: 'chemin invalide', code: 'usage' };
  const racines = racinesSources(cfg);
  const candidats = [];
  const barre = brut.indexOf('/');
  if (barre > 0) {
    const s = cfg.sources.find((x) => x.id === brut.slice(0, barre));
    if (s) candidats.push(path.resolve(s.rootAbs, brut.slice(barre + 1)));
  }
  candidats.push(path.isAbsolute(brut) ? path.resolve(brut) : path.resolve(BRAIN_DIR, brut));
  candidats.push(path.resolve(process.cwd(), brut));
  let existant = null;
  for (const c of candidats) {
    let reel; try { reel = fs.realpathSync(c); } catch { continue; }
    existant = reel;
    if (racines.some((r) => reel === r || reel.startsWith(r + path.sep))) return { reel };
  }
  if (existant) return { erreur: 'chemin hors du périmètre des sources', code: 'hors-perimetre' };
  return { erreur: 'fiche introuvable', code: 'introuvable' };
}

/** Bornes du frontmatter (indices de ligne de l'ouvrant et du fermant), ou null. */
function bornesFrontmatter(lines) {
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') return { open: 0, close: i };
  }
  return null;
}

/**
 * Passe `statut: <de>` → `statut: <vers>` dans le frontmatter, de façon SÛRE :
 * seule la ligne `statut:` est touchée (indentation, espaces, guillemets et
 * retour chariot préservés) ; le reste du fichier est conservé octet pour octet ;
 * une ligne datée est ajoutée au « ## Fil de preuves » s'il existe (append-only) ;
 * écriture atomique (tmp + rename), donc jamais de `.tmp` résiduel.
 * Renvoie `{ ok:true, filAjoute }` ou `{ ok:false, code, erreur }` (ne lève pas).
 */
function changerStatutFiche(abs, de, vers, { date, filTexte } = {}) {
  if (path.extname(abs).toLowerCase() !== '.md') {
    return { ok: false, code: 'extension', erreur: 'seules les fiches .md sont promouvables' };
  }
  let texte;
  try { texte = fs.readFileSync(abs, 'utf8'); }
  catch (e) { return { ok: false, code: 'lecture', erreur: `lecture impossible : ${e.message}` }; }
  const lines = texte.split('\n');
  const bornes = bornesFrontmatter(lines);
  if (!bornes) return { ok: false, code: 'sans-frontmatter', erreur: 'fiche sans frontmatter YAML' };

  let iStatut = -1;
  let valeurCourante = null;
  for (let i = bornes.open + 1; i < bornes.close; i++) {
    const m = lines[i].match(/^(statut\s*:\s*)(['"]?)([A-Za-z]+)(\2)(\s*\r?)$/);
    if (m) { iStatut = i; valeurCourante = m[3].toLowerCase(); break; }
  }
  if (iStatut === -1) {
    return { ok: false, code: 'sans-statut', erreur: 'la fiche ne porte pas de champ « statut » dans son frontmatter' };
  }
  if (valeurCourante !== de) {
    const raison = valeurCourante === vers
      ? `la fiche est déjà en « ${vers} » — rien à faire`
      : `statut inattendu « ${valeurCourante} » (attendu « ${de} »)`;
    return { ok: false, code: 'mauvais-statut', erreur: raison, statut: valeurCourante };
  }

  // Remplacement ciblé : on ne reconstruit QUE la valeur, tout le reste inchangé.
  lines[iStatut] = lines[iStatut].replace(
    /^(statut\s*:\s*)(['"]?)([A-Za-z]+)(\2)(\s*\r?)$/,
    (all, tete, q1, _v, q2, queue) => tete + q1 + vers + q2 + queue,
  );

  // Fil de preuves : ajout d'UNE ligne datée en fin de section, si elle existe.
  let filAjoute = false;
  if (filTexte) {
    let h = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Fil de preuves\s*\r?$/i.test(lines[i])) { h = i; break; }
    }
    if (h !== -1) {
      let fin = lines.length;
      for (let i = h + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i])) { fin = i; break; }
      }
      let dernier = h; // à défaut de contenu, juste après le titre
      for (let i = h + 1; i < fin; i++) if (lines[i].trim() !== '') dernier = i;
      const cr = /\r$/.test(lines[h]) ? '\r' : '';
      lines.splice(dernier + 1, 0, `- [${date}] ${filTexte}${cr}`);
      filAjoute = true;
    }
  }

  try { ecrireAtomique(abs, lines.join('\n')); }
  catch (e) { return { ok: false, code: 'ecriture', erreur: `écriture impossible : ${e.message}` }; }
  return { ok: true, filAjoute };
}

/**
 * Frontmatter d'une fiche, y compris une liste `sources:` en bloc (les scalaires
 * seuls ne suffisent pas ici : on veut la source d'origine du brouillon).
 * Lecture bornée aux 8 premiers Ko : le frontmatter est toujours en tête.
 */
function frontmatterFiche(abs) {
  let tete = '';
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    tete = buf.slice(0, n).toString('utf8');
  } catch { return { statut: null, titre: '', modified: '', sources: [] }; }
  const lines = tete.split('\n');
  const bornes = bornesFrontmatter(lines);
  if (!bornes) return { statut: null, titre: '', modified: '', sources: [] };
  const fm = { statut: null, titre: '', modified: '', sources: [] };
  const deguill = (s) => s.trim().replace(/^["']|["']$/g, '');
  for (let i = bornes.open + 1; i < bornes.close; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && fm._enSources) fm.sources.push(deguill(item[1]));
      continue;
    }
    fm._enSources = false;
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const cle = line.slice(0, c).trim();
    const val = line.slice(c + 1).trim();
    if (cle === 'statut') fm.statut = deguill(val).toLowerCase() || null;
    else if (cle === 'titre' || cle === 'title') fm.titre = deguill(val);
    else if (cle === 'modified') fm.modified = deguill(val);
    else if (cle === 'sources') {
      if (!val) fm._enSources = true;                         // liste en bloc
      else if (/^\[.*\]$/.test(val)) {                        // liste en ligne
        fm.sources = val.slice(1, -1).split(',').map(deguill).filter(Boolean);
      } else fm.sources = [deguill(val)];
    }
  }
  delete fm._enSources;
  return fm;
}

/**
 * Statut d'une fiche (`draft` | `canon` | null) lu au vol dans son frontmatter.
 * Lecture bornée à 2 Ko (le frontmatter est en tête) : assez léger pour le
 * graphe, qui l'expose pour distinguer visuellement les brouillons (DESIGN §3).
 */
function statutDeFiche(abs) {
  if (!/\.(md|markdown)$/i.test(abs)) return null;
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const lines = buf.slice(0, n).toString('utf8').split('\n');
    const bornes = bornesFrontmatter(lines);
    if (!bornes) return null;
    for (let i = bornes.open + 1; i < bornes.close; i++) {
      const m = lines[i].match(/^statut\s*:\s*['"]?([A-Za-z]+)/);
      if (m) { const v = m[1].toLowerCase(); return v === 'draft' || v === 'canon' ? v : null; }
    }
  } catch { /* fiche illisible : statut inconnu */ }
  return null;
}

function cmdDrafts(cfg, args, opts) {
  const brouillons = [];
  for (const f of discoverFiles(cfg)) {
    if (f.zone !== 'distilled') continue;
    if (!/\.md$/i.test(f.rel)) continue;
    const fm = frontmatterFiche(f.abs);
    if (fm.statut !== 'draft') continue;
    const t = Date.parse(fm.modified);
    const ageJours = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
    brouillons.push({
      source: f.source, path: f.id, rel: f.rel, abs: f.abs,
      titre: assainir(fm.titre, LIMITE.heading) || path.basename(f.rel),
      modified: fm.modified || null,
      age_jours: ageJours,
      sources: fm.sources.map((s) => assainir(s, LIMITE.contexte)),
    });
  }
  brouillons.sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));

  if (opts.json) {
    process.stdout.write(JSON.stringify({ count: brouillons.length, drafts: brouillons }, null, 2) + '\n');
    return 0;
  }
  const lignes = [];
  lignes.push(`${brouillons.length} brouillon(s) à relire${brouillons.length ? ' :' : '.'}`);
  lignes.push('');
  brouillons.forEach((b, i) => {
    lignes.push(`${i + 1}. [${b.source}] ${b.path}`);
    lignes.push(`   « ${b.titre} »`);
    const age = b.age_jours == null ? 'date inconnue'
      : (b.age_jours <= 0 ? "aujourd'hui" : `il y a ${b.age_jours} j`);
    lignes.push(`   modifié ${b.modified || '—'} · ${age}`
      + (b.sources.length ? ` · source : ${b.sources.join(' ; ')}` : ''));
    lignes.push('');
  });
  if (brouillons.length) lignes.push('Promouvoir : node brain.js promote <source>/<chemin>');
  process.stdout.write(lignes.join('\n').replace(/\n+$/, '\n'));
  return 0;
}

/** Cœur commun à promote/demote : localise, change le statut, rend le verdict. */
function transitionFiche(cfg, args, opts, de, vers, filTexte) {
  const cible = localiserFiche(cfg, args[0]);
  const emettre = (obj, exit) => {
    if (opts.json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
    else if (obj.ok) {
      process.stdout.write(`✓ ${obj.id || obj.abs} : ${de} → ${vers}`
        + (obj.filAjoute ? ' (ligne ajoutée au fil de preuves)' : '') + '\n');
    } else process.stderr.write(`brain.js : ${obj.erreur}\n`);
    return exit;
  };
  if (cible.erreur) {
    if (cible.code === 'usage') fail(`usage : brain.js ${vers === 'canon' ? 'promote' : 'demote'} <source>/<chemin>`);
    return emettre({ ok: false, code: cible.code, erreur: cible.erreur }, 1);
  }
  const date = dateDuJour(opts.date);
  const r = changerStatutFiche(cible.reel, de, vers, { date, filTexte });
  if (!r.ok) return emettre({ ok: false, code: r.code, erreur: r.erreur, statut: r.statut }, 1);
  return emettre({
    ok: true, statut: vers, abs: cible.reel, id: ficheId(cfg, cible.reel),
    filAjoute: r.filAjoute, date,
  }, 0);
}

function cmdPromote(cfg, args, opts) {
  return transitionFiche(cfg, args, opts, 'draft', 'canon', 'promue en canon après relecture.');
}

function cmdDemote(cfg, args, opts) {
  return transitionFiche(cfg, args, opts, 'canon', 'draft', 'repassée en brouillon pour relecture.');
}

const USAGE = `brain.js — moteur du Second Brain (BM25F par section, zéro dépendance)

  node brain.js search "<requête>" [--k 5] [--per-file 2] [--raw] [--source <id>]
                                   [--in <dossier>] [--expand] [--learn] [--full] [--json]
  node brain.js search --query-file <chemin|->     # document de requête multi-lignes :
                                                   #   intent: <note ignorée du moteur>
                                                   #   lex: <angle 1>
                                                   #   lex: <angle 2>   → fusion RRF
  node brain.js show <fichier>[#<ligne|slug-de-titre>] [--json]
  node brain.js show <fichier>:<début>:<nombre>          # lecture par tranche de lignes
  node brain.js outline <fichier> [--json]
  node brain.js related <fichier> [--depth 2] [--json]
  node brain.js graph [--orphans] [--broken] [--json]
  node brain.js index [--verify] [--force]
  node brain.js lint [--json]
  node brain.js stats [--short]
  node brain.js calibrate [--json]        # P@1 / P@5 / MRR + seuil de confiance
  node brain.js calibrate --tune [--json] # A/B des poids BM25F — RECOMMANDE, n'applique rien
  node brain.js reflect --used <fichier> --query "<requête>" [--at <iso>]
  node brain.js reflect --deadend <fichier> --query "<requête>" [--at <iso>]
  node brain.js reflect --report [--json]  # sidecar .brain/learning.json, jamais les fiches
  node brain.js drafts [--json]            # fiches « statut: draft », toutes sources
  node brain.js promote <source>/<chemin> [--date YYYY-MM-DD] [--json]  # draft → canon
  node brain.js demote  <source>/<chemin> [--date YYYY-MM-DD] [--json]  # canon → draft
`;

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        k: { type: 'string' },
        'per-file': { type: 'string' },
        'query-file': { type: 'string' },
        raw: { type: 'boolean' },
        source: { type: 'string' },
        in: { type: 'string' },
        expand: { type: 'boolean' },
        full: { type: 'boolean' },
        json: { type: 'boolean' },
        depth: { type: 'string' },
        orphans: { type: 'boolean' },
        broken: { type: 'boolean' },
        verify: { type: 'boolean' },
        force: { type: 'boolean' },
        short: { type: 'boolean' },
        tune: { type: 'boolean' },
        used: { type: 'string' },
        deadend: { type: 'string' },
        report: { type: 'boolean' },
        query: { type: 'string' },
        at: { type: 'string' },
        date: { type: 'string' },
        learn: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${e.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const cmd = positionals[0];
  if (!cmd || values.help) { process.stdout.write(USAGE); return cmd ? 0 : 1; }

  const opts = {
    k: values.k ? parseInt(values.k, 10) : undefined,
    perFile: values['per-file'] ? parseInt(values['per-file'], 10) : undefined,
    queryFile: values['query-file'],
    raw: !!values.raw,
    source: values.source,
    in: values.in,
    expand: !!values.expand,
    full: !!values.full,
    json: !!values.json,
    depth: values.depth ? parseInt(values.depth, 10) : undefined,
    orphans: !!values.orphans,
    broken: !!values.broken,
    verify: !!values.verify,
    force: !!values.force,
    short: !!values.short,
    tune: !!values.tune,
    used: values.used,
    deadend: values.deadend,
    report: !!values.report,
    query: values.query,
    at: values.at,
    date: values.date,
    learn: !!values.learn,
  };
  const cfg = loadConfig();
  if (opts.source && !cfg.sources.some((s) => s.id === opts.source)) {
    fail(`source inconnue : ${opts.source} (connues : ${cfg.sources.map((s) => s.id).join(', ')})`);
  }
  const rest = positionals.slice(1);
  switch (cmd) {
    case 'search': return cmdSearch(cfg, rest, opts);
    case 'show': return cmdShow(cfg, rest, opts);
    case 'outline': return cmdOutline(cfg, rest, opts);
    case 'related': return cmdRelated(cfg, rest, opts);
    case 'graph': return cmdGraph(cfg, rest, opts);
    case 'index': return cmdIndex(cfg, rest, opts);
    case 'lint': return cmdLint(cfg, rest, opts);
    case 'stats': return cmdStats(cfg, rest, opts);
    case 'calibrate': return cmdCalibrate(cfg, rest, opts);
    case 'reflect': return cmdReflect(cfg, rest, opts);
    case 'drafts': return cmdDrafts(cfg, rest, opts);
    case 'promote': return cmdPromote(cfg, rest, opts);
    case 'demote': return cmdDemote(cfg, rest, opts);
    default:
      fail(`sous-commande inconnue : ${cmd}\n\n${USAGE}`);
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2)) || 0;
}

// Exports pour brain.test.mjs (aucun effet de bord à l'import).
module.exports = {
  loadConfig, tokenize, fold, stemFrLight, slugify,
  parseFile, chunkSections, isNavigational,
  discoverFiles, runIndex, ensureIndex, loadIndexRaw, indexPath, probeIndex,
  scoreQuery, search, buildSnippet, buildGraph, writeGraphJson, layout,
  parseQueryDocument, reciprocalRankFusion, RRF_K, RRF_BONUS,
  evaluerFixtures, cibleAtteinte, ciblesDe, seuilDepuis,
  loadLearning, saveLearning, analyserLearning, learningPath,
  DEMI_VIE_JOURS, CORROBORATIONS_MIN,
  resolveFileArg, defaultThreshold, main,
  localiserFiche, changerStatutFiche, frontmatterFiche, statutDeFiche, ficheId, dateDuJour,
  cmdDrafts, cmdPromote, cmdDemote,
  assainir, contextForFile, evidenceOf, creationSureOf, missingSources, synopsisOf,
  detectExtractor, ensurePdfText, parseIndexable, pdfTextToMarkdown, textSrc, pdftextDir,
  W, K1, B, MINLEN, ZONE_WEIGHT, LIMITE, EVIDENCE_ORDRE, SHRINK_TOL,
};
