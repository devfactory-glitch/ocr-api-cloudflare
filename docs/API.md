# Reference API — OCR Assurance Maladie

Guide complet de tous les endpoints avec exemples de requetes et reponses.

---

## Authentification

Les routes `/admin/*` sont protegees par une cle d'administration.

```bash
# Via header (recommande)
curl -H "X-Admin-Key: votre-cle-secrete" https://api/admin/stats

# Via query param
curl "https://api/admin?admin_key=votre-cle-secrete"
```

En developpement (sans `ADMIN_KEY` configuree), l'acces est libre.

---

## Routes publiques

### `GET /` — Statut de l'API

```bash
curl https://api/
```

```json
{
  "message": "API OCR BH Assurance (Intelligente)",
  "version": "4.1.0",
  "endpoints": [
    "POST /analyse-bulletin (MULTI-DOC, Structure complète IA avec correction automatique)",
    "POST /ocr (SIMPLIFIÉ pour 1 seul fichier manuel)",
    "POST /valider",
    "GET  /bulletins",
    "GET  /bulletins/:id",
    "GET  /admin  (tableau de bord)",
    "GET  /docs   (Swagger UI)"
  ]
}
```

---

### `POST /analyse-bulletin` — Analyse OCR multi-documents

L'endpoint principal du systeme. Accepte un ou plusieurs fichiers image et retourne un JSON structure complet.

#### Parametres

| Champ | Type | Requis | Description |
|-------|------|:------:|-------------|
| `files` | File[] | Oui | Images (JPEG, PNG) du dossier medical |
| `mode` | String | Non | `"dossier"` (defaut) ou `"batch"` |

#### Mode dossier (defaut)

Tous les fichiers sont traites comme un seul dossier medical (1 BS + justificatifs).

```bash
curl -X POST https://api/analyse-bulletin \
  -F "files=@bulletin_recto.jpg" \
  -F "files=@bulletin_verso.jpg" \
  -F "files=@ordonnance.jpg" \
  -F "files=@facture_pharmacie.jpg"
```

**Reponse** :
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
      "numero_contrat": "",
      "numero_cnam": "0833",
      "employeur": "SEPTEO",
      "numero_bulletin": "BS-2026-0456",
      "date_bulletin": "06/07/2026",
      "beneficiaire_coche": "Conjoint",
      "adresse": ""
    },
    "infos_patient": {
      "nom_prenom_malade": "Kefi Raouia"
    },
    "actes_independants": [
      {
        "type": "MEDECIN",
        "acte": "Consultation specialiste",
        "praticien": "Dr Ahmed Ben Salah",
        "matricule_fiscal": "1234567/A",
        "specialite": "Cardiologie",
        "date_acte": "15/06/2026",
        "montant": "80.000",
        "montant_cnam": "0",
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
          {
            "designation": "AMLOR 5MG BT 30",
            "quantite": "2",
            "montant_unitaire": "12.500",
            "montant": "25.000",
            "vignette": "E2"
          }
        ]
      }
    ],
    "cnam": {
      "decompte_present": false
    },
    "pieces_justificatives": [
      {
        "type_piece": "ORDONNANCE",
        "praticien": "Dr Ahmed Ben Salah",
        "date_piece": "15/06/2026",
        "rattachement_acte": 0,
        "contenu": {
          "medicaments": [
            "AMLOR 5MG - 1cp/jour pendant 3 mois",
            "ASPEGIC 100MG - 1 sachet/jour"
          ]
        }
      }
    ],
    "synthese": {
      "total_medecin": "80.000",
      "total_radiologie": "0",
      "total_pharmacie": "231.604",
      "total_laboratoire": "0",
      "total_hospitalisation": "0",
      "total_dentaire": "0",
      "total_optique": "0",
      "total_paramedical": "0",
      "total_global_calcule": "311.604",
      "total_cnam": "0",
      "devise": "DT"
    }
  }
}
```

#### Mode batch

Chaque fichier est traite comme un BS independant, en parallele.

```bash
curl -X POST https://api/analyse-bulletin \
  -F "mode=batch" \
  -F "files=@bulletin1.jpg" \
  -F "files=@bulletin2.jpg" \
  -F "files=@bulletin3.jpg"
