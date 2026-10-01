// Ausführen: npm test  (keine Abhängigkeiten, nur Node)
const crypto = require("crypto");
const { verifyHubSpotSignature } = require("../lib/hubspot-signature");

const SECRET = "test-secret-abc";
const NOW = 1_800_000_000_000;
const host = "bp-matching-api.vercel.app";
// So sieht ein hubspot.fetch-GET live aus: eigene Params + von HubSpot angehängte Metadaten
const url = "/api/bk-match?dealId=123&appId=34333298&portalId=139583220&userEmail=Joost%40noditch.de&userId=1";

function v3Headers(method, u, ts, secret = SECRET) {
  // HubSpot signiert die URI mit dekodiertem %40 und bei GET mit leerem Body
  const decodedUri = `https://${host}${u}`.replace(/%40/g, "@");
  const sig = crypto.createHmac("sha256", secret).update(`${method}${decodedUri}${ts}`, "utf8").digest("base64");
  return { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": String(ts), host };
}
function v2Headers(method, u, secret = SECRET) {
  const sig = crypto.createHash("sha256").update(`${secret}${method}https://${host}${u}`, "utf8").digest("hex");
  return { "x-hubspot-signature": sig, "x-hubspot-signature-version": "v2", host };
}
const req = (headers, u = url, body) => ({ method: "GET", url: u, headers, body });
const opts = { clientSecret: SECRET, now: NOW };

const cases = [
  ["v3 gültig",                           verifyHubSpotSignature(req(v3Headers("GET", url, NOW - 1000)), opts).ok === true],
  ["v3 gültig trotz Vercel-Body {} bei GET", verifyHubSpotSignature(req(v3Headers("GET", url, NOW), url, {}), opts).ok === true],
  ["v3 Timestamp 6 min alt",              verifyHubSpotSignature(req(v3Headers("GET", url, NOW - 6 * 60 * 1000)), opts).ok === false],
  ["v3 falsches Secret",                  verifyHubSpotSignature(req(v3Headers("GET", url, NOW, "other")), opts).ok === false],
  ["v3 Query manipuliert",                verifyHubSpotSignature(req(v3Headers("GET", url, NOW), url.replace("dealId=123", "dealId=124")), opts).ok === false],
  ["v2 gültig (ohne v3-Header)",          verifyHubSpotSignature(req(v2Headers("GET", url)), opts).ok === true],
  ["v2 falsches Secret",                  verifyHubSpotSignature(req(v2Headers("GET", url, "other")), opts).ok === false],
  ["keine Header → 401",                  verifyHubSpotSignature(req({ host }), opts).status === 401],
  ["kein Secret konfiguriert → 500",      verifyHubSpotSignature(req(v3Headers("GET", url, NOW)), { clientSecret: "", now: NOW }).status === 500],
  ["x-forwarded-host bevorzugt",          verifyHubSpotSignature(req({ ...v3Headers("GET", url, NOW), host: "internal", "x-forwarded-host": host }), opts).ok === true],
];
let fail = 0;
for (const [name, ok] of cases) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fail++; }
console.log(fail ? `${fail} Test(s) fehlgeschlagen` : "alle Tests bestanden");
process.exit(fail ? 1 : 0);
