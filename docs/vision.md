# La vision d'origine

> Ce document est le cahier des charges d'origine qui a inspiré cet outil :
> la vision et la philosophie du "Second Brain Agentic OS / LLM Wiki". Il est
> reproduit ici tel quel, comme point de départ conceptuel. L'implémentation
> livrée dans ce dépôt va plus loin sur plusieurs points (moteur BM25F
> `brain.js`, Dream Sequence outillée, observatoire 4 couches, boucle de
> relecture draft → canon) — voir `DESIGN.md` pour le contrat technique réel
> et `README.md` pour ce qui est original par rapport au pattern d'origine.

---

# System Specification: Agentic Second Brain & LLM Wiki OS

> **Guide d'architecture et de mise en place pour Claude / Claude Code**
> Ce document sert de récapitulatif technique complet et de cahier des charges système pour concevoir, configurer et utiliser un Second Cerveau agentique autonome en local.

---

## 1. Philosophie & Principes Fondateurs

### 1.1. Dépasser le Second Cerveau Passif (Obsidian vs Agentic OS)
Les outils de Second Cerveau traditionnels (type Obsidian) reposent sur la prise de note manuelle et des graphes de liens bidirectionnels. Bien que visuels, ces graphes restent souvent pasifs et n'aident pas directement l'IA à extraire l'information efficacement.

L'approche **Agentic OS / LLM Wiki** transforme la gestion de la connaissance :
- **L'IA est l'archiviste et le curateur** : Vous déposez des contenus bruts (articles, PDFs, notes), et l'IA se charge d'indexer, résumer, lier et auditer le savoir.
- **Indexation déterministe pré-LLM** : Un script local (ex: `brain.js`) filtre les fichiers et calcule un score de pertinence avant d'envoyer uniquement les blocs utiles au modèle.
- **Gain de performances** : Réduction de **~40% des jetons (tokens)** consommés et réponses nettement plus rapides.

### 1.2. Le Pattern LLM Wiki (Andrej Karpathy)
Inspiré de la méthodologie partagée par Andrej Karpathy, le système repose sur une structure de fichiers texte simples (`.md`), sans base de données vectorielle complexe ou propriétaire :
- **Lissibilité universelle** : Fichiers sauvegardés en Markdown standard.
- **Auto-évolution** : Une routine récurrente ("Dream Sequence") maintient la cohérence de la base en nettoyant les doublons et en mettant à jour la table des matières.

---

## 2. Architecture & Structure des Fichiers

Créez le répertoire racine `knowledge_base/` sur votre ordinateur avec la structure suivante :

```text
📁 knowledge_base/
├── 📄 CLAUDE.md              # Manuel d'instructions système (Operating Manual)
├── 📄 brain.js               # Moteur d'indexation et de recherche déterministe
├── 📁 raw/                    # Zone de dépôt (fichiers bruts, liens, transcriptions)
├── 📁 wiki/                   # Connaissance structurée & synthétisée par l'IA
│   ├── 📄 index.md           # Carte des concepts & Table des matières générale
│   ├── 📄 log.md             # Historique chronologique des ajouts et modifications
│   └── 📄 processed.md       # Registre des sources brutes déjà ingérées
├── 📁 outputs/                # Livrables générés par l'IA (Rapports, PDFs, Fiches)
├── 📁 skills/                 # Compétences et prompts réutilisables par l'agent
├── 📁 routines/               # Tâches programmées et automatisations
└── 📁 UI/                     # Interface de visualisation graphique web (HTML/JS)
```

---

## 3. Le Manuel Opératoire (`CLAUDE.md`)

Le fichier `CLAUDE.md` situé à la racine agit comme le prompt système permanent pour Claude Code ou Claude Desktop.

```markdown
# Manuel Opératoire - Second Cerveau & LLM Wiki

Tu es le gestionnaire autonome de ce Second Cerveau. Ta mission est de maintenir une base de connaissances structurée, à jour et immédiatement interrogeable.

## Règles d'Or
1. **Séparation des zones** : Les fichiers dans `raw/` ne doivent jamais être modifiés directement. La synthèse structurée réside dans `wiki/`.
2. **Consultation efficace** : Avant de lire de volumineux fichiers, utilise `brain.js` pour cibler la section précise requise par la requête.
3. **Mise à jour des logs** : Chaque nouvelle ingestion doit inscrire une entrée horodatée dans `wiki/log.md` et mettre à jour `wiki/index.md`.

## Workflow d'Ingestion
Quand un fichier ou un lien est ajouté dans `raw/` :
1. Analyse le contenu brut.
2. Synthétise les concepts clés sous forme de fiches atomiques dans `wiki/`.
3. Ajoute la source dans `wiki/processed.md`.
4. Mets à jour la table des matières dans `wiki/index.md`.

## Routine "Dream Sequence"
Lors de l'exécution du nettoyage :
- Vérifie les contradictions entre les articles du `wiki/`.
- Repère les concepts orphelins ou obsolètes.
- Consolide les fiches fragmentées.
```

