---
description: Règles d'usage du dépôt brut raw/ — chargées seulement quand un fichier de raw/ est touché.
paths: ["raw/**"]
---

# Tu viens d'ouvrir un fichier de `raw/`

**`raw/` est immuable.** Lecture seule, sans exception : jamais d'écriture, jamais de
renommage, jamais de suppression, jamais de « petite correction de coquille ». Une source
fautive se corrige par une fiche de `wiki/` qui la contredit et la cite, pas par une retouche
de la source. C'est ce qui rend le registre par hash de `wiki/processed.md` fiable.

**`raw/` est le dernier recours en lecture**, pas le premier réflexe. Ordre imposé :
`wiki/index.md` → `node brain.js search "<termes>"` → fiches ciblées → `raw/`. Si tu es ici
sans être passé par le moteur, tu es probablement en train de payer 10 000 tokens pour une
information qui tenait dans une section de 245 tokens.

## Avant de distiller

1. `shasum -a 1 raw/<fichier>` puis chercher ce SHA-1 dans `wiki/processed.md`. S'il y est,
   la source est déjà ingérée — même redéposée sous un autre nom. S'arrêter et le dire.
2. Sinon, la skill `ingest` porte la procédure complète. Ses points non négociables :
   - **discuter les points clés avec l'utilisateur AVANT d'écrire quoi que ce soit** ;
   - **propager vers 10 à 15 fiches**, pas une seule ;
   - écrire en `statut: draft` sur les gabarits de `wiki/_templates/` ;
   - tenir `wiki/index.md`, `wiki/processed.md` et `wiki/log.md` ;
   - **revue de `git diff` par l'utilisateur avant tout commit**, et lui seul promeut en `canon`.

## Format des lignes de registre

```
wiki/processed.md : - 2026-08-07 — sha1:a1b2c3d4e5 — raw/20260807-article.md — fiches : [[a]], [[b]]
wiki/log.md       : ## [2026-08-07] ingest | Titre court
```

Ces deux formats sont lus par `brain.js lint` sans LLM. Une ligne mal formée est une ligne
invisible : elle fera croire à une source jamais ingérée, et provoquera un doublon.

## Nommage des dépôts

`YYYYMMDD-sujet.ext`. La date est celle du dépôt, pas celle du contenu ; la date du contenu
vit dans le frontmatter de la fiche `source-summary`, en `temporalite`.
