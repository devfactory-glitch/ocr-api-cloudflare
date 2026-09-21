# API OCR Assurance Maladie Tunisie

API d'extraction OCR intelligente pour les dossiers medicaux d'assurance maladie en Tunisie. Analyse les bulletins de soins (BS), ordonnances, factures et pieces justificatives via Google Gemini avec auto-correction croisee multi-documents, post-traitement deterministe et boucle d'amelioration continue (few-shot learning).

## Table des matieres

- [Stack technique](#stack-technique)
- [Architecture](#architecture)
- [Structure du projet](#structure-du-projet)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commandes](#commandes)
- [Endpoints API](#endpoints-api)
- [Pipeline OCR](#pipeline-ocr)
- [Post-traitement deterministe](#post-traitement-deterministe)
- [Boucle d'amelioration continue (Few-Shot)](#boucle-damelioration-continue-few-shot)
- [Nomenclature CNAM](#nomenclature-cnam)
- [Types d'actes extraits](#types-dactes-extraits)
- [Pieces justificatives](#pieces-justificatives-detectees)
- [Base de donnees D1](#base-de-donnees-d1)
- [Administration](#administration)
- [Multi-tenant](#multi-tenant)
- [Tests](#tests)
- [Gestion des erreurs](#gestion-des-erreurs)

---

## Stack technique

| Composant | Technologie |
|-----------|-------------|
| **Runtime** | [Cloudflare Workers](https://workers.cloudflare.com/) |
| **Framework** | [Hono](https://hono.dev/) v4 |
| **IA / OCR** | [Google Generative AI](https://ai.google.dev/) — Gemini 3.1 Pro Preview |
| **Base de donnees** | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite distribue) |
| **Langage** | JavaScript (ES Modules) |

## Architecture

```
                    +------------------+
                    |   Client / Front |
                    +--------+---------+
                             |
                    multipart/form-data (images)
                             |
                    +--------v---------+
                    | Cloudflare Worker |
                    |   (Hono router)  |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v-----+
     | Gemini API |  | D1 Database |  |  Admin   |
     | (OCR + IA) |  | (SQLite)    |  | Dashboard|
     +--------+---+  +------+------+  +----------+
              |              |
     +--------v--------------v--------+
     |      Pipeline post-OCR         |
     | 1. enrichActesFromContext()     |
     | 2. enrichWithNomenclature()    |
     | 3. postProcess() (15 verrous) |
     +---------------------------------+
```

### Flux de traitement

1. **Reception** — Images envoyees via `multipart/form-data`
2. **Few-shot** — Chargement d'exemples corriges depuis D1 (max 3)
3. **Gemini OCR** — Extraction IA avec prompt specialise (systemInstruction)
4. **Failover** — Pro (180s) > Flash 3.5 (45s) > Flash 3.7 (45s)
5. **Post-traitement** — 3 couches deterministes corrigent le resultat
6. **Reponse** — JSON structure retourne au client

## Structure du projet

```
src/
  index.js          # Point d'entree — routes API, failover Gemini, enrichissement,
                    # few-shot, nomenclature CNAM, pipeline OCR complet
  prompt.js         # Prompt OCR specialise (PROMPT_BASE, PROMPT, PROMPT_DOSSIER)
                    # ~1500 lignes — regles d'extraction detaillees pour BS tunisiens
  postprocess.js    # Couche deterministe post-OCR — 15 verrous de correction
                    # independante du modele et du prompt
  admin.js          # Plateforme d'administration — dashboard HTML, providers,
                    # bulletins, correction, few-shot, nomenclature
  admin_panel.js    # Interface visuelle simplifiee du dashboard (Tailwind)
  stats.js          # Module statistiques — logging D1, metriques, evolution
test/
  postprocess.v2.test.mjs   # Tests unitaires postProcess v2
  patchs.test.mjs           # Tests des patchs correctifs
  v3_correctifs.test.mjs    # Tests correctifs v3
  v4_finitions.test.mjs     # Tests finitions v4
  v5_fusion.test.mjs        # Tests fusion pharmacie v5
  verrou0.test.mjs          # Tests verrou 0
  verrous_10_11.test.mjs    # Tests verrous 10-11
  verrous_12_13.test.mjs    # Tests verrous 12-13
wrangler.toml       # Configuration Cloudflare Workers (dev, staging, prod)
package.json        # Dependances npm
```

## Installation

```bash
git clone https://github.com/devfactory-ai/ocr-api-cloudflare.git
cd ocr-api-cloudflare
npm install
```

### Prerequis

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Compte Cloudflare avec D1 active
- Cle API Google Generative AI (Gemini)

## Configuration

### Variables d'environnement

Configurees via le dashboard Cloudflare Workers (Settings > Variables) :

| Variable | Description | Obligatoire |
|----------|-------------|:-----------:|
| `GEMINI_API_KEY` | Cle API Google Generative AI | Oui |
| `ADMIN_KEY` | Cle d'acces a la plateforme d'administration | Prod uniquement |

> En dev, si `ADMIN_KEY` n'est pas definie, l'acces admin est libre.

### Environnements

| Env | Worker | D1 Database | Usage |
|-----|--------|-------------|-------|
| **dev** | `ocr-api-bh-assurance-dev` | `bulletins-db-dev` | Developpement local |
| **staging** | `ocr-api-bh-assurance-staging` | `bulletins-db` | Tests pre-production |
| **prod** | `ocr-api-bh-assurance` | `bulletins-db-prod` | Production |

> **Note** : staging et default partagent la meme base D1 (`bulletins-db`).

## Commandes

```bash
# Developpement local (port 8787)
npm run dev

# Port personnalise
npx wrangler dev --port 8000

# Deployer sur staging
npx wrangler deploy --env staging

# Deployer en production
npx wrangler deploy --env prod

# Lancer les tests
node --test test/
```

---

## Endpoints API

### Routes publiques

| Methode | Route | Description |
|---------|-------|-------------|
| `GET` | `/` | Statut de l'API et liste des endpoints |
| `GET` | `/docs` | Swagger UI interactive |
| `GET` | `/openapi.json` | Specification OpenAPI 3.0 |
| `POST` | `/analyse-bulletin` | **Analyse OCR multi-documents** (principal) |
| `POST` | `/ocr` | OCR simple (un seul document) |
| `POST` | `/valider` | Validation/correction humaine |
| `POST` | `/valider-bulletin` | Alias de `/valider` (compatibilite front) |
| `GET` | `/bulletins` | Historique des 100 derniers bulletins |
| `GET` | `/bulletins/:id` | Detail d'un bulletin |

### Routes admin (protegees par `X-Admin-Key`)

| Methode | Route | Description |
|---------|-------|-------------|
| `GET` | `/admin` | Dashboard HTML |
| `GET` | `/admin/stats` | Statistiques JSON (filtrable par date) |
| `GET` | `/admin/logs` | Logs d'utilisation avec pagination |
| `GET` | `/admin/bulletins` | Liste des bulletins valides avec filtre |
| `GET` | `/admin/bulletins/:id` | Detail d'un bulletin (donnees_ia + corrigees) |
| `PUT` | `/admin/bulletins/:id/corriger` | Enregistrer une correction humaine |
| `PUT` | `/admin/bulletins/:id/valider` | Valider tel quel (IA = reference) |
| `PUT` | `/admin/bulletins/:id/promouvoir` | Toggle exemple few-shot |
| `PUT` | `/admin/bulletins/:id/rejeter` | Rejeter un bulletin |
| `GET` | `/admin/exemples-fewshot` | Liste des exemples few-shot actifs |
| `GET` | `/admin/providers` | Providers OCR configures |
| `POST` | `/admin/providers` | Ajouter/mettre a jour un provider |
| `PATCH` | `/admin/providers/:id/activer` | Activer/desactiver un provider |
| `DELETE` | `/admin/providers/:id` | Supprimer un provider |
| `POST` | `/admin/providers/:id/tester` | Tester la connexion d'un provider |
| `POST` | `/admin/seed-nomenclature` | Injecter/MAJ la nomenclature CNAM |
| `GET` | `/admin/nomenclature` | Lister la nomenclature CNAM active |

---

### `POST /analyse-bulletin` — Analyse OCR multi-documents

Endpoint principal. Envoie un ou plusieurs fichiers (bulletin + pieces justificatives) pour extraction OCR structuree.

**Content-Type** : `multipart/form-data`

| Champ | Type | Description |
|-------|------|-------------|
| `files` | File[] | Images du dossier (BS + ordonnances + factures) |
| `mode` | String | `"dossier"` (defaut) ou `"batch"` |

**Mode dossier** (defaut) : tous les fichiers = 1 seul dossier medical.
**Mode batch** : chaque fichier = 1 BS independant, analyse en parallele.

```bash
# Mode dossier (defaut)
curl -X POST https://votre-api.workers.dev/analyse-bulletin \
  -F "files=@bulletin_recto.jpg" \
  -F "files=@bulletin_verso.jpg" \
  -F "files=@ordonnance.jpg" \
  -F "files=@facture_pharmacie.jpg"

# Mode batch
curl -X POST https://votre-api.workers.dev/analyse-bulletin \
  -F "mode=batch" \
  -F "files=@bulletin1.jpg" \
  -F "files=@bulletin2.jpg"
```

**Reponse (mode dossier)** :
```json
{
  "success": true,
  "mode": "dossier",
  "nombre_fichiers": 4,
  "modele_utilise": "gemini-3.1-pro-preview",
  "duree_ms": 95230,
  "fewshot_count": 2,
  "resultat": {
    "infos_adherent": {
      "assureur_detecte": "CARTE Assurances",
      "nom_prenom": "Ben Aoun Mohamed",
      "numero_adherent": "1099",
      "numero_contrat": "POL-2024-789",
      "numero_cnam": "0833",
      "employeur": "SEPTEO",
      "numero_bulletin": "BS-2026-0456",
      "date_bulletin": "06/07/2026",
      "beneficiaire_coche": "Conjoint"
    },
    "infos_patient": {
      "nom_prenom_malade": "Kefi Raouia"
    },
    "actes_independants": [
      {
        "type": "MEDECIN",
        "acte": "Consultation specialiste",
        "praticien": "Dr Ahmed Ben Salah",
        "specialite": "Cardiologie",
        "date_acte": "15/06/2026",
        "montant": "80.000",
        "lettre_cle": "CS",
        "cotation": "1",
        "rubrique_proposee": "CS"
      },
      {
        "type": "PHARMACIE",
        "acte": "Achat medicaments",
        "pharmacie": "Pharmacie Centrale",
        "date_acte": "15/06/2026",
        "montant": "231.604",
        "details_lignes": [
          { "designation": "AMLOR 5MG", "quantite": "2", "montant_unitaire": "12.500", "montant": "25.000" }
        ]
      }
    ],
    "cnam": {
      "decompte_present": true,
      "numero_decompte": "DEC-2026-1234"
    },
    "pieces_justificatives": [
      {
        "type_piece": "ORDONNANCE",
        "praticien": "Dr Ahmed Ben Salah",
        "rattachement_acte": 0,
        "contenu": {
          "medicaments": ["AMLOR 5MG", "ASPEGIC 100MG"]
        }
      }
    ],
    "synthese": {
      "total_medecin": "80.000",
      "total_pharmacie": "231.604",
      "total_global_calcule": "311.604",
      "devise": "DT"
    }
  }
}
```

---

### `POST /ocr` — OCR simple

Analyse generique d'un document de sante unique. Retourne un JSON structure libre (pas de post-traitement).

```bash
curl -X POST https://votre-api.workers.dev/ocr \
  -F "file=@document.jpg"
```

---

### `POST /valider` — Validation humaine

Permet au superviseur de valider ou corriger le JSON extrait, avec stockage en D1.

```json
{
  "donnees_ia": { "...resultat de l'OCR..." },
  "donnees_corrigees": { "...JSON corrige (optionnel)..." },
  "metadata_validation": {
    "statut_validation": "valide",
    "erreurs_signalees": ["montant pharmacie incorrect"],
    "commentaires_correction": "Corrige le total"
  }
}
```

Statuts possibles : `valide`, `corrige`, `rejete`, `en_attente`.

---

## Pipeline OCR

Le traitement d'un dossier passe par 5 etapes sequentielles :

### 1. Preparation des images

Les fichiers sont convertis en base64 et envoyes inline a Gemini. La conversion utilise des chunks de 8KB pour eviter le O(n^2) de la concatenation char par char.

### 2. Injection few-shot

Avant les images, jusqu'a 3 exemples corriges sont injectes dans la conversation Gemini comme turns user/model (texte uniquement, pas d'images). Ces exemples viennent de la table `bulletins_valides` (ou `est_exemple_fewshot = 1`).

### 3. Extraction IA (Gemini)

Le prompt est passe en `systemInstruction` (cache par Gemini). Le modele recoit les images et retourne un JSON structure.

**Failover multi-modeles** :

| Ordre | Modele | Timeout (1er chunk) | Usage |
|:-----:|--------|:-------------------:|-------|
| 1 | `gemini-3.1-pro-preview` | 180s | Qualite maximale |
| 2 | `gemini-3.5-flash` | 45s | Rapide |
| 3 | `gemini-3.7-flash` | 45s | Backup |

Le timeout s'applique uniquement au premier chunk. Une fois le streaming demarre, il n'y a plus de timeout.

### 4. Enrichissement contextuel

- **`enrichActesFromContext()`** — Croise actes promus avec les pieces justificatives (lettres confidentielles) pour corriger les noms d'intervention (ex: "Chirurgien" remplace par "Circoncision").

- **`enrichWithNomenclature()`** — Cherche les codes CNAM dans la table `nomenclature_cnam` et enrichit avec lettre_cle, cotation, forfait_conventionnel.

### 5. Post-traitement deterministe

Voir section dediee ci-dessous.

---

## Post-traitement deterministe

Le fichier `postprocess.js` applique 15 verrous de correction apres l'OCR. Cette couche est **independante du modele et du prompt** : un prompt peut devier, ce code non.

### Verrous

| # | Nom | Description |
|:-:|-----|-------------|
| 0 | Nettoyage structurel | Normalise la structure JSON (champs manquants, types) |
| 1 | Identite imprimee | L'identite imprimee (facture, decompte) ecrase le manuscrit du BS |
| 2 | Separation types | Garantit la separation MEDECIN / RADIOLOGIE / LABORATOIRE |
| 3 | Coherence montants | Verifie la coherence montant facture vs montant BS |
| 4 | Lettres-cles CNAM | Corrige les lettres-cles selon le type d'acte et la specialite |
| 5 | Rattachement praticien | Croise praticiens entre actes et pieces justificatives |
| 6 | Defalcation facture | Separe les lignes d'une facture clinique en actes independants |
| 7 | Fusion pharmacie | Fusionne les doublons pharmacie (meme pharmacie + meme date) |
| 8 | Regroupement labo | Regroupe les analyses d'un meme laboratoire |
| 9 | Visite / rubrique | Corrige rubrique VS/V selon la specialite pour les visites |
| 10 | Coherence hospi | Verifie les dates entree/sortie et les sections d'hospitalisation |
| 11 | Honoraires chirurgicaux | Analyse et repartit les honoraires de l'equipe chirurgicale |
| 12 | Rubriques KC | Attribue K/FAN/SO aux actes de l'equipe chirurgicale |
| 14 | Recalcul synthese | Recalcule tous les totaux de la synthese |
| 15 | Observations | Ajoute des observations sur les anomalies detectees |

### Fonctions utilitaires cles

- **`sameName(a, b)`** — Comparaison de noms par intersection de tokens (robuste a l'ordre nom/prenom et aux titres Dr/Pr/Mme)
- **`rubriqueParRole(role)`** — Mappe le role d'intervention a la rubrique CNAM (FAN, K, CS)
- **`rubriqueParType(acte)`** — Deduit la rubrique depuis le type d'acte
- **`analyseHonoraires(acte)`** — Analyse pure (sans effet de bord) des honoraires d'hospitalisation

---

## Boucle d'amelioration continue (Few-Shot)

Le systeme apprend des corrections humaines grace a une boucle en 4 etapes :

```
[Admin corrige un BS] --> [Stockage D1] --> [Selection exemples] --> [Injection few-shot Gemini]
         ^                                                                    |
    [Qualite amelioree] <-----------------------------------------------------+
```

### Fonctionnement

1. **Soumission** — Un BS est analyse par Gemini (`/analyse-bulletin`)
2. **Validation** — L'admin valide ou corrige le resultat via l'interface (`/admin/bulletins/:id/corriger` ou `/valider`)
3. **Promotion** — L'admin choisit manuellement de promouvoir un bulletin corrige comme exemple few-shot (`/admin/bulletins/:id/promouvoir`)
4. **Injection** — Lors des analyses suivantes, `getFewShotExamples()` selectionne max 3 exemples diversifies (assureurs/types differents) et les injecte dans la conversation Gemini

### Garde-fous

| Risque | Mitigation |
|--------|-----------|
| Regression OCR | Few-shot additif. Si 0 exemple, comportement identique a avant |
| Mauvais exemple | Promotion manuelle par admin. Demouvoir a tout moment |
| Depassement tokens | Hard cap 3 exemples + trimming JSON (~6000 tokens max) |
| Isolation tenant | Chaque tenant a sa propre DB D1, exemples non partages |
| Erreur DB | `getFewShotExamples()` catch + return []. Degradation gracieuse |

---

## Nomenclature CNAM

La table `nomenclature_cnam` contient ~3100 codes d'actes medicaux de la CNAM tunisienne.

### Sources

- PDF "actes-medicaux" : 3053 codes (chirurgie, consultations, biologie, etc.)
- JSON imagerie : 47 codes avec forfait_conventionnel

### Enrichissement post-OCR

La fonction `enrichWithNomenclature()` est appelee apres l'extraction Gemini :
- Cherche les codes CNAM dans `details_lignes[].code_acte` et `accord_prealable_details.code_intervention`
- Enrichit avec : `matched_nomenclature { code, famille, designation, lettre_cle, cotation, forfait_conventionnel, accord_prealable }`
- Remonte `lettre_cle` et `cotation` au niveau de l'acte si absents

### Endpoints nomenclature

```bash
# Lister la nomenclature
curl -H "X-Admin-Key: $KEY" https://api/admin/nomenclature?famille=CHIRURGIE

# Injecter/mettre a jour
curl -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  https://api/admin/seed-nomenclature \
  -d '{"familles": [{"famille": "CHIRURGIE", "lettre_cle": "K", "actes": [{"code_acte": "KC001234", "designation": "...", "cotation": 50}]}]}'
```

---

## Types d'actes extraits

Tous les actes sont dans le tableau `actes_independants` avec un champ `type` :

| Type | Description | Lettres-cles CNAM |
|------|-------------|-------------------|
| `MEDECIN` | Consultations, visites | C, CS, V, VS, K, KC, KE |
| `RADIOLOGIE` | Echographie, scanner, IRM, radio | Rd, Z |
| `PHARMACIE` | Tickets/factures de pharmacie (avec `details_lignes`) | — |
| `LABORATOIRE` | Analyses biologiques (avec `details_lignes`) | B |
| `HOSPITALISATION` | Sejour clinique/hopital (avec `details_lignes` + `compte_autrui`) | KC, K, FAN, SO, JHC, PH |
| `DENTAIRE` | Soins dentaires DC / protheses DP (`type_soin_dentaire`) | D, DC, DP |
| `OPTIQUE` | Montures, verres, prescription OD/OG (`prescription_optique`) | — |
| `PARAMEDICAL` | Kine, sage-femme, infirmier | SC, SF, AMO, AMI, TO, TM, APR |

### Rubriques CNAM pour hospitalisation

| Rubrique | Description |
|----------|-------------|
| `K` / `KC` | Chirurgien |
| `FAN` | Anesthesiste |
| `SO` | Salle d'operation |
| `JHC` | Journees d'hospitalisation (sejour) |
| `PH` | Pharmacie interne |

---

## Pieces justificatives detectees

| Type | Description |
|------|-------------|
| `ORDONNANCE` | Prescription medicale (medicaments, posologie, duree) |
| `BILAN` | Resultats d'analyses biologiques (parametres, valeurs, normes) |
| `RECU` | Recu de paiement, ticket de caisse |
| `FACTURE` | Facture detaillee (pharmacie, labo, clinique) |
| `COMPTE_RENDU` | Compte-rendu medical, rapport radiologique |
| `LETTRE_CONFIDENTIELLE` | Lettre confidentielle de clinique (chirurgien, codification CNAM) |
| `NOTE_HONORAIRES` | Note d'honoraires praticien |
| `RELEVE_ASSUREUR` | Releve de prestations de l'assureur |

Chaque piece est rattachee a l'acte correspondant via `rattachement_acte` (index dans `actes_independants`).

---

## Base de donnees D1

Tables creees automatiquement au premier appel (avec migrations automatiques pour les colonnes ajoutees) :

### `bulletins_valides`

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `donnees_ia` | TEXT | JSON original genere par Gemini |
| `donnees_corrigees` | TEXT | JSON corrige par l'humain (NULL si valide tel quel) |
| `assureur` | TEXT | Assureur detecte (extrait auto) |
| `types_actes` | TEXT | JSON array des types d'actes presents |
| `est_exemple_fewshot` | INTEGER | 1 = promu comme exemple few-shot |
| `statut_validation` | TEXT | `en_attente` / `valide` / `corrige` / `rejete` |
| `erreurs_signalees` | TEXT | JSON array des erreurs detectees |
| `commentaires_correction` | TEXT | Commentaire libre du superviseur |
| `created_at` | DATETIME | Date de creation |
| `updated_at` | DATETIME | Date de derniere modification |

### `usage_logs`

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `endpoint` | TEXT | Route appelee (`/analyse-bulletin`, `/ocr`) |
| `provider` | TEXT | Provider utilise (`gemini`) |
| `status` | TEXT | `success` ou `error` |
| `nb_fichiers` | INTEGER | Nombre de fichiers envoyes |
| `duree_ms` | INTEGER | Duree totale en millisecondes |
| `error_message` | TEXT | Message d'erreur (si echec) |
| `fewshot_count` | INTEGER | Nombre d'exemples few-shot injectes |
| `created_at` | DATETIME | Date de creation |

### `ocr_providers`

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `nom` | TEXT UNIQUE | Nom du provider |
| `type` | TEXT | `gemini`, `anthropic_claude`, `google_vision`, `azure_cv`, `custom` |
| `api_key` | TEXT | Cle API (optionnel) |
| `modele` | TEXT | Nom du modele |
| `est_actif` | INTEGER | 1 = actif |
| `config_json` | TEXT | Configuration JSON supplementaire |
| `created_at` | DATETIME | Date de creation |
| `updated_at` | DATETIME | Date de modification |

### `nomenclature_cnam`

| Colonne | Type | Description |
|---------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `code` | TEXT UNIQUE | Code CNAM (ex: `KC001234`) |
| `famille` | TEXT | Famille d'actes (ex: `CHIRURGIE`) |
| `designation` | TEXT | Description de l'acte |
| `lettre_cle` | TEXT | Lettre-cle CNAM (K, B, Z, etc.) |
| `cotation` | REAL | Cotation principale |
| `lettre_cle_2` | TEXT | Seconde lettre-cle (optionnel) |
| `cotation_2` | REAL | Seconde cotation (optionnel) |
| `forfait_conventionnel` | REAL | Forfait conventionnel (imagerie) |
| `accord_prealable` | INTEGER | 1 = necessite accord prealable |
| `deleted_at` | DATETIME | Soft delete |
| `created_at` | DATETIME | Date de creation |

### Index

- `idx_usage_logs_created_at` — Tri chronologique des logs
- `idx_usage_logs_status` — Filtre par statut
- `idx_usage_logs_endpoint` — Filtre par endpoint
- `idx_fewshot` — Acces rapide aux exemples few-shot (partiel)
- `idx_nomenclature_code` — Lookup rapide par code CNAM (partiel, exclut deleted)

---

## Administration

### Dashboard

Accessible a `GET /admin` (protege par `X-Admin-Key` en production).

Interface HTML complete avec :
- **Vue d'ensemble** — Requetes totales, taux de succes, duree moyenne, documents traites
- **Statistiques** — Evolution sur 30 jours, repartition par endpoint/provider
- **Logs** — Historique des requetes avec pagination et filtres
- **Bulletins** — Liste des bulletins valides/corriges avec editeur JSON
- **Providers OCR** — Configuration et test de connexion des providers
- **Nomenclature** — Consultation de la nomenclature CNAM
- **Precision OCR** — Taux de precision mensuel, exemples few-shot actifs

### Authentification admin

```bash
# Via header
curl -H "X-Admin-Key: votre-cle" https://api/admin/stats

# Via query param
curl "https://api/admin/stats?admin_key=votre-cle"
```

---

## Multi-tenant

Le systeme supporte plusieurs tenants (ex: `demo`, `BH`), chacun avec :
- **Sa propre base D1** — Isolation complete des donnees
- **Ses propres exemples few-shot** — Les corrections d'un tenant n'affectent pas les autres
- **Son propre historique** — Bulletins, logs, statistiques separes

Chaque tenant est deploye comme un Worker Cloudflare distinct, lie a sa propre database D1 via `wrangler.toml`.

---

## Tests

Les tests couvrent le post-traitement deterministe (`postprocess.js`) :

```bash
# Lancer tous les tests
node --test test/

# Lancer un test specifique
node --test test/postprocess.v2.test.mjs
```

| Fichier | Couverture |
|---------|-----------|
| `postprocess.v2.test.mjs` | Verrous de base, structure, nettoyage |
| `patchs.test.mjs` | Patchs correctifs transverses |
| `v3_correctifs.test.mjs` | Correctifs v3 (identite, montants) |
| `v4_finitions.test.mjs` | Finitions v4 (lettres-cles, rubriques) |
| `v5_fusion.test.mjs` | Fusion pharmacie (E1-E4) |
| `verrou0.test.mjs` | Verrou 0 (nettoyage structurel) |
| `verrous_10_11.test.mjs` | Verrous 10-11 (hospi, honoraires) |
| `verrous_12_13.test.mjs` | Verrous 12-13 (rubriques KC, pre-passes) |

---

## Gestion des erreurs

Format uniforme pour toutes les reponses :

```json
{
  "success": false,
  "erreur": "Description de l'erreur"
}
```

| Code HTTP | Description |
|:---------:|-------------|
| 200 | Extraction reussie |
| 401 | Acces non autorise (admin) |
| 404 | Ressource introuvable |
| 422 | Aucun fichier envoye ou JSON mal forme |
| 500 | Erreur interne du serveur |

### Failover Gemini

Si le modele principal echoue (timeout, erreur 429/500/503), le systeme bascule automatiquement sur le modele suivant. Si tous les modeles echouent, une erreur 500 est retournee avec le detail de chaque tentative.

---

## Regles d'intelligence OCR

Le prompt (`prompt.js`) contient des regles specialisees pour le contexte tunisien :

1. **Lecture prealable** — Redressement mental des scans pivotes (90/180/270 degres)
2. **Priorite au dactylographie** — Les textes imprimes ecrasent l'ecriture manuscrite
3. **Cachets officiels** — Noms et matricules fiscaux extraits des tampons
4. **Separation types** — Ne melange jamais MEDECIN / RADIOLOGIE / LABORATOIRE
5. **Correction orthographique** — Noms de medicaments corriges depuis les factures imprimees
6. **Regroupement obligatoire** — Un acte pharmacie/labo = un ticket = un objet avec `details_lignes`
7. **Champs illisibles** — `[ILLISIBLE]` au lieu d'inventer
8. **Detection CNAM** — Extraction automatique du decompte de remboursement
9. **Croisement CNAM / actes** — Alimentation automatique de `montant_cnam`
10. **Pieces justificatives** — Rattachement automatique aux actes correspondants
11. **Coherence ordonnance/pharmacie** — Verification croisee des medicaments
12. **Multi-pages** — Fusion recto/verso d'un meme bulletin
13. **Beneficiaire** — Detection case cochee (Adherent / Conjoint / Enfant)
14. **Lettres-cles CNAM** — Extraction automatique sur tous les types d'actes
15. **Regroupement pharmacie renforce** — Fusion par pharmacie + date, anti-doublons
16. **Accord prealable (APB)** — Detection sur documents separes et lignes APB
17. **Equipe chirurgicale** — Decomposition chirurgien/anesthesiste/aide/bloc operatoire
18. **Accouchement** — Cesarienne (KC) vs voie basse (forfait)
19. **Ventilation PEC/Patient** — Repartition prise en charge vs reste a charge
20. **Hospitalisation vs acte ambulatoire** — Distinction entre sejour et acte en clinique

---

## Assureurs supportes

L'API detecte automatiquement l'assureur via le logo et l'en-tete du bulletin :

- **BH Assurance**
- **CARTE Assurances**
- **CNAM** (Caisse Nationale d'Assurance Maladie)
- **STAR**
- **GAT**
- Tout autre assureur tunisien (detection generique)

---

## Licence

ISC
