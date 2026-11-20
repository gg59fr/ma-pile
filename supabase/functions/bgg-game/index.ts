// BoardGameGeek lookups for Ma Pile games. The BGG token never leaves the server:
// it is read from private.settings through public.app_secret('bgg_token').
//
//   POST {title, year?, expansion?}   signed-in user → best BGG match (image, players, time)
//   POST {mode: 'backfill', limit?}   signed-in user → fills that user's games without an image;
//                                     x-admin-key header (private.settings 'admin_key') → the owner's games
//
// Matching: exact name on BGG (primary or alternate names, so French titles work), expansion vs base
// game, then the closest publication year. No confident match → the game is left as is and reported.
// BGG terms: non-commercial use, credit BoardGameGeek, about one request per second.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const API = 'https://boardgamegeek.com/xmlapi2/';
const GAP_MS = 1100;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
let token = '', last = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const norm = (s: string) => decode(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const attr = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}[^>]*value="([^"]*)"`)); return m ? decode(m[1]) : ''; };
const text = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`)); return m ? decode(m[1]) : ''; };

async function bgg(path: string): Promise<string> {
  if (!token) { const { data } = await admin.rpc('app_secret', { p_key: 'bgg_token' }); token = data || ''; }
  if (!token) throw new Error('BGG token missing');
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 202 || r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`BGG HTTP ${r.status}`);
    return await r.text();
  }
  throw new Error('BGG busy');
}

type Hit = { id: string; type: string; name: string; year: number | null };
async function search(q: string, exact: boolean): Promise<Hit[]> {
  const xml = await bgg(`search?type=boardgame,boardgameexpansion${exact ? '&exact=1' : ''}&query=${encodeURIComponent(q)}`);
  return [...xml.matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].slice(0, 200).map(m => ({ type: m[1], id: m[2], name: attr(m[3], 'name'), year: +attr(m[3], 'yearpublished') || null }));
}
function pick(hits: Hit[], title: string, year: number | null, expansion: boolean): Hit | null {
  const want = norm(title);
  let c = hits.filter(h => norm(h.name) === want);
  if (!c.length) return null;
  const typed = c.filter(h => (h.type === 'boardgameexpansion') === expansion);
  if (typed.length) c = typed;
  // BGG lists a game once per type; the same id can come back twice.
  c = c.filter((h, i) => c.findIndex(x => x.id === h.id) === i);
  if (c.length === 1) return c[0];
  if (!year) return null;                       // several games share the name and nothing tells them apart
  const dist = (h: Hit) => h.year == null ? 99 : (h.year <= year ? year - h.year : (h.year - year) * 2);
  c.sort((a, b) => dist(a) - dist(b));
  return dist(c[0]) < dist(c[1]) && dist(c[0]) <= 6 ? c[0] : null;
}
async function find(title: string, year: number | null, expansion: boolean): Promise<Hit | null> {
  const tries = [title, title.split(/\s+[:\-–]\s+/)[0]].filter((t, i, a) => t && a.indexOf(t) === i);
  for (const t of tries) {
    const hit = pick(await search(t, true), t, year, expansion);
    if (hit) return hit;
  }
  // Last try: a single BGG game whose name starts with the short title ("Dorfromantik" → "Dorfromantik: The Board Game").
  const short = norm(tries[tries.length - 1]);
  if (short.length >= 5) {
    const c = (await search(tries[tries.length - 1], false)).filter(h => norm(h.name).startsWith(short + ' ') && (h.type === 'boardgameexpansion') === expansion);
    const ids = [...new Set(c.map(h => h.id))];
    if (ids.length === 1) return c[0];
  }
  return null;
}
async function things(ids: string[]) {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 20) {
    const xml = await bgg(`thing?id=${ids.slice(i, i + 20).join(',')}`);
    for (const m of xml.matchAll(/<item type="[^"]+" id="(\d+)">([\s\S]*?)<\/item>/g)) {
      const x = m[2], min = +attr(x, 'minplayers'), max = +attr(x, 'maxplayers');
      const tmin = +attr(x, 'minplaytime'), tmax = +attr(x, 'maxplaytime');
      out.set(m[1], {
        bgg: +m[1], name: attr(x, 'name'), year: +attr(x, 'yearpublished') || null,
        thumb: text(x, 'thumbnail') || null, image: text(x, 'image') || null,
        players: min ? (max && max !== min ? `${min} à ${max}` : `${min}`) : null,
        time: tmin ? (tmax && tmax !== tmin ? `${tmin} à ${tmax}` : `${tmin}`) : (+attr(x, 'playingtime') || null),
      });
    }
  }
  return out;
}

async function userId(req: Request): Promise<string | null> {
  const key = req.headers.get('x-admin-key');
  if (key) {
    const { data } = await admin.rpc('app_secret', { p_key: 'admin_key' });
    if (!data || key !== data) return null;
    const { data: u } = await admin.from('items').select('user_id').limit(1).maybeSingle();
    return u?.user_id ?? null;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = await admin.auth.getUser(jwt);
  return data?.user?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const uid = await userId(req);
  if (!uid) return json({ error: 'not_signed_in' }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* empty body */ }
  try {
    if (body.mode !== 'backfill') {
      const title = String(body.title || '').trim();
      if (!title) return json({ error: 'title_required' }, 400);
      const hit = await find(title, Number(body.year) || null, !!body.expansion);
      if (!hit) return json({ found: false });
      return json({ found: true, ...(await things([hit.id])).get(hit.id) });
    }
    const limit = Math.min(12, Math.max(1, Number(body.limit) || 10));  // stays within the function's time limit
    const { data: games, error } = await admin.from('items').select('id,title,detail,pub_year,extra,photo')
      .eq('user_id', uid).eq('type', 'jeu').is('photo', null).order('created_at').limit(400);
    if (error) throw error;
    const todo = (games || []).filter(g => !(g.extra && (g.extra.bgg || g.extra.bgg_none))).slice(0, limit);
    const matched: { item: typeof todo[number]; id: string }[] = [], missed: string[] = [];
    for (const g of todo) {
      const hit = await find(g.title, g.pub_year, /^extension/i.test(g.detail || ''));
      if (hit) matched.push({ item: g, id: hit.id }); else missed.push(g.title);
      if (!hit) await admin.from('items').update({ extra: { ...(g.extra || {}), bgg_none: true } }).eq('id', g.id);
    }
    const info = await things([...new Set(matched.map(m => m.id))]);
    let filled = 0;
    for (const { item, id } of matched) {
      const t = info.get(id); if (!t) { missed.push(item.title); continue; }
      const extra = { ...(item.extra || {}), bgg: t.bgg, bigImg: t.image || undefined };
      if (!extra.players && t.players) extra.players = t.players;
      if (!extra.time && t.time) extra.time = String(t.time);
      const patch: Record<string, unknown> = { extra, updated_at: Date.now() };
      if (t.thumb) { patch.photo = t.thumb; patch.cover_from = 'bgg'; }
      const { error: e } = await admin.from('items').update(patch).eq('id', item.id);
      if (!e) filled++;
    }
    const remaining = (games || []).filter(g => !(g.extra && (g.extra.bgg || g.extra.bgg_none))).length - todo.length;
    return json({ done: todo.length, filled, missed, remaining: Math.max(0, remaining) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
