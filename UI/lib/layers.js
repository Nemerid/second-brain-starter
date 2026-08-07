'use strict';
/**
 * layers.js — introspection RÉELLE des trois couches non-mémoire de l'OS agentique.
 *
 *   Applications → serveurs MCP déclarés (~/.claude.json, .mcp.json du projet)
 *   Routines     → routines/ du second cerveau + agents launchd com.secondbrain.*
 *   Skills       → les SKILL.md de ~/.claude/skills et de .claude/skills du projet
 *
 * RÈGLE DE CONFIDENTIALITÉ (non négociable) : ~/.claude.json contient des jetons
 * en clair dans les blocs `env` et parfois dans les URL. Ce module ne recopie
 * JAMAIS `env`, ni une URL complète : il n'expose que le nom, le transport et
 * l'hôte. Toute évolution qui élargirait ce périmètre doit être refusée.
 *
 * RÈGLE DE RISQUE : la politique locale `UI/mcp-risk.json` est prioritaire sur
 * ce que déclare un serveur. Défaut pessimiste « inconnu », jamais « sans risque ».
 */

const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');

/* ------------------------------------------------------------------ outils */

function listerDossiers(racine) {
  try {
    return fs.readdirSync(racine, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name[0] !== '.')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'fr'));
  } catch (_) {
    return [];
  }
}

function listerFichiers(racine) {
  try {
    return fs.readdirSync(racine, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name[0] !== '.')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'fr'));
  } catch (_) {
    return [];
  }
}

/**
 * Lecteur de frontmatter YAML volontairement minimal (zéro dépendance) :
 * gère `cle: valeur`, les guillemets, les scalaires de bloc `>` et `|`, et les
 * listes en ligne `[a, b]`. Suffisant pour un SKILL.md, et incapable d'exécuter
 * quoi que ce soit — ce qui est le but.
 */
function lireFrontmatter(texte) {
  if (!texte.startsWith('---')) return {};
  const fin = texte.indexOf('\n---', 3);
  if (fin === -1) return {};
  const lignes = texte.slice(texte.indexOf('\n') + 1, fin).split('\n');
  const out = {};
  let cle = null;
  let bloc = null;      // '>' ou '|'
  let morceaux = [];
  let indentBloc = 0;

  const cloreBloc = () => {
    if (cle && bloc) {
      out[cle] = bloc === '>' ? morceaux.join(' ').trim() : morceaux.join('\n').trim();
    }
    bloc = null; morceaux = []; cle = null;
  };

  for (const ligne of lignes) {
    if (bloc) {
      const vide = ligne.trim() === '';
      const indent = ligne.length - ligne.replace(/^\s+/, '').length;
      if (vide) { morceaux.push(''); continue; }
      if (indent >= indentBloc) { morceaux.push(ligne.slice(indentBloc).trimEnd()); continue; }
      cloreBloc();
    }
    if (!ligne.trim() || ligne.trimStart()[0] === '#') continue;
    if (/^\s/.test(ligne)) continue;                       // sous-clé : ignorée
    const m = ligne.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const nom = m[1];
    let val = m[2].trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      cle = nom; bloc = val[0]; morceaux = []; indentBloc = 2;
      continue;
    }
    if (val.startsWith('"') && val.endsWith('"') && val.length > 1) {
      try { val = JSON.parse(val); } catch (_) { val = val.slice(1, -1); }
    } else if (val.startsWith("'") && val.endsWith("'") && val.length > 1) {
      val = val.slice(1, -1);
    }
    out[nom] = val;
  }
  cloreBloc();
  return out;
}

/* ------------------------------------------------- couche 1 : Applications */

function chargerPolitiqueRisque() {
  const brut = P.lireJson(path.join(P.UI_DIR, 'mcp-risk.json'), null);
  if (!brut || typeof brut !== 'object') {
    return {
      avertissement:
        'Politique de risque introuvable : tous les serveurs sont classés « inconnu ».',
      defaut: {
        level: 'inconnu',
        why: 'UI/mcp-risk.json absent ou illisible : aucune présomption d’innocuité.',
        origin: 'default',
      },
      serveurs: {}, prefixes: {},
    };
  }
  return {
    avertissement: brut.avertissement || '',
    niveaux: brut.niveaux || {},
    defaut: brut.defaut || { level: 'inconnu', why: 'Non répertorié.', origin: 'default' },
    serveurs: brut.serveurs || {},
    prefixes: brut.prefixes || {},
  };
}

