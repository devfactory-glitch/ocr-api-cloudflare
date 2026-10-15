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
| S58 | Documents clones | 4-Critique | Hash visuel (dHash) pour comparaison inter-bulletins |

## Perimetre OCR (ce qu'on fait)

1. Enrichir le prompt Gemini pour extraire `document_integrity` dans le JSON
2. Parser le resultat et l'inclure dans la reponse OCR
3. Calculer un hash visuel (dHash) par image uploadee
4. Stocker `visual_hash` en base pour comparaison future (S58)

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
    },
    "visual_hash": "a1b2c3d4e5f6..."
  }
}
```

## Contraintes techniques

- **Zero regression** : l'analyse d'integrite est isolee dans un module separe (`src/document-integrity.js`)
- **Fire-and-forget** : si l'analyse echoue, l'extraction OCR reste intacte
- **Pas de second appel Gemini** : integre dans le prompt existant (un seul appel)
- **Runtime** : Cloudflare Workers (pas de librairie native image)
- **dHash** : calcule en pur JS sur les octets bruts de l'image

## Architecture

```
[Gemini OCR] ──→ JSON avec document_integrity
                          ↓
              [postProcess] ── extraction inchangee
                          ↓
              [computeVisualHash()] ── dHash pur JS
                          ↓
              [Reponse finale] ── document_integrity + visual_hash
```

## Fichiers modifies

| Fichier | Modification |
|---------|-------------|
| `src/document-integrity.js` | Nouveau — dHash + enrichissement |
| `src/prompt.js` | Ajout section document_integrity dans le schema JSON |
| `src/index.js` | Import + appel post-OCR (fire-and-forget) + migration visual_hash |
| `docs/REQ-DOCUMENT-INTEGRITY.md` | Ce document |
| `docs/ARCHITECTURE.md` | Mise a jour pipeline + section integrite |

## Tests

- L'analyse d'integrite ne doit JAMAIS bloquer l'extraction OCR
- Si Gemini ne retourne pas `document_integrity`, le champ est absent (pas d'erreur)
- Le dHash doit etre deterministe (meme image = meme hash)
