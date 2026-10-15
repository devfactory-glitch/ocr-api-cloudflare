# REQ-DOCUMENT-INTEGRITY — Analyse d'integrite documentaire (Antifraude)

**Branche** : `feature/document-integrity-antifraude`
**Date** : 2026-10-15
**Reference CdCF** : anti faude.pdf — Scenarios S8, S9, S10, S11, S58
**Cahier de recette** : cahier-recette-antifraude.html (21 scenarios manquants, 5 relevent de l'OCR)

---

## Contexte

Le moteur antifraude Dhamen (projet principal E-Sante) applique 60 regles de detection sur les bulletins de soins. 5 scenarios necessitent une **analyse visuelle** que seul le moteur OCR (Gemini Vision) peut fournir. Ces 5 scenarios sont les seuls manquants cote OCR.

## Scenarios couverts

| # | Scenario | Risque | Description |
|---|----------|--------|-------------|
| S8 | Cachet suspect | 4-Critique | Detecter la presence/absence de cachet, extraire son contenu textuel |
| S9 | Signature suspecte | 4-Critique | Detecter la presence/absence de signature |
| S10 | Ajout manuscrit suspect | 3-Eleve | Detecter des zones manuscrites ajoutees apres impression |
| S11 | Document falsifie | 4-Critique | Detecter des zones avec polices/resolutions incoherentes |
| S58 | Documents clones | 4-Critique | Delegue a Dhamen (pHash necessaire, impossible sur Cloudflare Workers) |

## Perimetre OCR (ce qu'on fait)

1. Enrichir le prompt Gemini pour extraire `document_integrity` dans le JSON (S8-S11)
2. Normaliser les types (toBool, toConfidence) en post-traitement
3. Inclure `document_integrity` dans la reponse OCR pour que Dhamen le consomme

## Hors perimetre OCR (ce que fait Dhamen)

- Comparaison cachets/signatures avec un referentiel (`matches_reference`, `consistent_with_history`)
- Scoring antifraude et decisions de blocage
- Clustering, graphes de relations, detection statistique
- Creation des regles STAMP_SUSPECT, SIGNATURE_SUSPECT, etc.

## Schema de sortie

```json
{
  "document_integrity": {
    "stamp_analysis": {
      "detected": true,
      "text_on_stamp": "Dr Mohamed BEN ALI - Cardiologue - MF 1234567",
      "confidence": 0.85
    },
    "signature_analysis": {
      "detected": true,
      "confidence": 0.7
    },
    "manuscript_addition": {
      "detected": false,
      "zones": [],
      "confidence": 0.9
    },
    "forgery_analysis": {
      "suspected": false,
      "suspicious_zones": [],
      "confidence": 0.85
    }
  }
}
```

## Contraintes techniques

- **Zero regression** : l'analyse d'integrite est isolee dans un module separe (`src/document-integrity.js`)
- **Fire-and-forget** : si l'analyse echoue, l'extraction OCR reste intacte
- **Pas de second appel Gemini** : integre dans le prompt existant (un seul appel)
- **Runtime** : Cloudflare Workers (pas de librairie native image)
## Architecture

```
[Gemini OCR] ──→ JSON avec document_integrity (S8-S11)
                          ↓
              [postProcess] ── extraction inchangee
                          ↓
              [enrichDocumentIntegrity()] ── normalisation types
                          ↓
              [Reponse finale] ── document_integrity pret pour Dhamen
```

## Fichiers modifies

| Fichier | Modification |
|---------|-------------|
| `src/document-integrity.js` | Nouveau — normalisation document_integrity |
| `src/prompt.js` | Ajout section document_integrity dans le schema JSON |
| `src/index.js` | Import + appel post-OCR (fire-and-forget) |
| `docs/REQ-DOCUMENT-INTEGRITY.md` | Ce document |
| `docs/ARCHITECTURE.md` | Mise a jour pipeline + section integrite |

## Tests

- L'analyse d'integrite ne doit JAMAIS bloquer l'extraction OCR
- Si Gemini ne retourne pas `document_integrity`, le champ est absent (pas d'erreur)
- toBool("false") doit retourner false (pas true comme Boolean("false"))
- Confidence 85 doit etre normalisee en 0.85
