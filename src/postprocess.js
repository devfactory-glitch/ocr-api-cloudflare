// src/postprocess.js — v2
// Couche DÉTERMINISTE appliquée après l'OCR — indépendante du modèle et du prompt.
// Un prompt peut dévier ; ce code, non.
//
// À appeler dans analyseSingleDossier(), APRÈS enrichActesFromContext()
// et APRÈS enrichWithNomenclature().
//
// CORRECTIFS v1 -> v2 :
//   [F1] Comparaison de noms par INTERSECTION DE TOKENS (sameName) au lieu du
//        dernier mot. "Dr Imed Eddine ESSID" ≡ "ESSID Imededdine",
//        "Dr. Raafet BABA" ≡ "BABA Raafet". Sans ça, les VERROUS 11 et 5
//        ne trouvaient jamais leur cible.
//   [F2] analyseHonoraires() est PURE (aucun effet de bord). L'écriture des
//        observations passe par addObs(), anti-doublon, dans une passe dédiée.
//   [F3] L'identité n'est corrigée QUE si une source imprimée existe réellement ;
//        sinon on signale sans prétendre avoir corrigé.
//   [F4] nom_prenom_malade : on retient le candidat le PLUS COMPLET, jamais un
//        nom tronqué issu d'une note d'honoraires.
//   [F5] Suppression de la variable morte bestMatch.

// ─────────────────────────────────────────────────────────────────────────────
// Helpers numériques
// ─────────────────────────────────────────────────────────────────────────────
const num = (v) => {
  if (v == null || v === "") return 0;
  const s = String(v)
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const norm = (s) =>
  String(s || "")
    .trim()
    .toLowerCase();

const CODE_INTERVENTION = /^[A-Z]{2,4}\d{6,}$/;
const AJUSTEMENT = /^\s*ajustement/i;
const SECTIONS = [
  "sejour",
  "bloc_operatoire",
  "pharmacie_interne",
  "autres_frais",
];

// ─────────────────────────────────────────────────────────────────────────────
// [F1] Comparaison de noms — robuste à l'ordre nom/prénom et aux titres
// ─────────────────────────────────────────────────────────────────────────────
function nameTokens(s) {
  return new Set(
    String(s || "")
      .replace(/\([^)]*\)/g, "") // retirer (GYN), (PED)...
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // retirer les accents
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(
        (w) => w.length >= 3 && !/^(dr|pr|mme|mlle|monsieur|madame)$/.test(w),
      ),
  );
}

function sameName(a, b) {
  if (!a || !b) return false;
  // Fast path : même chaîne normalisée → match évident
  if (normCompare(a) === normCompare(b)) return true;
  const A = nameTokens(a),
    B = nameTokens(b);
  if (A.size === 0 || B.size === 0) return false;
  for (const t of A) if (B.has(t)) return true; // au moins un token commun
  return false;
}

function normName(s) {
  return [...nameTokens(s)].sort().join(" ");
}

