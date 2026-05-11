/**
 * GET /api/instagram-image?url=https://www.instagram.com/p/CODE/&img_index=1
 * Redirige (302) a la imagen en CDN. Carruseles: la página /embed/ lista las fotos en orden.
 */

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }

  var rawUrl = req.query && req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Falta el parámetro url.");
    return;
  }

  var imgIndex = parseInt(String((req.query && req.query.img_index) || "1"), 10);
  if (!isFinite(imgIndex) || imgIndex < 1) imgIndex = 1;

  try {
    var parsedForIndex = new URL(rawUrl);
    var idxFromUrl = parsedForIndex.searchParams.get("img_index");
    if (idxFromUrl) {
      var parsedIdx = parseInt(idxFromUrl, 10);
      if (isFinite(parsedIdx) && parsedIdx >= 1) imgIndex = parsedIdx;
    }
  } catch (e1) {}

  var normalized = normalizeInstagramPostUrl(rawUrl);
  if (!normalized) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("URL no válida: usa un post instagram.com/p/… , /reel/… o /tv/…");
    return;
  }

  var ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

  var embedPlainUrl = normalized.replace(/\/+$/, "") + "/embed/";
  var htmlEmbed = "";
  try {
    var rEmb = await fetch(embedPlainUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        Referer: "https://www.instagram.com/",
      },
    });
    htmlEmbed = await rEmb.text();
  } catch (e2) {
    htmlEmbed = "";
  }

  var images = extractCarouselFromEmbed(htmlEmbed);

  if (images.length < imgIndex) {
    var htmlMain = "";
    try {
      var rMain = await fetch(normalized, {
        redirect: "follow",
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        },
      });
      htmlMain = await rMain.text();
    } catch (e3) {
      htmlMain = "";
    }
    images = mergeUniqueUrls(images, extractInstagramLegacy(htmlMain));
  }

  var chosen = pickImageStrict(images, imgIndex);

  if (!chosen && imgIndex === 1) {
    chosen = await microlinkFirstImage(normalized);
  }

  if (!chosen) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "No se obtuvo la foto " +
        imgIndex +
        " del post. Si es la 2.ª de un carrusel, Instagram a veces cambia el HTML; sube la foto a Drive o prueba de nuevo más tarde."
    );
    return;
  }

  res.statusCode = 302;
  res.setHeader("Location", chosen);
  res.setHeader("Cache-Control", "public, s-maxage=43200, stale-while-revalidate=86400");
  res.end();
};

function normalizeInstagramPostUrl(input) {
  try {
    var u = new URL(input);
    if (!u.hostname.endsWith("instagram.com")) return null;
    var path = u.pathname.replace(/\/+$/, "");
    var m = path.match(/^\/(p|reel|tv)\/([^/]+)/i);
    if (!m) return null;
    return "https://www.instagram.com/" + m[1].toLowerCase() + "/" + m[2] + "/";
  } catch (e) {
    return null;
  }
}

function mergeUniqueUrls(a, b) {
  var out = a.slice();
  for (var i = 0; i < b.length; i++) {
    if (out.indexOf(b[i]) === -1) out.push(b[i]);
  }
  return out;
}

function decodeIgUrlChunk(raw) {
  return String(raw || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&");
}

function collectScontentUrlsFromHtml(html) {
  var seen = {};
  var ordered = [];
  function addAll(re) {
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      if (seen[m[0]]) continue;
      seen[m[0]] = true;
      ordered.push(m[0]);
    }
  }
  addAll(/https:\/\/scontent[^"'\\\s<>]*\.(?:jpg|jpeg|webp)(?:\?[^"'\\\s<>]*)?/gi);
  addAll(/https:\\\/\\\/scontent[^"'\\\s<>]*\.(?:jpg|jpeg|webp)(?:\?[^"'\\\s<>]*)?/gi);
  return ordered.map(decodeIgUrlChunk);
}

function isProfilePicUrl(u) {
  return u.indexOf("/v/t51.2885-19/") !== -1;
}

function isVideoNframeCoverUrl(u) {
  try {
    var clean = u.replace(/&amp;/g, "&");
    var m = clean.match(/(?:^|[?&])efg=([^&]+)/);
    if (!m) return false;
    var b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var json = Buffer.from(b64, "base64").toString("utf8");
    return json.indexOf("video_nframe_cover_frame") !== -1;
  } catch (e) {
    return false;
  }
}

function mediaKeyFromPostUrl(u) {
  var m = u.match(/\/(\d{6,}_\d+_\d+_n\.(?:jpg|jpeg|webp))/i);
  return m ? m[1] : u;
}

function urlQualityScore(u) {
  var m = u.match(/s(\d+)x(\d+)/i);
  if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
  if (u.indexOf("1080") !== -1) return 1080 * 1080;
  if (u.indexOf("640") !== -1) return 640 * 640;
  return 10000;
}

/** Orden de carrusel desde /embed/ (excluye avatar y fotogramas basura de vídeo). */
function extractCarouselFromEmbed(html) {
  var urls = collectScontentUrlsFromHtml(html);
  urls = urls.filter(function (u) {
    if (isProfilePicUrl(u)) return false;
    if (isVideoNframeCoverUrl(u)) return false;
    return true;
  });

  var bestByKey = {};
  urls.forEach(function (u) {
    var k = mediaKeyFromPostUrl(u);
    if (!bestByKey[k] || urlQualityScore(u) > urlQualityScore(bestByKey[k])) bestByKey[k] = u;
  });

  var order = [];
  var seen = {};
  urls.forEach(function (u) {
    var k = mediaKeyFromPostUrl(u);
    if (seen[k]) return;
    seen[k] = true;
    order.push(bestByKey[k]);
  });
  return order;
}

function extractInstagramLegacy(html) {
  var ordered = [];
  function push(raw) {
    if (!raw || typeof raw !== "string") return;
    var u = decodeIgUrlChunk(raw);
    if (!/^https?:\/\//i.test(u)) return;
    if (u.indexOf("cdninstagram.com") === -1 && u.indexOf("fbcdn.net") === -1) return;
    if (ordered.indexOf(u) !== -1) return;
    ordered.push(u);
  }

  var m;
  var reDisplay = /"display_url"\s*:\s*"([^"]+)"/g;
  while ((m = reDisplay.exec(html)) !== null) push(m[1]);

  if (ordered.length < 2) {
    var reRaw =
      /https:\/\/scontent(?:\.cdninstagram\.com|\.[^/"'\s]+\.cdninstagram\.com)\/[^"'\\\s<>]+?\.(?:jpg|jpeg|webp)/gi;
    while ((m = reRaw.exec(html)) !== null) push(m[0]);
  }

  return ordered;
}

function pickImageStrict(images, imgIndex) {
  if (!images || !images.length) return null;
  if (imgIndex <= images.length) return images[imgIndex - 1];
  return null;
}

async function microlinkFirstImage(postUrl) {
  try {
    var api = "https://api.microlink.io/?url=" + encodeURIComponent(postUrl);
    var r = await fetch(api, { headers: { "User-Agent": "ganesha-jewelry-web/1.0" } });
    if (!r.ok) return null;
    var j = await r.json();
    var u = j && j.data && j.data.image && j.data.image.url;
    return typeof u === "string" ? u : null;
  } catch (e) {
    return null;
  }
}
