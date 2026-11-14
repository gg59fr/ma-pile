// Refreshes public.lego_sets from Rebrickable's free CSV downloads (sets + themes).
// Barcodes (ean, upc) are not in those files and are never overwritten here.
// Runs at most once every 6 hours, so calling it again is harmless.
// Deployed with verify_jwt on; run it with:
//   curl -X POST -H "Authorization: Bearer <anon key>" https://<project>.supabase.co/functions/v1/lego-catalog-sync
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const BASE = 'https://cdn.rebrickable.com/media/downloads/';
const COOLDOWN_MS = 6 * 3600 * 1000;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function csvGz(name: string): Promise<Record<string, string>[]> {
  const r = await fetch(BASE + name + '.csv.gz');
  if (!r.ok || !r.body) throw new Error(`${name}: HTTP ${r.status}`);
  const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  const [head, ...rest] = parseCSV(text);
  return rest.filter(x => x.length >= head.length).map(x => Object.fromEntries(head.map((h, i) => [h, x[i]])));
}

Deno.serve(async () => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: last } = await sb.from('lego_sync').select('ran_at, rows').eq('id', 1).maybeSingle();
  if (last?.ran_at && Date.now() - new Date(last.ran_at).getTime() < COOLDOWN_MS)
    return json({ skipped: true, ran_at: last.ran_at, rows: last.rows });
  await sb.from('lego_sync').upsert({ id: 1, ran_at: new Date().toISOString(), rows: last?.rows ?? null });
  try {
    const themes = new Map((await csvGz('themes')).map(t => [t.id, t]));
    const path = (id: string): string => { const t = themes.get(id); if (!t) return ''; const p = t.parent_id ? path(t.parent_id) : ''; return p ? `${p} › ${t.name}` : t.name; };
    const sets = (await csvGz('sets')).map(s => ({
      set_num: s.set_num, name: s.name, year: +s.year || null, theme: themes.get(s.theme_id)?.name ?? null,
      theme_path: path(s.theme_id) || null, pieces: +s.num_parts || null, img: s.img_url || null, updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < sets.length; i += 1000) {
      const { error } = await sb.from('lego_sets').upsert(sets.slice(i, i + 1000), { onConflict: 'set_num' });
      if (error) throw new Error(`batch ${i}: ${error.message}`);
    }
    await sb.from('lego_sync').upsert({ id: 1, ran_at: new Date().toISOString(), rows: sets.length });
    return json({ ok: true, rows: sets.length });
  } catch (e) {
    await sb.from('lego_sync').upsert({ id: 1, ran_at: last?.ran_at ?? null, rows: last?.rows ?? null });
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
