const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 7000;
const BASE = "https://sololatino.net";
const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36";

const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const cache = new Map();

const manifest = require("./manifest.json");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

function absoluteUrl(href) {
  try {
    return new URL(href, BASE).href;
  } catch {
    return null;
  }
}

function clean(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function addonId(type, url) {
  return `sl:${type}:${slugFromUrl(url)}`;
}

function parseRating(text) {
  const m = clean(text).match(/(?:★\s*)?(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

async function fetchHtml(url) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.time < CACHE_TTL) return cached.html;

  const r = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!r.ok) throw new Error(`HTTP ${r.status} while fetching ${url}`);
  const html = await r.text();
  cache.set(url, { time: now, html });
  return html;
}

function classifyUrl(url) {
  const p = new URL(url).pathname;
  if (p.startsWith("/pelicula/")) return "movie";
  if (p.startsWith("/serie/") || p.startsWith("/anime/") || p.startsWith("/dorama/")) return "series";
  return null;
}

function extractCatalogItems(html, type) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));
    if (!href || seen.has(href)) return;

    const detected = classifyUrl(href);
    if (detected !== type) return;

    const text = clean($(a).text());
    const parentText = clean($(a).parent().text());
    const combined = clean(`${text} ${parentText}`);

    // Skip navigation links that happen to match a content path.
    if (!text && !parentText) return;

    const title = text || clean($(a).find("img").attr("alt")) || slugFromUrl(href);
    const img = $(a).find("img").first().attr("src") || $(a).find("img").first().attr("data-src");

    let year;
    const yearMatch = combined.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) year = yearMatch[0];

    const rating = parseRating(combined);

    items.push({
      id: addonId(type, href),
      type,
      name: clean(title),
      poster: absoluteUrl(img),
      year: year ? Number(year) : undefined,
      rating,
      _sourceUrl: href
    });
    seen.add(href);
  });

  return items.slice(0, 100);
}

async function catalog(type, search, skip = 0) {
  const path = type === "movie" ? "/peliculas" : "/series";
  let url = BASE + path;

  if (search) {
    url = `${BASE}/buscar?query=${encodeURIComponent(search)}`;
  } else if (skip > 0) {
    url += `?page=${Math.floor(skip / 20) + 1}`;
  }

  const html = await fetchHtml(url);
  let items = extractCatalogItems(html, type);

  if (search && items.length === 0) {
    // Some versions of the site may use a different search parameter.
    const fallback = await fetchHtml(`${BASE}/buscar?q=${encodeURIComponent(search)}`);
    items = extractCatalogItems(fallback, type);
  }

  return items.map(({ _sourceUrl, ...item }) => ({
    ...item,
    poster: item.poster || undefined,
    metaUrl: _sourceUrl
  }));
}

function extractMetaFromPage(html, sourceUrl, type) {
  const $ = cheerio.load(html);

  const title = clean($("h1").first().text()) || clean($('meta[property="og:title"]').attr("content"));
  const description =
    clean($('meta[name="description"]').attr("content")) ||
    clean($('meta[property="og:description"]').attr("content"));
  const poster =
    $('meta[property="og:image"]').attr("content") ||
    absoluteUrl($("img").filter((_, el) => {
      const alt = clean($(el).attr("alt"));
      return alt && title && alt.toLowerCase().includes(title.toLowerCase());
    }).first().attr("src"));

  const bodyText = clean($("body").text());
  const yearMatch = bodyText.match(/\b(19|20)\d{2}\b/);
  const ratingMatch = bodyText.match(/(?:IMDb|TMDB)?\s*(\d+(?:\.\d+)?)\s*(?:\/10)?/i);

  const genres = [];
  $("a[href]").each((_, a) => {
    const text = clean($(a).text());
    if (text && /^(Drama|Comedia|Suspense|Acción|Animación|Crimen|Terror|Aventura|Familia|Romance|Misterio|Ciencia Ficción|Fantasía|Documental|Historia|Música|Anime|Bélica|Kids|Western|Reality)$/i.test(text)) {
      if (!genres.includes(text)) genres.push(text);
    }
  });

  const meta = {
    id: addonId(type, sourceUrl),
    type,
    name: title || slugFromUrl(sourceUrl),
    poster: absoluteUrl(poster),
    description,
    releaseInfo: yearMatch ? yearMatch[0] : undefined,
    genres,
    links: [
      {
        name: "SoloLatino",
        category: "source",
        url: sourceUrl
      }
    ],
    behaviorHints: {
      defaultVideoId: addonId(type, sourceUrl)
    }
  };

  if (type === "series") {
    meta.videos = extractEpisodes($, sourceUrl, meta);
  }

  return meta;
}

