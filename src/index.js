// src/index.js
// API OCR Assurance Maladie Tunisie — Cloudflare Workers + Hono
// Inclut la plateforme d'administration, D1 et l'OCR avancé multi-documents

import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "./admin.js"; // À supposer existant dans votre dossier
import { logUsageEvent } from "./stats.js"; // À supposer existant dans votre dossier
import { PROMPT, PROMPT_DOSSIER } from "./prompt.js";
import { postProcess } from "./postprocess.js";

const app = new Hono();
app.use("/*", cors());

// ─────────────────────────────────────────────
// Initialisation automatique des tables D1
// ─────────────────────────────────────────────
let dbInitialized = false;

async function initDB(db) {
  if (dbInitialized || !db) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS bulletins_valides (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        donnees_ia            TEXT    NOT NULL,
        donnees_corrigees     TEXT,
        assureur              TEXT,
        types_actes           TEXT    NOT NULL DEFAULT '[]',
        est_exemple_fewshot   INTEGER NOT NULL DEFAULT 0,
        statut_validation     TEXT    NOT NULL DEFAULT 'en_attente',
        erreurs_signalees     TEXT    NOT NULL DEFAULT '[]',
        commentaires_correction TEXT  NOT NULL DEFAULT '',
        created_at            DATETIME DEFAULT (datetime('now')),
        updated_at            DATETIME
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS usage_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint      TEXT    NOT NULL,
        provider      TEXT,
        status        TEXT    NOT NULL,
        nb_fichiers   INTEGER NOT NULL DEFAULT 1,
        duree_ms      INTEGER,
        error_message TEXT,
        fewshot_count INTEGER NOT NULL DEFAULT 0,
        created_at    DATETIME DEFAULT (datetime('now'))
      )`),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at DESC)`,
      ),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_status ON usage_logs(status)`,
      ),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_endpoint ON usage_logs(endpoint)`,
      ),
      db.prepare(`CREATE TABLE IF NOT EXISTS ocr_providers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nom         TEXT    NOT NULL UNIQUE,
        type        TEXT    NOT NULL,
        api_key     TEXT,
        modele      TEXT,
        est_actif   INTEGER NOT NULL DEFAULT 1,
        config_json TEXT    NOT NULL DEFAULT '{}',
        created_at  DATETIME DEFAULT (datetime('now')),
        updated_at  DATETIME DEFAULT (datetime('now'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS nomenclature_cnam (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        code                  TEXT    UNIQUE,
        famille               TEXT    NOT NULL,
        designation           TEXT    NOT NULL,
        lettre_cle            TEXT,
        cotation              REAL,
        lettre_cle_2          TEXT,
        cotation_2            REAL,
        forfait_conventionnel REAL,
        accord_prealable      INTEGER NOT NULL DEFAULT 0,
        deleted_at            DATETIME,
        created_at            DATETIME DEFAULT (datetime('now'))
      )`),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_nomenclature_code ON nomenclature_cnam(code) WHERE deleted_at IS NULL`,
      ),
    ]);
    // Migrations : ajouter les nouvelles colonnes sur tables existantes (ignore si déjà présentes)
    const migrations = [
      `ALTER TABLE bulletins_valides ADD COLUMN donnees_corrigees TEXT`,
      `ALTER TABLE bulletins_valides ADD COLUMN assureur TEXT`,
      `ALTER TABLE bulletins_valides ADD COLUMN types_actes TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE bulletins_valides ADD COLUMN est_exemple_fewshot INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE bulletins_valides ADD COLUMN updated_at DATETIME`,
      `ALTER TABLE usage_logs ADD COLUMN fewshot_count INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of migrations) {
      try { await db.prepare(sql).run(); } catch { /* colonne existe déjà */ }
    }
    // Index few-shot (après les migrations pour que la colonne existe)
    try {
      await db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_fewshot ON bulletins_valides(est_exemple_fewshot) WHERE est_exemple_fewshot = 1`
      ).run();
    } catch { /* index existe déjà ou colonne pas prête */ }
    dbInitialized = true;
  } catch (e) {
    console.error("DB init error:", e.message);
  }
}

app.use("/*", async (c, next) => {
  if (c.env.DB) await initDB(c.env.DB);
  return next();
});

// Monter la plateforme d'administration
app.route("/admin", admin);

// ─────────────────────────────────────────────
// ENRICHISSEMENT NOMENCLATURE CNAM (post-OCR)
// Pour chaque acte MEDECIN/RADIOLOGIE/LABORATOIRE, cherche le code CNAM
// dans la table nomenclature_cnam et enrichit avec les données de référence.
// ─────────────────────────────────────────────
const CNAM_CODE_PATTERN = /^[A-Z]{2,3}\d{6,}$/;

async function enrichWithNomenclature(db, data) {
  if (!db || !data?.actes_independants) return data;

  const typesEligibles = ["MEDECIN", "RADIOLOGIE", "LABORATOIRE", "HOSPITALISATION"];
  const QUERY = "SELECT code, famille, designation, lettre_cle, cotation, lettre_cle_2, cotation_2, forfait_conventionnel, accord_prealable FROM nomenclature_cnam WHERE code = ? AND deleted_at IS NULL";

  function buildMatch(row) {
    return {
      code: row.code,
      famille: row.famille || "",
      designation: row.designation,
      lettre_cle: row.lettre_cle || "",
      cotation: row.cotation != null ? row.cotation : "",
      forfait_conventionnel: row.forfait_conventionnel != null ? row.forfait_conventionnel : null,
      accord_prealable: !!row.accord_prealable,
    };
  }

  for (const acte of data.actes_independants) {
    if (!typesEligibles.includes(acte.type)) continue;

    // Collecter les codes CNAM depuis details_lignes
    const codesFromDetails = [];
    if (Array.isArray(acte.details_lignes)) {
      for (const ligne of acte.details_lignes) {
        const code = ligne.code_acte || "";
        if (CNAM_CODE_PATTERN.test(code)) {
          codesFromDetails.push({ ligne, code });
        }
      }
    }

    // Code depuis accord_prealable_details.code_intervention
    const codeIntervention = acte.accord_prealable_details?.code_intervention || "";
    const hasCodeIntervention = CNAM_CODE_PATTERN.test(codeIntervention);

    // Lookup pour chaque code trouvé dans details_lignes
    let enrichedFromDetails = false;
    for (const { ligne, code } of codesFromDetails) {
      try {
        const row = await db.prepare(QUERY).bind(code).first();
        if (row) {
          ligne.matched_nomenclature = buildMatch(row);
          if (!acte.lettre_cle && row.lettre_cle) acte.lettre_cle = row.lettre_cle;
          if (!acte.cotation && row.cotation) acte.cotation = String(row.cotation);
          enrichedFromDetails = true;
        }
      } catch (e) { console.error("nomenclature lookup error:", e.message); }
    }

    // Enrichir depuis code_intervention si aucun details_lignes n'a été enrichi
    if (hasCodeIntervention && !enrichedFromDetails) {
      try {
        const row = await db.prepare(QUERY).bind(codeIntervention).first();
        if (row) {
          const match = buildMatch(row);
          // Enrichir le premier details_lignes s'il existe
          const target = Array.isArray(acte.details_lignes) && acte.details_lignes.length > 0
            ? acte.details_lignes[0]
            : null;
          if (target) {
            target.matched_nomenclature = match;
            if (!target.code_acte) target.code_acte = row.code;
          }
          // Remonter au niveau de l'acte pour le front
          if (!acte.code_acte) acte.code_acte = row.code;
          if (!acte.lettre_cle && row.lettre_cle) acte.lettre_cle = row.lettre_cle;
          if (!acte.cotation && row.cotation) acte.cotation = String(row.cotation);
          acte.matched_nomenclature = match;
        }
      } catch (e) { console.error("nomenclature intervention lookup error:", e.message); }
    }
  }

  return data;
}

// ─────────────────────────────────────────────
// POST-TRAITEMENT : enrichir les actes promus avec le nom d'intervention
// Croise actes_independants ↔ pieces_justificatives ↔ hospitalisation
// Principe : si "acte" d'un acte promu est extrait du rôle dans libelle_origine
// (ex: "LAABIDI Béchir (Chirurgien)" → acte: "Chirurgien"), c'est un rôle,
// pas un nom d'intervention. On le remplace par la source autoritaire.
// ─────────────────────────────────────────────

function enrichActesFromContext(data) {
  if (!data?.actes_independants) return data;

  const actes = data.actes_independants;
  const pieces = data.pieces_justificatives || [];

  // Indexer les hospitalisations par position
  const hospiByIndex = {};
  actes.forEach((a, idx) => {
    if (a.type === "HOSPITALISATION") hospiByIndex[idx] = a;
  });

  // Extraire les infos des lettres confidentielles rattachées
  // { hospiIndex → { intervention, chirurgien } }
  const lcByHospiIndex = {};
  for (const piece of pieces) {
    if (piece.type_piece !== "LETTRE_CONFIDENTIELLE") continue;
    const rattach = piece.rattachement_acte;
    if (rattach == null) continue;

    const lc = piece.contenu?.lettre_confidentielle;
    if (!lc) continue;

    const intervention = (lc.acte_realise || lc.motif || lc.intervention || "").trim();
    const chirurgien = (lc.chirurgien || piece.praticien || "").trim().toLowerCase();

    if (intervention) {
      lcByHospiIndex[rattach] = { intervention, chirurgien };
    }
  }

  // Enrichir le motif de l'hospitalisation depuis la lettre confidentielle
  for (const [idxStr, lc] of Object.entries(lcByHospiIndex)) {
    const idx = parseInt(idxStr);
    if (hospiByIndex[idx] && !hospiByIndex[idx].motif?.trim()) {
      hospiByIndex[idx].motif = lc.intervention;
    }
  }

  // Pour chaque acte promu : détecter si "acte" est un rôle extrait de libelle_origine
  for (const acte of actes) {
    if (acte.rattachement_hospitalisation == null) continue;
    if (!acte.acte && !acte.libelle_origine) continue;

    const hospiIdx = acte.rattachement_hospitalisation;
    const acteVal = (acte.acte || "").trim();
    const acteNorm = acteVal.toLowerCase();

    // Détection sans hardcode : le rôle est la partie entre parenthèses de libelle_origine
    // ex: "LAABIDI Béchir (Chirurgien)" → rôle = "chirurgien"
    const libelleOrigine = (acte.libelle_origine || "").trim();
    const roleMatch = libelleOrigine.match(/\(([^)]+)\)/);
    const roleFromLibelle = roleMatch ? roleMatch[1].trim().toLowerCase() : "";

    // "acte" est un rôle SI :
    // a) il correspond au rôle extrait de libelle_origine, OU
    // b) il est vide
    const isRole = acteNorm === "" ||
      (roleFromLibelle && acteNorm === roleFromLibelle);

    if (!isRole) continue; // l'IA a mis un vrai nom d'intervention → ne pas écraser

    // Chercher le nom d'intervention — source autoritaire
    const lc = lcByHospiIndex[hospiIdx];
    const hospiMotif = hospiByIndex[hospiIdx]?.motif || "";

    if (lc) {
      // La LC concerne le chirurgien. Vérifier si cet acte promu est du même praticien.
      const praticienNorm = (acte.praticien || "").toLowerCase();
      const estChirurgien = lc.chirurgien &&
        (praticienNorm.includes(lc.chirurgien.split(" ").pop()) ||
         lc.chirurgien.includes(praticienNorm.split(" ").pop()));

      if (estChirurgien) {
        // C'est le chirurgien de la LC → acte = intervention de la LC
        acte.acte = lc.intervention;
      } else if (hospiMotif) {
        // Autre praticien (anesthésiste, etc.) → utiliser le motif hospi comme contexte
        // mais garder le rôle car l'anesthésiste ne fait pas la circoncision
        // → ne pas écraser, laisser le rôle (c'est l'info la plus juste pour ce praticien)
      }
    } else if (hospiMotif) {
      // Pas de LC mais hospitalisation a un motif → utiliser pour le chirurgien principal
      acte.acte = hospiMotif;
    }
  }

  return data;
}


// ─────────────────────────────────────────────
// PROMPT CLASSIQUE / SIMPLE
// Utilisé pour la route POST /ocr (un fichier)
// ─────────────────────────────────────────────
const OCR_PROMPT = `Tu es une IA spécialisée dans le traitement OCR de documents de santé Tunisiens.
Analyse ce document (peut être une ordonnance, note labo, etc.). 
Extrais un maximum d'informations et réponds sous le format de l'API demandée (structuration classique et générique).
Privilégie les cachets. Fais attention à la typographie tunisienne.
Réponds exclusivement en JSON structuré (infos_assurance, details, dates, etc.), selon ton propre format lisible sans balises.`;

// ─────────────────────────────────────────────
// Helpers Techniques
// ─────────────────────────────────────────────
async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Conversion par chunks de 8KB — évite le O(n²) de la concaténation char par char
  const CHUNK = 8192;
  const chunks = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(chunks.join(""));
}

// ─────────────────────────────────────────────
// Few-shot : sélection d'exemples corrigés pour injection dans Gemini
// ─────────────────────────────────────────────
async function getFewShotExamples(db) {
  try {
    if (!db) return [];
    const rows = await db.prepare(
      `SELECT donnees_corrigees, donnees_ia, assureur, types_actes
       FROM bulletins_valides
       WHERE est_exemple_fewshot = 1 AND statut_validation IN ('valide', 'corrige')
       ORDER BY updated_at DESC LIMIT 10`
    ).all();

    if (!rows.results || rows.results.length === 0) return [];

    // Diversifier : max 3 exemples avec assureurs/types différents
    const selected = [];
    const seenKeys = new Set();
    for (const row of rows.results) {
      const key = `${row.assureur || ''}|${row.types_actes || '[]'}`;
      if (seenKeys.has(key) && selected.length > 0) continue;
      seenKeys.add(key);

      const json = row.donnees_corrigees || row.donnees_ia;
      if (!json) continue;

      let parsed;
      try { parsed = JSON.parse(json); } catch { continue; }

      // Trim pour budget tokens : supprimer pieces_justificatives, limiter details_lignes
      if (parsed.pieces_justificatives) delete parsed.pieces_justificatives;
      if (parsed.actes_independants && Array.isArray(parsed.actes_independants)) {
        for (const acte of parsed.actes_independants) {
          if (acte.pieces_justificatives) delete acte.pieces_justificatives;
          if (acte.details_lignes && Array.isArray(acte.details_lignes) && acte.details_lignes.length > 2) {
            acte.details_lignes = acte.details_lignes.slice(0, 2);
          }
        }
      }

      let typesStr = '[]';
      try { typesStr = row.types_actes || '[]'; } catch {}
      const types = JSON.parse(typesStr);
      const desc = `Exemple — BS ${row.assureur || 'inconnu'}, ${parsed.actes_independants?.length || 0} actes ${types.join('/')}`;

      selected.push({ description: desc, json: JSON.stringify(parsed) });
      if (selected.length >= 3) break;
    }

    return selected;
  } catch (err) {
    console.log('getFewShotExamples erreur (dégradation gracieuse):', err.message);
    return [];
  }
}

// Failover multi-modèles : pro (qualité) → flash (rapide) → flash 3.7 (backup)
const GEMINI_MODELS_ORDERED = [
  { name: "gemini-3.1-pro-preview", timeoutMs: 180_000 }, // 180s — modèle qualité (BS + vignettes = lent)
  { name: "gemini-3.5-flash",       timeoutMs: 45_000 },  // 45s
  { name: "gemini-3.7-flash",       timeoutMs: 45_000 },  // 45s
];

// Appel streaming Gemini avec timeout sur le 1er chunk uniquement
// Le prompt est passé en systemInstruction (caché + optimisé par Gemini)
async function callGeminiStream(env, modelName, systemPrompt, imageParts, timeoutMs, fewShotExamples = []) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
  });
  const generationConfig = {
    responseMimeType: "application/json",
    temperature: 0.0,
  };

  // Construire les contents : few-shot (text-only) + requête réelle (avec images)
  const contents = [];
  for (const ex of fewShotExamples) {
    contents.push({ role: "user", parts: [{ text: ex.description }] });
    contents.push({ role: "model", parts: [{ text: ex.json }] });
  }
  contents.push({ role: "user", parts: imageParts });

  const streamResult = await model.generateContentStream({
    contents,
    generationConfig,
  });

  let fullText = "";
  const iterator = streamResult.stream[Symbol.asyncIterator]();

  // Attendre le 1er chunk avec timeout
  const firstChunk = await Promise.race([
    iterator.next(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Pas de réponse après ${timeoutMs / 1000}s`)), timeoutMs)
    ),
  ]);

  if (!firstChunk.done) {
    const part = firstChunk.value.text();
    if (part) fullText += part;
  }

  // 1er chunk reçu → laisser le stream finir sans timeout
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    const part = value.text();
    if (part) fullText += part;
  }

  return fullText;
}

