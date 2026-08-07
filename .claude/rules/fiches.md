---
description: Format obligatoire des fiches du wiki — chargé seulement quand une fiche de wiki/ est touchée.
paths: ["wiki/**/*.md"]
---

# Tu viens d'ouvrir une fiche du wiki

Ces fiches sont écrites **pour la machine**, pas pour l'humain : c'est l'UI 4 couches qui
sert la lisibilité. Le markdown, lui, est optimisé pour la récupération par `brain.js`.

## Frontmatter — obligatoire, aucun champ facultatif

```yaml
---
type: overview | topic | entity | source-summary | qa
titre: Titre lisible de la fiche
modified: 2026-08-07T12:00:00+02:00
statut: draft | canon
tags: [prospection, objection, prix]
sources: ["raw/20260807-article.md"]
temporalite: timeless | "as of 2026-08" | pointer
---
```

- `type` : cinq valeurs, et cinq seulement. Il décide de l'emplacement, du gabarit et des
  champs. Gabarits dans `wiki/_templates/`.
- `modified` : ISO 8601 avec fuseau. À remettre à jour à **chaque** édition, sans exception —
  `brain.js lint` alerte sur les fiches sans `modified` depuis 90 jours.
- `statut` : une fiche naît en `draft`. **Seule une validation humaine promeut en `canon`.**
  Ne jamais s'auto-promouvoir : le sas est le garde-fou contre la composition des
  hallucinations, où un fait faux devient une autorité citée par les ingestions suivantes.
- `temporalite` : `timeless` (vrai hors du temps), `"as of 2026-08"` (vrai à cette date, à
  revoir), `pointer` (la fiche renvoie à une source vivante plutôt que d'en copier l'état).

## Corps

**Préambule obligatoire, en tête, juste après le frontmatter :**

```markdown
## Pour le futur Claude

Ouvrir cette fiche quand … Elle répond à … Elle ne couvre pas … (voir [[autre-fiche]]).
```

Deux à trois lignes. C'est ce qui, six mois plus tard, évite de rouvrir cinq fiches pour
trouver la bonne.

## Deux zones, et une seule règle

Une fiche a un HAUT et un BAS, et ils n'obéissent pas à la même loi.

| Zone | Ce que c'est | Ce qu'on a le droit d'y faire |
|---|---|---|
| **Le haut** (`## État`, puis les sections de fond) | la vérité compilée : ce qu'on tient pour vrai **aujourd'hui** | **RÉÉCRIRE** entièrement dès qu'une preuve la contredit ou la complète |
| **`## Fil de preuves`** (dernier, avant `## Fiches liées`) | la preuve datée et sourcée | **AJOUTER** une ligne, jamais corriger ni supprimer celles déjà écrites |

Format d'une ligne de fil, à la ligne près :

```markdown
- [2026-08-07] le prospect a objecté sur le délai, pas sur le prix — [[raw/20260807-tournee.md]]
- [2026-08-07] tarif 2025 démenti par la nouvelle grille — [grille publique](https://…)
```

Source **interne** en wikilien (elle alimente le graphe), source **externe** en lien markdown.
Date absolue entre crochets, en tête : le fil se trie et se lit sans parseur.

**Pourquoi.** Sans cette séparation, comprendre une entité demande de lire deux cents entrées
et la réponse est enterrée à la 147e ; ou bien la consolidation réécrit tout et efface une
observation de terrain que personne ne retrouvera. Avec elle, l'état se lit en trente secondes
et le fil reste opposable. Le patron n'est pas théorique : c'est celui du **journal de
tournée** de l'utilisateur — constat à chaud en bas, leçon consolidée en tête — qui a été trouvé sur
le terrain avant d'être trouvé dans la littérature.

**Un fait démenti ne s'efface JAMAIS du fil.** Il disparaît du haut (à l'endroit exact où il
vivait, sinon il reste indexé et remonte dans `brain.js search`), et une nouvelle ligne datée
dit qu'il a été démenti et par quoi. Effacer une ligne de fil, c'est effacer la preuve —
et le dossier est en git, donc ça se voit.

`node brain.js lint` signale les fiches `entity` et `topic` sans `## Fil de preuves`
(rubrique « Fiches sans fil de preuves »). C'est un AVERTISSEMENT, pas un échec : les fiches
écrites avant cette règle restent valides et se convertissent au fil de l'eau.

Ensuite :

- **Une fiche = une idée.** Si elle traite deux sujets, elle en fait deux.
- **Titres de section explicites** : ils pèsent ×4 dans le score BM25F. « Répondre sans
  baisser le prix » vaut mieux que « Détails ».
- **Dates absolues, toujours.** Jamais « le mois dernier », « récemment », « il y a deux
  semaines » : `2026-07`, `2026-08-07`. Une date relative devient fausse en silence.
- **Wikiliens `[[cible]]`, `[[cible#ancre]]`, `[[cible|alias]]`.** L'alias et l'ancre sont
  indexés comme texte d'ancrage de la fiche CIBLE : les rédiger comme une description, pas
  comme « ici » ou « voir aussi ».
- **Contradictions : jamais d'arbitrage silencieux.**

```markdown
> [!WARNING] Contradiction non tranchée
> `raw/20260612-conference.md` affirme que X.
> `raw/20260807-article.md` affirme que non-X.
> Aucune des deux ne prime : à trancher par l'utilisateur.
```

- Une section de moins de 200 caractères est fusionnée dans son parent par l'indexeur : ne pas
  multiplier les micro-sections. Une section de plus de 3 000 caractères est scindée : couper
  soi-même, au bon endroit, plutôt que de laisser la machine couper au hasard.
- Les blocs de type « Fiches liées », presque uniquement composés de wikiliens, sont exclus de
  l'index et versés au graphe seulement. C'est voulu : ne pas y mettre de contenu.

## Après avoir édité une fiche

`modified` à jour, ligne correspondante dans `wiki/index.md` (une seule ligne, l'index reste
sous 200 lignes et 25 Ko), entrée dans `wiki/log.md` au format
`## [YYYY-MM-DD] ingest|query|lint|consolidate | Titre`, puis `node brain.js index` et
`node brain.js lint`.
