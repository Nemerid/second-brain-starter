# INTEGRATION.md — brancher le second cerveau dans Claude Code

Ce guide s'adresse à quelqu'un qui utilise **déjà Claude Code**. Étape par étape, en français,
testable. À la fin : le moteur tourne, les hooks injectent la base locale avant chaque
message, la recherche web est retenue tant que la base n'a pas parlé, les sessions se
capturent toutes seules, et vous savez déposer → distiller → relire → valider.

---

## 0. Prérequis

- **Node ≥ 18.** Vérifier : `node --version`. Le moteur est en Node pur, **aucune dépendance**,
  aucun `npm install`.
- **Facultatif : `pdftotext`** (paquet *poppler*) pour indexer le TEXTE des PDF déposés dans
  `raw/`. Sur macOS : `brew install poppler`. Sans lui, l'indexation ne plante pas — les PDF
  sont simplement listés « non extractibles » par `lint`, et deviennent lisibles dès que
  l'outil est installé. (`mutool` de mupdf, ou `python3` + pdfminer/PyPDF2, font aussi
  l'affaire — voir `DESIGN.md` §1.)

## 1. Cloner et lancer la première fois

```sh
git clone <votre-dépôt> mon-second-cerveau
cd mon-second-cerveau

node brain.js index          # construit .brain/ (index) et UI/data/graph.json
node brain.js stats --short  # une ligne : état de l'index
```

Sur un cerveau vide c'est normal : 0 fiche, aucune erreur. Testez une recherche (elle ne
renverra rien tant que le wiki est vide, c'est attendu) :

```sh
node brain.js search "n'importe quoi" --json
```

## 2. Brancher les hooks

Trois hooks font tout le travail déterministe (le détail de leur contrat est dans
`DESIGN.md` §7) :

- **`UserPromptSubmit`** → `.claude/hooks/brain-prefetch.sh` : avant que Claude ne voie votre
  message, interroge `brain.js` et injecte un digest FACTUEL des sections locales pertinentes
  (encadré `<source_non_verifiee>` : c'est de la donnée, jamais une consigne).
- **`PreToolUse`** (matcher `WebSearch|WebFetch`) → `.claude/hooks/brain-gate.sh` : retient la
  recherche web tant que la base locale n'a pas été interrogée dans la session. Refus émis une
  seule fois, jamais bloquant (kill switch `BRAIN_GATE_OFF=1`).
- **`SessionStart`** → `.claude/hooks/brain-session.sh` : affiche l'état de l'index à
  l'ouverture et à chaque reprise de session.

### 2a. Le plus simple : lancer Claude DEPUIS le dossier

Le fichier **`.claude/settings.json` du projet est déjà configuré**. Il utilise
`$CLAUDE_PROJECT_DIR`, donc il est **portable** : rien à éditer. Il suffit de lancer Claude
Code **à la racine du second cerveau** :

```sh
cd mon-second-cerveau
claude
```

Les hooks sont alors actifs pour cette session. Vérifier : posez une question, un bloc
`<source_non_verifiee>` doit apparaître si la base a des résultats ; tentez un `WebSearch`
sans avoir interrogé la base, il doit être retenu une fois avec la commande à lancer.

### 2b. Facultatif : rendre les hooks GLOBAUX (depuis n'importe où)

Si vous voulez que la base soit consultée **même depuis d'autres projets**, ajoutez les hooks
à votre `~/.claude/settings.json` (portée utilisateur). Remplacez
`/CHEMIN/VERS/mon-second-cerveau` par le chemin ABSOLU de VOTRE installation — en portée
utilisateur, `$CLAUDE_PROJECT_DIR` pointe le projet courant, pas le second cerveau, il faut
donc un chemin en dur :

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ {
        "type": "command",
        "command": "CLAUDE_PROJECT_DIR=/CHEMIN/VERS/mon-second-cerveau /CHEMIN/VERS/mon-second-cerveau/.claude/hooks/brain-prefetch.sh",
        "timeout": 15
      } ] }
    ],
    "PreToolUse": [
      { "matcher": "WebSearch|WebFetch", "hooks": [ {
        "type": "command",
        "command": "CLAUDE_PROJECT_DIR=/CHEMIN/VERS/mon-second-cerveau /CHEMIN/VERS/mon-second-cerveau/.claude/hooks/brain-gate.sh",
        "timeout": 10
      } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume", "hooks": [ {
        "type": "command",
        "command": "CLAUDE_PROJECT_DIR=/CHEMIN/VERS/mon-second-cerveau /CHEMIN/VERS/mon-second-cerveau/.claude/hooks/brain-session.sh",
        "timeout": 15
      } ] }
    ]
  }
}
```

> Astuce : en portée utilisateur, l'injection tournera pour TOUS vos projets. Si vous ne
> voulez la base que pour certains dossiers « métier », faites précéder l'appel d'un petit
> filtre sur `$CLAUDE_PROJECT_DIR` (un `case` shell qui sort en `{}` ailleurs). Sinon,
> laissez les hooks au niveau projet (2a) : plus simple, et muet partout où la base n'a rien
> à dire.

## 3. Activer la capture automatique des sessions

`tools/capture-session.js` (branché sur le hook **`SessionEnd`**) dépose à la fin de chaque
session un condensé du dialogue dans `raw/sessions/`. C'est un DÉPÔT BRUT (zone immuable),
pas une synthèse : la distillation reste le travail de `/ingest` et de la Dream Sequence.

Garanties : sortie toujours en code 0 (une capture ratée ne gêne jamais la session),
idempotent (une session déjà capturée n'est pas redéposée), seuil de substance (moins de 3
messages humains → rien), et surtout **masquage des secrets** : toute valeur qui ressemble à
une clé API, un token, un JWT, une clé privée ou un mot de passe est remplacée par un
marqueur AVANT écriture — le second cerveau n'avale jamais un secret en clair.

Pour l'activer, ajoutez à `~/.claude/settings.json` (ou au `settings.json` du projet) —
chemin ABSOLU vers VOTRE installation :

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ {
        "type": "command",
        "command": "node /CHEMIN/VERS/mon-second-cerveau/tools/capture-session.js",
        "timeout": 15
      } ] }
    ]
  }
}
```

