---
name: brain
description: Interroge le second cerveau local (moteur brain.js, BM25F sur wiki/, raw/ et les sources fédérées éventuelles) pour retrouver ce que l'utilisateur sait déjà, avant tout Grep, Read exploratoire ou recherche web. À utiliser dès que la question porte sur des connaissances déjà accumulées : « qu'est-ce que je sais sur… », « retrouve mes notes sur… », « cherche dans le second cerveau », « on en avait parlé où ? », « j'ai déjà une fiche là-dessus ? », « qu'est-ce que disait tel auteur / telle méthode sur… », ou quand il faut vérifier qu'une information n'est pas déjà en base avant d'aller la chercher ailleurs.
allowed-tools: Bash(node brain.js *), Bash(node ${CLAUDE_SKILL_DIR}/../../../brain.js *), Read, Glob, Grep
---

# Interroger le second cerveau

État de l'index à cet instant :
!`node brain.js stats --short 2>/dev/null || echo "index indisponible — lancer : node brain.js index"`

Toutes les commandes se lancent depuis `knowledge_base/`.

## La séquence, dans l'ordre

1. **`wiki/index.md`** d'abord si la question nomme un thème connu. C'est la carte : une ligne par fiche.
2. **`node brain.js search "<termes>" --json --k 5`** — le moteur. Termes en langage naturel,
   le moteur normalise (accents, élisions, pluriels, mots composés) lui-même.
3. **`node brain.js show <fichier>#<ligne>`** sur les 2 ou 3 sections retenues, ou `Read` avec les
   `offset`/`limit` que le moteur a donnés. Jamais le fichier entier : la section médiane fait
   environ 245 tokens, le fichier entier entre 8 000 et 11 000.
4. Réponse **citant chaque fiche par son chemin**, pour que l'utilisateur puisse vérifier.

## Lire la sortie

- `line_start` / `line_end` : l'identifiant léger. C'est ce qui permet d'ouvrir juste ce qu'il faut.
- `score` : comparatif, pas absolu. Un écart faible entre le 1er et le 5e signale une requête floue.
- `confidence: "low"` : **le moteur admet qu'il ne sait pas.** Ne pas maquiller ses résultats en
  réponse. Reformuler la requête, ou passer à `--raw`, puis au web en le disant explicitement.
- `snippet` : 240 caractères, termes encadrés de `**`. C'est un repère, pas une citation.

## Les options qui servent vraiment

| Option | Quand |
|---|---|
| `--k 10` | la requête est large et on veut balayer |
| `--per-file 4` | une seule fiche semble contenir toute la réponse, on veut l'ouvrir à fond |
| `--source <id>` | on sait dans quelle base chercher |
| `--raw` | rien dans les fiches distillées ; on descend dans le dépôt brut |
| `--expand` | ajoute les voisins du graphe de wikiliens, utile pour cartographier un sujet |
| `--full` | le texte des sections ; **seulement après avoir arbitré**, jamais en première passe |

Autour du moteur : `node brain.js outline <fichier>` (sommaire d'un fichier, coût quasi nul,
idéal avant de décider quoi lire) et `node brain.js related <fichier> --depth 2` (voisinage).

## Si la base ne sait rien

Le dire. « Rien dans la base locale sur X » est une réponse utile : elle signale une lacune,
et souvent le bon geste suivant est de déposer une source dans `raw/` puis de lancer la
skill `ingest`. Ne jamais combler un silence de la base par une reconstitution de mémoire
présentée comme une fiche.

## Après une recherche qui a demandé du travail

Si la réponse a exigé de croiser plusieurs fiches et qu'elle resservira, proposer à l'utilisateur de
la figer en fiche `type: qa` (`wiki/_templates/qa.md`, `statut: draft`). Une question déjà
résolue ne doit pas être re-résolue. Journaliser dans `wiki/log.md` :
`## [YYYY-MM-DD] query | <question>`.
