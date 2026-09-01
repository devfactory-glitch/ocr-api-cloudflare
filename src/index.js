// src/index.js
// API OCR Assurance Maladie Tunisie — Cloudflare Workers + Hono
// Inclut la plateforme d'administration, D1 et l'OCR avancé multi-documents

import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "./admin.js"; // À supposer existant dans votre dossier
import { logUsageEvent } from "./stats.js"; // À supposer existant dans votre dossier

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
// PROMPT PARTAGÉ (règles + schéma JSON)
// Utilisé par PROMPT (1 fichier) et PROMPT_DOSSIER (multi-docs)
// ─────────────────────────────────────────────
const PROMPT_BASE = `
🔍 LECTURE PRÉALABLE :
A. Scans souvent PIVOTÉS (90°/180°/270°). Redresser mentalement avant extraction.
B. IGNORER pages avec texte INVERSÉ/EN MIROIR (transparence verso).
C. DOUBLONS : même document scanné 2 fois → garder la plus lisible. Ne JAMAIS additionner.
D. RECTO/VERSO = un seul bulletin. Fusionner.
E. VERSO DU BS : contient les sections professionnels de santé (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux). Chaque section a des COLONNES (Date, Désignation, Code Acte, Cotation, Honoraires, Cachet). Le verso est souvent PIVOTÉ à 90°. LIRE CHAQUE SECTION ET CHAQUE CACHET.

🔍 PRIORITÉ DES SOURCES (pour les MONTANTS et NOMS) : 1) Facture imprimée → 2) Ticket informatique → 3) Cachet officiel → 4) Manuscrit.
   EXCEPTION CODIFICATION : pour les LETTRES-CLÉS et COTATIONS, la LETTRE CONFIDENTIELLE prime sur tout (même manuscrite), car c'est le document de référence pour la codification CNAM.
F. Tampons dateurs à molette = DATES, jamais numéros ni montants.
G. Tampon de cabinet = nom praticien + MF. Lire même si incliné.

🔍 MONTANTS : POINT décimal, SANS séparateur milliers, 3 décimales ("1 307,477" → "1307.477"). Montant NÉGATIF : garder le signe.
- "montant" et "montant_cnam" sont 2 champs TOTALEMENT SÉPARÉS avec des SOURCES DIFFÉRENTES :
  "montant" = montant FACTURÉ par le prestataire. Sources autorisées :
    1) FACTURE ou REÇU du praticien (priorité)
    2) Colonne HONORAIRES du BS
    3) Ticket de caisse (pharmacie)
    JAMAIS depuis un décompte CNAM ou une décision de prise en charge.
  "montant_cnam" = montant REMBOURSÉ par la CNAM. Sources autorisées :
    1) Colonne "Mnt Remb" / "montant_rembourse" du DÉCOMPTE CNAM
    2) Montant accordé dans une DÉCISION DE PRISE EN CHARGE
    JAMAIS depuis une facture ou le BS.
  ERREUR GRAVE : prendre un montant du décompte CNAM et le mettre dans "montant" d'un acte. INTERDIT.
  Si aucune facture ni BS ne donne le montant → "montant" = "". Ne JAMAIS copier le montant_cnam vers montant.

🔍 CODIFICATION :
- Cotation peut être NON NUMÉRIQUE ("Kc P1"). Renvoyer telle quelle.
- Chercher lettre-clé sur notes d'honoraires/lettres confidentielles, pas seulement BS.
- Illisible → "[ILLISIBLE]". Ne jamais deviner.
- SÉPARATION lettre-clé / coefficient : "lettre_cle" = alphabétique | "cotation" = numérique.
  "Ke 40"→"Ke","40" | "B120"→"B","120" | "KC50"→"KC","50" | "CS"→"CS","" | "Kc P1"→"KC","P1"
- Code 3 lettres + 6 chiffres (MGE000070, RAD010260) = CODE D'INTERVENTION CNAM → accord_prealable_details.code_intervention.
  Ce code n'est PAS une lettre-clé. NE JAMAIS mettre "RAD" dans lettre_cle ni "010260" dans cotation.
  Un code comme RAD010260 → code_intervention: "RAD010260", lettre_cle: "Z" ou "Rd" (selon nomenclature radiologie).
- MATRICULE FISCALE : format standard = 7 chiffres + "/" + lettre + "/A/" + lettre + "/000" (ex: 1756903/P/A/C/000).
  Lire de gauche à droite. Ne JAMAIS inverser l'ordre des caractères.

🔴 RÈGLES :
1. Textes imprimés ÉCRASENT le manuscrit brouillon.
2. Nom/MF praticiens → Cachets/Tampons à l'encre.
3. Ne PAS mélanger MEDECIN (C, V) et RADIOLOGIE (Écho, Scanner, IRM).
3a. CONSULTATION ≠ ACTE TECHNIQUE — DISTINCTION PAR LA SECTION DU BS :
   La SECTION du BS détermine la nature de l'acte :
     - Section "Consultations et Visites" → consultation/visite → lettre-clé C, CS ou V.
     - Section "Actes Médicaux" → acte technique (examen, geste, intervention) → lettre-clé KC, K ou KE. JAMAIS C/CS.
   Si le BS a une ligne dans "Consultations" ET une ligne dans "Actes Médicaux" pour le même praticien → 2 actes séparés avec des montants distincts.
   Si un acte apparaît UNIQUEMENT sur une facture/reçu sans section BS identifiable → déduire la lettre-clé de la NATURE de l'acte : un examen ou geste technique = KC, une consultation = C/CS.
3b. CLASSIFICATION DES ACTES — ordre de priorité STRICT :
   N°1 LETTRE CONFIDENTIELLE : Kc/KC→MEDECIN | KE→MEDECIN | B→LABORATOIRE | Z/Rd→RADIOLOGIE | D→DENTAIRE
   N°2 SECTION DU BS REMPLIE : Consultations/Visites/Actes Médicaux→MEDECIN | Biologie→LABORATOIRE | Hospitalisation(dates)→HOSPITALISATION | Accouchement→HOSPITALISATION | Dentaire→DENTAIRE | Paramédicaux→PARAMEDICAL | Pharmacie→PHARMACIE
   N°3 FACTURE : UNIQUEMENT montants/détails financiers. L'en-tête ne détermine JAMAIS le type.
   POUR LES MONTANTS : Facture/Reçu > BS > Ordonnance. Si la facture dit 47.500 et le BS dit 50.000, prendre 47.500.
3c. FACTURE CLINIQUE ≠ HOSPITALISATION — RÈGLE CRITIQUE :
    HOSPITALISATION = le patient est ADMIS dans un établissement (au moins 1 nuit OU chirurgie ambulatoire avec bloc).
    PREUVES DE SÉJOUR requises (au moins 1) :
      - date_entree ≠ date_sortie (le patient a dormi)
      - frais de séjour/chambre/lit sur la facture
      - section "Hospitalisation" du BS remplie avec dates
      - lettre confidentielle mentionnant "hospitalisé" ou "opéré"
    Sans AUCUNE preuve de séjour → l'acte est MEDECIN/RADIOLOGIE/LABORATOIRE selon sa nature.

    EXEMPLES CONCRETS :
    HOSPITALISATION : patient admis en clinique, opéré (circoncision KC20), séjour 2 jours → HOSPITALISATION
    HOSPITALISATION : accouchement en clinique, date entrée/sortie → HOSPITALISATION
    PAS HOSPITALISATION : patient va en clinique faire un scanner → RADIOLOGIE
    PAS HOSPITALISATION : patient va en clinique pour une consultation spécialiste → MEDECIN
    PAS HOSPITALISATION : facture d'un centre d'imagerie (même si c'est une "clinique") → RADIOLOGIE

    La SECTION du BS qui est remplie guide le type : si c'est "Actes Médicaux" avec un cachet de radiologue dans une clinique → RADIOLOGIE, pas HOSPITALISATION.
3d. LETTRE CONFIDENTIELLE PRIME sur tous les autres documents. Contredit facture ou BS → elle GAGNE.
3e. CLASSEMENT DES LIGNES DE FACTURE CLINIQUE (RÈGLE CRITIQUE) :
Toute ligne d'une facture d'établissement doit être classée en 2 catégories :

  A) LIGNES "ACTE_COTE" (promues en actes indépendants) :
     Honoraires d'un praticien nommé, AIDE OPERATOIRE, ANESTHESISTE,
     INSTRUMENTISTE, PANSEUR, laboratoire, anatomopathologie, imagerie,
     pharmacie EXTERNE (officine de ville facturée en compte d'autrui).
     → Ces lignes sont PROMUES en actes séparés dans "actes_independants".

  B) LIGNES CLINIQUE (restent dans l'HOSPITALISATION groupées par section) :
     Chaque ligne non promue doit être placée dans la BONNE section :
       "sejour"             : chambre, lit, hébergement, nuitée, séjour,
                              AJUSTEMENT SEJOUR
       "bloc_operatoire"    : bloc opératoire, salle de réveil, réanimation,
                              appareillages, AJUSTEMENT APPAREILLAGES, oxygène
       "pharmacie_interne"  : pharmacie (interne/hospitalière), consommables,
                              AJUSTEMENT PHARMACIE
       "autres_frais"       : frais de dossier, blouse, bracelet, timbre fiscal,
                              extras, AJUSTEMENT EXTRAS, AJUSTEMENT NEGATIF,
                              tout ce qui ne rentre pas dans les 3 sections ci-dessus

CAS PARTICULIER "AJUSTEMENT <POSTE>" :
Une ligne "AJUSTEMENT" suivie d'un POSTE nommé va dans la section de CE POSTE :
  AJUSTEMENT SEJOUR        -> section "sejour"
  AJUSTEMENT APPAREILLAGES -> section "bloc_operatoire"
  AJUSTEMENT PHARMACIE     -> section "pharmacie_interne"
  AJUSTEMENT EXTRAS        -> section "autres_frais"
  AJUSTEMENT NEGATIF       -> section "autres_frais"

PROMOTION EN ACTE INDÉPENDANT :
Seules les lignes classées "acte_cote" (catégorie A) sont promues.
Les lignes clinique (catégorie B) restent dans leurs sections respectives
(sejour, bloc_operatoire, pharmacie_interne, autres_frais) de l'HOSPITALISATION.

TYPE DE L'ACTE PROMU :
  praticien / rôle médical -> "MEDECIN"    | pharmacie externe -> "PHARMACIE"
  laboratoire, anapath     -> "LABORATOIRE" | centre d'imagerie -> "RADIOLOGIE"

CHAMPS OBLIGATOIRES SUR UN ACTE PROMU :
  - "rattachement_hospitalisation" : index 0-BASED de l'acte HOSPITALISATION
  - "origine_ligne"    : "compte_autrui" | "details_facture"
  - "libelle_origine"  : libellé EXACT de la ligne, avant interprétation
  - "praticien"        : le nom si visible, SINON le libellé du rôle tel quel
                         (ex: "AIDE OPERATOIRE"). Ne JAMAIS inventer un nom.
  - "acte"             : le NOM DE L'INTERVENTION réalisée (ex: "Circoncision",
                         "Appendicectomie", "Anesthésie générale"), PAS le rôle
                         du praticien. Chercher dans : lettre confidentielle
                         (champ "acte réalisé" / "motif"), facture clinique
                         (désignation de l'acte), BS (section hospitalisation).
                         Si introuvable → utiliser le libellé du rôle en dernier recours.
  - "lettre_cle" OBLIGATOIRE sur un acte promu : déduire la lettre-clé du
    ROLE du prestataire si elle n'est pas explicite :
      Chirurgien         -> "KC"
      Anesthésiste       -> "K"
      Aide opératoire    -> "K"
      Instrumentiste     -> "K"
      Laboratoire/anapath -> "B"
      Imagerie           -> "Z"
    Ne s'applique PAS aux pharmacies (pas de lettre-clé).

Ce classement est une PROPOSITION fondée sur la nomenclature. Le barème
définitif dépend du contrat d'assurance et sera appliqué en aval. Ne jamais
calculer de montant remboursé.

ANTI-DOUBLE-COMPTAGE (impératif) :
Une ligne promue NE DOIT PLUS apparaître dans les sections de l'HOSPITALISATION
(sejour, bloc_operatoire, pharmacie_interne, autres_frais).
"total_clinique" = sejour.total + bloc_operatoire.total + pharmacie_interne.total
+ autres_frais.total (ne compte que les lignes non promues).
"montant" de l'hospitalisation reste le TOTAL de la facture (contrôle).
"total_global_calcule" n'additionne chaque montant QU'UNE SEULE FOIS.
3f. EXTRACTION EXHAUSTIVE DEPUIS LE BULLETIN DE SOINS (RÈGLE CRITIQUE) :
   Le BS (bulletin de soins) est le DOCUMENT MAÎTRE. Il a 2 faces :
   - RECTO : identité adhérent, bénéficiaire, employeur, N° BS, date
   - VERSO (côté professionnel) : sections à remplir avec cachets des praticiens

   ⚠️ Le VERSO du BS est souvent PIVOTÉ à 90° (orientation paysage). Le redresser mentalement.
   ⚠️ Le VERSO contient PLUSIEURS SECTIONS avec colonnes : DATE | DESIGNATION | CODE ACTE | COTATION | HONORAIRES | CACHET ET SIGNATURE.
   ⚠️ Chaque section peut contenir un CACHET de praticien (tampon à l'encre) avec nom, MF, code CNAM. LIRE ces cachets.

   SECTIONS DU BS À VÉRIFIER UNE PAR UNE :
     * "Consultations et Visites" → un acte MEDECIN par ligne (même si montant = 0 ou "Gratuit").
       IMPORTANT : si le praticien est un SPÉCIALISTE (cachet indique spécialité), la lettre-clé est "CS" même si le BS écrit juste "C".
     * "Actes Médicaux" → un acte MEDECIN ou RADIOLOGIE par ligne.
       IMPORTANT : lire le CACHET dans cette section. Si le cachet indique un RADIOLOGUE → type "RADIOLOGIE".
       Le code acte, la cotation et le montant sont dans les colonnes du BS.
     * "Biologie" ou "Biologie & Radiologie" → un acte LABORATOIRE et/ou RADIOLOGIE par ligne.
       IMPORTANT : lire le CACHET du labo (nom, MF) et le MONTANT dans la colonne honoraires.
     * "Hospitalisation" / "Accouchement-Hospitalisation" → un acte HOSPITALISATION
       ATTENTION HOSPITALISATION : la section "Hospitalisation" du BS a des colonnes Date Entrée / Date Sortie / Montant / Code Établissement.
       Si cette section est VIDE (pas de dates) mais qu'il y a un acte dans "Actes Médicaux" ou "Biologie & Radiologie" fait dans une clinique → ce n'est PAS une hospitalisation, c'est un acte normal (MEDECIN/RADIOLOGIE/LABORATOIRE) réalisé en ambulatoire dans un établissement.
     * "Pharmacie" → un acte PHARMACIE par pharmacie/date. Le BS indique souvent le MONTANT TOTAL pharmacie. Ce montant DOIT correspondre à la somme des tickets. Si écart → signaler dans observations.
     * "Soins Dentaires" / "Prothèses Dentaires" → un acte DENTAIRE par ligne
     * "Actes Paramédicaux" → un acte PARAMEDICAL par ligne
   DÉTECTION KINÉ / RÉÉDUCATION :
   - Ordonnance prescrivant "rééducation fonctionnelle", "kinésithérapie", "physiothérapie", "séances de kiné/rééducation" → acte PARAMEDICAL
   - Extraire le nombre de séances : "3 séances/semaine x 12 séances" → nombre_seances_prescrites: "36" (total)
   - Si la section "Actes Paramédicaux" du BS est remplie avec un cachet kiné → acte PARAMEDICAL
   - Lettres-clés kiné : TO (tarif orthoptie) | TM (tarif massage) | APR (acte paramédical de rééducation)
   - Un KINÉSITHÉRAPEUTE n'est PAS un MEDECIN. Ses actes → type "PARAMEDICAL", JAMAIS "MEDECIN".
   CHAMPS SPÉCIAUX EN HAUT DE LA FACE PROFESSIONNELLE :
     * "Suivi de la grossesse" / "Date prévue d'accouchement" → si rempli, les soins sont liés à la maternité. Le signaler dans observations.
     * "APCI" (checkbox) → si coché, le patient est sous régime APCI (affection longue durée).
   VÉRIFICATION FINALE : avant de retourner le JSON, relis CHAQUE section du
   BS et vérifie qu'aucun acte listé n'a été oublié. Si un acte apparaît sur
   le BS mais pas encore dans "actes_independants", AJOUTE-LE avec les infos
   disponibles (praticien, date, montant du BS). Un acte sur le BS sans
   facture séparée reste un acte valide — utilise les montants du BS.
   Avant d'ajouter, vérifier qu'il ne s'agit pas d'un acte déjà présent sous
   une autre source (promotion depuis une facture, compte-rendu). Un meme
   soin ne doit apparaitre qu'UNE seule fois dans "actes_independants".
3g. DÉTAIL PHARMACIE INTERNE / CUMULÉ — EXTRAIRE LE DÉTAIL :
   Si le dossier contient une page "Détail Pharmacie Cumulé", "Détail
   consommables" ou toute annexe listant les produits utilisés pendant
   l'hospitalisation (médicaments, dispositifs médicaux, consommables) :
   → Extraire CHAQUE ligne individuellement dans pharmacie_interne.lignes
     avec : nom du produit, quantité, prix unitaire, TVA, montant.
   → Le total pharmacie_interne.total reste la SOMME de ces lignes.
   → Si la facture clinique a une ligne groupée "Pharmacie Interne" ET
     que le détail existe sur une autre page → utiliser le DÉTAIL (plus
     précis), pas la ligne groupée.
   → Si AUCUN détail n'existe (pas de page annexe) → garder les lignes
     groupées de la facture clinique telles quelles.
   L'assureur a besoin du détail pour vérifier la remboursabilité de
   chaque produit individuellement.
4. Répare l'orthographe des noms de médicaments depuis les factures imprimées.
5. REGROUPEMENT : PHARMACIE et LABORATOIRE → regrouper les lignes d'un MÊME acte (même date, même prestataire) dans UN SEUL objet avec "details_lignes". Ne PAS créer un acte par médicament/analyse.
5b. LECTURE EXHAUSTIVE PHARMACIE (RÈGLE CRITIQUE) :
   Chaque TICKET DE CAISSE ou FACTURE de pharmacie contient PLUSIEURS médicaments.
   Tu DOIS lire CHAQUE LIGNE du ticket une par une, de haut en bas.
   Chaque VIGNETTE collée = 1 médicament = 1 entrée dans "details_lignes".
   Si "quantite" > 1 sur une ligne → c'est 1 entrée avec cette quantité, PAS plusieurs entrées.
   Si le ticket affiche 8 lignes → il DOIT y avoir 8 entrées dans details_lignes.
   ERREUR FRÉQUENTE : ne lire que le 1er et le dernier médicament. INTERDIT.
   VÉRIFICATION : compter le nombre de lignes sur le ticket et vérifier que details_lignes a le MÊME nombre.
   NOM DU MÉDICAMENT : lire depuis la VIGNETTE (petite étiquette collée) ou depuis la ligne imprimée du ticket. Les vignettes peuvent être inclinées, petites, ou partiellement recouvertes — les lire quand même.
   PRIX : chaque ligne a un prix. Le total du ticket = somme de toutes les lignes.
5c. CODE PCT / CODE AMM SUR TICKET PHARMACIE (RÈGLE CRITIQUE) :
   Les tickets de pharmacie ont des COLONNES : Code PCT | Désignation | Prix | Qté | Total.
   Chaque code PCT est sur la MÊME LIGNE que son médicament. NE JAMAIS décaler les codes.
   Ex: si le ticket affiche :
     35        | DOLIPRANE 1000 MG | 4.245 | 2 | 8.490
     301966    | ESORAL 40MG       | 15.475| 1 | 15.475
   Alors : code_amm de DOLIPRANE = "35", code_amm de ESORAL = "301966".
   ERREUR GRAVE : attribuer le code PCT d'un médicament à un autre. INTERDIT.
   MÉTHODE : lire le ticket LIGNE PAR LIGNE, de haut en bas, en gardant chaque code sur sa ligne.
   Les VIGNETTES collées à côté confirment le nom du médicament et son prix — les utiliser pour VÉRIFIER, pas pour décaler les codes.
6. Illisible sans référence imprimée → "[ILLISIBLE]". AUCUNE INVENTION.
7. CNAM : si un décompte CNAM est présent (mots-clés : "CNAM", "Décompte de remboursement", "Mnt Remb", "TotRemb"), extraire TOUTES les sections (Consultation, Actes, Médicaments...) avec code, désignation, quantité, date, montant_depense, montant_rembourse, franchise, décision. Extraire totaux.
8. CROISEMENT CNAM ↔ ACTES (RÈGLE CRITIQUE) :
   Si un décompte CNAM est présent, pour chaque acte chercher la ligne CNAM correspondante (même type, même date) :
   → Remplir "montant_cnam" avec le montant EFFECTIVEMENT REMBOURSÉ par la CNAM (colonne "Mnt Remb" du décompte).
   → Ce montant REMPLACE tout forfait de décision de prise en charge précédemment affecté.
   → NE JAMAIS modifier "montant" de l'acte. Le "montant" vient de la FACTURE ou du BS, JAMAIS du décompte.
   → Ex: facture = 278.500, décompte Mnt Remb = 231.000, reste adhérent = 47.500 :
     "montant" = "278.500" (facture)
     "montant_cnam" = "231.000" (décompte, PAS le forfait de la décision)
   → Si pas de correspondance → montant_cnam = "".
9. PIÈCES JUSTIFICATIVES : extraire dans "pieces_justificatives" avec rattachement_acte (index 0-based, null si impossible).
   Types : ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | PRISE_EN_CHARGE | CERTIFICAT_MEDICAL | AUTRE
   CERTIFICAT_MEDICAL : certificat médical confidentiel attestant une pathologie (cancer, maladie chronique). Extraire dans texte_libre. Si mentionne une pathologie APCI → alimenter aussi apci.pathologies.
   LETTRE_CONFIDENTIELLE : extraire INTÉGRALEMENT chirurgien, dates, motif COMPLET (ne JAMAIS tronquer), acte réalisé, codification CNAM.
   PRISE_EN_CHARGE : code_intervention, forfait CNAM, numéro/date décision. Rattacher à l'acte correspondant.
10. CROISEMENT ORDONNANCES ↔ PHARMACIE : vérifier cohérence médicaments prescrits vs délivrés. Signaler écarts dans "observations".
11. NUMÉRO DE BULLETIN : champ "BS N°" imprimé en HAUT du BS (ex: 0308601). Peut aussi être manuscrit/tamponné. NE PAS confondre avec numéro d'adhérent, contrat, ou Adhésion N°.
12. DATES : TOUJOURS normaliser en JJ/MM/AAAA avec zéros (3/7/26 → 03/07/2026, 6/8/26 → 06/08/2026). Année 2 chiffres → 20XX.
   DATE DU BULLETIN : chercher le champ "Date" sur le BS (souvent manuscrit). C'est la date de DÉPÔT du bulletin, PAS la date des actes. Si non visible → "".
13. MULTI-PAGES : bulletin recto + verso = UN SEUL document. FUSIONNER les 2 faces.
   FACE 1 (côté patient) : identité adhérent, bénéficiaire, employeur, N° BS (imprimé en haut), APCI, signature assuré.
   FACE 2 (côté professionnel) : sections médicales (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux) avec cachets praticiens + cachet employeur.
   Les 2 faces forment UN SEUL bulletin.
14. BÉNÉFICIAIRE : case cochée (✓/✗/remplie). Conjoint → nom malade = conjoint. Enfant → nom malade = enfant. Aucune → "Adhérent".
15. LETTRES-CLÉS CNAM : C=consultation généraliste | CS=spécialiste | V=visite | KC=chirurgie | KE=exploration | K=technique | Z=radiations ionisantes | B=biologie | Rd=radiologie diagnostique | D=dentaire | P=anatomopath | SC/SF=sage-femme | AMO/AMI/AMS=infirmier | TO/TM/APR=kiné
16. DÉSIGNATIONS EXACTES : lire CHAQUE LIGNE de la facture. NE JAMAIS utiliser de termes génériques. Détailler analyses biologiques dans details_lignes. Si plusieurs prestations → details_lignes. Montant global sans détail → PAS de details_lignes.
17. PHARMACIE : 1 acte = 1 ticket/1 pharmacie/1 date. Toutes lignes dans details_lignes. Fusionner doublons même pharmacie+date.
   PHARMACIES MULTIPLES : un dossier peut contenir 2, 3+ tickets de pharmacies DIFFÉRENTES → créer UN acte PHARMACIE par pharmacie/date. Ex: Pharmacie ABDENNADHER (66.885 DT) + Pharmacie BOUDRYA (77.500 DT) = 2 actes PHARMACIE séparés.
   ATTENTION : un ticket peut avoir 2, 5, 10+ médicaments. NE JAMAIS en ignorer.
   Lire le ticket LIGNE PAR LIGNE. Si une vignette est collée à côté d'une ligne → lire le nom depuis la vignette (plus fiable que le code-barres).
   Si le BS mentionne "Pharmacie" avec un montant mais que tu n'as pas de ticket détaillé → créer l'acte PHARMACIE avec le montant du BS, details_lignes vide.
   PRODUITS DE CONTRASTE (ex: MEDISCAN, OMNIPAQUE, IOPAMIRON) : ce sont des produits achetés en pharmacie POUR une radiologie. Créer un acte PHARMACIE normal. Le rattachement à la radiologie se fait via l'ordonnance du radiologue → signaler dans observations "Produit de contraste pour radiologie".
18. ACCORD PRÉALABLE ET PRISE EN CHARGE CNAM :
   a) ACCORD PRÉALABLE ASSUREUR : quand le BS ou l'assureur mentionne "Accord préalable", "APB", ou une colonne "Accord" → accord_prealable: true.
   b) DÉCISION DE PRISE EN CHARGE CNAM : c'est un document CNAM distinct (titre "DÉCISION DE PRISE EN CHARGE").
      → accord_prealable: true + remplir accord_prealable_details (code_intervention, forfait_cnam, numero_decision, date_decision).
      → Le "forfait_cnam" dans accord_prealable_details = montant du FORFAIT accordé (engagement maximum).
   c) MONTANT_CNAM : PRIORITÉ AU DÉCOMPTE CNAM :
      → Si un DÉCOMPTE CNAM existe → montant_cnam = montant EFFECTIVEMENT REMBOURSÉ (colonne "Mnt Remb" du décompte). C'est le montant RÉEL payé par la CNAM.
      → Si PAS de décompte mais une DÉCISION DE PRISE EN CHARGE → montant_cnam = forfait de la décision (par défaut).
      → Le forfait (décision) ≠ le remboursement réel (décompte). Le décompte PRIME TOUJOURS.
      → Ex: décision forfait = 332.500, mais décompte montre Mnt Remb = 231.000 → montant_cnam = "231.000" (pas 332.500).
         Le reste (47.500) est à la charge de l'adhérent.

Retourne UNIQUEMENT ce JSON :

{
          "infos_adherent": {
            "assureur_detecte": "BH Assurance | CARTE Assurances | CNAM | STAR | GAT | autre — détecter via le LOGO ou la mention de l'ASSUREUR (en haut du BS). ATTENTION : le formulaire BS peut être au format CNAM (formulaire standard) mais l'assureur est celui dont le LOGO apparaît (ex: CARTE Assurances). Ne PAS mettre 'CNAM' comme assureur sauf si c'est un BS CNAM sans logo d'assureur privé. Choisir UN SEUL assureur, jamais 'CNAM / CARTE'.",
            "nom_prenom": "Nom de l'adhérent",
            "numero_adherent": "N° de l'adhérent — chercher dans 'Adhésion N°' ou 'N° Adhérent'. Si absent, chercher dans 'Identifiant Unique'. ATTENTION : 'Adhésion N°' n'est PAS le contrat, c'est le numero_adherent. Transcrire EXACTEMENT tel qu'il apparaît, SANS espaces parasites.",
            "numero_contrat": "N° de contrat — chercher UNIQUEMENT dans 'Contrat N°' ou 'Police N°'. JAMAIS depuis 'Adhésion N°' (qui est le numero_adherent). Si pas de champ 'Contrat N°' explicite → ''.",
            "numero_cnam": "N° CNAM — chercher dans 'N° CNAM', 'CNAM', 'Identifiant Social'. Ce champ est DISTINCT de numero_adherent et numero_contrat. Si non visible → ''.",
            "employeur": "Nom de l'employeur (champ Employeur sur le bulletin)",
            "numero_bulletin": "N° du bulletin — chercher en HAUT du BS le champ 'BS N°'. Peut être imprimé ou manuscrit/tamponné. PRIORITÉ HAUTE.",
            "date_bulletin": "Date du bulletin (JJ/MM/AAAA)",
            "beneficiaire_coche": "Conjoint / Enfant / Adhérent (case cochée, défaut: Adhérent)",
            "mode_paiement": "tiers_payant | remboursement | '' (si mention 'Tiers Payant' visible → tiers_payant, sinon remboursement par défaut, si incertain → '')",
            "cachet_employeur": true,
            "signature_presente": true,
            "apci": {
              "numero_decision": "N° de décision APCI/ALD si visible",
              "pathologies": "Liste des pathologies couvertes si visible"
            }
          },
          "infos_patient": {
            "nom_prenom_malade": "Nom du patient soigné"
          },
          "actes_independants": [
            {
              "type": "MEDECIN",
              "date": "...",
              "praticien": "Nom du médecin traitant",
              "matricule_fiscale": "...",
              "acte": "Désignation EXACTE (ex: Consultation spécialisée cardiologie, Visite à domicile, Cholecystectomie coelioscopique, Anesthésie, Aide opératoire)",
              "lettre_cle": "KC ou K ou KE ou C ou CS ou V si visible",
              "cotation": "Nombre après la lettre-clé (ex: 50 pour KC50, 100 pour KC100)",
              "rattachement_hospitalisation": "Index 0-BASED de l'acte HOSPITALISATION dans actes_independants auquel ce prestataire est rattaché (meme convention que rattachement_acte). Remplir UNIQUEMENT pour les prestataires promus depuis une facture clinique. Si acte indépendant -> ne pas inclure ce champ.",
              "origine_ligne": "compte_autrui | details_facture — présent UNIQUEMENT sur un acte promu depuis une ligne de facture. Absent sur un acte saisi directement au bulletin.",
              "libelle_origine": "Libellé EXACT de la ligne telle qu'écrite sur la facture (ex: 'AIDE OPERATOIRE', 'DR SAKKA WISSAL'). Présent uniquement sur un acte promu.",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE de chaque prestation sur la facture",
                  "code_acte": "Lettre-clé de cette ligne si visible (ex: CS, Ke, KC)",
                  "cotation": "Coefficient de cette ligne",
                  "montant": "Montant de cette ligne"
                }
              ],
              "conventionne": "oui | non | '' (si mention 'conventionné' ou 'hors convention' visible sur facture/reçu/BS. Si non visible → '')",
              "montant": "Montant FACTURÉ — UNIQUEMENT depuis facture/reçu/BS. JAMAIS depuis décision CNAM ni décompte. Si pas de facture ni BS → ''.",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
            {
              "type": "RADIOLOGIE",
              "date": "...",
              "centre_radiologie": "Nom du centre ou médecin radiologue",
              "matricule_fiscale": "...",
              "medecin_prescripteur": "Médecin ayant prescrit la radio",
              "acte": "Désignation EXACTE (ex: Échographie abdominale, Radio thorax face, Scanner cérébral)",
              "lettre_cle": "Rd ou Z si visible",
              "cotation": "Nombre après la lettre-clé (ex: 15 pour Rd15)",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE de chaque examen (ex: TDM abdominale, Échographie pelvienne)",
                  "code_acte": "Code CNAM si visible (ex: Z, Rd)",
                  "cotation": "Coefficient",
                  "montant": "Montant de cette ligne"
                }
              ],
              "montant": "Montant FACTURÉ — UNIQUEMENT depuis facture/reçu/BS. JAMAIS depuis décision CNAM ni décompte. Si pas de facture ni BS → ''.",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
            {
              "type": "PHARMACIE",
              "date": "...",
              "pharmacie": "...",
              "matricule_fiscale": "...",
              "details_lignes": [
                {
                  "medicament": "Nom EXACT du médicament — lire depuis la VIGNETTE collée (priorité) ou depuis la ligne imprimée du ticket. Ex: DOLIPRANE 1000MG, AUGMENTIN 1G, VOLTARENE 75MG",
                  "code_amm": "Code PCT / Code AMM — lire depuis la COLONNE 'Code PCT' du ticket, sur la MÊME LIGNE que ce médicament. Ne JAMAIS prendre le code d'une autre ligne.",
                  "quantite": "Quantité achetée (ex: 1, 2, 3). Lire sur la ligne du ticket.",
                  "prix_unitaire": "Prix unitaire TTC",
                  "total_ligne": "Prix total de cette ligne (quantite × prix_unitaire)"
                }
              ],
              "montant": "TOTAL du ticket/facture pharmacie (doit = somme de tous les total_ligne)",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
           {
              "type": "LABORATOIRE",
              "date": "Date de l'analyse",
              "laboratoire": "Nom complet du labo",
              "matricule_fiscale": "MF du laboratoire",
              "medecin_prescripteur": "Nom du médecin",
              "details_lignes": [
                {
                  "acte": "Désignation EXACTE (ex: NUMÉRATION FORMULE SANGUINE, GLYCÉMIE À JEUN)",
                  "code_acte": "Code CNAM si visible (ex: BCA000010)",
                  "lettre_cle": "B",
                  "cotation": "Nombre (ex: 60 pour B60)",
                  "montant": "Montant de cette ligne"
                }
              ],
              "montant": "Montant Total facturé pour cet acte labo",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
            {
              "type": "HOSPITALISATION",
              "clinique": "Nom de la clinique/hopital",
              "matricule_fiscale": "MF de la clinique",
              "date_entree": "Date d'entree (JJ/MM/AAAA)",
              "date_sortie": "Date de sortie (JJ/MM/AAAA)",
              "nombre_nuitees": "Nombre de nuitees (date_sortie - date_entree). Ex: entree 17/07 sortie 18/07 = 1 nuitee",
              "motif": "Motif d'hospitalisation (accouchement, chirurgie, etc.)",
              "sejour": {
                "lignes": [
                  {"prestation": "CHAMBRE INDIVIDUELLE / LIT / HEBERGEMENT / NUITEE / AJUSTEMENT SEJOUR", "quantite": "", "prix_unitaire": "", "tva": "", "montant": ""}
                ],
                "total": "Somme des lignes sejour (chambre + ajustements sejour)"
              },
              "bloc_operatoire": {
                "lignes": [
                  {"prestation": "BLOC OPERATOIRE / SALLE DE REVEIL / REANIMATION / APPAREILLAGES / AJUSTEMENT APPAREILLAGES / OXYGENE", "quantite": "", "prix_unitaire": "", "tva": "", "montant": ""}
                ],
                "total": "Somme des lignes bloc operatoire"
              },
              "pharmacie_interne": {
                "lignes": [
                  {"prestation": "Nom EXACT du médicament/consommable/dispositif (ex: Sevoflurane, Paracetamol 1g, Compresse stérile)", "quantite": "", "prix_unitaire": "", "tva": "", "montant": ""}
                ],
                "total": "Somme des lignes pharmacie interne"
              },
              "autres_frais": {
                "lignes": [
                  {"prestation": "FRAIS DE DOSSIER / BLOUSE / TIMBRE / EXTRAS / AJUSTEMENT EXTRAS / AJUSTEMENT NEGATIF", "quantite": "", "prix_unitaire": "", "tva": "", "montant": ""}
                ],
                "total": "Somme des lignes autres frais"
              },
              "total_clinique": "Total des frais clinique propres (sejour + bloc + pharmacie_interne + autres)",
              "total_acte_cote": "Somme des montants de TOUTES les lignes classees acte_cote (prestataires du compte d'autrui promus en actes independants). C'est un CONTROLE : il doit etre egal a la somme des montants des actes portant rattachement_hospitalisation vers cette hospitalisation. Ne JAMAIS renvoyer 0 s'il existe au moins un acte promu.",
              "montant": "Total general de la facture (clinique + compte d'autrui)",
              "lettre_cle": "KC/KE si visible (depuis lettre confidentielle ou BS)",
              "cotation": "Nombre après la lettre-clé si visible",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false,
              "accord_prealable_details": {
                "code_intervention": "Code CNAM de l'intervention (ex: MGE000070) — depuis la décision de prise en charge",
                "forfait_cnam": "Montant du forfait CNAM accordé (ex: 2135)",
                "numero_decision": "N° de la décision de prise en charge",
                "date_decision": "Date de la décision"
              }
            },
            {
              "type": "DENTAIRE",
              "date": "Date de l'acte",
              "praticien": "Nom du dentiste",
              "matricule_fiscale": "MF du dentiste",
              "type_soin_dentaire": "DC pour SOINS DENTAIRES (partie haute du formulaire), DP pour PROTHESE DENTAIRE (partie basse)",
              "dents": "Numéros des dents traitées (ex: 11, 21, 36)",
              "acte": "Désignation EXACTE (ex: Détartrage, Extraction, Prothèse dentaire)",
              "lettre_cle": "D",
              "cotation": "Nombre après la lettre-clé (ex: 40 pour D40)",
              "montant": "Honoraires",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
            {
              "type": "OPTIQUE",
              "date": "Date de l'acte",
              "praticien": "Nom de l'opticien/lunettier",
              "matricule_fiscale": "MF de l'opticien",
              "acte": "Monture + Verres optiques",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE (ex: Monture optique, Verres progressifs, Traitement anti-reflet)",
                  "quantite": "Quantité",
                  "montant": "Montant"
                }
              ],
              "prescription_optique": {
                "oeil_droit": "Correction OD (ex: +0.25 (-0.25 à 5°))",
                "oeil_gauche": "Correction OG (ex: 0.00 (-0.50 à 175°))"
              },
              "montant": "Total TTC de la facture",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            },
            {
              "type": "PARAMEDICAL",
              "date": "Date de l'acte",
              "praticien": "Nom du praticien paramédical (kiné, sage-femme, infirmier)",
              "matricule_fiscale": "MF du praticien",
              "acte": "Désignation EXACTE (ex: Rééducation fonctionnelle du genou, Kinésithérapie respiratoire, Séance de rééducation, Soins infirmiers)",
              "nombre_seances_prescrites": "Nombre de séances prescrites sur l'ordonnance (si visible)",
              "nombre_seances_realisees": "Nombre de séances réalisées / facturées (si visible)",
              "lettre_cle": "SC ou SF ou AMO ou AMI ou AMS ou TO ou TM ou APR si visible",
              "cotation": "Nombre après la lettre-clé",
              "montant": "Honoraires",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false
            }
          ],
          "cnam": {
            "numero_assure": "N° de l'assuré CNAM",
            "caisse": "Nom de la caisse (ex: CNSS, CNRPS...)",
            "beneficiaire": "Bénéficiaire (ex: Conjoint - SAMIA, Adhérent...)",
            "regime": "Régime (ex: APCI/MLD, AMG...)",
            "ref_paiement": "Référence de paiement / Mandat",
            "date_decompte": "Date du décompte (JJ/MM/AAAA)",
            "details_remboursement": [
              {
                "categorie": "Consultation & Visites | Actes | Médicaments | autre section",
                "lignes": [
                  {
                    "code": "Code du produit/acte (si disponible)",
                    "designation": "Désignation de l'acte ou du médicament",
                    "quantite": "Quantité (si disponible)",
                    "date": "Date de l'acte",
                    "montant_depense": "Montant dépensé",
                    "montant_rembourse": "Montant remboursé par la CNAM",
                    "franchise": "Montant franchise / ticket modérateur / part restant à charge (si colonne visible)",
                    "decision": "Décision médicale (Accord, Rejet, etc.)"
                  }
                ]
              }
            ],
            "total_depense": "Total dépensé (toutes sections)",
            "total_rembourse": "Total remboursé par la CNAM (toutes sections)",
            "total_franchise": "Total franchise / part restant à charge (si visible)"
          },
          "pieces_justificatives": [
            {
              "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | PRISE_EN_CHARGE | CERTIFICAT_MEDICAL | AUTRE",
              "rattachement_acte": 0,
              "praticien": "Nom du médecin/prescripteur",
              "date": "Date du document (JJ/MM/AAAA)",
              "contenu": {
                "medicaments_prescrits": [
                  {
                    "nom": "Nom du médicament",
                    "posologie": "Posologie prescrite",
                    "duree": "Durée du traitement",
                    "quantite": "Quantité prescrite"
                  }
                ],
                "resultats_bilan": [
                  {
                    "parametre": "Nom du paramètre (ex: Glycémie, Cholestérol...)",
                    "valeur": "Valeur mesurée",
                    "unite": "Unité (g/l, mmol/l...)",
                    "norme": "Valeurs normales de référence"
                  }
                ],
                "texte_libre": "Contenu textuel pour COMPTE_RENDU, PRISE_EN_CHARGE ou AUTRE (resume fidele). Pour PRISE_EN_CHARGE, y reporter le code d'intervention, le forfait accorde, le numero et la date de decision — ces memes valeurs alimentent accord_prealable_details de l'acte rattache.",
                "lettre_confidentielle": {
                  "clinique": "Nom de la clinique",
                  "chirurgien": "Nom du chirurgien",
                  "date_hospitalisation": "Date d'hospitalisation (JJ/MM/AAAA)",
                  "date_operation": "Date d'opération (JJ/MM/AAAA)",
                  "motif": "Motif COMPLET et INTÉGRAL tel qu'écrit sur la lettre — recopier TOUT le texte médical sans tronquer ni résumer (ex: 'Fibroscopie pour RGO du gastric, HP bactérie à éradiquer, kyste rectal à explorer'). Ne JAMAIS réduire à un seul mot.",
                  "acte_realise": "Description COMPLÈTE de l'acte subi tel qu'écrit après 'il (elle) a subi' — recopier intégralement (ex: 'Gastroscopie avec biopsie et extraction polype')",
                  "codification_cnam": "Codification CNAM complète (ex: Kc P1)",
                  "lettre_cle": "Lettre-clé extraite (ex: KC)",
                  "cotation": "Cotation extraite (ex: P1)"
                },
                "facture_details": {
                  "numero_facture": "Numéro de la facture",
                  "date_facture": "Date de la facture (JJ/MM/AAAA)",
                  "clinique": "Nom de la clinique/établissement",
                  "matricule_fiscale": "MF de la clinique",
                  "lignes_clinique": [
                    {
                      "designation": "Désignation EXACTE de la prestation (ex: FORFAIT BOX ENDOSCOPIE, BIOPSIE, PHARMACIE, FRAIS DE DOSSIER)",
                      "quantite": "Quantité",
                      "prix_unitaire": "Prix unitaire",
                      "tva_pourcent": "Taux TVA (ex: 7%, 19%, 0%)",
                      "montant_ht": "Montant HT",
                      "montant_tva": "Montant TVA",
                      "montant_ttc": "Montant TTC"
                    }
                  ],
                  "total_clinique_ht": "Total HT des frais clinique",
                  "total_clinique_tva": "Total TVA des frais clinique",
                  "total_clinique_ttc": "Total TTC des frais clinique",
                  "compte_autrui": [
                    {
                      "nom_prestataire": "Nom du prestataire externe",
                      "matricule_fiscale": "MF du prestataire",
                      "nature_acte": "Nature de l'acte (Acte médical, Laboratoire, Acte Endoscopie, etc.)",
                      "montant_ht": "Montant HT",
                      "montant_tva": "Montant TVA",
                      "montant_ttc": "Montant TTC"
                    }
                  ],
                  "total_compte_autrui": "Total TTC compte d'autrui",
                  "timbre_fiscal": "Montant du timbre fiscal",
                  "total_facture_ttc": "Total TTC de la facture (clinique + compte d'autrui + timbre)",
                  "avance": "Avance versée par le patient (si visible)",
                  "net_a_payer": "Net à payer ou à rembourser (si visible)"
                }
              },
              "montant": "Montant figurant sur la pièce (si applicable)",
              "observations": "Remarques : écarts ordonnance/pharmacie, anomalies détectées"
            }
          ],
          "synthese": {
            "total_medecin": "Somme Consultations ou 0",
            "total_radiologie": "Somme Actes Radio/Imagerie ou 0",
            "total_pharmacie": "Somme pharmacie ou 0",
            "total_laboratoire": "Total labo ou 0",
            "total_hospitalisation": "Total hospitalisation/clinique ou 0",
            "total_dentaire": "Total actes dentaires ou 0",
            "total_optique": "Total actes optique ou 0",
            "total_paramedical": "Total actes paramédicaux ou 0",
            "total_global_calcule": "La somme de tout le dossier",
            "total_cnam": "Total remboursé par la CNAM (depuis le décompte CNAM si présent, sinon 0)",
            "devise": "DT"
          }
        }

RÈGLES COMPLÉMENTAIRES :
- beneficiaire_coche : case cochée (✓/✗/remplie) → "Adhérent"/"Conjoint"/"Enfant". Défaut: "Adhérent".
- conjoint.nom_prenom : UNIQUEMENT si case "Conjoint" cochée.
- enfants : UNIQUEMENT si case "Enfant" cochée, sinon [].
- mode_paiement : mention "Tiers Payant" → "tiers_payant", sinon "remboursement". Incertain → "".
- cachet_employeur / signature_presente : true si visible sur le bulletin, false si absent.
  ATTENTION : la signature de l'assuré est souvent en BAS À DROITE du recto du BS (champ "SIGNATURE DE L'ASSURÉ"). C'est un griffonnage manuscrit — ne pas le confondre avec du texte. Si TOUT trait manuscrit ressemblant à une signature est visible → true.
  Le cachet employeur est un TAMPON (rond ou rectangulaire) de l'entreprise, souvent au VERSO du BS.
- apci : DÉTECTER via 3 sources possibles :
  1) CHECKBOX "APCI" sur le BS (en haut de la face professionnelle, champ "Soins effectués dans le cadre de : APCI"). Si coché → apci.
  2) CERTIFICAT MÉDICAL CONFIDENTIEL mentionnant une pathologie chronique (cancer, diabète, insuffisance rénale, etc.) → extraire pathologie dans apci.pathologies.
  3) DÉCOMPTE CNAM avec "Régime: APCI" ou "ALD" → apci.
  Si aucune de ces 3 sources → ne pas inclure apci.
- conventionne : si mention "conventionné"/"hors convention" visible → "oui"/"non". Sinon "".
- nombre_seances : PARAMEDICAL → extraire séances prescrites (ordonnance) et réalisées (facture). Si non visible → "".
- cnam : UNIQUEMENT si décompte CNAM présent. Sinon ne pas inclure.
- pieces_justificatives : UNIQUEMENT sous-clés pertinentes au type (medicaments_prescrits pour ORDONNANCE, resultats_bilan pour BILAN, lettre_confidentielle pour LETTRE_CONFIDENTIELLE, facture_details pour FACTURE clinique, texte_libre pour COMPTE_RENDU/PRISE_EN_CHARGE/CERTIFICAT_MEDICAL/AUTRE).
- numero_adherent ≠ numero_contrat ≠ numero_cnam : 3 champs DISTINCTS. Ne pas confondre. 'Adhésion N°' = numero_adherent. Le numéro en face du label 'Adhésion N°' est TOUJOURS le numero_adherent, quelle que soit sa taille.
- Si aucun champ "Contrat N°" explicite → numero_contrat = "".
- numero_cnam : format long (ex: 1688627809). Si BS assureur sans champ CNAM visible → "".
- CODE CNAM DU PRESTATAIRE ≠ CODE CNAM DU PATIENT : sur le BS, chaque section a un champ "Code CNAM et MF du professionnel de santé" (ex: 1/12896/11). C'est le code du PRATICIEN, PAS du patient. NE JAMAIS le mettre dans numero_cnam. De même sur les tickets pharmacie, "Code CNAM: 1/xxxxx/xx" est le code du PHARMACIEN.
- HOSPITALISATION SECTIONS : répartir lignes dans sejour/bloc_operatoire/pharmacie_interne/autres_frais. Chaque section a lignes[] + total.
- HOSPITALISATION COMPTE D'AUTRUI → ACTES SÉPARÉS : chaque prestataire externe → acte indépendant avec rattachement_hospitalisation (0-based). Clinique garde UNIQUEMENT ses sections groupées, SANS le compte_autrui.
- HOSPITALISATION ACCORD PRÉALABLE : si décision de prise en charge → accord_prealable: true + accord_prealable_details (code_intervention, forfait_cnam, numero_decision, date_decision).
- DENTAIRE : type_soin_dentaire = "DC" (soins) ou "DP" (prothèse). Lettre-clé = D.
- OPTIQUE : type "OPTIQUE" (JAMAIS "PARAMEDICAL"). Séparer monture/verres dans details_lignes + prescription_optique.
- COMPTE-RENDU = PIÈCE + ACTE : générer l'acte correspondant (RADIOLOGIE/MEDECIN/LABORATOIRE). GARDE-FOU ANTI-DOUBLON : si acte existe déjà → rattacher via rattachement_acte, NE PAS dupliquer.
- ÉCART COTATION : lettre confidentielle ≠ BS → retenir lettre confidentielle + signaler dans observations.
- Noms tunisiens : "nekk"→"Mekki", "nohaned"→"Mohamed".
- matricule_fiscale : format COMPLET avec les slashs : 7 chiffres + "/" + lettre + "/A/" + lettre + "/000" (ex: 1538875N/A/P/000, 1671890K/A/M/000). TOUJOURS inclure les slashs et le suffixe "/000". Si partiel (manque les slashs ou le /000) → compléter depuis le cachet ou la facture. Si introuvable → "".
- CONTRÔLE FINAL : total_acte_cote + total_clinique ≈ montant facture (± TVA/timbre). Écart > 1 DT → re-vérifier.
Si champ introuvable → "". Pas de balises Markdown.`;

