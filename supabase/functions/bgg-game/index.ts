// BoardGameGeek lookups for Ma Pile games. The BGG token never leaves the server:
// it is read from private.settings through public.app_secret('bgg_token').
//
//   POST {title, year?, expansion?}   signed-in user → best BGG match (image, players, time)
//   POST {mode: 'search', q}          signed-in user → up to 10 BGG games for a typed name, with full details
//   POST {mode: 'french'}             games with a BGG picture: switch to the French edition's box (12 per call)
//   POST {mode: 'refresh'}            games already linked to BGG: adds designers and age where missing (20 per call)
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
function pick(hits: Hit[], title: string, year: number | null, expansion: boolean, tie?: Hit[]): Hit | null {
  const want = norm(title);
  let c = hits.filter(h => norm(h.name) === want);
  if (!c.length) return null;
  const typed = c.filter(h => (h.type === 'boardgameexpansion') === expansion);
  if (typed.length) c = typed;
  // BGG lists a game once per type; the same id can come back twice.
  c = c.filter((h, i) => c.findIndex(x => x.id === h.id) === i);
  if (c.length === 1) return c[0];
  if (year) {
    const dist = (h: Hit) => h.year == null ? 99 : (h.year <= year ? year - h.year : (h.year - year) * 2);
    c.sort((a, b) => dist(a) - dist(b));
    if (dist(c[0]) < dist(c[1]) && dist(c[0]) <= 6) return c[0];
  }
  // Still several games of that name (the year is often the French edition's): decided by popularity in find().
  if (tie) tie.push(...c);
  return null;
}
async function find(title: string, year: number | null, expansion: boolean): Promise<Hit | null> {
  const tries = [title, title.split(/\s+[:\-–]\s+/)[0]].filter((t, i, a) => t && a.indexOf(t) === i);
  for (const t of tries) {
    const tie: Hit[] = [];
    const hit = pick(await search(t, true), t, year, expansion, tie) || await popular(tie);
    if (hit) return hit;
  }
  // Last try on a broad search: same name once accents are ignored ("Honshu" → "Honshū"),
  // else a single game whose name starts with the short title ("Dorfromantik" → "Dorfromantik: The Board Game").
  const short = norm(tries[tries.length - 1]);
  if (short.length >= 4) {
    const all = (await search(tries[tries.length - 1], false)).filter(h => (h.type === 'boardgameexpansion') === expansion);
    const uniq = (l: Hit[]) => l.filter((h, i) => l.findIndex(x => x.id === h.id) === i);
    const same = uniq(all.filter(h => norm(h.name) === short));
    if (same.length === 1) return same[0];
    if (same.length > 1) return await popular(same);
    const pre = uniq(all.filter(h => norm(h.name).startsWith(short + ' ')));
    if (pre.length === 1) return pre[0];
  }
  return null;
}
// Same name, no year to tell them apart: take the game far more rated on BGG than the others
// (the well-known edition rather than a namesake), otherwise leave it undecided.
async function popular(c: Hit[]): Promise<Hit | null> {
  if (c.length < 2) return null;
  const ids = c.slice(0, 20).map(h => h.id);
  const xml = await bgg(`thing?id=${ids.join(',')}&stats=1`);
  const n = new Map([...xml.matchAll(/<item type="[^"]+" id="(\d+)">([\s\S]*?)<\/item>/g)].map(m => [m[1], +attr(m[2], 'usersrated') || 0]));
  const ranked = c.slice(0, 20).sort((a, b) => (n.get(b.id) || 0) - (n.get(a.id) || 0));
  const top = n.get(ranked[0].id) || 0, next = n.get(ranked[1].id) || 0;
  return top >= 20 && top >= next * 5 ? ranked[0] : null;
}
// Game details. BGG's main picture is the original (often English, often old) box: we look through the
// game's editions ("versions") for a French one with a picture, the closest to the year of the user's copy
// (the year imported from Myludo is the French edition's) or else the newest, and use its box and publisher.
type Version = { id: string; thumb: string; image: string; year: number; langs: string[]; publisher: string };
function frenchVersion(vers: Version[], year: number | null): Version | null {
  const c = vers.filter(v => v.thumb && v.langs.includes('French'));
  if (!c.length) return null;
  const rank = (v: Version) => (v.langs.length === 1 ? 0 : 10000) + (year ? Math.abs((v.year || 0) - year) * 10 : (3000 - (v.year || 0)));
  return c.sort((a, b) => rank(a) - rank(b))[0];
}
async function things(ids: string[], years: Map<string, number | null> = new Map()) {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 4) {            // editions make the answer large: a few games per call
    const xml = await bgg(`thing?id=${ids.slice(i, i + 4).join(',')}&versions=1`);
    const starts = [...xml.matchAll(/<item type="(boardgame|boardgameexpansion)" id="(\d+)">/g)];
    starts.forEach((m, k) => {
      const body = xml.slice(m.index! + m[0].length, k + 1 < starts.length ? starts[k + 1].index : xml.length);
      const vblock = (body.match(/<versions>([\s\S]*?)<\/versions>/) || [])[1] || '';
      const x = body.replace(/<versions>[\s\S]*?<\/versions>/, '');
      const vers: Version[] = [...vblock.matchAll(/<item type="boardgameversion" id="(\d+)">([\s\S]*?)<\/item>/g)].map(v => ({
        id: v[1], thumb: text(v[2], 'thumbnail'), image: text(v[2], 'image'), year: +attr(v[2], 'yearpublished') || 0,
        langs: [...v[2].matchAll(/<link type="language" id="\d+" value="([^"]*)"/g)].map(l => decode(l[1])),
        publisher: decode((v[2].match(/<link type="boardgamepublisher" id="\d+" value="([^"]*)"/) || [])[1] || ''),
      }));
      const fr = frenchVersion(vers, years.get(m[2]) ?? null);
      const min = +attr(x, 'minplayers'), max = +attr(x, 'maxplayers');
      const tmin = +attr(x, 'minplaytime'), tmax = +attr(x, 'maxplaytime');
      const designers = [...x.matchAll(/<link type="boardgamedesigner" id="\d+" value="([^"]*)"/g)].map(d => decode(d[1])).filter(d => d !== '(Uncredited)');
      out.set(m[2], {
        expansion: m[1] === 'boardgameexpansion',
        designers: designers.slice(0, 3), age: +attr(x, 'minage') || null,
        bgg: +m[2], name: attr(x, 'name'), year: +attr(x, 'yearpublished') || null,
        thumb: fr ? fr.thumb : (text(x, 'thumbnail') || null), image: fr ? (fr.image || fr.thumb) : (text(x, 'image') || null),
        fr: fr ? +fr.id : null, frYear: fr ? fr.year || null : null, publisher: fr ? fr.publisher || null : null,
        players: min ? (max && max !== min ? `${min} à ${max}` : `${min}`) : null,
        time: tmin ? (tmax && tmax !== tmin ? `${tmin} à ${tmax}` : `${tmin}`) : (+attr(x, 'playingtime') || null),
      });
    });
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
    if (body.mode === 'search') {
      const q = String(body.q || '').trim();
      if (q.length < 2) return json({ results: [] });
      const want = norm(q);
      const score = (h: Hit) => { const n = norm(h.name); return n === want ? 0 : n.startsWith(want) ? 1 : n.includes(want) ? 2 : 3; };
      let hits = await search(q, false);
      if (!hits.length && q.includes(' ')) hits = await search(q.split(/\s+[:\-–]\s+/)[0], false);
      const seen = new Set<string>();
      hits = hits.sort((a, b) => score(a) - score(b) || (a.type === 'boardgame' ? 0 : 1) - (b.type === 'boardgame' ? 0 : 1) || (b.year || 0) - (a.year || 0))
        .filter(h => !seen.has(h.id) && seen.add(h.id)).slice(0, 8);
      const info = await things(hits.map(h => h.id));
      // Keep the name that matched the search (often the French title), BGG's main name as a hint.
      return json({ results: hits.map(h => ({ ...info.get(h.id), name: h.name, mainName: info.get(h.id)?.name || h.name, year: info.get(h.id)?.frYear ?? h.year ?? info.get(h.id)?.year ?? null })).filter(r => r.bgg) });
    }
    if (body.mode === 'french') {
      // Games whose picture came from BGG: switch to the French edition's box when BGG has one.
      const { data: games, error } = await admin.from('items').select('id,pub_year,extra')
        .eq('user_id', uid).eq('type', 'jeu').eq('cover_from', 'bgg').is('extra->fr_checked', null).order('created_at').limit(12);
      if (error) throw error;
      const info = await things([...new Set((games || []).map(g => String(g.extra.bgg)))], new Map((games || []).map(g => [String(g.extra.bgg), g.pub_year])));
      let french = 0; const none: string[] = [];
      for (const g of games || []) {
        const t = info.get(String(g.extra.bgg));
        const extra = { ...g.extra, fr_checked: true };
        const patch: Record<string, unknown> = { extra, updated_at: Date.now() };
        if (t && t.fr) { patch.photo = t.thumb; extra.bigImg = t.image || t.thumb; extra.fr = t.fr; if (t.publisher) extra.publisher = t.publisher; french++; }
        else none.push(String(g.extra.bgg));
        await admin.from('items').update(patch).eq('id', g.id);
      }
      const { count } = await admin.from('items').select('id', { count: 'exact', head: true })
        .eq('user_id', uid).eq('type', 'jeu').eq('cover_from', 'bgg').is('extra->fr_checked', null);
      return json({ done: (games || []).length, french, none, remaining: count ?? 0 });
    }
    if (body.mode === 'refresh') {
      const { data: games, error } = await admin.from('items').select('id,creator,pub_year,extra')
        .eq('user_id', uid).eq('type', 'jeu').not('extra->bgg', 'is', null).is('extra->bgg_info', null).order('created_at').limit(20);
      if (error) throw error;
      const info = await things([...new Set((games || []).map(g => String(g.extra.bgg)))]);
      let updated = 0;
      for (const g of games || []) {
        const t = info.get(String(g.extra.bgg));
        const extra = { ...g.extra, bgg_info: true };
        const patch: Record<string, unknown> = { extra, updated_at: Date.now() };
        if (t) {
          if (!extra.age && t.age) extra.age = t.age;
          if (!extra.players && t.players) extra.players = t.players;
          if (!extra.time && t.time) extra.time = String(t.time);
          if (!extra.bigImg && t.image) extra.bigImg = t.image;
          if (!g.creator && (t.designers as string[])?.length) patch.creator = (t.designers as string[]).slice(0, 2).join(', ');
          if (!g.pub_year && t.year) patch.pub_year = t.year;
        }
        const { error: e } = await admin.from('items').update(patch).eq('id', g.id);
        if (!e && t) updated++;
      }
      const { count } = await admin.from('items').select('id', { count: 'exact', head: true })
        .eq('user_id', uid).eq('type', 'jeu').not('extra->bgg', 'is', null).is('extra->bgg_info', null);
      return json({ done: (games || []).length, updated, remaining: count ?? 0 });
    }
    if (body.mode !== 'backfill') {
      const title = String(body.title || '').trim();
      if (!title) return json({ error: 'title_required' }, 400);
      const hit = await find(title, Number(body.year) || null, !!body.expansion);
      if (!hit) return json({ found: false });
      return json({ found: true, ...(await things([hit.id], new Map([[hit.id, Number(body.year) || null]]))).get(hit.id) });
    }
    const limit = Math.min(12, Math.max(1, Number(body.limit) || 10));  // stays within the function's time limit
    const { data: games, error } = await admin.from('items').select('id,title,creator,detail,pub_year,extra,photo')
      .eq('user_id', uid).eq('type', 'jeu').is('photo', null).order('created_at').limit(400);
    if (error) throw error;
    const todo = (games || []).filter(g => !(g.extra && (g.extra.bgg || g.extra.bgg_none))).slice(0, limit);
    const matched: { item: typeof todo[number]; id: string }[] = [], missed: string[] = [];
    for (const g of todo) {
      const hit = await find(g.title, g.pub_year, /^extension/i.test(g.detail || ''));
      if (hit) matched.push({ item: g, id: hit.id }); else missed.push(g.title);
      if (!hit) await admin.from('items').update({ extra: { ...(g.extra || {}), bgg_none: true } }).eq('id', g.id);
    }
    const info = await things([...new Set(matched.map(m => m.id))], new Map(matched.map(m => [m.id, m.item.pub_year])));
    let filled = 0;
    for (const { item, id } of matched) {
      const t = info.get(id); if (!t) { missed.push(item.title); continue; }
      const extra = { ...(item.extra || {}), bgg: t.bgg, bigImg: t.image || undefined, bgg_info: true, fr_checked: true, fr: t.fr || undefined, publisher: t.publisher || undefined };
      if (!extra.players && t.players) extra.players = t.players;
      if (!extra.time && t.time) extra.time = String(t.time);
      if (!extra.age && t.age) extra.age = t.age;
      const patch: Record<string, unknown> = { extra, updated_at: Date.now() };
      if (!item.creator && (t.designers as string[])?.length) patch.creator = (t.designers as string[]).slice(0, 2).join(', ');
      if (!item.pub_year && t.year) patch.pub_year = t.year;
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
