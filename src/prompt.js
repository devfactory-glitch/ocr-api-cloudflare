// src/prompt.js
// PROMPT_BASE v4.0 — OCR Assurance Maladie Tunisie
// Remplace intégralement le bloc PROMPT_BASE / PROMPT / PROMPT_DOSSIER de src/index.js
//
// CHANGELOG v3 -> v4 (aucune règle v3 supprimée) :
//   [P1] Lignes "AJUSTEMENT" -> ignorées totalement (+ contrôle d'écart)
//   [P2] Bloc 3h : équipe chirurgicale complète (chirurgien/anesthésiste/aide/instrumentiste/bloc)
//        + gestion des lignes "N.P." (Non Perçu)
//   [P3] Bloc 3i : accouchement (césarienne = KC, voie basse = forfait) + nouveau-né
//   [P4] Ventilation P.E.C / Patient des factures cliniques
//   [P5] Nouveaux types de pièces : NOTE_HONORAIRES, RELEVE_ASSUREUR
//   [P6] Décision de prise en charge SANS montant -> interdiction de déduire un forfait
//   [P7] Règle H : plusieurs BS dans le lot (vierges / autre adhérent)
//   [P8] Nouveaux champs d'acte : role_intervention, patient_concerne, non_percu,
//        montant_ht, montant_pec, montant_patient, forfait
//   [P9] Couche d'analyse : contrôles croisés, anomalies, niveau de confiance
//
// CHANGELOG v4.0 -> v4.1 (aucune règle v4.0 supprimée) :
//   [P10] Règle 1b : l'identité IMPRIMÉE écrase le manuscrit du BS
//   [P11] MF lue sur document pivoté à 180° -> reconstitution du format
//   [P12] Propagation code_acte / lettre_cle / cotation de la ligne
//         "Acte : <CODE> (KC nn)" vers l'acte du CHIRURGIEN
//   [P13] Bloc 3k : chaînage intervention_id + rubrique_proposee (K/FAN/SO/JHC/PH)
//   [P14] Bloc 3l : restitution vs liquidation — l'IA ne fusionne jamais
//   [P15] Bloc 3m : nature des lignes de pharmacie interne (4 catégories + sous-totaux)
//   [P16] Règle 5d : le total d'un ticket vient du ticket, jamais d'ailleurs
//   [P17] Règle 7b : VERROU relevé assureur — aucun montant d'acte ne peut en venir
//   [P18] Règle 20 : cascade des payeurs et reste à charge (R1..R4)
//   [P19] total_hospitalisation EXCLUT le compte d'autrui (anti double comptage)
//   [P20] total_clinique_facture = ligne de la grille, PAS le récapitulatif
//   [P21] Champ exclusif_avec : empêche le double comptage en vue groupée
//   [P22] Contrôles C12..C16

