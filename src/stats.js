// src/stats.js
// Module de statistiques pour la plateforme d'administration OCR BH Assurance

/**
 * Enregistre un événement d'utilisation dans la base D1
 * @param {Object} db - Instance D1 Database
 * @param {Object} event - Données de l'événement
 */
export async function logUsageEvent(db, event) {
  const {
    endpoint,
    provider,
    status,           // 'success' | 'error'
    nb_fichiers = 1,
    duree_ms = null,
    error_message = null,
  } = event;

  await db
    .prepare(
      `INSERT INTO usage_logs (endpoint, provider, status, nb_fichiers, duree_ms, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(endpoint, provider, status, nb_fichiers, duree_ms, error_message)
    .run();
}

/**
 * Retourne les statistiques globales d'utilisation
 * @param {Object} db - Instance D1 Database
 * @param {Object} options - Options de filtre (depuis, jusqu'a)
 */
export async function getGlobalStats(db, options = {}) {
  const { depuis = null, jusqu_a = null } = options;

  let dateFilter = "";
  const params = [];

  if (depuis) {
    dateFilter += " AND created_at >= ?";
    params.push(depuis);
  }
  if (jusqu_a) {
    dateFilter += " AND created_at <= ?";
    params.push(jusqu_a);
  }

  // Statistiques globales
  const globalQuery = `
    SELECT
      COUNT(*) as total_requetes,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as total_succes,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as total_erreurs,
      SUM(nb_fichiers) as total_documents,
      ROUND(AVG(duree_ms), 2) as duree_moyenne_ms,
      ROUND(AVG(CASE WHEN status = 'success' THEN duree_ms END), 2) as duree_succes_ms
    FROM usage_logs
    WHERE 1=1 ${dateFilter}
  `;

  const global = await db.prepare(globalQuery).bind(...params).first();

  // Stats par endpoint
  const endpointQuery = `
    SELECT
      endpoint,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as succes,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as erreurs,
      SUM(nb_fichiers) as documents,
      ROUND(AVG(duree_ms), 2) as duree_moyenne_ms
    FROM usage_logs
    WHERE 1=1 ${dateFilter}
    GROUP BY endpoint
    ORDER BY total DESC
  `;

  const byEndpoint = await db.prepare(endpointQuery).bind(...params).all();

  // Stats par provider OCR
  const providerQuery = `
    SELECT
      provider,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as succes,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as erreurs,
      ROUND(AVG(duree_ms), 2) as duree_moyenne_ms
    FROM usage_logs
    WHERE 1=1 ${dateFilter}
    GROUP BY provider
    ORDER BY total DESC
  `;

  const byProvider = await db.prepare(providerQuery).bind(...params).all();

  // Évolution par jour (30 derniers jours)
  const evolutionQuery = `
    SELECT
      DATE(created_at) as jour,
      COUNT(*) as requetes,
      SUM(nb_fichiers) as documents,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as erreurs
    FROM usage_logs
    WHERE created_at >= datetime('now', '-30 days') ${dateFilter ? "AND 1=1 " + dateFilter : ""}
    GROUP BY DATE(created_at)
    ORDER BY jour ASC
  `;

  const evolution = await db.prepare(evolutionQuery).bind(...params).all();

  // Taux de validation des bulletins
  const validationQuery = `
    SELECT
      statut_validation,
      COUNT(*) as total
    FROM bulletins_valides
    WHERE 1=1
    GROUP BY statut_validation
  `;

  let validationStats = { results: [] };
  try {
    validationStats = await db.prepare(validationQuery).all();
  } catch {
    // Table peut ne pas exister encore
  }

  const taux_succes =
    global.total_requetes > 0
      ? Math.round((global.total_succes / global.total_requetes) * 100)
      : 0;

  return {
    global: {
      ...global,
      taux_succes,
      taux_erreur: 100 - taux_succes,
    },
    par_endpoint: byEndpoint.results || [],
    par_provider: byProvider.results || [],
    evolution_30j: evolution.results || [],
    validation: validationStats.results || [],
  };
}

/**
 * Retourne les logs récents avec pagination
 */
export async function getRecentLogs(db, { page = 1, per_page = 50, status = null, endpoint = null } = {}) {
  const offset = (page - 1) * per_page;
  let filters = "";
  const params = [];

  if (status) {
    filters += " AND status = ?";
    params.push(status);
  }
  if (endpoint) {
    filters += " AND endpoint = ?";
    params.push(endpoint);
  }

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM usage_logs WHERE 1=1 ${filters}`)
    .bind(...params)
    .first();

  const logs = await db
    .prepare(
      `SELECT * FROM usage_logs WHERE 1=1 ${filters}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, per_page, offset)
    .all();

  return {
    total: countResult.total,
    page,
    per_page,
    pages: Math.ceil(countResult.total / per_page),
    logs: logs.results || [],
  };
}
