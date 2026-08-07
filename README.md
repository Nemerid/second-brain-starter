# Second Brain Agentic OS — starter

**v0.1.2** — licence MIT

*A local, agentic second brain for Claude Code. You drop in raw material; the agent
distills it into an atomic wiki. A dependency-free BM25F engine (`brain.js`) answers
queries with paths, line numbers and 240-character snippets instead of whole files —
cutting token cost — and a Claude Code hook consults it before every message. A local
4-layer "observatory" lets you watch the system as an operating system. **100% local:
this repo is the bare software — your content stays on your machine, nothing is ever
sent anywhere.** Everything below is in French.*

---

Un **second cerveau agentique local** pour Claude Code. Vous déposez de la matière brute
(articles, PDF, transcriptions, notes) ; l'agent la distille en fiches wiki atomiques. Un
moteur de recherche **BM25F déterministe, sans aucune dépendance** (`brain.js`) répond par
des chemins, des numéros de ligne et des extraits — jamais des fichiers entiers — ce qui
**économise des tokens**. Un **hook** interroge ce moteur avant chaque message, un autre
retient la recherche web tant que la base locale n'a pas parlé. Un **observatoire** local
montre l'ensemble comme un système d'exploitation à quatre couches.

> **Ceci est le LOGICIEL nu.** Le dépôt ne contient aucune fiche de contenu : vous déposez
> VOTRE matière, elle reste chez vous, tout tourne **100 % en local**. Les hooks n'envoient
> rien à l'extérieur.

## Démarrage rapide

Prérequis : **Node ≥ 18** (rien d'autre — aucun `npm install`, aucun `package.json`).

```sh
git clone <votre-dépôt> mon-second-cerveau
cd mon-second-cerveau

node brain.js index                 # 1. construire l'index (et UI/data/graph.json)
node brain.js search "ma requête" --json   # 2. interroger le moteur
node UI/server.js                   # 3. ouvrir l'observatoire — http://127.0.0.1:4321
```

Sur un cerveau vide, l'index se construit sans erreur (0 fiche) : la base se remplit quand
vous déposez des sources dans `raw/` et lancez l'ingestion. Pour brancher les hooks, les
skills, la capture de session et les routines : voir **[`docs/INTEGRATION.md`](docs/INTEGRATION.md)**.

## Les trois idées

1. **Ce qui est brut reste brut.** `raw/` est un dépôt en lecture seule. Rien n'y est
   corrigé, renommé ni supprimé. C'est la seule zone dont on peut dire qu'elle n'a pas été
   réécrite.
2. **Ce qui est su est distillé.** `wiki/` appartient à l'agent : des fiches atomiques, cinq
   types stricts, un frontmatter obligatoire, un index qui tient sur 200 lignes.
3. **On ne cherche pas, on interroge.** `brain.js` est un moteur BM25F en Node pur. Il rend
   des chemins, des numéros de ligne et des extraits de 240 caractères. Une section médiane
   coûte quelques centaines de tokens, le fichier qui la contient dix fois plus. C'est là
   que se fait l'économie.

Et une garantie : un **hook** interroge le moteur avant chaque message, un second **retient**
la recherche web tant que la base locale n'a pas répondu. `CLAUDE.md` et les skills ne sont
que du contexte — ils augmentent la probabilité ; seuls les hooks garantissent.

## La structure des dossiers

| Chemin | Rôle |
|---|---|
| `brain.js` | le moteur BM25F et sa CLI (indexation, recherche, lint, drafts/promote…) |
| `brain.config.json` | déclaration des sources indexées (voir « sources fédérées » plus bas) |
| `brain.test.mjs` | tests du moteur (`node --test brain.test.mjs`) |
| `CLAUDE.md` | le manuel opératoire, chargé à chaque session — sous 200 lignes |
| `DESIGN.md` | le contrat technique entre composants — normatif |
| `raw/` | le dépôt brut, immuable (dont `raw/sessions/` pour les captures automatiques) |
| `wiki/` | les fiches distillées — `index.md`, `log.md`, `processed.md`, `_templates/` |
| `outputs/` | les livrables produits (indexés, pondérés ×0,7) |
| `.claude/` | `settings.json` (hooks), `hooks/`, `skills/` (brain, ingest, dream), `rules/` |
| `routines/` | l'indexation nocturne (launchd) et la Dream Sequence (consolidation) |
| `UI/` | l'observatoire 4 couches (`node UI/server.js`) |
| `docs/` | la vision d'origine et le guide d'intégration |
| `tools/` | `capture-session.js` — capture automatique des sessions dans `raw/sessions/` |
| `.design/` | `proto3.mjs` — prototype de validation du moteur (BM25F + chaîne FR) |

## Les quatre couches de l'observatoire

`node UI/server.js` sert une console qui montre l'agent comme un système d'exploitation :

- **Applications** (bleu) — les serveurs MCP que l'agent peut atteindre. Chaque serveur
  porte une pastille de risque, avec un **défaut pessimiste** : « inconnu », jamais « sans
  risque ». La politique de risque locale (`UI/mcp-risk.json`) prime sur ce qu'un serveur
  déclare de lui-même. **Éditez `UI/mcp-risk.json` pour y déclarer VOS serveurs** (le fichier
  livré ne contient que des exemples génériques).
- **Routines** (jaune) — ce qui tourne sans qu'on le demande : l'indexation nocturne (sans
  modèle, coût nul) et la Dream Sequence (avec modèle, livrée inerte).
- **Memory** (vert) — le second cerveau lui-même : `raw/` → `wiki/` → `outputs/`, le graphe
  de wikiliens, les orphelines, les liens cassés.
- **Skills** (violet) — les procédures que l'agent sait exécuter : `brain` (chercher),
  `ingest` (distiller), `dream` (consolider).

L'observatoire lit et écrit **uniquement en local** (bind `127.0.0.1`, jeton de session,
chemins confinés aux racines déclarées). Voir le modèle de menace en tête de `UI/server.js`.