function evaluerRisque(nom, politique, declare) {
  const exact = politique.serveurs[nom];
  if (exact) {
    const r = {
      level: exact.level || 'inconnu',
      why: exact.why || 'Classé par la politique locale.',
      origin: 'policy',
    };
    if (exact.portee) r.portee = exact.portee;
    if (declare && declare.level && declare.level !== r.level) {
      r.divergence =
        'Le serveur se déclare « ' + declare.level +
        ' » ; la politique locale le classe « ' + r.level + ' ». La politique prime.';
    }
    return r;
  }
  for (const prefixe of Object.keys(politique.prefixes || {})) {
    if (prefixe === '_lisez_moi') continue;
    if (nom.startsWith(prefixe)) {
      const p = politique.prefixes[prefixe];
      const r = {
        level: p.level || 'inconnu',
        why: p.why || 'Classé par règle de préfixe locale.',
        origin: 'policy',
      };
      if (p.portee) r.portee = p.portee;
      return r;
    }
  }
  if (declare && declare.level) {
    return {
      level: declare.level,
      why: declare.why + ' (déclaration du serveur, non vérifiable).',
      origin: 'declared',
    };
  }
  return {
    level: politique.defaut.level || 'inconnu',
    why: politique.defaut.why,
    origin: 'default',
  };
}

/** Transport et hôte, SANS jeton : on ne recopie ni `env`, ni URL complète. */
function decrireTransport(def) {
  const type = typeof def.type === 'string' ? def.type.toLowerCase() : '';
  if (type === 'http' || type === 'sse' || def.url) {
    let hote = '';
    try { hote = new URL(def.url).host; } catch (_) { hote = ''; }
    return { transport: type === 'sse' ? 'sse' : 'http', hote, commande: '' };
  }
  const cmd = typeof def.command === 'string' ? def.command : '';
  let cible = '';
  if (Array.isArray(def.args)) {
    for (const a of def.args) {
      if (typeof a === 'string' && /\.(m?js|py|ts|sh)$/.test(a)) { cible = path.basename(a); break; }
    }
    if (!cible && def.args.length) cible = String(def.args[0]).split(/[\\/]/).pop();
  }
  return { transport: 'stdio', hote: '', commande: (cmd + (cible ? ' ' + cible : '')).trim() };
}

/**
 * Annotation déclarée : Claude Code ne persiste pas les tool annotations dans
 * ~/.claude.json, on n'a donc à peu près jamais de déclaration à croiser. On
 * accepte tout de même un champ local `risk`/`annotations` si un jour il existe.
 */
function lireDeclaration(def) {
  const a = def && (def.annotations || def.risk);
  if (!a || typeof a !== 'object') return null;
  if (a.readOnlyHint === true) {
    return { level: 'lecture', why: 'Le serveur annonce readOnlyHint: true' };
  }
  if (a.destructiveHint === true) {
    return { level: 'action', why: 'Le serveur annonce destructiveHint: true' };
  }
  return null;
}

