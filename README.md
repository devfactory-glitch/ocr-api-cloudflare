# API OCR Assurance Maladie Tunisie

API d'extraction OCR intelligente pour les dossiers medicaux d'assurance maladie en Tunisie.
Analyse les bulletins de soins, ordonnances, factures et pieces justificatives via **Google Gemini** avec auto-correction croisee multi-documents.

## Stack technique

**Cloudflare Workers** + **Hono** + **Gemini AI** + **Cloudflare D1** (SQLite) — JavaScript ES Modules

## Demarrage rapide

```bash
git clone https://github.com/devfactory-ai/ocr-api-cloudflare.git
cd ocr-api-cloudflare
npm install
npm run dev          # http://localhost:8787
```

**Prerequis** : Node.js >= 18, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), cle API Gemini.

### Variables d'environnement

| Variable | Description | Obligatoire |
|----------|-------------|:-----------:|
| `GEMINI_API_KEY` | Cle API Google Generative AI | Oui |
| `ADMIN_KEY` | Cle d'acces admin (`X-Admin-Key`) | Prod uniquement |

### Deploiement

```bash
npx wrangler deploy --env staging    # staging
npx wrangler deploy --env prod       # production
node --test test/                    # 159 tests
```

| Env | Worker | D1 |
|-----|--------|----|
| dev | `ocr-api-bh-assurance-dev` | `bulletins-db-dev` |
| staging | `ocr-api-bh-assurance-staging` | `bulletins-db` |
| prod | `ocr-api-bh-assurance` | `bulletins-db-prod` |

## Comment ca marche

```
Images (BS + justificatifs)
    |
    v
Gemini OCR  ------>  enrichActesFromContext()  --->  enrichWithNomenclature()  --->  postProcess()
 (IA)                (croisement pieces)             (codes CNAM D1)                (15 verrous)
    |                                                                                    |
    +--- few-shot (max 3 exemples corriges depuis D1)                               JSON final
```

1. Les images sont envoyees a **Gemini Pro** (failover : Pro > Flash 3.5 > Flash 3.7)
2. Le JSON brut passe par **3 couches de post-traitement deterministe**
3. Les corrections humaines alimentent le **few-shot learning** pour les analyses suivantes

## Endpoints principaux

| Methode | Route | Description |
|---------|-------|-------------|
| `POST` | `/analyse-bulletin` | **Analyse OCR multi-documents** (endpoint principal) |
| `POST` | `/ocr` | OCR simple (un seul document) |
| `POST` | `/valider` | Validation / correction humaine |
| `GET` | `/bulletins` | Historique des bulletins |
| `GET` | `/admin` | Dashboard d'administration |
| `GET` | `/docs` | Swagger UI |

### Exemple

```bash
curl -X POST https://votre-api.workers.dev/analyse-bulletin \
  -F "files=@bulletin_recto.jpg" \
  -F "files=@bulletin_verso.jpg" \
  -F "files=@ordonnance.jpg" \
  -F "files=@facture.jpg"
```

Le parametre `mode=batch` permet de traiter chaque fichier comme un BS independant en parallele.

## Structure du projet

```
src/
  index.js          Point d'entree — routes, Gemini failover, few-shot, enrichissement
  prompt.js         Prompt OCR specialise (~1500 lignes, 20+ regles metier)
  postprocess.js    15 verrous de correction deterministe post-OCR
  admin.js          Dashboard admin, gestion bulletins/providers/nomenclature
  stats.js          Logging et statistiques D1
test/               159 tests unitaires (postprocess)
wrangler.toml       Configuration Cloudflare Workers (dev/staging/prod)
```

## Documentation detaillee

| Document | Contenu |
|----------|---------|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Architecture technique, pipeline, modules, post-traitement, few-shot, schema JSON, performance, deploiement |
| **[docs/API.md](docs/API.md)** | Reference API complete — tous les endpoints avec exemples curl et reponses |

## Licence

ISC