async function generateWithFallback(env, systemPrompt, imageParts, fewShotExamples = []) {
  const errors = [];

  for (const { name: modelName, timeoutMs } of GEMINI_MODELS_ORDERED) {
    try {
      console.log(`Essai ${modelName} (premier chunk max ${timeoutMs / 1000}s)...`);
      const start = Date.now();
      const text = await callGeminiStream(env, modelName, systemPrompt, imageParts, timeoutMs, fewShotExamples);

      if (text && text.trim().length > 10) {
        console.log(`${modelName} — OK en ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return {
          response: { text: () => text },
          modelUsed: modelName,
        };
      }
      errors.push(`${modelName}: réponse vide`);
    } catch (err) {
      const msg = err.message || "";
      errors.push(`${modelName}: ${msg.substring(0, 80)}`);
      console.log(`${modelName} échoué: ${msg.substring(0, 80)}`);
      continue; // Passer au modèle suivant immédiatement
    }
  }

  throw new Error(`Tous les modèles ont échoué: ${errors.join(" | ")}`);
}

// ─────────────────────────────────────────────
// Routes Publiques & Swagger (docs)
// ─────────────────────────────────────────────
app.get("/", (c) => {
  return c.json({
    message: "API OCR BH Assurance (Intelligente)",
    version: "4.1.0", // version upgradée grâce aux auto-corrections !
    endpoints: [
      "POST /analyse-bulletin (MULTI-DOC, Structure complète IA avec correction automatique)",
      "POST /ocr (SIMPLIFIÉ pour 1 seul fichier manuel)",
      "POST /valider",
      "GET  /bulletins",
      "GET  /bulletins/:id",
      "GET  /admin  (tableau de bord)",
      "GET  /docs   (Swagger UI)",
    ],
  });
});

app.get("/openapi.json", (c) => {
  return c.json({
    openapi: "3.0.3",
    info: {
      title: "API OCR BH Assurance (Intelligente)",
      description:
        "API d'extraction OCR de dossiers médicaux avec auto-correction croisée et séparation médecins/radiologie via Gemini AI 1.5.",
      version: "4.1.0",
    },
    paths: {
      "/": {
        get: {
          summary: "Statut de l'API",
          responses: { 200: { description: "API active" } },
        },
      },
      "/analyse-bulletin": {
        post: {
          summary:
            "Analyser un Dossier de soins Complet (IA Avancée Multi-docs)",
          description:
            "Envoie plusieurs images (bulletin, tickets de caisse, labo) pour extraction OCR et croisement d'auto-correction automatique.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: { type: "string", format: "binary" },
                      description:
                        "Images (Bulletin, Ordonnance, Facture, Pharmacie, Labo) au format JPEG/PNG",
                    },
                  },
                  required: ["files"],
                },
              },
            },
          },
          responses: {
            200: {
              description:
                "Données croisées, catégorisées et corrigées extraites par l'IA",
            },
            422: { description: "Aucun fichier envoyé" },
            500: { description: "Erreur serveur / Erreur OCR" },
          },
        },
      },
      "/ocr": {
        post: {
          summary: "OCR Simple Manuel",
          description:
            "Envoie 1 SEULE image et retourne l'information générique de celle-ci.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "Fichier Unique (JPEG/PNG)",
                    },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: { 200: { description: "JSON brut de la photo unique" } },
        },
      },
      "/valider": {
        post: {
          summary: "Valider ou Corriger en D1 Database",
          description:
            "Permet de renvoyer le JSON corrigé par le superviseur humain.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    donnees_ia: { type: "object" },
                    metadata_validation: {
                      type: "object",
                      properties: {
                        statut_validation: {
                          type: "string",
                          example: "valide",
                        },
                        erreurs_signalees: {
                          type: "array",
                          items: { type: "string" },
                        },
                        commentaires_correction: { type: "string" },
                      },
                      required: ["statut_validation"],
                    },
                  },
                  required: ["donnees_ia", "metadata_validation"],
                },
              },
            },
          },
          responses: { 200: { description: "Feedback OK" } },
        },
      },
      "/bulletins": {
        get: {
          summary: "Historique Base D1",
          responses: {
            200: { description: "100 derniers bulletins Validés / Rejetés" },
          },
        },
      },
      "/bulletins/{id}": {
        get: {
          summary: "Détails Validation N°ID",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: { 200: { description: "Details du record SQLite (D1)" } },
        },
      },
    },
  });
});

app.get("/docs", (c) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>API OCR BH Assurance - Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>`;
  return c.html(html);
});

// ─────────────────────────────────────────────
// ROUTE PRINCIPALE DU SYSTÈME -> POST /analyse-bulletin (Smart Extract Multi Docs)
// ─────────────────────────────────────────────
// Analyse un seul dossier (1 ou plusieurs fichiers = 1 BS + justificatifs)
async function analyseSingleDossier(env, files, fewShotExamples) {
  const imageParts = await Promise.all(
    files.map(async (file) => {
      const base64 = await fileToBase64(file);
      return {
        inlineData: { data: base64, mimeType: file.type || "image/jpeg" },
      };
    }),
  );

  const prompt = files.length === 1 ? PROMPT : PROMPT_DOSSIER;
  const result = await generateWithFallback(env, prompt, imageParts, fewShotExamples);
  const text = result.response.text();

  let data = null;
  let parseOk = false;
  try {
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    data = JSON.parse(cleaned);
    parseOk = true;
  } catch {
    /* ignoré */
  }

  if (parseOk && data) {
    // Post-traitement 1 : croiser actes promus ↔ pièces justificatives (déterministe)
    data = enrichActesFromContext(data);
    // Post-traitement 2 : enrichir avec nomenclature CNAM (DB)
    if (env.DB) data = await enrichWithNomenclature(env.DB, data);
    data = postProcess(data);
  }

  return { data, parseOk, text, modelUsed: result.modelUsed };
}

app.post("/analyse-bulletin", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files");
    const mode = formData.get("mode") || "dossier"; // "dossier" (défaut) | "batch"

    if (!files || files.length === 0) {
      return c.json(
        {
          error:
            "Aucun fichier envoyé. Mettez le Bulletin + Pièces Justificatives (Ordos, Pharmacies) dans 'files'",
        },
        422,
      );
    }

    const fewShotExamples = await getFewShotExamples(c.env.DB);

    // ── Mode batch : chaque fichier = 1 BS indépendant, analysé en parallèle ──
    if (mode === "batch") {
      const results = await Promise.all(
        files.map(async (file, idx) => {
          try {
            const r = await analyseSingleDossier(c.env, [file], fewShotExamples);
            return {
              index: idx,
              fichier: file.name || `fichier_${idx}`,
              success: true,
              modele_utilise: r.modelUsed,
              resultat: r.data,
              ...(r.parseOk ? {} : { reponse_brute: r.text, avertissement: "Réponse in-parsable" }),
            };
          } catch (err) {
            return {
              index: idx,
              fichier: file.name || `fichier_${idx}`,
              success: false,
              erreur: err.message,
            };
          }
        }),
      );

      const succeeded = results.filter((r) => r.success).length;

      if (c.env.DB) {
        await logUsageEvent(c.env.DB, {
          endpoint: "/analyse-bulletin",
          provider: "gemini",
          status: succeeded > 0 ? "success" : "error",
          nb_fichiers: files.length,
          duree_ms: Date.now() - startTime,
          fewshot_count: fewShotExamples.length,
        }).catch(() => {});
      }

      return c.json({
        success: true,
        mode: "batch",
        nombre_bulletins: files.length,
        bulletins_traites: succeeded,
        duree_ms: Date.now() - startTime,
        fewshot_count: fewShotExamples.length,
        resultats: results,
      });
    }

    // ── Mode dossier (défaut) : tous les fichiers = 1 seul dossier ──
    const r = await analyseSingleDossier(c.env, files, fewShotExamples);

    if (c.env.DB) {
      await logUsageEvent(c.env.DB, {
        endpoint: "/analyse-bulletin",
        provider: "gemini",
        status: "success",
        nb_fichiers: files.length,
        duree_ms: Date.now() - startTime,
        fewshot_count: fewShotExamples.length,
      }).catch(() => {});
    }

    return c.json({
      success: true,
      mode: "dossier",
      nombre_fichiers: files.length,
      modele_utilise: r.modelUsed,
      duree_ms: Date.now() - startTime,
      fewshot_count: fewShotExamples.length,
      resultat: r.data,
      ...(r.parseOk
        ? {}
        : {
            reponse_brute: r.text,
            avertissement: "Réponse in-parsable côté JS (Gemini a mal formulé)",
          }),
    });
  } catch (err) {
    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/analyse-bulletin",
        provider: "gemini",
        status: "error",
        nb_fichiers: 0,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /ocr - (La Version compatible ancien format, Un Seul Doc Brute)
// N.B: Dans votre code il y avait 2 fois POST /ocr !
// Ils ont été fusionnés en un seul block optimal ci-dessous :
// ─────────────────────────────────────────────
app.post("/ocr", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file) {
      return c.json({ error: "Aucun fichier (file) envoyé." }, 422);
    }

    const base64 = await fileToBase64(file);
    const imagePart = {
      inlineData: { data: base64, mimeType: file.type || "image/jpeg" },
    };

    const result = await generateWithFallback(c.env, OCR_PROMPT, [imagePart]);
    const text = result.response.text();

    let data = null;
    let parseOk = false;
    try {
      const cleaned = text
        .replace(/```json\n?/gi, "")
        .replace(/```\n?/g, "")
        .trim();
      data = JSON.parse(cleaned);
      parseOk = true;
    } catch {
      /* Fallback prévu */
    }

    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "success",
        nb_fichiers: 1,
        duree_ms: Date.now() - startTime,
      }).catch(() => {});

    if (parseOk) {
      return c.json({ success: true, resultat: data });
    } else {
      return c.json({
        success: true,
        resultat: null,
        reponse_brute: text,
        avertissement: "JSON imparfait",
      });
    }
  } catch (err) {
    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "error",
        nb_fichiers: 1,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    return c.json(
      { success: false, erreur: err.message || "Erreur interne OCR" },
      500,
    );
  }
});

