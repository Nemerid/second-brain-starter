# `routines/` — ce qui tourne tout seul

Deux routines, de nature très différente. La première est mécanique et gratuite, la seconde
demande un modèle et coûte de l'argent. Elles ne s'installent pas de la même façon, et c'est
volontaire.

| Routine | Moteur | LLM ? | Coût | Installée ? |
|---|---|---|---|---|
| **Indexation** (`com.secondbrain.index.plist`) | launchd, 3 h du matin | non | nul | non — procédure ci-dessous |
| **Dream Sequence** (`dream-sequence.md`) | skill `/dream`, ou tâche planifiée Desktop | oui | quelques centimes par passe | non — déclenchement manuel par défaut |

## Ce qui tourne sans modèle de langage

`node brain.js index` relit les fichiers modifiés, reconstruit l'index inversé
(`.brain/index.json.gz`) et régénère `UI/data/graph.json`. Aucune écriture dans `wiki/`,
aucun jugement, aucun risque : au pire l'index est reconstruit pour rien.

C'est ce qui doit tourner toutes les nuits. Sans lui, la première recherche de la journée
paie la réindexation, et le graphe de l'UI affiche l'état d'hier.

## Ce qui a besoin d'un modèle

La consolidation : fusionner des doublons, comprendre qu'un fait en contredit un autre,
décider quelle fiche chapeaute quelles autres. Aucun de ces gestes n'est mécanique. C'est la
Dream Sequence, documentée dans `dream-sequence.md`. Elle est livrée **inerte** : rien ne la
déclenche tant que l'utilisateur ne l'a pas armée.

## Installer l'indexation nocturne (macOS, launchd)

D'abord, préparer le `.plist` depuis le gabarit. `com.secondbrain.index.plist.template`
contient des placeholders `<CHEMIN_NODE>`, `<RACINE_DU_SECOND_BRAIN>` et `<HOME>` à remplacer
par vos chemins absolus (launchd n'hérite ni du PATH du shell, ni de nvm) :

```sh
KB="$(cd "$(dirname "$0")/.." && pwd)"     # ou le chemin absolu de votre dépôt
NODE="$(command -v node)"                   # p. ex. /opt/homebrew/bin/node ou une version nvm
sed -e "s#<CHEMIN_NODE>#$NODE#g" \
    -e "s#<RACINE_DU_SECOND_BRAIN>#$KB#g" \
    -e "s#<HOME>#$HOME#g" \
    "$KB/routines/com.secondbrain.index.plist.template" \
    > ~/Library/LaunchAgents/com.secondbrain.index.plist
```

> Le chemin de `node` peut pointer vers une version nvm, qui change à chaque mise à jour :
> le revérifier avec `which node` après toute mise à jour, et régénérer le `.plist`.

Puis charger :

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.secondbrain.index.plist
launchctl print gui/$(id -u)/com.secondbrain.index | head -20
```

Déclencher une passe immédiatement, pour vérifier sans attendre 3 h du matin :

```sh
launchctl kickstart -p gui/$(id -u)/com.secondbrain.index
tail -20 ~/Library/Logs/com.secondbrain.index.log
tail -20 ~/Library/Logs/com.secondbrain.index.err.log
```

Désinstaller :

```sh
launchctl bootout gui/$(id -u)/com.secondbrain.index
rm ~/Library/LaunchAgents/com.secondbrain.index.plist
```

Après toute modification du `.plist` : `bootout` puis `bootstrap`. Un simple `bootstrap` sur
un service déjà chargé échoue avec `Bootstrap failed: 5: Input/output error`.

### Points de vigilance

- **Volume amovible.** Si la base vit sur un disque externe et qu'il n'est pas monté à 3 h,
  `brain.js` échoue, launchd journalise l'erreur et retentera la nuit suivante. C'est le
  comportement voulu : pas de rattrapage, pas de reconstruction sur un volume absent. (Sur un
  disque interne, ce point ne s'applique pas.)
- **Machine endormie.** `StartCalendarInterval` rattrape au réveil si l'heure est passée.
  Un seul rattrapage, pas un par nuit manquée.
- **`RunAtLoad` est à `false`** : installer la routine ne déclenche pas d'indexation. Pour en
  lancer une, `launchctl kickstart`.
- **Variante nvm.** Si le chemin de `node` change trop souvent, remplacer les deux premières
  entrées de `ProgramArguments` par
  `/bin/zsh` puis `-lc` puis `node "$KB/brain.js" index` : le shell de connexion charge nvm.
  C'est moins déterministe, mais ça survit aux mises à jour.

## Armer la Dream Sequence

Trois options, de la plus sûre à la plus automatique.

1. **Manuelle (défaut).** Invoquer la skill `/dream` depuis une session Claude Code ouverte
   dans `knowledge_base/`. C'est le mode recommandé tant que le wiki n'a pas dépassé la
   centaine de fiches : à ce volume, une passe par mois suffit, et la lire prend deux minutes.
2. **Tâche planifiée Claude Desktop** (Routines → Local). À réserver aux routines qui
   demandent vraiment un raisonnement, ce qui est le cas ici. Deux limites à connaître :
   la tâche ne tourne que si l'application est ouverte et la machine éveillée, et une skill
   marquée `disable-model-invocation: true` arriverait comme du texte brut au lieu de
   s'exécuter. La skill `dream` ne porte pas ce réglage.
3. **Ne jamais** passer par les Routines *cloud* : elles repartent d'un clone frais, ne voient
   aucun fichier local et ne liraient donc rien du second cerveau.

`/loop` et les outils Cron internes de Claude Code ne conviennent ni à l'une ni à l'autre :
les tâches sont liées à la session, ne se déclenchent que si Claude Code tourne et est
inactif, n'ont aucun rattrapage, et les récurrentes expirent au bout de sept jours.

## Vérifier que tout est en place

```sh
launchctl list | grep com.secondbrain.index    # indexation chargée ?
node brain.js stats --short                     # date du dernier index
node brain.js lint                              # dérive structurelle
```

L'onglet **Routines** de l'UI (`node UI/server.js`) lit ce dossier et
`~/Library/LaunchAgents/com.secondbrain.*.plist` : il montre ce qui est réellement chargé,
sa dernière et sa prochaine exécution.