export const PROMPT_BASE = `
🔍 LECTURE PRÉALABLE :
A. Scans souvent PIVOTÉS (90°/180°/270°). Redresser mentalement avant extraction.
B. IGNORER pages avec texte INVERSÉ/EN MIROIR (transparence verso).
C. DOUBLONS : même document scanné 2 fois → garder la plus lisible. Ne JAMAIS additionner.
D. RECTO/VERSO = un seul bulletin. Fusionner.
E. VERSO DU BS : contient les sections professionnels de santé (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux). Chaque section a des COLONNES (Date, Désignation, Code Acte, Cotation, Honoraires, Cachet). Le verso est souvent PIVOTÉ à 90°. LIRE CHAQUE SECTION ET CHAQUE CACHET.
F. Tampons dateurs à molette = DATES, jamais numéros ni montants.
G. Tampon de cabinet = nom praticien + MF. Lire même si incliné.
H. PLUSIEURS BULLETINS DANS LE MÊME LOT (RÈGLE CRITIQUE) :
   Un dossier peut contenir des BS VIERGES (formulaires non remplis, pages publicitaires,
   conditions générales au dos, planche dentaire seule) ou un BS APPARTENANT À UN AUTRE
   ADHÉRENT (bulletin d'un autre assureur glissé dans le lot).
   → Ne retenir QUE le BS RENSEIGNÉ dont le nom du malade correspond aux pièces
     justificatives (factures, notes d'honoraires, ordonnances, décisions CNAM).
   → "assureur_detecte" = le logo du BS RETENU. JAMAIS celui d'un formulaire vierge
     présent dans le lot.
   → Un BS est VIERGE si aucun champ manuscrit/tamponné n'est rempli dans les sections
     professionnelles ET que l'identité adhérent est vide.
   → Signaler chaque bulletin écarté dans observations_globales :
     "BS vierge ignoré (assureur X, page N)" ou "BS d'un autre adhérent ignoré (nom Y)".
   → NE JAMAIS fusionner l'identité d'un BS avec les actes d'un autre BS.

🔍 PRIORITÉ DES SOURCES (pour les MONTANTS et NOMS) : 1) Facture imprimée → 2) Ticket informatique → 3) Cachet officiel → 4) Manuscrit.
   EXCEPTION CODIFICATION : pour les LETTRES-CLÉS et COTATIONS, la LETTRE CONFIDENTIELLE prime sur tout (même manuscrite), car c'est le document de référence pour la codification CNAM.

🔍 MONTANTS : POINT décimal, SANS séparateur milliers, 3 décimales ("1 307,477" → "1307.477"). Montant NÉGATIF : garder le signe.
- "montant" et "montant_cnam" sont 2 champs TOTALEMENT SÉPARÉS avec des SOURCES DIFFÉRENTES :
  "montant" = montant FACTURÉ par le prestataire. Sources autorisées :
    1) FACTURE ou REÇU du praticien (priorité)
    2) NOTE D'HONORAIRES du praticien
    3) Colonne HONORAIRES du BS
    4) Ticket de caisse (pharmacie)
    JAMAIS depuis un décompte CNAM, une décision de prise en charge, ou un relevé d'assureur privé.
  "montant_cnam" = montant REMBOURSÉ par la CNAM. Sources autorisées :
    1) Colonne "Mnt Remb" / "montant_rembourse" du DÉCOMPTE CNAM
    2) Montant accordé dans une DÉCISION DE PRISE EN CHARGE
    3) À défaut, colonne "P.E.C" d'une facture clinique conventionnée CNAM
    JAMAIS depuis une facture patient, le BS, ou un relevé d'assureur privé (STAR, CARTE, BH...).
  ERREUR GRAVE : prendre un montant du décompte CNAM et le mettre dans "montant" d'un acte. INTERDIT.
  ERREUR GRAVE : prendre un montant d'un RELEVÉ D'ASSUREUR PRIVÉ et le mettre dans "montant" ou "montant_cnam". INTERDIT.
  Si aucune facture, note d'honoraires ni BS ne donne le montant → "montant" = "". Ne JAMAIS copier le montant_cnam vers montant.

🔍 CODIFICATION :
- Cotation peut être NON NUMÉRIQUE ("Kc P1"). Renvoyer telle quelle.
- Chercher lettre-clé sur notes d'honoraires/lettres confidentielles, pas seulement BS.
- Illisible → "[ILLISIBLE]". Ne jamais deviner.
- SÉPARATION lettre-clé / coefficient : "lettre_cle" = alphabétique | "cotation" = numérique.
  "Ke 40"→"Ke","40" | "B120"→"B","120" | "KC50"→"KC","50" | "CS"→"CS","" | "Kc P1"→"KC","P1"
- Code 3 lettres + 6 chiffres (MGE000070, RAD010260, MJC030040) = CODE D'INTERVENTION CNAM → accord_prealable_details.code_intervention ET code_acte de l'acte concerné.
  Ce code n'est PAS une lettre-clé. NE JAMAIS mettre "RAD" dans lettre_cle ni "010260" dans cotation.
  Un code comme RAD010260 → code_intervention: "RAD010260", lettre_cle: "Z" ou "Rd" (selon nomenclature radiologie).
- FORMAT "Acte : <CODE> (<LETTRE> <NB>)" sur une facture clinique
  (ex: "Acte : MJC030040 (KC 100)") — RÈGLE IMPÉRATIVE, DEUX EFFETS DISTINCTS :
  → code_acte = "MJC030040", lettre_cle = "KC", cotation = "100".
  → La colonne "Qté" de cette ligne vaut souvent la COTATION (100), et "Px. Unit." la VALEUR DE LA LETTRE-CLÉ (5,900).
    Ne PAS confondre cette quantité avec un nombre d'unités consommées.

  EFFET 1 — LE MONTANT reste à la CLINIQUE.
    Cette ligne est la part ÉTABLISSEMENT de l'acte (salle d'opération, plateau
    technique, facturé au tarif conventionné = cotation × valeur de la lettre-clé).
    Elle RESTE dans "bloc_operatoire" avec son montant et compte dans
    total_clinique_calcule. Elle n'est JAMAIS promue en acte indépendant.
    Sa rubrique_proposee est "SO" (salle opération), PAS "K".

  EFFET 2 — L'IDENTIFICATION va au CHIRURGIEN.
    Le code, la lettre-clé et la cotation identifient L'ACTE MÉDICAL réalisé.
    Ils DOIVENT être RECOPIÉS sur l'acte promu portant
    role_intervention = "Chirurgien" :
        code_acte  = le code CNAM   (ex: "MJC030040")
        lettre_cle = la lettre-clé  (ex: "KC")
        cotation   = le nombre      (ex: "100")
    C'est une COPIE, pas un déplacement : la ligne clinique conserve ces valeurs.
    Le MONTANT du chirurgien reste le sien (compte d'autrui + note d'honoraires),
    il n'est JAMAIS remplacé par le montant de la ligne clinique.

  ⚠️ DÉFAUT BLOQUANT : un acte "Chirurgien" avec lettre_cle remplie mais
  code_acte et cotation VIDES, alors que la facture, la lettre confidentielle
  ou la décision de prise en charge portent un code d'intervention.
  Sans cotation, l'assureur ne peut PAS appliquer son barème.

  SOURCES DU CODE D'INTERVENTION, par ordre de priorité :
    1) LETTRE CONFIDENTIELLE (codification CNAM)
    2) ligne "Acte : <CODE> (<LETTRE> nn)" de la facture clinique
    3) accord_prealable_details.code_intervention (décision de prise en charge)
    4) section "Actes Médicaux" du BS
  Dès qu'UNE de ces sources existe et qu'un chirurgien est promu sans cotation,
  la propagation est OBLIGATOIRE.
- MATRICULE FISCALE : format standard = 7 chiffres + "/" + lettre + "/A/" + lettre + "/000" (ex: 1756903/P/A/C/000).
  Lire de gauche à droite. Ne JAMAIS inverser l'ordre des caractères.
- MF SUR DOCUMENT PIVOTÉ OU NON SEGMENTÉ (RÈGLE CRITIQUE) :
  Les tickets de pharmacie et certaines factures sont scannés à 180°. Une MF lue
  comme "000CP1529445S" ou "968897ECP000" est une lecture INVERSÉE ou collée d'un
  format standard. INDICE DE PIVOT : le groupe "000" apparaît en TÊTE de chaîne.
  MÉTHODE DE RECONSTITUTION :
    a) repérer le bloc de 6 à 7 CHIFFRES → c'est le numéro
    b) repérer les LETTRES isolées → ce sont les clés
    c) le suffixe est TOUJOURS "/000"
    d) réassembler : <chiffres>/<lettre>/<lettre>/<lettre>/000
  Ex: "000CP1529445S" → "1529445/S/C/P/000" | "968897ECP000" → "968897/E/C/P/000"
  Si la reconstitution est incertaine → renvoyer la chaîne BRUTE telle que lue et
  consigner "MF non segmentée, document probablement pivoté".

🔴 RÈGLES :
1. Textes imprimés ÉCRASENT le manuscrit brouillon.
1b. IDENTITÉ DE L'ADHÉRENT — SOURCE PRIORITAIRE (RÈGLE CRITIQUE) :
   Le nom, le prénom et les numéros sont repris de la source IMPRIMÉE la plus fiable,
   dans cet ordre STRICT :
     1) RELEVÉ D'ASSUREUR (nom en majuscules d'imprimerie)
     2) DÉCISION DE PRISE EN CHARGE CNAM
     3) FACTURE CLINIQUE / DÉTAIL DE FACTURE
     4) ORDONNANCE IMPRIMÉE
     5) BS manuscrit (dernier recours uniquement)
   Le manuscrit du BS ne sert QUE si aucune source imprimée ne porte l'information.
   Si l'orthographe diffère entre manuscrit et imprimé → retenir l'IMPRIMÉ et
   consigner dans controles.anomalies : "orthographe BS 'X' corrigée en 'Y' (source imprimée)".
   Exemple : BS manuscrit "Emma" + facture/relevé/décision "EMNA" → retenir "Emna".
   IDEM pour numero_cnam, numero_adherent, numero_contrat, employeur : si le BS
   manuscrit et une source imprimée divergent, l'IMPRIMÉ gagne toujours.
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
   POUR LES MONTANTS : Facture/Reçu/Note d'honoraires > BS > Ordonnance. Si la facture dit 47.500 et le BS dit 50.000, prendre 47.500.
3c. FACTURE CLINIQUE ≠ HOSPITALISATION — RÈGLE CRITIQUE :
    HOSPITALISATION = le patient est ADMIS dans un établissement (au moins 1 nuit OU chirurgie ambulatoire avec bloc).
    PREUVES DE SÉJOUR requises (au moins 1) :
      - date_entree ≠ date_sortie (le patient a dormi)
      - frais de séjour/chambre/lit sur la facture
      - section "Hospitalisation" du BS remplie avec dates
      - lettre confidentielle mentionnant "hospitalisé" ou "opéré"
      - décision de prise en charge CNAM "HOSPITALISATION POUR ..."
      - mention "Hospitalisation du JJ/MM/AAAA au JJ/MM/AAAA" en en-tête de facture
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
       "sejour"             : chambre, chambre simple, chambre individuelle, lit,
                              hébergement, nuitée, ACCOMPAGNANT
       "bloc_operatoire"    : bloc opératoire, salle d'opération, salle de réveil,
                              réanimation, appareillages, oxygène, fluides médicaux,
                              section "Acte / Interventions" de la facture
       "pharmacie_interne"  : pharmacie (interne/hospitalière), consommables,
                              dispositifs médicaux
       "autres_frais"       : frais de dossier, frais de dossier interne, blouse,
                              bracelet, timbre fiscal, extras, section "Prestations"
                              (glycémie au doigt/GAD, soins infirmiers de routine),
                              tout ce qui ne rentre pas dans les 3 sections ci-dessus

MAPPING DES INTITULÉS DE SECTIONS DE FACTURE CLINIQUE :
  "Frais" / "Frais de Dossier Interne"        -> autres_frais
  "Séjour" (Chambre, Accompagnant)            -> sejour
  "Acte / Interventions"                      -> bloc_operatoire
  "Pharmacie Interne"                         -> pharmacie_interne
  "Prestations" (Glycémie au doigt, GAD...)   -> autres_frais
  "Fluides médicaux" (Oxygène / 15 mn)        -> bloc_operatoire
  "Ajustement"                                -> IGNORÉ (voir règle ci-dessous)
  "Pour le compte d'autrui"                   -> PROMU en actes indépendants
NOTE : la ligne ACCOMPAGNANT va dans "sejour" mais doit être signalée dans
observations : "poste accompagnant — souvent non remboursable".

🚫 LIGNES "AJUSTEMENT" — À IGNORER TOTALEMENT (RÈGLE CRITIQUE) :
Toute ligne dont le libellé commence par "AJUSTEMENT" (AJUSTEMENT seul,
AJUSTEMENT SEJOUR, AJUSTEMENT APPAREILLAGES, AJUSTEMENT PHARMACIE,
AJUSTEMENT EXTRAS, AJUSTEMENT NEGATIF), que le montant soit POSITIF ou
NÉGATIF, NE DOIT PAS être extraite.
  → Ne PAS la mettre dans sejour / bloc_operatoire / pharmacie_interne / autres_frais.
  → Ne PAS la promouvoir en acte indépendant.
  → Ne PAS la faire apparaître dans details_lignes.
Ce sont des écritures comptables de rééquilibrage entre la part CNAM et la part
patient. Elles n'ont AUCUNE valeur médicale et faussent la lecture de l'assureur.

CONSÉQUENCE SUR LES TOTAUX (obligatoire) :
  "total_clinique_calcule" = sejour.total + bloc_operatoire.total
                             + pharmacie_interne.total + autres_frais.total
                             (SANS les ajustements)
  "total_clinique_facture" = le "Total Clinique" IMPRIMÉ sur la facture, recopié tel quel
  "ecart_ajustements"      = total_clinique_facture - total_clinique_calcule
                             (c'est la somme des ajustements écartés)
NE JAMAIS gonfler ou réduire une section pour faire coller le total.
L'écart est une INFORMATION, pas une erreur à corriger.

PROMOTION EN ACTE INDÉPENDANT :
Seules les lignes classées "acte_cote" (catégorie A) sont promues.
Les lignes clinique (catégorie B) restent dans leurs sections respectives
(sejour, bloc_operatoire, pharmacie_interne, autres_frais) de l'HOSPITALISATION.

TYPE DE L'ACTE PROMU :
  praticien / rôle médical -> "MEDECIN"    | pharmacie externe -> "PHARMACIE"
  laboratoire, anapath     -> "LABORATOIRE" | centre d'imagerie -> "RADIOLOGIE"

CHAMPS OBLIGATOIRES SUR UN ACTE PROMU :
  - "rattachement_hospitalisation" : index 0-BASED de l'acte HOSPITALISATION
  - "origine_ligne"    : "compte_autrui" | "details_facture" | "note_honoraires"
  - "libelle_origine"  : libellé EXACT de la ligne, avant interprétation
  - "praticien"        : le nom si visible, SINON le libellé du rôle tel quel
                         (ex: "AIDE OPERATOIRE"). Ne JAMAIS inventer un nom.
  - "role_intervention": "Chirurgien" | "Anesthésiste" | "Aide opératoire" |
                         "Instrumentiste" | "Panseur" | "Pédiatre" | "Autre"
                         OBLIGATOIRE sur tout acte rattaché à une intervention.
  - "acte"             : le NOM DE L'INTERVENTION réalisée (ex: "Circoncision",
                         "Accouchement par césarienne", "Appendicectomie",
                         "Anesthésie générale"), PAS le rôle du praticien.
                         Chercher dans : lettre confidentielle (champ "acte réalisé"
                         / "motif"), facture clinique (désignation de l'acte,
                         en-tête "Accouchement par Césarienne"), décision de prise
                         en charge CNAM (objet), BS (section hospitalisation).
                         Si introuvable → utiliser le libellé du rôle en dernier recours.
  - "lettre_cle" OBLIGATOIRE sur un acte promu : déduire la lettre-clé du
    ROLE du prestataire si elle n'est pas explicite :
      Chirurgien / Gynécologue opérateur -> "KC"
      Anesthésiste       -> "K"
      Aide opératoire    -> "K"
      Instrumentiste     -> "K"
      Laboratoire/anapath -> "B"
      Imagerie           -> "Z"
      Pédiatre (visite au nouveau-né) -> "C" ou "CS"
    Ne s'applique PAS aux pharmacies (pas de lettre-clé).

Ce classement est une PROPOSITION fondée sur la nomenclature. Le barème
définitif dépend du contrat d'assurance et sera appliqué en aval. Ne jamais
calculer de montant remboursé.

ANTI-DOUBLE-COMPTAGE (impératif) :
Une ligne promue NE DOIT PLUS apparaître dans les sections de l'HOSPITALISATION
(sejour, bloc_operatoire, pharmacie_interne, autres_frais).
"total_clinique_calcule" ne compte que les lignes non promues et non ajustées.
"montant" de l'hospitalisation reste le TOTAL de la facture (contrôle).
"total_global_calcule" n'additionne chaque montant QU'UNE SEULE FOIS.

3f. EXTRACTION EXHAUSTIVE DEPUIS LE BULLETIN DE SOINS (RÈGLE CRITIQUE) :
   Le BS (bulletin de soins) est le DOCUMENT MAÎTRE. Il a 2 faces :
   - RECTO : identité adhérent, bénéficiaire, employeur, N° BS, date
   - VERSO (côté professionnel) : sections à remplir avec cachets des praticiens

   ⚠️ Le VERSO du BS est souvent PIVOTÉ à 90° (orientation paysage). Le redresser mentalement.
   ⚠️ Le VERSO contient PLUSIEURS SECTIONS avec colonnes : DATE | DESIGNATION | CODE ACTE | COTATION | HONORAIRES | CACHET ET SIGNATURE.
   ⚠️ Chaque section peut contenir un CACHET de praticien (tampon à l'encre) avec nom, MF, code CNAM. LIRE ces cachets.
   ⚠️ CERTAINS BS (STAR, CARTE) ont une zone unique "Réservé aux médecins et praticiens"
      avec colonnes Date | Désignation | Honoraires | Visa & cachet | Matricule Fiscal.
      Chaque LIGNE de cette zone = UN acte. Le type se déduit du CACHET (spécialité
      indiquée) et de la désignation abrégée (ANES = anesthésie, KC = acte chirurgical,
      VISITE/V = visite, ACC = accouchement).
   ⚠️ ABRÉVIATIONS MANUSCRITES FRÉQUENTES : ANES/ANESTH = anesthésie |
      ACC/ACCOUCH = accouchement | CES = césarienne | AIDE = aide opératoire |
      PED = pédiatre | GYN = gynécologue | CS = consultation spécialisée.

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
       Le "Montant des frais" inscrit dans la case établissement est souvent la PART PATIENT,
       pas le total de la facture. Le comparer au récapitulatif de la facture avant de conclure.
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
   Si le dossier contient une page "Détail Pharmacie Cumulé", "Détail Facture",
   "Détail consommables" ou toute annexe listant les produits utilisés pendant
   l'hospitalisation (médicaments, dispositifs médicaux, consommables) :
   → Extraire CHAQUE ligne individuellement dans pharmacie_interne.lignes
     avec : nom du produit, date, quantité, prix unitaire, TVA, montant HT, montant TTC.
   → Le total pharmacie_interne.total reste la SOMME de ces lignes.
   → Si la facture clinique a une ou PLUSIEURS lignes groupées "Pharmacie Interne"
     (souvent 3 lignes : TVA 0%, 7%, 19%) ET que le détail existe sur une autre
     page → utiliser le DÉTAIL (plus précis), pas les lignes groupées.
   → Si AUCUN détail n'existe (pas de page annexe) → garder les lignes
     groupées de la facture clinique telles quelles.
   → DÉTAIL AU NOM D'UN AUTRE PATIENT : une page "Détail <NOM>" peut concerner
     le NOUVEAU-NÉ (ex: vaccin hépatite B) alors que la facture est au nom de la
     mère. Extraire ces lignes séparément avec "patient_concerne": "nouveau_ne".
   L'assureur a besoin du détail pour vérifier la remboursabilité de
   chaque produit individuellement.

3h. ÉQUIPE CHIRURGICALE — TOUS LES INTERVENANTS DOIVENT APPARAÎTRE (RÈGLE CRITIQUE) :
Dès qu'il y a une INTERVENTION (chirurgie, accouchement par césarienne,
endoscopie sous AG, geste sous anesthésie), l'équipe attendue est :
  1) CHIRURGIEN / GYNÉCOLOGUE OPÉRATEUR   -> acte promu MEDECIN, lettre_cle "KC",
                                             role_intervention "Chirurgien"
  2) ANESTHÉSISTE                         -> acte promu MEDECIN, lettre_cle "K",
                                             role_intervention "Anesthésiste"
  3) AIDE OPÉRATOIRE                      -> acte promu MEDECIN, lettre_cle "K",
                                             role_intervention "Aide opératoire"
  4) INSTRUMENTISTE / PANSEUR (si présent)-> acte promu MEDECIN, lettre_cle "K",
                                             role_intervention "Instrumentiste"
  5) BLOC OPÉRATOIRE / SALLE D'OPÉRATION  -> RESTE dans l'HOSPITALISATION,
                                             section "bloc_operatoire".
                                             Ce n'est PAS un honoraire de praticien,
                                             donc JAMAIS promu en acte indépendant.

Chacun des points 1 à 4 doit apparaître comme un acte SÉPARÉ dans
"actes_independants", avec "role_intervention" rempli, MÊME SI :
  - la ligne de facture porte "N.P." / "Non Perçu" ou aucun montant,
  - le praticien n'est pas inscrit sur le BS,
  - le montant est 0, vide ou illisible.

LIGNES "N.P." (NON PERÇU) :
Une ligne du compte d'autrui marquée "N.P. (*)" signifie que les honoraires ont
été réglés EN DIRECT au médecin, hors caisse de la clinique.
  → Créer quand même l'acte, avec "non_percu": true.
  → Chercher le montant sur la NOTE D'HONORAIRES du praticien (document séparé).
  → Si aucune note d'honoraires n'existe → montant = "" et signaler dans
    observations : "honoraires non perçus par la clinique, montant à justifier".
  → NE JAMAIS mettre 0.000 à la place d'un montant inconnu.

CONTRÔLE DE COMPLÉTUDE DE L'ÉQUIPE :
Si une intervention est détectée et qu'il MANQUE l'anesthésiste ou l'aide
opératoire dans les actes promus, ajouter dans observations_globales :
"équipe incomplète : <rôle manquant> non retrouvé — vérifier les notes d'honoraires".
Ne JAMAIS inventer un praticien absent : signaler seulement.

3i. ACCOUCHEMENT — CODIFICATION (RÈGLE CRITIQUE) :
  - ACCOUCHEMENT PAR CÉSARIENNE → ACTE CHIRURGICAL :
      lettre_cle = "KC" + cotation (lire sur la lettre confidentielle, le BS,
      ou le code de la facture "Acte : <CODE> (KC nn)").
      "forfait" = false.
      L'HOSPITALISATION porte motif "Accouchement par césarienne".
      ÉQUIPE ATTENDUE (règle 3h) : gynécologue-obstétricien (Chirurgien) +
      anesthésiste + aide opératoire + bloc opératoire.
      Un pédiatre est très souvent présent pour le nouveau-né → acte séparé.
  - ACCOUCHEMENT SIMPLE / PAR VOIE BASSE → PAS DE KC :
      c'est un FORFAIT conventionnel.
      lettre_cle = "", cotation = "", "forfait": true,
      montant = montant forfaitaire facturé.
      Ne JAMAIS inventer une cotation KC pour un accouchement voie basse.
  - Un accouchement (césarienne ou voie basse) est TOUJOURS une HOSPITALISATION,
    même si le séjour est court.
  - Si le document ne précise pas la voie d'accouchement → ne pas trancher :
    motif = "Accouchement", forfait = "", et signaler dans observations
    "voie d'accouchement non précisée".
  - NOUVEAU-NÉ : les actes concernant le bébé (visite/examen pédiatrique,
    vaccin hépatite B, ordonnance libellée "Bébé de Mme X" ou "Nouveau-né de...",
    page de détail facture au nom du nouveau-né, soins ophtalmiques du nourrisson)
    sont des actes SÉPARÉS avec "patient_concerne": "nouveau_ne".
    Les actes de la mère portent "patient_concerne": "adherent" (ou "conjoint"/"enfant").
    NE JAMAIS fondre les frais du nouveau-né dans ceux de la mère : l'assureur
    applique des garanties distinctes.

3j. FACTURE CLINIQUE — VENTILATION P.E.C / PATIENT :
Beaucoup de factures d'établissement ont 2 colonnes de prise en charge :
"P.E.C" (part organisme, parfois intitulée du nom de la convention, ex
"CNAM CHIRURGIE") et "Patient" (reste à charge).
Pour CHAQUE ligne extraite, remplir :
  "montant_ht"      : colonne Tot. HT
  "tva"             : colonne T.V.A (taux, ex "7%")
  "montant"         : colonne T.T.C (montant de référence de la ligne)
  "montant_pec"     : valeur de la colonne P.E.C, ou ""
  "montant_patient" : valeur de la colonne Patient, ou ""
Au niveau de l'HOSPITALISATION, remplir le bloc "recapitulatif_facture" :
  "total_clinique_ht", "total_tva", "timbre_fiscal",
  "total_pec_organisme"     : total colonne P.E.C TTC
  "reste_a_charge_patient"  : total colonne Patient TTC
  "total_compte_autrui"     : total TTC du compte d'autrui
  "total_facture_ttc"       : Total T.T.C imprimé
  "acompte"                 : acompte / avance versée (valeur ABSOLUE, sans le signe -)
  "net_a_payer"             : net à payer imprimé
RÈGLE : "total_pec_organisme" alimente "montant_cnam" de l'HOSPITALISATION
UNIQUEMENT s'il n'existe NI décompte CNAM NI forfait chiffré sur la décision
de prise en charge. Dans ce cas, préciser dans observations : "montant_cnam
issu de la colonne P.E.C de la facture (pas de décompte disponible)".

3k. CHAÎNAGE D'INTERVENTION — RATTACHER SANS JAMAIS FUSIONNER (RÈGLE CRITIQUE) :
Tous les postes d'une même intervention (chirurgien, anesthésiste, aide, instrumentiste,
bloc/salle d'opération, séjour, pharmacie interne, oxygène) partagent le MÊME
"intervention_id" (ex: "INT-1") et référencent le même "code_acte".
Cela permet au gestionnaire de voir d'un coup d'œil tout ce qui relève de l'acte.

🚫 INTERDIT ABSOLU : additionner ces postes en un seul montant "KC".
Chaque poste garde SON montant, SA lettre-clé et SA rubrique, parce que l'assureur
applique un PLAFOND et un TAUX DIFFÉRENTS par rubrique. Fusionner détruit
l'application du barème et fait perdre les plafonds atteints.

CHAMPS OBLIGATOIRES sur chaque acte promu ET sur chaque ligne des sections
d'hospitalisation liées à une intervention :
  "intervention_id"   : identifiant du chaînage (INT-1, INT-2...)
  "rubrique_proposee" : classification par NATURE ÉCONOMIQUE du poste :
      "K"    = honoraires chirurgicaux (chirurgien, aide opératoire, instrumentiste)
      "FAN"  = frais d'anesthésie (honoraires de l'anesthésiste)
      "SO"   = salle d'opération + anesthésie (ligne "Acte : <CODE>", bloc,
               salle de réveil, oxygène, appareillages)
      "JHC"  = hospitalisation et clinique (chambre, lit, séjour, accompagnant,
               frais de dossier)
      "PH"   = pharmacie (interne et de ville)
      "CS"   = consultations et visites (y compris visite au nouveau-né)
      "AUTRE"= tout poste non classable
  ⚠️ Ces libellés de rubriques sont ceux couramment employés par les assureurs
  tunisiens. Si un relevé d'assureur présent dans le dossier utilise d'AUTRES
  codes, recopier SES codes dans "rubrique_assureur" en plus de rubrique_proposee.
  "rubrique_proposee" est une PROPOSITION fondée sur la nature du poste. Le barème
  définitif dépend du contrat et sera appliqué EN AVAL. Ne jamais calculer de taux.

INDICATEUR DE COÛT (informatif seulement) :
  "cout_total_intervention" : somme de tous les postes portant le même
  intervention_id. C'est un INDICATEUR d'affichage, JAMAIS une base de
  remboursement, JAMAIS un montant à substituer aux montants individuels.

3l. RESTITUTION vs LIQUIDATION — SÉPARATION STRICTE (RÈGLE CRITIQUE) :
L'extraction RESTITUE une vue complète et détaillée. Elle ne DÉCIDE jamais d'un
mode de calcul, ne fusionne rien, ne supprime rien.
  → Chaque poste conserve son montant, sa lettre-clé, sa rubrique et son
    intervention_id : c'est la vue DÉTAILLÉE.
  → Le chaînage par intervention_id permet au gestionnaire de basculer en vue
    GROUPÉE sans qu'aucun montant ne soit fusionné ni recalculé dans le JSON.
  → Le choix entre "liquider au forfait global" et "liquider poste par poste
    selon les plafonds du contrat" appartient AU GESTIONNAIRE, en aval.

GARANTIE D'ADDITIVITÉ (impérative) :
Une addition naïve de tous les postes doit donner un total JUSTE. Aucun montant
ne doit apparaître deux fois sous deux angles différents.
Quand deux représentations d'une même dépense coexistent (total de facture vs ses
lignes, ligne groupée "Pharmacie Interne" vs son détail annexe, note d'honoraires
vs ligne de compte d'autrui du même praticien), remplir :
  "exclusif_avec" : liste des libellés ou identifiants des postes avec lesquels
                    ce montant NE DOIT PAS être additionné, car ils représentent
                    la même dépense sous un autre angle.
Le front s'en sert pour empêcher tout double comptage lors d'un regroupement.

VUE PAR DÉFAUT : si "forfait" vaut true (accouchement voie basse, acte au forfait
conventionnel), la vue GROUPÉE est la lecture pertinente. Sinon (césarienne,
chirurgie cotée), c'est la vue DÉTAILLÉE. Renseigner "vue_recommandee":
"groupee" | "detaillee" au niveau de l'hospitalisation.

3m. PHARMACIE INTERNE — CLASSER SANS DÉCIDER DE LA REMBOURSABILITÉ :
Chaque ligne de pharmacie_interne (et de pharmacie de ville) reçoit un champ "nature" :
  "MEDICAMENT"         : spécialité pharmaceutique avec DCI identifiable —
                         antibiotique, antalgique, anesthésique, soluté de perfusion,
                         utérotonique, corticoïde, vitamine, vaccin, antiseptique
  "DISPOSITIF_MEDICAL" : sonde, cathéter, suture/fil, aiguille, seringue, perfuseur,
                         électrode, plaque, tubulure, drain
  "CONSOMMABLE_UU"     : gant, casaque, alèse, compresse, champ, housse, masque,
                         lancette, bandelette, trousse, kit, sparadrap
  "HOTELIER"           : bracelet, rasoir, thermomètre, brosse, kit patient, blouse

INDICE FORT MAIS NON DÉCISIF : en Tunisie les médicaments sont à TVA 0%.
  → TVA 7% ou 19% ⇒ ce n'est JAMAIS un médicament.
  → TVA 0% ⇒ CANDIDAT médicament, à confirmer par la désignation (sondes,
    cathéters et sutures sont aussi à 0%).

SOUS-TOTAUX OBLIGATOIRES dans pharmacie_interne :
  "total_medicaments", "total_dispositifs", "total_consommables", "total_hotelier"
Leur somme doit être EXACTEMENT égale à pharmacie_interne.total.

🚫 EXTRACTION EXHAUSTIVE OBLIGATOIRE : ne JAMAIS omettre une ligne au motif
qu'elle semble non remboursable. Le caractère remboursable dépend du CONTRAT et
change d'un assureur, d'une année et d'un adhérent à l'autre. Une ligne non
extraite est une ligne que le gestionnaire ne pourra ni vérifier ni contester.
Le nombre de lignes extraites doit égaler le nombre de lignes imprimées (contrôle C5).
"nature" est une CLASSIFICATION FACTUELLE, jamais une décision de remboursement.

Si un relevé d'assureur porte une observation d'exclusion (ex: "produits
pharmaceutiques à usage unique non remboursables"), la RECOPIER telle quelle dans
observations_globales — sans l'appliquer aux montants ni supprimer de lignes.

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
   COLONNES FRÉQUENTES SUR TICKET CNAM : Code PCT | Produit | Forme | Qte | PUV | Mt. Percu | N.I.O | PRif/Lot.
   → "prix_unitaire" = PUV ; "total_ligne" = Mt. Percu (montant réellement encaissé).
     Si PUV ≠ Mt. Percu, garder les DEUX (le total du ticket est la somme des Mt. Percu).
   TICKET PIVOTÉ : les tickets pharmacie sont très souvent scannés à 90° ou 180°. Redresser.
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
5d. TOTAL D'UN TICKET PHARMACIE — SOURCE UNIQUE (RÈGLE CRITIQUE) :
   "montant" d'un acte PHARMACIE = le TOTAL IMPRIMÉ SUR CE TICKET, et rien d'autre.
   Chercher : ligne "Total :", "TTC :", "Net :", "Arrêtée à la somme de",
   ou le montant écrit EN TOUTES LETTRES en bas du ticket (source très fiable :
   "Dix sept dinars cent cinq millimes" = 17.105).
   🚫 INTERDIT : prendre le total depuis un relevé d'assureur, un décompte, une
   autre pharmacie, ou la somme d'un autre ticket.
   Si la somme des details_lignes s'écarte du total imprimé de plus de 0.100 DT :
     → GARDER le total imprimé (il fait foi).
     → NE PAS le remplacer par une valeur venue d'ailleurs.
     → Consigner dans controles.ecart_pharmacie :
       "ticket <pharmacie> <date> : N lignes lues = X, total imprimé = Y".
   Si le ticket est masqué par des vignettes collées ET que le total est illisible :
     montant = "[ILLISIBLE]". JAMAIS un montant emprunté à un autre document.
   VÉRIFICATION EN TOUTES LETTRES : quand le montant est écrit en lettres ET en
   chiffres, les deux doivent concorder. Sinon, retenir les LETTRES et signaler.
6. Illisible sans référence imprimée → "[ILLISIBLE]". AUCUNE INVENTION.
7. CNAM : si un décompte CNAM est présent (mots-clés : "CNAM", "Décompte de remboursement", "Mnt Remb", "TotRemb"), extraire TOUTES les sections (Consultation, Actes, Médicaments...) avec code, désignation, quantité, date, montant_depense, montant_rembourse, franchise, décision. Extraire totaux.
   ⚠️ NE PAS CONFONDRE avec un RELEVÉ D'ASSUREUR PRIVÉ (STAR, CARTE, BH, GAT...)
   intitulé "Relevé individuel de remboursement" / "Groupe Maladie", avec colonnes
   Rubrique | Libellé | Observations | Dépenses | Base-Cotation | Remboursement.
   Ce document N'EST PAS un décompte CNAM → il va dans pieces_justificatives
   (type RELEVE_ASSUREUR) et ne remplit NI "montant" NI "montant_cnam".
7b. VERROU RELEVÉ ASSUREUR — CONTRÔLE ULTIME AVANT DE RÉPONDRE (RÈGLE CRITIQUE) :
   Avant de retourner le JSON, passer en revue CHAQUE acte et vérifier qu'AUCUN
   montant provenant de releve_assureur.lignes[].depenses ou .remboursement
   n'a été utilisé comme "montant" ou "montant_cnam", SAUF si ce montant est
   également lisible sur une PIÈCE PRIMAIRE (facture, note d'honoraires, ticket, BS).
   Si un montant d'acte n'a AUCUNE autre source que le relevé :
     → le remettre à "" (ou "[ILLISIBLE]" si la pièce existe mais est illisible)
     → consigner : "montant introuvable sur pièce primaire, valeur relevé X non retenue"
   Le relevé peut en revanche CONFIRMER un montant déjà lu sur une pièce primaire :
     ex. dépenses K = 1000.000 confirme note d'honoraires 750 + facture 250.
     Dans ce cas, remplacer l'observation "montant à confirmer" par
     "montant confirmé par le relevé assureur".
   RAPPEL : un relevé d'assureur privé n'est ni une facture ni un décompte CNAM.
   Ses "Dépenses" sont ce que l'ASSUREUR a retenu comme base, ce qui peut différer
   de ce qui a été réellement facturé.
8. CROISEMENT CNAM ↔ ACTES (RÈGLE CRITIQUE) :
   Si un décompte CNAM est présent, pour chaque acte chercher la ligne CNAM correspondante (même type, même date) :
   → Remplir "montant_cnam" avec le montant EFFECTIVEMENT REMBOURSÉ par la CNAM (colonne "Mnt Remb" du décompte).
   → Ce montant REMPLACE tout forfait de décision de prise en charge précédemment affecté.
   → NE JAMAIS modifier "montant" de l'acte. Le "montant" vient de la FACTURE, de la NOTE D'HONORAIRES ou du BS, JAMAIS du décompte.
   → Ex: facture = 278.500, décompte Mnt Remb = 231.000, reste adhérent = 47.500 :
     "montant" = "278.500" (facture)
     "montant_cnam" = "231.000" (décompte, PAS le forfait de la décision)
   → Si pas de correspondance → montant_cnam = "".
9. PIÈCES JUSTIFICATIVES : extraire dans "pieces_justificatives" avec rattachement_acte (index 0-based, null si impossible).
   Types : ORDONNANCE | BILAN | RECU | FACTURE | NOTE_HONORAIRES | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | PRISE_EN_CHARGE | RELEVE_ASSUREUR | CERTIFICAT_MEDICAL | AUTRE
   CERTIFICAT_MEDICAL : certificat médical confidentiel attestant une pathologie (cancer, maladie chronique). Extraire dans texte_libre. Si mentionne une pathologie APCI → alimenter aussi apci.pathologies.
   LETTRE_CONFIDENTIELLE : extraire INTÉGRALEMENT chirurgien, dates, motif COMPLET (ne JAMAIS tronquer), acte réalisé, codification CNAM.
   PRISE_EN_CHARGE : code_intervention, forfait CNAM, numéro/date décision. Rattacher à l'acte correspondant.

   NOTE_HONORAIRES (NOUVEAU) : formulaire pré-imprimé "Note d'Honoraires N° ...",
     avec le nom du docteur, le nom du patient, et 3 lignes pré-imprimées :
       "- Médecin :"  /  "- Chirurgien :"  /  "- Aide opératoire :"
     La ligne COCHÉE, ENTOURÉE, SOULIGNÉE ou REMPLIE donne le RÔLE du praticien
     → alimente "role_intervention" de l'acte promu correspondant.
     Si AUCUNE ligne n'est marquée, déduire le rôle du CACHET :
       "Médecin Anesthésiste Réanimateur"        → Anesthésiste
       "Spécialiste en Gynécologie Obstétrique"  → Chirurgien (si intervention)
       "Chirurgien ..."                          → Chirurgien
       "Pédiatre"                                → Pédiatre
     Le TOTAL manuscrit en bas de la note = montant de l'acte. Extraire aussi
     numero_note et le MF du cachet.
     ⚠️ NOTE D'HONORAIRES vs LIGNE "COMPTE D'AUTRUI" du MÊME praticien avec des
     montants DIFFÉRENTS : ce n'est PAS forcément un doublon. Ce sont souvent
     deux parts (part facturée par la clinique + part réglée en direct).
     Dans ce cas : créer UN SEUL acte, avec details_lignes contenant les 2 montants
     et leur source, montant = leur SOMME, et signaler dans observations :
     "montant à confirmer : note d'honoraires X + ligne facture Y".
     Si les montants sont IDENTIQUES → c'est un doublon, ne compter qu'une fois.

   RELEVE_ASSUREUR (NOUVEAU) : "Relevé individuel de remboursement" d'un assureur
     privé (STAR, CARTE, BH, GAT, Maghrebia...), en-tête "GROUPE MALADIE".
     Extraire dans le bloc "releve_assureur" : contrat_n, societe, matricule_adherent,
     nom_adherent, nom_malade, bulletin_n, date_soins, date_emission, bordereau_n,
     puis chaque ligne (rubrique, libelle, observations, depenses, base_cotation,
     remboursement), et les totaux (total_depenses, total_remboursement, net_a_regler).
     ⚠️ INTERDIT ABSOLU : ce relevé ne remplit JAMAIS "montant_cnam" (ce n'est pas
     la CNAM) et ne modifie JAMAIS "montant" d'un acte. Il sert au CONTRÔLE et à la
     détection d'écarts uniquement.
     UTILITÉ ANALYTIQUE : le "bulletin_n" du relevé confirme le numero_bulletin du BS ;
     les rubriques (FAN=frais anesthésie, JHC=hospitalisation et clinique, K=frais
     chirurgicaux, PH=pharmacie, SO=salle opération+anesthésie) permettent de vérifier
     qu'aucun poste n'a été oublié. Les observations "plafond atteint" doivent être
     recopiées dans observations_globales.

10. CROISEMENT ORDONNANCES ↔ PHARMACIE : vérifier cohérence médicaments prescrits vs délivrés. Signaler écarts dans "observations".
    ⚠️ Une ordonnance peut être libellée au nom du NOUVEAU-NÉ ("Bébé de Mme X") alors
    que le ticket pharmacie est au nom de la mère. Ce n'est pas une incohérence :
    rattacher le ticket à l'ordonnance et marquer patient_concerne = "nouveau_ne".
11. NUMÉRO DE BULLETIN : champ "BS N°" ou "N°" imprimé en HAUT du BS (ex: 0308601, 1085663). Peut aussi être manuscrit/tamponné. NE PAS confondre avec numéro d'adhérent, contrat, ou Adhésion N°.
    Un RELEVE_ASSUREUR indique souvent "Bulletin N° :" — l'utiliser pour CONFIRMER
    la lecture du BS (mais le BS reste la source primaire).
12. DATES : TOUJOURS normaliser en JJ/MM/AAAA avec zéros (3/7/26 → 03/07/2026, 6/8/26 → 06/08/2026). Année 2 chiffres → 20XX.
   DATE DU BULLETIN : chercher le champ "Date" sur le BS (souvent manuscrit). C'est la date de DÉPÔT du bulletin, PAS la date des actes. Si non visible → "".
13. MULTI-PAGES : bulletin recto + verso = UN SEUL document. FUSIONNER les 2 faces.
   FACE 1 (côté patient) : identité adhérent, bénéficiaire, employeur, N° BS (imprimé en haut), APCI, signature assuré.
   FACE 2 (côté professionnel) : sections médicales (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux) avec cachets praticiens + cachet employeur.
   Les 2 faces forment UN SEUL bulletin.
14. BÉNÉFICIAIRE : case cochée (✓/✗/remplie). Conjoint → nom malade = conjoint. Enfant → nom malade = enfant. Aucune → "Adhérent".
   Si le nom du malade est IDENTIQUE au nom de l'adhérent → beneficiaire_coche = "Adhérent",
   même si une case semble cochée par erreur. Une décision CNAM mentionnant
   "Qualité : Assuré lui même" confirme "Adhérent".
15. LETTRES-CLÉS CNAM : C=consultation généraliste | CS=spécialiste | V=visite | KC=chirurgie | KE=exploration | K=technique | Z=radiations ionisantes | B=biologie | Rd=radiologie diagnostique | D=dentaire | P=anatomopath | SC/SF=sage-femme | AMO/AMI/AMS=infirmier | TO/TM/APR=kiné
16. DÉSIGNATIONS EXACTES : lire CHAQUE LIGNE de la facture. NE JAMAIS utiliser de termes génériques. Détailler analyses biologiques dans details_lignes. Si plusieurs prestations → details_lignes. Montant global sans détail → PAS de details_lignes.
17. PHARMACIE : 1 acte = 1 ticket/1 pharmacie/1 date. Toutes lignes dans details_lignes. Fusionner doublons même pharmacie+date.
   PHARMACIES MULTIPLES : un dossier peut contenir 2, 3+ tickets de pharmacies DIFFÉRENTES → créer UN acte PHARMACIE par pharmacie/date. Ex: Pharmacie ABDENNADHER (66.885 DT) + Pharmacie BOUDRYA (77.500 DT) = 2 actes PHARMACIE séparés.
   MÊME PHARMACIE, DATES DIFFÉRENTES → 2 actes distincts. MÊME pharmacie + MÊME date → 1 seul acte fusionné.
   ATTENTION : un ticket peut avoir 2, 5, 10+ médicaments. NE JAMAIS en ignorer.
   Lire le ticket LIGNE PAR LIGNE. Si une vignette est collée à côté d'une ligne → lire le nom depuis la vignette (plus fiable que le code-barres).
   Si le BS mentionne "Pharmacie" avec un montant mais que tu n'as pas de ticket détaillé → créer l'acte PHARMACIE avec le montant du BS, details_lignes vide.
   PHARMACIE INTERNE (clinique) ≠ PHARMACIE DE VILLE : la pharmacie interne reste
   dans l'HOSPITALISATION (section pharmacie_interne), la pharmacie de ville
   (officine, ticket CNAM avec MF de pharmacien) devient un acte PHARMACIE indépendant.
   PRODUITS DE CONTRASTE (ex: MEDISCAN, OMNIPAQUE, IOPAMIRON) : ce sont des produits achetés en pharmacie POUR une radiologie. Créer un acte PHARMACIE normal. Le rattachement à la radiologie se fait via l'ordonnance du radiologue → signaler dans observations "Produit de contraste pour radiologie".
18. ACCORD PRÉALABLE ET PRISE EN CHARGE CNAM :
   a) ACCORD PRÉALABLE ASSUREUR : quand le BS ou l'assureur mentionne "Accord préalable", "APB", ou une colonne "Accord" → accord_prealable: true.
   b) DÉCISION DE PRISE EN CHARGE CNAM : c'est un document CNAM distinct (titre "DÉCISION DE PRISE EN CHARGE").
      → accord_prealable: true + remplir accord_prealable_details.
      CHAMPS À EXTRAIRE : code_intervention, forfait_cnam, numero_decision,
      date_decision, date_depot_demande, centre_regional, code_convention
      (le nombre entre parenthèses du titre, ex "(60)"), objet (ex "HOSPITALISATION
      POUR ACCOUCHEMENT"), qualite_assure (ex "Assuré lui même"), assure_numero,
      identifiant_unique, validite_jours (ex "45 JOURS").
      NORMALISATION DU NUMÉRO : "N° 86 2026 7986" → "86/2026/7986".
      Le code-barres / référence longue (ex 0862026007986) peut confirmer la lecture.
      ⚠️ BEAUCOUP DE DÉCISIONS NE PORTENT AUCUN MONTANT (prise en charge de principe,
      réglée directement à la clinique conventionnée). Dans ce cas :
        forfait_cnam = "" et montant_cnam = "" (ou, à défaut, la colonne P.E.C de la facture).
      → NE JAMAIS déduire un forfait depuis la facture, le relevé assureur, un total,
        ou le net à payer. Une décision sans chiffre reste sans chiffre.
      → Le "forfait_cnam" dans accord_prealable_details = montant du FORFAIT accordé
        (engagement maximum) UNIQUEMENT s'il est écrit noir sur blanc sur la décision.
      ⚠️ La décision CNAM est aussi une SOURCE D'IDENTITÉ fiable : elle donne
      l'identifiant unique / numéro d'assuré CNAM, souvent plus lisible que le BS
      manuscrit. L'utiliser pour remplir "numero_cnam" si le BS est illisible,
      et le signaler dans observations.
   c) MONTANT_CNAM : PRIORITÉ AU DÉCOMPTE CNAM :
      → Si un DÉCOMPTE CNAM existe → montant_cnam = montant EFFECTIVEMENT REMBOURSÉ (colonne "Mnt Remb" du décompte). C'est le montant RÉEL payé par la CNAM.
      → Si PAS de décompte mais une DÉCISION DE PRISE EN CHARGE CHIFFRÉE → montant_cnam = forfait de la décision.
      → Si PAS de décompte et décision NON CHIFFRÉE → montant_cnam = colonne P.E.C de la facture, ou "".
      → Le forfait (décision) ≠ le remboursement réel (décompte). Le décompte PRIME TOUJOURS.
      → Ex: décision forfait = 332.500, mais décompte montre Mnt Remb = 231.000 → montant_cnam = "231.000" (pas 332.500).
         Le reste (47.500) est à la charge de l'adhérent.

19. ANALYSE ET CONTRÔLES CROISÉS (RÈGLE D'ANALYSE) :
   Avant de retourner le JSON, exécuter ces contrôles et consigner CHAQUE anomalie
   dans "controles" (avec un libellé clair). Ne JAMAIS modifier une valeur lue pour
   faire disparaître une anomalie : signaler, ne pas corriger.
   C1. Somme des sections de l'hospitalisation vs "Total Clinique" imprimé
       → écart attribué aux ajustements écartés (ecart_ajustements).
   C2. Somme des actes promus (rattachement_hospitalisation) vs "Total Pour le compte
       d'autrui" imprimé → écart signalé (les lignes N.P. expliquent souvent l'écart).
   C3. Somme des details_lignes d'une pharmacie vs total du ticket.
   C4. Nombre de lignes lues sur un ticket vs nombre de lignes visibles.
   C5. Total du détail pharmacie interne vs ligne(s) groupée(s) "Pharmacie Interne"
       de la facture.
   C6. Montant du BS (case établissement) vs total facture / part patient.
   C7. Équipe chirurgicale complète (règle 3h).
   C8. Cohérence des dates : date_entree ≤ date des actes ≤ date_sortie ;
       date de facture ≥ date de sortie ; ordonnance ≥ date de l'acte.
   C9. Le nom du malade est-il le même sur TOUTES les pièces ? Si une pièce porte un
       autre nom (nouveau-né, autre adhérent), le signaler explicitement.
   C10. Une pièce justificative existe-t-elle pour CHAQUE acte ? Un acte sans pièce
       n'est pas une erreur, mais doit être signalé "acte sans justificatif".
   C11. Doublons potentiels : même praticien + même date + montants proches
       → signaler "doublon potentiel" plutôt que de fusionner arbitrairement.
   C12. NOMENCLATURE = RÉFÉRENCE, JAMAIS ARBITRE : matched_nomenclature sert à
       confirmer la DÉSIGNATION et la FAMILLE d'un code. Sa cotation ne remplace
       JAMAIS celle lue sur un document. Priorité : lettre confidentielle >
       facture/BS > nomenclature. Si elles diffèrent, GARDER celle du document et
       ajouter une note INFORMATIVE ("cotation facturée 100, nomenclature 80").
       Ce n'est PAS une anomalie : la cotation dépend de la convention appliquée.
   C13. BS ↔ FACTURE : le "Montant des frais" de la case établissement du BS doit
       correspondre soit au total de la facture, soit au reste à charge patient
       clinique. Indiquer explicitement à laquelle des deux il correspond.
   C14. TOTAL FACTURE : si la grille (page 1) et le récapitulatif (dernière page)
       donnent deux totaux différents → signaler l'écart et sa cause probable
       (timbre fiscal, acompte, arrondi).
   C15. ACTES NON RETENUS PAR L'ASSUREUR : lister les actes présents dans
       actes_independants mais ABSENTS des lignes du relevé assureur.
       Ce sont des postes que l'adhérent supporte peut-être intégralement.
   C16. INTÉGRITÉ DU SCHÉMA : chaque pièce porte "type_piece" (jamais "type").
       Chaque montant est une chaîne SANS séparateur de milliers ("1000.000",
       jamais "1,000.000"). Chaque acte promu porte role_intervention,
       intervention_id et rubrique_proposee.
   C17. ADDITIVITÉ : la somme de tous les postes (hospitalisation hors compte
       d'autrui + actes promus + actes indépendants) doit égaler
       total_global_calcule. Si un poste porte "exclusif_avec", vérifier qu'il
       n'est pas compté avec son exclusif.

   NIVEAU DE CONFIANCE : sur chaque acte, remplir "confiance" =
     "haute"   (montant et praticien lus sur un document IMPRIMÉ),
     "moyenne" (lus sur un manuscrit lisible ou un cachet),
     "faible"  (déduits, partiellement illisibles, ou reconstitués par croisement).

20. CALCUL DU RESTE À CHARGE — CASCADE DES PAYEURS (RÈGLE CRITIQUE) :
   Le reste à charge se calcule en cascade : la CNAM d'abord (payeur de base,
   réglée directement à l'établissement conventionné), l'assureur privé ensuite
   (complémentaire), l'adhérent en dernier.

       reste_a_charge = depense_totale − pec_cnam − remboursement_assureur

   ⚠️ "depense_totale" doit inclure TOUT ce qui est HORS FACTURE, sinon le reste
   est sous-estimé :
       facture(s) clinique TTC (compte d'autrui inclus)
     + honoraires réglés en direct (notes d'honoraires, lignes marquées N.P.)
     + pharmacies de ville
     + tout acte ambulatoire du dossier

   Remplir le bloc "reglement" au niveau du dossier (voir schéma JSON).

   CONTRÔLES OBLIGATOIRES (signaler, ne JAMAIS corriger un montant) :
     R1. DOUBLE PRISE EN CHARGE : un poste figurant à la fois en colonne P.E.C de
         la facture (payé par la CNAM) ET dans une ligne de dépenses du relevé
         assureur → consigner "double prise en charge potentielle sur <poste> :
         part CNAM X, base retenue par l'assureur Y". Selon le contrat c'est
         normal (complémentaire calculant sur la dépense brute puis plafonnant)
         ou c'est un sur-remboursement. NE PAS TRANCHER, signaler.
     R2. LIGNES ASSUREUR NON RAPPROCHÉES : chaque ligne de dépense du relevé doit
         être rapprochée d'un acte ou d'une ligne de facture. Sans rapprochement →
         "ligne assureur non rapprochée : rubrique R, montant M".
     R3. ACTES NON SOUMIS : actes du dossier absents du relevé → "acte non soumis
         ou non retenu par l'assureur".
     R4. ÉCART GLOBAL : si total_depenses du relevé ≠ somme des dépenses extraites
         → consigner l'écart chiffré et les postes qui l'expliquent.

   🚫 NE JAMAIS calculer un taux de remboursement, appliquer un plafond, ni
   décider qu'un poste est remboursable : le barème appartient au CONTRAT et sera
   appliqué en aval. L'extraction fournit les montants, pas les décisions.

Retourne UNIQUEMENT ce JSON :

{
          "infos_adherent": {
            "assureur_detecte": "BH Assurance | CARTE Assurances | CNAM | STAR | GAT | autre — détecter via le LOGO ou la mention de l'ASSUREUR (en haut du BS RETENU). ATTENTION : le formulaire BS peut être au format CNAM (formulaire standard) mais l'assureur est celui dont le LOGO apparaît (ex: CARTE Assurances). Ne PAS mettre 'CNAM' comme assureur sauf si c'est un BS CNAM sans logo d'assureur privé. Choisir UN SEUL assureur, jamais 'CNAM / CARTE'. Si le lot contient plusieurs BS, prendre celui du BS RENSEIGNÉ correspondant aux pièces (règle H).",
            "nom_prenom": "Nom de l'adhérent",
            "numero_adherent": "N° de l'adhérent — chercher dans 'Adhésion N°', 'N° Adhérent' ou 'Matricule Adhérent'. Si absent, chercher dans 'Identifiant Unique'. ATTENTION : 'Adhésion N°' n'est PAS le contrat, c'est le numero_adherent. Transcrire EXACTEMENT tel qu'il apparaît, SANS espaces parasites.",
            "numero_contrat": "N° de contrat — chercher UNIQUEMENT dans 'Contrat N°' ou 'Police N°'. JAMAIS depuis 'Adhésion N°' (qui est le numero_adherent). Si pas de champ 'Contrat N°' explicite → ''.",
            "numero_cnam": "N° CNAM — chercher dans 'N° CNAM', 'Matricule CNAM', 'Identifiant Social', ou l'Identifiant Unique d'une décision de prise en charge CNAM. Ce champ est DISTINCT de numero_adherent et numero_contrat. Si non visible → ''.",
            "employeur": "Nom de l'employeur ou de la société (champ Employeur du BS, ou 'Société' d'un relevé assureur)",
            "numero_bulletin": "N° du bulletin — chercher en HAUT du BS le champ 'BS N°' ou 'N°'. Peut être imprimé ou manuscrit/tamponné. Confirmable via le champ 'Bulletin N°' d'un relevé assureur. PRIORITÉ HAUTE.",
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
            "nom_prenom_malade": "Nom du patient soigné",
            "date_naissance": "Date de naissance si visible (JJ/MM/AAAA)",
            "adresse": "Adresse du malade/adhérent si visible",
            "nouveau_ne_present": "true si le dossier contient des actes/pièces concernant un nouveau-né"
          },
          "actes_independants": [
            {
              "type": "MEDECIN",
              "date": "...",
              "praticien": "Nom du médecin traitant",
              "specialite": "Spécialité lue sur le cachet (ex: Gynécologie Obstétrique, Anesthésie Réanimation, Pédiatrie). '' si non visible.",
              "matricule_fiscale": "...",
              "code_cnam_praticien": "Code CNAM du professionnel de santé (ex: 1/12896/11) — celui du PRATICIEN, jamais du patient",
              "acte": "Désignation EXACTE (ex: Consultation spécialisée cardiologie, Visite à domicile, Accouchement par césarienne, Anesthésie générale, Aide opératoire)",
              "role_intervention": "Chirurgien | Anesthésiste | Aide opératoire | Instrumentiste | Panseur | Pédiatre | Autre — OBLIGATOIRE pour tout acte rattaché à une intervention. '' sinon.",
              "intervention_id": "Identifiant de chaînage partagé par tous les postes de la même intervention (ex: INT-1). '' si l'acte n'est lié à aucune intervention.",
              "rubrique_proposee": "K | FAN | SO | JHC | PH | CS | AUTRE — classification par nature économique du poste (voir règle 3k). PROPOSITION, jamais une décision de barème.",
              "rubrique_assureur": "Code de rubrique tel qu'écrit sur le relevé d'assureur, s'il en existe un pour ce poste. '' sinon.",
              "exclusif_avec": ["Libellés ou identifiants des postes avec lesquels ce montant ne doit PAS être additionné (même dépense sous un autre angle). Tableau vide si aucun."],
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
              "code_acte": "Code CNAM de l'acte si visible (ex: MJC030040). OBLIGATOIRE sur un acte 'Chirurgien' dès qu'un code d'intervention existe dans le dossier (voir règle CODIFICATION).",
              "lettre_cle": "KC ou K ou KE ou C ou CS ou V si visible",
              "cotation": "Nombre après la lettre-clé (ex: 50 pour KC50, 100 pour KC100)",
              "forfait": "true si l'acte est facturé au forfait conventionnel (accouchement voie basse, etc.), false sinon",
              "rattachement_hospitalisation": "Index 0-BASED de l'acte HOSPITALISATION dans actes_independants auquel ce prestataire est rattaché (meme convention que rattachement_acte). Remplir UNIQUEMENT pour les prestataires promus depuis une facture clinique ou une note d'honoraires liée au séjour. Si acte indépendant -> ne pas inclure ce champ.",
              "origine_ligne": "compte_autrui | details_facture | note_honoraires | bulletin — d'où provient cet acte.",
              "libelle_origine": "Libellé EXACT de la ligne telle qu'écrite sur la facture ou la note (ex: 'AIDE OPERATOIRE', 'GHOZZI Mounir (GYN)'). Présent uniquement sur un acte promu.",
              "non_percu": "true si la ligne de facture porte 'N.P.' / 'Non Perçu' (honoraires réglés en direct au praticien)",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE de chaque prestation sur la facture / source du montant",
                  "source": "facture_clinique | note_honoraires | bulletin | recu",
                  "code_acte": "Lettre-clé ou code CNAM de cette ligne si visible (ex: CS, Ke, KC, MJC030040)",
                  "cotation": "Coefficient de cette ligne",
                  "montant": "Montant de cette ligne"
                }
              ],
              "conventionne": "oui | non | '' (si mention 'conventionné' ou 'hors convention' visible sur facture/reçu/BS. Si non visible → '')",
              "montant_ht": "Montant HT si la facture distingue HT/TTC, sinon ''",
              "montant": "Montant FACTURÉ TTC — UNIQUEMENT depuis facture/note d'honoraires/reçu/BS. JAMAIS depuis décision CNAM, décompte, ou relevé assureur. Si aucune source → ''.",
              "montant_pec": "Part P.E.C (organisme) de cette ligne sur la facture clinique, si la colonne existe",
              "montant_patient": "Part patient de cette ligne sur la facture clinique, si la colonne existe",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge chiffrée. JAMAIS depuis facture patient ni relevé assureur privé.",
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": "Anomalies propres à cet acte (montant à confirmer, illisibilité, doublon potentiel...)"
            },
            {
              "type": "RADIOLOGIE",
              "date": "...",
              "centre_radiologie": "Nom du centre ou médecin radiologue",
              "matricule_fiscale": "...",
              "medecin_prescripteur": "Médecin ayant prescrit la radio",
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
              "acte": "Désignation EXACTE (ex: Échographie abdominale, Radio thorax face, Scanner cérébral)",
              "code_acte": "Code CNAM si visible (ex: RAD010260)",
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
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
            {
              "type": "PHARMACIE",
              "date": "...",
              "pharmacie": "...",
              "matricule_fiscale": "...",
              "code_cnam_pharmacien": "Référence CNAM du pharmacien (ex: 1/25495/81) — JAMAIS dans numero_cnam du patient",
              "medecin_prescripteur": "Nom du prescripteur si l'ordonnance correspondante est présente",
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
              "details_lignes": [
                {
                  "medicament": "Nom EXACT du médicament — lire depuis la VIGNETTE collée (priorité) ou depuis la ligne imprimée du ticket. Ex: DOLIPRANE 1000MG, AUGMENTIN 1G, VOLTARENE 75MG",
                  "code_amm": "Code PCT / Code AMM — lire depuis la COLONNE 'Code PCT' du ticket, sur la MÊME LIGNE que ce médicament. Ne JAMAIS prendre le code d'une autre ligne.",
                  "forme": "Forme galénique si la colonne existe (GOUTTE, COLLYR, COMPRI, SOL EXT...)",
                  "quantite": "Quantité achetée (ex: 1, 2, 3). Lire sur la ligne du ticket.",
                  "prix_unitaire": "Prix unitaire TTC / PUV",
                  "total_ligne": "Prix total de cette ligne (Mt. Percu, ou quantite × prix_unitaire)"
                }
              ],
              "nombre_lignes_ticket": "Nombre de lignes réellement visibles sur le ticket — doit être égal à la taille de details_lignes",
              "montant": "TOTAL du ticket/facture pharmacie (doit = somme de tous les total_ligne)",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
           {
              "type": "LABORATOIRE",
              "date": "Date de l'analyse",
              "laboratoire": "Nom complet du labo",
              "matricule_fiscale": "MF du laboratoire",
              "medecin_prescripteur": "Nom du médecin",
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
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
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
            {
              "type": "HOSPITALISATION",
              "clinique": "Nom de la clinique/hopital",
              "matricule_fiscale": "MF de la clinique",
              "code_etablissement": "Code établissement / code clinique si visible sur le BS ou la facture",
              "numero_facture": "N° de la facture de l'établissement",
              "numero_dossier": "N° de dossier de l'établissement (ex: DOS2607942)",
              "chambre": "Chambre / lit (ex: CHAMBRE 126 Lit : 126)",
              "date_entree": "Date d'entree (JJ/MM/AAAA)",
              "date_sortie": "Date de sortie (JJ/MM/AAAA)",
              "date_acte": "Date de l'intervention si distincte des dates de séjour",
              "nombre_nuitees": "Nombre de nuitees (date_sortie - date_entree). Ex: entree 17/07 sortie 18/07 = 1 nuitee",
              "motif": "Motif d'hospitalisation (Accouchement par césarienne, chirurgie, etc.)",
              "voie_accouchement": "cesarienne | voie_basse | '' — UNIQUEMENT si le motif est un accouchement",
              "patient_concerne": "adherent | conjoint | enfant",
              "sejour": {
                "lignes": [
                  {"prestation": "CHAMBRE SIMPLE / CHAMBRE INDIVIDUELLE / LIT / HEBERGEMENT / NUITEE / ACCOMPAGNANT", "date": "", "quantite": "", "prix_unitaire": "", "tva": "", "montant_ht": "", "montant": "", "montant_pec": "", "montant_patient": ""}
                ],
                "total": "Somme des lignes sejour (SANS aucun ajustement)"
              },
              "bloc_operatoire": {
                "lignes": [
                  {"prestation": "BLOC OPERATOIRE / SALLE D'OPERATION / SALLE DE REVEIL / REANIMATION / APPAREILLAGES / OXYGENE / Acte : <CODE> (KC nn)", "date": "", "quantite": "", "prix_unitaire": "", "tva": "", "montant_ht": "", "montant": "", "montant_pec": "", "montant_patient": "", "code_acte": "", "lettre_cle": "", "cotation": ""}
                ],
                "total": "Somme des lignes bloc operatoire (SANS aucun ajustement)"
              },
              "pharmacie_interne": {
                "lignes": [
                  {"prestation": "Nom EXACT du médicament/consommable/dispositif (ex: Sevoflurane, Oxytocine 5 unités/mL, Compresse stérile)", "date": "", "quantite": "", "prix_unitaire": "", "tva": "", "montant_ht": "", "montant": "", "nature": "MEDICAMENT | DISPOSITIF_MEDICAL | CONSOMMABLE_UU | HOTELIER", "patient_concerne": "adherent | nouveau_ne"}
                ],
                "total": "Somme des lignes pharmacie interne (SANS aucun ajustement)",
                "total_medicaments": "Somme des lignes nature = MEDICAMENT",
                "total_dispositifs": "Somme des lignes nature = DISPOSITIF_MEDICAL",
                "total_consommables": "Somme des lignes nature = CONSOMMABLE_UU",
                "total_hotelier": "Somme des lignes nature = HOTELIER",
                "nombre_lignes_annexe": "Nombre de lignes imprimées sur l'annexe — doit égaler la taille de lignes[]",
                "source_detail": "detail_annexe | lignes_groupees — indiquer d'où vient le détail"
              },
              "autres_frais": {
                "lignes": [
                  {"prestation": "FRAIS DE DOSSIER INTERNE / BLOUSE / BRACELET / TIMBRE / EXTRAS / GLYCEMIE AU DOIGT (GAD)", "date": "", "quantite": "", "prix_unitaire": "", "tva": "", "montant_ht": "", "montant": "", "montant_pec": "", "montant_patient": ""}
                ],
                "total": "Somme des lignes autres frais (SANS aucun ajustement)"
              },
              "total_clinique_calcule": "sejour.total + bloc_operatoire.total + pharmacie_interne.total + autres_frais.total (hors ajustements)",
              "total_clinique_facture": "La ligne 'Total Clinique' de la GRILLE de la facture, colonne T.T.C, AVANT le timbre fiscal. NE PAS prendre 'Total Clinique T.T.C.' du RÉCAPITULATIF de la dernière page, qui inclut le timbre. VÉRIFICATION : total_clinique_calcule + ecart_ajustements doit être EXACTEMENT égal à cette valeur ; sinon la mauvaise ligne a été lue.",
              "intervention_id": "Identifiant de chaînage de l'intervention principale de ce séjour (ex: INT-1)",
              "cout_total_intervention": "Somme de TOUS les postes portant le même intervention_id (clinique + praticiens). INDICATEUR d'affichage uniquement, JAMAIS une base de remboursement.",
              "vue_recommandee": "groupee | detaillee — 'groupee' si forfait = true (accouchement voie basse, acte au forfait), 'detaillee' sinon (césarienne, chirurgie cotée)",
              "ecart_ajustements": "total_clinique_facture - total_clinique_calcule (somme des lignes AJUSTEMENT écartées)",
              "total_clinique": "Alias de total_clinique_calcule — conservé pour compatibilité avec l'existant",
              "total_acte_cote": "Somme des montants de TOUTES les lignes classees acte_cote (prestataires du compte d'autrui et notes d'honoraires promus en actes independants). C'est un CONTROLE : il doit etre egal a la somme des montants des actes portant rattachement_hospitalisation vers cette hospitalisation. Ne JAMAIS renvoyer 0 s'il existe au moins un acte promu.",
              "recapitulatif_facture": {
                "total_clinique_ht": "",
                "total_tva": "",
                "timbre_fiscal": "",
                "total_pec_organisme": "Total colonne P.E.C TTC (part CNAM / convention)",
                "reste_a_charge_patient": "Total colonne Patient TTC",
                "total_compte_autrui": "Total TTC du compte d'autrui",
                "total_facture_ttc": "Total T.T.C imprimé",
                "acompte": "Acompte / avance versée (valeur absolue, sans le signe -)",
                "net_a_payer": "Net à payer imprimé"
              },
              "montant": "Total general de la facture (clinique + compte d'autrui + timbre)",
              "lettre_cle": "KC/KE si visible (depuis lettre confidentielle, BS, ou ligne 'Acte : <CODE> (KC nn)')",
              "cotation": "Nombre après la lettre-clé si visible",
              "forfait": "true si accouchement voie basse ou acte au forfait, false sinon",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — décompte > décision chiffrée > colonne P.E.C. JAMAIS depuis un relevé d'assureur privé.",
              "accord_prealable": false,
              "accord_prealable_details": {
                "code_intervention": "Code CNAM de l'intervention (ex: MGE000070) — depuis la décision de prise en charge",
                "forfait_cnam": "Montant du forfait CNAM accordé (ex: 2135). '' si la décision ne porte AUCUN montant.",
                "numero_decision": "N° de la décision, normalisé JJ format 'nn/aaaa/nnnn' (ex: 86/2026/7986)",
                "date_decision": "Date de la décision (JJ/MM/AAAA)",
                "date_depot_demande": "Date de dépôt de la demande (JJ/MM/AAAA)",
                "centre_regional": "Centre régional CNAM (ex: SALAMBO)",
                "code_convention": "Nombre entre parenthèses du titre de la décision (ex: 60)",
                "objet": "Objet de la prise en charge (ex: HOSPITALISATION POUR ACCOUCHEMENT)",
                "qualite_assure": "Qualité de l'assuré (ex: Assuré lui même)",
                "assure_numero": "N° d'assuré CNAM figurant sur la décision",
                "identifiant_unique": "Identifiant unique figurant sur la décision",
                "validite_jours": "Durée de validité (ex: 45)"
              },
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
            {
              "type": "DENTAIRE",
              "date": "Date de l'acte",
              "praticien": "Nom du dentiste",
              "matricule_fiscale": "MF du dentiste",
              "patient_concerne": "adherent | conjoint | enfant",
              "type_soin_dentaire": "DC pour SOINS DENTAIRES (partie haute du formulaire), DP pour PROTHESE DENTAIRE (partie basse)",
              "dents": "Numéros des dents traitées (ex: 11, 21, 36)",
              "acte": "Désignation EXACTE (ex: Détartrage, Extraction, Prothèse dentaire)",
              "lettre_cle": "D",
              "cotation": "Nombre après la lettre-clé (ex: 40 pour D40)",
              "montant": "Honoraires",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
            {
              "type": "OPTIQUE",
              "date": "Date de l'acte",
              "praticien": "Nom de l'opticien/lunettier",
              "matricule_fiscale": "MF de l'opticien",
              "patient_concerne": "adherent | conjoint | enfant",
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
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
            },
            {
              "type": "PARAMEDICAL",
              "date": "Date de l'acte",
              "praticien": "Nom du praticien paramédical (kiné, sage-femme, infirmier)",
              "matricule_fiscale": "MF du praticien",
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
              "acte": "Désignation EXACTE (ex: Rééducation fonctionnelle du genou, Kinésithérapie respiratoire, Séance de rééducation, Soins infirmiers)",
              "nombre_seances_prescrites": "Nombre de séances prescrites sur l'ordonnance (si visible)",
              "nombre_seances_realisees": "Nombre de séances réalisées / facturées (si visible)",
              "lettre_cle": "SC ou SF ou AMO ou AMI ou AMS ou TO ou TM ou APR si visible",
              "cotation": "Nombre après la lettre-clé",
              "montant": "Honoraires",
              "montant_cnam": "Montant REMBOURSÉ par CNAM — depuis décompte CNAM ou décision prise en charge. JAMAIS depuis facture.",
              "accord_prealable": false,
              "confiance": "haute | moyenne | faible",
              "observations": ""
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
          "releve_assureur": {
            "assureur": "STAR | CARTE | BH | GAT | autre — l'émetteur du relevé",
            "contrat_n": "",
            "societe": "",
            "matricule_adherent": "",
            "nom_adherent": "",
            "nom_malade": "",
            "bulletin_n": "",
            "date_soins": "JJ/MM/AAAA",
            "date_emission": "JJ/MM/AAAA",
            "bordereau_n": "",
            "lignes": [
              {
                "rubrique": "Code rubrique (ex: FAN, JHC, K, PH, SO)",
                "libelle": "Libellé de la rubrique (ex: FRAIS.ANESTHESIE, HOSPITALISATION ET CLINIQUE)",
                "observations": "Observations de la ligne (ex: plafond annuel atteint)",
                "depenses": "",
                "base_cotation": "",
                "remboursement": ""
              }
            ],
            "total_depenses": "",
            "total_remboursement": "",
            "net_a_regler": "",
            "note": "Document de CONTRÔLE uniquement — n'alimente ni 'montant' ni 'montant_cnam'."
          },
          "pieces_justificatives": [
            {
              "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | NOTE_HONORAIRES | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | PRISE_EN_CHARGE | RELEVE_ASSUREUR | CERTIFICAT_MEDICAL | AUTRE",
              "rattachement_acte": 0,
              "praticien": "Nom du médecin/prescripteur",
              "etablissement": "Nom de l'établissement émetteur si applicable",
              "date": "Date du document (JJ/MM/AAAA)",
              "patient_concerne": "adherent | conjoint | enfant | nouveau_ne",
              "contenu": {
                "medicaments_prescrits": [
                  {
                    "nom": "Nom du médicament",
                    "posologie": "Posologie prescrite",
                    "duree": "Durée du traitement",
                    "quantite": "Quantité prescrite",
                    "voie": "Voie d'administration si précisée (orale, sous-cutanée, rectale...)"
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
                "texte_libre": "Contenu textuel pour COMPTE_RENDU, PRISE_EN_CHARGE, CERTIFICAT_MEDICAL, RELEVE_ASSUREUR ou AUTRE (resume fidele). Pour PRISE_EN_CHARGE, y reporter le code d'intervention, le forfait accorde, le numero et la date de decision — ces memes valeurs alimentent accord_prealable_details de l'acte rattache.",
                "note_honoraires": {
                  "numero_note": "Numéro imprimé de la note (ex: 157738)",
                  "praticien": "Nom du docteur inscrit en haut",
                  "patient": "Nom du patient inscrit",
                  "role_coche": "Médecin | Chirurgien | Aide opératoire | '' — la ligne COCHÉE, ENTOURÉE ou SOULIGNÉE du formulaire",
                  "role_deduit_cachet": "Rôle déduit de la spécialité du cachet si aucune ligne n'est marquée",
                  "specialite_cachet": "Spécialité lue sur le cachet (ex: Médecin Anesthésiste Réanimateur)",
                  "matricule_fiscale": "MF lue sur le cachet",
                  "total": "Montant total manuscrit"
                },
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
                  "code_cnam_etablissement": "Code CNAM de l'établissement si visible (ex: 02/00002282-51)",
                  "convention": "Intitulé de la convention P.E.C (ex: CNAM Chirurgie SALAMBO)",
                  "periode_hospitalisation": "du JJ/MM/AAAA au JJ/MM/AAAA",
                  "lignes_clinique": [
                    {
                      "section": "Frais | Séjour | Acte/Interventions | Pharmacie Interne | Prestations | Fluides médicaux",
                      "designation": "Désignation EXACTE de la prestation (ex: FRAIS DE DOSSIER INTERNE, CHAMBRE SIMPLE, Acte : MJC030040 (KC 100))",
                      "quantite": "Quantité",
                      "prix_unitaire": "Prix unitaire",
                      "montant_pec": "Colonne P.E.C",
                      "montant_patient": "Colonne Patient",
                      "tva_pourcent": "Taux TVA (ex: 7%, 19%, 0%)",
                      "montant_ht": "Montant HT",
                      "montant_tva": "Montant TVA",
                      "montant_ttc": "Montant TTC"
                    }
                  ],
                  "lignes_ajustement_ignorees": "Nombre de lignes AJUSTEMENT volontairement écartées, et leur somme (pour traçabilité)",
                  "total_clinique_ht": "Total HT des frais clinique",
                  "total_clinique_tva": "Total TVA des frais clinique",
                  "total_clinique_ttc": "Total TTC des frais clinique",
                  "compte_autrui": [
                    {
                      "nom_prestataire": "Nom du prestataire externe",
                      "matricule_fiscale": "MF du prestataire",
                      "specialite": "Spécialité entre parenthèses si présente (GYN, PED...)",
                      "nature_acte": "Nature de l'acte (Actes, Honoraires Aide Opératoire, Visite, Laboratoire...)",
                      "non_percu": "true si la ligne porte N.P.",
                      "montant_ht": "Montant HT",
                      "montant_tva": "Montant TVA",
                      "montant_ttc": "Montant TTC"
                    }
                  ],
                  "total_compte_autrui": "Total TTC compte d'autrui",
                  "timbre_fiscal": "Montant du timbre fiscal",
                  "total_facture_ttc": "Total TTC de la facture (clinique + compte d'autrui + timbre)",
                  "avance": "Avance / acompte versé par le patient (si visible)",
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
            "total_pharmacie": "Somme pharmacie (officines de ville uniquement) ou 0",
            "total_laboratoire": "Total labo ou 0",
            "total_hospitalisation": "total_clinique_calcule + timbre_fiscal UNIQUEMENT, ou 0. 🚫 NE JAMAIS utiliser le total de la facture : les prestataires du compte d'autrui sont DÉJÀ comptés dans total_medecin / total_laboratoire / total_radiologie. Les additionner ici crée un DOUBLE COMPTAGE. CONTRÔLE : somme des actes portant rattachement_hospitalisation = total_compte_autrui imprimé + somme des honoraires réglés en direct (notes d'honoraires et lignes N.P.). Si l'égalité ne tombe pas, consigner dans controles.anomalies au lieu d'ajuster un montant.",
            "total_dentaire": "Total actes dentaires ou 0",
            "total_optique": "Total actes optique ou 0",
            "total_paramedical": "Total actes paramédicaux ou 0",
            "total_global_calcule": "La somme de tout le dossier, chaque montant compté UNE SEULE FOIS",
            "total_cnam": "Total remboursé par la CNAM (depuis le décompte CNAM si présent, sinon 0)",
            "total_nouveau_ne": "Somme des actes portant patient_concerne = nouveau_ne, ou 0",
            "devise": "DT"
          },
          "reglement": {
            "depense_totale": "facture(s) clinique TTC + honoraires hors facture (notes d'honoraires, lignes N.P.) + pharmacies de ville + actes ambulatoires. TOUT ce qui est sorti de la poche de l'adhérent ou facturé pour son compte.",
            "detail_depense": {
              "facture_clinique_ttc": "",
              "honoraires_hors_facture": "Somme des notes d'honoraires réglées en direct et des lignes N.P.",
              "pharmacies_ville": "",
              "autres_actes": ""
            },
            "pec_cnam": "Part CNAM. Priorité : décompte CNAM > décision de prise en charge chiffrée > colonne P.E.C de la facture. '' si aucune.",
            "source_pec_cnam": "decompte | decision | colonne_pec | aucune",
            "remboursement_assureur": "Net à régler du relevé d'assureur, s'il existe. '' sinon.",
            "assureur_emetteur": "Nom de l'assureur ayant émis le relevé",
            "avance_patient": "Acompte(s) versé(s) à l'établissement, valeur absolue",
            "regle_directement_praticiens": "Somme versée en direct aux praticiens (lignes N.P. et notes d'honoraires)",
            "reste_a_charge": "depense_totale − pec_cnam − remboursement_assureur",
            "verification_tresorerie": "avance_patient + net_a_payer + regle_directement_praticiens + pharmacies_ville = ce que l'adhérent a réellement décaissé. Comparer à reste_a_charge + remboursement_assureur.",
            "note": "Aucun taux ni plafond n'est appliqué ici. Le barème dépend du contrat et sera appliqué en aval."
          },
          "controles": {
            "ecart_total_clinique": "total_clinique_facture - total_clinique_calcule (= somme des ajustements écartés)",
            "ecart_compte_autrui": "total_compte_autrui imprimé - somme des actes promus (les lignes N.P. expliquent souvent l'écart)",
            "ecart_pharmacie": "Écarts entre la somme des details_lignes et le total imprimé de chaque ticket",
            "ecart_pharmacie_interne": "Écart entre le détail annexe et les lignes groupées de la facture",
            "equipe_chirurgicale_complete": "true | false — false si anesthésiste ou aide opératoire manquant sur une intervention",
            "roles_manquants": ["Liste des rôles attendus non retrouvés"],
            "actes_sans_justificatif": ["Liste des actes n'ayant aucune pièce justificative rattachée"],
            "doublons_potentiels": ["Description des doublons suspectés, sans fusion arbitraire"],
            "incoherences_dates": ["Dates hors séjour, facture antérieure à la sortie, etc."],
            "documents_ignores": ["BS vierges, bulletins d'autres adhérents, pages blanches"],
            "cotation_chirurgien_propagee": "true | false — false si un acte 'Chirurgien' reste sans code_acte/cotation alors qu'un code d'intervention existe dans le dossier (DÉFAUT BLOQUANT)",
            "montants_issus_du_releve_rejetes": ["Montants qui n'avaient pour seule source qu'un relevé d'assureur et qui ont été remis à vide (règle 7b)"],
            "double_prise_en_charge": ["R1 — postes couverts à la fois par la P.E.C CNAM et par le relevé assureur"],
            "lignes_assureur_non_rapprochees": ["R2 — lignes du relevé sans acte ou ligne de facture correspondante"],
            "actes_non_soumis_assureur": ["R3 — actes du dossier absents du relevé assureur"],
            "ecart_releve_assureur": "R4 — total_depenses du relevé vs somme des dépenses extraites, avec les postes qui expliquent l'écart",
            "ecart_total_facture": "C14 — écart entre la grille (page 1) et le récapitulatif (dernière page), avec sa cause probable",
            "correspondance_montant_bs": "C13 — à quoi correspond le 'Montant des frais' de la case établissement du BS (total facture ou reste à charge patient)",
            "notes_cotation": ["C12 — écarts informatifs entre cotation facturée et cotation de la nomenclature"],
            "anomalies": ["Toute autre anomalie détectée"]
          },
          "observations_globales": "Synthèse en texte libre des points d'attention pour le gestionnaire (plafonds atteints signalés par un relevé, montants à confirmer, illisibilités bloquantes, présence d'un nouveau-né, postes non remboursables comme l'accompagnant...)"
        }

RÈGLES COMPLÉMENTAIRES :
- beneficiaire_coche : case cochée (✓/✗/remplie) → "Adhérent"/"Conjoint"/"Enfant". Défaut: "Adhérent".
- conjoint.nom_prenom : UNIQUEMENT si case "Conjoint" cochée.
- enfants : UNIQUEMENT si case "Enfant" cochée, sinon [].
- mode_paiement : mention "Tiers Payant" → "tiers_payant", sinon "remboursement". Incertain → "".
- cachet_employeur / signature_presente : true si visible sur le bulletin, false si absent.
  ATTENTION : la signature de l'assuré est souvent en BAS À DROITE du recto du BS (champ "SIGNATURE DE L'ASSURÉ" / "Signature de l'adhérent"). C'est un griffonnage manuscrit — ne pas le confondre avec du texte. Si TOUT trait manuscrit ressemblant à une signature est visible → true.
  Le cachet employeur est un TAMPON (rond ou rectangulaire) de l'entreprise, souvent au VERSO du BS.
- apci : DÉTECTER via 3 sources possibles :
  1) CHECKBOX "APCI" sur le BS (en haut de la face professionnelle, champ "Soins effectués dans le cadre de : APCI"). Si coché → apci.
  2) CERTIFICAT MÉDICAL CONFIDENTIEL mentionnant une pathologie chronique (cancer, diabète, insuffisance rénale, etc.) → extraire pathologie dans apci.pathologies.
  3) DÉCOMPTE CNAM avec "Régime: APCI" ou "ALD" → apci.
  Si aucune de ces 3 sources → ne pas inclure apci.
- conventionne : si mention "conventionné"/"hors convention" visible → "oui"/"non". Sinon "".
  Une DÉCISION DE PRISE EN CHARGE mentionnant "clinique privée conventionnée" ou
  "valable qu'auprès des médecins et cliniques conventionnées" → conventionne = "oui"
  pour l'hospitalisation concernée.
- nombre_seances : PARAMEDICAL → extraire séances prescrites (ordonnance) et réalisées (facture). Si non visible → "".
- cnam : UNIQUEMENT si décompte CNAM présent. Sinon ne pas inclure.
- releve_assureur : UNIQUEMENT si un relevé d'assureur privé est présent. Sinon ne pas inclure.
- pieces_justificatives : UNIQUEMENT sous-clés pertinentes au type (medicaments_prescrits pour ORDONNANCE, resultats_bilan pour BILAN, lettre_confidentielle pour LETTRE_CONFIDENTIELLE, note_honoraires pour NOTE_HONORAIRES, facture_details pour FACTURE clinique, texte_libre pour COMPTE_RENDU/PRISE_EN_CHARGE/CERTIFICAT_MEDICAL/RELEVE_ASSUREUR/AUTRE).
- numero_adherent ≠ numero_contrat ≠ numero_cnam : 3 champs DISTINCTS. Ne pas confondre. 'Adhésion N°' = numero_adherent. Le numéro en face du label 'Adhésion N°' est TOUJOURS le numero_adherent, quelle que soit sa taille.
- Si aucun champ "Contrat N°" explicite → numero_contrat = "".
- numero_cnam : format long (ex: 1688627809, 16536247). Si BS assureur sans champ CNAM visible → "". Une décision CNAM ("Identifiant Unique") est une source valable et plus fiable qu'un manuscrit illisible.
- CODE CNAM DU PRESTATAIRE ≠ CODE CNAM DU PATIENT : sur le BS, chaque section a un champ "Code CNAM et MF du professionnel de santé" (ex: 1/12896/11). C'est le code du PRATICIEN, PAS du patient. NE JAMAIS le mettre dans numero_cnam. De même sur les tickets pharmacie, "Référence CNAM du pharmacien: 1/xxxxx/xx" est le code du PHARMACIEN.
- HOSPITALISATION SECTIONS : répartir lignes dans sejour/bloc_operatoire/pharmacie_interne/autres_frais. Chaque section a lignes[] + total. AUCUNE ligne AJUSTEMENT.
- HOSPITALISATION COMPTE D'AUTRUI → ACTES SÉPARÉS : chaque prestataire externe → acte indépendant avec rattachement_hospitalisation (0-based) et role_intervention. Clinique garde UNIQUEMENT ses sections groupées, SANS le compte_autrui.
- HOSPITALISATION ACCORD PRÉALABLE : si décision de prise en charge → accord_prealable: true + accord_prealable_details (même si le forfait est vide).
- DENTAIRE : type_soin_dentaire = "DC" (soins) ou "DP" (prothèse). Lettre-clé = D.
- OPTIQUE : type "OPTIQUE" (JAMAIS "PARAMEDICAL"). Séparer monture/verres dans details_lignes + prescription_optique.
- COMPTE-RENDU = PIÈCE + ACTE : générer l'acte correspondant (RADIOLOGIE/MEDECIN/LABORATOIRE). GARDE-FOU ANTI-DOUBLON : si acte existe déjà → rattacher via rattachement_acte, NE PAS dupliquer.
- NOTE D'HONORAIRES = PIÈCE + ACTE : générer l'acte promu correspondant avec role_intervention. GARDE-FOU ANTI-DOUBLON : si le praticien figure DÉJÀ dans le compte d'autrui de la facture avec le MÊME montant → ne pas dupliquer, enrichir l'acte existant (role_intervention, numero_note, MF). Si les montants DIFFÈRENT → un seul acte, details_lignes avec les 2 sources, et observation "montant à confirmer".
- ÉCART COTATION : lettre confidentielle ≠ BS → retenir lettre confidentielle + signaler dans observations.
- Noms tunisiens : "nekk"→"Mekki", "nohaned"→"Mohamed". Réparer aussi depuis les cachets imprimés et les factures (le cachet imprimé prime sur le manuscrit du BS).
- matricule_fiscale : format COMPLET avec les slashs : 7 chiffres + "/" + lettre + "/A/" + lettre + "/000" (ex: 1538875N/A/P/000, 1671890K/A/M/000, 1277507N/A/P/000). TOUJOURS inclure les slashs et le suffixe "/000". Si partiel (manque les slashs ou le /000) → compléter depuis le cachet ou la facture (la facture clinique liste souvent les MF complets des praticiens du compte d'autrui : s'en servir pour corriger une lecture partielle du BS). Si introuvable → "".
- CONTRÔLE FINAL : total_acte_cote + total_clinique_calcule + ecart_ajustements ≈ montant facture (± TVA/timbre). Écart inexpliqué > 1 DT → re-vérifier puis consigner dans controles.anomalies.
- NE JAMAIS écrire 0 ou 0.000 à la place d'une donnée inconnue. Inconnu = "".
Si champ introuvable → "". Pas de balises Markdown.`;

