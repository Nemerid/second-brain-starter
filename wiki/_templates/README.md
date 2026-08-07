# `wiki/_templates/` — les cinq gabarits de fiche

Cinq types stricts, et cinq seulement. Le type décide du gabarit, des champs du frontmatter
et de la place de la fiche dans le wiki. C'est cette contrainte qui rend le lint et la
déduplication mécaniques — des fiches libres ne se contrôlent pas.

| Gabarit | Pour quoi | Question à laquelle il répond |
|---|---|---|
| `overview.md` | la carte d'un domaine | « qu'est-ce qu'il y a dans ce sujet, et par où commencer ? » |
| `topic.md` | une idée, un savoir-faire | « comment fait-on X ? » |
| `entity.md` | une personne, entreprise, outil, méthode, lieu | « que sait-on de Y ? » |
| `source-summary.md` | ce que dit UNE source, et ce qu'elle vaut | « que raconte cet article, et l'a-t-on cru ? » |
| `qa.md` | une réponse qui a coûté du travail | « on avait déjà tranché ça, non ? » |

## Usage

Copier le gabarit, renommer en `wiki/<slug>.md`, remplacer tous les `<...>`, supprimer les
blocs marqués « à supprimer si… » et les commentaires HTML qui ne servent plus. Ne jamais
laisser un `<...>` dans une fiche en production : il serait indexé tel quel.

Le préambule `## Pour le futur Claude` est **obligatoire** dans les cinq. Deux à trois
lignes : quand ouvrir la fiche, ce qu'elle répond, ce qu'elle ne couvre pas. C'est ce qui
évite d'ouvrir cinq fiches pour en trouver une.

Toute fiche naît en `statut: draft`. Seule une validation humaine, après revue du `git diff`,
la promeut en `canon`.

## Note pour l'indexeur

Ce dossier contient des gabarits, pas des fiches. Ses fichiers ne sont pas censés apparaître
dans `wiki/index.md`, et `brain.js lint` ne doit pas les compter comme orphelins ni comme
dérive d'index. Le préfixe `_` du dossier sert de marqueur.