```

**Reponse** :
```json
{
  "success": true,
  "mode": "batch",
  "nombre_bulletins": 3,
  "bulletins_traites": 3,
  "duree_ms": 125000,
  "fewshot_count": 1,
  "resultats": [
    {
      "index": 0,
      "fichier": "bulletin1.jpg",
      "success": true,
      "modele_utilise": "gemini-3.1-pro-preview",
      "resultat": { "..." }
    },
    {
      "index": 1,
      "fichier": "bulletin2.jpg",
      "success": true,
      "modele_utilise": "gemini-3.1-pro-preview",
      "resultat": { "..." }
    },
    {
      "index": 2,
      "fichier": "bulletin3.jpg",
      "success": false,
      "erreur": "Tous les modèles ont échoué: ..."
    }
  ]
}
```

---

### `POST /ocr` — OCR simple

Analyse generique d'un seul document. Pas de post-traitement ni d'enrichissement.

```bash
curl -X POST https://api/ocr \
  -F "file=@document.jpg"
```

**Reponse** :
```json
{
  "success": true,
  "resultat": {
    "type_document": "ordonnance",
    "praticien": "Dr Mohamed Ali",
    "date": "10/06/2026",
    "medicaments": [
      "DOLIPRANE 1000MG - 3x/jour",
      "AMOXICILLINE 1G - 2x/jour pendant 7 jours"
    ]
  }
}
```

---

### `POST /valider` — Validation humaine

Enregistre le resultat OCR avec la validation/correction du superviseur.

```bash
curl -X POST https://api/valider \
  -H "Content-Type: application/json" \
  -d '{
    "donnees_ia": { "infos_adherent": { "..." }, "actes_independants": [...] },
    "donnees_corrigees": null,
    "metadata_validation": {
      "statut_validation": "valide",
      "erreurs_signalees": [],
      "commentaires_correction": ""
    }
  }'
```

**Avec correction** :
```bash
curl -X POST https://api/valider \
  -H "Content-Type: application/json" \
  -d '{
    "donnees_ia": { "..." },
    "donnees_corrigees": { "...JSON corrige..." },
    "metadata_validation": {
      "statut_validation": "corrige",
      "erreurs_signalees": ["montant_incorrect", "acte_manquant"],
      "commentaires_correction": "Montant pharmacie etait 231 au lieu de 213"
    }
  }'
```

**Reponse** :
```json
{
  "success": true,
  "message": "Feedback ok",
  "id": 42,
  "statut": "corrige",
  "assureur": "CARTE Assurances",
  "types_actes": ["MEDECIN", "PHARMACIE"]
}
```

---

### `GET /bulletins` — Historique

```bash
curl https://api/bulletins
```

**Reponse** :
```json
{
  "success": true,
  "total": 42,
  "bulletins": [
    {
      "id": 42,
      "donnees_ia": "{...}",
      "donnees_corrigees": "{...}",
      "statut_validation": "corrige",
      "assureur": "CARTE Assurances",
      "types_actes": "[\"MEDECIN\",\"PHARMACIE\"]",
      "est_exemple_fewshot": 1,
      "created_at": "2026-09-15 10:30:00"
    }
  ]
}
```

---

## Routes administration

### `GET /admin/stats` — Statistiques

```bash
curl -H "X-Admin-Key: $KEY" "https://api/admin/stats?depuis=2026-09-01&jusqu_a=2026-09-30"
```

**Reponse** :
```json
{
  "success": true,
  "stats": {
    "global": {
      "total_requetes": 156,
      "total_succes": 148,
      "total_erreurs": 8,
      "total_documents": 523,
      "duree_moyenne_ms": 87500,
      "duree_succes_ms": 82300,
      "taux_succes": 95,
      "taux_erreur": 5
    },
    "par_endpoint": [
      { "endpoint": "/analyse-bulletin", "total": 140, "succes": 135, "erreurs": 5, "documents": 498, "duree_moyenne_ms": 91200 },
      { "endpoint": "/ocr", "total": 16, "succes": 13, "erreurs": 3, "documents": 16, "duree_moyenne_ms": 25000 }
    ],
    "par_provider": [
      { "provider": "gemini", "total": 156, "succes": 148, "erreurs": 8, "duree_moyenne_ms": 87500 }
    ],
    "evolution_30j": [
      { "jour": "2026-09-01", "requetes": 5, "documents": 18, "erreurs": 0 }
    ],
    "validation": [
      { "statut_validation": "valide", "total": 30 },
      { "statut_validation": "corrige", "total": 8 },
      { "statut_validation": "rejete", "total": 2 }
    ],
    "precision": {
      "total": 40,
      "valide_sans_correction": 30,
      "taux_precision": 75,
      "exemples_fewshot": 3
    }
  }
}
```

---

### `GET /admin/bulletins` — Liste paginee

```bash
curl -H "X-Admin-Key: $KEY" "https://api/admin/bulletins?page=1&per_page=20&statut=corrige"
```

---

### `PUT /admin/bulletins/:id/corriger` — Correction humaine

```bash
curl -X PUT -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "https://api/admin/bulletins/42/corriger" \
  -d '{
    "donnees_corrigees": { "infos_adherent": { "..." }, "actes_independants": [...] },
    "erreurs_signalees": ["montant_incorrect"],
    "commentaires_correction": "Total pharmacie corrige"
  }'
