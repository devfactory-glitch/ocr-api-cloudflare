// src/document-integrity.js
// Module isolé — Analyse d'intégrité documentaire (Antifraude CdCF S8-S11, S58)
// Zero impact sur le pipeline OCR existant.

// ─────────────────────────────────────────────
// dHash (Difference Hash) — hash perceptuel pur JS
// Fonctionne sur les octets bruts de l'image (pas besoin de décodage).
// Produit un hash 64 bits (16 hex chars) stable aux redimensionnements légers.
// ─────────────────────────────────────────────
export function computeVisualHash(base64Data) {
  try {
    const raw = atob(base64Data);
    const len = raw.length;
    if (len < 256) return null;

    // Échantillonner 9×8 = 72 points régulièrement espacés dans les octets bruts
    // Chaque paire adjacente horizontale produit 1 bit (plus grand ou non)
    const cols = 9, rows = 8;
    const grid = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = Math.floor((r * cols + c) * len / (rows * cols));
        grid.push(raw.charCodeAt(idx) & 0xFF);
      }
    }

    // Produire 64 bits : comparer chaque pixel avec son voisin droit
    let hash = "";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const bit = grid[r * cols + c] > grid[r * cols + c + 1] ? "1" : "0";
        hash += bit;
      }
    }

    // Convertir le binaire 64 bits en hex 16 chars
    let hex = "";
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(hash.substring(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Enrichir la réponse OCR avec document_integrity
// Appelé APRÈS le parsing JSON, en fire-and-forget.
// Si Gemini n'a pas retourné document_integrity, on ne force rien.
// ─────────────────────────────────────────────
export function enrichDocumentIntegrity(data, imageParts) {
  if (!data) return data;

  // Normaliser document_integrity si Gemini l'a partiellement rempli
  const di = data.document_integrity;
  if (di) {
    if (di.stamp_analysis) {
      di.stamp_analysis.detected = Boolean(di.stamp_analysis.detected);
      di.stamp_analysis.confidence = normalizeConfidence(di.stamp_analysis.confidence);
    }
    if (di.signature_analysis) {
      di.signature_analysis.detected = Boolean(di.signature_analysis.detected);
      di.signature_analysis.confidence = normalizeConfidence(di.signature_analysis.confidence);
    }
    if (di.manuscript_addition) {
      di.manuscript_addition.detected = Boolean(di.manuscript_addition.detected);
      di.manuscript_addition.confidence = normalizeConfidence(di.manuscript_addition.confidence);
      if (!Array.isArray(di.manuscript_addition.zones)) di.manuscript_addition.zones = [];
    }
    if (di.forgery_analysis) {
      di.forgery_analysis.suspected = Boolean(di.forgery_analysis.suspected);
      di.forgery_analysis.confidence = normalizeConfidence(di.forgery_analysis.confidence);
      if (!Array.isArray(di.forgery_analysis.suspicious_zones)) di.forgery_analysis.suspicious_zones = [];
    }
  }

  // Calculer le visual_hash depuis la première image (BS principal)
  if (imageParts && imageParts.length > 0) {
    const firstImage = imageParts[0]?.inlineData?.data;
    if (firstImage) {
      const hash = computeVisualHash(firstImage);
      if (hash) {
        if (!data.document_integrity) data.document_integrity = {};
        data.document_integrity.visual_hash = hash;
      }
    }
  }

  return data;
}

function normalizeConfidence(val) {
  const n = parseFloat(val);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) return Math.min(n / 100, 1); // Gemini peut retourner 85 au lieu de 0.85
  return Math.max(0, Math.min(1, n));
}
