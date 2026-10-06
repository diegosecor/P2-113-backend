/* =============================================================================
   PATH FREQUENCY API
   -----------------------------------------------------------------------------
   Minimal dependency-free API. Start locally with: `node server.js`.
   ============================================================================= */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const storeFile = path.join(__dirname, "routes-store.json");
const port = Number(process.env.PORT || 3000);

/* =============================================================================
   FILE-BASED ROUTE STORE
   -----------------------------------------------------------------------------
   The local JSON file is created only after a profile or route is saved.
   ============================================================================= */
const readStore = () => {
  try { return JSON.parse(fs.readFileSync(storeFile, "utf8")); }
  catch (_) { return { profiles: [], routes: [] }; }
};
const writeStore = (store) => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));

// Every API response includes CORS so the static GitHub Pages frontend can call it.
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*" });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; if (raw.length > 5_000_000) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
  req.on("error", reject);
});

/* =============================================================================
   ROUTE INSIGHT SERVICES
   -----------------------------------------------------------------------------
   Reverse geocoding identifies a nearby place; an AI description is optional.
   ============================================================================= */
const terrain = (route) => {
  const span = Math.round(route.maxElevation - route.minElevation);
  if (span > 700 || route.ascent > 900) return "mountainous terrain with sustained climbs";
  if (span > 250 || route.ascent > 350) return "rolling terrain with repeated changes in grade";
  return "mostly flat terrain, suitable for steady pacing";
};
async function placeFor(lat, lon) {
  try {
    const result = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, { headers: { "User-Agent": "PathFrequency route-insights/1.0" } });
    if (!result.ok) return null;
    const data = await result.json();
    const a = data.address || {};
    return [a.village || a.town || a.city || a.county, a.state || a.country].filter(Boolean).join(", ") || data.display_name?.split(",").slice(0, 2).join(",");
  } catch (_) { return null; }
}
async function insight(route) {
  const place = await placeFor(route.lat, route.lon);
  const location = place || `near ${Number(route.lat).toFixed(3)}, ${Number(route.lon).toFixed(3)}`;
  const facts = `${route.sport} route of ${Number(route.distanceKm).toFixed(1)} km through ${terrain(route)}. It climbs about ${Math.round(route.ascent)} m, ranges from ${Math.round(route.minElevation)} to ${Math.round(route.maxElevation)} m, and records speeds from ${Number(route.minSpeed).toFixed(1)} to ${Number(route.maxSpeed).toFixed(1)} km/h.`;
  // An OpenAI call is deliberately opt-in: no GPX data leaves this server unless its owner sets a key.
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL, input: `Write one concise, factual route insight (max 45 words) for ${location}. Use only: ${facts}` })
      });
      const ai = await response.json();
      const text = ai.output_text || ai.output?.flatMap(x => x.content || []).map(x => x.text).filter(Boolean).join(" ");
      if (response.ok && text) return { place: location, description: text, tags: [route.sport, `${Number(route.distanceKm).toFixed(1)} km`, `${Math.round(route.ascent)} m ascent`] };
    } catch (_) { /* Use the deterministic insight below. */ }
  }
  return { place: location, description: facts, tags: [route.sport, `${Number(route.distanceKm).toFixed(1)} km`, `${Math.round(route.ascent)} m ascent`] };
}
async function nearbyPhoto(lat, lon) {
  const latitude = Number(lat), longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  try {
    // Wikimedia Commons returns real, reusable photographs geotagged close to the route midpoint.
    const query = new URLSearchParams({ action: "query", format: "json", generator: "geosearch", ggsprimary: "all", ggsnamespace: "6", ggsradius: "12000", ggslimit: "1", ggscoord: `${latitude}|${longitude}`, prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "900", origin: "*" });
    const response = await fetch(`https://commons.wikimedia.org/w/api.php?${query}`, { headers: { "User-Agent": "PathFrequency route photo/1.0" } });
    if (!response.ok) return null;
    const page = Object.values((await response.json()).query?.pages || {})[0];
    const info = page?.imageinfo?.[0];
    if (!info?.thumburl) return null;
    const metadata = info.extmetadata || {};
    const clean = (value) => String(value || "").replace(/<[^>]*>/g, "").trim();
    return { url: info.thumburl, pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(page.title || "")}`, title: page.title?.replace(/^File:/, "") || "Photo near route", author: clean(metadata.Artist?.value) || "Wikimedia Commons", license: clean(metadata.LicenseShortName?.value) };
  } catch (_) { return null; }
}

/* =============================================================================
   HTTP ROUTES
   -----------------------------------------------------------------------------
   Profiles and saved routes use JSON; insight and photo routes add geographic context.
   ============================================================================= */
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") return json(res, 200, { service: "Path Frequency API", status: "ok" });
    if (req.method === "POST" && url.pathname === "/api/profiles") {
      const profile = await body(req); if (!profile.id || !profile.name) return json(res, 400, { error: "id and name are required" });
      const store = readStore(), i = store.profiles.findIndex(p => p.id === profile.id);
      i >= 0 ? store.profiles[i] = profile : store.profiles.push(profile); writeStore(store); return json(res, 201, profile);
    }
    if (req.method === "POST" && url.pathname === "/api/routes") {
      const { userId, route } = await body(req); if (!userId || !route?.id) return json(res, 400, { error: "userId and route are required" });
      const store = readStore(); store.routes = store.routes.filter(r => r.id !== route.id); store.routes.unshift({ ...route, userId, savedAt: new Date().toISOString() }); writeStore(store); return json(res, 201, { id: route.id });
    }
    const userRoutes = url.pathname.match(/^\/api\/users\/([^/]+)\/routes$/);
    if (req.method === "GET" && userRoutes) return json(res, 200, readStore().routes.filter(r => r.userId === decodeURIComponent(userRoutes[1])));
    if (req.method === "GET" && url.pathname === "/api/route-photo") return json(res, 200, await nearbyPhoto(url.searchParams.get("lat"), url.searchParams.get("lon")));
    if (req.method === "POST" && url.pathname === "/api/route-insight") return json(res, 200, await insight(await body(req)));
    return json(res, 404, { error: "Not found" });
  } catch (error) { console.error(error); json(res, 500, { error: "Server error" }); }
}).listen(port, () => console.log(`Path Frequency API and app: http://localhost:${port}`));