// ─────────────────────────────────────────────
// PROMPTS CONSTRUITS À PARTIR DE PROMPT_BASE
// ─────────────────────────────────────────────
const PROMPT = `Analyse ces images d'un bulletin de soins d'assurance maladie tunisien.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien.
Identifie l'assureur via le logo, l'en-tête, la mise en page ou toute mention visible.
Extrais avec précision TOUTES les informations visibles.
${PROMPT_BASE}`;

const PROMPT_DOSSIER = `Tu reçois plusieurs images du MÊME dossier médical d'un adhérent d'assurance maladie en Tunisie.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien.
Ces images peuvent inclure : bulletin de soins, reçus, ordonnances, analyses, factures, décompte CNAM, comptes-rendus, décisions de prise en charge, lettres confidentielles, etc.
Tu dois COMBINER toutes ces images pour produire UN SEUL dossier structuré et complet.
${PROMPT_BASE}
IMPORTANT : le BS est le document PRINCIPAL. Les autres documents sont des PIÈCES JUSTIFICATIVES. Suivre les étapes ci-dessous dans l'ORDRE.

ÉTAPE 1 — IDENTIFIER : Classe chaque image (bulletin de soins, ordonnance, reçu, facture, bilan, compte-rendu, lettre confidentielle, décision de prise en charge, décompte CNAM, ticket pharmacie, certificat médical...).

ÉTAPE 2 — LIRE LE BS EXHAUSTIVEMENT :
   Le BS est le DOCUMENT MAÎTRE. Lire les 2 faces :
   a) FACE PATIENT : nom, numéro adhérent (Adhésion N°), employeur, BS N°, date, bénéficiaire, APCI, signature.
   b) FACE PROFESSIONNEL : lire CHAQUE SECTION une par une (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux).
      Pour chaque section remplie → créer l'acte correspondant avec : date, désignation, code acte, cotation, honoraires, cachet praticien (nom + MF).
   c) Ne rien oublier : si le BS mentionne un acte, il DOIT apparaître dans actes_independants.

ÉTAPE 3 — LIRE CHAQUE FICHIER JUSTIFICATIF :
   Pour chaque document (facture, ticket, ordonnance, lettre confidentielle, décision CNAM, compte-rendu...) :
   a) Extraire TOUTES les informations : montants, détails lignes, praticien, MF, codes, dates.
   b) PHARMACIE : lire CHAQUE LIGNE du ticket (tous les médicaments, vignettes, codes PCT, quantités, prix).
   c) FACTURE : lire chaque ligne avec montant individuel.
   d) LETTRE CONFIDENTIELLE : extraire codification CNAM (lettre-clé, coefficient), motif complet, acte réalisé.
   e) DÉCISION DE PRISE EN CHARGE : extraire code_intervention, forfait_cnam, numéro/date décision.

ÉTAPE 4 — CROISER BS ↔ FICHIERS (ENRICHISSEMENT) :
   Pour CHAQUE acte du BS, chercher dans les fichiers les informations COMPLÉMENTAIRES :
   a) MATCHING : associer un fichier à un acte par TYPE + PRATICIEN + DATE + MONTANT.
   b) Enrichir chaque acte :
      - Facture/Reçu → montant exact, MF, details_lignes
      - Ordonnance → médecin prescripteur, médicaments prescrits
      - Lettre confidentielle → lettre_cle, cotation (PRIME sur le BS)
      - Décision CNAM → code_intervention, forfait_cnam, accord_prealable
      - Compte-rendu → détails de l'examen
   c) Si un code (RAD010260) apparaît sur la décision mais PAS sur le BS → le reporter sur l'acte.
   d) Si une MF ou lettre-clé apparaît sur un fichier mais PAS sur le BS → la reporter.
   e) AUCUN CHAMP NE DOIT RESTER VIDE si l'information existe dans un AUTRE document.
   f) INTERDIT — DÉCISION CNAM → "montant" : le montant d'une décision de prise en charge CNAM va UNIQUEMENT dans forfait_cnam et montant_cnam. JAMAIS dans "montant". Si aucune facture ni BS ne donne le montant → "montant" = "". Ne JAMAIS copier un montant CNAM vers "montant".

ÉTAPE 5 — CROISER CNAM :
   Si un décompte CNAM est présent → pour chaque acte, chercher la ligne CNAM correspondante.
   montant_cnam = montant REMBOURSÉ du décompte (colonne "Mnt Remb"). Priorité sur le forfait de la décision.
   RAPPEL : ne JAMAIS toucher "montant" dans cette étape. "montant" vient de la facture/BS, pas du CNAM.

ÉTAPE 6 — PIÈCES JUSTIFICATIVES :
   Extraire chaque document dans "pieces_justificatives" avec rattachement_acte.
   Vérifier cohérence ordonnance ↔ pharmacie. Signaler écarts dans observations.

ÉTAPE 7 — VÉRIFICATION FINALE :
   a) Relire le BS section par section : chaque acte listé est-il dans actes_independants ?
   b) Chaque médicament du ticket est-il dans details_lignes ?
   c) Les montants sont-ils cohérents (facture vs BS vs total) ?
   d) Aucun doublon (un même soin ne doit apparaître qu'UNE fois) ?`;


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
    version: "3.0.0", // version upgradée grâce aux auto-corrections !
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
      version: "3.0.0",
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
