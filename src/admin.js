// src/admin.js
// Plateforme d'administration de l'API OCR BH Assurance
// Tableau de bord + Configuration des providers OCR

import { Hono } from "hono";
import { getGlobalStats, getRecentLogs } from "./stats.js";

const admin = new Hono();

// ─────────────────────────────────────────────
// Middleware : protection basique par clé admin
// ─────────────────────────────────────────────
admin.use("/*", async (c, next) => {
  const adminKey = c.env.ADMIN_KEY;
  if (!adminKey) {
    // Pas de clé configurée : accès libre en dev
    return next();
  }

  const authHeader = c.req.header("X-Admin-Key") || c.req.query("admin_key");
  if (authHeader !== adminKey) {
    return c.json({ error: "Accès non autorisé. Fournissez X-Admin-Key valide." }, 401);
  }

  return next();
});

// ─────────────────────────────────────────────
// GET /admin
// Interface HTML du tableau de bord
// ─────────────────────────────────────────────
admin.get("/", async (c) => {
  const html = buildDashboardHTML();
  return c.html(html);
});

// ─────────────────────────────────────────────
// GET /admin/stats
// Statistiques JSON pour le dashboard
// ─────────────────────────────────────────────
admin.get("/stats", async (c) => {
  try {
    const depuis = c.req.query("depuis") || null;
    const jusqu_a = c.req.query("jusqu_a") || null;

    const stats = await getGlobalStats(c.env.DB, { depuis, jusqu_a });
    return c.json({ success: true, stats });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// GET /admin/logs
// Logs d'utilisation paginés
// ─────────────────────────────────────────────
admin.get("/logs", async (c) => {
  try {
    const page = parseInt(c.req.query("page") || "1");
    const per_page = parseInt(c.req.query("per_page") || "50");
    const status = c.req.query("status") || null;
    const endpoint = c.req.query("endpoint") || null;

    const result = await getRecentLogs(c.env.DB, { page, per_page, status, endpoint });
    return c.json({ success: true, ...result });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// GET /admin/providers
// Lister la configuration actuelle des providers
// ─────────────────────────────────────────────
admin.get("/providers", async (c) => {
  try {
    const providers = await c.env.DB
      .prepare("SELECT * FROM ocr_providers ORDER BY est_actif DESC, nom ASC")
      .all();

    return c.json({
      success: true,
      providers: providers.results || [],
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /admin/providers
// Créer ou mettre à jour un provider OCR
// Body: { nom, type, api_key, modele, est_actif, config_json }
// ─────────────────────────────────────────────
admin.post("/providers", async (c) => {
  try {
    const body = await c.req.json();
    const { nom, type, api_key, modele, est_actif = true, config_json = "{}" } = body;

    if (!nom || !type) {
      return c.json({ success: false, erreur: "Les champs 'nom' et 'type' sont requis." }, 422);
    }

    const TYPES_VALIDES = ["google_vision", "gemini", "anthropic_claude", "azure_cv", "custom"];
    if (!TYPES_VALIDES.includes(type)) {
      return c.json({
        success: false,
        erreur: `Type invalide. Types supportés : ${TYPES_VALIDES.join(", ")}`,
      }, 422);
    }

    // Vérifier si ce provider existe déjà
    const existing = await c.env.DB
      .prepare("SELECT id FROM ocr_providers WHERE nom = ?")
      .bind(nom)
      .first();

    let result;
    if (existing) {
      // Mise à jour
      result = await c.env.DB
        .prepare(
          `UPDATE ocr_providers
           SET type = ?, api_key = ?, modele = ?, est_actif = ?, config_json = ?, updated_at = datetime('now')
           WHERE nom = ?`
        )
        .bind(type, api_key || null, modele || null, est_actif ? 1 : 0, config_json, nom)
        .run();

      return c.json({
        success: true,
        action: "mis_a_jour",
        message: `Provider '${nom}' mis à jour avec succès.`,
        id: existing.id,
      });
    } else {
      // Création
      result = await c.env.DB
        .prepare(
          `INSERT INTO ocr_providers (nom, type, api_key, modele, est_actif, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .bind(nom, type, api_key || null, modele || null, est_actif ? 1 : 0, config_json)
        .run();

      return c.json({
        success: true,
        action: "cree",
        message: `Provider '${nom}' créé avec succès.`,
        id: result.meta.last_row_id,
      }, 201);
    }
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// PATCH /admin/providers/:id/activer
// Activer / désactiver un provider
// ─────────────────────────────────────────────
admin.patch("/providers/:id/activer", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const { est_actif } = await c.req.json();

    const provider = await c.env.DB
      .prepare("SELECT id, nom FROM ocr_providers WHERE id = ?")
      .bind(id)
      .first();

    if (!provider) {
      return c.json({ success: false, erreur: "Provider introuvable." }, 404);
    }

    await c.env.DB
      .prepare("UPDATE ocr_providers SET est_actif = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(est_actif ? 1 : 0, id)
      .run();

    return c.json({
      success: true,
      message: `Provider '${provider.nom}' ${est_actif ? "activé" : "désactivé"}.`,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// DELETE /admin/providers/:id
// Supprimer un provider
// ─────────────────────────────────────────────
admin.delete("/providers/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));

    const provider = await c.env.DB
      .prepare("SELECT id, nom FROM ocr_providers WHERE id = ?")
      .bind(id)
      .first();

    if (!provider) {
      return c.json({ success: false, erreur: "Provider introuvable." }, 404);
    }

    await c.env.DB
      .prepare("DELETE FROM ocr_providers WHERE id = ?")
      .bind(id)
      .run();

    return c.json({
      success: true,
      message: `Provider '${provider.nom}' supprimé.`,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /admin/providers/:id/tester
// Teste la connexion d'un provider (ping API)
// ─────────────────────────────────────────────
admin.post("/providers/:id/tester", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));

    const provider = await c.env.DB
      .prepare("SELECT * FROM ocr_providers WHERE id = ?")
      .bind(id)
      .first();

    if (!provider) {
      return c.json({ success: false, erreur: "Provider introuvable." }, 404);
    }

    const startTime = Date.now();
    let testResult = { ok: false, message: "" };

    switch (provider.type) {
      case "gemini": {
        const apiKey = provider.api_key || c.env.GEMINI_API_KEY;
        if (!apiKey) {
          testResult = { ok: false, message: "Clé API Gemini manquante." };
          break;
        }
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
          );
          testResult = resp.ok
            ? { ok: true, message: "Connexion Gemini API réussie." }
            : { ok: false, message: `Erreur ${resp.status}: ${resp.statusText}` };
        } catch (e) {
          testResult = { ok: false, message: e.message };
        }
        break;
      }

      case "anthropic_claude": {
        const apiKey = provider.api_key || c.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          testResult = { ok: false, message: "Clé API Anthropic manquante." };
          break;
        }
        try {
          const resp = await fetch("https://api.anthropic.com/v1/models", {
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
          });
          testResult = resp.ok
            ? { ok: true, message: "Connexion Anthropic Claude réussie." }
            : { ok: false, message: `Erreur ${resp.status}: ${resp.statusText}` };
        } catch (e) {
          testResult = { ok: false, message: e.message };
        }
        break;
      }

      case "google_vision": {
        const apiKey = provider.api_key || c.env.GOOGLE_VISION_API_KEY;
        if (!apiKey) {
          testResult = { ok: false, message: "Clé API Google Vision manquante." };
          break;
        }
        try {
          const resp = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requests: [] }),
            }
          );
          // 400 = clé valide mais requête vide (normal pour un test)
          testResult = resp.status === 400 || resp.ok
            ? { ok: true, message: "Connexion Google Vision API réussie." }
            : { ok: false, message: `Erreur ${resp.status}: ${resp.statusText}` };
        } catch (e) {
          testResult = { ok: false, message: e.message };
        }
        break;
      }

      default:
        testResult = { ok: false, message: `Test non implémenté pour le type '${provider.type}'.` };
    }

    const duree_ms = Date.now() - startTime;

    return c.json({
      success: true,
      provider: provider.nom,
      type: provider.type,
      test: testResult,
      duree_ms,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// GET /admin/bulletins
// Liste les bulletins validés avec filtre
// ─────────────────────────────────────────────
admin.get("/bulletins", async (c) => {
  try {
    const page = parseInt(c.req.query("page") || "1");
    const per_page = parseInt(c.req.query("per_page") || "20");
    const statut = c.req.query("statut") || null;
    const offset = (page - 1) * per_page;

    let filter = "";
    const params = [];
    if (statut) {
      filter = " WHERE statut_validation = ?";
      params.push(statut);
    }

    const countResult = await c.env.DB
      .prepare(`SELECT COUNT(*) as total FROM bulletins_valides${filter}`)
      .bind(...params)
      .first();

    const bulletins = await c.env.DB
      .prepare(
        `SELECT id, statut_validation, erreurs_signalees, commentaires_correction, created_at
         FROM bulletins_valides${filter}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...params, per_page, offset)
      .all();

    return c.json({
      success: true,
      total: countResult.total,
      page,
      per_page,
      pages: Math.ceil(countResult.total / per_page),
      bulletins: bulletins.results || [],
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// HTML du tableau de bord d'administration
// ─────────────────────────────────────────────
function buildDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Administration — OCR BH Assurance</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:       #0b0f1a;
      --surface:  #111827;
      --border:   #1e2d3d;
      --accent:   #00e5ff;
      --accent2:  #7c3aed;
      --success:  #22c55e;
      --warning:  #f59e0b;
      --danger:   #ef4444;
      --text:     #e2e8f0;
      --muted:    #64748b;
      --font-ui:  'Sora', sans-serif;
      --font-mono:'DM Mono', monospace;
    }

    body {
      font-family: var(--font-ui);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: grid;
      grid-template-columns: 240px 1fr;
      grid-template-rows: auto 1fr;
    }

    /* ── Topbar ── */
    .topbar {
      grid-column: 1 / -1;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 2rem;
      height: 60px;
      gap: 1rem;
    }
    .topbar-logo {
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--accent);
    }
    .topbar-logo span { color: var(--text); font-weight: 300; }
    .topbar-badge {
      font-family: var(--font-mono);
      font-size: 0.65rem;
      background: var(--accent2);
      color: #fff;
      padding: 2px 8px;
      border-radius: 20px;
      letter-spacing: 1px;
    }
    .topbar-right {
      margin-left: auto;
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .status-label { font-size: 0.8rem; color: var(--muted); }

    /* ── Sidebar ── */
    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 1.5rem 0;
      position: sticky;
      top: 60px;
      height: calc(100vh - 60px);
      overflow-y: auto;
    }
    .nav-section { margin-bottom: 1.5rem; }
    .nav-label {
      font-size: 0.65rem;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
      padding: 0 1.25rem;
      margin-bottom: 0.5rem;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.65rem 1.25rem;
      cursor: pointer;
      color: var(--muted);
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.15s;
      border-left: 2px solid transparent;
    }
    .nav-item:hover, .nav-item.active {
      color: var(--text);
      background: rgba(0,229,255,0.05);
      border-left-color: var(--accent);
    }
    .nav-item.active { color: var(--accent); }
    .nav-icon { font-size: 1rem; width: 20px; text-align: center; }

    /* ── Main content ── */
    main {
      padding: 2rem;
      overflow-y: auto;
    }

    /* ── Page header ── */
    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 2rem;
    }
    .page-title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.5px; }
    .page-subtitle { color: var(--muted); font-size: 0.875rem; margin-top: 0.25rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: all 0.15s;
    }
    .btn-primary { background: var(--accent); color: var(--bg); }
    .btn-primary:hover { opacity: 0.85; }
    .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
    .btn-ghost:hover { color: var(--text); border-color: var(--accent); }
    .btn-danger { background: rgba(239,68,68,0.15); color: var(--danger); border: 1px solid rgba(239,68,68,0.3); }
    .btn-success-sm { background: rgba(34,197,94,0.15); color: var(--success); border: 1px solid rgba(34,197,94,0.3); padding: 0.25rem 0.6rem; font-size: 0.75rem; }

    /* ── Tabs ── */
    .tabs { display: flex; gap: 0.25rem; margin-bottom: 2rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px; width: fit-content; }
    .tab-btn { padding: 0.5rem 1.25rem; border-radius: 6px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; background: transparent; color: var(--muted); transition: all 0.15s; }
    .tab-btn.active { background: var(--accent); color: var(--bg); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ── KPI Cards ── */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--accent), var(--accent2));
    }
    .kpi-label { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
    .kpi-value { font-size: 2rem; font-weight: 700; font-family: var(--font-mono); margin: 0.5rem 0 0.25rem; color: var(--text); }
    .kpi-sub { font-size: 0.75rem; color: var(--muted); }
    .kpi-success .kpi-value { color: var(--success); }
    .kpi-warning .kpi-value { color: var(--warning); }
    .kpi-danger .kpi-value { color: var(--danger); }

    /* ── Chart area ── */
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
    .chart-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
    }
    .chart-card.full { grid-column: 1 / -1; }
    .chart-title { font-size: 0.875rem; font-weight: 600; margin-bottom: 1rem; color: var(--text); }
    .chart-canvas-wrap { position: relative; height: 220px; }

    /* ── Bar chart simple ── */
    .bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 180px; }
    .bar-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .bar-fill {
      width: 100%;
      background: linear-gradient(180deg, var(--accent), var(--accent2));
      border-radius: 3px 3px 0 0;
      min-height: 2px;
      transition: height 0.6s ease;
    }
    .bar-fill.error { background: linear-gradient(180deg, var(--danger), #7f1d1d); }
    .bar-label { font-size: 0.6rem; color: var(--muted); text-align: center; }
    .bar-val { font-size: 0.65rem; font-family: var(--font-mono); color: var(--accent); }

    /* ── Donut chart (CSS) ── */
    .donut-wrap { display: flex; align-items: center; gap: 2rem; }
    .donut {
      width: 120px; height: 120px;
      border-radius: 50%;
      position: relative;
      flex-shrink: 0;
    }
    .donut-legend { flex: 1; }
    .legend-item { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; font-size: 0.8rem; }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }

    /* ── Table ── */
    .data-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .data-table th {
      text-align: left;
      padding: 0.65rem 1rem;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
    }
    .data-table td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid rgba(30,45,61,0.6);
      vertical-align: middle;
    }
    .data-table tr:hover td { background: rgba(0,229,255,0.03); }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 20px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tag-success { background: rgba(34,197,94,0.15); color: var(--success); }
    .tag-error   { background: rgba(239,68,68,0.15); color: var(--danger); }
    .tag-warning { background: rgba(245,158,11,0.15); color: var(--warning); }
    .tag-info    { background: rgba(0,229,255,0.1); color: var(--accent); }

    /* ── Form / Config ── */
    .config-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .config-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
    .config-title { font-size: 1rem; font-weight: 600; }
    .config-subtitle { font-size: 0.8rem; color: var(--muted); margin-top: 0.2rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .form-group { display: flex; flex-direction: column; gap: 0.4rem; }
    .form-group.full { grid-column: 1 / -1; }
    label { font-size: 0.75rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    input, select, textarea {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 0.85rem;
      padding: 0.6rem 0.9rem;
      width: 100%;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(0,229,255,0.1);
    }
    textarea { resize: vertical; min-height: 80px; }
    .toggle-wrap { display: flex; align-items: center; gap: 0.75rem; }
    .toggle {
      width: 44px; height: 24px;
      background: var(--border);
      border-radius: 12px;
      cursor: pointer;
      position: relative;
      transition: background 0.2s;
    }
    .toggle.on { background: var(--success); }
    .toggle::after {
      content: '';
      width: 18px; height: 18px;
      background: #fff;
      border-radius: 50%;
      position: absolute;
      top: 3px; left: 3px;
      transition: transform 0.2s;
    }
    .toggle.on::after { transform: translateX(20px); }

    /* ── Provider cards ── */
    .providers-list { display: flex; flex-direction: column; gap: 1rem; }
    .provider-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 1.25rem;
    }
    .provider-icon {
      width: 42px; height: 42px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
      background: rgba(0,229,255,0.1);
      flex-shrink: 0;
    }
    .provider-info { flex: 1; }
    .provider-name { font-weight: 600; font-size: 0.95rem; }
    .provider-type { font-size: 0.75rem; color: var(--muted); font-family: var(--font-mono); }
    .provider-actions { display: flex; gap: 0.5rem; align-items: center; }

    /* ── Loading & empty ── */
    .loading { text-align: center; padding: 3rem; color: var(--muted); }
    .loading-spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty-state { text-align: center; padding: 4rem 2rem; color: var(--muted); }
    .empty-icon { font-size: 3rem; margin-bottom: 1rem; }

    /* ── Modal ── */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
      opacity: 0; pointer-events: none;
      transition: opacity 0.2s;
    }
    .modal-overlay.open { opacity: 1; pointer-events: all; }
    .modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      width: 90%;
      max-width: 560px;
      transform: translateY(20px);
      transition: transform 0.2s;
    }
    .modal-overlay.open .modal { transform: translateY(0); }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .modal-title { font-size: 1.1rem; font-weight: 700; }
    .modal-close { background: none; border: none; color: var(--muted); font-size: 1.25rem; cursor: pointer; }
    .modal-footer { display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 1.5rem; }

    /* ── Toast ── */
    .toast-wrap { position: fixed; bottom: 1.5rem; right: 1.5rem; display: flex; flex-direction: column; gap: 0.5rem; z-index: 2000; }
    .toast {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      padding: 0.85rem 1.25rem;
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 280px;
      transform: translateX(120%);
      transition: transform 0.3s ease;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    .toast.show { transform: translateX(0); }
    .toast.success { border-left-color: var(--success); }
    .toast.error   { border-left-color: var(--danger); }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>

  <!-- Topbar -->
  <header class="topbar">
    <div class="topbar-logo">OCR <span>BH Assurance</span></div>
    <span class="topbar-badge">ADMIN</span>
    <div class="topbar-right">
      <div class="status-dot"></div>
      <span class="status-label">API opérationnelle</span>
    </div>
  </header>

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="nav-section">
      <div class="nav-label">Tableau de bord</div>
      <div class="nav-item active" data-section="dashboard" onclick="showSection('dashboard', this)">
        <span class="nav-icon">📊</span> Vue d'ensemble
      </div>
      <div class="nav-item" data-section="logs" onclick="showSection('logs', this)">
        <span class="nav-icon">📋</span> Logs d'utilisation
      </div>
      <div class="nav-item" data-section="bulletins" onclick="showSection('bulletins', this)">
        <span class="nav-icon">📄</span> Bulletins validés
      </div>
    </div>
    <div class="nav-section">
      <div class="nav-label">Configuration</div>
      <div class="nav-item" data-section="providers" onclick="showSection('providers', this)">
        <span class="nav-icon">⚙️</span> Providers OCR
      </div>
    </div>
  </nav>

  <!-- Main -->
  <main>

    <!-- ── Section: Dashboard ── -->
    <section id="section-dashboard" class="tab-panel active">
      <div class="page-header">
        <div>
          <div class="page-title">Vue d'ensemble</div>
          <div class="page-subtitle">Statistiques d'utilisation en temps réel</div>
        </div>
        <div style="display:flex;gap:0.5rem">
          <select id="period-select" class="btn btn-ghost" onchange="loadStats()" style="cursor:pointer">
            <option value="">Toute la période</option>
            <option value="7">7 derniers jours</option>
            <option value="30" selected>30 derniers jours</option>
            <option value="90">90 derniers jours</option>
          </select>
          <button class="btn btn-primary" onclick="loadStats()">↻ Actualiser</button>
        </div>
      </div>

      <!-- KPI Grid -->
      <div class="kpi-grid" id="kpi-grid">
        <div class="kpi-card">
          <div class="loading"><div class="loading-spinner"></div></div>
        </div>
      </div>

      <!-- Charts -->
      <div class="chart-grid">
        <div class="chart-card full">
          <div class="chart-title">Volume de requêtes — 30 derniers jours</div>
          <div id="bar-chart-wrap" class="bar-chart"></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Taux de succès / erreur</div>
          <div class="donut-wrap" id="donut-wrap">
            <div class="loading"><div class="loading-spinner"></div></div>
          </div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Requêtes par endpoint</div>
          <div id="endpoint-table-wrap"></div>
        </div>
      </div>
    </section>

    <!-- ── Section: Logs ── -->
    <section id="section-logs" class="tab-panel">
      <div class="page-header">
        <div>
          <div class="page-title">Logs d'utilisation</div>
          <div class="page-subtitle">Historique complet des requêtes</div>
        </div>
        <div style="display:flex;gap:0.5rem">
          <select id="log-status-filter" class="btn btn-ghost" onchange="loadLogs()" style="cursor:pointer">
            <option value="">Tous les statuts</option>
            <option value="success">Succès</option>
            <option value="error">Erreur</option>
          </select>
          <select id="log-endpoint-filter" class="btn btn-ghost" onchange="loadLogs()" style="cursor:pointer">
            <option value="">Tous les endpoints</option>
            <option value="/analyse-bulletin">/analyse-bulletin</option>
            <option value="/ocr">/ocr</option>
            <option value="/valider">/valider</option>
          </select>
        </div>
      </div>
      <div class="config-card" style="padding:0;overflow:hidden">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Endpoint</th>
              <th>Provider</th>
              <th>Statut</th>
              <th>Docs</th>
              <th>Durée</th>
              <th>Erreur</th>
            </tr>
          </thead>
          <tbody id="logs-tbody">
            <tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--muted)">Chargement…</td></tr>
          </tbody>
        </table>
      </div>
      <div id="logs-pagination" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem"></div>
    </section>

    <!-- ── Section: Bulletins ── -->
    <section id="section-bulletins" class="tab-panel">
      <div class="page-header">
        <div>
          <div class="page-title">Bulletins validés</div>
          <div class="page-subtitle">Données extraites et corrigées</div>
        </div>
        <select id="bulletin-status-filter" class="btn btn-ghost" onchange="loadBulletins()" style="cursor:pointer">
          <option value="">Tous les statuts</option>
          <option value="en_attente">En attente</option>
          <option value="valide">Validé</option>
          <option value="corrige">Corrigé</option>
          <option value="rejete">Rejeté</option>
        </select>
      </div>
      <div class="config-card" style="padding:0;overflow:hidden">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Date</th>
              <th>Statut</th>
              <th>Erreurs</th>
              <th>Commentaires</th>
            </tr>
          </thead>
          <tbody id="bulletins-tbody">
            <tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--muted)">Chargement…</td></tr>
          </tbody>
        </table>
      </div>
      <div id="bulletins-pagination" style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem"></div>
    </section>

    <!-- ── Section: Providers ── -->
    <section id="section-providers" class="tab-panel">
      <div class="page-header">
        <div>
          <div class="page-title">Configuration des providers OCR</div>
          <div class="page-subtitle">Gérez vos services tiers d'extraction de texte</div>
        </div>
        <button class="btn btn-primary" onclick="openProviderModal()">+ Ajouter un provider</button>
      </div>

      <div class="providers-list" id="providers-list">
        <div class="loading"><div class="loading-spinner"></div><div>Chargement…</div></div>
      </div>
    </section>

  </main>

  <!-- ── Toast ── -->
  <div class="toast-wrap" id="toast-wrap"></div>

  <!-- ── Provider Modal ── -->
  <div class="modal-overlay" id="provider-modal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="modal-title">Nouveau provider OCR</div>
        <button class="modal-close" onclick="closeProviderModal()">✕</button>
      </div>
      <div class="form-grid">
        <div class="form-group">
          <label for="p-nom">Nom</label>
          <input type="text" id="p-nom" placeholder="ex: Gemini Flash" />
        </div>
        <div class="form-group">
          <label for="p-type">Type</label>
          <select id="p-type">
            <option value="">Sélectionner…</option>
            <option value="gemini">Gemini (Google)</option>
            <option value="google_vision">Google Vision API</option>
            <option value="anthropic_claude">Anthropic Claude</option>
            <option value="azure_cv">Azure Computer Vision</option>
            <option value="custom">Custom / Autre</option>
          </select>
        </div>
        <div class="form-group full">
          <label for="p-apikey">Clé API</label>
          <input type="password" id="p-apikey" placeholder="Laisser vide pour utiliser la variable d'env" />
        </div>
        <div class="form-group">
          <label for="p-modele">Modèle</label>
          <input type="text" id="p-modele" placeholder="ex: gemini-1.5-flash" />
        </div>
        <div class="form-group">
          <label>Statut</label>
          <div class="toggle-wrap" style="padding-top:0.35rem">
            <div class="toggle on" id="p-toggle" onclick="toggleProvider(this)"></div>
            <span id="p-toggle-label" style="font-size:0.85rem;color:var(--muted)">Actif</span>
          </div>
        </div>
        <div class="form-group full">
          <label for="p-config">Config JSON (optionnel)</label>
          <textarea id="p-config" placeholder='{"temperature": 0, "max_tokens": 4096}'>{}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="closeProviderModal()">Annuler</button>
        <button class="btn btn-primary" onclick="saveProvider()">Enregistrer</button>
      </div>
    </div>
  </div>

  <script>
    // ══════════════════════════════════════════════
    // Navigation
    // ══════════════════════════════════════════════
    function showSection(name, el) {
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('section-' + name).classList.add('active');
      el.classList.add('active');

      if (name === 'dashboard') loadStats();
      if (name === 'logs')      loadLogs();
      if (name === 'bulletins') loadBulletins();
      if (name === 'providers') loadProviders();
    }

    // ══════════════════════════════════════════════
    // Toast
    // ══════════════════════════════════════════════
    function toast(msg, type = 'success') {
      const icons = { success: '✅', error: '❌', warning: '⚠️' };
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.innerHTML = \`<span>\${icons[type] || '💬'}</span> \${msg}\`;
      document.getElementById('toast-wrap').appendChild(el);
      setTimeout(() => el.classList.add('show'), 10);
      setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
    }

    // ══════════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════════
    function getAdminKey() {
      return localStorage.getItem('admin_key') || '';
    }

    async function apiFetch(path, opts = {}) {
      const key = getAdminKey();
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (key) headers['X-Admin-Key'] = key;
      const resp = await fetch('/admin' + path, { ...opts, headers });
      const data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.erreur || resp.statusText);
      return data;
    }

    function fmtDate(s) {
      if (!s) return '—';
      return new Date(s + 'Z').toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    }

    function tagHtml(status) {
      const map = { success: 'success', error: 'error', en_attente: 'warning', valide: 'success', corrige: 'info', rejete: 'error' };
      const labels = { success: 'Succès', error: 'Erreur', en_attente: 'En attente', valide: 'Validé', corrige: 'Corrigé', rejete: 'Rejeté' };
      const cls = map[status] || 'info';
      return \`<span class="tag tag-\${cls}">\${labels[status] || status}</span>\`;
    }

    // ══════════════════════════════════════════════
    // Dashboard
    // ══════════════════════════════════════════════
    async function loadStats() {
      try {
        const period = document.getElementById('period-select').value;
        let qs = '';
        if (period) {
          const d = new Date();
          d.setDate(d.getDate() - parseInt(period));
          qs = '?depuis=' + d.toISOString().split('T')[0];
        }

        const { stats } = await apiFetch('/stats' + qs);
        renderKPIs(stats.global);
        renderBarChart(stats.evolution_30j);
        renderDonut(stats.global);
        renderEndpointTable(stats.par_endpoint);
      } catch (e) {
        console.error(e);
        document.getElementById('kpi-grid').innerHTML =
          \`<div style="color:var(--danger);grid-column:1/-1">Erreur: \${e.message}</div>\`;
      }
    }

    function renderKPIs(g) {
      if (!g) return;
      const items = [
        { label: 'Total requêtes', value: g.total_requetes ?? 0, sub: 'Toute la période', cls: '' },
        { label: 'Succès', value: g.total_succes ?? 0, sub: \`\${g.taux_succes ?? 0}% du total\`, cls: 'kpi-success' },
        { label: 'Erreurs', value: g.total_erreurs ?? 0, sub: \`\${g.taux_erreur ?? 0}% du total\`, cls: g.total_erreurs > 0 ? 'kpi-danger' : '' },
        { label: 'Documents traités', value: g.total_documents ?? 0, sub: 'Fichiers analysés', cls: '' },
        { label: 'Durée moyenne', value: g.duree_moyenne_ms ? (g.duree_moyenne_ms / 1000).toFixed(1) + 's' : '—', sub: 'Toutes requêtes', cls: '' },
      ];
      document.getElementById('kpi-grid').innerHTML = items.map(i => \`
        <div class="kpi-card \${i.cls}">
          <div class="kpi-label">\${i.label}</div>
          <div class="kpi-value">\${i.value}</div>
          <div class="kpi-sub">\${i.sub}</div>
        </div>
      \`).join('');
    }

    function renderBarChart(data) {
      const wrap = document.getElementById('bar-chart-wrap');
      if (!data || !data.length) { wrap.innerHTML = '<div style="color:var(--muted);padding:2rem">Pas de données</div>'; return; }
      const max = Math.max(...data.map(d => d.requetes || 0), 1);
      wrap.innerHTML = data.map(d => {
        const h = Math.round(((d.requetes || 0) / max) * 160);
        const he = Math.round(((d.erreurs || 0) / max) * 160);
        const label = d.jour ? d.jour.slice(5) : '';
        return \`<div class="bar-item">
          <div class="bar-val">\${d.requetes || 0}</div>
          <div style="display:flex;gap:2px;align-items:flex-end;height:160px">
            <div class="bar-fill" style="height:\${h}px;flex:1"></div>
            \${he > 0 ? \`<div class="bar-fill error" style="height:\${he}px;width:6px"></div>\` : ''}
          </div>
          <div class="bar-label">\${label}</div>
        </div>\`;
      }).join('');
    }

    function renderDonut(g) {
      const s = g.total_succes || 0;
      const e = g.total_erreurs || 0;
      const total = s + e || 1;
      const pct = Math.round((s / total) * 100);
      const deg = Math.round((s / total) * 360);
      document.getElementById('donut-wrap').innerHTML = \`
        <div class="donut" style="background: conic-gradient(var(--success) 0deg \${deg}deg, var(--danger) \${deg}deg 360deg)">
          <div style="position:absolute;inset:18px;background:var(--surface);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column">
            <div style="font-size:1.4rem;font-weight:700;color:var(--success)">\${pct}%</div>
            <div style="font-size:0.65rem;color:var(--muted)">Succès</div>
          </div>
        </div>
        <div class="donut-legend">
          <div class="legend-item"><div class="legend-dot" style="background:var(--success)"></div><span>Succès : \${s}</span></div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--danger)"></div><span>Erreurs : \${e}</span></div>
        </div>
      \`;
    }

    function renderEndpointTable(data) {
      if (!data || !data.length) {
        document.getElementById('endpoint-table-wrap').innerHTML = '<div style="color:var(--muted);padding:1rem">Pas de données</div>';
        return;
      }
      document.getElementById('endpoint-table-wrap').innerHTML = \`
        <table class="data-table" style="font-size:0.8rem">
          <thead><tr><th>Endpoint</th><th>Requêtes</th><th>Succès</th><th>Erreurs</th></tr></thead>
          <tbody>\${data.map(r => \`
            <tr>
              <td style="font-family:var(--font-mono);color:var(--accent)">\${r.endpoint}</td>
              <td>\${r.total}</td>
              <td style="color:var(--success)">\${r.succes}</td>
              <td style="color:var(--danger)">\${r.erreurs}</td>
            </tr>
          \`).join('')}</tbody>
        </table>
      \`;
    }

    // ══════════════════════════════════════════════
    // Logs
    // ══════════════════════════════════════════════
    let logsPage = 1;
    async function loadLogs(page = 1) {
      logsPage = page;
      const status   = document.getElementById('log-status-filter').value;
      const endpoint = document.getElementById('log-endpoint-filter').value;
      let qs = \`?page=\${page}&per_page=30\`;
      if (status)   qs += '&status='   + status;
      if (endpoint) qs += '&endpoint=' + encodeURIComponent(endpoint);

      try {
        const data = await apiFetch('/logs' + qs);
        const tbody = document.getElementById('logs-tbody');
        if (!data.logs.length) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--muted)">Aucun log trouvé</td></tr>';
        } else {
          tbody.innerHTML = data.logs.map(l => \`
            <tr>
              <td style="font-size:0.75rem;color:var(--muted)">\${fmtDate(l.created_at)}</td>
              <td style="font-family:var(--font-mono);font-size:0.8rem;color:var(--accent)">\${l.endpoint}</td>
              <td style="font-size:0.8rem">\${l.provider || '—'}</td>
              <td>\${tagHtml(l.status)}</td>
              <td style="text-align:center">\${l.nb_fichiers ?? 1}</td>
              <td style="font-family:var(--font-mono);font-size:0.75rem">\${l.duree_ms ? l.duree_ms + 'ms' : '—'}</td>
              <td style="font-size:0.75rem;color:var(--danger);max-width:200px;overflow:hidden;text-overflow:ellipsis">\${l.error_message || ''}</td>
            </tr>
          \`).join('');
        }
        renderPagination('logs-pagination', data.page, data.pages, p => loadLogs(p));
      } catch(e) { toast(e.message, 'error'); }
    }

    // ══════════════════════════════════════════════
    // Bulletins
    // ══════════════════════════════════════════════
    let bulletinsPage = 1;
    async function loadBulletins(page = 1) {
      bulletinsPage = page;
      const statut = document.getElementById('bulletin-status-filter').value;
      let qs = \`?page=\${page}&per_page=20\`;
      if (statut) qs += '&statut=' + statut;

      try {
        const data = await apiFetch('/bulletins' + qs);
        const tbody = document.getElementById('bulletins-tbody');
        if (!data.bulletins.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--muted)">Aucun bulletin</td></tr>';
        } else {
          tbody.innerHTML = data.bulletins.map(b => {
            let erreurs = [];
            try { erreurs = JSON.parse(b.erreurs_signalees || '[]'); } catch {}
            return \`<tr>
              <td style="font-family:var(--font-mono);color:var(--muted)">#\${b.id}</td>
              <td style="font-size:0.75rem;color:var(--muted)">\${fmtDate(b.created_at)}</td>
              <td>\${tagHtml(b.statut_validation)}</td>
              <td style="font-size:0.8rem">\${erreurs.length ? erreurs.join(', ') : '—'}</td>
              <td style="font-size:0.8rem;color:var(--muted)">\${b.commentaires_correction || '—'}</td>
            </tr>\`;
          }).join('');
        }
        renderPagination('bulletins-pagination', data.page, data.pages, p => loadBulletins(p));
      } catch(e) { toast(e.message, 'error'); }
    }

    // ══════════════════════════════════════════════
    // Pagination helper
    // ══════════════════════════════════════════════
    function renderPagination(containerId, page, pages, cb) {
      const el = document.getElementById(containerId);
      if (pages <= 1) { el.innerHTML = ''; return; }
      let html = '';
      if (page > 1) html += \`<button class="btn btn-ghost" onclick="(\${cb})(1)">«</button>\`;
      if (page > 1) html += \`<button class="btn btn-ghost" onclick="(\${cb})(\${page-1})">‹ Préc</button>\`;
      html += \`<span style="padding:0.5rem 1rem;font-size:0.8rem;color:var(--muted)">\${page} / \${pages}</span>\`;
      if (page < pages) html += \`<button class="btn btn-ghost" onclick="(\${cb})(\${page+1})">Suiv ›</button>\`;
      if (page < pages) html += \`<button class="btn btn-ghost" onclick="(\${cb})(\${pages})">»</button>\`;
      el.innerHTML = html;
    }

    // ══════════════════════════════════════════════
    // Providers
    // ══════════════════════════════════════════════
    const PROVIDER_ICONS = { gemini: '🌐', google_vision: '👁', anthropic_claude: '🤖', azure_cv: '☁️', custom: '🔧' };
    const PROVIDER_LABELS = { gemini: 'Gemini (Google)', google_vision: 'Google Vision API', anthropic_claude: 'Anthropic Claude', azure_cv: 'Azure Computer Vision', custom: 'Custom' };

    async function loadProviders() {
      try {
        const { providers } = await apiFetch('/providers');
        const list = document.getElementById('providers-list');

        if (!providers.length) {
          list.innerHTML = \`<div class="empty-state"><div class="empty-icon">🔌</div><div>Aucun provider configuré</div><div style="font-size:0.85rem;margin-top:0.5rem">Ajoutez votre premier provider OCR</div></div>\`;
          return;
        }

        list.innerHTML = providers.map(p => \`
          <div class="provider-card" id="pcard-\${p.id}">
            <div class="provider-icon">\${PROVIDER_ICONS[p.type] || '🔧'}</div>
            <div class="provider-info">
              <div class="provider-name">\${p.nom}</div>
              <div class="provider-type">\${PROVIDER_LABELS[p.type] || p.type}\${p.modele ? ' · ' + p.modele : ''}</div>
            </div>
            <div class="provider-actions">
              <span class="tag \${p.est_actif ? 'tag-success' : 'tag-warning'}">\${p.est_actif ? 'Actif' : 'Inactif'}</span>
              <button class="btn btn-success-sm" onclick="testProvider(\${p.id}, '\${p.nom}')">🔌 Tester</button>
              <button class="btn btn-ghost" style="font-size:0.75rem" onclick="toggleProviderStatus(\${p.id}, \${p.est_actif})">
                \${p.est_actif ? '⏸ Désactiver' : '▶ Activer'}
              </button>
              <button class="btn btn-danger" style="font-size:0.75rem;padding:0.25rem 0.6rem" onclick="deleteProvider(\${p.id}, '\${p.nom}')">🗑</button>
            </div>
          </div>
        \`).join('');
      } catch(e) {
        document.getElementById('providers-list').innerHTML =
          \`<div style="color:var(--danger);padding:2rem">Erreur: \${e.message}</div>\`;
      }
    }

    async function testProvider(id, nom) {
      toast('Test de connexion pour ' + nom + '…', 'warning');
      try {
        const data = await apiFetch('/providers/' + id + '/tester', { method: 'POST' });
        if (data.test.ok) {
          toast(\`✅ \${nom} : \${data.test.message} (\${data.duree_ms}ms)\`, 'success');
        } else {
          toast(\`❌ \${nom} : \${data.test.message}\`, 'error');
        }
      } catch(e) { toast(e.message, 'error'); }
    }

    async function toggleProviderStatus(id, currentlyActive) {
      try {
        await apiFetch('/providers/' + id + '/activer', {
          method: 'PATCH',
          body: JSON.stringify({ est_actif: !currentlyActive }),
        });
        toast('Statut mis à jour.', 'success');
        loadProviders();
      } catch(e) { toast(e.message, 'error'); }
    }

    async function deleteProvider(id, nom) {
      if (!confirm(\`Supprimer le provider "\${nom}" ?\`)) return;
      try {
        await apiFetch('/providers/' + id, { method: 'DELETE' });
        toast(\`Provider "\${nom}" supprimé.\`, 'success');
        loadProviders();
      } catch(e) { toast(e.message, 'error'); }
    }

    // ── Modal ──
    function openProviderModal() {
      document.getElementById('p-nom').value = '';
      document.getElementById('p-type').value = '';
      document.getElementById('p-apikey').value = '';
      document.getElementById('p-modele').value = '';
      document.getElementById('p-config').value = '{}';
      const tog = document.getElementById('p-toggle');
      tog.classList.add('on');
      document.getElementById('p-toggle-label').textContent = 'Actif';
      document.getElementById('provider-modal').classList.add('open');
    }
    function closeProviderModal() {
      document.getElementById('provider-modal').classList.remove('open');
    }
    function toggleProvider(el) {
      el.classList.toggle('on');
      document.getElementById('p-toggle-label').textContent = el.classList.contains('on') ? 'Actif' : 'Inactif';
    }

    async function saveProvider() {
      const nom = document.getElementById('p-nom').value.trim();
      const type = document.getElementById('p-type').value;
      const api_key = document.getElementById('p-apikey').value.trim();
      const modele = document.getElementById('p-modele').value.trim();
      const est_actif = document.getElementById('p-toggle').classList.contains('on');
      const config_json = document.getElementById('p-config').value.trim() || '{}';

      if (!nom || !type) { toast('Nom et type sont requis.', 'error'); return; }

      try {
        const data = await apiFetch('/providers', {
          method: 'POST',
          body: JSON.stringify({ nom, type, api_key: api_key || null, modele: modele || null, est_actif, config_json }),
        });
        toast(\`\${data.action === 'cree' ? 'Provider créé' : 'Provider mis à jour'} avec succès !\`, 'success');
        closeProviderModal();
        loadProviders();
      } catch(e) { toast(e.message, 'error'); }
    }

    // ══════════════════════════════════════════════
    // Init
    // ══════════════════════════════════════════════
    loadStats();
  </script>
</body>
</html>`;
}

export default admin;