function collecterApplications() {
  const politique = chargerPolitiqueRisque();
  const trouves = new Map(); // nom → entrée

  const ajouter = (nom, def, scope, provenance) => {
    if (!nom || typeof nom !== 'string') return;
    if (trouves.has(nom)) {
      const e = trouves.get(nom);
      if (e.provenances.indexOf(provenance) === -1) e.provenances.push(provenance);
      return;
    }
    const d = def && typeof def === 'object' ? def : {};
    const t = decrireTransport(d);
    trouves.set(nom, {
      name: nom,
      transport: t.transport,
      scope,
      hote: t.hote,
      commande: t.commande,
      provenances: [provenance],
      risk: evaluerRisque(nom, politique, lireDeclaration(d)),
    });
  };

  // Portée utilisateur : ~/.claude.json, clé racine `mcpServers`.
  const claudeJson = P.lireJson(path.join(P.HOME, '.claude.json'), null);
  if (claudeJson && claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object') {
    for (const nom of Object.keys(claudeJson.mcpServers)) {
      ajouter(nom, claudeJson.mcpServers[nom], 'user', '~/.claude.json');
    }
  }

  // Portée projet : entrée `projects[<racine>]` de ~/.claude.json.
  if (claudeJson && claudeJson.projects && typeof claudeJson.projects === 'object') {
    for (const racine of [P.KB_DIR, path.dirname(P.KB_DIR)]) {
      const proj = claudeJson.projects[racine];
      if (proj && proj.mcpServers && typeof proj.mcpServers === 'object') {
        for (const nom of Object.keys(proj.mcpServers)) {
          ajouter(nom, proj.mcpServers[nom], 'project', '~/.claude.json → projects');
        }
      }
    }
  }

  // Portée claude.ai : connecteurs hébergés (Gmail, Drive, Agenda, Supermetrics…).
  // Ils n'apparaissent pas dans `mcpServers` — Claude Code n'en garde que la liste
  // `claudeAiMcpEverConnected`, en libellé humain. On la normalise vers le nom
  // réellement porté par les outils (`claude.ai Google Drive` → `claude_ai_Google_Drive`),
  // sans quoi la règle de risque par préfixe `claude_ai_` ne s'appliquerait jamais et
  // cette surface d'accès resterait invisible dans la console.
  if (claudeJson && Array.isArray(claudeJson.claudeAiMcpEverConnected)) {
    for (const libelle of claudeJson.claudeAiMcpEverConnected) {
      if (typeof libelle !== 'string' || !libelle) continue;
      const nom = libelle.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '');
      ajouter(nom, { type: 'http' }, 'claudeai', '~/.claude.json → claudeAiMcpEverConnected');
      const e = trouves.get(nom);
      if (e && !e.libelle) e.libelle = libelle;
    }
  }

  // Portée projet : .mcp.json versionné à la racine du second cerveau.
  const mcpJson = P.lireJson(path.join(P.KB_DIR, '.mcp.json'), null);
  if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
    for (const nom of Object.keys(mcpJson.mcpServers)) {
      ajouter(nom, mcpJson.mcpServers[nom], 'project', '.mcp.json');
    }
  }

  const liste = Array.from(trouves.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { applications: liste, politique: { avertissement: politique.avertissement } };
}

/* ----------------------------------------------------- couche 2 : Routines */

/** Lecture minimale d'un plist launchd (regex, aucune dépendance). */
function lirePlist(fichier) {
  let texte;
  try { texte = fs.readFileSync(fichier, 'utf8'); } catch (_) { return null; }
  const label = (texte.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/) || [])[1] || '';
  const prog = [];
  const bloc = texte.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (bloc) {
    const re = /<string>([^<]*)<\/string>/g;
    let m;
    while ((m = re.exec(bloc[1]))) prog.push(m[1]);
  }
  let horaire = '';
  const cal = texte.match(/<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (cal) {
    const champs = {};
    const re = /<key>(\w+)<\/key>\s*<integer>(-?\d+)<\/integer>/g;
    let m;
    while ((m = re.exec(cal[1]))) champs[m[1]] = Number(m[2]);
    if (champs.Hour !== undefined) {
      const hh = String(champs.Hour).padStart(2, '0');
      const mm = String(champs.Minute || 0).padStart(2, '0');
      horaire = 'tous les jours à ' + hh + ' h ' + mm;
      if (champs.Weekday !== undefined) {
        const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
        horaire = 'chaque ' + (jours[champs.Weekday] || 'jour') + ' à ' + hh + ' h ' + mm;
      }
    }
  }
  const inter = texte.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  if (!horaire && inter) horaire = 'toutes les ' + Math.round(Number(inter[1]) / 60) + ' min';
  const charge = /<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(texte);
  if (!horaire && charge) horaire = 'au chargement de la session';
  return { label, horaire: horaire || 'déclenchement non calendaire', prog };
}

