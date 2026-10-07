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

// ---> FUNCIÓN ACTUALIZADA CON CABECERAS DE NAVEGADOR REAL <---
async function fetchHtml(url) {
  const now = Date.now();
  const cached = cache.get(url);

  if (cached && now - cached.time < CACHE_TTL) {
    return cached.html;
  }

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1"
    }
  });

  if (!r.ok) {
    throw new Error(`HTTP ${r.status} while fetching ${url}`);
  }

  const html = await r.text();

  cache.set(url, {
    time: now,
    html
  });

  return html;
}

function classifyUrl(url) {
  const p = new URL(url).pathname;

  if (p.startsWith("/pelicula/")) {
    return "movie";
  }

  if (
    p.startsWith("/serie/") ||
    p.startsWith("/anime/") ||
    p.startsWith("/dorama/")
  ) {
    return "series";
  }

  return null;
}

function extractCatalogItems(html, type) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const href = absoluteUrl($(a).attr("href"));

    if (!href || seen.has(href)) {
      return;
    }

    const detected = classifyUrl(href);

    if (detected !== type) {
      return;
    }

    const text = clean($(a).text());
    const parentText = clean($(a).parent().text());
    const combined = clean(`${text} ${parentText}`);

    if (!text && !parentText) {
      return;
    }

    const title =
      text ||
      clean($(a).find("img").attr("alt")) ||
      slugFromUrl(href);

    const img =
      $(a).find("img").first().attr("src") ||
      $(a).find("img").first().attr("data-src");

    let year;

    const yearMatch = combined.match(/\b(19|20)\d{2}\b/);

    if (yearMatch) {
      year = yearMatch[0];
    }

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
    const fallback = await fetchHtml(
      `${BASE}/buscar?q=${encodeURIComponent(search)}`
    );

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

  const title =
    clean($("h1").first().text()) ||
    clean($('meta[property="og:title"]').attr("content"));

  const description =
    clean($('meta[name="description"]').attr("content")) ||
    clean($('meta[property="og:description"]').attr("content"));

  const poster =
    $('meta[property="og:image"]').attr("content") ||
    absoluteUrl(
      $("img")
        .filter((_, el) => {
          const alt = clean($(el).attr("alt"));

          return (
            alt &&
            title &&
            alt.toLowerCase().includes(title.toLowerCase())
          );
        })
        .first()
        .attr("src")
    );

  const bodyText = clean($("body").text());

  const yearMatch = bodyText.match(/\b(19|20)\d{2}\b/);

  const ratingMatch = bodyText.match(
    /(?:IMDb|TMDB)?\s*(\d+(?:\.\d+)?)\s*(?:\/10)?/i
  );

  const genres = [];

  $("a[href]").each((_, a) => {
    const text = clean($(a).text());

    if (
      text &&
      /^(Drama|Comedia|Suspense|Acción|Animación|Crimen|Terror|Aventura|Familia|Romance|Misterio|Ciencia Ficción|Fantasía|Documental|Historia|Música|Anime|Bélica|Kids|Western|Reality)$/i.test(
        text
      )
    ) {
      if (!genres.includes(text)) {
        genres.push(text);
      }
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

  if (ratingMatch) {
    meta.imdbRating = ratingMatch[1];
  }

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

    if (!href || seen.has(href)) {
      return;
    }

    const text = clean($(a).text());

    const m = text.match(/\bE(\d+)\b/i);

    if (!m) {
      return;
    }

    const seasonText = clean($(a).parent().text());

    const seasonMatch = seasonText.match(
      /(?:Temporada|Season)\s*(\d+)/i
    );

    const season = seasonMatch
      ? Number(seasonMatch[1])
      : 1;

    const episode = Number(m[1]);

    videos.push({
      id: `${meta.id}:s${season}e${episode}`,
      title: text,
      season,
      episode,

      overview: clean($(a).parent().text()).slice(0, 500),

      thumbnail: meta.poster,

      released: undefined,

      // Guardamos la página del episodio.
      _sourceUrl: href
    });

    seen.add(href);
  });

  return videos.slice(0, 300);
}

