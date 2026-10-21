/**
 * DigiCards · Vista previa rica del enlace (WhatsApp, Instagram, Telegram, iMessage, Facebook...)
 *
 * Problema: /clientes/{id}/ entrega un cascarón vacío ("Cargando tarjeta…") y el nombre y las fotos se pintan
 * después con JavaScript. Los previews de enlaces no ejecutan JavaScript, así que solo veían "DigiCards".
 *
 * Solución: esta Edge Function corre delante de la página. Cuando quien pide el enlace es un previsualizador
 * (o se agrega ?og=1 para probar), consulta la API pública y le añade al <head> las etiquetas Open Graph del
 * negocio: nombre, foto 1200x630 y descripción.
 *
 * Seguridad y robustez:
 *  - Usa la MISMA API pública: solo hay vista previa si la tarjeta está Publicada/Entregado y Pagada.
 *  - Los visitantes normales reciben la página tal cual (sin demora extra).
 *  - Cualquier fallo (API lenta, caída, sin datos) devuelve la página original sin tocarla.
 *
 * Instalación: guardar este archivo en  netlify/edge-functions/tarjeta-og.js  del repositorio. No requiere
 * cambiar netlify.toml: la ruta se declara en `config` al final.
 */

const PREVISUALIZADORES = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|discordbot|linkedinbot|pinterest|skypeuripreview|applebot|googlebot|bingbot|snapchat|viber|vkshare|signal|embedly|redditbot|tumblr|\bbot\b|crawler|spider|preview/i;

const TTL_DATOS_MS = 5 * 60 * 1000;
const TTL_API_MS = 10 * 60 * 1000;
const ESPERA_API_MS = 3500;

const cacheDatos = new Map();   // id -> { t, d }
let cacheApi = null;            // { t, url }

/* ------------------------------ utilidades puras ------------------------------ */

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function recortar(s, max) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  var corte = t.slice(0, max);
  var sp = corte.lastIndexOf(' ');
  return (sp > max * 0.6 ? corte.slice(0, sp) : corte).replace(/[\s,.;:·-]+$/, '') + '…';
}

function listaFotos(valor) {
  var s = String(valor == null ? '' : valor).trim();
  if (!s) return [];
  var items;
  if (s.charAt(0) === '{' || s.charAt(0) === '[') {
    try {
      var j = JSON.parse(s);
      items = (Array.isArray(j) ? j : [j]).map(function (x) { return x && x.url ? String(x.url).trim() : ''; });
    } catch (e) { items = []; }
  } else {
    items = s.split(/\r?\n/).map(function (x) { return x.trim(); });
  }
  return items.filter(function (x) {
    return /^https:\/\//i.test(x) && x.indexOf('storage.tally.so/private/') === -1 && !/\.mp4(\?|$)/i.test(x);
  });
}

/** Cloudinary: recorta a la medida pedida y fuerza JPG (WhatsApp no siempre lee webp/avif). Otras URLs quedan igual. */
function imagenOG(url, ancho, alto) {
  var m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?:[^/]+\/)*?(v\d+\/.+)$/i.exec(String(url || ''));
  if (!m) return String(url || '');
  return m[1] + 'c_fill,g_auto,w_' + ancho + ',h_' + alto + ',f_jpg,q_auto/' + m[2];
}