## Ajouter ses propres sources fédérées

`brain.js` peut indexer, **en lecture**, d'autres dossiers que le vôtre (une base technique,
une base métier, des notes existantes…). Il suffit d'ajouter une entrée dans la liste
`sources` de `brain.config.json`, avec un `root` (relatif à la racine du dépôt) et les
sous-dossiers à indexer. Exemple d'une source fédérée supplémentaire :

```json
{
  "sources": [
    { "id": "kb", "label": "Knowledge Base", "color": "#4ade80",
      "root": ".", "distilled": ["wiki"], "raw": ["raw"], "outputs": ["outputs"] },

    { "id": "notes", "label": "Mes notes existantes", "color": "#60a5fa",
      "root": "../mes-notes",
      "distilled": ["fiches", "INDEX.md"],
      "raw": ["sources"] }
  ],
  "context": {
    "kb/wiki/":   "fiches distillées — canon si « statut: canon », brouillon sinon",
    "notes/fiches/": "mes notes distillées, en lecture seule"
  }
}
```

- `root` : dossier racine de la source (relatif à `brain.config.json`).
- `distilled` / `raw` / `outputs` : les sous-dossiers à indexer, par zone.
- `context` : pour chaque préfixe `<id>/<chemin>`, une phrase qui dit ce que ce dossier EST.
  Elle apparaît dans chaque résultat de recherche — l'agent arbitre sans ouvrir le fichier.
- Ensuite : `node brain.js search "…" --source notes` restreint la recherche à cette source.

Une source déclarée mais introuvable ne fait pas planter le moteur : `index` le signale et
`search` le déclare dans sa sortie JSON.

## Documentation

- **[`docs/vision.md`](docs/vision.md)** — la vision et la philosophie d'origine.
- **[`docs/INTEGRATION.md`](docs/INTEGRATION.md)** — le guide pas-à-pas pour brancher l'outil
  dans Claude Code : hooks, capture de session, skills, rythme d'usage, observatoire.
- **`DESIGN.md`** — le contrat technique normatif entre les composants.
- **`CLAUDE.md`** — le manuel opératoire que Claude charge à chaque session.

## Crédits et inspirations

Le motif de fond — `raw/` immuable, `wiki/` possédé par le modèle, un schéma dans `CLAUDE.md`,
un `index.md` orienté contenu, un `log.md` chronologique, et les trois workflows
**ingest / query / lint** — vient du pattern **« LLM Wiki »** partagé par **Andrej Karpathy**
(gist `llm-wiki.md`, 2026). Le vocabulaire est repris délibérément, pour rester compatible
avec cet écosystème.

Ce qui a été **ajouté par-dessus, et n'est PAS de Karpathy** :

- **`brain.js`** — le moteur BM25F, sa chaîne de normalisation française, le chunking par
  sections, le garde-fou `confidence: low` : spécifique à ce dépôt.
- **La Dream Sequence** — routine de consolidation en quatre phases (ORIENT / GATHER /
  CONSOLIDATE / PRUNE), cascade de portes, verrou, rollback : une extension maison, pas une
  routine décrite par le gist.
- **L'observatoire 4 couches** — la console de visualisation : une pièce maison, sans
  équivalent connu.
- **La boucle de relecture `draft` → `canon`** et la taxonomie temporelle
  (`timeless` / `as of AAAA-MM` / `pointer`) : reprises des implémentations communautaires du
  motif et durcies ici.
- **Les hooks** (`UserPromptSubmit`, `PreToolUse`, `SessionStart`) suivent la documentation
  officielle de Claude Code.

## Licence

MIT — voir [`LICENSE`](LICENSE). © 2026 Pangos.
