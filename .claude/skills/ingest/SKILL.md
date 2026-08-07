---
name: ingest
description: Distille une source brute déposée dans raw/ (article, transcription, PDF converti, notes, liste de liens) en fiches wiki atomiques, en propageant vers toutes les fiches existantes qu'elle concerne. À utiliser dès que l'utilisateur dit « j'ai déposé un truc dans raw/ », « ingère cet article », « traite cette transcription », « ajoute ça au second cerveau », « distille cette vidéo », ou quand un fichier de raw/ est absent de wiki/processed.md et qu'il faut le traiter.
allowed-tools: Bash(node brain.js *), Bash(git diff*), Bash(git status*), Bash(shasum*), Read, Write, Edit, Glob, Grep
---

# Ingestion — de `raw/` vers `wiki/`

Une ingestion coûte cher et touche beaucoup de fiches. Elle se fait en sept étapes, dans
cet ordre, sans en sauter.

## 0. Vérifier que c'est bien à faire

```
node brain.js lint --json     # liste les fichiers de raw/ absents de processed.md
shasum -a 1 raw/<fichier>
```

Si le SHA-1 apparaît déjà dans `wiki/processed.md`, la source a déjà été ingérée, même sous
un autre nom : s'arrêter et le dire. C'est tout l'intérêt du registre par hash.

## 1. Lire la source, une seule fois, en entier

`raw/` est **immuable** : lecture seule, jamais d'écriture, jamais de renommage, jamais de
suppression. Une source fautive se corrige par une fiche qui la contredit.

## 2. DISCUTER LES POINTS CLÉS AVANT D'ÉCRIRE

IMPORTANT : c'est l'étape qui décide de la qualité de tout le reste. Ne rien écrire encore.
Présenter à l'utilisateur, en une liste courte :

- ce qui mérite une **fiche neuve** (et de quel type) ;
- ce qui **enrichit une fiche existante** (chemin de la fiche, ce qui change) ;
- ce qu'on **jette** (redite, actualité périssable, opinion sans portée) et pourquoi ;
- ce qui **contredit** une fiche existante — signalé comme tel, jamais fondu en silence.

Attendre son arbitrage. Une source ingérée sans cette discussion produit du bruit, et le
bruit se cite lui-même à l'ingestion suivante.

## 3. Chercher les fiches déjà concernées

Pour chaque point clé retenu :

```
node brain.js search "<point clé>" --json --k 8
node brain.js related <fiche> --depth 2
```

Un point clé qui ne ressort pas du premier coup se cherche par ANGLES, pas par
reformulations successives — les listes sont fusionnées et une fiche que chaque angle
classe 3e ou 4e remonte 1re :

```
printf 'lex: <angle 1>\nlex: <angle 2>\nlex: <angle 3>\n' | node brain.js search --query-file - --k 8
```

**Lire `creation_sure` avant de créer quoi que ce soit** : `exists` = la fiche est déjà là
sous ce nom, l'enrichir ; `probable` = vérifier ; `unknown` = voie libre. Le doublon se
prévient à l'écriture, pas au `lint`.

## 4. Propager — 10 à 15 fiches, pas une

Une source ingérée se propage vers **toutes** les fiches qu'elle concerne. Une ingestion qui
ne modifie qu'un seul fichier a presque toujours été mal faite : c'est la différence entre un
wiki qui se compose et un wiki qui s'accumule. Ce budget est réel, l'annoncer à l'utilisateur avant
de commencer à écrire.

Pour chaque fiche touchée : mettre à jour le contenu, le champ `modified`, et les wikiliens
dans les deux sens (la fiche neuve pointe vers l'ancienne, l'ancienne pointe vers la neuve).

**Et une ligne au `## Fil de preuves`, systématiquement.** Une fiche a deux zones : le HAUT
(`## État`, puis le fond) se RÉÉCRIT au vu des preuves ; le BAS s'ALLONGE, jamais ne se
corrige. Enrichir une fiche existante, c'est donc DEUX gestes : reformuler le haut, et
ajouter en bas `- [2026-08-07] <ce que la source établit> — [[raw/<chemin>]]`. Sans le fil,
la prochaine consolidation devra choisir entre écraser une observation de terrain et ne rien
oser toucher. Détail : `.claude/rules/fiches.md`.

## 5. Écrire — en `draft`, sur gabarit

Gabarits dans `wiki/_templates/` : `overview`, `topic`, `entity`, `source-summary`, `qa`.
Le type détermine l'emplacement, le gabarit et les champs.

- `statut: draft` **toujours**. Aucune promotion automatique en `canon`.
- Frontmatter complet, `modified` en ISO 8601, `sources: ["raw/<chemin>"]`.
- `temporalite` par fiche : `timeless`, `"as of 2026-08"`, ou `pointer`.
- Dates absolues dans le corps : jamais « le mois dernier », toujours `2026-07`.
- Préambule `## Pour le futur Claude` en tête, 2 à 3 lignes : quand ouvrir cette fiche.
- Contradiction entre deux sources : callout `> [!WARNING]` citant les deux, avec les chemins.
- Une fiche = une idée. Si elle traite deux sujets, elle en fait deux.
- Zone haute compilée, `## Fil de preuves` en bas : les gabarits la portent déjà, la garder.

## 6. Tenir les trois registres

`wiki/index.md` — une ligne par fiche, sous son thème. Jamais plus d'une ligne.
Plafond dur : 200 lignes ou 25 Ko. Au-delà, ne pas ajouter : lancer la Dream Sequence (phase PRUNE).

`wiki/processed.md` — une ligne, exactement :

```
- 2026-08-07 — sha1:a1b2c3d4e5 — raw/20260807-article.md — fiches : [[fiche-a]], [[fiche-b]]
```

La liste des fiches produites permet le rollback propre d'une ingestion ratée.

`wiki/log.md` — la plus récente en tête :

```
## [2026-08-07] ingest | Article X sur Y
- fiches touchées : [[fiche-a]], [[fiche-b]], [[fiche-c]]
- source : raw/20260807-article.md
```

## 7. Revue de diff — obligatoire

```
git status
git diff
```

Présenter le diff à l'utilisateur **avant tout commit**. C'est là que la propagation sur 10 à 15 fiches
devient visible, et c'est la seule boucle de contrôle qui attrape une distillation qui a dérivé.
La promotion `draft` → `canon` est sa décision, pas celle de l'agent.

## Pour finir

```
node brain.js index      # réindexer
node brain.js lint       # liens cassés, orphelines, dérive d'index
```
