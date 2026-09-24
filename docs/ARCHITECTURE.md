# Architecture technique — OCR Assurance Maladie

Documentation technique detaillee du systeme OCR pour les dossiers medicaux d'assurance maladie en Tunisie.

## Table des matieres

- [Vue d'ensemble](#vue-densemble)
- [Modules](#modules)
- [Pipeline de traitement](#pipeline-de-traitement)
- [Prompt OCR](#prompt-ocr)
- [Post-traitement deterministe](#post-traitement-deterministe)
- [Few-shot learning](#few-shot-learning)
- [Nomenclature CNAM](#nomenclature-cnam)
- [Schema JSON de sortie](#schema-json-de-sortie)
- [Modele Gemini et failover](#modele-gemini-et-failover)
- [Securite](#securite)
- [Performance](#performance)
- [Deploiement](#deploiement)

---

## Vue d'ensemble

Le systeme est concu comme un pipeline en couches :

```
[Images] --> [Few-shot] --> [Gemini OCR] --> [enrichActesFromContext] --> [enrichWithNomenclature] --> [postProcess] --> [JSON final]
                                 ^
                           systemInstruction
                           (prompt.js ~1500 lignes)
```

Chaque couche est independante et peut echouer sans bloquer les suivantes (sauf Gemini qui est critique).

---

## Modules

### `src/index.js` (~1000 lignes)

Point d'entree principal. Contient :

| Fonction | Lignes | Description |
|----------|:------:|-------------|
| `initDB()` | 21-109 | Creation des tables D1 + migrations auto |
| `enrichWithNomenclature()` | 126-201 | Enrichissement par codes CNAM depuis D1 |
| `enrichActesFromContext()` | 211-299 | Croisement actes promus / pieces justificatives |
| `fileToBase64()` | 315-325 | Conversion fichier -> base64 par chunks 8KB |
| `getFewShotExamples()` | 330-381 | Selection de 3 exemples diversifies depuis D1 |
| `callGeminiStream()` | 392-441 | Appel streaming Gemini avec timeout sur 1er chunk |
| `generateWithFallback()` | 443-469 | Failover multi-modeles sequentiel |
| `analyseSingleDossier()` | 653-689 | Orchestration complete d'un dossier |

Routes :
- `POST /analyse-bulletin` — Route principale (dossier ou batch)
- `POST /ocr` — OCR simple (un document)
- `POST /valider` et `/valider-bulletin` — Validation humaine
- `GET /bulletins` et `/bulletins/:id` — Consultation D1
- `GET /docs` et `/openapi.json` — Documentation Swagger

### `src/prompt.js` (~1500 lignes)

Prompt OCR specialise pour le contexte tunisien. Exporte :

- `PROMPT_BASE` — Regles completes d'extraction (sections BS, types d'actes, pieces justificatives, regles metier CNAM)
- `PROMPT` — `PROMPT_BASE` pour un seul document
- `PROMPT_DOSSIER` — `PROMPT_BASE` avec instructions multi-documents (croisement, deduplication)

**Structure du prompt** :
1. Lecture prealable (pivotement, doublons, recto/verso)
2. Extraction identite (adherent, patient, assureur)
3. Regles par type d'acte (MEDECIN, RADIOLOGIE, PHARMACIE, etc.)
4. Regles speciales (hospitalisation, equipe chirurgicale, accouchement)
5. Detection CNAM (decompte, remboursement)
6. Pieces justificatives (rattachement, contenu)
7. Schema JSON de sortie impose
8. Controles de coherence (C1..C16)

> **Avertissement** : Ce prompt est le resultat de dizaines d'iterations. Toute modification risque des regressions subtiles. Tester exhaustivement avant de deployer.

### `src/postprocess.js` (~1670 lignes)

Couche deterministe post-OCR. Voir la section dediee plus bas.

### `src/admin.js` (~1900 lignes)

Plateforme d'administration complete :
- Dashboard HTML full-featured (dark theme, graphiques, filtres)
- CRUD providers OCR avec test de connexion
- Gestion des bulletins (voir, corriger, valider, rejeter, promouvoir)
- Injection nomenclature CNAM
- Editeur JSON integre pour les corrections

### `src/stats.js` (~210 lignes)

Module de statistiques :
- `logUsageEvent()` — Enregistre chaque requete dans `usage_logs`
- `getGlobalStats()` — Statistiques globales (taux succes, duree, evolution 30j, precision OCR, few-shot)
- `getRecentLogs()` — Logs pagines avec filtres

### `src/admin_panel.js` (~50 lignes)

Interface visuelle simplifiee du dashboard (Tailwind CSS). Route alternative `/admin/dashboard`.

---

## Pipeline de traitement

### Etape 1 : Reception et preparation

```js
// index.js — analyseSingleDossier()
const imageParts = await Promise.all(
  files.map(async (file) => {
    const base64 = await fileToBase64(file);
    return { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } };
  })
);
```

### Etape 2 : Selection du prompt

```js
// 1 fichier → prompt simple, 2+ fichiers → prompt multi-documents
const prompt = files.length === 1 ? PROMPT : PROMPT_DOSSIER;
```

### Etape 3 : Few-shot injection

```js
const fewShotExamples = await getFewShotExamples(c.env.DB);
// Injectes comme turns user/model AVANT les images
for (const ex of fewShotExamples) {
  contents.push({ role: "user", parts: [{ text: ex.description }] });
  contents.push({ role: "model", parts: [{ text: ex.json }] });
}
contents.push({ role: "user", parts: imageParts });
```

### Etape 4 : Appel Gemini avec failover

```
Pro (180s) --echec--> Flash 3.5 (45s) --echec--> Flash 3.7 (45s) --echec--> Erreur 500
```

Le streaming est utilise : timeout uniquement sur le 1er chunk, puis pas de timeout pour le reste.

### Etape 5 : Post-traitement en 3 couches

```js
data = enrichActesFromContext(data);       // Croisement contexte
data = await enrichWithNomenclature(env.DB, data); // Nomenclature CNAM
data = postProcess(data);                  // 15 verrous deterministes
```

---

## Post-traitement deterministe

### Principes de conception

1. **Deterministe** — Meme entree = meme sortie, a chaque fois
2. **Independant du modele** — Fonctionne identiquement quel que soit le modele Gemini
3. **Sans effet de bord** — `analyseHonoraires()` est une fonction pure
4. **Anti-regression** — 159 tests automatises couvrent tous les verrous

### Fonctions utilitaires

```js
// Comparaison de noms robuste (ordre, titres, accents)
sameName("Dr Imed Eddine ESSID", "ESSID Imededdine") // true
sameName("Dr. Raafet BABA", "BABA Raafet")            // true

// Rubrique par role d'intervention
rubriqueParRole("Anesthésiste")   // "FAN"
rubriqueParRole("Chirurgien")     // "K"
rubriqueParRole("Pédiatre")       // "CS"  (regle CNAM, pas du hardcode)

// Rubrique par type d'acte
rubriqueParType({ type: "RADIOLOGIE" })  // "Z"
rubriqueParType({ type: "LABORATOIRE" }) // "B"
```

### Detail des verrous

**Verrou 0 — Nettoyage structurel**
- Garantit que `actes_independants` est un tableau
- Normalise les champs manquants avec valeurs par defaut
- Supprime les actes vides ou invalides

**Verrou 1 — Identite imprimee**
- Compare l'identite manuscrite du BS avec les sources imprimees (factures, decomptes)
- L'imprime ecrase le manuscrit (plus fiable)
- Ne corrige QUE si une source imprimee existe reellement

**Verrou 5 — Rattachement praticien**
- Utilise `sameName()` pour croiser les praticiens entre actes et pieces
- Intersection de tokens (pas de comparaison stricte)

**Verrou 7 — Fusion pharmacie**
- Detecte les doublons : meme pharmacie + meme date
- Fusionne les `details_lignes` et recalcule le montant total
- Fast path via `sameName()` pour les noms de pharmacie identiques

**Verrou 9 — Pre-passe visite/rubrique**
- Visite + specialiste → rubrique `VS` (visite specialisee)
- Visite + generaliste → rubrique `V`
- Rubrique `AUTRE` → deduite du type d'acte

**Verrou 11 — Honoraires chirurgicaux**
- Analyse pure des sections : sejour, bloc_operatoire, pharmacie_interne, autres_frais
- Ignore les lignes "AJUSTEMENT"
- Ventile entre PEC et patient

**Verrou 12 — Rubriques KC**
- Attribue `K` (chirurgien), `FAN` (anesthesiste), `SO` (salle d'operation)
- Base sur `rubriqueParRole()` — utilise le role du praticien

**Verrou 14 — Recalcul synthese**
- Recalcule `total_medecin`, `total_pharmacie`, etc. depuis les actes
- Utilise un Map pre-calcule `totauxParType` pour la performance
- Formate en `###.###` (3 decimales, convention tunisienne DT)

---

## Few-shot learning

### Selection des exemples

```sql
SELECT donnees_corrigees, donnees_ia, assureur, types_actes
FROM bulletins_valides
WHERE est_exemple_fewshot = 1
  AND statut_validation IN ('valide', 'corrige')
ORDER BY updated_at DESC
LIMIT 10
```

Puis diversification :
- Max 3 exemples
- Cle de deduplication : `assureur|types_actes`
- Trimming : suppression de `pieces_justificatives`, `details_lignes` limite a 2 lignes
- Budget tokens estime : ~6000 tokens max pour 3 exemples

### Format d'injection

Les exemples sont injectes comme un historique de conversation **texte uniquement** (pas d'images) :

```
[user] "Exemple — BS CARTE Assurances, 3 actes MEDECIN/PHARMACIE"
[model] "{\"infos_adherent\": {...}, \"actes_independants\": [...]}"
[user] "Exemple — BS BH Assurance, 1 acte HOSPITALISATION"
[model] "{...}"
[user] <images du vrai BS>  ← requete reelle
```

---

## Nomenclature CNAM

### Pattern de code

```
[A-Z]{2,3}\d{6,}
```

Exemples : `KC001234`, `B0012345`, `Z0001234`

### Processus d'enrichissement

```
Pour chaque acte (MEDECIN, RADIOLOGIE, LABORATOIRE, HOSPITALISATION) :
  1. Scanner details_lignes[].code_acte pour des codes CNAM
  2. Si match → enrichir la ligne avec matched_nomenclature
  3. Si aucun match dans details_lignes → tenter accord_prealable_details.code_intervention
  4. Remonter lettre_cle et cotation au niveau de l'acte si absents
  5. Si un code au format CNAM n'est pas trouve → observation d'alerte sur l'acte
```

### Alerte codes non trouves

Quand un code respecte le pattern CNAM (`[A-Z]{2,3}\d{6,}`) mais n'existe pas dans la table `nomenclature_cnam`, une observation est ajoutee sur l'acte :

```
"observations": "code CNAM non trouvé dans la nomenclature : ROD300050 — à vérifier"
```

Cela permet :
- **Detection visible** — le front affiche l'alerte, l'admin voit immediatement le probleme
- **Correction humaine** — l'admin corrige le code (ex: `ROD300050` → `RAD0300010`)
- **Few-shot** — la correction alimente Gemini pour les analyses futures
- **Mesure qualite** — suivi du nombre de codes non trouves au fil du temps

> Aucune correction automatique (fuzzy match) n'est appliquee : un seul chiffre de difference dans un code CNAM peut designer un acte completement different. Le systeme signale, l'humain tranche.

---

## Schema JSON de sortie

Structure simplifiee du JSON retourne par `/analyse-bulletin` :

```
resultat
├── infos_adherent
│   ├── assureur_detecte        # Logo/en-tete du BS
│   ├── nom_prenom              # Nom de l'assure
│   ├── numero_adherent         # "Adhesion N°" prioritaire
│   ├── numero_contrat          # "Contrat N°" / "Police N°"
│   ├── numero_cnam             # "N° CNAM"
│   ├── employeur
│   ├── numero_bulletin         # Numero du BS
│   ├── date_bulletin           # JJ/MM/AAAA
│   └── beneficiaire_coche      # Adherent / Conjoint / Enfant
│
├── infos_patient
│   └── nom_prenom_malade
│
├── actes_independants[]
│   ├── type                    # MEDECIN, PHARMACIE, RADIOLOGIE, etc.
│   ├── acte                    # Designation de l'acte
│   ├── praticien               # Nom du praticien
│   ├── specialite
│   ├── date_acte               # JJ/MM/AAAA
│   ├── montant                 # Montant facture (DT)
│   ├── montant_cnam            # Montant rembourse CNAM
│   ├── lettre_cle              # C, CS, K, B, Z, etc.
│   ├── cotation
│   ├── rubrique_proposee       # Rubrique CNAM proposee
│   ├── code_acte               # Code CNAM
│   ├── details_lignes[]        # Lignes de detail (pharma, labo, hospi)
│   ├── role_intervention       # Pour equipe chirurgicale
│   ├── rattachement_hospitalisation  # Index de l'hospi parente
│   ├── matched_nomenclature    # Enrichissement CNAM
│   └── ...
│
├── cnam
│   ├── decompte_present        # Boolean
│   ├── numero_decompte
│   └── ...
│
├── pieces_justificatives[]
│   ├── type_piece              # ORDONNANCE, FACTURE, etc.
│   ├── praticien
│   ├── rattachement_acte       # Index dans actes_independants
│   └── contenu                 # Contenu specifique au type
│
├── synthese
│   ├── total_medecin
│   ├── total_radiologie
│   ├── total_pharmacie
│   ├── total_laboratoire
│   ├── total_hospitalisation
│   ├── total_dentaire
│   ├── total_optique
│   ├── total_paramedical
│   ├── total_global_calcule
│   ├── total_cnam
│   └── devise                  # "DT"
│
└── observations[]              # Anomalies et avertissements
```

---

## Modele Gemini et failover

### Configuration

```js
const GEMINI_MODELS_ORDERED = [
  { name: "gemini-3.1-pro-preview", timeoutMs: 180_000 },
  { name: "gemini-3.5-flash",       timeoutMs: 45_000 },
  { name: "gemini-3.7-flash",       timeoutMs: 45_000 },
];
```

### Parametres de generation

```js
{
  responseMimeType: "application/json",
  temperature: 0.0  // Extraction deterministe
}
```

### Streaming

Le prompt est passe via `systemInstruction` (cache par Gemini, non compte dans les tokens de l'input utilisateur).

Le streaming utilise `generateContentStream()` avec un timeout uniquement sur le 1er chunk :
- Si le 1er chunk n'arrive pas dans le delai → echec → modele suivant
- Des que le 1er chunk arrive → pas de timeout → le stream finit naturellement

### Pourquoi Pro est lent

Le modele Pro traite des images haute resolution (BS, factures, ordonnances). Avec 4-8 images par dossier, le traitement prend 40-180 secondes. C'est incompressible : la qualite des resultats est directement liee au temps de traitement. Flash est plus rapide mais perd des details sur les dossiers complexes.

---

## Securite

### Authentification admin

- Header `X-Admin-Key` ou query param `?admin_key=`
- En dev (pas de `ADMIN_KEY` configuree) : acces libre
- En production : obligatoire

### CORS

Active globalement via `cors()` middleware Hono.

### Cles API

- `GEMINI_API_KEY` — Stockee dans Cloudflare Workers secrets (jamais en clair dans le code)
- `ADMIN_KEY` — Idem

### Protection des donnees

- Les images ne sont PAS stockees — uniquement le JSON extrait
- Les cles API des providers sont stockees en D1 (dans `ocr_providers.api_key`)
- Soft delete sur la nomenclature (`deleted_at`)

---

## Performance

### Metriques typiques

| Metrique | Valeur |
|----------|--------|
| Duree analyse (Pro, 4 images) | 60-180s |
| Duree analyse (Flash, 1 image) | 10-30s |
| Taille JSON sortie | 5-50 KB |
| Post-traitement (`postProcess`) | < 5ms |
| Enrichissement nomenclature D1 | < 10ms |
| Selection few-shot D1 | < 5ms |

### Optimisations implementees

- Conversion base64 par chunks de 8KB (evite O(n^2))
- Streaming Gemini avec timeout sur 1er chunk uniquement
- Map pre-calcule `totauxParType` dans postProcess
- Index D1 partiels pour few-shot et nomenclature
- `sameName()` fast path pour noms identiques

---

## Deploiement

### Pre-requis

1. Compte Cloudflare avec Workers et D1 actives
2. Wrangler CLI configure (`wrangler login`)
3. Bases D1 creees (`wrangler d1 create bulletins-db`)
4. Secrets configures (`wrangler secret put GEMINI_API_KEY`)

### Processus

```bash
# 1. Tester en local
npm run dev

# 2. Lancer les tests
node --test test/

# 3. Deployer en staging
npx wrangler deploy --env staging

# 4. Tester en staging (via curl ou front)
curl -X POST https://ocr-api-bh-assurance-staging.votre-compte.workers.dev/analyse-bulletin \
  -F "files=@bulletin.jpg"

# 5. Deployer en production
npx wrangler deploy --env prod
```

### Migrations D1

Les migrations sont automatiques : `initDB()` cree les tables et ajoute les colonnes manquantes a chaque demarrage du Worker. Pas besoin de scripts de migration manuels.

---

## Historique des versions

| Version | Description |
|---------|-------------|
| v4.2.0 | Alerte codes CNAM non trouves dans la nomenclature (observation sur l'acte) |
| v4.1.0 | Equipe chirurgicale, accouchement, ventilation PEC, controles C12-C16 |
| v4.0 | Identite imprimee, rubriques CNAM, nomenclature, few-shot learning |
| v3.0 | Post-traitement deterministe, 15 verrous, fusion pharmacie |
| v2.0 | Multi-documents, croisement automatique, detection CNAM |
| v1.0 | OCR simple, extraction basique |
