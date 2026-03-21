const HUBSPOT_API = "https://api-eu1.hubapi.com";
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "143405850";

const DETAIL_PROPERTIES = [
  // Persönliche Daten
  "bp_anrede",
  "firstname",
  "lastname",
  "spitzname",
  "bp_geburtsdatum",
  "familienstand",
  "kinder",
  "country",
  "email",
  "mobilephone",
  "beschreibung",
  // Betreuungsprofil
  "kategorie_bk",
  "deutschkenntnisse",
  "ab_wann_ware_die_bk_einsatzbereit",
  "raucher_bk",
  "zigaretten_am_tag",
  "fuhrerschein_bk",
  // Erfahrung
  "pflegeerfahrung_in_jahren_bk",
  "erfahrung",
  "transfer__heben__umlagern_ohne_hilfsmittel_bis_kg",
  "letzte_betreuungseinsatze",
  // Ausbildung
  "ausbildungen_bk",
  "sonstige_ausbildung__details",
  "zertifikate",
  // Foto
  "foto_betreuungskraft",
];

async function hubspotFetch(path, options = {}) {
  const res = await fetch(`${HUBSPOT_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot API ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const { contactId } = req.query;
    if (!contactId) {
      return res.status(400).json({ error: "contactId parameter required" });
    }

    // 1. Contact-Properties laden
    const props = DETAIL_PROPERTIES.join(",");
    const contact = await hubspotFetch(
      `/crm/v3/objects/contacts/${contactId}?properties=${props}`
    );
    const p = contact.properties || {};

    // 2. Agentur laden (Associated Company)
    let agentur = "";
    try {
      const assocData = await hubspotFetch(
        `/crm/v4/objects/contacts/${contactId}/associations/companies`
      );
      const companyId = assocData.results?.[0]?.toObjectId;
      if (companyId) {
        const company = await hubspotFetch(
          `/crm/v3/objects/companies/${companyId}?properties=name`
        );
        agentur = company.properties?.name || "";
      }
    } catch {
      // Agentur optional
    }

    // 3. Alter berechnen
    const alter = p.bp_geburtsdatum
      ? String(Math.floor((Date.now() - new Date(p.bp_geburtsdatum).getTime()) / (365.25 * 24 * 60 * 60 * 1000)))
      : "";

    // 4. Letzte Einsätze HTML bereinigen
    const letzteEinsaetze = (p.letzte_betreuungseinsatze || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return res.status(200).json({
      contactId,
      agentur,
      profil: {
        anrede: p.bp_anrede || "",
        vorname: p.firstname || "",
        nachname: p.lastname || "",
        spitzname: p.spitzname || "",
        geburtsdatum: p.bp_geburtsdatum || "",
        alter,
        familienstand: p.familienstand || "",
        kinder: p.kinder || "",
        land: p.country || "",
        email: p.email || "",
        handynummer: p.mobilephone || "",
        beschreibung: p.beschreibung || "",
        kategorie: p.kategorie_bk || "",
        deutschkenntnisse: p.deutschkenntnisse || "",
        verfuegbarAb: p.ab_wann_ware_die_bk_einsatzbereit || "",
        raucher: p.raucher_bk || "",
        zigarettenAmTag: p.zigaretten_am_tag || "",
        fuehrerschein: p.fuhrerschein_bk || "",
        pflegeerfahrungJahre: p.pflegeerfahrung_in_jahren_bk || "",
        erfahrung: p.erfahrung || "",
        transferKg: p.transfer__heben__umlagern_ohne_hilfsmittel_bis_kg || "",
        letzteEinsaetze,
        ausbildungen: p.ausbildungen_bk || "",
        sonstigeAusbildung: p.sonstige_ausbildung__details || "",
        zertifikate: p.zertifikate || "",
      },
      link: `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/contact/${contactId}`,
    });
  } catch (err) {
    console.error("BK Details Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