```

---

### `PUT /admin/bulletins/:id/valider` — Validation tel quel

```bash
curl -X PUT -H "X-Admin-Key: $KEY" "https://api/admin/bulletins/42/valider"
```

---

### `PUT /admin/bulletins/:id/promouvoir` — Toggle few-shot

```bash
curl -X PUT -H "X-Admin-Key: $KEY" "https://api/admin/bulletins/42/promouvoir"
```

**Reponse** :
```json
{
  "success": true,
  "est_exemple_fewshot": true,
  "message": "Bulletin #42 promu comme exemple few-shot."
}
```

---

### `PUT /admin/bulletins/:id/rejeter` — Rejet

```bash
curl -X PUT -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "https://api/admin/bulletins/42/rejeter" \
  -d '{
    "erreurs_signalees": ["document_illisible"],
    "commentaires_correction": "Scan trop flou"
  }'
```

---

### `GET /admin/exemples-fewshot` — Exemples actifs

```bash
curl -H "X-Admin-Key: $KEY" "https://api/admin/exemples-fewshot"
```

**Reponse** :
```json
{
  "success": true,
  "total": 3,
  "exemples": [
    {
      "id": 42,
      "assureur": "CARTE Assurances",
      "types_actes": "[\"MEDECIN\",\"PHARMACIE\"]",
      "statut_validation": "corrige",
      "created_at": "2026-09-15 10:30:00",
      "updated_at": "2026-09-16 14:20:00"
    }
  ]
}
```

---

### Providers OCR

#### `GET /admin/providers` — Liste

```bash
curl -H "X-Admin-Key: $KEY" "https://api/admin/providers"
```

#### `POST /admin/providers` — Creer/MAJ

Types valides : `google_vision`, `gemini`, `anthropic_claude`, `azure_cv`, `custom`

```bash
curl -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "https://api/admin/providers" \
  -d '{
    "nom": "gemini-pro",
    "type": "gemini",
    "api_key": "AIza...",
    "modele": "gemini-3.1-pro-preview",
    "est_actif": true
  }'
```

#### `POST /admin/providers/:id/tester` — Test connexion

```bash
curl -X POST -H "X-Admin-Key: $KEY" "https://api/admin/providers/1/tester"
```

**Reponse** :
```json
{
  "success": true,
  "provider": "gemini-pro",
  "type": "gemini",
  "test": { "ok": true, "message": "Connexion Gemini API réussie." },
  "duree_ms": 230
}
```

---

### Nomenclature CNAM

#### `GET /admin/nomenclature` — Consulter

```bash
# Toute la nomenclature
curl -H "X-Admin-Key: $KEY" "https://api/admin/nomenclature"

# Filtrer par famille
curl -H "X-Admin-Key: $KEY" "https://api/admin/nomenclature?famille=CHIRURGIE"
```

#### `POST /admin/seed-nomenclature` — Injecter

```bash
curl -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "https://api/admin/seed-nomenclature" \
  -d '{
    "familles": [
      {
        "famille": "CHIRURGIE GENERALE",
        "lettre_cle": "K",
        "actes": [
          { "code_acte": "KC001234", "designation": "Appendicectomie", "cotation": 60 },
          { "code_acte": "KC001235", "designation": "Cholecystectomie", "cotation": 80 }
        ]
      }
    ]
  }'
```

**Reponse** :
```json
{
  "success": true,
  "inserted": 2,
  "updated": 0,
  "total": 2
}
```

---

## Codes d'erreur

| Code | Description |
|:----:|-------------|
| 200 | Succes |
| 201 | Creation reussie (provider) |
| 401 | Acces non autorise (cle admin invalide) |
| 404 | Ressource introuvable (bulletin, provider) |
| 422 | Donnees invalides (fichier manquant, JSON mal forme) |
| 500 | Erreur interne (echec Gemini, erreur D1) |

Format d'erreur uniforme :
```json
{
  "success": false,
  "erreur": "Description de l'erreur"
}
```
