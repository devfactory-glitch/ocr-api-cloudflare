// src/document-integrity.js
// Module isolé — Analyse d'intégrité documentaire (Antifraude CdCF S8-S11)
// Zero impact sur le pipeline OCR existant.
// S58 (clones visuels) nécessite un pHash impossible sur Workers — délégué à Dhamen.

// ─────────────────────────────────────────────
// Normaliser document_integrity retourné par Gemini.
// Si Gemini ne l'a pas rempli, ne rien forcer.
// ─────────────────────────────────────────────
export function enrichDocumentIntegrity(data) {
  if (!data?.document_integrity) return data;

  const di = data.document_integrity;

  if (di.stamp_analysis) {
    di.stamp_analysis.detected = toBool(di.stamp_analysis.detected);
    di.stamp_analysis.confidence = toConfidence(di.stamp_analysis.confidence);
  }
  if (di.signature_analysis) {
    di.signature_analysis.detected = toBool(di.signature_analysis.detected);
    di.signature_analysis.confidence = toConfidence(di.signature_analysis.confidence);
  }
  if (di.manuscript_addition) {
    di.manuscript_addition.detected = toBool(di.manuscript_addition.detected);
    di.manuscript_addition.confidence = toConfidence(di.manuscript_addition.confidence);
    if (!Array.isArray(di.manuscript_addition.zones)) di.manuscript_addition.zones = [];
  }
  if (di.forgery_analysis) {
    di.forgery_analysis.suspected = toBool(di.forgery_analysis.suspected);
    di.forgery_analysis.confidence = toConfidence(di.forgery_analysis.confidence);
    if (!Array.isArray(di.forgery_analysis.suspicious_zones)) di.forgery_analysis.suspicious_zones = [];
  }

  return data;
}

// Gemini peut retourner true, "true", "false", false
function toBool(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val.trim().toLowerCase() === "true";
  return Boolean(val);
}

// Gemini peut retourner 0.85, "0.85", 85
function toConfidence(val) {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) return Math.min(n / 100, 1);
  return Math.max(0, Math.min(1, n));
}
