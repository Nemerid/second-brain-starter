# Dream Sequence — la routine de consolidation

> Ce document décrit la routine. La procédure que suit l'agent quand elle se déclenche vit
> dans la skill `.claude/skills/dream/SKILL.md`. Les deux se lisent ensemble : ici le *quand*
> et le *comment ne pas casser*, là-bas le *quoi faire*.

## À quoi ça sert

Un wiki alimenté par ingestions successives dérive de trois façons, toujours les mêmes :

1. **Les doublons.** Deux ingestions à trois semaines d'écart produisent deux fiches qui
   disent la même chose sous deux titres différents. Le moteur les remonte toutes les deux,
   l'agent lit les deux, et personne ne sait laquelle fait foi.
2. **Les faits périmés qui restent indexés.** Une information démentie mais laissée en place
   continue de sortir dans `brain.js search`, et redevient une autorité citée à l'ingestion
   suivante. C'est la **composition des hallucinations** : un fait faux se recopie tout seul.
3. **L'index qui gonfle.** `wiki/index.md` dépasse ses 200 lignes, n'est plus chargé en
   entier, et la carte cesse d'être une carte.

Aucun de ces trois problèmes n'est mécanique : `brain.js lint` les détecte, il ne les répare
pas. La réparation demande un modèle. C'est cette routine.

## Ce qu'elle n'est pas

Elle **ne crée aucune connaissance**. Elle ne va pas chercher de source, ne complète pas une
fiche par ce qu'elle sait, n'invente pas de lien. Elle range ce qui est là. Toute fiche
qu'elle touche repasse en `statut: draft` et attend une revue humaine.

## Les quatre phases

| Phase | Ce qu'elle fait | Ce qu'elle a le droit de lire |
|---|---|---|
| **ORIENT** | repérer les signaux depuis la dernière passe | `wiki/index.md`, `wiki/log.md` |
| **GATHER** | rassembler les preuves, **grep bornés** | seulement ce que les signaux désignent |
| **CONSOLIDATE** | fusionner, absolutiser les dates, supprimer les faits contredits **à la source**, poser les `> [!WARNING]` | les fiches désignées |
| **PRUNE** | ramener `wiki/index.md` sous 200 lignes et 25 Ko | `wiki/index.md` |

L'instruction centrale, à ne pas adoucir : **« ne lis pas exhaustivement, ne cherche que ce
que tu soupçonnes déjà d'importer »**. Une passe qui relit tout le wiki sature son contexte,
coûte cher, et produit des fusions hasardeuses parce qu'elle a tout vu et ne distingue plus.

Détail des quatre phases : `.claude/skills/dream/SKILL.md`.

## La cascade de portes, par coût croissant

Une passe de consolidation coûte quelques centimes et quelques minutes. La plupart des
déclenchements ne devraient rien coûter du tout, parce qu'il n'y a rien à faire. D'où une
cascade : chaque porte est plus chère que la précédente, et la première qui se ferme arrête
tout, avant d'avoir payé les suivantes.

| # | Porte | Coût | Passe si |
|---|---|---|---|
| 1 | **Drapeau d'armement** — `routines/.dream-enabled` existe | quasi nul | la routine a été armée explicitement par l'utilisateur |
| 2 | **Ancienneté** — `stat()` sur `routines/.dream-last` | un appel système | la dernière passe remonte à plus de 24 h |
| 3 | **Bridage mémoire** — compteur de passes du mois dans `.dream-last` | lecture d'un fichier | moins de 8 passes ce mois-ci |
| 4 | **Volume de matière** — `readdir` de `wiki/`, comparaison des `mtime` à `.dream-last` | un parcours de dossier | au moins 3 fiches ont bougé, ou `index.md` dépasse 180 lignes |
| 5 | **Verrou** — création exclusive de `routines/.dream-lock` | une écriture | aucune autre passe n'est en cours |
| 6 | **La passe** — les quatre phases | quelques centimes | — |

Les portes 1 à 4 sont mécaniques : elles ne demandent aucun modèle. Un déclencheur qui
s'arrête à la porte 2 n'a rien coûté.

## Le verrou

Fichier `routines/.dream-lock`, créé en **exclusion** (`fs.openSync(path, 'wx')`) : si le
fichier existe déjà, la création échoue, et c'est cet échec qui fait office de verrou. Pas de
« lire puis écrire », qui laisserait une fenêtre entre les deux.