function sourceUrlFromId(id) {
  const m = String(id).match(
    /^sl:(movie|series):(.+?)(?::s\d+e\d+)?$/
  );

  if (!m) {
    return null;
  }

  const type = m[1];
  const slug = m[2];

  return `${BASE}/${
    type === "movie"
      ? "pelicula"
      : "serie"
  }/${slug}`;
}

function episodeInfoFromId(id) {
  const m = String(id).match(
    /^sl:series:(.+?):s(\d+)e(\d+)$/
  );

  if (!m) {
    return null;
  }

  return {
    seriesSlug: m[1],
    season: Number(m[2]),
    episode: Number(m[3])
  };
}

function extractMediaUrls(html, pageUrl) {
  const $ = cheerio.load(html);

  const candidates = [];

  function add(value, typeHint = "") {
    if (!value) {
      return;
    }

    const valueClean = String(value).trim();

    if (!valueClean) {
      return;
    }

    try {
      const url = new URL(valueClean, pageUrl).href;

      if (!/^https?:\/\//i.test(url)) {
        return;
      }

      const lower = url.toLowerCase();

      let type = typeHint;

      if (!type) {
        if (lower.includes(".m3u8")) {
          type = "application/x-mpegURL";
        } else if (lower.includes(".mpd")) {
          type = "application/dash+xml";
        } else if (lower.includes(".webm")) {
          type = "video/webm";
        } else if (lower.includes(".mp4")) {
          type = "video/mp4";
        }
      }

      candidates.push({
        url,
        type
      });
    } catch {}
  }

  // <video src="">
  $("video[src]").each((_, el) => {
    add(
      $(el).attr("src"),
      $(el).attr("type")
    );
  });

  // <source src="">
  $("video source[src], source[src]").each(
    (_, el) => {
      add(
        $(el).attr("src"),
        $(el).attr("type")
      );
    }
  );

  // OpenGraph
  $('meta[property="og:video"]').each(
    (_, el) => {
      add($(el).attr("content"));
    }
  );

  $('meta[property="og:video:url"]').each(
    (_, el) => {
      add($(el).attr("content"));
    }
  );

  // Links e iframes
  $("a[href], iframe[src]").each(
    (_, el) => {
      add(
        $(el).attr("href") ||
          $(el).attr("src")
      );
    }
  );

  const rawMatches =
    html.match(
      /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4|webm|mpd)(?:\?[^"'\\\s<>]*)?/gi
    ) || [];

  for (const match of rawMatches) {
    add(match);
  }

  const unique = [];
  const seen = new Set();

  for (const item of candidates) {
    if (seen.has(item.url)) {
      continue;
    }

    seen.add(item.url);
    unique.push(item);
  }

  return unique;
}

function streamTypeForUrl(url, type) {
  const lower = url.toLowerCase();

  if (type) {
    return type;
  }

  if (lower.includes(".m3u8")) {
    return "application/x-mpegURL";
  }

  if (lower.includes(".mpd")) {
    return "application/dash+xml";
  }

  if (lower.includes(".webm")) {
    return "video/webm";
  }

  if (lower.includes(".mp4")) {
    return "video/mp4";
  }

  return undefined;
}

async function resolveEpisodeUrl(
  seriesUrl,
  season,
  episode
) {
  const html = await fetchHtml(seriesUrl);

  const $ = cheerio.load(html);

  let found = null;

  $("a[href]").each((_, a) => {
    if (found) {
      return;
    }

    const href = absoluteUrl(
      $(a).attr("href")
    );

    if (!href) {
      return;
    }

    const text = clean($(a).text());

    const parentText = clean(
      $(a).parent().text()
    );

    const episodeMatch =
      text.match(/\bE(\d+)\b/i) ||
      parentText.match(/\bE(\d+)\b/i);

    if (
      !episodeMatch ||
      Number(episodeMatch[1]) !== episode
    ) {
      return;
    }

    const seasonMatch =
      parentText.match(
        /(?:Temporada|Season)\s*(\d+)/i
      );

    if (
      seasonMatch &&
      Number(seasonMatch[1]) !== season
    ) {
      return;
    }

    found = href;
  });

  return found;
}

async function resolveStreams(id, type) {
  let pageUrl = sourceUrlFromId(id);

  if (!pageUrl) {
    return [];
  }

  if (type === "series") {
    const info = episodeInfoFromId(id);

    if (info) {
      pageUrl = await resolveEpisodeUrl(
        pageUrl,
        info.season,
        info.episode
      );

      if (!pageUrl) {
        return [];
      }
    }
  }

  const html = await fetchHtml(pageUrl);

  const media =
    extractMediaUrls(
      html,
      pageUrl
    );

  return media.map(
    (item, index) => ({
      name:
        `SoloLatino · Servidor ${index + 1}`,

      title: "Reproducir",

      url: item.url,

      type: streamTypeForUrl(
        item.url,
        item.type
      )
    })
  );
}

app.get(
  "/manifest.json",
  (_, res) => {
    res.json(manifest);
  }
);

app.get(
  "/",
  (_, res) => {
    res.type("html").send(`
      <html>
        <head>
          <meta charset="utf-8">
          <title>SoloLatino Stremio Addon</title>
        </head>

        <body
          style="
            font-family:system-ui;
            max-width:720px;
            margin:40px auto;
            padding:20px
          "
        >

          <h1>
            SoloLatino • Stremio Addon
          </h1>

          <p>
            Catálogo y metadatos con
            resolución de fuentes de vídeo
            autorizadas.
          </p>

          <p>
            <a href="/manifest.json">
              Instalar / abrir manifest.json
            </a>
          </p>

        </body>
      </html>
    `);
  }
);

app.get(
  "/catalog/:type/:id.json",
  async (req, res) => {
    try {
      const type = req.params.type;
      const id = req.params.id;

      if (
        !["movie", "series"].includes(type)
      ) {
        return res.json({
          metas: []
        });
      }

      const search =
        req.query.search
          ? String(req.query.search)
          : "";

      const skip = Math.max(
        0,
        Number(req.query.skip || 0)
      );

      const expected =
        type === "movie"
          ? "sololatino-movies"
          : "sololatino-series";

      if (id !== expected) {
        return res.json({
          metas: []
        });
      }

      const metas =
        await catalog(
          type,
          search,
          skip
        );

      res.json({
        metas
      });
    } catch (err) {
      console.error(err);

      res.status(502).json({
        metas: [],
        error:
          "No se pudo consultar el catálogo."
      });
    }
  }
);

app.get(
  "/meta/:type/:id.json",
  async (req, res) => {
    try {
      const {
        type,
        id
      } = req.params;

      const sourceUrl =
        sourceUrlFromId(id);

      if (!sourceUrl) {
        return res.json({
          meta: null
        });
      }

      const html =
        await fetchHtml(
          sourceUrl
        );

      const meta =
        extractMetaFromPage(
          html,
          sourceUrl,
          type
        );

      res.json({
        meta
      });
    } catch (err) {
      console.error(err);

      res.status(502).json({
        meta: null,
        error:
          "No se pudo consultar el contenido."
      });
    }
  }
);

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {
    try {
      const {
        type,
        id
      } = req.params;

      if (
        !["movie", "series"].includes(type)
      ) {
        return res.json({
          streams: []
        });
      }

      const streams =
        await resolveStreams(
          id,
          type
        );

      res.json({
        streams
      });
    } catch (err) {
      console.error(
        "Stream error:",
        err
      );

      res.status(502).json({
        streams: [],
        error:
          "No se pudo encontrar una fuente de vídeo compatible."
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `SoloLatino Stremio addon running on port ${PORT}`
    );

    console.log(
      `Manifest: http://localhost:${PORT}/manifest.json`
    );
  }
);
  