---

## 4. Moteur de Recherche Déterministe (`brain.js`)

Pour éviter de surcharger le contexte du LLM lors des recherches, le script `brain.js` effectue une pré-sélection déterministe :

```javascript
const fs = require('fs');
const path = require('path');

const WIKI_DIR = path.join(__dirname, 'wiki');

function searchWiki(query) {
    const keywords = query.toLowerCase().split(' ').filter(w => w.length > 2);
    const results = [];

    const files = fs.readdirSync(WIKI_DIR);
    files.forEach(file => {
        if (!file.endsWith('.md')) return;
        const filePath = path.join(WIKI_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        let score = 0;
        keywords.forEach(kw => {
            const matches = (content.toLowerCase().match(new RegExp(kw, 'g')) || []).length;
            score += matches;
        });

        if (score > 0) {
            results.push({ file, score, path: filePath });
        }
    });

    return results.sort((a, b) => b.score - a.score);
}

const query = process.argv.slice(2).join(' ');
if (query) {
    console.log(JSON.stringify(searchWiki(query), null, 2));
}
```

---

## 5. Spécifications de l'Interface Visuelle (Visualiseur 4-Couches)

L'interface graphique interactive (développée en HTML/JS/CSS léger ou visuelle sur navigateur) permet de visualiser l'écosystème global de l'agentique OS selon 4 couches distinctes :

```
+-----------------------------------------------------------------------+
|                       AGENTIC OPERATING SYSTEM                        |
+-----------------------------------------------------------------------+
|  [🔵 APPLICATIONS / CONNECTEURS MCP]                                  |
|   ├── Google Calendar      ├── Google Drive       ├── CLI Local       |
|                                                                       |
|  [🟡 ROUTINES / AUTOMATISATIONS]                                       |
|   ├── Dream Sequence (Daily)                  ├── Daily Log           |
|                                                                       |
|  [🟢 MEMORY / CONNAISSANCES]                                          |
|   ├── raw/ (Dépôt)         ├── wiki/ (Synthèse) ├── outputs/        |
|                                                                       |
|  [🟣 SKILLS / COMPÉTENCES]                                            |
|   ├── Extraction PDF       ├── Research Agent   ├── Code Reviewer   |
+-----------------------------------------------------------------------+
```

### Description des 4 Couches Graphiques
1. 🔵 **Applications (Connecteurs MCP / APIs)** :
   - Cartographie tous les outils externes reliés à l'agent via MCP (*Model Context Protocol*), API ou CLI.
   - **Indicateur de risque** : Permet de vérifier visuellement quelles applications ont des droits d'action (ex: envoi d'emails, écriture sur Drive) pour maintenir un contrôle de sécurité.
2. 🟡 **Routines (Automatisations)** :
   - Affiche les tâches récurrentes exécutées en arrière-plan (ex: audit quotidien de la base, synchronisation des logs).
3. 🟢 **Memory (Index de la Connaissance)** :
   - Visualisation arborescente des dossiers `raw/`, `wiki/` et `outputs/`.
   - Permet d'ouvrir directement un fichier ou une note sur la machine.
4. 🟣 **Skills (Compétences)** :
   - Liste les compétences métier et prompts spécialisés disponibles pour l'agent.

---

## 6. Séquence de Rêve ("Dream Sequence" & Auto-Correction)

La **Dream Sequence** est un processus récurrent (ex: quotidien à minuit) qui exécute les opérations suivantes :
1. **Scrutage** : Analyse de la zone `raw/` pour repérer les fichiers non enregistrés dans `wiki/processed.md`.
2. **Ingestion & Synthèse** : Traitement des nouveautés et intégration dans les fiches thématiques de `wiki/`.
3. **Linting & Nettoyage** :
   - Détection des contradictions entre fiches.
   - Correction des liens brisés dans `index.md`.
   - Suppression des redondances et fusion des notes similaires.
4. **Horodatage** : Consignation des opérations dans `wiki/log.md`.

---

## 7. Directives pour Travailler avec Claude

Pour faire construire cet outil directement par Claude sur votre ordinateur :

1. **Création du dossier** : Créez le dossier `knowledge_base` et placez-y le fichier `CLAUDE.md`.
2. **Initialisation** : Lancez Claude Code dans ce répertoire en lui fournissant la consigne suivante :
   > *"Lis le fichier CLAUDE.md à la racine. Crée la structure de dossiers (raw, wiki, outputs, skills, routines, UI), génère le script brain.js et configure la routine quotidienne de Dream Sequence."*
3. **Développement de l'UI** : Demandez à Claude :
   > *"Génère une page web HTML/JS autonome dans le dossier UI/ permettant de visualiser sous forme de cartes/nœuds les 4 couches : Applications (MCP), Routines, Memory (fichiers wiki) et Skills."*
4. **Alimentation** : Déposez vos premiers documents bruts dans `raw/` et demandez à Claude d'exécuter la première ingestion.