function collecterRoutines() {
  const out = [];

  // a) routines/ du second cerveau : plists non installés + documentation.
  const dossier = path.join(P.KB_DIR, 'routines');
  for (const nom of listerFichiers(dossier)) {
    const abs = path.join(dossier, nom);
    if (nom.endsWith('.plist')) {
      const pl = lirePlist(abs) || { label: nom, horaire: '' };
      out.push({
        name: pl.label || nom.replace(/\.plist$/, ''),
        schedule: pl.horaire,
        definition: abs,
        kind: 'launchd',
        etat: 'non installé (gabarit versionné dans routines/)',
        commande: pl.prog.join(' '),
      });
    } else if (nom.endsWith('.md') && !/^readme\.md$/i.test(nom)) {
      const fm = lireFrontmatter(safeRead(abs));
      out.push({
        name: fm.titre || fm.name || nom.replace(/\.md$/, ''),
        schedule: fm.schedule || fm.declenchement || 'déclenchement manuel',
        definition: abs,
        kind: 'doc',
        etat: 'procédure documentée',
        commande: '',
      });
    } else if (nom.endsWith('.sh')) {
      out.push({
        name: nom.replace(/\.sh$/, ''),
        schedule: 'appelé par une autre routine',
        definition: abs, kind: 'doc', etat: 'script', commande: '',
      });
    }
  }

  // b) agents launchd RÉELLEMENT installés pour le second cerveau.
  const la = path.join(P.HOME, 'Library', 'LaunchAgents');
  for (const nom of listerFichiers(la)) {
    if (!/^com\.secondbrain\..*\.plist$/.test(nom)) continue;
    const abs = path.join(la, nom);
    const pl = lirePlist(abs) || { label: nom, horaire: '' };
    out.push({
      name: pl.label || nom.replace(/\.plist$/, ''),
      schedule: pl.horaire,
      definition: abs,
      kind: 'launchd',
      etat: 'installé dans ~/Library/LaunchAgents',
      commande: pl.prog.join(' '),
    });
  }

  // c) skills projet à vocation de routine (dream, ingest…).
  for (const s of collecterSkills()) {
    if (s.scope !== 'project') continue;
    if (!/^(dream|ingest|consolidate|nuit)/i.test(s.name)) continue;
    out.push({
      name: '/' + s.name,
      schedule: 'invocation manuelle ou tâche planifiée',
      definition: s.path,
      kind: 'skill',
      etat: 'skill du projet',
      commande: '',
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function safeRead(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; }
}

/* ------------------------------------------------------- couche 4 : Skills */

function lireSkillsDe(racine, scope, layer) {
  const out = [];
  for (const nom of listerDossiers(racine)) {
    const fichier = path.join(racine, nom, 'SKILL.md');
    if (!fs.existsSync(fichier)) continue;
    const texte = safeRead(fichier);
    const fm = lireFrontmatter(texte);
    const description = (fm.description || '').replace(/\s+/g, ' ').trim();
    out.push({
      name: fm.name || nom,
      description: description || '(aucune description dans le frontmatter)',
      scope,
      path: path.join(racine, nom),
      fichier,
      layer,
      declencheurs: (fm['when-to-use'] || fm.when_to_use || '').replace(/\s+/g, ' ').trim(),
      outils: (fm['allowed-tools'] || fm.allowedTools || '').trim(),
      invocable: fm['user-invocable'] === 'false' ? false : true,
      lignes: texte ? texte.split('\n').length : 0,
    });
  }
  return out;
}

function collecterSkills() {
  const out = []
    .concat(lireSkillsDe(path.join(P.KB_DIR, '.claude', 'skills'), 'project', 'second-brain'))
    .concat(lireSkillsDe(path.join(P.KB_DIR, 'skills'), 'project', 'second-brain'))
    .concat(lireSkillsDe(path.join(P.HOME, '.claude', 'skills'), 'user', 'global'));
  const vues = new Set();
  return out
    .filter((s) => {
      const cle = s.scope + '/' + s.name;
      if (vues.has(cle)) return false;
      vues.add(cle);
      return true;
    })
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
      return a.name.localeCompare(b.name, 'fr');
    });
}

/* --------------------------------------------------------------- assemblage */

function collecterCouches() {
  const apps = collecterApplications();
  const skills = collecterSkills();
  const routines = collecterRoutines();
  return {
    generatedAt: new Date().toISOString(),
    applications: apps.applications,
    routines,
    skills,
    politique: apps.politique,
    racines: {
      knowledgeBase: P.KB_DIR,
      skillsUtilisateur: path.join(P.HOME, '.claude', 'skills'),
      skillsProjet: path.join(P.KB_DIR, '.claude', 'skills'),
      routines: path.join(P.KB_DIR, 'routines'),
      launchAgents: path.join(P.HOME, 'Library', 'LaunchAgents'),
    },
  };
}

module.exports = {
  collecterCouches, collecterApplications, collecterRoutines, collecterSkills,
  lireFrontmatter, lirePlist, chargerPolitiqueRisque, evaluerRisque,
};