function normCompare(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// [F2] Observations sans doublon
// ─────────────────────────────────────────────────────────────────────────────
function addObs(obj, txt) {
  if (!obj || !txt) return;
  const cur = String(obj.observations || "");
  if (cur.includes(txt)) return;
  obj.observations = [cur, txt].filter(Boolean).join(" | ");
}

// ─────────────────────────────────────────────────────────────────────────────
// [F2] Analyse des honoraires d'un acte — FONCTION PURE
// Retourne { horsFacture, doublons: [montants trouvés aussi sur la facture] }
// ─────────────────────────────────────────────────────────────────────────────
function analyseHonoraires(a, compteAutruiLignes) {
  const res = { horsFacture: 0, doublons: [] };
  if (Array.isArray(a.details_lignes)) {
    const nh = a.details_lignes.filter((l) => l.source === "note_honoraires");
    if (nh.length > 0) {
      const ca = compteAutruiLignes || [];
      for (const line of nh) {
        const m = num(line.montant);
        const dbl = ca.some(
          (c) =>
            sameName(c.nom_prestataire, a.praticien) &&
            Math.abs(num(c.montant_ttc) - m) <= 0.1,
        );
        if (dbl) res.doublons.push(m);
        else res.horsFacture += m;
      }
      return res;
    }
  }
  if (a.non_percu === true || a.non_percu === "true")
    res.horsFacture = num(a.montant);
  return res;
}
const honorairesHorsFactureActe = (a, ca) =>
  analyseHonoraires(a, ca).horsFacture;

// ─────────────────────────────────────────────────────────────────────────────
// Constantes domaine
// ─────────────────────────────────────────────────────────────────────────────
const RUBRIQUES_KC = ["K", "FAN", "SO"];

// ─────────────────────────────────────────────────────────────────────────────
// Classification de secours
// ─────────────────────────────────────────────────────────────────────────────
function rubriqueParType(acte) {
  const t = String(acte.type || "").toUpperCase();
  if (t === "RADIOLOGIE") return "Z";
  if (t === "LABORATOIRE") return "B";
  if (t === "PHARMACIE") return "PH";
  return "";
}

function rubriqueParRole(role) {
  const r = norm(role);
  if (r.includes("anesth")) return "FAN";
  if (
    r.includes("chirurgien") ||
    r.includes("aide") ||
    r.includes("instrument") ||
    r.includes("panseur")
  )
    return "K";
  if (r.includes("pediatre") || r.includes("pédiatre")) return "CS";
  return "AUTRE";
}

function rubriqueParSection(section, libelle) {
  const l = norm(libelle);
  if (section === "pharmacie_interne") return "PH";
  if (section === "sejour") return "JHC";
  if (section === "bloc_operatoire") return "SO";
  if (l.includes("dossier")) return "JHC";
  return "AUTRE";
}

const MOTS_DISPOSITIF = [
  // Multi-word (captent les faux positifs consommables avant les mono-mots)
  "masque a oxygene", "masque d'oxygene", "masque oxygene",
  "lunette d'oxygene", "lunette oxygene",
  "manche pour bistouri", "manche bistouri",
  "sac a urine", "sac urine",
  // Mono-mot
  "sonde", "catheter", "aiguille", "seringue", "perfuseur",
  "electrode", "tubulure", "plaque", "drain", "neofil",
  "suture", "clamp", "bistouri", "nebuliseur",
];
const MOTS_CONSOMMABLE = [
  "gant", "casaque", "alese", "compresse", "champ",
  "housse", "masque", "lancette", "bandelette", "trousse",
  "kit ", "sparadrap", "fixaderm", "lunette", "manche", "brosse",
];
const MOTS_HOTELIER = [
  "bracelet", "rasoir", "thermometre", "blouse", "kit patient",
];

function natureLigne(ligne) {
  // Classification 100% déterministe — on ignore ligne.nature (instable)
  // Normalisation : accents supprimés pour robustesse OCR
  const l = String(ligne.prestation || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  // Ordre : HOTELIER (court, non ambigu) → DISPOSITIF → CONSOMMABLE → repli TVA
  if (MOTS_HOTELIER.some((m) => l.includes(m))) return "HOTELIER";
  if (MOTS_DISPOSITIF.some((m) => l.includes(m))) return "DISPOSITIF_MEDICAL";
  if (MOTS_CONSOMMABLE.some((m) => l.includes(m))) return "CONSOMMABLE_UU";
  const tva = num(String(ligne.tva).replace("%", ""));
  return tva === 0 ? "MEDICAMENT" : "CONSOMMABLE_UU";
}

// Bornes indicatives par rôle (DT)
const BORNES_ROLE = {
  chirurgien: [400, 1500],
  gynecologue: [400, 1500],
  gynécologue: [400, 1500],
  anesthesiste: [150, 400],
  anesthésiste: [150, 400],
  "aide operatoire": [100, 300],
  "aide opératoire": [100, 300],
  instrumentiste: [50, 200],
  panseur: [50, 200],
};

// ═════════════════════════════════════════════════════════════════════════════
export function postProcess(data) {
  if (!data || !Array.isArray(data.actes_independants)) return data;

  const warn = [];
  const actes = data.actes_independants;

  // Lignes compte_autrui du dossier (référence pour le dédoublonnage)
  const compteAutruiLignes = [];
  for (const p of data.pieces_justificatives || []) {
    for (const ca of p.contenu?.facture_details?.compte_autrui || []) {
      compteAutruiLignes.push(ca);
    }
  }

  // ═══ VERROU 0 — Index de rattachement + intégrité du schéma ════════════════
  {
    const hospiIndexes = [];
    for (let i = 0; i < actes.length; i++) {
      if (actes[i].type === "HOSPITALISATION") hospiIndexes.push(i);
    }
    if (hospiIndexes.length === 1) {
      const bon = hospiIndexes[0];
      let nbFix = 0;
      for (const a of actes) {
        if (a.rattachement_hospitalisation == null) continue;
        const ri = a.rattachement_hospitalisation;
        if (ri !== bon && actes[ri]?.type !== "HOSPITALISATION") {
          a.rattachement_hospitalisation = bon;
          nbFix++;
        }
      }
      if (nbFix > 0) {
        warn.push(
          `${nbFix} rattachement(s) remappé(s) vers l'index ${bon} (seule HOSPITALISATION du dossier)`,
        );
      }
    } else if (hospiIndexes.length > 1) {
      for (const a of actes) {
        if (a.rattachement_hospitalisation == null) continue;
        const ri = a.rattachement_hospitalisation;
        if (
          ri < 0 ||
          ri >= actes.length ||
          actes[ri]?.type !== "HOSPITALISATION"
        ) {
          warn.push(
            `rattachement_hospitalisation ${ri} invalide pour ${a.praticien || a.type} — plusieurs hospitalisations, remappage impossible`,
          );
        }
      }
    }
    let nbTypeFix = 0;
    for (const pj of data.pieces_justificatives || []) {
      if (
        pj.rattachement_acte != null &&
        (pj.rattachement_acte < 0 || pj.rattachement_acte >= actes.length)
      ) {
        pj.rattachement_acte = null;
      }
      if (!pj.type_piece && pj.type) {
        pj.type_piece = pj.type;
        delete pj.type;
        nbTypeFix++;
      }
    }
    if (nbTypeFix > 0) {
      warn.push(
        `${nbTypeFix} pièce(s) justificative(s) : clé "type" renommée en "type_piece"`,
      );
    }
  }

  // ═══ VERROU 10 — Identité (contamination par un BS écarté) ═════════════════
  {
    const rel = data.releve_assureur;
    const adh = data.infos_adherent || {};
    const pat = data.infos_patient || {};

    // Noms attestés par les pièces IMPRIMÉES
    const nomsImprimes = [];
    let nomDecisionCnam = null;
    for (const p of data.pieces_justificatives || []) {
      const tp = p.type_piece || "";
      if (tp === "PRISE_EN_CHARGE" && p.contenu?.texte_libre) {
        const m = p.contenu.texte_libre.match(
          /(?:ARTICLE\s*1\s*:|nom(?:\s+et\s+pr[ée]nom)?[^:]*:|assur[ée]\(?e?\)?[^:]*:)\s*([A-ZÀ-Ü][A-ZÀ-Üa-zà-ü'\- ]{3,})/,
        );
        if (m) {
          // Couper avant le libellé de champ suivant (Qualité, Identifiant, Assuré...)
          const brut = m[1]
            .split(/\s+(?=Qualit|Identifiant|Assur|Demande|Date|N°|est\s)/i)[0]
            .replace(/[.,;].*$/, "")
            .trim();
          if (brut.length >= 3) {
            nomDecisionCnam = brut;
            nomsImprimes.push(brut);
          }
        }
      }
      if (p.contenu?.note_honoraires?.patient)
        nomsImprimes.push(p.contenu.note_honoraires.patient);
    }
    if (rel?.nom_adherent) nomsImprimes.push(rel.nom_adherent);
    if (rel?.nom_malade) nomsImprimes.push(rel.nom_malade);

    // [F3] Contamination de l'identité adhérent
    if (adh.nom_prenom && nomsImprimes.length > 0) {
      const match = nomsImprimes.some((n) => sameName(n, adh.nom_prenom));
      if (!match) {
        const ancien = adh.nom_prenom;
        const remplacant = rel?.nom_adherent || nomDecisionCnam || null;
        data.controles = data.controles || {};
        data.controles.documents_ignores =
          data.controles.documents_ignores || [];
        data.controles.documents_ignores.push(
          `BS écarté : identité '${ancien}' ne correspond à aucune pièce du dossier`,
        );
        if (!remplacant) {
          // Aucune source imprimée : signaler SANS prétendre corriger
          warn.push(
            `Contamination identité probable : '${ancien}' absent de toutes les pièces — ` +
              `aucune source imprimée disponible pour corriger, à vérifier manuellement`,
          );
        } else {
          adh.nom_prenom = remplacant;
          if (rel?.matricule_adherent)
            adh.numero_adherent = String(rel.matricule_adherent);
          if (rel?.contrat_n) adh.numero_contrat = String(rel.contrat_n);
          if (rel?.societe) adh.employeur = rel.societe;
          if (rel?.bulletin_n && !adh.numero_bulletin)
            adh.numero_bulletin = String(rel.bulletin_n);
          warn.push(
            `Identité corrigée : '${ancien}' remplacé par '${remplacant}' — ` +
              `le BS retenu appartenait à un autre adhérent`,
          );
        }
      }
    }

    // [F4] Nom du malade — retenir le candidat le PLUS COMPLET
    if (pat.nom_prenom_malade && nomsImprimes.length > 0) {
      const ancien = pat.nom_prenom_malade;
      const exact = nomsImprimes.some((n) => normName(n) === normName(ancien));
      if (!exact) {
        const candidats = [rel?.nom_malade, rel?.nom_adherent, ...nomsImprimes]
          .filter(Boolean)
          .filter((n) => sameName(n, ancien) || nomsImprimes.length === 1)
          .sort((a, b) => nameTokens(b).size - nameTokens(a).size);
        const candidat = candidats[0];
        if (candidat && nameTokens(candidat).size >= nameTokens(ancien).size) {
          pat.nom_prenom_malade = candidat;
          warn.push(
            `Nom malade corrigé : '${ancien}' → '${candidat}' (source imprimée)`,
          );
        }
      }
    }

    // Arbitrage bénéficiaire par la décision CNAM
    let forceAdherent = false;
    for (const p of data.pieces_justificatives || []) {
      if ((p.type_piece || "") !== "PRISE_EN_CHARGE") continue;
      const txt = String(p.contenu?.texte_libre || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      if (txt.includes("assure lui meme") || txt.includes("assure lui-meme")) {
        forceAdherent = true;
        break;
      }
    }
    if (forceAdherent) {
      // C6a — Construire un Set des index d'actes rattachés à une pièce nouveau-né
      const indexesNouveauNe = new Set();
      const RE_NN = /bebe|nouveau.ne|nourrisson/;
      for (const p of data.pieces_justificatives || []) {
        let isNN = p.patient_concerne === "nouveau_ne";
        if (!isNN) {
          const blob = normCompare(
            JSON.stringify(p.contenu || "") + " " + (p.observations || ""),
          );
          if (RE_NN.test(blob)) isNN = true;
        }
        if (isNN && p.rattachement_acte != null &&
            p.rattachement_acte >= 0 && p.rattachement_acte < actes.length) {
          indexesNouveauNe.add(p.rattachement_acte);
        }
      }

      let nbCorr = 0;
      const bc = norm(adh.beneficiaire_coche);
      if (bc && bc !== "adherent" && bc !== "adhérent") {
        adh.beneficiaire_coche = "Adhérent";
        nbCorr++;
      }

      // C6b — Arbitrage actes avec protection nouveau-né
      for (let i = 0; i < actes.length; i++) {
        const a = actes[i];
        if (a.patient_concerne === "nouveau_ne" || indexesNouveauNe.has(i)) {
          if (a.patient_concerne !== "nouveau_ne") {
            a.patient_concerne = "nouveau_ne";
            warn.push(
              `Acte ${a.praticien || a.pharmacie || a.type} : patient_concerne forcé à "nouveau_ne" (pièce nouveau-né détectée)`,
            );
          }
          continue;
        }
        if (a.patient_concerne && a.patient_concerne !== "adherent") {
          a.patient_concerne = "adherent";
          nbCorr++;
        }
        if (a.type !== "HOSPITALISATION") continue;
        for (const sec of SECTIONS) {
          for (const ligne of a[sec]?.lignes || []) {
            if (ligne.patient_concerne === "nouveau_ne") continue;
            if (
              ligne.patient_concerne &&
              ligne.patient_concerne !== "adherent"
            ) {
              ligne.patient_concerne = "adherent";
              nbCorr++;
            }
          }
        }
      }

      // C6c — Arbitrage pièces justificatives avec protection nouveau-né
      for (const p of data.pieces_justificatives || []) {
        if (p.patient_concerne === "nouveau_ne") continue;
        // Protection : pièce liée à un acte nouveau-né
        if (p.rattachement_acte != null && indexesNouveauNe.has(p.rattachement_acte)) {
          p.patient_concerne = "nouveau_ne";
          continue;
        }
        // Protection : contenu mentionnant nouveau-né
        const blob = normCompare(
          JSON.stringify(p.contenu || "") + " " + (p.observations || ""),
        );
        if (RE_NN.test(blob)) {
          p.patient_concerne = "nouveau_ne";
          continue;
        }
        if (p.patient_concerne && p.patient_concerne !== "adherent") {
          p.patient_concerne = "adherent";
          nbCorr++;
        }
      }

      if (nbCorr > 0) {
        warn.push(
          `Arbitrage CNAM "Assuré lui même" : ${nbCorr} valeur(s) corrigée(s) en "Adhérent"`,
        );
      }
    }
  }

  const hospis = actes
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.type === "HOSPITALISATION");

  // ═══ VERROU 1 — Purger les lignes AJUSTEMENT ═══════════════════════════════
  for (const { a: h } of hospis) {
    let sommeAjust = 0,
      nbAjust = 0;
    for (const sec of SECTIONS) {
      const bloc = h[sec];
      if (!bloc || !Array.isArray(bloc.lignes)) continue;
      const gardees = [];
      for (const ligne of bloc.lignes) {
        if (AJUSTEMENT.test(ligne.prestation || "")) {
          sommeAjust += num(ligne.montant);
          nbAjust++;
        } else gardees.push(ligne);
      }
      bloc.lignes = gardees;
      bloc.total = fmt(gardees.reduce((s, l) => s + num(l.montant), 0));
    }
    if (nbAjust > 0) {
      warn.push(
        `${nbAjust} ligne(s) AJUSTEMENT purgée(s) par le post-traitement (somme ${fmt(sommeAjust)})`,
      );
    }
    const calcule = SECTIONS.reduce((s, sec) => s + num(h[sec]?.total), 0);
    h.total_clinique_calcule = fmt(calcule);
    h.total_clinique = h.total_clinique_calcule;
    const facture = num(h.total_clinique_facture);
    if (facture > 0) h.ecart_ajustements = fmt(facture - calcule);

    // D1/E3/E4 — VERROU 2bis : total_clinique_ht corrigé
    const recap = h.recapitulatif_facture;
    if (recap) {
      // E3a — Traçabilité de la valeur d'origine
      if (recap.total_clinique_ht && !recap.total_clinique_ht_source) {
        recap.total_clinique_ht_source = recap.total_clinique_ht;
      }

      // Candidat 1 : somme des montant_ht des lignes_clinique
      let sommeHT = 0;
      let factureDetails = null;
      for (const p of data.pieces_justificatives || []) {
        const fd = p.contenu?.facture_details;
        if (!fd) continue;
        if (fd.lignes_clinique) factureDetails = fd;
        for (const l of fd.lignes_clinique || []) {
          sommeHT += num(l.montant_ht);
        }
      }

      // Candidat 2 : htDeduit = TTC - TVA (si renseignés dans facture_details ou recap)
      const fdTTC = num(factureDetails?.total_clinique_ttc || recap.total_clinique_ttc);
      const fdTVA = num(factureDetails?.total_clinique_tva || recap.total_tva);
      const htDeduit = (fdTTC > 0 && fdTVA >= 0) ? fdTTC - fdTVA : 0;

      // Choisir le meilleur candidat
      const ancienHT = num(recap.total_clinique_ht);
      if (sommeHT > 0 || htDeduit > 0) {
        let retenu = sommeHT;
        if (sommeHT > 0 && htDeduit > 0) {
          // Retenir le plus proche du HT déclaré ou de htDeduit si différent
          retenu = Math.abs(sommeHT - htDeduit) < 1 ? sommeHT :
                   (Math.abs(htDeduit - ancienHT) < Math.abs(sommeHT - ancienHT) ? htDeduit : htDeduit);
          warn.push(
            `total_clinique_ht : somme des lignes ${fmt(sommeHT)}, TTC-TVA ${fmt(htDeduit)}, retenu ${fmt(retenu)}`,
          );
        }
        if (retenu > 0 && Math.abs(ancienHT - retenu) > 1) {
          recap.total_clinique_ht = fmt(retenu);
        }
      }

      // E3b — Propager dans facture_details
      if (factureDetails && recap.total_clinique_ht) {
        factureDetails.total_clinique_ht = recap.total_clinique_ht;
      }

      // E4 — Cohérence HT + TVA ≈ TTC : comparer à total_clinique_facture (inclut ajustements)
      const factureRef = num(h.total_clinique_facture);
      if (factureRef > 0) {
        const ht = num(recap.total_clinique_ht);
        const tva = num(recap.total_tva);
        if (ht > 0 && tva >= 0 && Math.abs(ht + tva - factureRef) > 2) {
          warn.push(
            `Incohérence facture : HT ${fmt(ht)} + TVA ${fmt(tva)} = ${fmt(ht + tva)}, TTC facturé ${fmt(factureRef)} (écart ${fmt(Math.abs(ht + tva - factureRef))})`,
          );
        }
      }
    }
  }

  // ═══ VERROU 2 — Sous-totaux par nature (pharmacie interne) ═════════════════
  for (const { a: h } of hospis) {
    const ph = h.pharmacie_interne;
    if (!ph || !Array.isArray(ph.lignes)) continue;

    // C4a — Dédoublonnage (prestation normalisée + date + montant)
    {
      const seen = new Set();
      const deduped = [];
      const dupNames = [];
      for (const ligne of ph.lignes) {
        const key =
          normCompare(ligne.prestation) +
          "|" + (ligne.date || "") +
          "|" + fmt(num(ligne.montant));
        if (seen.has(key)) {
          dupNames.push(ligne.prestation || "?");
          continue;
        }
        seen.add(key);
        deduped.push(ligne);
      }
      if (dupNames.length > 0) {
        warn.push(
          `${dupNames.length} ligne(s) pharmacie dupliquée(s) supprimée(s) : ${dupNames.join(", ")}`,
        );
      }
      ph.lignes = deduped;
    }

    // C4b — Quantité : absent/null/vide/"0" → "1", sinon convertir en string
    for (const ligne of ph.lignes) {
      const q = ligne.quantite;
      if (q == null || q === "" || String(q) === "0") {
        ligne.quantite = "1";
      } else {
        ligne.quantite = String(q);
      }
    }

    // Classification + sous-totaux
    const tot = {
      MEDICAMENT: 0,
      DISPOSITIF_MEDICAL: 0,
      CONSOMMABLE_UU: 0,
      HOTELIER: 0,
    };
    for (const ligne of ph.lignes) {
      ligne.nature = natureLigne(ligne);
      tot[ligne.nature] = (tot[ligne.nature] || 0) + num(ligne.montant);
    }
    ph.total_medicaments = fmt(tot.MEDICAMENT);
    ph.total_dispositifs = fmt(tot.DISPOSITIF_MEDICAL);
    ph.total_consommables = fmt(tot.CONSOMMABLE_UU);
    ph.total_hotelier = fmt(tot.HOTELIER);

    // Contrôle de somme (lignes vs déclaré)
    const sommeLignes = ph.lignes.reduce((s, l) => s + num(l.montant), 0);
    const totalDeclare = num(ph.total);
    if (totalDeclare > 0 && Math.abs(sommeLignes - totalDeclare) > 0.1) {
      ph.total = fmt(sommeLignes);
      warn.push(
        `pharmacie interne : total déclaré ${fmt(totalDeclare)}, somme des ${ph.lignes.length} lignes = ${fmt(sommeLignes)}, total recalculé`,
      );
    }

    // Contrôle nombre_lignes_annexe
    const nbReel = ph.lignes.length;
    const nbAnnonce = parseInt(ph.nombre_lignes_annexe, 10);
    if (ph.nombre_lignes_annexe && !isNaN(nbAnnonce) && nbAnnonce !== nbReel) {
      warn.push(
        `pharmacie interne : ${nbAnnonce} lignes annoncées, ${nbReel} extraites — lignes manquantes possibles`,
      );
    }
    ph.nombre_lignes_annexe = String(nbReel);

    // C4c — nombre_lignes (après dédoublonnage, distinct de nombre_lignes_annexe)
    ph.nombre_lignes = nbReel;

    // C4d — controle_somme (lignes détail vs groupes facture)
    let totalGroupesFacture = 0;
    for (const p of data.pieces_justificatives || []) {
      for (const l of p.contenu?.facture_details?.lignes_clinique || []) {
        if (normCompare(l.section || "").includes("pharmacie")) {
          totalGroupesFacture += num(l.montant_ttc);
        }
      }
    }
    const ecartFacture = sommeLignes - totalGroupesFacture;
    ph.controle_somme = {
      total_lignes: fmt(sommeLignes),
      total_groupes_facture: fmt(totalGroupesFacture),
      ecart: fmt(ecartFacture),
    };
    if (totalGroupesFacture > 0 && Math.abs(ecartFacture) > 0.1) {
      warn.push(
        `pharmacie interne : total lignes ${fmt(sommeLignes)} vs groupes facture ${fmt(totalGroupesFacture)} (écart ${fmt(ecartFacture)})`,
      );
    }

    // C4e — exclusif_avec si la source est un détail annexe
    if (ph.source_detail === "detail_annexe") {
      ph.exclusif_avec = [
        "facture_details.lignes_clinique (section Pharmacie Interne)",
      ];
    }
  }

  // ═══ VERROU 3 — Propagation du code d'intervention vers le CHIRURGIEN ══════
  for (const { a: h, i: idx } of hospis) {
    let code = "",
      lettre = "",
      cotation = "";
    for (const ligne of h.bloc_operatoire?.lignes || []) {
      const m = String(ligne.prestation || "").match(
        /([A-Z]{2,4}\d{6,})\s*\(\s*([A-Za-z]{1,3})\s*(\d+)\s*\)/,
      );
      if (m) {
        code ||= m[1];
        lettre ||= m[2].toUpperCase();
        cotation ||= m[3];
      }
      if (ligne.code_acte && CODE_INTERVENTION.test(ligne.code_acte)) {
        code ||= ligne.code_acte;
        lettre ||= ligne.lettre_cle || "";
        cotation ||= ligne.cotation || "";
      }
      ligne.rubrique_proposee ||= "SO";
    }
    const ci = h.accord_prealable_details?.code_intervention || "";
    if (!code && CODE_INTERVENTION.test(ci)) code = ci;
    code ||= h.code_acte || "";
    lettre ||= h.lettre_cle || "";
    cotation ||= h.cotation || "";

    if (code) {
      if (
        h.accord_prealable_details &&
        !h.accord_prealable_details.code_intervention
      ) {
        h.accord_prealable_details.code_intervention = code;
      }
      if (!h.code_acte) h.code_acte = code;
    }

    const chirurgiens = actes.filter(
      (a) =>
        a.rattachement_hospitalisation === idx &&
        norm(a.role_intervention).includes("chirurgien"),
    );
    for (const ch of chirurgiens) {
      if (code && !ch.code_acte) ch.code_acte = code;
      if (lettre && !ch.lettre_cle) ch.lettre_cle = lettre;
      if (cotation && !ch.cotation) ch.cotation = String(cotation);
    }
    if (code && chirurgiens.length && !chirurgiens[0].cotation) {
      warn.push(
        `Chirurgien sans cotation malgré le code ${code} — DÉFAUT BLOQUANT`,
      );
    }
    if (code && chirurgiens.length === 0) {
      warn.push(
        `Code d'intervention ${code} présent mais aucun acte 'Chirurgien' promu`,
      );
    }
  }

  // ═══ VERROU 11 — Recomposer le montant d'un acte promu ═════════════════════
  // [F1] sameName rend ce verrou opérant : "Dr Imed Eddine ESSID" ≡ "ESSID Imededdine"
  for (const a of actes) {
    if (a.rattachement_hospitalisation == null) continue;
    if (!Array.isArray(a.details_lignes) || a.details_lignes.length === 0)
      continue;
    for (const ca of compteAutruiLignes) {
      if (!sameName(ca.nom_prestataire, a.praticien)) continue;
      const mCA = num(ca.montant_ttc);
      if (mCA <= 0) continue;
      if (a.details_lignes.some((dl) => Math.abs(num(dl.montant) - mCA) <= 0.1))
        continue;
      a.details_lignes.push({
        designation:
          ca.nature_acte || ca.specialite || "Ligne facture clinique",
        source: "facture_clinique",
        montant: ca.montant_ttc,
      });
      const ancien = a.montant;
      a.montant = fmt(
        a.details_lignes.reduce((s, dl) => s + num(dl.montant), 0),
      );
      warn.push(
        `Montant de ${a.praticien} recomposé : ${ancien} (note) + ${ca.montant_ttc} (facture) = ${a.montant}`,
      );
    }
  }

  // ═══ [F2] Passe unique : observations de doublon note/facture ══════════════
  for (const a of actes) {
    const { doublons } = analyseHonoraires(a, compteAutruiLignes);
    if (doublons.length > 0) {
      addObs(a, "note d'honoraires = ligne facture, compté une seule fois");
    }
  }

  // ═══ VERROU 4 — Chaînage intervention_id + rubrique_proposee ═══════════════
  hospis.forEach(({ a: h, i: idx }, n) => {
    const id = `INT-${n + 1}`;
    h.intervention_id ||= id;
    for (const sec of SECTIONS) {
      for (const ligne of h[sec]?.lignes || []) {
        ligne.intervention_id ||= id;
        ligne.rubrique_proposee ||= rubriqueParSection(sec, ligne.prestation);
      }
    }
    let cout = num(h.total_clinique_calcule);
    for (const a of actes) {
      if (a.rattachement_hospitalisation !== idx) continue;
      a.intervention_id ||= id;
      a.rubrique_proposee ||= rubriqueParType(a) || rubriqueParRole(a.role_intervention);
      cout += num(a.montant);
    }
    h.cout_total_intervention = fmt(cout);
    h.vue_recommandee ||=
      h.forfait === true || h.forfait === "true" ? "groupee" : "detaillee";
  });

  // ═══ VERROU 5 — Anti double comptage sur les totaux ════════════════════════
  const totauxParType = {};
  for (const a of actes) {
    const t = a.type || "";
    totauxParType[t] = (totauxParType[t] || 0) + num(a.montant);
  }
  const sommeType = (t) => totauxParType[t] || 0;

  const totalHospi = hospis.reduce(
    (s, { a: h }) =>
      s +
      num(h.total_clinique_calcule) +
      num(h.recapitulatif_facture?.timbre_fiscal),
    0,
  );

  data.synthese = data.synthese || {};
  const S = data.synthese;
  S.total_medecin = fmt(sommeType("MEDECIN"));
  S.total_radiologie = fmt(sommeType("RADIOLOGIE"));
  S.total_pharmacie = fmt(sommeType("PHARMACIE"));
  S.total_laboratoire = fmt(sommeType("LABORATOIRE"));
  S.total_dentaire = fmt(sommeType("DENTAIRE"));
  S.total_optique = fmt(sommeType("OPTIQUE"));
  S.total_paramedical = fmt(sommeType("PARAMEDICAL"));
  S.total_hospitalisation = fmt(totalHospi); // SANS le compte d'autrui
  S.total_global_calcule = fmt(
    totalHospi +
      [
        "MEDECIN",
        "RADIOLOGIE",
        "PHARMACIE",
        "LABORATOIRE",
        "DENTAIRE",
        "OPTIQUE",
        "PARAMEDICAL",
      ].reduce((s, t) => s + sommeType(t), 0),
  );
  // BONUS — total_nouveau_ne avec lignes hospitalisation
  {
    const totalActesNN = actes
      .filter((a) => a.patient_concerne === "nouveau_ne")
      .reduce((s, a) => s + num(a.montant), 0);
    let totalLignesNN = 0;
    for (const { a: h } of hospis) {
      for (const sec of SECTIONS) {
        for (const ligne of h[sec]?.lignes || []) {
          if (ligne.patient_concerne === "nouveau_ne") {
            totalLignesNN += num(ligne.montant);
          }
        }
      }
    }
    S.total_nouveau_ne = fmt(totalActesNN + totalLignesNN);
    S.detail_nouveau_ne = {
      actes: fmt(totalActesNN),
      lignes_hospitalisation: fmt(totalLignesNN),
      total: fmt(totalActesNN + totalLignesNN),
    };
  }
  S.devise = S.devise || "DT";

  let sommeEcartCA = 0;
  for (const { a: h, i: idx } of hospis) {
    const rattaches = actes.filter(
      (a) => a.rattachement_hospitalisation === idx,
    );
    const promus = rattaches.reduce((s, a) => s + num(a.montant), 0);
    h.total_acte_cote = fmt(promus);
    const imprime = num(h.recapitulatif_facture?.total_compte_autrui);
    if (imprime > 0) {
      const directs = rattaches.reduce(
        (s, a) => s + honorairesHorsFactureActe(a, compteAutruiLignes),
        0,
      );
      const attendu = imprime + directs;
      const ecart = promus - attendu;
      sommeEcartCA += ecart;
      if (Math.abs(ecart) > 0.1) {
        warn.push(
          `Écart compte d'autrui : promus ${fmt(promus)} vs attendu ${fmt(attendu)} ` +
            `(imprimé ${fmt(imprime)} + directs ${fmt(directs)} — écart ${fmt(ecart)})`,
        );
      } else if (directs > 0) {
        addObs(
          h,
          `compte d'autrui cohérent : ${fmt(imprime)} facturés + ${fmt(directs)} réglés en direct`,
        );
      }
    }
  }

  // Constantes spécialité (utilisées par pré-passe visite + VERROU 13)
  const MOTS_SPECIALITE = [
    "anesth", "gyneco", "obstetri", "pediatr", "chirurg", "radiolog",
    "cardiolog", "biolog", "dentis", "ophtalm", "dermat", "uro",
    "orthop", "gastro", "neuro", "pneumo", "endocrin", "reanima",
    "medecin", "generaliste", "interniste", "orl",
  ];

  // ═══ Pré-passe : normalisation rubriques (doit tourner AVANT VERROU 12/15) ══
  for (const a of actes) {
    // Visite → rubrique VS/V
    if (normCompare(a.acte || "").includes("visite")) {
      const specNorm = normCompare(a.specialite || "");
      const isSpec = specNorm && MOTS_SPECIALITE.some(m => specNorm.includes(m));
      const cible = isSpec ? "VS" : "V";
      if (a.lettre_cle && a.lettre_cle !== cible && ["CS", "C", "V", "VS"].includes(a.lettre_cle)) {
        a.lettre_cle = cible;
      }
      if (a.rubrique_proposee && ["CS", "C"].includes(a.rubrique_proposee)) {
        a.rubrique_proposee = cible;
      }
    }
    // Rubrique "AUTRE" → rubrique selon le type (RADIOLOGIE→Z, LABORATOIRE→B, PHARMACIE→PH)
    if (a.rubrique_proposee === "AUTRE" || !a.rubrique_proposee) {
      const rub = rubriqueParType(a);
      if (rub) a.rubrique_proposee = rub;
    }
  }

  // ═══ VERROU 15 — Cohérence accouchement forfait vs césarienne (KC) ═════════
  for (const { a: h, i: idx } of hospis) {
    const motifNorm = normCompare(h.motif || "");
    const voie = normCompare(h.voie_accouchement || "");
    const estAccouchement = motifNorm.includes("accouchement") || voie !== "";
    if (!estAccouchement) continue;

    const estCesarienne = voie.includes("cesarienne") ||
      (motifNorm.includes("cesarienne") && voie !== "voie_basse");

    if (estCesarienne) {
      // Césarienne → KC obligatoire
      if (!h.lettre_cle || h.lettre_cle !== "KC") {
        const ancien = h.lettre_cle || "(vide)";
        h.lettre_cle = "KC";
        warn.push(`Accouchement par césarienne : lettre_cle corrigée ${ancien} → KC`);
      }
      if (h.forfait === true || h.forfait === "true") {
        h.forfait = false;
        warn.push(`Césarienne : forfait corrigé true → false (acte chirurgical, pas forfait)`);
      }
    } else {
      // Voie basse / forfait → PAS de KC
      if (h.lettre_cle === "KC") {
        h.lettre_cle = "";
        h.cotation = "";
        h.code_acte = "";
        warn.push(`Accouchement voie basse : lettre_cle KC retirée (forfait, pas acte chirurgical)`);
      }
      if (h.forfait !== true && h.forfait !== "true") {
        h.forfait = true;
        warn.push(`Accouchement voie basse : forfait corrigé → true`);
      }
      h.vue_recommandee = "groupee";
      // Retirer KC/cotation des chirurgiens rattachés (faux positifs)
      for (const a of actes) {
        if (a.rattachement_hospitalisation !== idx) continue;
        if (a.lettre_cle === "KC") {
          a.lettre_cle = "";
          a.cotation = "";
          addObs(a, "lettre_cle KC retirée : accouchement voie basse (forfait)");
        }
      }
    }
  }

  // ═══ VERROU 12 — Défalcation facture par rubrique ═══════════════════════════
  {
    const rel = data.releve_assureur;
    const hasReleve = rel && Array.isArray(rel.lignes);

    // Relevé assureur indexé par rubrique
    const releveDepByRub = {};
    if (hasReleve) {
      for (const l of rel.lignes) {
        const r = String(l.rubrique || "").toUpperCase();
        if (!releveDepByRub[r]) releveDepByRub[r] = { depenses: 0, remboursement: 0 };
        releveDepByRub[r].depenses += num(l.depenses);
        releveDepByRub[r].remboursement += num(l.remboursement);
      }
    }

    for (const { a: h, i: idx } of hospis) {
      const rattaches = actes.filter((a) => a.rattachement_hospitalisation === idx);
      const estKC = !(h.forfait === true || h.forfait === "true") &&
        (h.code_acte || rattaches.some((a) => a.role_intervention));

      // Collecter TOUTES les lignes de la facture par rubrique
      const rubTotals = {};
      const addRub = (rub, montant, pec) => {
        const r = rub || "AUTRE";
        if (!rubTotals[r]) rubTotals[r] = { depenses: 0, pec_cnam: 0, lignes: [] };
        rubTotals[r].depenses += num(montant);
        rubTotals[r].pec_cnam += num(pec);
      };

      // 1. Séjour → JHC + correction nombre_nuitees depuis quantité chambre
      let nuiteesFact = 0;
      for (const ligne of h.sejour?.lignes || []) {
        addRub(ligne.rubrique_proposee || "JHC", ligne.montant, ligne.montant_pec);
        const prest = normCompare(ligne.prestation || "");
        if (prest.includes("chambre") || prest.includes("nuitee") || prest.includes("lit")) {
          nuiteesFact += num(ligne.quantite);
        }
      }
      if (nuiteesFact > 0 && num(h.nombre_nuitees) !== nuiteesFact) {
        const ancien = h.nombre_nuitees || "(vide)";
        h.nombre_nuitees = String(nuiteesFact);
        warn.push(`nombre_nuitees corrigé : ${ancien} → ${nuiteesFact} (quantité chambre facturée)`);
      }
      // 2. Bloc opératoire → SO
      for (const ligne of h.bloc_operatoire?.lignes || []) {
        addRub(ligne.rubrique_proposee || "SO", ligne.montant, ligne.montant_pec);
      }
      // 3. Pharmacie interne → PH
      for (const ligne of h.pharmacie_interne?.lignes || []) {
        addRub(ligne.rubrique_proposee || "PH", ligne.montant, ligne.montant_pec);
      }
      // 4. Autres frais
      for (const ligne of h.autres_frais?.lignes || []) {
        addRub(ligne.rubrique_proposee || "AUTRE", ligne.montant, ligne.montant_pec);
      }
      // 5. Actes rattachés (compte d'autrui promus)
      const postesKc = [];
      for (const a of rattaches) {
        const rub = a.rubrique_proposee || "AUTRE";
        addRub(rub, a.montant, a.montant_cnam || a.montant_pec);
        if (estKC && RUBRIQUES_KC.includes(rub)) {
          postesKc.push({
            role: a.role_intervention || a.type,
            praticien: a.praticien || "",
            rubrique_proposee: rub,
            montant: a.montant || "",
            montant_pec: a.montant_cnam || a.montant_pec || "",
          });
        }
      }

      // Construire la défalcation complète
      const defalcation = [];
      const allRubs = [...new Set([...Object.keys(rubTotals), ...Object.keys(releveDepByRub)])];
      for (const r of allRubs) {
        const dep = rubTotals[r]?.depenses || 0;
        const pec = rubTotals[r]?.pec_cnam || 0;
        const assRemb = releveDepByRub[r]?.remboursement || 0;
        defalcation.push({
          rubrique: r,
          dans_bloc_kc: RUBRIQUES_KC.includes(r),
          depenses: fmt(dep),
          pec_cnam: fmt(pec),
          remboursement_assureur: hasReleve ? fmt(assRemb) : "",
          reste_a_charge: hasReleve ? fmt(dep - pec - assRemb) : fmt(dep - pec),
        });
      }

      // Totaux par catégorie
      let totalFacture = 0, totalPec = 0, totalAssureur = 0;
      let totalKc = 0, totalPecKc = 0, totalAssureurKc = 0;
      for (const d of defalcation) {
        const dep = num(d.depenses), pec = num(d.pec_cnam), ass = num(d.remboursement_assureur);
        totalFacture += dep; totalPec += pec; totalAssureur += ass;
        if (d.dans_bloc_kc) { totalKc += dep; totalPecKc += pec; totalAssureurKc += ass; }
      }

      // Timbre fiscal
      const timbre = num(h.recapitulatif_facture?.timbre_fiscal);

      // Postes KC : ajouter les lignes bloc_operatoire
      if (estKC) {
        for (const ligne of h.bloc_operatoire?.lignes || []) {
          postesKc.unshift({
            role: "Établissement",
            praticien: h.clinique || "",
            rubrique_proposee: ligne.rubrique_proposee || "SO",
            montant: ligne.montant || "",
            montant_pec: ligne.montant_pec || "",
          });
        }
      }

      // F5 — type_sejour : ambulatoire (0 nuitées) vs hospitalisation
      const nuitees = num(h.nombre_nuitees);
      const typeSejour = nuitees > 0 ? "hospitalisation" : "ambulatoire";

      h.defalcation_facture = {
        type_sejour: typeSejour,
        nombre_nuitees: h.nombre_nuitees || "0",
        defalcation,
        total_facture: fmt(totalFacture + timbre),
        total_pec_cnam: fmt(totalPec),
        total_assureur: hasReleve ? fmt(totalAssureur) : "",
        timbre_fiscal: timbre > 0 ? fmt(timbre) : "",
        ecart_ajustements: h.ecart_ajustements || "",
      };

      // Bloc KC uniquement si acte chirurgical (pas forfait)
      if (estKC) {
        h.bloc_kc = {
          code_acte: h.code_acte || "",
          lettre_cle: h.lettre_cle || "",
          cotation: h.cotation || "",
          postes: postesKc,
          total_kc_brut: fmt(totalKc),
          total_pec_cnam: fmt(totalPecKc),
          total_assureur: hasReleve ? fmt(totalAssureurKc) : "",
          reste_a_charge_bloc: hasReleve
            ? fmt(totalKc - totalPecKc - totalAssureurKc)
            : fmt(totalKc - totalPecKc),
          exclusif_avec: ["actes_independants", "bloc_operatoire"],
        };
      }
    }
  }

  // ═══ VERROU 6 — Cohérence des tickets pharmacie ════════════════════════════
  for (const a of actes) {
    if (a.type !== "PHARMACIE") continue;
    if (!Array.isArray(a.details_lignes)) continue;

    // D4 — Dédoublonnage details_lignes (même médicament + même code_amm + même prix)
    {
      const seen = new Set();
      const deduped = [];
      const dupNames = [];
      for (const dl of a.details_lignes) {
        const key =
          normCompare(dl.medicament || dl.designation || "") +
          "|" + normCompare(dl.code_amm || "") +
          "|" + fmt(num(dl.total_ligne));
        if (seen.has(key)) {
          dupNames.push(dl.medicament || dl.designation || "?");
          continue;
        }
        seen.add(key);
        deduped.push(dl);
      }
      if (dupNames.length > 0) {
        warn.push(
          `Ticket ${a.pharmacie || "?"} : ${dupNames.length} ligne(s) dupliquée(s) supprimée(s) : ${dupNames.join(", ")}`,
        );
        a.details_lignes = deduped;
      }
    }

    const somme = a.details_lignes.reduce((s, l) => s + num(l.total_ligne), 0);
    const total = num(a.montant);

    // D3 — Montant illisible mais lignes exploitables
    if (total === 0 && somme > 0) {
      a.montant_lignes_calcule = fmt(somme);
      warn.push(
        `Ticket ${a.pharmacie || "?"} ${a.date || ""} : montant total illisible, somme des ${a.details_lignes.length} lignes = ${fmt(somme)} — montant non comptabilisé dans les totaux`,
      );
    }

    if (total > 0 && somme > 0 && Math.abs(somme - total) > 0.1) {
      warn.push(
        `Ticket ${a.pharmacie || "?"} ${a.date || ""} : ${a.details_lignes.length} lignes = ` +
          `${fmt(somme)}, total déclaré ${fmt(total)} (écart ${fmt(total - somme)})`,
      );
    }
  }

  // BONUS — nombre_lignes_ticket après dédoublonnage
  for (const a of actes) {
    if (a.type === "PHARMACIE" && Array.isArray(a.details_lignes)) {
      a.nombre_lignes_ticket = String(a.details_lignes.length);
    }
  }

  // ═══ VERROU 14 — Fusion des actes PHARMACIE même officine + même date ══════
  {
    const isIllisible = (a) =>
      num(a.montant) === 0 && String(a.montant || "").toUpperCase().includes("ILLISIBLE");

    const pharmaIndexes = [];
    for (let i = 0; i < actes.length; i++) {
      if (actes[i].type === "PHARMACIE") pharmaIndexes.push(i);
    }
    // Grouper par (pharmacie normalisée, date)
    const groups = new Map();
    for (const i of pharmaIndexes) {
      const a = actes[i];
      let gKey = null;
      for (const [k] of groups) {
        const [kName, kDate] = k.split("|||");
        if (sameName(kName, a.pharmacie || "") && kDate === (a.date || "")) {
          gKey = k;
          break;
        }
      }
      if (!gKey) gKey = (a.pharmacie || "") + "|||" + (a.date || "");
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey).push(i);
    }

    // Fusionner les groupes de taille > 1 (avec conditions de non-fusion E2)
    const indexesToRemove = new Set();
    for (const [, idxs] of groups) {
      if (idxs.length < 2) continue;

      // E2 — Vérifier les conditions de non-fusion pour chaque paire
      const fusionnable = [];
      const nonFusionnable = [];
      for (let k = 1; k < idxs.length; k++) {
        const a = actes[idxs[0]], b = actes[idxs[k]];
        const prescA = a.medecin_prescripteur || "";
        const prescB = b.medecin_prescripteur || "";
        const cnamA = a.code_cnam_pharmacien || "";
        const cnamB = b.code_cnam_pharmacien || "";
        const aIll = isIllisible(a), bIll = isIllisible(b);

        let raison = null;
        if (prescA && prescB && !sameName(prescA, prescB)) {
          raison = `prescripteurs différents (${prescA} / ${prescB})`;
        } else if (cnamA && cnamB && cnamA !== cnamB) {
          raison = `code_cnam_pharmacien différents (${cnamA} / ${cnamB})`;
        } else if ((aIll && !bIll) || (!aIll && bIll)) {
          raison = `un ticket lisible, l'autre illisible — tickets physiquement distincts`;
        }

        if (raison) {
          nonFusionnable.push({ idx: idxs[k], raison });
        } else {
          fusionnable.push(idxs[k]);
        }
      }

      // Avertir les non-fusionnés
      for (const nf of nonFusionnable) {
        warn.push(
          `2 actes PHARMACIE ${actes[idxs[0]].pharmacie || "?"} ${actes[idxs[0]].date || ""} non fusionnés : ${nf.raison} — fusion à confirmer par le gestionnaire`,
        );
      }

      // Fusionner les fusionnables
      if (fusionnable.length === 0) continue;
      const keep = actes[idxs[0]];
      let nbIllisibles = isIllisible(keep) ? 1 : 0;
      let sommeMontantsLisibles = num(keep.montant);

      for (const donorIdx of fusionnable) {
        const donor = actes[donorIdx];
        // Fusionner details_lignes avec dédoublonnage
        if (Array.isArray(donor.details_lignes)) {
          const existingKeys = new Set();
          for (const dl of keep.details_lignes || []) {
            existingKeys.add(
              normCompare(dl.medicament || dl.designation || "") +
              "|" + normCompare(dl.code_amm || "") +
              "|" + fmt(num(dl.total_ligne)),
            );
          }
          keep.details_lignes = keep.details_lignes || [];
          for (const dl of donor.details_lignes) {
            const key =
              normCompare(dl.medicament || dl.designation || "") +
              "|" + normCompare(dl.code_amm || "") +
              "|" + fmt(num(dl.total_ligne));
            if (!existingKeys.has(key)) {
              keep.details_lignes.push(dl);
              existingKeys.add(key);
            }
          }
        }
        // E1 — Montant : additionner les lisibles, signaler les illisibles
        if (isIllisible(donor)) {
          nbIllisibles++;
        } else {
          sommeMontantsLisibles += num(donor.montant);
        }
        // Observations et confiance
        if (donor.observations) addObs(keep, donor.observations);
        if (donor.confiance === "faible" || (donor.confiance === "moyenne" && keep.confiance !== "faible")) {
          keep.confiance = donor.confiance;
        }
        indexesToRemove.add(donorIdx);
      }

      // Résoudre le montant final (E1)
      const tousIllisibles = nbIllisibles > 0 && sommeMontantsLisibles === 0;
      const sommeLignes = (keep.details_lignes || []).reduce((s, l) => s + num(l.total_ligne), 0);
      if (tousIllisibles) {
        keep.montant = "[ILLISIBLE]";
        if (sommeLignes > 0) keep.montant_lignes_calcule = fmt(sommeLignes);
      } else {
        keep.montant = fmt(sommeMontantsLisibles);
        if (nbIllisibles > 0) {
          keep.montant_partiel = true;
          if (sommeLignes > 0) keep.montant_lignes_calcule = fmt(sommeLignes);
          addObs(keep, `montant partiel — ${nbIllisibles} ticket(s) fusionné(s) au total illisible, somme des lignes = ${fmt(sommeLignes)}`);
        }
      }

      // BONUS — nombre_lignes_ticket recalculé après fusion
      if (Array.isArray(keep.details_lignes)) {
        keep.nombre_lignes_ticket = String(keep.details_lignes.length);
      }

      const label = nbIllisibles > 0
        ? `fusion PHARMACIE ${keep.pharmacie || "?"} ${keep.date || ""} : montant retenu ${keep.montant} (dont ${nbIllisibles} ticket(s) au total illisible)`
        : `${fusionnable.length} acte(s) PHARMACIE fusionné(s) : ${keep.pharmacie || "?"} ${keep.date || ""}`;
      warn.push(label);
    }

    if (indexesToRemove.size > 0) {
      // Construire la table de remappage ancien index → nouvel index
      const oldToNew = new Map();
      let newIdx = 0;
      for (let i = 0; i < actes.length; i++) {
        if (indexesToRemove.has(i)) {
          for (const [, idxs] of groups) {
            if (idxs.includes(i)) {
              oldToNew.set(i, oldToNew.get(idxs[0]) ?? idxs[0]);
              break;
            }
          }
        } else {
          oldToNew.set(i, newIdx);
          newIdx++;
        }
      }
      for (const [old, mapped] of oldToNew) {
        if (indexesToRemove.has(old) && oldToNew.has(mapped) && !indexesToRemove.has(mapped)) {
          oldToNew.set(old, oldToNew.get(mapped));
        }
      }

      for (let i = 0; i < actes.length; i++) {
        if (indexesToRemove.has(i)) continue;
        const a = actes[i];
        if (a.rattachement_hospitalisation != null && oldToNew.has(a.rattachement_hospitalisation)) {
          a.rattachement_hospitalisation = oldToNew.get(a.rattachement_hospitalisation);
        }
      }
      for (const p of data.pieces_justificatives || []) {
        if (p.rattachement_acte != null && oldToNew.has(p.rattachement_acte)) {
          p.rattachement_acte = oldToNew.get(p.rattachement_acte);
        }
      }

      const sorted = [...indexesToRemove].sort((a, b) => b - a);
      for (const i of sorted) {
        actes.splice(i, 1);
      }

      const pharmaVillePost = actes
        .filter((a) => a.type === "PHARMACIE")
        .reduce((s, a) => s + num(a.montant), 0);
      data.synthese = data.synthese || {};
      data.synthese.total_pharmacie = fmt(pharmaVillePost);
    }
  }

  // ═══ VERROU 7 — Aucun montant issu du seul relevé assureur ═════════════════
  const rel = data.releve_assureur;
  if (rel && Array.isArray(rel.lignes)) {
    const montantsReleve = new Set();
    for (const l of rel.lignes) {
      if (num(l.depenses)) montantsReleve.add(fmt(num(l.depenses)));
      if (num(l.remboursement)) montantsReleve.add(fmt(num(l.remboursement)));
    }
    const primaires = new Set();
    for (const p of data.pieces_justificatives || []) {
      if (num(p.montant)) primaires.add(fmt(num(p.montant)));
      const nh = p.contenu?.note_honoraires;
      if (nh && num(nh.total)) primaires.add(fmt(num(nh.total)));
      for (const l of p.contenu?.facture_details?.lignes_clinique || []) {
        if (num(l.montant_ttc)) primaires.add(fmt(num(l.montant_ttc)));
      }
      for (const ca of p.contenu?.facture_details?.compte_autrui || []) {
        if (num(ca.montant_ttc)) primaires.add(fmt(num(ca.montant_ttc)));
      }
    }
    for (const a of actes) {
      const m = fmt(num(a.montant));
      if (num(a.montant) > 0 && montantsReleve.has(m) && !primaires.has(m)) {
        const src = (a.details_lignes || []).some((l) => num(l.montant));
        if (!src) {
          warn.push(
            `Acte ${a.praticien || a.pharmacie || a.type} : montant ${m} n'a pour source ` +
              `que le relevé assureur — à vérifier sur pièce primaire`,
          );
          a.confiance = "faible";
          addObs(a, "montant non confirmé par une pièce primaire");
        }
      }
    }
  }

  // ═══ VERROU 9 — Montants manuscrits non recoupés ═══════════════════════════
  {
    const imprimes = new Set();
    for (const p of data.pieces_justificatives || []) {
      for (const l of p.contenu?.facture_details?.lignes_clinique || []) {
        if (num(l.montant_ttc)) imprimes.add(fmt(num(l.montant_ttc)));
      }
      for (const ca of p.contenu?.facture_details?.compte_autrui || []) {
        if (num(ca.montant_ttc)) imprimes.add(fmt(num(ca.montant_ttc)));
      }
    }
    if (rel && Array.isArray(rel.lignes)) {
      for (const l of rel.lignes)
        if (num(l.depenses)) imprimes.add(fmt(num(l.depenses)));
    }

    for (const a of actes) {
      if (!a.role_intervention) continue;
      const hf = honorairesHorsFactureActe(a, compteAutruiLignes);
      if (hf <= 0) continue; // montant attesté par la facture, pas manuscrit
      const m = fmt(num(a.montant));
      if (!imprimes.has(m)) {
        if (a.confiance === "haute" || !a.confiance) a.confiance = "moyenne";
        addObs(a, "montant manuscrit non recoupé — à vérifier");
        warn.push(
          `${a.praticien || a.role_intervention} : montant ${m} manuscrit non recoupé`,
        );
      }
      const bornes = BORNES_ROLE[norm(a.role_intervention)];
      if (bornes) {
        const val = num(a.montant);
        if (val > 0 && (val < bornes[0] || val > bornes[1])) {
          warn.push(
            `montant hors norme pour ${a.role_intervention} : ${m} ` +
              `(usuel ${bornes[0]}–${bornes[1]} DT) — relire le manuscrit`,
          );
          a.confiance = "faible";
        }
      }
    }

    for (const { i: idx } of hospis) {
      const rattaches = actes.filter(
        (a) => a.rattachement_hospitalisation === idx,
      );
      const chir = rattaches.find((a) =>
        norm(a.role_intervention).includes("chirurgien"),
      );
      const aides = rattaches.filter((a) =>
        norm(a.role_intervention).includes("aide op"),
      );
      if (!chir) continue;
      for (const aide of aides) {
        if (num(aide.montant) > num(chir.montant)) {
          warn.push(
            `Incohérence : aide opératoire (${fmt(num(aide.montant))}) > ` +
              `chirurgien (${fmt(num(chir.montant))}) — relire les notes d'honoraires`,
          );
        }
      }
    }
  }

  // ═══ VERROU 8 — Cascade des payeurs ════════════════════════════════════════
  const factureTTC = hospis.reduce(
    (s, { a: h }) =>
      s + num(h.recapitulatif_facture?.total_facture_ttc || h.montant),
    0,
  );
  const horsFacture = actes.reduce(
    (s, a) => s + honorairesHorsFactureActe(a, compteAutruiLignes),
    0,
  );
  const pharmaVille = sommeType("PHARMACIE");
  const pecCnam = hospis.reduce(
    (s, { a: h }) =>
      s + num(h.montant_cnam || h.recapitulatif_facture?.total_pec_organisme),
    0,
  );
  const rembAssureur = num(rel?.net_a_regler || rel?.total_remboursement);
  const depense = factureTTC + horsFacture + pharmaVille;

  data.reglement = {
    ...(data.reglement || {}),
    depense_totale: fmt(depense),
    detail_depense: {
      facture_clinique_ttc: fmt(factureTTC),
      honoraires_hors_facture: fmt(horsFacture),
      pharmacies_ville: fmt(pharmaVille),
      autres_actes: fmt(0),
    },
    pec_cnam: fmt(pecCnam),
    remboursement_assureur: rembAssureur ? fmt(rembAssureur) : "",
    avance_patient: fmt(
      hospis.reduce(
        (s, { a: h }) => s + num(h.recapitulatif_facture?.acompte),
        0,
      ),
    ),
    regle_directement_praticiens: fmt(horsFacture),
    reste_a_charge: fmt(depense - pecCnam - rembAssureur),
    note: "Aucun taux ni plafond appliqué. Le barème dépend du contrat et sera appliqué en aval.",
  };

  // D2 — verification_tresorerie recalculée
  {
    const acompte = hospis.reduce(
      (s, { a: h }) => s + num(h.recapitulatif_facture?.acompte), 0,
    );
    const netAPayer = hospis.reduce(
      (s, { a: h }) => s + num(h.recapitulatif_facture?.net_a_payer), 0,
    );
    const totalDecaisse = acompte + netAPayer + horsFacture + pharmaVille;
    data.reglement.verification_tresorerie =
      `décaissé par l'adhérent ≈ ${fmt(acompte)} (acompte) + ${fmt(netAPayer)} (solde clinique)` +
      ` + ${fmt(horsFacture)} (direct praticiens) + ${fmt(pharmaVille)} (pharmacies) = ${fmt(totalDecaisse)}`;
  }

  // ═══ VERROU 13 — Protection nomenclature + cohérence rôle ═════════════════
  const ABREV_SPECIALITE = {
    GYN: "Gynécologue", GYNECOLOGUE: "Gynécologue", GYNECO: "Gynécologue",
    PED: "Pédiatre", PEDIATRE: "Pédiatre",
    ANES: "Anesthésiste", ANESTH: "Anesthésiste", ANESTHESISTE: "Anesthésiste",
    CHIR: "Chirurgien", CHIRURGIEN: "Chirurgien",
    RAD: "Radiologue", RADIOLOGUE: "Radiologue",
    CARDIO: "Cardiologue", CARDIOLOGUE: "Cardiologue",
    ORL: "ORL",
    DERM: "Dermatologue", DERMATOLOGUE: "Dermatologue",
    GASTRO: "Gastro-entérologue",
    NEURO: "Neurologue", NEUROLOGUE: "Neurologue",
    PNEUMO: "Pneumologue", PNEUMOLOGUE: "Pneumologue",
    URO: "Urologue", UROLOGUE: "Urologue",
    ORTHO: "Orthopédiste", ORTHOPEDISTE: "Orthopédiste",
    OPH: "Ophtalmologue", OPHTALMO: "Ophtalmologue",
  };
  const GESTES_CHIRURGICAUX = [
    "cesarienne", "appendicectomie", "cholecystectomie", "hernie",
    "accouchement", "circoncision", "thyroidectomie", "hysterectomie",
    "mastectomie", "prostatectomie", "arthroplastie",
  ];

  for (const a of actes) {
    // 13a — Détecter la CONTAMINATION : champs d'affichage = désignation nomenclature
    if (a.matched_nomenclature?.designation) {
      const mn = a.matched_nomenclature;
      const desig = mn.designation;
      a.designation_nomenclature = desig;
      const desigNorm = normCompare(desig);

      // Champ acte contaminé par la nomenclature
      if (a.acte && normCompare(a.acte) === desigNorm) {
        const ancien = a.acte;
        const hospi = hospis.find(({ i }) => i === a.rattachement_hospitalisation);
        a.acte = hospi?.a?.motif || "";
        warn.push(
          `désignation nomenclature '${ancien}' retirée du champ acte de ${a.praticien || a.type} — valeur non lue sur pièce`,
        );
      }
      // Champ specialite contaminé par la nomenclature
      if (a.specialite && normCompare(a.specialite) === desigNorm) {
        const ancien = a.specialite;
        a.specialite = "";
        warn.push(
          `désignation nomenclature '${ancien}' retirée du champ specialite de ${a.praticien || a.type} — valeur non lue sur pièce`,
        );
      }
    }

    // 13b — Même contrôle sur details_lignes
    if (Array.isArray(a.details_lignes)) {
      // Collecter toutes les désignations nomenclature de cet acte
      const nomencDesigs = new Set();
      if (a.matched_nomenclature?.designation) {
        nomencDesigs.add(normCompare(a.matched_nomenclature.designation));
      }
      for (const dl of a.details_lignes) {
        if (dl.matched_nomenclature?.designation) {
          const dlDesig = dl.matched_nomenclature.designation;
          nomencDesigs.add(normCompare(dlDesig));
          dl.designation_nomenclature = dlDesig;
        }
      }
      // Si dl.designation est égale à une désignation nomenclature → remplacer
      for (const dl of a.details_lignes) {
        if (dl.designation && nomencDesigs.has(normCompare(dl.designation))) {
          const ancien = dl.designation;
          dl.designation_nomenclature = dl.designation_nomenclature || ancien;
          // Chercher nature_acte dans la ligne compte_autrui du même praticien
          const caLine = compteAutruiLignes.find(
            (c) => sameName(c.nom_prestataire, a.praticien),
          );
          dl.designation = caLine?.nature_acte || "Part facture clinique";
          warn.push(
            `désignation nomenclature '${ancien}' retirée de details_lignes de ${a.praticien || a.type} — remplacée par '${dl.designation}'`,
          );
        }
      }
    }

    // 13c — Cohérence rôle anesthésiste : l'acte doit décrire l'anesthésie
    if (norm(a.role_intervention).includes("anesth")) {
      const acteStr = normCompare(a.acte || "");
      // Guard idempotence : ne pas re-corriger un acte déjà corrigé
      if (!acteStr.startsWith("anesthesie")) {
        const estGesteChir = GESTES_CHIRURGICAUX.some((g) => acteStr.includes(g));
        if (estGesteChir && a.acte) {
          const hospi = hospis.find(({ i }) => i === a.rattachement_hospitalisation);
          const motif = hospi?.a?.motif || a.acte;
          a.acte = `Anesthésie pour ${motif}`;
          addObs(a, "acte corrigé : l'anesthésiste pratique l'anesthésie, pas le geste chirurgical");
        }
      }
    }

    // 13d — Spécialité : priorité cachet > abréviation > mot valide > ""
    if (a.role_intervention) {
      const specNorm = normCompare(a.specialite || "");
      const estSpecValide = specNorm && MOTS_SPECIALITE.some((m) => specNorm.includes(m));

      // Chercher cachet
      let cachet = null;
      for (const p of data.pieces_justificatives || []) {
        const nh = p.contenu?.note_honoraires;
        if (!nh?.specialite_cachet) continue;
        const nhPrat = nh.praticien || p.praticien || "";
        if (sameName(nhPrat, a.praticien)) {
          cachet = nh.specialite_cachet;
          break;
        }
      }

      if (cachet) {
        // Priorité 1 : cachet
        if (a.specialite !== cachet) {
          const ancien = a.specialite;
          a.specialite = cachet;
          if (ancien) {
            warn.push(
              `spécialité '${ancien}' non fiable pour ${a.praticien} — remplacée par '${cachet}' (cachet)`,
            );
          }
        }
      } else if (!estSpecValide && a.specialite) {
        // D6 — Tenter de développer l'abréviation
        const abrevKey = String(a.specialite)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^A-Za-z]/g, "")
          .toUpperCase();
        const developpee = ABREV_SPECIALITE[abrevKey];
        if (developpee) {
          const ancien = a.specialite;
          a.specialite = developpee;
          warn.push(
            `spécialité '${ancien}' développée en '${developpee}'`,
          );
        } else {
          const ancien = a.specialite;
          a.specialite = "";
          warn.push(
            `spécialité '${ancien}' non fiable pour ${a.praticien} — vidée (aucun cachet trouvé)`,
          );
        }
      }
    }
  }

  // ═══ Consolidation ═════════════════════════════════════════════════════════
  data.controles = data.controles || {};
  data.controles.anomalies = [
    ...new Set([...(data.controles.anomalies || []), ...warn]),
  ];
  data.controles.post_traitement_applique = true;
  data.controles.ecart_total_clinique = fmt(
    hospis.reduce((s, { a: h }) => s + num(h.ecart_ajustements), 0),
  );
  data.controles.ecart_compte_autrui = fmt(sommeEcartCA);

  // D2 — ecart_releve_assureur recalculé
  if (rel && Array.isArray(rel.lignes)) {
    const totalDepReleve = rel.lignes.reduce((s, l) => s + num(l.depenses), 0);
    const depenseCalc = num(data.reglement?.depense_totale);
    const diff = totalDepReleve - depenseCalc;
    data.controles.ecart_releve_assureur =
      `total_depenses relevé ${fmt(totalDepReleve)} vs dépenses extraites ${fmt(depenseCalc)} (écart ${fmt(diff)})`;
  } else {
    data.controles.ecart_releve_assureur = "";
  }

  return data;
}
