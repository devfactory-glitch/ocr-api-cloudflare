// test/postprocess.test.mjs
// Tests unitaires de la couche déterministe postProcess (v4.1)
// Lancer avec : node test/postprocess.test.mjs

import { postProcess } from "../src/postprocess.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Fixture : hospitalisation pour césarienne ───────────────────────────────
function makeFixture() {
  return {
    actes_independants: [
      {
        type: "HOSPITALISATION",
        clinique: "Clinique Test",
        date_entree: "10/04/2026",
        date_sortie: "11/04/2026",
        motif: "Accouchement par Césarienne",
        voie_accouchement: "cesarienne",
        patient_concerne: "adherent",
        forfait: false,
        sejour: {
          lignes: [
            { prestation: "Chambre simple", montant: "206.510", tva: "7%" },
            { prestation: "AJUSTEMENT SEJOUR", montant: "-12.000", tva: "7%" },
          ],
          total: "194.510",
        },
        bloc_operatoire: {
          lignes: [
            { prestation: "Acte : MJC030040 (KC 100)", montant: "631.300", tva: "7%",
              code_acte: "MJC030040", lettre_cle: "KC", cotation: "100" },
            { prestation: "Oxygène / 15 mn", montant: "9.630", tva: "7%" },
            { prestation: "AJUSTEMENT APPAREILLAGES", montant: "5.000", tva: "7%" },
          ],
          total: "645.930",
        },
        pharmacie_interne: {
          lignes: [
            { prestation: "BUPIVACAINE RACHIS 5mg/ml", montant: "4.567", tva: "0%" },
            { prestation: "CASAQUE RENFORCEE", montant: "43.354", tva: "19%" },
            { prestation: "AJUSTEMENT PHARMACIE", montant: "-3.000", tva: "0%" },
          ],
          total: "44.921",
        },
        autres_frais: {
          lignes: [
            { prestation: "Frais de Dossier Interne", montant: "32.100", tva: "7%" },
          ],
          total: "32.100",
        },
        total_clinique_calcule: "917.461",
        total_clinique_facture: "927.461",
        total_clinique: "917.461",
        recapitulatif_facture: {
          total_compte_autrui: "752.900",
          total_facture_ttc: "1681.361",
          timbre_fiscal: "1.000",
          acompte: "500.000",
        },
        montant: "1681.361",
        lettre_cle: "KC",
        cotation: "100",
        code_acte: "MJC030040",
        accord_prealable: true,
        accord_prealable_details: { code_intervention: "MJC030040" },
      },
      // Chirurgien promu — cotation VIDE (doit être propagée)
      {
        type: "MEDECIN",
        praticien: "Dr ESSID",
        role_intervention: "Chirurgien",
        rattachement_hospitalisation: 0,
        lettre_cle: "",
        cotation: "",
        code_acte: "",
        montant: "1000.000",
      },
      // Anesthésiste promu
      {
        type: "MEDECIN",
        praticien: "Dr BABA",
        role_intervention: "Anesthésiste",
        rattachement_hospitalisation: 0,
        lettre_cle: "K",
        cotation: "",
        montant: "321.000",
      },
      // Pédiatre promu
      {
        type: "MEDECIN",
        praticien: "Dr KAZDAGHLI",
        role_intervention: "Pédiatre",
        patient_concerne: "nouveau_ne",
        rattachement_hospitalisation: 0,
        montant: "181.900",
      },
      // Pharmacie ville avec écart details_lignes
      {
        type: "PHARMACIE",
        pharmacie: "Pharmacie TEST",
        date: "12/04/2026",
        montant: "152.788",
        details_lignes: [
          { medicament: "DEBRICOL 200mg", total_ligne: "7.105" },
          { medicament: "DOLIPRANE 1g", total_ligne: "4.245" },
        ],
      },
    ],
    synthese: {},
    controles: { anomalies: [] },
  };
}

