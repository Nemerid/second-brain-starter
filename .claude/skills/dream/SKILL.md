---
name: dream
description: Consolide le wiki en quatre phases (ORIENT, GATHER, CONSOLIDATE, PRUNE) — fusionne les doublons, convertit les dates relatives en dates absolues, supprime à la source les faits contredits, matérialise les contradictions en callouts, et ramène wiki/index.md sous son plafond. À utiliser quand l'utilisateur dit « lance la dream sequence », « /dream », « consolide le wiki », « fais le ménage dans les fiches », « range la base », « l'index est trop long », ou après une série d'ingestions qui a laissé des redites.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Dream Sequence — consolidation du wiki

Routine de rangement. Elle ne crée pas de connaissance neuve : elle range, recoud et élague
ce qui existe déjà. Documentation complète de la routine : `routines/dream-sequence.md`.

## Règles qui tiennent pour les quatre phases

- **Outils : `Read`, `Write`, `Edit`, `Glob`, `Grep`. Rien d'autre.** Pas de shell, pas de réseau,
  aucune suppression de fichier. Une consolidation ne doit jamais pouvoir casser autre chose
  que ce qu'elle édite, et toujours de façon rattrapable par `git checkout`.
- **Ne lis pas exhaustivement. Ne cherche que ce que tu soupçonnes déjà d'importer.**
  C'est la règle centrale : lire tout le wiki à chaque passe coûte cher, sature le contexte
  et produit des fusions hasardeuses.
- **Écriture en `statut: draft`.** Toute fiche touchée repasse en `draft` et voit son `modified`
  mis à jour. Seule une validation humaine, ou une revue de diff explicite, promeut en `canon`.
- **ESTAMPILLE OBLIGATOIRE.** Toute fiche écrite ou réécrite par cette routine porte, dans son
  frontmatter et sans exception :

  ```yaml
  dream: true
  dream_date: 2026-08-07     # la date du cycle, absolue
  ```

  `statut: draft` dit que la fiche n'est pas validée ; `dream: true` dit qu'elle a été écrite
  par la MACHINE. Ce n'est pas la même information, et c'est la seconde qui protège :
  sans elle, le cycle suivant re-digère sa propre production et dérive — chaque passe
  s'appuyant sur la précédente jusqu'à ce que plus rien ne remonte à une source.
  Une fiche estampillée n'est jamais une source pour un cycle ultérieur : ses `sources:`
  font foi, pas elle. `node brain.js lint` signale les manquements (rubrique
  « Estampilles Dream Sequence » : estampille sans date, fiche rêvée promue en `canon`,
  fiche qui se source sur une fiche rêvée).
- **DEUX ZONES : le haut se réécrit, le fil s'allonge.** Toute fiche a une zone haute
  (`## État`, puis les sections de fond) et une zone basse `## Fil de preuves`. Cette routine
  **RÉÉCRIT le haut** autant qu'il le faut, et **N'AJOUTE que des lignes au fil**, au format
  `- [2026-08-07] fait — [[source]]`. Elle ne corrige aucune ligne de fil déjà écrite, n'en
  supprime aucune, n'en réordonne aucune. C'est la contrepartie exacte du geste « supprimer
  les faits contredits à la source » de la phase CONSOLIDATE : le fait faux disparaît du
  HAUT, et une ligne datée du FIL dit qu'il a été démenti et par quoi. Sans le fil, ce geste
  détruirait la trace ; sans le geste, le haut deviendrait illisible. Format complet :
  `.claude/rules/fiches.md`.
- **Jamais de fusion silencieuse.** Deux sources qui divergent restent deux voix citées.
- **`raw/` reste immuable.** On le lit, jamais on ne l'écrit.
- **Rendre compte.** Une entrée `## [YYYY-MM-DD] consolidate | <résumé>` dans `wiki/log.md`,
  listant les fiches touchées, les fusions faites et les faits supprimés.

## Phase 1 — ORIENT

