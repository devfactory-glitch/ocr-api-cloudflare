// src/document-integrity.js
// Module isolé — Antifraude CdCF S8-S11 + S58 (fingerprint)
// Zero impact sur le pipeline OCR existant.

// ─────────────────────────────────────────────
// Normaliser document_integrity retourné par Gemini.
// Si Gemini ne l'a pas rempli, ne rien forcer.
// ─────────────────────────────────────────────
export function enrichDocumentIntegrity(data) {
  if (!data) return data;

  // S8-S11 : normaliser document_integrity
  const di = data.document_integrity;
  if (di) {
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
  }

  // S58 : normaliser document_fingerprint (5 champs string|null)
  if (data.document_fingerprint) {
    const fp = data.document_fingerprint;
    for (const key of ["template_hash", "handwriting_profile", "stamp_visual", "layout_signature", "content_structure_hash"]) {
      fp[key] = toStringOrNull(fp[key]);
    }
  }

  // S58 bis : clone_key structurelle (déterministe, basée sur les données extraites)
  data.clone_key = buildCloneKey(data.actes_independants);

  return data;
}

// Génère une clé de clone déterministe à partir des actes extraits.
// Deux BS avec les mêmes actes/prestataires/montants/dates produisent la même clé.
// Les champs d'identité (nom, matricule) sont exclus volontairement.
function buildCloneKey(actes) {
  if (!Array.isArray(actes) || actes.length === 0) return null;

  const parts = actes.map(a => {
    const type = (a.type || "").toUpperCase().trim();
    const date = (a.date || "").trim();
    const praticien = (a.praticien || "").toUpperCase().trim();
    const montant = (a.montant || "").trim();
    const code = (a.code_acte || "").toUpperCase().trim();
    return `${type}|${date}|${praticien}|${montant}|${code}`;
  });

  // Tri pour que l'ordre des actes n'affecte pas la clé
  parts.sort();
  return parts.join(";;");
}

// Gemini peut retourner undefined, null, ou un string
function toStringOrNull(val) {
  if (val == null || val === "") return null;
  return typeof val === "string" ? val.trim() : String(val);
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
