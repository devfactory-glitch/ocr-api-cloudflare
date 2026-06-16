# API OCR BH Assurance

API d'extraction OCR de bulletins de soins BH Assurance, deployee sur **Cloudflare Workers** avec **Gemini AI** pour l'analyse d'images.

## Stack technique

- **Runtime** : Cloudflare Workers
- **Framework** : [Hono](https://hono.dev/)
- **IA** : Google Gemini (gemini-3.1-flash-lite-preview)
- **Deploiement** : Wrangler CLI

## Installation

```bash
# Cloner le projet
git clone https://github.com/devfactory-ai/ocr-api-cloudflare.git
cd ocr-api-cloudflare

# Installer les dependances
npm install
```

## Configuration

Creer un fichier `.env` a la racine du projet :

```env
GEMINI_API_KEY=votre_cle_api_gemini
```

## Lancer en local

```bash
# Port par defaut (8787)
npm run dev

# Port personnalise
npx wrangler dev --port 8000
```

## Deployer sur Cloudflare

```bash
npm run deploy
```

## Endpoints

### `GET /`

Status de l'API.

**Reponse :**
```json
{ "message": "API OCR BH Assurance active" }
```

---

### `POST /analyse-bulletin`

Analyse un ou plusieurs images de bulletin de soins. Retourne les informations de l'adherent et le volet medical.

**Request :** `multipart/form-data`
- `files` : une ou plusieurs images (JPEG, PNG)

**Reponse :**
```json
{
  "success": true,
  "nombre_fichiers": 1,
  "resultat": {
    "infos_adherent": {
      "nom_prenom": "...",
      "numero_contrat": "...",
      "numero_bulletin": "...",
      "adresse": "...",
      "beneficiaire_coche": "...",
      "date_signature": "..."
    },
    "volet_medical": [
      {
        "date_acte": "...",
        "nature_acte": "...",
        "montant_honoraires": "...",
        "montant_facture": "...",
        "nom_praticien": "...",
        "matricule_fiscale": "..."
      }
    ]
  }
}
```

**Exemple avec curl :**
```bash
curl -X POST http://localhost:8000/analyse-bulletin \
  -F "files=@bulletin_page1.jpg" \
  -F "files=@bulletin_page2.jpg"
```

---

### `POST /ocr`

OCR complet avec extraction structuree detaillee. Retourne toutes les informations du document : adherent, assurance, actes medicaux, pharmacie, totaux et observations.

**Request :** `multipart/form-data`
- `file` : une seule image (JPEG, PNG)

**Reponse :**
```json
{
  "success": true,
  "resultat": {
    "infos_adherent": {
      "nom_prenom": "...",
      "numero_contrat": "...",
      "numero_bulletin": "...",
      "numero_matricule": "...",
      "date_naissance": "...",
      "adresse": "...",
      "telephone": "...",
      "email": "...",
      "employeur": "...",
      "lien_beneficiaire": "...",
      "beneficiaire_coche": "...",
      "date_signature": "..."
    },
    "infos_assurance": {
      "nom_assurance": "...",
      "numero_police": "...",
      "categorie": "...",
      "date_effet": "...",
      "date_expiration": "...",
      "taux_couverture": "..."
    },
    "volet_medical": [
      {
        "date_acte": "...",
        "nature_acte": "...",
        "description_acte": "...",
        "code_acte": "...",
        "montant_honoraires": "...",
        "montant_facture": "...",
        "montant_rembourse": "...",
        "reste_a_charge": "...",
        "nom_praticien": "...",
        "specialite_praticien": "...",
        "matricule_fiscale": "...",
        "nom_etablissement": "...",
        "adresse_etablissement": "...",
        "numero_facture": "...",
        "date_facture": "..."
      }
    ],
    "pharmacie": [
      {
        "nom_medicament": "...",
        "quantite": "...",
        "prix_unitaire": "...",
        "montant_total": "...",
        "nom_pharmacie": "...",
        "date_achat": "...",
        "numero_facture": "..."
      }
    ],
    "totaux": {
      "total_honoraires": "...",
      "total_factures": "...",
      "total_rembourse": "...",
      "total_reste_a_charge": "..."
    },
    "observations": "..."
  }
}
```

**Exemple avec curl :**
```bash
curl -X POST http://localhost:8000/ocr \
  -F "file=@bulletin.jpg"
```

---

### `GET /docs`

Interface Swagger UI interactive pour tester les endpoints.

### `GET /openapi.json`

Specification OpenAPI 3.0 de l'API.

## Structure du projet

```
ocr-api-cloudflare/
  src/
    index.js        # Code principal de l'API
  wrangler.toml     # Configuration Cloudflare Workers
  package.json
  .env              # Variables d'environnement (non commite)
  .gitignore
```

## Gestion des erreurs

Tous les endpoints retournent un format uniforme en cas d'erreur :

```json
{
  "success": false,
  "erreur": "Description de l'erreur"
}
```

| Code | Description |
|------|-------------|
| 200  | Extraction reussie |
| 422  | Aucun fichier envoye |
| 500  | Erreur interne du serveur |
