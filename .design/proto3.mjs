// Prototype de validation : BM25F par section vs comptage regex naif, corpus FR reel
import fs from 'node:fs';
import path from 'node:path';

// Prototype de validation : PROTO_ROOT pointe vers un dossier de fiches .md a evaluer.
// Par defaut, le wiki du depot (vide au depart : fournir un corpus pour comparer).
const ROOT = process.env.PROTO_ROOT
  || path.resolve(new URL('.', import.meta.url).pathname, '..', 'wiki');

// --- normalisation FR ---
const ELISIONS = new Set(['l','d','j','n','m','t','s','c','qu','lorsqu','puisqu','quoiqu','jusqu']);
function fold(s) {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}
function stemFrLight(w) {
  // stemming leger FR (inspire du FrenchLightStemmer de Lucene, tres reduit)
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
const segmenter = new Intl.Segmenter('fr', { granularity: 'word' });
function tokenize(text, { stem = true } = {}) {
  const out = [];
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    let w = fold(seg.segment);
    // elision : l'entreprise -> entreprise (+ garder la forme jointe)
    const m = w.match(/^([a-z]{1,6})['’](.+)$/);
    if (m && ELISIONS.has(m[1])) w = m[2];
    if (w.length < 2) continue;
    out.push(stem ? stemFrLight(w) : w);
  }
  return out;
}

// --- decoupage par sections ---
function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let body = raw, fm = {};
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const lines = body.split('\n');
  const sections = [];
  let cur = null, crumb = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/^```/.test(L)) inFence = !inFence;
    const h = !inFence && L.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length, title = h[2].trim();
      crumb = crumb.slice(0, lvl - 1); crumb[lvl - 1] = title;
      if (cur) sections.push(cur);
      cur = { file, line: i + 1, level: lvl, title, crumb: crumb.filter(Boolean).join(' > '), text: '' };
    } else {
      if (!cur) cur = { file, line: 1, level: 0, title: '(preambule)', crumb: '', text: '' };
      cur.text += L + '\n';
    }
  }
  if (cur) sections.push(cur);
  return { fm, sections, raw };
}

// --- index ---
const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.md')).map(f => path.join(ROOT, f));
const docs = [];
const graph = new Map();
for (const f of files) {
  const { fm, sections } = parse(f);
  for (const s of sections) {
    const links = [...s.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim());
    if (links.length) {
      const k = path.basename(f);
      if (!graph.has(k)) graph.set(k, new Set());
      for (const l of links) graph.get(k).add(l.replace(/\.md$/,'') + '.md');
    }
    // une section dont >30% du texte est des wikilinks n'est pas du contenu : c'est du graphe
    const linkChars = links.join('').length;
    if (s.text.trim().length < 400 && linkChars > s.text.trim().length * 0.25) continue;
    docs.push({
      id: `${path.basename(f)}#${s.line}`,
      file: path.basename(f), title: s.title, crumb: s.crumb, line: s.line,
      chars: s.text.length + s.title.length,
      fields: {
        title: tokenize(s.title),
        crumb: tokenize(s.crumb),
        meta: tokenize([fm.themes, fm.source, fm.video, path.basename(f, '.md').replace(/-/g, ' ')].filter(Boolean).join(' ')),
        body: tokenize(s.text),
      },
    });
  }
}

// BM25F : ponderation AVANT la saturation (Robertson/Zaragoza/Taylor 2004)
const W = { title: 4, crumb: 1.5, meta: 2, body: 1 };
const K1 = 1.2, B = 0.75, MINLEN = 120;
const df = new Map();
let totalLen = 0;
for (const d of docs) {
  d.tf = new Map(); d.len = 0;
  for (const [field, toks] of Object.entries(d.fields)) {
    const w = W[field];
    for (const t of toks) { d.tf.set(t, (d.tf.get(t) || 0) + w); d.len += w; }
  }
  totalLen += d.len;
  for (const t of new Set(d.tf.keys())) df.set(t, (df.get(t) || 0) + 1);
}
const avgLen = totalLen / docs.length;
const N = docs.length;

