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
  "firstname",
  "lastname",
  "bp_anrede",
  "deutschkenntnisse",
  "erfahrung",
  "fuhrerschein_bk",
  "ab_wann_ware_die_bk_einsatzbereit",
  "transfer__heben__umlagern_ohne_hilfsmittel_bis_kg",
  "pflegeerfahrung_in_jahren_bk",
  "kategorie_bk",
];

const MAX_RESULTS = 10;

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
      scored.push({
        contactId: bk.id,
        name: [bkProps.firstname, bkProps.lastname].filter(Boolean).join(" "),
        score,
        stars: getStars(score),
        kategorie: bkProps.kategorie_bk || kategorie,
        deutsch: bkProps.deutschkenntnisse || "",
        verfuegbarAb: bkProps.ab_wann_ware_die_bk_einsatzbereit || "",
        erfahrungen: details.krankheiten?.matched || [],
        details,
      });
    }

    // 5. Sortieren nach Score (absteigend)
    scored.sort((a, b) => b.score - a.score);

    // 6. Top N nehmen
    const topBKs = scored.slice(0, MAX_RESULTS);

    // 7. Agenturen laden für Top BKs
    const contactIds = topBKs.map((bk) => bk.contactId);
    const agenturMap = await fetchAgenturen(contactIds);

    // 8. Response zusammenbauen
    const results = topBKs.map((bk) => ({
      ...bk,
      agentur: agenturMap[bk.contactId] || "",
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