// ── Test 1 — Lignes AJUSTEMENT purgées ──────────────────────────────────────
console.log("\n1. Purge des lignes AJUSTEMENT");
{
  const data = postProcess(makeFixture());
  const h = data.actes_independants[0];
  const allLignes = ["sejour", "bloc_operatoire", "pharmacie_interne", "autres_frais"]
    .flatMap((sec) => (h[sec]?.lignes || []).map((l) => l.prestation));
  const hasAjust = allLignes.some((p) => /ajustement/i.test(p));
  assert(!hasAjust, "Aucune ligne AJUSTEMENT ne survit dans les sections");
  assert(h.sejour.lignes.length === 1, "sejour : 1 ligne restante (Chambre simple)");
  assert(h.bloc_operatoire.lignes.length === 2, "bloc_operatoire : 2 lignes restantes");
  assert(h.pharmacie_interne.lignes.length === 2, "pharmacie_interne : 2 lignes restantes");
}

// ── Test 2 — Propagation code/lettre/cotation au chirurgien ─────────────────
console.log("\n2. Propagation code intervention → chirurgien");
{
  const data = postProcess(makeFixture());
  const chir = data.actes_independants[1];
  assert(chir.code_acte === "MJC030040", `code_acte = ${chir.code_acte}`);
  assert(chir.lettre_cle === "KC", `lettre_cle = ${chir.lettre_cle}`);
  assert(chir.cotation === "100", `cotation = ${chir.cotation}`);
}

// ── Test 3 — total_hospitalisation SANS le compte d'autrui ──────────────────
console.log("\n3. total_hospitalisation sans double comptage");
{
  const data = postProcess(makeFixture());
  const totalHospi = parseFloat(data.synthese.total_hospitalisation);
  const h = data.actes_independants[0];
  const expected = parseFloat(h.total_clinique_calcule) + 1.0; // + timbre_fiscal
  assert(
    Math.abs(totalHospi - expected) < 0.01,
    `total_hospitalisation (${totalHospi}) = total_clinique_calcule + timbre (${expected})`
  );
  // Vérifier qu'il ne contient PAS le compte d'autrui
  assert(totalHospi < 1000, `total_hospitalisation (${totalHospi}) < 1000 (pas de compte d'autrui)`);
}

// ── Test 4 — rubrique_proposee ──────────────────────────────────────────────
console.log("\n4. rubrique_proposee assignée");
{
  const data = postProcess(makeFixture());
  const h = data.actes_independants[0];
  const acteBloc = h.bloc_operatoire.lignes.find((l) => l.prestation.includes("Acte :"));
  assert(acteBloc?.rubrique_proposee === "SO", `Ligne bloc Acte → rubrique ${acteBloc?.rubrique_proposee}`);

  const chir = data.actes_independants[1];
  assert(chir.rubrique_proposee === "K", `Chirurgien → rubrique ${chir.rubrique_proposee}`);

  const anesth = data.actes_independants[2];
  assert(anesth.rubrique_proposee === "FAN", `Anesthésiste → rubrique ${anesth.rubrique_proposee}`);
}

// ── Test 5 — Écart pharmacie → anomalies ────────────────────────────────────
console.log("\n5. Écart pharmacie details_lignes vs montant");
{
  const data = postProcess(makeFixture());
  const anomalies = data.controles.anomalies || [];
  const pharmaWarn = anomalies.find((w) => w.includes("Pharmacie TEST") && w.includes("152.788"));
  assert(!!pharmaWarn, `Anomalie pharmacie détectée : ${pharmaWarn ? "oui" : "non"}`);
}

// ── Test 6 — controles.post_traitement_applique ─────────────────────────────
console.log("\n6. Flag post_traitement_applique");
{
  const data = postProcess(makeFixture());
  assert(data.controles.post_traitement_applique === true, "post_traitement_applique = true");
}

// ── Résumé ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`Résultat : ${passed} passés, ${failed} échoués sur ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
