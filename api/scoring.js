/**
 * BK Matching Scoring Module
 * Max Score = 100 Punkte (Kategorie bereits per Search gefiltert → immer 20)
 */

const DEUTSCH_LEVELS = [
  "keine_bis_geringe_deutschkenntnisse",
  "einfache_deutschkenntnisse",
  "mittlere_deutschkenntnisse",
  "gute_deutschkenntnisse",
  "sehr_gute_bis_fliessende_deutschkenntnisse",
];

// BK-seitige Labels können anders geschrieben sein
const DEUTSCH_LEVEL_NORMALIZE = {
  "keine bis geringe deutschkenntnisse": 0,
  "keine_bis_geringe_deutschkenntnisse": 0,
  "einfache deutschkenntnisse": 1,
  "einfache_deutschkenntnisse": 1,
  "mittlere deutschkenntnisse": 2,
  "mittlere_deutschkenntnisse": 2,
  "gute deutschkenntnisse": 3,
  "gute_deutschkenntnisse": 3,
  "sehr gute bis fließende deutschkenntnisse": 4,
  "sehr gute bis fliessende deutschkenntnisse": 4,
  "sehr_gute_bis_fliessende_deutschkenntnisse": 4,
};

const DISEASE_MAP = {
  mp_demenz: ["Demenz", "Demenz Anfangsstadium", "Demenz Fortgeschritten"],
  mp_harninkontinenz: ["Inkontinenz"],
  mp_stuhlinkontinenz: ["Inkontinenz"],
  mp_querschnitt: ["Querschnittslähmung"],
  mp_suchterkrankung: ["Suchterkrankung"],
  mp_hochansteckend: ["Hochansteckende Krankheiten"],
};

const KRANKHEITEN_WEITERE_MAP = {
  diabetes: ["Diabetes (insulinpflichtig)"],
  parkinson: ["Parkinson"],
  ms: ["Multiple Sklerose (MS)"],
  schlaganfall: ["Schlaganfall"],
  herzerkrankung: ["Herz-Kreislaufprobleme", "Herzinfarkt"],
  copd: ["COPD"],
};

// Geschlechts-Mapping: Deal mp_geschlecht_bk → BK bp_anrede
const GENDER_MAP = {
  weiblich: ["Frau"],
  maennlich: ["Herr"],
};

function getDeutschIndex(value) {
  if (!value) return -1;
  const normalized = value.toLowerCase().trim();
  if (normalized in DEUTSCH_LEVEL_NORMALIZE) {
    return DEUTSCH_LEVEL_NORMALIZE[normalized];
  }
  return -1;
}

function parseCheckboxField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Prüft ob BK nach Geschlecht gefiltert werden soll.
 * Gibt true zurück wenn BK NICHT passt (= ausschließen).
 */
function isGenderExcluded(deal, bk) {
  const requested = deal.mp_geschlecht_bk;
  if (!requested || requested === "egal") return false;

  const allowedAnreden = GENDER_MAP[requested];
  if (!allowedAnreden) return false;

  const bkAnrede = (bk.bp_anrede || "").trim();
  return !allowedAnreden.includes(bkAnrede);
}

/**
 * Berechnet den Match-Score für eine BK gegen einen Deal.
 * Gibt { score, maxScore, details } zurück.
 */