function extractEpisodes($, sourceUrl, meta) {
  const videos = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));
    if (!href || seen.has(href)) return;

    const text = clean($(a).text());
    const m = text.match(/\bE(\d+)\b/i);
    if (!m) return;

    const seasonText = clean($(a).parent().text());
    const seasonMatch = seasonText.match(/(?:Temporada|Season)\s*(\d+)/i);
    const season = seasonMatch ? Number(seasonMatch[1]) : 1;
    const episode = Number(m[1]);

    videos.push({
      id: `${meta.id}:s${season}e${episode}`,
      title: text,
      season,
      episode,
      overview: clean($(a).parent().text()).slice(0, 500),
      thumbnail: meta.poster,
      released: undefined
    });

    seen.add(href);
  });

  return videos.slice(0, 300);
}

function sourceUrlFromId(id) {
  const m = String(id).match(/^sl:(movie|series):(.+?)(?::s\d+e\d+)?$/);
  if (!m) return null;
  const type = m[1];
  const slug = m[2];
  return `${BASE}/${type === "movie" ? "pelicula" : "serie"}/${slug}`;
}

app.get("/manifest.json", (_, res) => res.json(manifest));

app.get("/", (_, res) => {
  res.type("html").send(`
    <html>
      <head><meta charset="utf-8"><title>SoloLatino Stremio Addon</title></head>
      <body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:20px">
        <h1>SoloLatino • Stremio Addon</h1>
        <p>Catálogo y metadatos de SoloLatino con enlaces externos.</p>
        <p><a href="/manifest.json">Instalar / abrir manifest.json</a></p>
        <p>Este addon no descarga ni retransmite archivos de vídeo; dirige al usuario a la página de origen.</p>
      </body>
    </html>
  `);
});

app.get("/catalog/:type/:id.json", async (req, res) => {
  try {
    const type = req.params.type;
    const id = req.params.id;
    if (!["movie", "series"].includes(type)) return res.json({ metas: [] });

    const search = req.query.search ? String(req.query.search) : "";
    const skip = Math.max(0, Number(req.query.skip || 0));
    const expected = type === "movie" ? "sololatino-movies" : "sololatino-series";
    if (id !== expected) return res.json({ metas: [] });

    const metas = await catalog(type, search, skip);
    res.json({ metas });
  } catch (err) {
    console.error(err);
    res.status(502).json({ metas: [], error: "No se pudo consultar SoloLatino." });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const { type, id } = req.params;
    const sourceUrl = sourceUrlFromId(id);
    if (!sourceUrl) return res.json({ meta: null });

    const html = await fetchHtml(sourceUrl);
    const meta = extractMetaFromPage(html, sourceUrl, type);
    res.json({ meta });
  } catch (err) {
    console.error(err);
    res.status(502).json({ meta: null, error: "No se pudo consultar el contenido." });
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  // Intentionally returns an external page link, not a media file or extracted player URL.
  const sourceUrl = sourceUrlFromId(req.params.id);
  if (!sourceUrl) return res.json({ streams: [] });

  res.json({
    streams: [
      {
        name: "SoloLatino",
        title: "Abrir en SoloLatino",
        externalUrl: sourceUrl
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`SoloLatino Stremio addon running on port ${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});
