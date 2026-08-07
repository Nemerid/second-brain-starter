# `outputs/` — livrables produits

Les documents que l'agent a produits à partir du second cerveau : rapports, notes de
synthèse, PDF, plans. Contrairement à `wiki/`, ce n'est pas du savoir canonique mais un
**état passé** — ce qui a été rendu un jour donné.

## Ce que ce dossier est

- **Indexé, mais pondéré ×0,7.** `brain.js` indexe ces fichiers pour qu'on les retrouve, mais
  leur score est volontairement abaissé : un livrable n'est pas une source de vérité, c'est
  une photographie. La carte `context` de `brain.config.json` le rappelle dans chaque résultat.
- **Pas une zone de travail.** On y dépose des rendus finis. Le savoir durable, lui, vit dans
  `wiki/` sous forme de fiches ; le brut dans `raw/`.

Rien à installer : déposez vos livrables ici (ou laissez l'agent les y écrire) et ils
deviennent retrouvables par `node brain.js search`.
