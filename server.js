const express = require("express");
const cheerio = require("cheerio");
const manifest = require("./manifest.json");

const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json");
  next();
});

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

async function getCinemetaMeta(type, imdbId) {
  try {
    const cleanId = imdbId.split(":")[0];
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${cleanId}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.meta || null;
  } catch (e) {
    console.error("Cinemeta fetch error:", e.message);
    return null;
  }
}

async function searchSoloLatino(title) {
  try {
    const searchUrl = `https://sololatino.net/?s=${encodeURIComponent(title)}`;
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9"
      }
    });

    if (!response.ok) {
      console.error(`SoloLatino status error: ${response.status}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const firstResult = $(".result-item, .item, article").find("a").first().attr("href");
    return firstResult || null;
  } catch (e) {
    console.error("SoloLatino search error:", e.message);
    return null;
  }
}

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const parts = id.split(":");
  const imdbId = parts[0];
  const season = parts[1];
  const episode = parts[2];

  const meta = await getCinemetaMeta(type, imdbId);
  if (!meta || !meta.name) {
    return res.json({ streams: [] });
  }

  const targetUrl = await searchSoloLatino(meta.name);
  const streams = [];

  if (targetUrl) {
    streams.push({
      name: "SoloLatino",
      title: `Latino • ${meta.name}${season ? ` S${season}E${episode}` : ""}`,
      externalUrl: targetUrl
    });
  }

  res.json({ streams });
});

app.listen(PORT, () => {
  console.log(`Stream server active on port ${PORT}`);
});