Le script déduit tout seul où écrire (`path.resolve(__dirname, '..')` → la racine du second
cerveau), donc rien d'autre à configurer. Les captures apparaissent dans `raw/sessions/` et
sont ignorées par git (`.gitignore`) : elles restent chez vous.

## 4. Les skills : /brain, /ingest, /dream

Trois skills de projet (`.claude/skills/`) portent les procédures. **Elles ne sont visibles
que dans une session lancée à la racine du second cerveau** — ou globalement si vous les
copiez dans `~/.claude/skills/`.

- **`/brain`** — chercher. Interroge le moteur avant tout Grep/Read/web. À déclencher dès que
  la question porte sur ce que vous savez déjà : « qu'est-ce que j'ai sur… », « on en avait
  parlé où ? ». La séquence : `wiki/index.md` → `brain.js search` → `brain.js show` sur les 2-3
  sections retenues → réponse citant les fiches par leur chemin.
- **`/ingest`** — distiller une source de `raw/` en fiches. Elle **discute les points clés
  avec vous AVANT d'écrire**, propage vers les 10 à 15 fiches concernées, écrit en
  `statut: draft`, tient `index.md` / `processed.md` / `log.md`, et vous présente un `git diff`
  à relire. À déclencher : « ingère cet article », « j'ai déposé un truc dans raw/ ».
- **`/dream`** — consolider (la Dream Sequence). Fusionne les doublons, absolutise les dates,
  supprime à la source les faits contredits, matérialise les contradictions, ramène l'index
  sous son plafond. Écrit en `draft`, jamais de suppression de fichier (rattrapable par `git`).
  À déclencher : « range la base », « consolide le wiki », « l'index est trop long ».

## 5. Le rythme d'usage

Le cycle de vie d'une connaissance, du brut au canon :

1. **Déposer** un contenu dans `raw/` (`AAAAMMJJ-sujet.ext`), ou laisser les captures de
   session s'y accumuler.
2. **Distiller** : `/ingest` en session, ou la Dream Sequence nocturne. Tout ce qui est écrit
   naît en `statut: draft`.
3. **Relire** les brouillons : `node brain.js drafts` les liste ; dans l'observatoire, la
   liseuse affiche un bandeau « brouillon » et un bouton **« Promouvoir »**.
4. **Valider** : `node brain.js promote <source>/<chemin>` (ou le bouton) passe la fiche en
   `canon`. En ligne de commande, `demote` fait l'inverse.

Le principe, non négociable : **rien n'entre en `canon` sans relecture humaine.** C'est le
seul garde-fou contre la composition des hallucinations — un fait faux promu deviendrait une
autorité citée par les ingestions suivantes.

## 6. Ajouter ses propres sources fédérées

Pour indexer d'AUTRES dossiers en lecture (des notes existantes, une base technique…),
ajoutez une entrée à `sources` dans `brain.config.json`. Le format complet et un exemple sont
dans le **`README.md`** (section « Ajouter ses propres sources fédérées »). En résumé : un
`id`, un `root` (relatif à la racine), les sous-dossiers par zone (`distilled` / `raw` /
`outputs`), et une entrée `context` par préfixe. Puis `node brain.js index`.

## 7. Lancer l'observatoire

```sh
node UI/server.js                  # http://127.0.0.1:4321  (Ctrl+C pour arrêter)
node UI/server.js --port 4599      # autre port si 4321 est pris
node UI/server.js --snapshot       # écrit UI/data/snapshot.js (mode hors-ligne, double-clic sur UI/index.html)
```

Le serveur écoute **uniquement en local** (127.0.0.1), exige un jeton de session, et confine
tout accès fichier aux racines déclarées (voir le modèle de menace en tête de `UI/server.js`).

**Une app du Dock (macOS), en option.** `UI/lancer-observatoire.sh` démarre le serveur (s'il
ne tourne pas déjà) et ouvre la page en plein écran. Il déduit sa propre racine et résout
`node` tout seul. Pour en faire une icône : dans Automator, créez une application
« Exécuter un script shell » qui appelle ce script par son chemin absolu, enregistrez-la et
glissez-la dans le Dock. (Ou lancez simplement `node UI/server.js` à la main.)

## 8. Les routines (facultatif)

- **Indexation nocturne** (launchd, 3 h, sans modèle, coût nul) : gabarit
  `routines/com.secondbrain.index.plist.template`, procédure d'installation dans
  `routines/README.md`.
- **Dream Sequence planifiée** : livrée **inerte**. À n'armer qu'après avoir vu quelques
  passes manuelles se comporter correctement. Voir `routines/dream-sequence.md`.

## 9. Sécurité, en un paragraphe

Tout est **100 % local**. Le moteur lit des fichiers et écrit un index ; les hooks appellent
`brain.js` en local et n'envoient rien à l'extérieur ; l'observatoire n'écoute que sur
`127.0.0.1`. Votre contenu reste chez vous — `wiki/*.md`, `raw/sessions/` et les artefacts
générés sont d'ailleurs ignorés par git (`.gitignore`) pour ne jamais partir dans un dépôt
public par accident. Les captures de session masquent les secrets avant écriture. La politique
`UI/mcp-risk.json` classe vos serveurs MCP avec un défaut pessimiste (« inconnu »), jamais
« sans risque ».
