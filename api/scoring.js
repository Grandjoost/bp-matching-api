/**
 * BK Matching Scoring Module
 * Max Score = 100 Punkte (Kategorie bereits per Search gefiltert → immer 20)
 *
 * Hard Filter (KO): Geschlecht, Anzahl Pflegebedürftige
 * Scoring: Kategorie(20) + Deutsch(15) + Krankheiten(30) + Pflegeerfahrung(20) + Transfer(10) + Führerschein(5)
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

// Geschlechts-Mapping: Deal mp_geschlecht_bk → BK bp_anrede
const GENDER_MAP = {
  weiblich: ["Frau"],
  maennlich: ["Herr"],
};

// Anzahl Pflegebedürftige: "zwei" > "eine"
const ANZAHL_ORDER = { eine: 1, zwei: 2 };

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
 * Hard Filter: Geschlecht.
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
 * Hard Filter: Anzahl Pflegebedürftige.
 * Gibt true zurück wenn BK NICHT passt (= ausschließen).
 * Deal fordert z.B. "zwei" → BK muss auch "zwei" können.
 */
function isAnzahlExcluded(deal, bk) {
  const dealAnzahl = deal.mp_anzahl_pflegebed;
  if (!dealAnzahl) return false; // nicht angegeben → kein Filter

  const bkAnzahl = bk.bk_anzahl_pflegebedurftige;
  if (!bkAnzahl) return false; // BK hat keine Angabe → nicht ausschließen

  const dealVal = ANZAHL_ORDER[dealAnzahl] || 0;
  const bkVal = ANZAHL_ORDER[bkAnzahl] || 0;

  // BK muss mindestens so viele können wie Deal fordert
  return bkVal < dealVal;
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

  // 3. Krankheitserfahrung (30 Punkte, anteilig)
  // Case-insensitive Vergleich, da interne Werte zwischen Deal und BK abweichen können
  const bkErfahrung = parseCheckboxField(bk.erfahrung);
  const bkErfahrungLower = bkErfahrung.map((e) => e.toLowerCase());
  const requiredDiseases = parseCheckboxField(deal.mp_krankheiten_weitere)
    .filter((d) => d.toLowerCase() !== "sonstige");

  if (requiredDiseases.length === 0) {
    details.krankheiten = { points: 30, max: 30, matched: [], required: [], match: true };
    score += 30;
  } else {
    const matchedDiseases = requiredDiseases.filter((d) =>
      bkErfahrungLower.includes(d.toLowerCase())
    );
    const krankheitenScore = Math.round(
      (matchedDiseases.length / requiredDiseases.length) * 30
    );
    details.krankheiten = {
      points: krankheitenScore,
      max: 30,
      matched: matchedDiseases,
      required: requiredDiseases,
      match: krankheitenScore === 30,
    };
    score += krankheitenScore;
  }

  // 4. Pflegeerfahrung (20 Punkte)
  const dealErfahrung = deal.mp_pflegeerfahrung;
  const bkJahre = parseFloat(bk.pflegeerfahrung_in_jahren_bk) || 0;

  if (!dealErfahrung || dealErfahrung === "grundkenntnisse") {
    // Grundkenntnisse → jede BK passt
    details.pflegeerfahrung = { points: 20, max: 20, match: true };
    score += 20;
  } else if (dealErfahrung === "fortgeschritten" && bkJahre >= 3) {
    details.pflegeerfahrung = { points: 20, max: 20, match: true };
    score += 20;
  } else if (dealErfahrung === "langjaehrig" && bkJahre >= 5) {
    details.pflegeerfahrung = { points: 20, max: 20, match: true };
    score += 20;
  } else {
    details.pflegeerfahrung = { points: 0, max: 20, match: false };
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

/**
 * Hard Filter: Rauchen.
 * "unbedingt Nichtraucher" → BK muss Nichtraucher sein.
 * "Nur im Freien" oder nicht gesetzt → kein Filter.
 */
function isRauchenExcluded(deal, bk) {
  const dealRauchen = (deal.bk_rauchen || "").toLowerCase().trim();
  if (!dealRauchen || dealRauchen === "nur im freien") return false;

  // "unbedingt Nichtraucher" → BK muss "false" (Nein) sein
  if (dealRauchen.includes("nichtraucher")) {
    const bkRaucher = (bk.raucher_bk || "").toLowerCase().trim();
    // Nur "false" = Nichtraucher, alles andere (true, e-zigarette, leer) → ausschließen
    return bkRaucher !== "false";
  }

  return false;
}

module.exports = { calculateScore, getStars, isGenderExcluded, isAnzahlExcluded, isRauchenExcluded, parseCheckboxField };