function bm25f(query) {
  const q = [...new Set(tokenize(query))];
  const res = [];
  for (const d of docs) {
    let score = 0, hits = 0;
    for (const t of q) {
      const f = d.tf.get(t); if (!f) continue;
      hits++;
      const n = df.get(t);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const dl = Math.max(d.len, MINLEN);
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgLen));
    }
    if (score > 0) res.push({ d, score: score * (1 + 0.15 * (hits - 1)), hits });
  }
  res.sort((a, b) => b.score - a.score);
  const perFile = new Map(); const out = [];
  for (const r of res) {
    const c = perFile.get(r.d.file) || 0;
    if (c >= 2) continue;
    perFile.set(r.d.file, c + 1); out.push(r);
  }
  return out;
}

// baseline : comptage regex naif au niveau FICHIER (ce que fait la spec)
const rawFiles = files.map(f => ({ file: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
function naive(query) {
  const terms = query.split(/\s+/).filter(Boolean);
  const res = [];
  for (const rf of rawFiles) {
    let c = 0;
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      c += (rf.text.match(re) || []).length;
    }
    if (c > 0) res.push({ file: rf.file, c, chars: rf.text.length });
  }
  return res.sort((a, b) => b.c - a.c);
}

const queries = [
  'objection trop cher',
  'Objection TROP CHER',          // casse
  'objections trop cheres',        // pluriel/accent
  'reponse a "je vais reflechir"', // accents manquants
  'porte-a-porte',                 // mot compose
  'l\'entreprise du prospect',     // elision
  'ancrage de prix',
];

console.log(`corpus: ${files.length} fichiers, ${docs.length} sections, avgLen=${avgLen.toFixed(0)}\n`);
for (const q of queries) {
  const b = bm25f(q).slice(0, 3);
  const n = naive(q).slice(0, 3);
  const bChars = b.reduce((s, r) => s + r.d.chars, 0);
  const nChars = n.reduce((s, r) => s + r.chars, 0);
  console.log(`Q: "${q}"`);
  console.log(`  BM25F/section : ${b.map(r => `${r.d.file}#${r.d.title.slice(0,28)}(${r.score.toFixed(1)})`).join(' | ') || 'AUCUN'}`);
  console.log(`     -> ${bChars} chars (~${Math.round(bChars/3.2)} tok)`);
  console.log(`  regex/fichier : ${n.map(r => `${r.file}(${r.c})`).join(' | ') || 'AUCUN'}`);
  console.log(`     -> ${nChars} chars (~${Math.round(nChars/3.2)} tok)`);
  console.log('');
}

// graphe
let edges = 0; for (const v of graph.values()) edges += v.size;
console.log(`graphe wikiliens: ${graph.size} noeuds sortants, ${edges} aretes`);
const idx = docs.map(d => ({ id: d.id, f: d.file, t: d.title, l: d.line, c: d.chars, tf: [...d.tf], len: d.len }));
const json = JSON.stringify(idx);
console.log(`index JSON: ${(json.length/1024).toFixed(0)} KB pour ${docs.length} sections / ${files.length} fichiers`);
const t0 = process.hrtime.bigint();
for (const q of queries) bm25f(q);
console.log(`${queries.length} requetes en ${Number(process.hrtime.bigint()-t0)/1e6} ms`);
const totalChars = rawFiles.reduce((s, r) => s + r.text.length, 0);
console.log(`corpus entier: ${totalChars} chars (~${Math.round(totalChars/3.2)} tok)`);

// --- format postings inverse compact ---
const terms = new Map();
docs.forEach((d, i) => { for (const [t, w] of d.tf) { if (!terms.has(t)) terms.set(t, []); terms.get(t).push(i, Math.round(w * 10)); } });
const compact = {
  v: 1, avgLen, docs: docs.map(d => [d.file, d.line, d.title, d.chars, Math.round(d.len)]),
  post: Object.fromEntries(terms),
};
const cj = JSON.stringify(compact);
console.log(`index postings compact: ${(cj.length / 1024).toFixed(0)} KB (${terms.size} termes uniques)`);
import zlib from 'node:zlib';
console.log(`gzip: ${(zlib.gzipSync(cj).length / 1024).toFixed(0)} KB`);
