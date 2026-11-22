// Reads a product page for Ma Pile ("add from a link"): suggested title, brand, price and the page's
// most representative pictures. Signed-in users only.
//
//   POST {url}            → {url, site, title, brand, price, currency, images: [...], blocked?}
//   POST {image, page?}   → the picture's bytes (so the app can shrink it and store it in its own storage,
//                           instead of linking to a shop picture that may disappear)
//
// Shops that block servers (Amazon, LEGO, Decathlon…) are read through Microlink (microlink.io, free tier):
// only the product page's address is sent to it.
// Safety: http(s) only, no local or private addresses, 10 s timeout, pages read up to 2 MB, pictures up to 8 MB.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.6' };

function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  }
  if (h.includes(':')) return null;                       // IPv6 literals: not needed for shops
  if (/\.supabase\.(co|in)$/.test(h)) return null;
  return u;
}
async function get(u: URL, accept: string, max: number, referer?: string): Promise<{ res: Response; bytes: Uint8Array } | null> {
  let url = u;
  for (let hop = 0; hop < 5; hop++) {                     // follow redirects by hand, checking each address
    const res = await fetch(url, { headers: { ...HEADERS, Accept: accept, ...(referer ? { Referer: referer } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = safeUrl(new URL(res.headers.get('location')!, url).href);
      if (!next) return null;
      url = next; continue;
    }
    const reader = res.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > max) { await reader.cancel(); break; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(Math.min(size, max)); let o = 0;
    for (const c of chunks) { bytes.set(c.subarray(0, bytes.length - o), o); o += c.length; if (o >= bytes.length) break; }
    Object.defineProperty(res, 'finalUrl', { value: url.href });
    return { res, bytes };
  }
  return null;
}

const decode = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const clean = (s: string) => decode(s || '').replace(/\s+/g, ' ').trim();
function metas(html: string) {
  const out: Record<string, string[]> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (key && val != null) (out[key.toLowerCase()] ||= []).push(clean(val));
  }
  return out;
}
function products(html: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const o = n as Record<string, unknown>, t = o['@type'];
    if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'ProductGroup') found.push(o);
    if (o['@graph']) walk(o['@graph']);
    if (o.mainEntity) walk(o.mainEntity);
  };
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* broken JSON-LD: skipped */ }
  }
  return found;
}
const imgList = (v: unknown): string[] => !v ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(imgList)
  : typeof v === 'object' ? imgList((v as Record<string, unknown>).url || (v as Record<string, unknown>).contentUrl) : [];

