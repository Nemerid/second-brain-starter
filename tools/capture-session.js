#!/usr/bin/env node
/**
 * capture-session.js — capture automatique des conversations Claude Code.
 *
 * Branché sur le hook SessionEnd (portée utilisateur : toutes les sessions de la
 * machine — activation documentée dans routines/README.md), il dépose à la fin de
 * chaque session un condensé du dialogue dans raw/sessions/ du second cerveau.
 * C'est un DÉPÔT BRUT (zone immuable) : aucune synthèse ici — la distillation
 * en fiches reste le travail de /ingest et de la Dream Sequence, avec diff relu.
 *
 * Garanties :
 *  - sort TOUJOURS en code 0 (un échec de capture ne gêne jamais la session) ;
 *  - idempotent : une session déjà capturée (même id) n'est pas redéposée ;
 *  - seuil de substance : moins de 3 messages humains → pas de dépôt ;
 *  - bornes : 3 000 caractères par message, ~250 Ko par fichier.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KB = path.resolve(__dirname, '..');                // …/knowledge_base
const DEST = path.join(KB, 'raw', 'sessions');
const MAX_MSG = 3000;
const MAX_TOTAL = 250 * 1024;
const MIN_HUMAIN = 3;

function texteDe(content) {
  // content : chaîne, ou tableau de blocs {type:"text",text}/{type:"tool_use"…}
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

function estBruitOutil(t) {
  // wrappers de commandes locales, rappels système, notifications de tâches
  const d = t.trim();
  return /^<(command-name|local-command-stdout|system-reminder|task-notification)/.test(d) ||
    /^\[SYSTEM NOTIFICATION/.test(d) || /^Caveat:/.test(d);
}

/**
 * masquer — retire toute valeur qui ressemble à un secret AVANT écriture dans
 * raw/sessions/. Ne touche JAMAIS aux fichiers d'origine (.env, notes d'accès…) :
 * le secret y reste intact. Ici on empêche seulement le second cerveau d'avaler
 * une copie en clair. Le remplaçant dit qu'un secret était là, pas sa valeur.
 */
const REMPL = '⟦secret masqué — voir la source d\'origine⟧';
function masquer(t) {
  if (!t) return t;
  return t
    // clés/API/tokens connus par préfixe
    .replace(/\b(AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,}\b/g, REMPL)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{20,}\b/g, REMPL)
    .replace(/\bgh[posu]_[A-Za-z0-9]{30,}\b/g, REMPL)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, REMPL)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REMPL)
    .replace(/\b(AIza)[A-Za-z0-9_\-]{30,}\b/g, REMPL)
    .replace(/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, REMPL) // JWT
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REMPL)
    // « mot de passe : xxxx », « password=xxxx », « secret: xxxx », « token = xxxx »
    .replace(/\b(mot de passe|mdp|password|passwd|secret|token|api[_-]?key|clé|cle|bearer)\b\s*[:=]\s*["'`]?([^\s"'`<>]{6,})/gi,
      function (m, label) { return label + ' : ' + REMPL; })
    // IBAN français
    .replace(/\bFR\d{2}[ ]?(\d{4}[ ]?){5}\d{3}\b/g, REMPL);
}

function main(brut) {
  let ev;
  try { ev = JSON.parse(brut); } catch (e) { return; }
  const transcript = ev.transcript_path;
  const sid = String(ev.session_id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!transcript || !sid || !fs.existsSync(transcript)) return;

  const sid8 = sid.slice(0, 8);
  fs.mkdirSync(DEST, { recursive: true });
  const deja = fs.readdirSync(DEST).some(function (f) { return f.indexOf(sid8) !== -1; });
  if (deja) return;

  const lignes = fs.readFileSync(transcript, 'utf8').split('\n');
  const tours = [];
  let nHumain = 0;
  for (const l of lignes) {
    if (!l.trim()) continue;
    let d; try { d = JSON.parse(l); } catch (e) { continue; }
    if (d.isMeta) continue;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    let t = texteDe((d.message || {}).content).trim();
    if (!t || estBruitOutil(t)) continue;
    t = masquer(t);                                   // jamais de secret en clair dans raw/sessions/
    if (t.length > MAX_MSG) t = t.slice(0, MAX_MSG) + '\n[… tronqué]';
    if (d.type === 'user') nHumain++;
    const dernier = tours[tours.length - 1];
    if (dernier && dernier.role === d.type) dernier.texte += '\n\n' + t;
    else tours.push({ role: d.type, texte: t });
  }
  if (nHumain < MIN_HUMAIN) return;

  const quand = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  const jour = '' + quand.getFullYear() + p(quand.getMonth() + 1) + p(quand.getDate());
  const heure = p(quand.getHours()) + p(quand.getMinutes());
  const projet = path.basename(ev.cwd || 'inconnu').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'inconnu';
  const fichier = path.join(DEST, jour + '-' + heure + '-' + projet + '-' + sid8 + '.md');

  let md = '---\n' +
    'source: session Claude Code\n' +
    'projet: ' + (ev.cwd || 'inconnu') + '\n' +
    'session: ' + sid + '\n' +
    'date: ' + quand.toISOString() + '\n' +
    'messages_humains: ' + nHumain + '\n' +
    '---\n\n' +
    '# Session « ' + projet + ' » du ' + p(quand.getDate()) + '/' + p(quand.getMonth() + 1) + '/' + quand.getFullYear() + '\n\n' +
    '> Dépôt automatique (hook SessionEnd). À distiller par `/ingest` ou la Dream Sequence :\n' +
    '> n\'en retenir que les décisions, faits durables et leçons — pas le déroulé.\n\n';
  for (const t of tours) {
    md += (t.role === 'user' ? '## Utilisateur\n\n' : '## Claude\n\n') + t.texte + '\n\n';
    if (md.length > MAX_TOTAL) { md += '\n[… session tronquée]\n'; break; }
  }
  fs.writeFileSync(fichier, md);
}

/**
 * Dream Sequence opportuniste : launchd ne peut pas exécuter de script depuis
 * ce volume externe (TCC, exit 126) — c'est donc ici, dans la session
 * utilisateur, que la passe quotidienne se déclenche. Si la dernière tentative
 * date de plus de 24 h, on lance routines/dream-nightly.sh DÉTACHÉ (le hook
 * rend la main immédiatement ; le script a son propre verrou et ses portes,
 * et n'appelle l'IA — Haiku, via l'abonnement — que s'il y a à distiller).
 */
function reverSiDu() {
  const stamp = path.join(KB, '.brain', 'last-dream');
  const script = path.join(KB, 'routines', 'dream-nightly.sh');
  if (!fs.existsSync(script)) return;
  try {
    const age = Date.now() - fs.statSync(stamp).mtimeMs;
    if (age < 24 * 3600 * 1000) return;
  } catch (e) { /* pas d'estampille : première passe */ }
  const enfant = require('child_process').spawn('/bin/sh', [script], {
    detached: true, stdio: 'ignore',
  });
  enfant.unref();
}

let entree = '';
process.stdin.on('data', function (c) { entree += c; });
process.stdin.on('end', function () {
  try { main(entree); } catch (e) { /* jamais bloquant */ }
  try { reverSiDu(); } catch (e) { /* jamais bloquant */ }
  process.exit(0);
});
