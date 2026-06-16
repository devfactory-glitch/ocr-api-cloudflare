-- schema.sql
-- Base de données D1 pour l'API OCR BH Assurance

-- ──────────────────────────────────────────────────────
-- Table existante : bulletins validés / corrigés
-- ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulletins_valides (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  donnees_ia            TEXT    NOT NULL,
  statut_validation     TEXT    NOT NULL DEFAULT 'en_attente',
  -- Statuts : en_attente | valide | corrige | rejete
  erreurs_signalees     TEXT    NOT NULL DEFAULT '[]',
  commentaires_correction TEXT  NOT NULL DEFAULT '',
  created_at            DATETIME DEFAULT (datetime('now'))
);

-- ──────────────────────────────────────────────────────
-- Nouvelle table : logs d'utilisation (tableau de bord)
-- ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint      TEXT    NOT NULL,          -- /analyse-bulletin, /ocr, /valider…
  provider      TEXT,                      -- gemini, google_vision, anthropic_claude…
  status        TEXT    NOT NULL,          -- success | error
  nb_fichiers   INTEGER NOT NULL DEFAULT 1,
  duree_ms      INTEGER,                   -- durée totale de la requête en ms
  error_message TEXT,                      -- message d'erreur si status=error
  created_at    DATETIME DEFAULT (datetime('now'))
);

-- Index pour les requêtes fréquentes sur les logs
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at  ON usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_status      ON usage_logs(status);
CREATE INDEX IF NOT EXISTS idx_usage_logs_endpoint    ON usage_logs(endpoint);

-- ──────────────────────────────────────────────────────
-- Nouvelle table : configuration des providers OCR
-- ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ocr_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom         TEXT    NOT NULL UNIQUE,
  -- Types supportés : gemini | google_vision | anthropic_claude | azure_cv | custom
  type        TEXT    NOT NULL,
  api_key     TEXT,                 -- clé API stockée (chiffrée côté app si besoin)
  modele      TEXT,                 -- ex: gemini-1.5-flash, claude-3-haiku
  est_actif   INTEGER NOT NULL DEFAULT 1,  -- 1 = actif, 0 = désactivé
  config_json TEXT    NOT NULL DEFAULT '{}',  -- options supplémentaires JSON
  created_at  DATETIME DEFAULT (datetime('now')),
  updated_at  DATETIME DEFAULT (datetime('now'))
);

-- Provider par défaut : Gemini (déjà utilisé dans l'API)
INSERT OR IGNORE INTO ocr_providers (nom, type, modele, est_actif, config_json)
VALUES (
  'Gemini Flash',
  'gemini',
  'gemini-1.5-flash',
  1,
  '{"temperature": 0, "max_output_tokens": 8192}'
);
