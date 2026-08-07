# Registre des sources ingérées

> Une ligne par source brute déjà traitée. Registre **append-only** : on ajoute, on ne
> réécrit pas. Un fichier de `raw/` dont le SHA-1 n'apparaît pas ici est considéré comme
> « à ingérer ».
>
> Format normatif, lu par `brain.js lint` sans LLM :
>
> ```
> - YYYY-MM-DD — sha1:<hash> — raw/<chemin> — fiches : [[fiche-a]], [[fiche-b]]
> ```
>
> Le hash (`shasum -a 1 raw/<fichier>`) rend l'ingestion **idempotente** : une source
> renommée ou redéposée sous un autre nom est reconnue et n'est pas ingérée deux fois.
> La liste des fiches produites permet le **rollback propre** d'une ingestion ratée.

(vide — aucune source ingérée pour l'instant)