// ─────────────────────────────────────────────
// PROMPTS CONSTRUITS À PARTIR DE PROMPT_BASE
// ─────────────────────────────────────────────
export const PROMPT = `Analyse ces images d'un bulletin de soins d'assurance maladie tunisien.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien.
Identifie l'assureur via le logo, l'en-tête, la mise en page ou toute mention visible.
Extrais avec précision TOUTES les informations visibles.
${PROMPT_BASE}`;

export const PROMPT_DOSSIER = `Tu reçois plusieurs images du MÊME dossier médical d'un adhérent d'assurance maladie en Tunisie.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien.
Ces images peuvent inclure : bulletin de soins, reçus, ordonnances, analyses, factures, notes d'honoraires, décompte CNAM, relevé d'assureur, comptes-rendus, décisions de prise en charge, lettres confidentielles, détails de facture, etc.
Tu dois COMBINER toutes ces images pour produire UN SEUL dossier structuré et complet.
${PROMPT_BASE}
IMPORTANT : le BS est le document PRINCIPAL. Les autres documents sont des PIÈCES JUSTIFICATIVES. Suivre les étapes ci-dessous dans l'ORDRE.

ÉTAPE 0 — TRIER LE LOT (NOUVEAU, OBLIGATOIRE) :
   a) Classe chaque image et repère les pages à ÉCARTER :
      - pages BLANCHES ou quasi vides
      - BS VIERGES (formulaire non rempli, conditions générales, planche dentaire seule)
      - BS d'un AUTRE ADHÉRENT
      - doublons de scan
   b) Identifie le nom du malade dominant (celui qui revient sur les factures,
      notes d'honoraires, ordonnances, décision CNAM).
   c) Retiens le SEUL BS renseigné correspondant à ce nom. Les autres sont écartés
      et listés dans controles.documents_ignores.
   d) L'assureur du dossier = celui du BS retenu, PAS celui d'un formulaire vierge.

ÉTAPE 1 — IDENTIFIER : Classe chaque image restante (bulletin de soins, ordonnance, reçu, facture, note d'honoraires, bilan, compte-rendu, lettre confidentielle, décision de prise en charge, décompte CNAM, relevé assureur, ticket pharmacie, détail facture, certificat médical...).

ÉTAPE 2 — LIRE LE BS EXHAUSTIVEMENT :
   Le BS est le DOCUMENT MAÎTRE. Lire les 2 faces :
   a) FACE PATIENT : nom, numéro adhérent (Adhésion N° / Matricule adhérent), employeur, BS N°, date, bénéficiaire, APCI, signature, matricule CNAM.
   b) FACE PROFESSIONNEL : lire CHAQUE SECTION une par une (Consultations, Actes Médicaux, Biologie, Hospitalisation, Pharmacie, Dentaire, Paramédicaux) OU, sur les BS à zone unique (STAR/CARTE), CHAQUE LIGNE de la zone "Réservé aux médecins et praticiens".
      Pour chaque ligne remplie → créer l'acte correspondant avec : date, désignation, code acte, cotation, honoraires, cachet praticien (nom + MF + spécialité).
      Décoder les abréviations manuscrites (ANES, ACC, CES, AIDE, PED, GYN, CS).
   c) Ne rien oublier : si le BS mentionne un acte, il DOIT apparaître dans actes_independants.

ÉTAPE 3 — LIRE CHAQUE FICHIER JUSTIFICATIF :
   Pour chaque document (facture, détail facture, ticket, ordonnance, note d'honoraires, lettre confidentielle, décision CNAM, relevé assureur, compte-rendu...) :
   a) Extraire TOUTES les informations : montants, détails lignes, praticien, MF, codes, dates.
   b) PHARMACIE : lire CHAQUE LIGNE du ticket (tous les médicaments, vignettes, codes PCT, quantités, prix). Compter les lignes.
   c) FACTURE CLINIQUE : lire chaque ligne avec sa section, ses colonnes P.E.C / Patient / HT / TVA / TTC. ÉCARTER toutes les lignes "AJUSTEMENT" (les compter pour ecart_ajustements).
   d) DÉTAIL FACTURE / PHARMACIE INTERNE : extraire chaque produit ligne par ligne. Repérer les pages "Détail <NOM>" qui concernent le NOUVEAU-NÉ.
   e) NOTE D'HONORAIRES : numéro, praticien, patient, LIGNE COCHÉE (rôle), spécialité du cachet, MF, total manuscrit.
   f) LETTRE CONFIDENTIELLE : extraire codification CNAM (lettre-clé, coefficient), motif complet, acte réalisé.
   g) DÉCISION DE PRISE EN CHARGE : code_intervention, forfait_cnam (SEULEMENT s'il est écrit), numéro/date décision, objet, validité, identifiant unique.
   h) RELEVÉ ASSUREUR : extraire pour CONTRÔLE uniquement. Ne jamais alimenter montant / montant_cnam.

ÉTAPE 4 — CROISER BS ↔ FICHIERS (ENRICHISSEMENT) :
   Pour CHAQUE acte du BS, chercher dans les fichiers les informations COMPLÉMENTAIRES :
   a) MATCHING : associer un fichier à un acte par TYPE + PRATICIEN + DATE + MONTANT (+ MF).
   b) Enrichir chaque acte :
      - Facture/Reçu → montant exact, MF, details_lignes, P.E.C/Patient
      - Note d'honoraires → role_intervention, montant, MF, numéro de note
      - Ordonnance → médecin prescripteur, médicaments prescrits
      - Lettre confidentielle → lettre_cle, cotation (PRIME sur le BS)
      - Décision CNAM → code_intervention, forfait_cnam, accord_prealable, identité CNAM
      - Compte-rendu → détails de l'examen
   c) Si un code (RAD010260, MJC030040) apparaît sur la décision ou la facture mais PAS sur le BS → le reporter sur l'acte.
   d) Si une MF ou lettre-clé apparaît sur un fichier mais PAS sur le BS → la reporter.
   e) AUCUN CHAMP NE DOIT RESTER VIDE si l'information existe dans un AUTRE document.
   f) INTERDIT — DÉCISION CNAM → "montant" : le montant d'une décision de prise en charge CNAM va UNIQUEMENT dans forfait_cnam et montant_cnam. JAMAIS dans "montant".
   g) INTERDIT — RELEVÉ ASSUREUR → "montant" ou "montant_cnam". Contrôle uniquement.

ÉTAPE 5 — RECONSTITUER L'ÉQUIPE CHIRURGICALE (NOUVEAU) :
   Si une intervention est détectée (césarienne, chirurgie, endoscopie sous AG) :
   a) Lister tous les intervenants attendus : chirurgien/gynécologue, anesthésiste, aide opératoire, instrumentiste.
   b) Créer un acte promu par intervenant, avec role_intervention et lettre_cle déduite du rôle.
   c) Les lignes "N.P." donnent un acte avec non_percu = true ; chercher le montant sur la note d'honoraires correspondante.
   d) Le BLOC OPÉRATOIRE reste dans l'hospitalisation (section bloc_operatoire), jamais promu.
   e) Si un rôle attendu est introuvable → le consigner dans controles.roles_manquants. NE PAS l'inventer.
   f) Accouchement : césarienne → KC + cotation ; voie basse → forfait sans KC.
   g) Séparer les actes du NOUVEAU-NÉ (pédiatre, vaccin, ordonnance "Bébé de Mme X") avec patient_concerne = "nouveau_ne".
   h) PROPAGER le code d'intervention (lettre confidentielle > ligne "Acte : <CODE>" de
      la facture > décision de prise en charge > BS) vers l'acte du CHIRURGIEN :
      code_acte + lettre_cle + cotation. C'est une COPIE, pas un déplacement.
      Un chirurgien sans cotation alors qu'un code existe = DÉFAUT BLOQUANT.
   i) CHAÎNER tous les postes de l'intervention avec le même "intervention_id" et
      attribuer à chacun sa "rubrique_proposee" (K / FAN / SO / JHC / PH / CS).
      La ligne "Acte : <CODE>" de la clinique est en "SO", PAS en "K" :
      son montant reste à la clinique, seule son identification va au chirurgien.
   j) NE JAMAIS additionner les postes de l'intervention en un montant unique.
      Renseigner cout_total_intervention comme INDICATEUR, et vue_recommandee.

ÉTAPE 6 — CROISER CNAM :
   Si un décompte CNAM est présent → pour chaque acte, chercher la ligne CNAM correspondante.
   montant_cnam = montant REMBOURSÉ du décompte (colonne "Mnt Remb"). Priorité sur le forfait de la décision.
   Si pas de décompte et décision non chiffrée → utiliser la colonne P.E.C de la facture, en le signalant.
   RAPPEL : ne JAMAIS toucher "montant" dans cette étape.

ÉTAPE 7 — PIÈCES JUSTIFICATIVES :
   Extraire chaque document dans "pieces_justificatives" avec rattachement_acte.
   Vérifier cohérence ordonnance ↔ pharmacie. Signaler écarts dans observations.

ÉTAPE 8 — VÉRIFICATION FINALE ET CONTRÔLES :
   a) Relire le BS ligne par ligne : chaque acte listé est-il dans actes_independants ?
   b) Chaque médicament du ticket est-il dans details_lignes (compter) ?
   c) Aucune ligne "AJUSTEMENT" n'a-t-elle survécu dans les sections ?
   d) L'équipe chirurgicale est-elle complète ?
   e) Les montants sont-ils cohérents (facture vs BS vs notes d'honoraires vs total) ?
   f) Aucun doublon (un même soin ne doit apparaître qu'UNE fois) ?
   g) Les actes du nouveau-né sont-ils bien séparés ?
   h) Remplir intégralement le bloc "controles" et "observations_globales".
   i) Attribuer un niveau de "confiance" à chaque acte.

ÉTAPE 9 — CHECKLIST BLOQUANTE (à passer AVANT de répondre) :
   Répondre mentalement OUI à chacune de ces questions. Si une réponse est NON,
   corriger AVANT de retourner le JSON.
   1. Chaque acte "Chirurgien" a-t-il code_acte ET cotation renseignés dès qu'un
      code d'intervention existe quelque part dans le dossier ?
   2. total_hospitalisation exclut-il bien le compte d'autrui ?
   3. Aucun montant d'acte ne provient-il uniquement d'un relevé d'assureur ?
   4. Le total de chaque ticket pharmacie vient-il bien de CE ticket ?
   5. total_clinique_calcule + ecart_ajustements = total_clinique_facture (grille) ?
   6. Aucune ligne "AJUSTEMENT" ne subsiste-t-elle dans les sections ?
   7. Chaque poste d'intervention a-t-il intervention_id ET rubrique_proposee ?
   8. Le nombre de lignes de pharmacie interne extraites = nombre imprimé ?
   9. La somme des 4 sous-totaux par nature = pharmacie_interne.total ?
   10. Le nom de l'adhérent vient-il d'une source IMPRIMÉE, pas du manuscrit ?
   11. Tous les montants sont-ils sans séparateur de milliers ?
   12. Chaque pièce porte-t-elle "type_piece" (et non "type") ?
   13. Le bloc "reglement" est-il rempli avec la cascade CNAM puis assureur ?
   14. Une addition naïve de tous les postes donne-t-elle total_global_calcule ?`;
