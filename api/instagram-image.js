/**
 * GET /api/instagram-image?url=https://www.instagram.com/p/CODE/&img_index=1
 * Descarga la imagen en el servidor y la devuelve (evita CORP same-origin del CDN en img_index≥2).
 * ?redirect=1 fuerza 302 al CDN (solo depuración).
 */

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
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
    var hint =
      instagramUrlLooksLikePlaceholder(rawUrl)
        ? " Copia el enlace REAL del post (barra de direcciones), no un ejemplo con {codigo} ni texto inventado."
        : "";
    res.end("URL no válida: usa instagram.com/p/CÓDIGO con el código que ves en la URL del post al abrirlo en el navegador." + hint);
    return;
  }

  /** Escritorio: Instagram devuelve HTML “vacío” (solo bundles JS) sin URLs scontent en /embed/. La app móvil sí recibe img src en el HTML. */
  var uaDesktop =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  var uaInstagramAndroid =
    "Instagram 275.0.0.27.98 Android (31/12; 440dpi; 1080x2274; samsung; SM-G991B; o1s; exynos2100; es_ES; 458229237)";

  var embedPlainUrl = normalized.replace(/\/+$/, "") + "/embed/";
  var htmlEmbed = "";
  try {
    var rEmb = await fetch(embedPlainUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": uaInstagramAndroid,
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
          "User-Agent": uaDesktop,
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

  var chosen = pickCarouselImage(images, imgIndex);

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

  var forceRedirect = req.query && String(req.query.redirect) === "1";

  if (forceRedirect) {
    res.statusCode = 302;
    res.setHeader("Location", chosen);
    res.setHeader("Cache-Control", "public, s-maxage=43200, stale-while-revalidate=86400");
    res.end();
    return;
  }

  var cdnHeaders = {
    "User-Agent": uaDesktop,
    Referer: "https://www.instagram.com/",
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };

  try {
    var rImg = await fetch(chosen, {
      redirect: "follow",
      headers: cdnHeaders,
    });
    if (!rImg.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Instagram devolvió HTTP " + rImg.status + " al obtener la imagen.");
      return;
    }
    var buf = Buffer.from(await rImg.arrayBuffer());
    var ct = rImg.headers.get("content-type") || "image/jpeg";
    res.statusCode = 200;
    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.end(buf);
  } catch (e4) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("No se pudo descargar la imagen desde Instagram.");
  }
};

function instagramUrlLooksLikePlaceholder(input) {
  var s = String(input || "").toLowerCase();
  return (
    s.indexOf("%7b") !== -1 ||
    s.indexOf("{codigo}") !== -1 ||
    s.indexOf("{code}") !== -1 ||
    /\/p\/\{/.test(s)
  );
}

function isInvalidInstagramShortcode(code) {
  var s = String(code || "").trim();
  if (!s) return true;
  try {
    s = decodeURIComponent(s);
  } catch (e1) {}
  var lower = s.toLowerCase();
  if (/[{}]/.test(s)) return true;
  if (lower === "codigo" || lower === "code" || lower === "shortcode" || lower === "tu_codigo") return true;
  // Shortcodes reales son alfanuméricos + guiones (ej. CyMHH0dvHNf)
  if (!/^[a-z0-9_-]+$/i.test(s)) return true;
  return false;
}

function normalizeInstagramPostUrl(input) {
  try {
    var u = new URL(input);
    if (!u.hostname.endsWith("instagram.com")) return null;
    var path = u.pathname.replace(/\/+$/, "");
    var m = path.match(/^\/(p|reel|tv)\/([^/]+)/i);
    if (!m) return null;
    if (isInvalidInstagramShortcode(m[2])) return null;
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

/** Decodifica el JSON del parámetro efg= (Meta usa base64 url-safe en URLs CDN). */
function decodeInstagramEfgJson(u) {
  try {
    var clean = u.replace(/&amp;/g, "&");
    var m = clean.match(/(?:^|[?&])efg=([^&]+)/);
    if (!m) return "";
    var b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    return Buffer.from(b64, "base64").toString("utf8");
  } catch (e) {
    return "";
  }
}

/**
 * Excluye avatar, fotogramas de vídeo y portadas de reel que NO son la “foto 2” del carrusel.
 * Antes solo filtrábamos video_nframe; quedaba video_default_cover_frame → imagen equivocada (otro producto).
 */
function isBadInstagramCarouselCdnUrl(u) {
  if (isProfilePicUrl(u)) return true;
  var j = decodeInstagramEfgJson(u);
  if (!j) return false;
  var lower = j.toLowerCase();
  if (lower.indexOf("profile_pic") !== -1) return true;
  if (lower.indexOf("cover_frame") !== -1) return true;
  if (lower.indexOf("video_nframe") !== -1) return true;
  if (lower.indexOf("video_default") !== -1) return true;
  return false;
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

/** Orden de carrusel desde /embed/ (solo URLs “foto”; sin covers de vídeo ni avatar). */
function extractCarouselFromEmbed(html) {
  var urls = collectScontentUrlsFromHtml(html);
  urls = urls.filter(function (u) {
    return !isBadInstagramCarouselCdnUrl(u);
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

/**
 * Si pides img_index=2 pero el embed solo publica una foto real (el resto son vídeos/covers filtrados),
 * devolvemos la misma que la 1 para no mostrar un fotograma u otro producto.
 */
function pickCarouselImage(images, imgIndex) {
  if (!images || !images.length) return null;
  var chosen = pickImageStrict(images, imgIndex);
  if (chosen) return chosen;
  if (imgIndex >= 2 && images.length >= 1) return images[0];
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