// Shop names glued to page titles: "Lampe X | Maisons du Monde", "Amazon.fr : Lampe X : Cuisine et Maison".
function tidyTitle(t: string, site: string, host: string): string {
  let s = clean(t);
  const shop = (host.replace(/^www\./, '').split('.').slice(-2, -1)[0] || '').toLowerCase();
  const isShop = (p: string) => { const x = p.toLowerCase().trim(); return !x || (shop.length > 2 && x.replace(/[^a-z0-9]/g, '').includes(shop.replace(/[^a-z0-9]/g, ''))) || (!!site && x === site.toLowerCase()) || /^(amazon|fnac|cdiscount|darty|boulanger|ebay|etsy|vinted|leboncoin|decathlon|ikea)\b/.test(x); };
  if (/amazon\./.test(host)) {
    // "Amazon.fr : LEGO 10280 Bouquet de fleurs : Jeux et Jouets" → the product part
    const parts = s.split(/\s+:\s+/).filter(p => !isShop(p));
    if (parts.length) s = parts.sort((a, b) => b.length - a.length)[0];
  } else {
    // Drop the shop's name at either end only, so product names with dashes stay whole.
    for (let k = 0; k < 2; k++) {
      const end = s.match(/^(.*\S)\s+[|–—:-]\s+([^|–—:]+)$/); if (end && isShop(end[2])) s = end[1];
      const start = s.match(/^([^|–—:]+?)\s+[|–—:-]\s+(.+)$/); if (start && isShop(start[1])) s = start[2];
    }
  }
  return s.replace(/^(achat|acheter)\s+/i, '').slice(0, 140);
}
// When the shop hides the page from robots, the address itself often names the product.
function titleFromUrl(u: URL): string {
  const seg = u.pathname.split('/').filter(p => /[a-z]/i.test(p) && /[-_]/.test(p) && p.length > 8).sort((a, b) => b.length - a.length)[0] || '';
  const s = decodeURIComponent(seg).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\s\S*\d\S{6,}$/, '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function pictures(html: string, m: Record<string, string[]>, prods: Record<string, unknown>[], base: URL): string[] {
  const raw: string[] = [];
  for (const p of prods) raw.push(...imgList(p.image));
  raw.push(...(m['og:image:secure_url'] || []), ...(m['og:image'] || []), ...(m['og:image:url'] || []), ...(m['twitter:image'] || []), ...(m['twitter:image:src'] || []), ...(m['image'] || []));
  // Amazon: the large product picture lives in data attributes.
  for (const a of html.matchAll(/data-old-hires\s*=\s*"([^"]+)"/gi)) raw.push(a[1]);
  for (const a of html.matchAll(/data-a-dynamic-image\s*=\s*"([^"]+)"/gi)) { try { raw.push(...Object.keys(JSON.parse(decode(a[1])))); } catch { /* skip */ } }
  const linkImg = html.match(/<link[^>]+rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i); if (linkImg) raw.push(linkImg[1]);
  // Then the page's own pictures, skipping logos, icons and tiny images.
  for (const t of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = t[0];
    const src = (tag.match(/\b(?:data-src|data-lazy-src|data-original|src)\s*=\s*["']([^"']+)["']/i) || [])[1]
      || ((tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i) || [])[1] || '').split(',').pop()?.trim().split(/\s+/)[0];
    if (!src) continue;
    const w = +((tag.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || 0), h = +((tag.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1] || 0);
    if ((w && w < 150) || (h && h < 150)) continue;
    raw.push(src);
    if (raw.length > 60) break;
  }
  const seen = new Set<string>(), out: string[] = [];
  for (const r of raw) {
    let u: URL; try { u = new URL(decode(r.trim()), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const s = u.href;
    if (/\.svg(\?|$)|\.gif(\?|$)|sprite|logo|icon|favicon|pixel|spacer|placeholder|blank\.|badge|flag|avatar|rating|stars?\b|payment|banner/i.test(s)) continue;
    const key = s.replace(/[?#].*$/, '').replace(/\._[^/]*_\./, '.');   // same Amazon picture in several sizes
    if (seen.has(key)) continue;
    seen.add(key); out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

// Fallback for pages that refuse servers: Microlink renders them with a real browser.
async function microlink(url: string): Promise<{ title: string; image: string; site: string; brand: string; price: number | null } | null> {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true&prerender=auto`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const d = (await r.json())?.data; if (!d) return null;
    return { title: clean(d.title || ''), image: d.image?.url || '', site: clean(d.publisher || ''), brand: clean(d.author || ''), price: null };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // Signed-in user, or the maintenance key kept server-side (private.settings 'admin_key') for tests.
  const key = req.headers.get('x-admin-key');
  let ok = false;
  if (key) { const { data } = await admin.rpc('app_secret', { p_key: 'admin_key' }); ok = !!data && key === data; }
  else { const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''); const { data: who } = await admin.auth.getUser(jwt); ok = !!who?.user; }
  if (!ok) return json({ error: 'not_signed_in' }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  try {
    if (body.image) {
      const u = safeUrl(String(body.image));
      if (!u) return json({ error: 'bad_url' }, 400);
      const page = safeUrl(String(body.page || ''));
      const r = await get(u, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 8_000_000, page ? page.origin + '/' : undefined);
      const type = r?.res.headers.get('content-type') || '';
      if (!r || !r.res.ok || !/^image\/(jpeg|png|webp|avif|gif)/i.test(type)) return json({ error: 'not_an_image' }, 422);
      return new Response(r.bytes, { headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'no-store' } });
    }

    const u = safeUrl(String(body.url || ''));
    if (!u) return json({ error: 'bad_url' }, 400);
    const r = await get(u, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 2_000_000);
    if (!r) return json({ error: 'bad_url' }, 400);
    const final = new URL((r.res as unknown as { finalUrl: string }).finalUrl || u.href);
    const host = final.hostname.replace(/^www\./, '');
    // Some French shops still serve ISO-8859-1 pages.
    let cs = ((r.res.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i) || [])[1];
    if (!cs) cs = (new TextDecoder('latin1').decode(r.bytes.slice(0, 4000)).match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1];
    let html: string;
    try { html = new TextDecoder(cs || 'utf-8').decode(r.bytes); } catch { html = new TextDecoder().decode(r.bytes); }
    const blocked = !r.res.ok || /captcha|robot check|access denied|are you a human|vérifiez que vous êtes humain/i.test(html.slice(0, 20000));
    const m = metas(html), prods = products(html), p = prods[0] || {};
    if (blocked || !(m['og:image'] || prods.length)) {
      const ml = await microlink(final.href);
      const t = ml ? tidyTitle(ml.title, ml.site, host) : '';
      if (ml && t && !/captcha|robot|access denied|just a moment|introuvable|not found|^404\b|^amazon(\.\w+)?$/i.test(t)) {
        const images = ml.image && !/logo|sprite/i.test(ml.image) ? [ml.image] : [];
        if (!blocked) images.push(...pictures(html, m, prods, final).filter(i => i !== ml.image));
        return json({ url: final.href, site: ml.site || host, title: t, brand: '', price: null, currency: null, images: images.slice(0, 8), blocked: false, via: 'microlink' });
      }
    }
    const site = (m['og:site_name'] || [])[0] || host;
    const rawTitle = clean(String(p.name || '')) || (m['og:title'] || [])[0] || (m['twitter:title'] || [])[0] || clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const title = (!blocked && rawTitle ? tidyTitle(rawTitle, site, host) : '') || titleFromUrl(final);
    const brandRaw = p.brand as unknown;
    const brand = clean(typeof brandRaw === 'string' ? brandRaw : String((brandRaw as Record<string, unknown>)?.name || '')) || (m['product:brand'] || m['og:brand'] || [])[0] || '';
    const offers = (Array.isArray(p.offers) ? p.offers[0] : p.offers) as Record<string, unknown> | undefined;
    const priceRaw = offers?.price ?? offers?.lowPrice ?? (m['product:price:amount'] || m['og:price:amount'] || m['price'] || [])[0];
    const price = priceRaw != null && priceRaw !== '' ? Math.round(parseFloat(String(priceRaw).replace(/\s/g, '').replace(',', '.')) * 100) / 100 : null;
    const currency = String(offers?.priceCurrency || (m['product:price:currency'] || m['og:price:currency'] || [])[0] || (price != null ? 'EUR' : '')) || null;
    return json({
      url: final.href, site: clean(site), title, brand: brand.slice(0, 80),
      price: price != null && isFinite(price) && price > 0 ? price : null, currency,
      images: blocked ? [] : pictures(html, m, prods, final), blocked,
    });
  } catch (e) {
    return json({ error: /timed? ?out|abort/i.test(String(e)) ? 'timeout' : 'unreachable' }, 502);
  }
});
