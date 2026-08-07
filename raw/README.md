# `raw/` — zone de dépôt

Déposer ici les contenus bruts : articles, PDF convertis, transcriptions, notes, listes de
liens (`.md` avec URLs). C'est aussi ici que le hook `SessionEnd` dépose ses captures de
session, dans `raw/sessions/` (voir `docs/INTEGRATION.md`).

## Règles

- **Immuable.** L'agent le lit, ne l'écrit **jamais** : pas d'édition, pas de renommage, pas
  de suppression, pas de correction de coquille. Une source fautive se corrige par une fiche
  de `wiki/` qui la contredit et la cite. C'est ce qui rend le registre par hash fiable.
- **Dernier recours en lecture.** Ordre imposé : `wiki/index.md` → `node brain.js search` →
  fiches ciblées → `raw/`. Le contenu utile de ce dossier a vocation à être distillé dans `wiki/`.
- **Tout fichier dont le SHA-1 est absent de `wiki/processed.md` est « à ingérer ».**
  Vérifier avec `shasum -a 1 raw/<fichier>` : une source redéposée sous un autre nom garde
  son hash et ne sera pas ingérée deux fois.
- **Nommage** : `AAAAMMJJ-sujet.ext`. La date est celle du **dépôt**. La date du **contenu**
  vit dans le frontmatter de la fiche `source-summary`, en `temporalite`.

## Ingérer

Ouvrir une session Claude Code à la racine du second cerveau et demander l'ingestion (skill
`ingest`). Elle discute les points clés avant d'écrire, propage vers les 10 à 15 fiches
concernées, écrit en `statut: draft`, et présente un `git diff` à relire. La promotion en
`canon` reste une décision humaine.