Lire `wiki/index.md`, puis les entrées de `wiki/log.md` depuis la dernière ligne
`consolidate`. Rien d'autre.

Objectif : savoir ce qui a bougé et ne pas refaire le travail de la passe précédente.
Sortie de la phase : une liste courte de **signaux suspectés** — titres qui se ressemblent,
thèmes touchés par plusieurs ingestions récentes, fiches citées nulle part, index qui gonfle.

Si aucun signal : s'arrêter là et le dire. Une Dream Sequence qui ne trouve rien est un
succès, pas un échec.

## Phase 2 — GATHER (borné)

Pour chaque signal, et pour lui seul :

- `Grep` avec un motif précis et `-n`, jamais un motif large sur tout le wiki ;
- `Glob` sur le sous-dossier concerné, pas sur `wiki/**` entier ;
- `Read` avec `offset`/`limit` sur les passages que le grep a désignés.

Interdits : lire une fiche entière « pour voir », parcourir tout `wiki/`, ouvrir `raw/`
pour recouper (la source fait foi via le champ `sources`, pas via une relecture).

Sortie de la phase : pour chaque signal, les chemins et les numéros de ligne exacts en jeu.

## Phase 3 — CONSOLIDATE

Quatre gestes, et rien d'autre.

**Fusionner les doublons.** Deux fiches qui disent la même chose : garder la plus ancienne
(son chemin est déjà cité ailleurs), y verser ce que l'autre apporte, remplacer l'autre par
un renvoi `[[fiche-gardée]]` et corriger les wikiliens entrants. Ne jamais supprimer un
fichier : le réduire à un renvoi.

**Absolutiser les dates.** « le mois dernier », « récemment », « il y a deux semaines » →
`2026-07`, `2026-08-07`. Recalculer à partir du `modified` de la fiche, pas de la date du jour.
Renseigner `temporalite` : `timeless`, `"as of 2026-08"`, ou `pointer`.

**Supprimer les faits contredits À LA SOURCE.** Quand une information est démentie par une
source plus récente, l'énoncé faux ne se laisse pas traîner en note de bas de page : il
disparaît de la ZONE HAUTE de la fiche, à l'endroit exact où il vivait. Sinon il reste
indexé, remonte dans `brain.js search`, et redevient une autorité citée par la prochaine
ingestion. En contrepartie obligatoire, une ligne s'AJOUTE au `## Fil de preuves` :
`- [2026-08-07] <l'énoncé retiré> démenti par <quoi> — [[source]]`. Et consigner ce qui a
été retiré dans l'entrée de `wiki/log.md`.

**Matérialiser les contradictions non tranchables.** Quand les deux sources se valent et
qu'aucune ne prime, ne pas arbitrer :

```markdown
> [!WARNING] Contradiction non tranchée
> `raw/20260612-conference.md` affirme que X.
> `raw/20260807-article.md` affirme que non-X.
> Aucune des deux ne prime : à trancher par l'utilisateur.
```

## Phase 4 — PRUNE

`wiki/index.md` doit rester **sous 200 lignes et 25 Ko** — c'est la limite dure de chargement
d'un fichier mémoire, et un index au-delà n'est plus lu en entier.

Dans l'ordre : réduire chaque fiche à **une ligne** ; regrouper les fiches d'un même thème
sous une fiche `overview` qui les chapeaute, et ne laisser dans l'index que l'overview ;
retirer les entrées pointant vers des fiches devenues de simples renvois.

Si l'index reste au-dessus du seuil après ces trois gestes : **échouer bruyamment.** Le dire
en clair à l'utilisateur, avec le compte de lignes et d'octets, plutôt que de tronquer l'index. Un
index tronqué en silence est une perte de mémoire invisible.

## Compte rendu attendu

Six lignes maximum : signaux repérés en ORIENT, fiches lues en GATHER, fusions faites, dates
absolutisées, faits supprimés (avec leur chemin), état de l'index avant et après. Puis
rappeler que tout est en `draft` et attend une revue de diff.
