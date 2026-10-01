/**
 * Prüft, dass ein eingehender Request wirklich von HubSpot (hubspot.fetch) kommt.
 *
 * HubSpot signiert jeden hubspot.fetch-Request mit dem Client Secret der App:
 *   - v3: X-HubSpot-Signature-v3 + X-HubSpot-Request-Timestamp
 *         HMAC-SHA256( method + uri + body + timestamp ), base64
 *   - v2: X-HubSpot-Signature (Signature-Version v2)
 *         SHA256( secret + method + uri + body ), hex
 * Docs: developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
 *
 * Erkenntnisse aus dem Live-Betrieb (hubspot.fetch, GET):
 *   - Beide Header kommen mit, Signature-Version steht auf "v2". Validiert hat v3.
 *   - Die URI muss wie in den Docs teil-dekodiert werden (z. B. %40 → @ in userEmail).
 *   - Der Body zählt bei GET als leerer String, obwohl Vercel req.body als {} parst.
 *
 * Ohne gültige Signatur wird der Request abgelehnt – die API ist sonst für jeden
 * mit der URL offen (personenbezogene BK-Daten!).
 */
const crypto = require("crypto");

const MAX_SKEW_MS = 5 * 60 * 1000;

// Nur diese Zeichen werden laut Docs im Query-String vor dem Hashen dekodiert.
const DECODE_MAP = {
  "%3A": ":", "%2F": "/", "%3F": "?", "%40": "@",
  "%21": "!", "%24": "$", "%27": "'", "%28": "(",
  "%29": ")", "%2A": "*", "%2C": ",", "%3B": ";",
};

function buildRequestUri(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}${req.url}`;
}

function decodeQueryForV3(uri) {
  const withoutFragment = uri.split("#")[0];
  const q = withoutFragment.indexOf("?");
  if (q === -1) return withoutFragment;
  const path = withoutFragment.slice(0, q + 1);
  const query = withoutFragment
    .slice(q + 1)
    .replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => DECODE_MAP[m.toUpperCase()]);
  return path + query;
}

/**
 * Body-String so, wie HubSpot ihn signiert. Bei GET/HEAD ist das immer "",
 * egal was der Vercel-Body-Parser daraus gemacht hat.
 */
function bodyAsString(req) {
  if (req.method === "GET" || req.method === "HEAD") return "";
  if (req.body === undefined || req.body === null) return "";
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyV3(req, clientSecret, now) {
  const signature = req.headers["x-hubspot-signature-v3"];
  const timestamp = req.headers["x-hubspot-request-timestamp"];
  if (!signature || !timestamp) return { ok: false, reason: "v3 header missing" };

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "v3 timestamp invalid" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "v3 timestamp outside 5 min window" };

  const uri = decodeQueryForV3(buildRequestUri(req));
  const raw = `${req.method}${uri}${bodyAsString(req)}${timestamp}`;
  const expected = crypto.createHmac("sha256", clientSecret).update(raw, "utf8").digest("base64");
  return safeEqual(expected, signature)
    ? { ok: true, version: "v3" }
    : { ok: false, reason: "v3 signature mismatch" };
}

function verifyV2(req, clientSecret) {
  const signature = req.headers["x-hubspot-signature"];
  if (!signature) return { ok: false, reason: "v2 header missing" };
  const raw = `${clientSecret}${req.method}${buildRequestUri(req)}${bodyAsString(req)}`;
  const expected = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  return safeEqual(expected, signature)
    ? { ok: true, version: "v2" }
    : { ok: false, reason: "v2 signature mismatch" };
}

/**
 * Gibt { ok, version } oder { ok: false, reason, status } zurück.
 * v3 wird bevorzugt (Replay-Schutz über Timestamp); v2 nur wenn kein v3-Header da ist.
 */
function verifyHubSpotSignature(req, { clientSecret = process.env.HUBSPOT_CLIENT_SECRET, now = Date.now() } = {}) {
  if (!clientSecret) {
    return { ok: false, status: 500, reason: "HUBSPOT_CLIENT_SECRET not configured" };
  }
  const result = req.headers["x-hubspot-signature-v3"]
    ? verifyV3(req, clientSecret, now)
    : verifyV2(req, clientSecret);
  return result.ok ? result : { ...result, status: 401 };
}

/**
 * Für Vercel-Handler: prüft die Signatur und beantwortet den Request selbst mit 401/500,
 * wenn sie fehlt oder falsch ist. Gibt true zurück, wenn der Handler weitermachen darf.
 */
function requireHubSpotSignature(req, res) {
  const result = verifyHubSpotSignature(req);
  if (result.ok) return true;
  console.warn(`[hubspot-signature] rejected ${req.method} ${(req.url || "").split("?")[0]}: ${result.reason}`);
  res.status(result.status).json({ error: result.status === 500 ? "Signature verification not configured" : "Unauthorized" });
  return false;
}

module.exports = { verifyHubSpotSignature, requireHubSpotSignature, buildRequestUri, decodeQueryForV3 };
