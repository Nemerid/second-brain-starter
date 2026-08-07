'use strict';
/**
 * graph.js — chargement DÉFENSIF du graphe produit par le moteur.
 *
 * `UI/data/graph.json` appartient à brain.js (autre composant). Il peut être
 * absent, en cours d'écriture, tronqué, ou d'un schéma légèrement différent.
 * L'UI ne doit jamais tomber pour autant : on normalise tout contre le schéma
 * du DESIGN.md §3, on jette silencieusement ce qui est inexploitable, et on
 * bascule sur `graph.sample.json` (graphe de démonstration) si nécessaire.
 */

const fs = require('node:fs');
const path = require('node:path');
const P = require('./paths');

const FICHIER_GRAPHE = path.join(P.DATA_DIR, 'graph.json');
const FICHIER_EXEMPLE = path.join(P.DATA_DIR, 'graph.sample.json');

const GRAPHE_VIDE = {
  generatedAt: null,
  sources: [],
  stats: { files: 0, sections: 0, links: 0, orphans: 0, broken: 0, unprocessed: 0 },
  nodes: [],
  links: [],
};

function nombre(v, defaut) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defaut;
}

function texte(v, defaut) {
  return typeof v === 'string' && v.length ? v : defaut;
}

/** Ramène n'importe quel objet vers le schéma §3, en supprimant l'inexploitable. */
function normaliser(brut, sourcesConnues) {
  const g = brut && typeof brut === 'object' ? brut : {};

  const sources = Array.isArray(g.sources) && g.sources.length
    ? g.sources
        .filter((s) => s && typeof s.id === 'string')
        .map((s) => ({
          id: s.id,
          label: texte(s.label, s.id),
          color: texte(s.color, '#94a3b8'),
          root: texte(s.root, ''),
        }))
    : (sourcesConnues || []).map((s) => ({
        id: s.id, label: s.label, color: s.color, root: s.root,
      }));

  const idsSources = new Set(sources.map((s) => s.id));
  const zonesValides = { distilled: 1, raw: 1, outputs: 1 };

  const noeuds = [];
  const vus = new Set();
  for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
    if (!n || typeof n.id !== 'string' || !n.id) continue;
    if (vus.has(n.id)) continue;
    vus.add(n.id);
    const source = typeof n.source === 'string' && idsSources.has(n.source) ? n.source : '';
    const zone = zonesValides[n.zone] ? n.zone : 'distilled';
    noeuds.push({
      id: n.id,
      label: texte(n.label, n.id.split('/').pop()),
      source,
      zone,
      abs: texte(n.abs, ''),
      size: nombre(n.size, 0),
      inbound: nombre(n.inbound, 0),
      outbound: nombre(n.outbound, 0),
      orphan: n.orphan === true,
      unprocessed: n.unprocessed === true,
      ghost: n.ghost === true,
      x: Number.isFinite(Number(n.x)) ? Number(n.x) : null,
      y: Number.isFinite(Number(n.y)) ? Number(n.y) : null,
    });
  }

  // Un lien vers un nœud inconnu crée un nœud fantôme, plutôt que de faire
  // planter force-graph (qui exige que toute extrémité existe).
  const liens = [];
  for (const l of Array.isArray(g.links) ? g.links : []) {
    if (!l) continue;
    const s = typeof l.source === 'string' ? l.source
      : (l.source && typeof l.source.id === 'string' ? l.source.id : null);
    const t = typeof l.target === 'string' ? l.target
      : (l.target && typeof l.target.id === 'string' ? l.target.id : null);
    if (!s || !t) continue;
    for (const bout of [s, t]) {
      if (!vus.has(bout)) {
        vus.add(bout);
        noeuds.push({
          id: bout, label: bout.split('/').pop(), source: '', zone: 'distilled',
          abs: '', size: 0, inbound: 0, outbound: 0, orphan: false,
          unprocessed: false, ghost: true, x: null, y: null,
        });
      }
    }
    liens.push({ source: s, target: t, broken: l.broken === true });
  }

  const st = g.stats && typeof g.stats === 'object' ? g.stats : {};
  const reels = noeuds.filter((n) => !n.ghost);
  const stats = {
    files: nombre(st.files, reels.length),
    sections: nombre(st.sections, 0),
    links: nombre(st.links, liens.length),
    orphans: nombre(st.orphans, reels.filter((n) => n.orphan).length),
    broken: nombre(st.broken, liens.filter((l) => l.broken).length),
    unprocessed: nombre(st.unprocessed, reels.filter((n) => n.unprocessed).length),
  };

  return {
    generatedAt: texte(g.generatedAt, null),
    sources, stats, nodes: noeuds, links: liens,
  };
}

/**
 * Charge le graphe. Ordre : graph.json → graph.sample.json → graphe vide.
 * Retourne `{ graphe, origine, avertissement }` pour que l'UI puisse le dire
 * franchement à l'utilisateur plutôt que d'afficher un graphe d'exemple en
 * le faisant passer pour la réalité.
 */
function charger(sourcesConnues) {
  let brut = null;
  let origine = 'vide';
  let avertissement = '';

  if (fs.existsSync(FICHIER_GRAPHE)) {
    try {
      brut = JSON.parse(fs.readFileSync(FICHIER_GRAPHE, 'utf8'));
      origine = 'index';
    } catch (e) {
      avertissement =
        'UI/data/graph.json est illisible (' + e.message +
        '). Repli sur le graphe d’exemple — relancer « node brain.js index ».';
    }
  } else {
    avertissement =
      'UI/data/graph.json n’existe pas encore : le moteur n’a pas encore indexé. ' +
      'Affichage du graphe d’exemple — lancer « node brain.js index ».';
  }

  if (!brut && fs.existsSync(FICHIER_EXEMPLE)) {
    try {
      brut = JSON.parse(fs.readFileSync(FICHIER_EXEMPLE, 'utf8'));
      origine = 'exemple';
    } catch (_) { /* on retombera sur le graphe vide */ }
  }

  if (!brut) {
    return {
      graphe: Object.assign({}, GRAPHE_VIDE, {
        sources: (sourcesConnues || []).map((s) => ({
          id: s.id, label: s.label, color: s.color, root: s.root,
        })),
      }),
      origine: 'vide',
      avertissement: avertissement || 'Aucun graphe disponible.',
    };
  }

  const graphe = normaliser(brut, sourcesConnues);
  graphe.origine = origine;
  graphe.avertissement = origine === 'index' ? '' : avertissement;
  return { graphe, origine, avertissement: graphe.avertissement };
}

module.exports = { charger, normaliser, FICHIER_GRAPHE, FICHIER_EXEMPLE, GRAPHE_VIDE };