Contenu : le PID, l'horodatage de prise, et la liste des fichiers que la passe va toucher —
c'est cette liste qui rend le rollback possible.

```
pid=48212
started=2026-08-07T03:12:04Z
files=wiki/ma-fiche.md,wiki/index.md,wiki/log.md
mtimes=1754531524000,1754530011000,1754529880000
```

**Reprise après mort.** Un verrou dont le PID ne tourne plus et qui a plus d'une heure est
considéré comme abandonné : la passe suivante le retire et reprend. Une heure, parce qu'une
passe normale dure quelques minutes et qu'un faux positif ferait tourner deux consolidations
en parallèle sur les mêmes fiches.

**Backoff après échec.** Une passe qui échoue écrit son échec dans `.dream-last` et interdit
toute nouvelle tentative pendant 6 h, puis 24 h, puis 72 h. Une routine qui échoue en boucle
ne doit pas échouer en boucle *vite*.

## Le rollback

Les `mtimes` enregistrés dans le verrou avant modification permettent de détecter, en fin de
passe, qu'un fichier a été touché par quelqu'un d'autre pendant la consolidation. Dans ce
cas : ne pas écrire, relâcher le verrou, ressortir avec le message « conflit d'écriture,
consolidation reportée ». La passe suivante repartira d'un état propre.

Objectif affiché, à ne jamais compromettre pour gagner en automatisation :

> **Le pire cas est une nouvelle tentative différée, jamais une corruption.**

En pratique, le vrai filet reste `git` : la Dream Sequence n'écrit que dans `wiki/`, qui est
versionné. Un `git diff` montre tout, un `git checkout -- wiki/` annule tout. C'est la raison
pour laquelle la skill `dream` n'a **ni shell, ni réseau, ni suppression de fichier** dans ses
`allowed-tools` : elle ne peut pas défaire ce que git peut refaire.

## Déclenchement

Par défaut : **manuel**, via la skill `/dream` dans une session ouverte dans `knowledge_base/`.
C'est le bon mode tant que le wiki tient sous la centaine de fiches — une passe par mois,
relue en deux minutes.

Automatisation possible, si le volume le justifie un jour :

- **Tâche planifiée Claude Desktop** (Routines → Local), qui invoque `/dream`. Elle ne tourne
  que si l'application est ouverte et la machine éveillée. Voir `routines/README.md`.
- **Hook `Stop`**, qui déclencherait la cascade à la fin de chaque session. Séduisant, mais à
  n'armer qu'après avoir vu plusieurs passes manuelles se comporter correctement : un hook
  `Stop` mal réglé consolide après *chaque* session, y compris celles où rien n'a bougé.
  Les portes 2 à 4 sont précisément là pour absorber ce cas.
- Sur un modèle rapide (Haiku) : une passe de quelques milliers de tokens coûte bien moins
  d'un centime. Réserver un gros modèle aux consolidations lourdes — la synthèse est
  justement ce que les petits modèles ratent.

**Armer** : créer `routines/.dream-enabled`. **Désarmer** : le supprimer. Rien d'autre.
Tant que ce fichier n'existe pas, la porte 1 est fermée et la routine est inerte.

## Après une passe

Une entrée dans `wiki/log.md` :

```
## [2026-08-07] consolidate | Fusion des fiches « objection prix »
- fusionnées : [[ma-fiche-doublon]] → [[ma-fiche]]
- faits supprimés : tarif 2024 (contredit par raw/20260807-tarifs.md), wiki/mon-offre.md:34
- dates absolutisées : 4 fiches
- index : 187 → 163 lignes
```

Puis, obligatoirement, **la revue du diff par l'utilisateur**. C'est lui qui promeut `draft` → `canon`.
Une consolidation qui s'auto-promeut réintroduit exactement le problème qu'elle prétend
résoudre.

## Fichiers de la routine

| Fichier | Rôle | Versionné ? |
|---|---|---|
| `routines/.dream-enabled` | drapeau d'armement (porte 1) | non |
| `routines/.dream-last` | horodatage, compteur mensuel, état de backoff | non |
| `routines/.dream-lock` | verrou de passe, PID, mtimes de rollback | non |
| `.claude/skills/dream/SKILL.md` | la procédure suivie par l'agent | oui |
| `routines/dream-sequence.md` | ce document | oui |
