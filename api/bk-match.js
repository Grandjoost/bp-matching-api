const { calculateScore, getStars, isGenderExcluded } = require("./scoring");

const HUBSPOT_API = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "143405850";

const DEAL_PROPERTIES = [
  "gewunschte_betreuungskategorie",
  "mp_deutschkenntnisse",
  "bp_service_startdate",
  "mp_geschlecht_bk",
  "mp_demenz",
  "mp_harninkontinenz",
  "mp_stuhlinkontinenz",
  "mp_querschnitt",
  "mp_suchterkrankung",
  "mp_hochansteckend",
  "mp_krankheiten_weitere",
  "mp_koerpergewicht",
  "mp_transfer",
  "mp_fuehrerschein",
];

const BK_PROPERTIES = [
  // Persönliche Daten
  "bp_anrede",
  "firstname",
  "lastname",
  "spitzname",
  "bp_geburtsdatum",
  "alter_bk",
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

const MAX_RESULTS = 10;

const SERVICE_STAGE_LAEUFT = "600b692d-a3fe-4052-9cd7-278b134d7941";
const SERVICE_STAGE_VORBEREITUNG = "8e2b21d0-7a90-4968-8f8c-a8525cc49c70";

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

async function fetchDeal(dealId) {
  const props = DEAL_PROPERTIES.join(",");
  return hubspotFetch(`/crm/v3/objects/deals/${dealId}?properties=${props}`);
}

async function searchBKs(kategorie) {
  const results = [];
  let after = undefined;

  // Paginate through all matching BKs
  do {
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "kategorie_bk",
              operator: "EQ",
              value: kategorie,
            },
          ],
        },
      ],
      properties: BK_PROPERTIES,
      limit: 100,
    };
    if (after) body.after = after;

    const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify(body),
    });

    results.push(...(data.results || []));
    after = data.paging?.next?.after;
  } while (after && results.length < 500);

  return results;
}

async function fetchAgenturen(contactIds) {
  if (contactIds.length === 0) return {};

  const agenturen = {};

  // Batch: max 100 per request
  const batches = [];
  for (let i = 0; i < contactIds.length; i += 100) {
    batches.push(contactIds.slice(i, i + 100));
  }

  for (const batch of batches) {
    const body = {
      inputs: batch.map((id) => ({ id })),
    };
    try {
      const data = await hubspotFetch(
        "/crm/v4/associations/contacts/companies/batch/read",
        { method: "POST", body: JSON.stringify(body) }
      );
      for (const result of data.results || []) {
        const contactId = result.from?.id;
        const companyId = result.to?.[0]?.toObjectId;
        if (contactId && companyId) {
          agenturen[contactId] = companyId;
        }
      }
    } catch {
      // Associations optional — weiter ohne
    }
  }

  // Company-Names laden
  const companyIds = [...new Set(Object.values(agenturen))];
  const companyNames = {};

  for (let i = 0; i < companyIds.length; i += 100) {
    const batch = companyIds.slice(i, i + 100);
    try {
      const data = await hubspotFetch("/crm/v3/objects/companies/batch/read", {
        method: "POST",
        body: JSON.stringify({
          inputs: batch.map((id) => ({ id })),
          properties: ["name"],
        }),
      });
      for (const company of data.results || []) {
        companyNames[company.id] = company.properties?.name || "";
      }
    } catch {
      // Weiter ohne Company-Names
    }
  }

  // Map: contactId → companyName
  const result = {};
  for (const [contactId, companyId] of Object.entries(agenturen)) {
    result[contactId] = companyNames[companyId] || "";
  }
  return result;
}

const BEWERTUNG_PUNKTE = { gut: 5, mittel: 3, schlecht: 1 };

function calcBewertungStars(bewertungen) {
  if (bewertungen.length === 0) return 0;
  const sum = bewertungen.reduce((acc, b) => acc + (BEWERTUNG_PUNKTE[b] || 0), 0);
  const avg = sum / bewertungen.length;
  if (avg >= 4.5) return 5;
  if (avg >= 3.5) return 4;
  if (avg >= 2.5) return 3;
  if (avg >= 1.5) return 2;
  return 1;
}