function calculateScore(deal, bk) {
  const details = {};
  let score = 0;

  // 1. Kategorie (20 Punkte) — immer 20, da bereits per Search gefiltert
  details.kategorie = { points: 20, max: 20, match: true };
  score += 20;

  // 2. Deutschkenntnisse (15 Punkte)
  const dealDeutsch = getDeutschIndex(deal.mp_deutschkenntnisse);
  const bkDeutsch = getDeutschIndex(bk.deutschkenntnisse);
  if (dealDeutsch <= 0 || bkDeutsch >= dealDeutsch) {
    details.deutsch = { points: 15, max: 15, match: true };
    score += 15;
  } else {
    details.deutsch = { points: 0, max: 15, match: false };
  }

  // 3. Verfügbarkeit (20 Punkte)
  const dealStart = deal.bp_service_startdate
    ? new Date(deal.bp_service_startdate)
    : null;
  const bkReady = bk.ab_wann_ware_die_bk_einsatzbereit
    ? new Date(bk.ab_wann_ware_die_bk_einsatzbereit)
    : null;
  if (!dealStart || !bkReady || bkReady <= dealStart) {
    details.verfuegbarkeit = { points: 20, max: 20, match: true };
    score += 20;
  } else {
    details.verfuegbarkeit = { points: 0, max: 20, match: false };
  }

  // 4. Krankheitserfahrung (30 Punkte, anteilig)
  const bkErfahrung = parseCheckboxField(bk.erfahrung);
  const requiredDiseases = [];
  const matchedDiseases = [];

  // Einzelfelder prüfen
  for (const [dealProp, bkLabels] of Object.entries(DISEASE_MAP)) {
    if (deal[dealProp] === "ja") {
      requiredDiseases.push(...bkLabels);
      const found = bkLabels.some((label) => bkErfahrung.includes(label));
      if (found) matchedDiseases.push(...bkLabels.filter((l) => bkErfahrung.includes(l)));
    }
  }

  // mp_krankheiten_weitere (Checkbox-Feld)
  const weitereKrankheiten = parseCheckboxField(deal.mp_krankheiten_weitere);
  for (const krankheit of weitereKrankheiten) {
    const bkLabels = KRANKHEITEN_WEITERE_MAP[krankheit];
    if (bkLabels) {
      requiredDiseases.push(...bkLabels);
      const found = bkLabels.some((label) => bkErfahrung.includes(label));
      if (found) matchedDiseases.push(...bkLabels.filter((l) => bkErfahrung.includes(l)));
    }
  }

  // Unique zählen
  const uniqueRequired = [...new Set(requiredDiseases)];
  const uniqueMatched = [...new Set(matchedDiseases)];

  if (uniqueRequired.length === 0) {
    details.krankheiten = { points: 30, max: 30, matched: [], required: [], match: true };
    score += 30;
  } else {
    const krankheitenScore = Math.round(
      (uniqueMatched.length / uniqueRequired.length) * 30
    );
    details.krankheiten = {
      points: krankheitenScore,
      max: 30,
      matched: uniqueMatched,
      required: uniqueRequired,
      match: krankheitenScore === 30,
    };
    score += krankheitenScore;
  }

  // 5. Körpergewicht / Transfer (10 Punkte)
  if (deal.mp_transfer === "nein") {
    details.transfer = { points: 10, max: 10, match: true, reason: "kein Transfer nötig" };
    score += 10;
  } else {
    const dealKg = parseFloat(deal.mp_koerpergewicht) || 0;
    const bkKg =
      parseFloat(bk.transfer__heben__umlagern_ohne_hilfsmittel_bis_kg) || 0;
    if (dealKg === 0 || bkKg >= dealKg) {
      details.transfer = { points: 10, max: 10, match: true };
      score += 10;
    } else {
      details.transfer = { points: 0, max: 10, match: false };
    }
  }

  // 6. Führerschein (5 Punkte)
  if (!deal.mp_fuehrerschein || deal.mp_fuehrerschein === "nein") {
    details.fuehrerschein = { points: 5, max: 5, match: true, reason: "nicht gefordert" };
    score += 5;
  } else {
    const bkFs = (bk.fuhrerschein_bk || "").toLowerCase();
    const hatFuehrerschein =
      bkFs.includes("ja") ||
      bkFs.includes("gültig") ||
      bkFs.includes("automatik");
    if (hatFuehrerschein) {
      details.fuehrerschein = { points: 5, max: 5, match: true };
      score += 5;
    } else {
      details.fuehrerschein = { points: 0, max: 5, match: false };
    }
  }

  return { score, maxScore: 100, details };
}

function getStars(score) {
  if (score >= 90) return 5;
  if (score >= 70) return 4;
  if (score >= 50) return 3;
  if (score >= 30) return 2;
  return 1;
}

module.exports = { calculateScore, getStars, isGenderExcluded, parseCheckboxField };