// ─────────────────────────────────────────────
// Boucle FEEDBACK VALIDATION D1 (/valider) et FETCH DE TABLES
// ─────────────────────────────────────────────
app.post("/valider", async (c) => {
  try {
    const body = await c.req.json();
    const { donnees_ia, donnees_corrigees, metadata_validation } = body;
    if (!donnees_ia || !metadata_validation)
      return c.json({ success: false, erreur: "JSON attendu mal formé" }, 422);
    const { statut_validation, erreurs_signalees, commentaires_correction } =
      metadata_validation;

    if (!statut_validation)
      return c.json(
        { success: false, erreur: "'statut_validation' est requis" },
        422,
      );

    // Extraire assureur et types_actes automatiquement
    const source = donnees_corrigees || donnees_ia;
    let assureur = '';
    let typesActes = [];
    try {
      const parsed = typeof source === 'string' ? JSON.parse(source) : source;
      assureur = parsed.infos_adherent?.assureur_detecte || parsed.infos_adherent?.assureur || parsed.assureur || '';
      if (parsed.actes_independants && Array.isArray(parsed.actes_independants)) {
        typesActes = [...new Set(parsed.actes_independants.map(a => a.type).filter(Boolean))];
      }
    } catch { /* extraction optionnelle */ }

    const result = await c.env.DB.prepare(
      `INSERT INTO bulletins_valides
       (donnees_ia, donnees_corrigees, assureur, types_actes, statut_validation, erreurs_signalees, commentaires_correction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        JSON.stringify(donnees_ia),
        donnees_corrigees ? JSON.stringify(typeof donnees_corrigees === 'string' ? JSON.parse(donnees_corrigees) : donnees_corrigees) : null,
        assureur,
        JSON.stringify(typesActes),
        statut_validation,
        JSON.stringify(erreurs_signalees || []),
        commentaires_correction || "",
      )
      .run();

    return c.json({
      success: true,
      message: "Feedback ok",
      id: result.meta.last_row_id,
      statut: statut_validation,
      assureur,
      types_actes: typesActes,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// Alias /valider-bulletin → même handler que /valider (compatibilité front)
app.post("/valider-bulletin", async (c) => {
  try {
    const body = await c.req.json();
    const { donnees_ia, donnees_corrigees, metadata_validation } = body;
    if (!donnees_ia || !metadata_validation)
      return c.json({ success: false, erreur: "JSON attendu mal formé" }, 422);
    const { statut_validation, erreurs_signalees, commentaires_correction } =
      metadata_validation;

    if (!statut_validation)
      return c.json({ success: false, erreur: "'statut_validation' est requis" }, 422);

    let assureur = '';
    let typesActes = [];
    const source = donnees_corrigees || donnees_ia;
    try {
      const parsed = typeof source === 'string' ? JSON.parse(source) : source;
      assureur = parsed.infos_adherent?.assureur_detecte || parsed.infos_adherent?.assureur || parsed.assureur || '';
      if (parsed.actes_independants && Array.isArray(parsed.actes_independants)) {
        typesActes = [...new Set(parsed.actes_independants.map(a => a.type).filter(Boolean))];
      }
    } catch { /* extraction optionnelle */ }

    const result = await c.env.DB.prepare(
      `INSERT INTO bulletins_valides
       (donnees_ia, donnees_corrigees, assureur, types_actes, statut_validation, erreurs_signalees, commentaires_correction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        JSON.stringify(donnees_ia),
        donnees_corrigees ? JSON.stringify(typeof donnees_corrigees === 'string' ? JSON.parse(donnees_corrigees) : donnees_corrigees) : null,
        assureur,
        JSON.stringify(typesActes),
        statut_validation,
        JSON.stringify(erreurs_signalees || []),
        commentaires_correction || "",
      )
      .run();

    return c.json({
      success: true,
      message: "Feedback ok",
      id: result.meta.last_row_id,
      statut: statut_validation,
      assureur,
      types_actes: typesActes,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

app.get("/bulletins", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM bulletins_valides ORDER BY created_at DESC LIMIT 100",
    ).all();
    return c.json({ success: true, total: results.length, bulletins: results });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

app.get("/bulletins/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const bulletin = await c.env.DB.prepare(
      "SELECT * FROM bulletins_valides WHERE id = ?",
    )
      .bind(id)
      .first();
    if (!bulletin) return c.json({ success: false, erreur: "Inexistant" }, 404);

    return c.json({
      success: true,
      bulletin: {
        ...bulletin,
        donnees_ia: JSON.parse(bulletin.donnees_ia || "{}"),
        erreurs_signalees: JSON.parse(bulletin.erreurs_signalees || "[]"),
      },
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// Route expérimentale de batch array-files : Demandée conservée intact.
app.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const files = body["images"];
    if (!files) return c.json({ error: "Aucun fichier 'images' posté" }, 400);

    const fileArray = Array.isArray(files) ? files : [files];
    const results = [];

    for (const file of fileArray) {
      if (file instanceof File) {
        // Validation basique de concept (ne lance pas genAi explicitement comme posté ds l'exemple originel)
        results.push({ filename: file.name, status: "processed" });
      }
    }
    return c.json({
      message: "Upload de simulation /test ok",
      count: results.length,
      details: results,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
