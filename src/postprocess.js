// src/postprocess.js
// Couche DÉTERMINISTE appliquée après l'OCR — indépendante du modèle et du prompt.
// Un prompt peut dévier ; ce code, non. Il verrouille les défauts bloquants,
// quel que soit le BS, l'assureur ou le contrat.
//
// À appeler dans analyseSingleDossier(), APRÈS enrichActesFromContext()
// et APRÈS enrichWithNomenclature().

const num = (v) => {
  if (v == null || v === "") return 0;
  const s = String(v).replace(/\s/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const norm = (s) => String(s || "").trim().toLowerCase();

const CODE_INTERVENTION = /^[A-Z]{2,4}\d{6,}$/;
const AJUSTEMENT = /^\s*ajustement/i;

const SECTIONS = ["sejour", "bloc_operatoire", "pharmacie_interne", "autres_frais"];

// ── Classification de secours des rubriques (si l'IA ne l'a pas fait) ──────────
function rubriqueParRole(role) {
  const r = norm(role);
  if (r.includes("anesth")) return "FAN";
  if (r.includes("chirurgien") || r.includes("aide") || r.includes("instrument") || r.includes("panseur")) return "K";
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

// ── Classification de secours de la nature d'une ligne de pharmacie ───────────
const MOTS_DISPOSITIF = ["sonde", "catheter", "cathéter", "aiguille", "seringue", "perfuseur",
  "electrode", "électrode", "tubulure", "plaque", "drain", "neofil", "fil ", "suture", "clamp"];
const MOTS_CONSOMMABLE = ["gant", "casaque", "alese", "alèse", "compresse", "champ", "housse",
  "masque", "lancette", "bandelette", "trousse", "kit ", "sparadrap", "fixaderm", "lunette", "manche"];
const MOTS_HOTELIER = ["bracelet", "rasoir", "thermometre", "thermomètre", "brosse", "blouse", "kit patient"];

function natureLigne(ligne) {
  if (ligne.nature) return ligne.nature; // l'IA a déjà tranché
  const l = norm(ligne.prestation);
  if (MOTS_HOTELIER.some((m) => l.includes(m))) return "HOTELIER";
  if (MOTS_CONSOMMABLE.some((m) => l.includes(m))) return "CONSOMMABLE_UU";
  if (MOTS_DISPOSITIF.some((m) => l.includes(m))) return "DISPOSITIF_MEDICAL";
  const tva = num(String(ligne.tva).replace("%", ""));
  return tva === 0 ? "MEDICAMENT" : "CONSOMMABLE_UU";
}

export function postProcess(data) {
  if (!data || !Array.isArray(data.actes_independants)) return data;

  const warn = [];
  const actes = data.actes_independants;
  const hospis = actes
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.type === "HOSPITALISATION");

  // ═══ VERROU 1 — Purger toute ligne AJUSTEMENT survivante ════════════════════
  for (const { a: h } of hospis) {
    let sommeAjust = 0;
    let nbAjust = 0;
    for (const sec of SECTIONS) {
      const bloc = h[sec];
      if (!bloc || !Array.isArray(bloc.lignes)) continue;
      const gardees = [];
      for (const ligne of bloc.lignes) {
        if (AJUSTEMENT.test(ligne.prestation || "")) {
          sommeAjust += num(ligne.montant);
          nbAjust++;
        } else {
          gardees.push(ligne);
        }
      }
      bloc.lignes = gardees;
      bloc.total = fmt(gardees.reduce((s, l) => s + num(l.montant), 0));
    }
    if (nbAjust > 0) {
      warn.push(`${nbAjust} ligne(s) AJUSTEMENT purgée(s) par le post-traitement (somme ${fmt(sommeAjust)})`);
    }

    // Recalcul des totaux cliniques
    const calcule = SECTIONS.reduce((s, sec) => s + num(h[sec]?.total), 0);
    h.total_clinique_calcule = fmt(calcule);
    h.total_clinique = h.total_clinique_calcule; // alias compat front
    const facture = num(h.total_clinique_facture);
    if (facture > 0) {
      h.ecart_ajustements = fmt(facture - calcule);
    }
  }

  // ═══ VERROU 2 — Sous-totaux par nature dans la pharmacie interne ════════════
  for (const { a: h } of hospis) {
    const ph = h.pharmacie_interne;
    if (!ph || !Array.isArray(ph.lignes)) continue;
    const tot = { MEDICAMENT: 0, DISPOSITIF_MEDICAL: 0, CONSOMMABLE_UU: 0, HOTELIER: 0 };
    for (const ligne of ph.lignes) {
      ligne.nature = natureLigne(ligne);
      tot[ligne.nature] = (tot[ligne.nature] || 0) + num(ligne.montant);
    }
    ph.total_medicaments = fmt(tot.MEDICAMENT);
    ph.total_dispositifs = fmt(tot.DISPOSITIF_MEDICAL);
    ph.total_consommables = fmt(tot.CONSOMMABLE_UU);
    ph.total_hotelier = fmt(tot.HOTELIER);
    ph.nombre_lignes_annexe = ph.nombre_lignes_annexe || String(ph.lignes.length);
  }

  // ═══ VERROU 3 — Propagation du code d'intervention vers le CHIRURGIEN ═══════
  for (const { a: h, i: idx } of hospis) {
    // Collecter les codes d'intervention disponibles, par ordre de priorité
    let code = "", lettre = "", cotation = "";

    // (a) ligne "Acte : <CODE> (KC nn)" du bloc opératoire
    for (const ligne of h.bloc_operatoire?.lignes || []) {
      const src = `${ligne.prestation || ""}`;
      const m = src.match(/([A-Z]{2,4}\d{6,})\s*\(\s*([A-Za-z]{1,3})\s*(\d+)\s*\)/);
      if (m) { code ||= m[1]; lettre ||= m[2].toUpperCase(); cotation ||= m[3]; }
      if (ligne.code_acte && CODE_INTERVENTION.test(ligne.code_acte)) {
        code ||= ligne.code_acte;
        lettre ||= ligne.lettre_cle || "";
        cotation ||= ligne.cotation || "";
      }
      // Rubrique de la ligne clinique de l'acte : SO, jamais K
      ligne.rubrique_proposee ||= "SO";
    }
    // (b) décision de prise en charge
    const ci = h.accord_prealable_details?.code_intervention || "";
    if (!code && CODE_INTERVENTION.test(ci)) code = ci;
    // (c) niveau hospitalisation
    code ||= h.code_acte || "";
    lettre ||= h.lettre_cle || "";
    cotation ||= h.cotation || "";

    // Appliquer au chirurgien rattaché
    const chirurgiens = actes.filter(
      (a) => a.rattachement_hospitalisation === idx &&
             norm(a.role_intervention).includes("chirurgien")
    );
    for (const ch of chirurgiens) {
      if (code && !ch.code_acte) ch.code_acte = code;
      if (lettre && !ch.lettre_cle) ch.lettre_cle = lettre;
      if (cotation && !ch.cotation) ch.cotation = String(cotation);
    }
    if (code && chirurgiens.length && !chirurgiens[0].cotation) {
      warn.push(`Chirurgien sans cotation malgré le code ${code} — DÉFAUT BLOQUANT`);
    }
    if (code && chirurgiens.length === 0) {
      warn.push(`Code d'intervention ${code} présent mais aucun acte 'Chirurgien' promu`);
    }
  }

  // ═══ VERROU 4 — Chaînage intervention_id + rubrique_proposee ════════════════
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
      a.rubrique_proposee ||= rubriqueParRole(a.role_intervention);
      cout += num(a.montant);
    }
    h.cout_total_intervention = fmt(cout);
    h.vue_recommandee ||= h.forfait === true || h.forfait === "true" ? "groupee" : "detaillee";
  });

  // ═══ VERROU 5 — Anti double comptage sur les totaux ═════════════════════════
  const sommeType = (t) =>
    actes.filter((a) => a.type === t).reduce((s, a) => s + num(a.montant), 0);

  const totalHospi = hospis.reduce(
    (s, { a: h }) => s + num(h.total_clinique_calcule) + num(h.recapitulatif_facture?.timbre_fiscal),
    0
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
  S.total_hospitalisation = fmt(totalHospi); // ← SANS le compte d'autrui
  S.total_global_calcule = fmt(
    totalHospi +
      ["MEDECIN", "RADIOLOGIE", "PHARMACIE", "LABORATOIRE", "DENTAIRE", "OPTIQUE", "PARAMEDICAL"]
        .reduce((s, t) => s + sommeType(t), 0)
  );
  S.total_nouveau_ne = fmt(
    actes.filter((a) => a.patient_concerne === "nouveau_ne").reduce((s, a) => s + num(a.montant), 0)
  );
  S.devise = S.devise || "DT";

  // Contrôle : actes promus vs compte d'autrui imprimé
  for (const { a: h, i: idx } of hospis) {
    const promus = actes
      .filter((a) => a.rattachement_hospitalisation === idx)
      .reduce((s, a) => s + num(a.montant), 0);
    h.total_acte_cote = fmt(promus);
    const imprime = num(h.recapitulatif_facture?.total_compte_autrui);
    if (imprime > 0 && Math.abs(promus - imprime) > 0.1) {
      warn.push(
        `Écart compte d'autrui : promus ${fmt(promus)} vs imprimé ${fmt(imprime)} ` +
        `(écart ${fmt(promus - imprime)} — vérifier les honoraires réglés en direct / lignes N.P.)`
      );
    }
  }

  // ═══ VERROU 6 — Cohérence des tickets pharmacie ═════════════════════════════
  for (const a of actes) {
    if (a.type !== "PHARMACIE" || !Array.isArray(a.details_lignes)) continue;
    const somme = a.details_lignes.reduce((s, l) => s + num(l.total_ligne), 0);
    const total = num(a.montant);
    if (total > 0 && somme > 0 && Math.abs(somme - total) > 0.1) {
      warn.push(
        `Ticket ${a.pharmacie || "?"} ${a.date || ""} : ${a.details_lignes.length} lignes = ` +
        `${fmt(somme)}, total déclaré ${fmt(total)} (écart ${fmt(total - somme)})`
      );
    }
  }

  // ═══ VERROU 7 — Aucun montant ne peut venir du seul relevé assureur ═════════
  const rel = data.releve_assureur;
  if (rel && Array.isArray(rel.lignes)) {
    const montantsReleve = new Set();
    for (const l of rel.lignes) {
      if (num(l.depenses)) montantsReleve.add(fmt(num(l.depenses)));
      if (num(l.remboursement)) montantsReleve.add(fmt(num(l.remboursement)));
    }
    // Montants attestés par une pièce primaire
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
            `que le relevé assureur — à vérifier sur pièce primaire`
          );
          a.confiance = "faible";
          a.observations = [a.observations, "montant non confirmé par une pièce primaire"]
            .filter(Boolean).join(" | ");
        }
      }
    }
  }

  // ═══ VERROU 8 — Cascade des payeurs ════════════════════════════════════════
  const factureTTC = hospis.reduce(
    (s, { a: h }) => s + num(h.recapitulatif_facture?.total_facture_ttc || h.montant), 0);
  const horsFacture = actes
    .filter((a) => a.non_percu === true || a.non_percu === "true")
    .reduce((s, a) => s + num(a.montant), 0);
  const pharmaVille = sommeType("PHARMACIE");
  const pecCnam = hospis.reduce(
    (s, { a: h }) => s + num(h.montant_cnam || h.recapitulatif_facture?.total_pec_organisme), 0);
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
    avance_patient: fmt(hospis.reduce((s, { a: h }) => s + num(h.recapitulatif_facture?.acompte), 0)),
    regle_directement_praticiens: fmt(horsFacture),
    reste_a_charge: fmt(depense - pecCnam - rembAssureur),
    note: "Aucun taux ni plafond appliqué. Le barème dépend du contrat et sera appliqué en aval.",
  };

  // ═══ Consolidation des avertissements ══════════════════════════════════════
  data.controles = data.controles || {};
  data.controles.anomalies = [...(data.controles.anomalies || []), ...warn];
  data.controles.post_traitement_applique = true;

  return data;
}
