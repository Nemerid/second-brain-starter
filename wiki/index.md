# Carte des concepts — table des matières

> Porte d'entrée du wiki : **une ligne par fiche**, sous son thème. Le détail vit dans les
> fiches, jamais ici. Maintenu à chaque ingestion et à chaque Dream Sequence.
>
> **Plafond dur : 200 lignes ou 25 Ko.** Au-delà, ce fichier n'est plus chargé en entier et
> cesse d'être une carte. `brain.js lint` échoue bruyamment quand le seuil est franchi ; la
> phase PRUNE de la Dream Sequence le ramène dessous, en regroupant les fiches d'un même
> thème sous une fiche `overview` qui, elle, n'occupe qu'une ligne.

## Sources fédérées (bases sœurs, en lecture)

> Aucune source fédérée pour l'instant. Le second cerveau peut indexer d'AUTRES dossiers en
> lecture (une base de vente, une base technique…) : déclarez-les dans `brain.config.json`
> (voir `README.md` → « Ajouter ses propres sources fédérées »). Elles apparaîtront ici et se
> filtrent par `node brain.js search "<termes>" --source <id>`.

## Thèmes

(aucune fiche pour l'instant — déposer une source dans `raw/`, puis lancer l'ingestion : `/ingest`)

> Format d'une entrée de thème, quand il y en aura — un titre `##` par thème, puis
> une puce par fiche : lien, phrase de repérage, statut.
>
> ```
> ## Mon premier thème
> - [[ma-premiere-fiche]] — la phrase de repérage qui dit quand l'ouvrir — canon
> - [[une-autre-fiche]] — ce qu'elle répond — draft
> ```