function idDeRuta(pathname) {
  var m = /^\/(?:clientes|ver)\/([^/?#]+)/i.exec(pathname || '');
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

function construirEtiquetas(t, urlCanonica) {
  var nombre = String(t.nombre || t.marca || 'DigiCards').trim();
  var esp = String(t.especialidad || '').trim();
  var desc = String(t.descripcion || '').trim();

  var titulo = recortar(nombre + ' · Tarjeta digital', 70);
  var base = desc || esp || '';
  var descripcion = recortar(base, 130);
  descripcion = (descripcion ? descripcion + ' ' : '') + '👉 Toca para ver mi tarjeta';

  var fotos = listaFotos(t.foto);
  var fuente = fotos[0] || listaFotos(t.logo)[0] || '';
  var imagen = fuente ? imagenOG(fuente, 1200, 630) : '';

  var tags = [
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="' + escAttr(nombre) + '" />',
    '<meta property="og:locale" content="es_CO" />',
    '<meta property="og:title" content="' + escAttr(titulo) + '" />',
    '<meta property="og:description" content="' + escAttr(descripcion) + '" />',
    '<meta property="og:url" content="' + escAttr(urlCanonica) + '" />',
    '<meta name="description" content="' + escAttr(descripcion) + '" />',
    '<meta name="twitter:card" content="' + (imagen ? 'summary_large_image' : 'summary') + '" />',
    '<meta name="twitter:title" content="' + escAttr(titulo) + '" />',
    '<meta name="twitter:description" content="' + escAttr(descripcion) + '" />'
  ];
  if (imagen) {
    tags.push('<meta property="og:image" content="' + escAttr(imagen) + '" />');
    tags.push('<meta property="og:image:secure_url" content="' + escAttr(imagen) + '" />');
    if (imagen !== fuente) {
      tags.push('<meta property="og:image:width" content="1200" />');
      tags.push('<meta property="og:image:height" content="630" />');
    }
    tags.push('<meta property="og:image:alt" content="' + escAttr(nombre) + '" />');
    tags.push('<meta name="twitter:image" content="' + escAttr(imagen) + '" />');
  }
  return { titulo: titulo, etiquetas: tags.join('\n') };
}

/** Inserta título y etiquetas en el <head>. Si la página no tiene </head> la devuelve intacta. (Se usan funciones de reemplazo: un "$" de los datos no se interpreta.) */
function inyectar(html, t, urlCanonica) {
  if (!/<\/head>/i.test(html)) return html;
  var r = construirEtiquetas(t, urlCanonica);
  var out = html;
  var tituloTag = '<title>' + escAttr(r.titulo) + '</title>';
  out = /<title>[^<]*<\/title>/i.test(out)
    ? out.replace(/<title>[^<]*<\/title>/i, function () { return tituloTag; })
    : out.replace(/<\/head>/i, function () { return tituloTag + '\n</head>'; });
  return out.replace(/<\/head>/i, function () { return r.etiquetas + '\n</head>'; });
}

/* ------------------------------ acceso a la API ------------------------------ */

async function urlApi(origen) {
  var env = '';
  try { env = (typeof Netlify !== 'undefined' && Netlify.env && Netlify.env.get('DIGICARDS_API')) || ''; } catch (e) {}
  if (/^https:\/\//i.test(env)) return env;
  if (cacheApi && Date.now() - cacheApi.t < TTL_API_MS) return cacheApi.url;
  var res = await fetch(origen + '/tarjeta/config.js');
  if (!res.ok) return '';
  var m = /DIGICARDS_API\s*=\s*['"]([^'"]+)['"]/.exec(await res.text());
  var url = m && /^https:\/\//i.test(m[1]) ? m[1] : '';
  if (url) cacheApi = { t: Date.now(), url: url };
  return url;
}

async function datosTarjeta(api, id) {
  var c = cacheDatos.get(id);
  if (c && Date.now() - c.t < TTL_DATOS_MS) return c.d;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, ESPERA_API_MS);
  try {
    var res = await fetch(api + '?api=1&id=' + encodeURIComponent(id), { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    var j = await res.json();
    if (!j || !j.ok || !j.tarjeta) return null;
    cacheDatos.set(id, { t: Date.now(), d: j.tarjeta });
    return j.tarjeta;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ Edge Function ------------------------------ */

export default async (request, context) => {
  var respuesta = await context.next();
  try {
    if (request.method !== 'GET') return respuesta;
    var url = new URL(request.url);
    if (respuesta.status !== 200 || !/text\/html/i.test(respuesta.headers.get('content-type') || '')) return respuesta;

    var forzar = url.searchParams.get('og') === '1';
    var ua = request.headers.get('user-agent') || '';
    if (!forzar && !PREVISUALIZADORES.test(ua)) return respuesta;

    var id = idDeRuta(url.pathname);
    if (!id) return respuesta;
    var api = await urlApi(url.origin);
    if (!api) return respuesta;
    var tarjeta = await datosTarjeta(api, id);
    if (!tarjeta) return respuesta;

    var html = await respuesta.clone().text();
    var nuevo = inyectar(html, tarjeta, url.origin + '/clientes/' + encodeURIComponent(id) + '/');
    if (nuevo === html) return respuesta;

    var cabeceras = new Headers(respuesta.headers);
    cabeceras.delete('content-length');
    cabeceras.set('vary', 'User-Agent');
    cabeceras.set('cache-control', 'public, max-age=300');
    return new Response(nuevo, { status: 200, headers: cabeceras });
  } catch (e) {
    return respuesta;   // ante cualquier error, la tarjeta se sirve como siempre
  }
};

export const config = { path: ['/clientes/*', '/ver/*'] };

// Solo para pruebas (Netlify ignora exportaciones extra).
export const _test = { escAttr, recortar, listaFotos, imagenOG, idDeRuta, construirEtiquetas, inyectar };