async function fetchEinsatzStatus(contactIds) {
  if (contactIds.length === 0) return {};

  const statusMap = {};
  const bewertungMap = {}; // contactId → [bewertungen]

  // Services (Betreuungseinsätze) sind über Association 798 mit Contacts verknüpft
  const batches = [];
  for (let i = 0; i < contactIds.length; i += 100) {
    batches.push(contactIds.slice(i, i + 100));
  }

  for (const batch of batches) {
    try {
      // Associations: Contact → Services laden
      const data = await hubspotFetch(
        "/crm/v4/associations/contacts/0-162/batch/read",
        {
          method: "POST",
          body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }),
        }
      );

      // Service-IDs sammeln pro Contact
      const contactServices = {};
      for (const result of data.results || []) {
        const contactId = result.from?.id;
        const serviceIds = (result.to || []).map((t) => t.toObjectId);
        if (contactId && serviceIds.length > 0) {
          contactServices[contactId] = serviceIds;
        }
      }

      // Service-Properties per Batch laden
      const allServiceIds = Object.values(contactServices).flat();
      if (allServiceIds.length === 0) continue;

      const uniqueServiceIds = [...new Set(allServiceIds)];
      for (let j = 0; j < uniqueServiceIds.length; j += 100) {
        const serviceBatch = uniqueServiceIds.slice(j, j + 100);
        const serviceData = await hubspotFetch(
          "/crm/v3/objects/0-162/batch/read",
          {
            method: "POST",
            body: JSON.stringify({
              inputs: serviceBatch.map((id) => ({ id })),
              properties: ["hs_pipeline_stage", "betreuungsbeginn", "betreuungsende", "hs_tags"],
            }),
          }
        );

        const serviceProps = {};
        for (const svc of serviceData.results || []) {
          serviceProps[svc.id] = svc.properties || {};
        }

        // Status + Betreuungsende + Bewertungen pro Contact bestimmen
        for (const [contactId, svcIds] of Object.entries(contactServices)) {
          if (!bewertungMap[contactId]) bewertungMap[contactId] = [];

          for (const svcId of svcIds) {
            const p = serviceProps[svcId];
            if (!p) continue;

            // Bewertung sammeln
            const tags = p.hs_tags;
            if (tags) {
              const tagList = tags.split(";").map((t) => t.trim().toLowerCase());
              for (const tag of tagList) {
                if (BEWERTUNG_PUNKTE[tag] !== undefined) {
                  bewertungMap[contactId].push(tag);
                }
              }
            }

            // Status bestimmen (läuft hat Vorrang)
            if (statusMap[contactId]?.status === "laeuft") continue;

            const stage = p.hs_pipeline_stage;
            if (stage === SERVICE_STAGE_LAEUFT) {
              statusMap[contactId] = { status: "laeuft", betreuungsende: p.betreuungsende || "" };
            } else if (stage === SERVICE_STAGE_VORBEREITUNG) {
              statusMap[contactId] = { status: "geplant", betreuungsende: p.betreuungsende || "" };
            }
          }
        }
      }
    } catch {
      // Services optional — weiter ohne
    }
  }

  // Bewertungs-Sterne berechnen und an statusMap anhängen
  for (const contactId of contactIds) {
    const bewertungen = bewertungMap[contactId] || [];
    const stars = calcBewertungStars(bewertungen);
    if (statusMap[contactId]) {
      statusMap[contactId].bewertungStars = stars;
    } else {
      statusMap[contactId] = { status: "frei", betreuungsende: "", bewertungStars: stars };
    }
  }

  return statusMap;
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const { dealId } = req.query;
    if (!dealId) {
      return res.status(400).json({ error: "dealId parameter required" });
    }

    // 1. Deal laden
    const deal = await fetchDeal(dealId);
    const dealProps = deal.properties || {};

    // 2. Prüfen ob Matching-Profil ausgefüllt
    const kategorie = dealProps.gewunschte_betreuungskategorie;
    if (!kategorie) {
      return res.status(200).json({
        results: [],
        empty: true,
        message: "Bitte Matching-Profil ausfüllen (Betreuungskategorie fehlt)",
        meta: { totalBKs: 0, shown: 0, dealComplete: false },
      });
    }

    // 3. BKs suchen (gefiltert nach Kategorie)
    const bks = await searchBKs(kategorie);

    if (bks.length === 0) {
      return res.status(200).json({
        results: [],
        empty: true,
        message: "Keine Betreuungskräfte in Kategorie '" + kategorie + "' gefunden",
        meta: { totalBKs: 0, shown: 0, dealComplete: true },
      });
    }

    // 4. Geschlechts-Filter + Scoring
    const scored = [];
    for (const bk of bks) {
      const bkProps = bk.properties || {};

      // Hard Filter: Geschlecht
      if (isGenderExcluded(dealProps, bkProps)) continue;

      const { score, details } = calculateScore(dealProps, bkProps);
      const avatarUrl = bkProps.foto_betreuungskraft || "";

      scored.push({
        contactId: bk.id,
        name: [bkProps.firstname, bkProps.lastname].filter(Boolean).join(" "),
        score,
        stars: 0,
        kategorie: bkProps.kategorie_bk || kategorie,
        deutsch: bkProps.deutschkenntnisse || "",
        verfuegbarAb: bkProps.ab_wann_ware_die_bk_einsatzbereit || "",
        erfahrungen: details.krankheiten?.matched || [],
        avatarUrl,
        // Alle Detail-Properties durchreichen
        profil: {
          anrede: bkProps.bp_anrede || "",
          vorname: bkProps.firstname || "",
          nachname: bkProps.lastname || "",
          spitzname: bkProps.spitzname || "",
          geburtsdatum: bkProps.bp_geburtsdatum || "",
          alter: bkProps.bp_geburtsdatum ? String(Math.floor((Date.now() - new Date(bkProps.bp_geburtsdatum).getTime()) / (365.25 * 24 * 60 * 60 * 1000))) : "",
          familienstand: bkProps.familienstand || "",
          kinder: bkProps.kinder || "",
          land: bkProps.country || "",
          email: bkProps.email || "",
          handynummer: bkProps.mobilephone || "",
          beschreibung: bkProps.beschreibung || "",
          kategorie: bkProps.kategorie_bk || "",
          deutschkenntnisse: bkProps.deutschkenntnisse || "",
          verfuegbarAb: bkProps.ab_wann_ware_die_bk_einsatzbereit || "",
          raucher: bkProps.raucher_bk || "",
          zigarettenAmTag: bkProps.zigaretten_am_tag || "",
          fuehrerschein: bkProps.fuhrerschein_bk || "",
          pflegeerfahrungJahre: bkProps.pflegeerfahrung_in_jahren_bk || "",
          erfahrung: bkProps.erfahrung || "",
          transferKg: bkProps.transfer__heben__umlagern_ohne_hilfsmittel_bis_kg || "",
          letzteEinsaetze: (bkProps.letzte_betreuungseinsatze || "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
          ausbildungen: bkProps.ausbildungen_bk || "",
          sonstigeAusbildung: bkProps.sonstige_ausbildung__details || "",
          zertifikate: bkProps.zertifikate || "",
        },
        details,
      });
    }

    // 5. Einsatz-Status + Bewertungs-Sterne für ALLE BKs laden
    const allContactIds = scored.map((bk) => bk.contactId);
    const einsatzMap = await fetchEinsatzStatus(allContactIds);

    // 6. Sterne + Status anreichern
    for (const bk of scored) {
      const einsatz = einsatzMap[bk.contactId];
      if (einsatz) {
        bk.stars = einsatz.bewertungStars || 0;
        bk.einsatzStatus = einsatz.status || "frei";
        if (einsatz.betreuungsende) {
          bk.verfuegbarAb = einsatz.betreuungsende;
        }
      }
    }

    // 7. Sortieren: Score absteigend, dann Sterne absteigend
    scored.sort((a, b) => b.score - a.score || b.stars - a.stars);

    // 8. Top N nehmen
    const topBKs = scored.slice(0, MAX_RESULTS);

    // 9. Agenturen laden (nur für Top N)
    const topContactIds = topBKs.map((bk) => bk.contactId);
    const agenturMap = await fetchAgenturen(topContactIds);

    // 10. Response zusammenbauen
    const results = topBKs.map((bk) => ({
      ...bk,
      agentur: agenturMap[bk.contactId] || "",
      einsatzStatus: bk.einsatzStatus || "frei",
      link: `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/contact/${bk.contactId}`,
    }));

    return res.status(200).json({
      results,
      meta: {
        totalBKs: scored.length,
        shown: results.length,
        dealComplete: true,
        kategorie,
      },
    });
  } catch (err) {
    console.error("BK Match Error:", err);
    return res.status(500).json({ error: err.message });
  }
};
