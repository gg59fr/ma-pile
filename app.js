import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as CONFIG from './config.js';
const { SUPABASE_URL, SUPABASE_ANON_KEY } = CONFIG;
const GOOGLE_BOOKS_KEY = CONFIG.GOOGLE_BOOKS_KEY || '';

(function(){
const TYPES = {
  livre:{label:'Livre',plural:'Livres',c:'var(--c-livre)',t:'var(--cover-light)',shape:'spine'},
  bd:{label:'BD',plural:'BD',c:'var(--c-bd)',t:'var(--cover-light)',shape:'spine'},
  jeu:{label:'Jeu',plural:'Jeux',c:'var(--c-jeu)',t:'var(--cover-dark)',shape:'box'},
  lego:{label:'Lego',plural:'Lego',c:'var(--c-lego)',t:'var(--cover-light)',shape:'box'},
  objet:{label:'Objet',plural:'Objets',c:'var(--c-objet)',t:'var(--cover-light)',shape:'box'}
};
const STATUS = {pile:'À acheter',cadeau:'Liste cadeaux',collection:'Ma collection',parti:'Plus à moi',termine:'Terminé',telecharge:'Téléchargé',achete:'Acheté',abandonne:'Abandonné'};
const SHELVES = ['termine','telecharge','abandonne'];
const COND = {boite:'En boîte', construit:'Construit', demonte:'Démonté'};
const FORMAT = {papier:'Papier', numerique:'Numérique'};
const DETAIL_LABEL = {livre:['Tome, série','Tome 2, Folio…'], bd:['Tome, série','Tome 1…'], lego:['N° de set','21335'], jeu:['Édition, extension','2e édition…'], objet:['Modèle','Taille, couleur…']};
const ICON = {
  cadeau:'<rect x="3" y="8" width="18" height="4"/><path d="M5 12v8h14v-8M12 8v12M12 8c-1-3-5-4-5-1.5S10 8 12 8zm0 0c1-3 5-4 5-1.5S14 8 12 8z"/>',
  termine:'<path d="m5 12 5 5 9-10"/>',
  telecharge:'<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  achete:'<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  abandonne:'<path d="M6 6l12 12M18 6 6 18"/>',
  pile:'<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  collection:'<rect x="3" y="11" width="18" height="9" rx="1.5"/><rect x="6" y="7" width="4" height="4" rx="1"/><rect x="14" y="7" width="4" height="4" rx="1"/>',
  parti:'<path d="M14 5h5v5M19 5l-8 8M10 5H5v14h14v-5"/>'
};
const ICOLOR = {termine:'var(--ok)',telecharge:'var(--c-livre)',achete:'var(--c-objet)',abandonne:'var(--accent)',cadeau:'currentColor',pile:'var(--accent)',collection:'var(--c-lego)',parti:'currentColor'};
const svg = (k,size=24,color='currentColor') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash = s => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const titleOf = it => (it.title || '').trim() || (it.owned ? 'Nouvelle fiche' : 'Nouvelle envie');
const ago = ms => { if (!ms) return ''; const d = Math.floor((Date.now() - ms) / 864e5);
  if (d < 1) return 'Ajouté aujourd’hui'; if (d < 7) return `Ajouté il y a ${d} j`;
  if (d < 60) return `Ajouté il y a ${Math.floor(d / 7)} sem.`; return `Ajouté il y a ${Math.floor(d / 30)} mois`; };

const state = { items: [], ready: false, view: 'collection', filter: 'all', q: '', shelf: 'termine', colFilter: 'all', cq: '', envTab: 'buy', addTo: 'collection',
  openId: null, identifying: new Set(), idNote: {}, previews: {}, coverBusy: new Set(), coverTried: {}, camTarget: null, delArmed: false, accountOpen: false };
let store = null, sb = null, user = null;
const pendingNew = new Map();
function createItem(it){ pendingNew.set(it.id, it); state.items.push(it); put(it.id, it); }

/* ---------- storage ---------- */
/* Supabase holds the records; this phone keeps a copy so the app opens offline. */
const CACHE_KEY = 'mapile-cache-v1';
const BUCKET = 'photos';
const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); } catch (e) { return []; } };
const writeCache = items => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(items)); } catch (e) {} };
const toRow = (id, d, uid) => ({
  id, user_id: uid, type: d.type || 'livre', status: d.status || 'pile',
  title: d.title || '', creator: d.creator || '', detail: d.detail || '', note: d.note || '',
  photo: d.photo || null, source: d.source || null, cover_from: d.coverFrom || null, isbn: d.isbn || null,
  pages: d.pages || null, pub_year: d.pubYear || null, publisher: d.publisher || null, genre: d.genre || null, meta_checked: d.metaChecked || null,
  owned: !!d.owned, owned_at: d.ownedAt ? Math.round(d.ownedAt) : null, format: d.format || null, cond: d.cond || null,
  plays: Math.max(0, d.plays | 0), extra: d.extra && typeof d.extra === 'object' ? d.extra : {},
  created_at: Math.round(d.createdAt || Date.now()), updated_at: Math.round(d.updatedAt || Date.now()),
  done_at: d.doneAt ? Math.round(d.doneAt) : null });
const fromRow = r => ({
  id: r.id, type: r.type, status: r.status, title: r.title, creator: r.creator, detail: r.detail, note: r.note,
  photo: r.photo, source: r.source, coverFrom: r.cover_from, isbn: r.isbn || null,
  pages: r.pages || null, pubYear: r.pub_year || null, publisher: r.publisher || null, genre: r.genre || null, metaChecked: r.meta_checked ? Number(r.meta_checked) : null,
  owned: !!r.owned, ownedAt: r.owned_at ? Number(r.owned_at) : null, format: r.format || null, cond: r.cond || null, plays: r.plays | 0, extra: r.extra || {},
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), doneAt: r.done_at == null ? null : Number(r.done_at) });
const photoPath = url => { const m = String(url || '').match(/\/storage\/v1\/object\/public\/photos\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; };

function supabaseStore(client, uid){
  let items = readCache(), subs = [];
  const emit = () => { writeCache(items); subs.forEach(f => f(items.slice())); };
  const upsertLocal = it => { const i = items.findIndex(x => x.id === it.id); if (i < 0) items.push(it); else items[i] = it; };
  async function load(){
    const all = []; let from = 0;
    for (;;) {
      const { data, error } = await client.from('items').select('*').order('created_at').range(from, from + 999);
      if (error) throw error;
      all.push(...data); if (data.length < 1000) break; from += 1000;
    }
    items = all.map(fromRow); banner(''); emit();
  }
  return {
    reload: () => load(),
    newId: () => crypto.randomUUID(),
    subscribe(f){
      subs.push(f);
      if (items.length) f(items.slice());
      load().catch(() => { banner('Hors connexion : tu vois la dernière version enregistrée sur ce téléphone.'); f(items.slice()); });
      client.channel('items-sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, p => {
          if (p.eventType === 'DELETE') items = items.filter(x => x.id !== p.old.id);
          else upsertLocal(fromRow(p.new));
          emit();
        })
        .subscribe();
      document.addEventListener('visibilitychange', () => { if (!document.hidden) load().catch(() => {}); });
      window.addEventListener('online', () => load().catch(() => {}));
    },
    async put(id, data){
      const { error } = await client.from('items').upsert(toRow(id, data, uid));
      if (error) throw error;
      upsertLocal(fromRow(toRow(id, data, uid))); emit();
    },
    async remove(id, photo){
      const { error } = await client.from('items').delete().eq('id', id);
      if (error) throw error;
      items = items.filter(x => x.id !== id); emit();
      this.removePhoto(photo);
    },
    async uploadPhoto(blob){
      const path = `${uid}/${crypto.randomUUID()}.jpg`;
      const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
      if (error) throw error;
      return client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },
    removePhoto(url){ const p = photoPath(url); if (p) client.storage.from(BUCKET).remove([p]).catch(() => {}); }
  };
}
async function put(id, data){
  try { await store.put(id, data); }
  catch (e) {
    if (!navigator.onLine) toast('Pas de connexion : la modification n’a pas été enregistrée.');
    else toast('Enregistrement impossible pour le moment. Réessaie.');
  }
}
function banner(msg){ const b = $('banner'); b.textContent = msg; b.hidden = !msg; }

/* ---------- covers ---------- */
function coverHTML(it, small){
  const T = TYPES[it.type] || TYPES.livre;
  const style = `--c:${T.c};--t:${T.t}`;
  const src = it.photo || state.previews[it.id];
  if (src) return `<span class="cover photo" style="${style}"><img src="${esc(src)}" alt="" loading="lazy"><span class="tag">${T.label}</span></span>`;
  return `<span class="cover m-${esc(it.type)}" style="${style}"><span class="tag">${T.label}${it.detail ? ' · ' + esc(it.detail) : ''}</span>${small ? '' : `<span class="ttl">${esc(titleOf(it))}</span>`}</span>`;
}

/* ---------- views ---------- */
const VIEW_ALIAS = { pile: ['envies', 'buy'], cadeaux: ['envies', 'gifts'], etageres: ['lectures'] };
function setView(v){
  if (VIEW_ALIAS[v]) { const [to, tab] = VIEW_ALIAS[v]; if (tab) setEnvTab(tab, true); v = to; }
  if (!['collection','envies','lectures','stats'].includes(v)) v = 'collection';
  state.view = v;
  document.querySelectorAll('section[data-view]').forEach(s => s.hidden = s.dataset.view !== v);
  document.querySelectorAll('.tab').forEach(t => { if (t.dataset.go === v) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current'); });
  if (location.hash.slice(1) !== v) { try { history.replaceState(null, '', '#' + v); } catch (e) {} }
  window.scrollTo(0, 0);
}

function setEnvTab(tab, quiet){
  state.envTab = tab === 'gifts' ? 'gifts' : 'buy';
  $('envBuy').hidden = state.envTab !== 'buy'; $('envGifts').hidden = state.envTab !== 'gifts';
  $('envTabBuy').setAttribute('aria-selected', String(state.envTab === 'buy'));
  $('envTabGifts').setAttribute('aria-selected', String(state.envTab === 'gifts'));
}

/* Collection: everything owned. Badge = where it stands (built, games played, read…). */
const fmtN = n => Math.round(n).toLocaleString('fr-FR');
function badgeOf(it){
  if (it.status === 'parti') return 'Plus à moi';
  const bits = [];
  if (it.type === 'lego') { if (it.cond) bits.push(COND[it.cond]); if (it.extra && it.extra.pieces) bits.push(`${fmtN(it.extra.pieces)} pièces`); }
  else if (it.type === 'jeu') bits.push(it.plays ? `${it.plays} partie${it.plays > 1 ? 's' : ''}` : 'Jamais joué');
  else if (isBook(it)) {
    bits.push(it.status === 'termine' ? 'Lu' : it.status === 'abandonne' ? 'Abandonné' : 'À lire');
    if (it.format === 'numerique') bits.push('Numérique'); else if (it.pages) bits.push(`${it.pages} p.`);
  }
  return bits.join(' · ');
}
function renderCollection(){
  const owned = state.items.filter(i => i.owned), gone = state.items.filter(i => !i.owned && i.status === 'parti');
  const n = k => owned.filter(i => i.type === k).length;
  const pieces = owned.filter(i => i.type === 'lego').reduce((t, i) => t + ((i.extra && i.extra.pieces) || 0), 0);
  const parts = [n('lego') && `${n('lego')} Lego${pieces ? ` · ${fmtN(pieces)} pièces` : ''}`, n('jeu') && `${n('jeu')} jeu${n('jeu') > 1 ? 'x' : ''}`,
    (n('livre') + n('bd')) && `${n('livre') + n('bd')} livre${n('livre') + n('bd') > 1 ? 's' : ''} et BD`, n('objet') && `${n('objet')} objet${n('objet') > 1 ? 's' : ''}`].filter(Boolean);
  $('colSub').textContent = !state.ready ? 'Chargement…' : parts.length ? parts.join(' · ') : 'Rien pour l’instant';
  if (state.colFilter === 'parti' && !gone.length) state.colFilter = 'all';
  const chips = [['all', 'Tout', owned.length], ...['lego', 'jeu', 'livre', 'bd', 'objet'].map(k => [k, TYPES[k].plural, n(k)])];
  if (gone.length) chips.push(['parti', 'Plus à moi', gone.length]);
  $('colChips').innerHTML = chips.map(([k, l, c]) => `<button type="button" class="chip" data-cfilter="${k}" aria-pressed="${state.colFilter === k}">${l} ${c}</button>`).join('');
  const q = state.cq.trim().toLowerCase();
  const base = state.colFilter === 'parti' ? gone : owned.filter(i => state.colFilter === 'all' || i.type === state.colFilter);
  const list = base.filter(i => !q || [i.title, i.creator, i.detail, i.note].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.ownedAt || b.createdAt || 0) - (a.ownedAt || a.createdAt || 0));
  const grid = $('colGrid');
  if (!state.ready) { grid.innerHTML = ''; return; }
  if (!list.length) {
    grid.innerHTML = owned.length
      ? `<div class="empty" style="grid-column:1/-1"><strong>Rien ne correspond</strong>Essaie un autre filtre ou un autre mot.</div>`
      : `<div class="empty" style="grid-column:1/-1"><strong>Ta collection est vide</strong>Ajoute tes Lego, tes jeux, tes livres ou tes objets avec le bouton +. Une envie achetée ou reçue arrive aussi ici avec « Je l’ai ».<button type="button" class="btn sun" data-act="photo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Ajouter à ma collection</button></div>`;
    return;
  }
  grid.innerHTML = list.map(it => { const b = badgeOf(it); return `<button type="button" class="card" data-open="${esc(it.id)}">
      ${coverHTML(it)}
      <span class="meta"><span class="t">${esc(titleOf(it))}</span>
      <span class="w">${state.identifying.has(it.id) ? '<span class="busy"><span class="spin"></span>Envoi de la photo…</span>' : state.coverBusy.has(it.id) ? '<span class="busy"><span class="spin"></span>Recherche en ligne…</span>' : esc(it.creator || (it.type === 'lego' && it.detail ? 'Set ' + it.detail : ''))}</span></span>
      ${b ? `<span class="badge${it.type === 'lego' && it.cond === 'boite' ? ' hot' : ''}">${esc(b)}</span>` : ''}
    </button>`; }).join('');
}

function renderPile(){
  const pile = state.items.filter(i => i.status === 'pile' && !i.owned);
  const gifts = state.items.filter(i => i.status === 'cadeau' && !i.owned).length;
  $('pileSub').textContent = !state.ready ? 'Chargement…' :
    `${pile.length} à acheter · ${gifts} dans la liste cadeaux`;
  const counts = {all: pile.length}; for (const k in TYPES) counts[k] = pile.filter(i => i.type === k).length;
  $('chips').innerHTML = [['all','Tout'], ...Object.keys(TYPES).map(k => [k, TYPES[k].plural])]
    .map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${l} ${counts[k]}</button>`).join('');
  const q = state.q.trim().toLowerCase();
  const list = pile.filter(i => (state.filter === 'all' || i.type === state.filter) &&
      (!q || [i.title, i.creator, i.detail, i.note].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const grid = $('pileGrid');
  if (!state.ready) { grid.innerHTML = ''; return; }
  if (!list.length) {
    grid.innerHTML = pile.length
      ? `<div class="empty" style="grid-column:1/-1"><strong>Rien ne correspond</strong>Essaie un autre filtre ou un autre mot.</div>`
      : `<div class="empty" style="grid-column:1/-1"><strong>Aucune envie pour l’instant</strong>Prends en photo une couverture, une boîte de jeu ou un objet, ou note une idée sans photo : la fiche arrive ici.<button type="button" class="btn sun" data-act="photo">${'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>'}Ajouter une envie</button></div>`;
    return;
  }
  grid.innerHTML = list.map(it => `<button type="button" class="card" data-open="${esc(it.id)}">
      ${coverHTML(it)}
      <span class="meta"><span class="t">${esc(titleOf(it))}</span>
      <span class="w">${state.identifying.has(it.id) ? '<span class="busy"><span class="spin"></span>Envoi de la photo…</span>' : state.coverBusy.has(it.id) ? '<span class="busy"><span class="spin"></span>Recherche de couverture…</span>' : esc(it.creator || ago(it.createdAt))}</span></span>
    </button>`).join('');
}

function giftLines(){
  return state.items.filter(i => i.status === 'cadeau' && !i.owned).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function renderGifts(){
  const g = giftLines();
  $('giftCount').textContent = `${g.length} envie${g.length > 1 ? 's' : ''}`;
  $('copyGifts').disabled = !g.length;
  $('giftList').innerHTML = !state.ready ? '' : g.length ? g.map(it => `<li><button type="button" class="rowitem" data-open="${esc(it.id)}">
      <span class="mini m-${esc(it.type)}" style="--c:${TYPES[it.type]?.c || TYPES.livre.c}">${it.photo ? `<img src="${esc(it.photo)}" alt="">` : ''}</span>
      <span class="meta"><span class="t">${esc(titleOf(it))}${it.detail ? ', ' + esc(it.detail) : ''}</span>
      <span class="w">${TYPES[it.type]?.label || ''}${it.creator ? ' · ' + esc(it.creator) : ''}</span></span></button></li>`).join('')
    : `<li class="empty"><strong>Liste vide</strong>Depuis la fiche d’une envie, choisis « Mettre dans ma liste cadeaux ».</li>`;
}
function giftText(){
  return 'Ma liste cadeaux\n' + giftLines().map(it => `• ${titleOf(it)}${it.detail ? ', ' + it.detail : ''} (${TYPES[it.type]?.label || ''}${it.creator ? ', ' + it.creator : ''})`).join('\n');
}

function renderShelf(){
  const counts = {}; SHELVES.forEach(s => counts[s] = state.items.filter(i => i.status === s).length);
  $('shelfTabs').innerHTML = SHELVES.map(s => `<button type="button" role="tab" data-shelf="${s}" aria-selected="${state.shelf === s}">${STATUS[s]} · ${counts[s]}</button>`).join('');
  const doneAt = i => i.doneAt || i.updatedAt || 0;
  const list = state.items.filter(i => i.status === state.shelf).sort((a, b) => doneAt(a) - doneAt(b));
  const shelf = $('shelf');
  if (!list.length) { shelf.innerHTML = `<p class="shelf-empty">${state.ready ? 'Rien sur cette étagère pour l’instant.' : 'Chargement…'}</p>`; $('shelfStat').hidden = true; return; }
  shelf.innerHTML = list.map(it => {
    const T = TYPES[it.type] || TYPES.livre, h = hash(it.id);
    const style = `--c:${T.c};--t:${T.t}`;
    if (T.shape === 'spine') return `<span class="slot"><button type="button" class="spine m-${esc(it.type)}" data-open="${esc(it.id)}" style="${style};width:${30 + h % 16}px;height:${112 + h % 38}px">${esc(titleOf(it))}</button></span>`;
    return `<span class="slot"><button type="button" class="box m-${esc(it.type)}" data-open="${esc(it.id)}" style="${style};width:${88 + h % 28}px;height:${64 + h % 44}px"><span class="tag">${T.label}</span>${esc(titleOf(it))}</button></span>`;
  }).join('');
  const year = new Date().getFullYear();
  const thisYear = list.filter(i => new Date(doneAt(i)).getFullYear() === year);
  const by = Object.keys(TYPES).map(k => [k, thisYear.filter(i => i.type === k).length]).filter(x => x[1]).map(([k, n]) => `${n} ${n > 1 ? TYPES[k].plural.toLowerCase() : TYPES[k].label.toLowerCase()}`);
  $('shelfStat').innerHTML = `<strong>${thisYear.length} en ${year}</strong>${by.length ? ' · ' + esc(by.join(', ')) : ''}`;
  $('shelfStat').hidden = false;
}

/* ---------- fiche (sheet) ---------- */
const find = id => state.items.find(i => i.id === id);
function openSheet(id){
  state.openId = id; state.delArmed = false;
  const it = find(id); if (!it) return;
  const T = Object.keys(TYPES);
  $('sheet').innerHTML = `
    <div class="sheet-bar"><span class="pill" id="sPill"></span>
      <button type="button" class="iconbtn" id="sClose" aria-label="Fermer la fiche"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="hero"><span id="sCover"></span>
      <div class="hero-txt"><h2 id="sheetTitle"></h2><p id="sCreator"></p>
      <button type="button" class="link" id="sPhoto" style="align-self:flex-start;padding:6px 0">${it.photo ? 'Changer la photo' : 'Ajouter une photo'}</button></div></div>
    <div class="own" role="group" aria-label="Est-ce que je l’ai ?">
      <button type="button" data-own="0" id="ownNo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>Envie</button>
      <button type="button" data-own="1" id="ownYes"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>Je l’ai</button>
    </div>
    <p class="idline" id="sId" aria-live="polite"></p>
    <div id="sExtra" class="extra"></div>
    <div class="field"><label for="fTitle">Titre</label><input id="fTitle" autocomplete="off" value="${esc(it.title)}" placeholder="Titre"></div>
    <div class="two">
      <div class="field"><label for="fCreator">Auteur, éditeur ou marque</label><input id="fCreator" autocomplete="off" value="${esc(it.creator)}"></div>
      <div class="field"><label for="fDetail" id="lDetail">Détail</label><input id="fDetail" autocomplete="off" value="${esc(it.detail)}"></div>
    </div>
    <div class="two" id="fBookRow">
      <div class="field"><label for="fPages">Pages</label><input id="fPages" type="number" inputmode="numeric" min="1" max="20000" value="${it.pages || ''}" placeholder="—"></div>
      <div class="field"><label for="fGenre">Genre</label><select id="fGenre"><option value="">À classer</option>${Object.entries(GENRES).map(([k, l]) => `<option value="${k}"${it.genre === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <p class="sub publine" id="fPub"></p>
    <div class="field"><span class="flabel" id="lType">Type</span>
      <div class="chips" role="group" aria-labelledby="lType" id="fType">${T.map(k => `<button type="button" class="chip" data-type="${k}" aria-pressed="${it.type === k}">${TYPES[k].label}</button>`).join('')}</div></div>
    <div class="field"><label for="fNote">Note</label><textarea id="fNote" rows="2" placeholder="Conseillé par…, prix vu, édition…">${esc(it.note)}</textarea></div>
    <div class="next"><h2>Et maintenant ?</h2><div id="sMoves" style="display:flex;flex-direction:column;gap:12px"></div></div>
    <div class="danger" id="sDanger"></div>`;
  $('sheetWrap').hidden = false;
  document.body.style.overflow = 'hidden';
  refreshSheet();
  $('sClose').focus({preventScroll: true});
}
function closeSheet(){
  if (state.accountOpen) { state.accountOpen = false; $('sheetWrap').hidden = true; $('sheet').innerHTML = ''; document.body.style.overflow = ''; return; }
  if (!state.openId) return;
  flushSave();
  const closed = state.openId;
  state.openId = null; $('sheetWrap').hidden = true; $('sheet').innerHTML = ''; document.body.style.overflow = '';
  autoEnrich(closed);
}
function refreshSheet(){
  const it = state.openId && find(state.openId);
  if (!state.openId) return;
  if (!it) { closeSheet(); return; }
  const titleIn = $('fTitle');
  $('sheetTitle').textContent = (titleIn && titleIn.value.trim()) || titleOf(it);
  $('sCreator').textContent = ($('fCreator') && $('fCreator').value) || '';
  const cov = coverHTML({...it, title: titleIn ? titleIn.value : it.title}, false);
  const shown = it.photo || state.previews[it.id];
  $('sCover').innerHTML = shown ? `<button type="button" class="zoom" data-act="zoom" aria-label="Voir la photo en grand">${cov}</button>` : cov;
  const pillKey = it.owned ? (isBook(it) && SHELVES.includes(it.status) ? it.status : 'collection') : it.status;
  $('sPill').innerHTML = `${svg(pillKey, 16, ICOLOR[pillKey])} ${it.owned && pillKey !== 'collection' ? `${STATUS[pillKey]} · dans ma collection` : STATUS[pillKey] || ''}`;
  $('ownNo').setAttribute('aria-pressed', String(!it.owned)); $('ownYes').setAttribute('aria-pressed', String(!!it.owned));
  const [dl, dph] = DETAIL_LABEL[it.type] || DETAIL_LABEL.objet;
  $('lDetail').textContent = dl; $('fDetail').placeholder = dph; $('fDetail').inputMode = it.type === 'lego' ? 'numeric' : 'text';
  const chipRow = (label, attr, map, cur) => `<div class="field"><span class="flabel">${label}</span><div class="chips" role="group" aria-label="${label}">${Object.entries(map).map(([k, l]) => `<button type="button" class="chip" ${attr}="${k}" aria-pressed="${cur === k}">${l}</button>`).join('')}</div></div>`;
  $('sExtra').innerHTML = !it.owned ? '' :
    it.type === 'lego' ? chipRow('État', 'data-cond', COND, it.cond) + (it.extra && it.extra.pieces ? `<p class="sub">${fmtN(it.extra.pieces)} pièces${it.extra.theme ? ' · ' + esc(it.extra.theme) : ''}${it.extra.year ? ' · ' + it.extra.year : ''}</p>` : '')
    : it.type === 'jeu' ? `<div class="field"><span class="flabel" id="lPlays">Parties jouées</span><div class="plays" role="group" aria-labelledby="lPlays"><button type="button" class="iconbtn" data-plays="-1" aria-label="Une partie de moins"${it.plays ? '' : ' disabled'}>−</button><output aria-live="polite">${it.plays || 0}</output><button type="button" class="iconbtn" data-plays="1" aria-label="Une partie de plus">+</button></div></div>`
      + (it.extra && (it.extra.players || it.extra.time) ? `<p class="sub">${[it.extra.players && `${esc(it.extra.players)} joueurs`, it.extra.time && `${esc(it.extra.time)} min`].filter(Boolean).join(' · ')}</p>` : '')
    : isBook(it) ? chipRow('Format', 'data-format', FORMAT, it.format) : '';
  $('sExtra').hidden = !$('sExtra').innerHTML;
  $('sPhoto').textContent = shown ? 'Changer la photo' : 'Ajouter une photo';
  const busy = state.identifying.has(it.id) ? 'Envoi de la photo…' : state.coverBusy.has(it.id) ? 'Recherche de couverture…' : '';
  const canCover = !shown && (it.type === 'livre' || it.type === 'bd');
  const fromWeb = it.photo && it.coverFrom && it.coverFrom !== 'none';
  $('sId').innerHTML = busy ? `<span class="busy"><span class="spin"></span>${busy}</span>`
    : esc(state.idNote[it.id] || (fromWeb ? `Couverture trouvée en ligne (${it.coverFrom === 'googlebooks' ? 'Google Books' : 'Open Library'}).` : ''))
      + (canCover ? ' <button type="button" class="link" data-act="cover" style="padding:4px 0">Chercher une couverture</button>' : '')
      + (fromWeb ? ' <button type="button" class="link" data-act="uncover" style="padding:4px 0">Pas la bonne ? Retirer</button>' : '');
  document.querySelectorAll('#fType .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === it.type)));
  $('fBookRow').hidden = !isBook(it);
  const pub = [it.pubYear && `Paru en ${it.pubYear}`, it.publisher].filter(Boolean).join(' · ');
  $('fPub').textContent = pub; $('fPub').hidden = !pub || !isBook(it);
  const chev = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
  const readMoves = isBook(it) ? ['termine', 'telecharge', 'abandonne'].filter(m => m !== it.status) : (!it.owned && it.status !== 'abandonne' ? ['abandonne'] : []);
  let html = '';
  if (!it.owned) {
    html += `<button type="button" class="big own-big" data-own="1" data-close="1">${svg('termine')}<span>Je l’ai (acheté ou reçu)</span>${chev}</button>`;
    if (it.status === 'pile') html += `<button type="button" class="big soft" data-move="cadeau">${svg('cadeau')}<span>Mettre dans ma liste cadeaux</span>${chev}</button>`;
    if (it.status === 'cadeau') html += `<button type="button" class="big soft" data-move="pile">${svg('pile', 24, 'var(--accent)')}<span>Retirer de la liste cadeaux</span>${chev}</button>`;
  }
  if (readMoves.length) html += `<div class="moves">${readMoves.map(m => `<button type="button" class="move" data-move="${m}">${svg(m, 24, ICOLOR[m])}${STATUS[m]}</button>`).join('')}</div>`;
  if (it.owned && isBook(it) && SHELVES.includes(it.status)) html += `<button type="button" class="link" data-move="collection" style="align-self:center">Remettre « à lire »</button>`;
  if (!it.owned && SHELVES.includes(it.status)) html += `<button type="button" class="link" data-move="pile" style="align-self:center">Remettre dans mes envies</button>`;
  if (it.owned) html += `<button type="button" class="link" data-act="gone" style="align-self:center">Je ne l’ai plus (vendu, donné)</button>`;
  if (!html) html = `<button type="button" class="link" data-act="close" style="align-self:center">Fermer la fiche</button>`;
  $('sMoves').innerHTML = html;
  $('sDanger').innerHTML = state.delArmed
    ? `<button type="button" class="link confirm" data-act="del-yes">Oui, supprimer la fiche</button><button type="button" class="link" data-act="del-no">Garder</button>`
    : `<button type="button" class="link" data-act="del">Supprimer la fiche</button>`;
}

let saveTimer = null;
function formPatch(){
  if (!state.openId || !$('fTitle')) return {};
  const pg = parseInt($('fPages').value, 10);
  return { title: $('fTitle').value.trim().slice(0, 200), creator: $('fCreator').value.trim().slice(0, 200),
    detail: $('fDetail').value.trim().slice(0, 80), note: $('fNote').value.slice(0, 2000),
    pages: pg > 0 && pg <= 20000 ? pg : null, genre: GENRES[$('fGenre').value] ? $('fGenre').value : null };
}
function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600); }
function flushSave(){
  clearTimeout(saveTimer); saveTimer = null;
  const it = state.openId && find(state.openId); if (!it || !$('fTitle')) return;
  const p = formPatch();
  if (['title','creator','detail','note','pages','genre'].every(k => String(it[k] ?? '') === String(p[k] ?? ''))) return;
  const next = {...it, ...p, updatedAt: Date.now()};
  Object.assign(it, p);
  put(it.id, next);
}
function save(id, patch){
  const it = find(id); if (!it) return;
  const extra = id === state.openId ? formPatch() : {};
  const next = {...it, ...extra, ...patch, updatedAt: Date.now()};
  Object.assign(it, next);
  put(id, next);
}

let toastTimer = null;
function toast(msg, undo){
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" id="undo">Annuler</button>' : ''}`;
  t.hidden = false;
  if (undo) $('undo').onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
function move(id, status){
  const it = find(id); if (!it) return;
  const prev = {status: it.status, doneAt: it.doneAt || null};
  save(id, {status, doneAt: SHELVES.includes(status) ? Date.now() : null});
  closeSheet();
  const msg = status === 'pile' ? (prev.status === 'cadeau' ? 'Retiré de la liste cadeaux' : 'Remis dans tes envies')
    : status === 'collection' ? 'Remis « à lire » dans ta collection' : `Rangé dans « ${STATUS[status]} »`;
  toast(msg, () => { save(id, prev); renderAll(); });
  renderAll();
}
function setOwned(id, on, close){
  const it = find(id); if (!it || !!it.owned === on) { if (close) closeSheet(); return; }
  const prev = {owned: !!it.owned, ownedAt: it.ownedAt || null, status: it.status};
  const patch = on
    ? {owned: true, ownedAt: Date.now(), status: ['pile', 'cadeau', 'parti', 'achete'].includes(it.status) ? 'collection' : it.status}
    : {owned: false, status: it.status === 'collection' ? 'pile' : it.status};
  save(id, patch);
  if (close) closeSheet(); else refreshSheet();
  toast(on ? (prev.status === 'cadeau' ? 'Dans ta collection, et retiré de la liste cadeaux' : 'Ajouté à ta collection') : 'Remis dans tes envies', () => { save(id, prev); renderAll(); });
  renderAll();
}
function markGone(id){
  const it = find(id); if (!it) return;
  const prev = {owned: !!it.owned, ownedAt: it.ownedAt || null, status: it.status};
  save(id, {owned: false, status: it.status === 'collection' ? 'parti' : it.status});
  closeSheet();
  toast('Sorti de ta collection', () => { save(id, prev); renderAll(); });
  renderAll();
}

/* ---------- photo + identification ---------- */
async function compress(file){
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    let max = 1400, q = 0.82;
    for (;;) {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      if (!blob) throw new Error('encode');
      if (blob.size < 450000 || max <= 640) return blob;
      max = Math.round(max * 0.8); q = 0.75;
    }
  } finally { URL.revokeObjectURL(url); }
}
const toDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

async function onPhoto(file){
  let blob;
  try { blob = await compress(file); }
  catch (e) { toast('Cette image ne s’ouvre pas. Essaie une autre photo.'); return; }
  const now = Date.now();
  let id = state.camTarget; state.camTarget = null;
  const preview = URL.createObjectURL(blob);
  if (!(id && find(id))) {
    id = store.newId();
    const it = newBase(id);
    state.previews[id] = preview;
    createItem(it);
    showTarget();
    renderAll();
    openSheet(id);
  } else { state.previews[id] = preview; }
  state.identifying.add(id); renderAll();
  try {
    const url = await store.uploadPhoto(blob);
    const it = find(id);
    if (it) { const old = it.photo; save(id, {photo: url}); if (old && old !== url) store.removePhoto(old); }
  } catch (e) {
    toast(navigator.onLine ? 'Envoi de la photo impossible. Réessaie.' : 'Pas de connexion : la photo n’a pas été envoyée.');
  } finally {
    state.identifying.delete(id); renderAll();
    setTimeout(() => { if (state.previews[id] === preview) { delete state.previews[id]; renderAll(); } URL.revokeObjectURL(preview); }, 4000);
  }
}

function dataToBlob(u){
  const i = u.indexOf(','), bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
  return new Blob([a], {type: (u.slice(0, i).match(/data:([^;]+)/) || [])[1] || 'image/jpeg'});
}

/* New entries go where the + menu switch says: the collection, or the wishes. */
function newBase(id, extra){
  const now = Date.now(), toCol = state.addTo === 'collection';
  const f = toCol ? state.colFilter : state.filter;
  return { id, type: TYPES[f] ? f : 'livre', owned: toCol, ownedAt: toCol ? now : null,
    status: toCol ? 'collection' : (state.view === 'envies' && state.envTab === 'gifts' ? 'cadeau' : 'pile'),
    title: '', creator: '', detail: '', note: '', photo: null, plays: 0, extra: {}, createdAt: now, updatedAt: now, ...extra };
}
function showTarget(){
  if (state.addTo === 'collection') { if (state.view !== 'collection') setView('collection'); }
  else if (state.view !== 'envies') setView('envies');
}
function addManual(){
  const id = store.newId();
  const it = newBase(id);
  showTarget();
  createItem(it); renderAll(); openSheet(id);
  setTimeout(() => $('fTitle') && $('fTitle').focus(), 50);
}

function renderAll(){ renderCollection(); renderPile(); renderGifts(); renderShelf(); renderStats(); refreshSheet(); }

/* ---------- book details: cover, pages, year, publisher, genre ----------
   Sources: BnF catalogue (best for French books), Open Library, then Google Books.
   Rule: when an author is known, a match must be by that author; with a title only,
   the title must be identical. The first matching edition wins. */
const GENRES = { polar: 'Polar & thriller', sf: 'Science-fiction', fantasy: 'Fantasy', horreur: 'Horreur', roman: 'Roman', essai: 'Essai & document', jeunesse: 'Jeunesse', autre: 'Autre' };
const isBook = it => it.type === 'livre' || it.type === 'bd';
const normT = t => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').replace(/\b(l|d|le|la|les|un|une|des|du|de|the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
const cleanTitle = t => String(t || '').replace(/\s*\((french|english) edition\)/ig, '').replace(/\s*\([^)]*\)\s*$/, '').split(/\s+[-–:]\s+/)[0].trim();
const lastNames = a => String(a || '').split(/,|&|;|\/|\bet\b|\band\b/i).map(x => normT(x).split(' ').filter(Boolean).pop()).filter(w => w && w.length > 1);
function authorMatches(wanted, names){
  const want = lastNames(wanted); if (!want.length) return true;
  const got = new Set((names || []).flatMap(n => normT(n).split(' ')));
  return want.some(w => got.has(w));
}
function genreFrom(text){
  const t = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!t.trim()) return null;
  if (/thriller|polar|policier|crime|detective|myster|suspense|espionage|espionnage/.test(t)) return 'polar';
  if (/science[- ]fiction|dystopi|cyberpunk|space opera|anticipation/.test(t)) return 'sf';
  if (/fantasy|fantastique|litrpg/.test(t)) return 'fantasy';
  if (/horror|horreur|epouvante/.test(t)) return 'horreur';
  if (/juvenile|jeunesse|young adult|children/.test(t)) return 'jeunesse';
  if (/essai|biograph|histoire|history|politi|document|nonfiction|non-fiction|memoir|temoignage/.test(t)) return 'essai';
  if (/\broman\b|fiction|novel/.test(t)) return 'roman';
  return null;
}
async function fetchWithRetry(url, as, tries = 2){
  for (let k = 1; ; k++) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try { const r = await fetch(url, {signal: ctl.signal}); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), {status: r.status}); return await (as === 'text' ? r.text() : r.json()); }
    catch (e) { if (k >= tries || (e.status && e.status < 500 && e.status !== 429)) throw e; await new Promise(r => setTimeout(r, 800)); }
    finally { clearTimeout(t); }
  }
}
const fetchJSON = url => fetchWithRetry(url, 'json');
const titleOk = (found, title, author) => { const f = normT(found), w = normT(title); return author ? (f === w || f.startsWith(w)) : f === w; };
async function fromBnF(title, author, isbn){
  const ln = lastNames(author)[0];
  const q = isbn ? `bib.isbn all "${isbn}"` : `bib.title all "${title.replace(/"/g, ' ')}"` + (ln ? ` and bib.author all "${ln}"` : '');
  const xml = await fetchWithRetry('https://catalogue.bnf.fr/api/SRU?' + new URLSearchParams({version: '1.2', operation: 'searchRetrieve', query: q, recordSchema: 'dublincore', maximumRecords: '15'}), 'text');
  const doc = new DOMParser().parseFromString(xml, 'application/xml'), DC = 'http://purl.org/dc/elements/1.1/';
  let best = null;
  for (const rec of doc.getElementsByTagNameNS('*', 'recordData')) {
    const g = tag => [...rec.getElementsByTagNameNS(DC, tag)].map(e => e.textContent || '');
    const full = (g('title')[0] || '').split(' / ')[0], main = full.split(' : ')[0];
    if (!isbn && (!titleOk(main, title, author) || (author && !authorMatches(author, g('creator'))))) continue;
    const pages = Math.max(0, ...g('format').flatMap(f => [...f.matchAll(/(\d{2,4})\s*p\./g)].map(m => +m[1]))) || null;
    const yr = (g('date').join(' ').match(/\d{4}/) || [])[0];
    const cand = { pages, year: yr ? +yr : null, publisher: ((g('publisher')[0] || '').replace(/\s*\([^)]*\)\s*$/, '').trim()) || null,
      genreText: [full.includes(' : ') ? full.split(' : ').slice(1).join(' ') : '', ...g('subject')].join(' ') };
    if (!best || (!best.pages && pages)) best = cand;
    if (best.pages) break;
  }
  return best;
}
async function fromOpenLibrary(title, author, isbn){
  if (isbn) {
    const d = await fetchJSON(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`), b = d && d['ISBN:' + isbn];
    if (b) return { cover: b.cover ? (b.cover.large || b.cover.medium) : null, pages: b.number_of_pages || null,
      year: +((String(b.publish_date || '').match(/\d{4}/) || [])[0]) || null, publisher: b.publishers && b.publishers[0] ? b.publishers[0].name : null,
      genreText: (b.subjects || []).map(x => x.name || x).join(' ') };
  }
  const p = new URLSearchParams({title, fields: 'cover_i,title,author_name,number_of_pages_median,first_publish_year,subject,publisher', limit: '10'}); if (author) p.set('author', author);
  const d = await fetchJSON('https://openlibrary.org/search.json?' + p);
  const ok = (d.docs || []).filter(x => author ? authorMatches(author, x.author_name) : titleOk(x.title, title, ''));
  if (!ok.length) return null;
  const withCover = ok.find(x => x.cover_i), first = ok[0];
  return { cover: withCover ? `https://covers.openlibrary.org/b/id/${withCover.cover_i}-L.jpg` : null,
    pages: (ok.find(x => x.number_of_pages_median) || {}).number_of_pages_median || null, year: first.first_publish_year || null,
    publisher: (first.publisher || [])[0] || null, genreText: (first.subject || []).slice(0, 30).join(' ') };
}
async function fromGoogle(title, author, isbn){
  const p = new URLSearchParams({q: isbn ? 'isbn:' + isbn : `intitle:${title}` + (author ? ` inauthor:${lastNames(author)[0] || author}` : ''), maxResults: '10', printType: 'books',
    fields: 'items(id,volumeInfo(title,authors,imageLinks,pageCount,publishedDate,publisher,categories))'});
  if (GOOGLE_BOOKS_KEY) p.set('key', GOOGLE_BOOKS_KEY);
  const d = await fetchJSON('https://www.googleapis.com/books/v1/volumes?' + p);
  const ok = (d.items || []).filter(v => isbn || (author ? authorMatches(author, (v.volumeInfo || {}).authors) : titleOk((v.volumeInfo || {}).title, title, '')));
  if (!ok.length) return null;
  const vi = ok[0].volumeInfo || {}, wc = ok.find(v => (v.volumeInfo || {}).imageLinks);
  return { cover: wc ? `https://books.google.com/books/content?id=${encodeURIComponent(wc.id)}&printsec=frontcover&img=1&zoom=1` : null,
    pages: (ok.map(v => (v.volumeInfo || {}).pageCount).find(n => n > 0)) || null, year: +((vi.publishedDate || '').slice(0, 4)) || null,
    publisher: vi.publisher || null, genreText: ok.flatMap(v => (v.volumeInfo || {}).categories || []).join(' '), categories: (vi.categories || []).join(' ') };
}
async function findBook(rawTitle, author, isbn){
  const title = cleanTitle(rawTitle);
  const [bnf, ol] = await Promise.all([fromBnF(title, author, isbn).catch(() => null), fromOpenLibrary(title, author, isbn).catch(() => null)]);
  let gb = null;
  if (!(ol && ol.cover) || !((bnf && bnf.pages) || (ol && ol.pages))) gb = await fromGoogle(title, author, isbn).catch(() => null);
  const pick = k => [bnf, ol, gb].map(x => x && x[k]).find(Boolean) || null;
  return { found: !!(bnf || ol || gb),
    cover: ol && ol.cover ? {url: ol.cover, from: 'openlibrary'} : gb && gb.cover ? {url: gb.cover, from: 'googlebooks'} : null,
    pages: pick('pages'), year: pick('year'), publisher: pick('publisher'),
    genre: genreFrom([bnf, ol, gb].map(x => x && x.genreText).join(' ')), comic: !!(gb && /comics|graphic novel/i.test(gb.categories || '')) };
}
async function autoEnrich(id, force){
  const it = find(id);
  if (!it || !isBook(it) || state.coverBusy.has(id)) return null;
  const title = (it.title || '').trim(), creator = (it.creator || '').trim();
  if (title.length < 2) { if (force) { state.idNote[id] = 'Indique d’abord le titre.'; refreshSheet(); } return null; }
  const wantCover = !it.photo && !state.previews[id] && (force || it.coverFrom !== 'none');
  const wantMeta = force ? !(it.pages && it.genre && it.pubYear) : !it.metaChecked;
  if (!wantCover && !wantMeta) return null;
  const key = normT(title) + '|' + normT(creator) + '|' + (it.isbn || '');
  if (!force && state.coverTried[id] === key) return null;
  state.coverTried[id] = key; state.coverBusy.add(id); renderAll();
  let r = null;
  try { r = await findBook(title, creator, it.isbn); } catch (e) {}
  state.coverBusy.delete(id);
  const cur = find(id); if (!cur) return null;
  if (!navigator.onLine && !(r && r.found)) {
    delete state.coverTried[id]; state.idNote[id] = 'Pas de connexion : les infos seront cherchées plus tard.'; renderAll(); return null;
  }
  const patch = { metaChecked: Date.now() };
  if (r) {
    if (wantCover && r.cover && !cur.photo) { patch.photo = r.cover.url; patch.coverFrom = r.cover.from; }
    if (!cur.pages && r.pages) patch.pages = r.pages;
    if (!cur.pubYear && r.year) patch.pubYear = r.year;
    if (!cur.publisher && r.publisher) patch.publisher = r.publisher;
    if (!cur.genre && r.genre) patch.genre = r.genre;
  }
  save(id, patch);
  if (id === state.openId) {
    if (patch.pages && $('fPages')) $('fPages').value = patch.pages;
    if (patch.genre && $('fGenre')) $('fGenre').value = patch.genre;
  }
  const got = [patch.photo && 'couverture', patch.pages && `${patch.pages} pages`, patch.pubYear && `paru en ${patch.pubYear}`, patch.genre && GENRES[patch.genre].toLowerCase()].filter(Boolean);
  state.idNote[id] = got.length
    ? `Trouvé en ligne : ${got.join(', ')}.` + (patch.photo && !creator ? ' Titre seul : vérifie que c’est le bon livre.' : '')
    : wantCover && !cur.photo ? 'Pas de couverture trouvée en ligne. Tu peux ajouter une photo.' : force ? 'Rien de plus trouvé en ligne.' : '';
  renderAll();
  return patch;
}
let detailsRun = false;
async function fillDetails(){
  const msg = t => { const m = $('accMsg'); if (m) m.innerHTML = t; };
  if (detailsRun) return;
  const todo = state.items.filter(i => isBook(i) && (i.title || '').trim() && ((!i.photo && i.coverFrom !== 'none') || !i.pages || !i.genre || !i.pubYear));
  if (!todo.length) { msg('Tes livres et BD ont déjà couverture, pages, année et genre.'); return; }
  detailsRun = true; let n = 0; const got = {photo: 0, pages: 0, genre: 0};
  for (const it of todo) {
    msg(`<span class="busy"><span class="spin"></span>Recherche en ligne : ${n} / ${todo.length}</span>`);
    const p = await autoEnrich(it.id, true);
    if (p) { if (p.photo) got.photo++; if (p.pages) got.pages++; if (p.genre) got.genre++; }
    n++; await new Promise(r => setTimeout(r, 300));
  }
  detailsRun = false;
  msg(`<strong>${todo.length} fiche${todo.length > 1 ? 's' : ''} vérifiée${todo.length > 1 ? 's' : ''}</strong> : ${got.photo} couverture${got.photo > 1 ? 's' : ''}, ${got.pages} nombre${got.pages > 1 ? 's' : ''} de pages et ${got.genre} genre${got.genre > 1 ? 's' : ''} trouvés. Le reste se complète à la main dans la fiche.`);
}

/* ---------- stats ---------- */
const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const plur = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const fmtNum = n => Math.round(n).toLocaleString('fr-FR');
const compact = n => n >= 1000 ? (n / 1000).toLocaleString('fr-FR', {maximumFractionDigits: 1}) + 'k' : String(n);
function renderStats(){
  const when = i => new Date(i.doneAt || i.updatedAt || 0);
  const reads = state.items.filter(i => i.status === 'termine' && isBook(i));
  const now = new Date(), cur = now.getFullYear();
  const years = [...new Set(reads.map(i => when(i).getFullYear()).concat(cur))].sort((a, b) => b - a);
  if (!years.includes(state.statYear)) state.statYear = cur;
  const y = state.statYear, mode = state.statMode === 'pages' ? 'pages' : 'count';
  $('statYears').innerHTML = years.map(yy => `<button type="button" class="chip" data-syear="${yy}" aria-pressed="${yy === y}">${yy}</button>`).join('');
  const body = $('statBody');
  if (!state.ready) { body.innerHTML = '<p class="sub">Chargement…</p>'; return; }
  const list = reads.filter(i => when(i).getFullYear() === y).sort((a, b) => when(a) - when(b));
  if (!list.length) {
    body.innerHTML = `<div class="empty"><strong>Aucune lecture terminée en ${y}</strong>Range un livre ou une BD dans « Terminé » depuis sa fiche, ou importe tes lectures Goodreads depuis l’onglet Lectures.</div>`;
    return;
  }
  const val = i => mode === 'pages' ? (i.pages || 0) : 1;
  const m = Array.from({length: 12}, () => ({livre: [], bd: []}));
  list.forEach(i => m[when(i).getMonth()][i.type].push(i));
  const sum = arr => arr.reduce((t, i) => t + val(i), 0);
  const tot = k => sum(m[k].livre) + sum(m[k].bd);
  const max = Math.max(1, ...m.map((_, k) => tot(k)));
  const nl = list.filter(i => i.type === 'livre').length, nb = list.length - nl;
  const withPages = list.filter(i => i.pages), pagesTotal = withPages.reduce((t, i) => t + i.pages, 0);
  const avgPages = withPages.length ? pagesTotal / withPages.length : 0;
  const longest = withPages.reduce((a, i) => !a || i.pages > a.pages ? i : a, null);
  const missing = list.length - withPages.length;
  const lastM = y === cur ? now.getMonth() : 11;
  let best = 0; for (let k = 1; k < 12; k++) if (tot(k) > tot(best)) best = k;
  const piece = (arr, type) => { const n = sum(arr); return n ? `<span class="piece m-${type}" style="--c:${TYPES[type].c};height:${(n / max * 100).toFixed(2)}%"></span>` : ''; };
  const label = MOIS.map((mm, k) => `${mm} ${tot(k)}`).join(', ');
  const note = mode === 'pages'
    ? `${fmtNum(pagesTotal / (lastM + 1))} pages par mois en moyenne${y === cur ? ' depuis janvier' : ''} · meilleur mois : ${MOIS[best].toLowerCase()} (${fmtNum(tot(best))} p.)${missing ? ` · ${missing} lecture${missing > 1 ? 's' : ''} sans nombre de pages, non comptée${missing > 1 ? 's' : ''}` : ''}`
    : `${(list.length / (lastM + 1)).toLocaleString('fr-FR', {maximumFractionDigits: 1})} par mois en moyenne${y === cur ? ' depuis janvier' : ''} · meilleur mois : ${MOIS[best].toLowerCase()} (${tot(best)})`;
  // genres
  const gc = {}; list.forEach(i => { const g = i.genre || ''; gc[g] = (gc[g] || 0) + 1; });
  const grows = Object.entries(gc).sort((a, b) => (a[0] === '') - (b[0] === '') || b[1] - a[1]);
  const gmax = Math.max(...grows.map(r => r[1]));
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <div class="tiles">
      <div class="tile"><b>${list.length}</b><span>${list.length > 1 ? 'lectures' : 'lecture'}</span></div>
      <div class="tile"><b>${nl}</b><span><i class="sw" style="--c:${TYPES.livre.c}"></i>${nl > 1 ? 'livres' : 'livre'}</span></div>
      <div class="tile"><b>${nb}</b><span><i class="sw m-bd" style="--c:${TYPES.bd.c}"></i>BD</span></div>
    </div>
    <div class="tiles">
      <div class="tile"><b>${withPages.length ? compact(pagesTotal) : '—'}</b><span>pages lues</span></div>
      <div class="tile"><b>${withPages.length ? fmtNum(avgPages) : '—'}</b><span>pages par livre</span></div>
      ${longest ? `<button type="button" class="tile tile-link" data-open="${esc(longest.id)}" aria-label="Plus long : ${esc(titleOf(longest))}, ${longest.pages} pages. Ouvrir la fiche"><b>${fmtNum(longest.pages)}</b><span>plus long</span><span class="tile-sub">${esc(titleOf(longest))}</span></button>` : '<div class="tile"><b>—</b><span>plus long</span></div>'}
    </div>
    ${missing ? `<p class="chart-note">${missing} lecture${missing > 1 ? 's' : ''} sans nombre de pages. Complète-les dans la fiche, ou avec « Compléter mes fiches » dans ton compte.</p>` : ''}
    <div class="chart">
      <div class="top"><h2>Par mois</h2>
        <div class="mini-seg" role="group" aria-label="Compter en"><button type="button" data-smode="count" aria-pressed="${mode === 'count'}">Lectures</button><button type="button" data-smode="pages" aria-pressed="${mode === 'pages'}">Pages</button></div></div>
      <div class="legend" aria-hidden="true"><span><i class="sw" style="--c:${TYPES.livre.c}"></i>Livres</span><span><i class="sw m-bd" style="--c:${TYPES.bd.c}"></i>BD</span></div>
      <div class="cols" role="img" aria-label="${mode === 'pages' ? 'Pages lues' : 'Lectures terminées'} par mois en ${y} : ${esc(label)}">
        ${m.map((x, k) => `<button type="button" class="col" data-smonth="${k}" ${tot(k) ? '' : 'disabled'} aria-hidden="true" tabindex="-1"><span class="n">${tot(k) ? (mode === 'pages' ? compact(tot(k)) : tot(k)) : ''}</span><span class="bar">${piece(x.bd, 'bd')}${piece(x.livre, 'livre')}</span></button>`).join('')}
      </div>
      <div class="mos" aria-hidden="true">${MOIS.map((mm, k) => `<span class="${y === cur && k === lastM ? 'now' : ''}">${mm[0]}</span>`).join('')}</div>
      <p class="chart-note">${note}</p>
    </div>
    <div class="chart">
      <div class="top"><h2>Par genre</h2><span class="sub">${list.length - (gc[''] || 0)} classée${list.length - (gc[''] || 0) > 1 ? 's' : ''} sur ${list.length}</span></div>
      <ul class="genres">${grows.map(([g, n]) => `<li class="${g ? '' : 'todo'}"><span class="gl">${g ? GENRES[g] : 'À classer'}</span><span class="gb"><i style="width:${(n / gmax * 100).toFixed(1)}%"></i></span><span class="gn">${n}</span></li>`).join('')}</ul>
      ${gc[''] ? '<p class="chart-note">Choisis le genre dans la fiche du livre pour classer les autres.</p>' : ''}
    </div>
    <div class="months">
      ${m.map((x, k) => ({x, k})).filter(o => o.x.livre.length + o.x.bd.length).reverse().map(({x, k}) => `<section class="mrow" id="sm-${k}" aria-labelledby="smh-${k}">
        <div class="mhead"><h3 id="smh-${k}">${MOIS[k]}</h3><span>${[x.livre.length ? plur(x.livre.length, 'livre', 'livres') : '', x.bd.length ? `${x.bd.length} BD` : '', [...x.livre, ...x.bd].some(i => i.pages) ? `${fmtNum([...x.livre, ...x.bd].reduce((t, i) => t + (i.pages || 0), 0))} p.` : ''].filter(Boolean).join(' · ')}</span></div>
        <ul class="mlist">${[...x.livre, ...x.bd].sort((a, b) => when(a) - when(b)).map(i => `<li><button type="button" class="mitem" data-open="${esc(i.id)}"><i class="sw${i.type === 'bd' ? ' m-bd' : ''}" style="--c:${TYPES[i.type].c}" aria-label="${TYPES[i.type].label}"></i><span class="t">${esc(titleOf(i))}${i.detail ? ', ' + esc(i.detail) : ''}</span><span class="w">${esc(i.creator || '')}${i.pages ? ` · ${i.pages} p.` : ''}</span></button></li>`).join('')}</ul>
      </section>`).join('')}
    </div>
  </div>`;
}

/* ---------- Goodreads import (CSV export) ---------- */
function parseCSV(text){
  const rows = []; let row = [], f = '', q = false;
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
const grDate = s => { const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec((s || '').trim()); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : null; };
const gr = { books: [], year: null, busy: false };
function grParse(text){
  const rows = parseCSV(text.replace(/^﻿/, ''));
  const head = (rows[0] || []).map(h => h.trim());
  const col = n => head.indexOf(n);
  if (col('Title') < 0 || col('Exclusive Shelf') < 0) return null;
  const get = (r, n) => col(n) < 0 ? '' : (r[col(n)] || '').trim();
  return rows.slice(1).filter(r => r.length > 2 && get(r, 'Exclusive Shelf') === 'read').map(r => {
    let title = get(r, 'Title'), detail = '';
    const m = /\s*\(([^()]*#[^()]*)\)\s*$/.exec(title);
    if (m) { detail = m[1].slice(0, 80); title = title.slice(0, m.index); }
    const tags = (get(r, 'Bookshelves') + ' ' + get(r, 'Binding')).toLowerCase();
    return { gid: get(r, 'Book Id').replace(/\D/g, ''), title: title.slice(0, 200), detail,
      creator: get(r, 'Author').slice(0, 200), readAt: grDate(get(r, 'Date Read')), addedAt: grDate(get(r, 'Date Added')),
      pages: +get(r, 'Number of Pages') || null, pubYear: +(get(r, 'Original Publication Year') || get(r, 'Year Published')) || null,
      publisher: get(r, 'Publisher').slice(0, 120) || null, genre: genreFrom(get(r, 'Bookshelves')), isbn: (get(r, 'ISBN13').replace(/\D/g, '').match(/^97[89]\d{10}$/) || [null])[0],
      get doneAt(){ return this.readAt || this.addedAt; }, get byAdded(){ return !this.readAt && !!this.addedAt; },
      type: /\b(bd|comics?|graphic|manga|bande)/.test(tags) ? 'bd' : 'livre' };
  });
}
function grKnown(b){
  const t = b.title.toLowerCase();
  return state.items.some(i => i.id === 'gr-' + b.gid || ((i.title || '').toLowerCase() === t && SHELVES.includes(i.status)));
}
function grRender(msg){
  const box = $('grBox'); box.hidden = false;
  if (msg) { box.innerHTML = `<p>${msg}</p><div class="acts"><button type="button" class="link" data-gr="close">Fermer</button></div>`; return; }
  const years = {}; let undated = 0;
  gr.books.forEach(b => { if (b.doneAt) { const y = new Date(b.doneAt).getFullYear(); years[y] = (years[y] || 0) + 1; } else undated++; });
  const ys = Object.keys(years).sort((a, b) => b - a);
  if (!ys.length) { grRender(`J’ai trouvé ${gr.books.length} livres lus, mais aucun n’a de date de lecture ni d’ajout. Vérifie que tu as bien choisi le fichier d’export d’origine, sans l’ouvrir dans Excel ou Numbers.`); return; }
  if (!gr.year || !years[gr.year]) gr.year = ys.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : ys[0];
  const pick = gr.books.filter(b => b.doneAt && String(new Date(b.doneAt).getFullYear()) === gr.year);
  const fresh = pick.filter(b => !grKnown(b)), bd = fresh.filter(b => b.type === 'bd').length, added = fresh.filter(b => b.byAdded).length;
  const fill = grFillable(pick);
  box.innerHTML = `<div class="top"><h2>Import Goodreads</h2><span class="sub">${gr.books.length} lus au total</span></div>
    <div class="field"><label for="grYear">Année de lecture</label>
      <select id="grYear">${ys.map(y => `<option value="${y}"${y === gr.year ? ' selected' : ''}>${y} · ${years[y]} livre${years[y] > 1 ? 's' : ''} lu${years[y] > 1 ? 's' : ''}</option>`).join('')}</select></div>
    <p><strong>${fresh.length} à ajouter</strong> dans « Terminé »${bd ? ` (dont ${bd} rangés en BD d’après tes étagères Goodreads)` : ''}${pick.length - fresh.length ? `. ${pick.length - fresh.length} y sont déjà, je les saute` : ''}.${added ? ` ${added} n’ont pas de date de lecture : je prends leur date d’ajout dans Goodreads.` : ''}${undated ? ` ${undated} livres sans aucune date sont ignorés.` : ''}${fill.length ? ` ${fill.length} fiche${fill.length > 1 ? 's' : ''} déjà importée${fill.length > 1 ? 's' : ''} seront complétée${fill.length > 1 ? 's' : ''} (pages, année, éditeur).` : ''}</p>
    ${fresh.length ? `<ol>${fresh.slice(0, 5).map(b => `<li>${esc(b.title)} · ${esc(b.creator)}</li>`).join('')}${fresh.length > 5 ? `<li style="list-style:none;color:var(--muted)">et ${fresh.length - 5} autres</li>` : ''}</ol>` : ''}
    <div class="acts">${fresh.length || fill.length ? `<button type="button" class="btn sun" data-gr="go">${fresh.length ? `Importer ${fresh.length} livre${fresh.length > 1 ? 's' : ''}` : `Compléter ${fill.length} fiche${fill.length > 1 ? 's' : ''}`}</button>` : ''}<button type="button" class="link" data-gr="close">Annuler</button></div>`;
}
function grFillable(books){
  const byTitle = b => state.items.find(i => SHELVES.includes(i.status) && (i.title || '').toLowerCase() === b.title.toLowerCase());
  return books.map(b => ({b, it: find('gr-' + b.gid) || byTitle(b)})).filter(({b, it}) => it &&
    ((!it.pages && b.pages) || (!it.pubYear && b.pubYear) || (!it.publisher && b.publisher) || (!it.isbn && b.isbn) || (!it.genre && b.genre)));
}
async function grImport(){
  if (gr.busy || !store) return;
  const inYear = gr.books.filter(b => b.doneAt && String(new Date(b.doneAt).getFullYear()) === gr.year);
  const fill = grFillable(inYear);
  for (const {b, it} of fill) {
    const patch = {};
    if (!it.pages && b.pages) patch.pages = b.pages;
    if (!it.pubYear && b.pubYear) patch.pubYear = b.pubYear;
    if (!it.publisher && b.publisher) patch.publisher = b.publisher;
    if (!it.isbn && b.isbn) patch.isbn = b.isbn;
    if (!it.genre && b.genre) patch.genre = b.genre;
    save(it.id, patch);
  }
  const pick = inYear.filter(b => !grKnown(b));
  gr.busy = true; let done = 0;
  const now = Date.now();
  for (const b of pick) {
    $('grBox').innerHTML = `<p class="busy"><span class="spin"></span>Import en cours : ${done} / ${pick.length}</p>`;
    const id = b.gid ? 'gr-' + b.gid : store.newId();
    try {
      await store.put(id, { type: b.type, status: 'termine', title: b.title, creator: b.creator, detail: b.detail,
        note: 'Importé de Goodreads', photo: null, createdAt: b.addedAt || b.doneAt, updatedAt: now, doneAt: b.doneAt, source: 'goodreads',
        pages: b.pages, pubYear: b.pubYear, publisher: b.publisher, isbn: b.isbn, genre: b.genre });
      done++;
    } catch (e) {
      gr.busy = false;
      grRender(e && e.code === 'resource_exhausted' ? `${done} livres importés, puis le serveur a demandé une pause. Relance l’import dans une minute : les livres déjà importés seront sautés.` : `${done} livres importés, puis l’enregistrement a échoué. Relance l’import pour finir.`);
      return;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  gr.busy = false;
  state.shelf = 'termine'; renderShelf();
  grRender(`<strong>${done} livre${done > 1 ? 's' : ''} ajouté${done > 1 ? 's' : ''}</strong> à l’étagère « Terminé » pour ${gr.year}${fill.length ? `, ${fill.length} fiche${fill.length > 1 ? 's' : ''} complétée${fill.length > 1 ? 's' : ''}` : ''}.`);
}
$('grBtn').onclick = () => { if (!store) { toast('Encore un instant, tes fiches se chargent.'); return; } $('grFile').click(); };
$('grFile').onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const books = grParse(await f.text());
    if (!books) { grRender('Ce fichier ne ressemble pas à un export Goodreads. Choisis le fichier goodreads_library_export.csv.'); return; }
    gr.books = books; gr.year = null; grRender(); $('grBox').scrollIntoView({behavior: 'smooth', block: 'nearest'});
  } catch (err) { grRender('Impossible de lire ce fichier.'); }
};
$('grBox').addEventListener('change', e => { if (e.target.id === 'grYear') { gr.year = e.target.value; grRender(); } });
$('grBox').addEventListener('click', e => { const b = e.target.closest('[data-gr]'); if (!b) return;
  if (b.dataset.gr === 'go') grImport(); else if (!gr.busy) { $('grBox').hidden = true; $('grBox').innerHTML = ''; } });

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.open) { openSheet(t.dataset.open); return; }
  if (t.dataset.go) { setView(t.dataset.go); return; }
  if (t.dataset.filter) { state.filter = t.dataset.filter; renderPile(); return; }
  if (t.dataset.cfilter) { state.colFilter = t.dataset.cfilter; renderCollection(); return; }
  if (t.dataset.env) { setEnvTab(t.dataset.env); return; }
  if (t.dataset.own && state.openId) { flushSave(); setOwned(state.openId, t.dataset.own === '1', !!t.dataset.close); return; }
  if (t.dataset.cond && state.openId) { const it = find(state.openId); save(state.openId, {cond: it && it.cond === t.dataset.cond ? null : t.dataset.cond}); renderAll(); return; }
  if (t.dataset.format && state.openId) { const it = find(state.openId); save(state.openId, {format: it && it.format === t.dataset.format ? null : t.dataset.format}); renderAll(); return; }
  if (t.dataset.plays && state.openId) { const it = find(state.openId); if (it) { save(state.openId, {plays: Math.max(0, (it.plays || 0) + (+t.dataset.plays))}); renderAll(); } return; }
  if (t.dataset.shelf) { state.shelf = t.dataset.shelf; renderShelf(); return; }
  if (t.dataset.syear) { state.statYear = +t.dataset.syear; renderStats(); return; }
  if (t.dataset.smode) { state.statMode = t.dataset.smode; renderStats(); return; }
  if (t.dataset.smonth) { const el = $('sm-' + t.dataset.smonth); if (el) el.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); return; }
  if (t.dataset.type && state.openId) { save(state.openId, {type: t.dataset.type}); renderAll(); return; }
  if (t.dataset.move && state.openId) { move(state.openId, t.dataset.move); return; }
  const act = t.dataset.act;
  if (act === 'photo') { if (!store) return; setMenu(true); }
  else if (act === 'library') { state.camTarget = null; $('lib').click(); }
  else if (act === 'zoom' && state.openId) { const it = find(state.openId); const src = it && (it.photo || state.previews[it.id]); if (src) openPhoto(src, t); }
  else if (act === 'close') closeSheet();
  else if (act === 'gone' && state.openId) { flushSave(); markGone(state.openId); }
  else if (act === 'cover' && state.openId) { flushSave(); delete state.idNote[state.openId]; autoEnrich(state.openId, true); }
  else if (act === 'uncover' && state.openId) { delete state.idNote[state.openId]; save(state.openId, {photo: null, coverFrom: 'none'}); renderAll(); toast('Couverture retirée. Tu peux ajouter une photo ou relancer la recherche.'); }
  else if (act === 'del') { state.delArmed = true; refreshSheet(); }
  else if (act === 'del-no') { state.delArmed = false; refreshSheet(); }
  else if (act === 'del-yes') { const id = state.openId; clearTimeout(saveTimer); state.openId = null; $('sheetWrap').hidden = true; document.body.style.overflow = '';
    const gone = find(id); pendingNew.delete(id); state.items = state.items.filter(i => i.id !== id); store.remove(id, gone && gone.photo).catch(() => toast('Suppression impossible. Réessaie.')); renderAll(); toast('Fiche supprimée'); }
});
function setAddTo(to){
  state.addTo = to === 'envie' ? 'envie' : 'collection';
  document.querySelectorAll('[data-to]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.to === state.addTo)));
}
function setMenu(open){
  if (open) setAddTo(state.view === 'envies' ? 'envie' : 'collection');
  $('addMenu').hidden = !open; $('fab').setAttribute('aria-expanded', String(open));
  if (open) $('addMenu').querySelector('[data-add]').focus({preventScroll: true});
}
$('fab').onclick = () => { if (!store) { toast('Encore un instant, tes fiches se chargent.'); return; } setMenu($('addMenu').hidden); };
$('addMenu').addEventListener('click', e => {
  const to = e.target.closest('[data-to]'); if (to) { setAddTo(to.dataset.to); return; }
  const b = e.target.closest('[data-add]'); if (!b) return;
  setMenu(false); state.camTarget = null;
  if (b.dataset.add === 'scan') openScanner();
  else if (b.dataset.add === 'cam') $('cam').click(); else if (b.dataset.add === 'lib') $('lib').click(); else addManual();
});
document.addEventListener('pointerdown', e => { if (!$('addMenu').hidden && !e.target.closest('#addMenu, #fab')) setMenu(false); });
$('cam').onchange = $('lib').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); };
$('q').oninput = e => { state.q = e.target.value; renderPile(); };
$('cq').oninput = e => { state.cq = e.target.value; renderCollection(); };
$('sheetWrap').addEventListener('click', e => { if (e.target === $('sheetWrap')) closeSheet(); });
$('sheet').addEventListener('input', e => { if (['fTitle','fCreator','fDetail','fNote','fPages','fGenre'].includes(e.target.id)) { scheduleSave(); $('sheetTitle').textContent = $('fTitle').value.trim() || 'Nouvelle envie'; $('sCreator').textContent = $('fCreator').value; } });
$('sheet').addEventListener('click', e => { if (e.target.closest('#sClose')) closeSheet(); if (e.target.closest('#sPhoto')) { flushSave(); state.camTarget = state.openId; $('lib').click(); } });
let lbReturn = null;
function openPhoto(src, from){ lbReturn = from || null; $('lbImg').src = src; $('lightbox').hidden = false; $('lbClose').focus({preventScroll: true}); }
function closePhoto(){ if ($('lightbox').hidden) return false; $('lightbox').hidden = true; $('lbImg').removeAttribute('src'); if (lbReturn && document.contains(lbReturn)) lbReturn.focus({preventScroll: true}); lbReturn = null; return true; }
$('lightbox').addEventListener('click', e => { e.stopPropagation(); closePhoto(); });
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (!$('scanner').hidden) { closeScanner(); return; } if (closePhoto()) return; if (!$('addMenu').hidden) { setMenu(false); $('fab').focus(); return; } if (state.openId || state.accountOpen) closeSheet(); });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
$('copyGifts').onclick = () => {
  const text = giftText(), ta = $('giftText');
  const fallback = () => { ta.value = text; ta.hidden = false; ta.focus(); ta.select(); toast('Sélectionne le texte et copie-le.'); };
  try { navigator.clipboard.writeText(text).then(() => toast('Liste copiée. Colle-la dans un message.'), fallback); } catch (err) { fallback(); }
};

/* ---------- shared gift list (public link) ---------- */
let giftLink = null, giftLinkArmed = false;
const newToken = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const giftUrl = t => new URL('cadeaux.html#' + t, location.href.split('#')[0]).href;
function renderGiftLink(){
  $('shareLabel').textContent = giftLink ? 'Partager le lien' : 'Créer le lien de partage';
  if (document.activeElement !== $('giftTitle')) $('giftTitle').value = giftLink ? giftLink.title : '';
  $('newGiftLink').hidden = !giftLink;
  $('newGiftLink').textContent = giftLinkArmed ? 'Confirmer : l’ancien lien ne marchera plus' : 'Changer le lien';
}
async function loadGiftLink(){
  try { const { data } = await sb.from('gift_lists').select('token,title').maybeSingle(); giftLink = data || null; } catch (e) {}
  renderGiftLink();
}
async function shareText(url, title){
  if (navigator.share) {
    try { await navigator.share({ title, text: `${title} : mes idées de cadeaux`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Lien copié. Colle-le dans un message.'); }
  catch (e) { const ta = $('giftText'); ta.value = url; ta.hidden = false; ta.focus(); ta.select(); toast('Sélectionne le lien et copie-le.'); }
}
$('shareGifts').onclick = async () => {
  if (!sb || !user) return;
  if (giftLink) { shareText(giftUrl(giftLink.token), giftLink.title); return; }
  // First time: create the link, then a second tap shares it (iOS only opens the share sheet straight from a tap).
  const title = $('giftTitle').value.trim() || 'Ma liste cadeaux';
  const { data, error } = await sb.from('gift_lists').insert({ user_id: user.id, token: newToken(), title }).select('token,title').single();
  if (error) { toast('Création du lien impossible. Vérifie ta connexion et réessaie.'); return; }
  giftLink = data; renderGiftLink();
  toast('Lien créé. Touche « Partager le lien » pour l’envoyer.');
};
$('giftTitle').addEventListener('change', async () => {
  const title = $('giftTitle').value.trim().slice(0, 80) || 'Ma liste cadeaux';
  if (!giftLink) return;
  const { error } = await sb.from('gift_lists').update({ title }).eq('user_id', user.id);
  if (error) toast('Titre non enregistré. Réessaie.'); else { giftLink.title = title; toast('Titre enregistré'); }
});
$('newGiftLink').onclick = async () => {
  if (!giftLink) return;
  if (!giftLinkArmed) { giftLinkArmed = true; renderGiftLink(); setTimeout(() => { giftLinkArmed = false; renderGiftLink(); }, 6000); return; }
  giftLinkArmed = false;
  const token = newToken();
  const { error } = await sb.from('gift_lists').update({ token }).eq('user_id', user.id);
  if (error) { toast('Changement impossible. Réessaie.'); renderGiftLink(); return; }
  giftLink.token = token; renderGiftLink();
  toast('Nouveau lien créé. L’ancien ne s’ouvre plus.');
};

/* ---------- barcode scan (ISBN) ---------- */
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
let zxingLoad = null;
function loadZXing(){
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return zxingLoad || (zxingLoad = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = ZXING_URL; sc.async = true;
    sc.onload = () => window.ZXing ? res(window.ZXing) : rej(new Error('zxing'));
    sc.onerror = () => { zxingLoad = null; rej(new Error('zxing')); };
    document.head.appendChild(sc);
  }));
}
function zxingReader(Z){
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader(); reader.setHints(hints);
  return canvas => { try { return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText(); } catch (e) { return null; } };
}
const check13 = b => String((10 - [...b].reduce((t, d, i) => t + (+d) * (i % 2 ? 3 : 1), 0) % 10) % 10);
function toIsbn13(raw){
  const v = String(raw || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (/^97[89]\d{10}$/.test(v)) return check13(v.slice(0, 12)) === v[12] ? v : null;
  if (/^\d{9}[\dX]$/.test(v)) { const sum = [...v].reduce((t, c, i) => t + (c === 'X' ? 10 : +c) * (10 - i), 0); if (sum % 11) return null; const b = '978' + v.slice(0, 9); return b + check13(b); }
  return null;
}
// Only Google Books categories are reliable enough to call something a comic;
// Open Library mixes the subjects of every edition (a novel's comic adaptation, for one).
const BD_RX = /comics|graphic novel|bande[s]?[ -]dessin|manga/i;
async function lookupIsbn(isbn){
  try {
    const d = await fetchJSON(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const b = d && d['ISBN:' + isbn];
    if (b && b.title) return {
      title: b.title, creator: (b.authors || []).map(a => a.name).join(', '),
      photo: b.cover ? (b.cover.large || b.cover.medium || null) : null, coverFrom: 'openlibrary' };
  } catch (e) {}
  try {
    const p = new URLSearchParams({q: 'isbn:' + isbn, maxResults: '1', fields: 'items(id,volumeInfo(title,subtitle,authors,imageLinks,categories))'});
    if (GOOGLE_BOOKS_KEY) p.set('key', GOOGLE_BOOKS_KEY);
    const d = await fetchJSON('https://www.googleapis.com/books/v1/volumes?' + p);
    const v = d.items && d.items[0], vi = v && v.volumeInfo;
    if (vi && vi.title) return {
      title: vi.title, creator: (vi.authors || []).join(', '),
      photo: vi.imageLinks ? `https://books.google.com/books/content?id=${encodeURIComponent(v.id)}&printsec=frontcover&img=1&zoom=1` : null, coverFrom: 'googlebooks',
      type: BD_RX.test((vi.categories || []).join(' ')) ? 'bd' : undefined };
  } catch (e) {}
  return null;
}
const scan = { stream: null, timer: null, busy: false, session: 0 };
const scanHint = t => { $('scanHint').textContent = t; };
async function openScanner(){
  if (!store) { toast('Encore un instant, tes fiches se chargent.'); return; }
  const session = ++scan.session;
  scan.busy = false; $('isbnIn').value = '';
  $('scanner').hidden = false; document.body.style.overflow = 'hidden';
  scanHint('Vise le code-barres au dos du livre.');
  $('scanClose').focus({preventScroll: true});
  loadZXing().catch(() => {});
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanHint('Caméra indisponible ici. Prends le code-barres en photo ou tape l’ISBN.'); return; }
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) { scanHint('Pas d’accès à la caméra. Autorise-la dans Réglages, prends le code-barres en photo ou tape l’ISBN.'); return; }
  if (session !== scan.session || $('scanner').hidden) { stopStream(); return; }
  const v = $('scanVideo'); v.srcObject = scan.stream; await v.play().catch(() => {});
  let detect = null;
  if ('BarcodeDetector' in window) {
    try {
      const fm = await window.BarcodeDetector.getSupportedFormats();
      if (fm.includes('ean_13')) { const bd = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] }); detect = async () => { const r = await bd.detect(v); return r[0] ? r[0].rawValue : null; }; }
    } catch (e) {}
  }
  if (!detect) {
    let Z; try { Z = await loadZXing(); } catch (e) { scanHint('Le lecteur de code-barres n’a pas pu se charger. Tape l’ISBN.'); return; }
    const read = zxingReader(Z), c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      const w = v.videoWidth, h = v.videoHeight; if (!w) return null;
      const cw = Math.round(w * 0.85), ch = Math.round(h * 0.45);
      c.width = cw; c.height = ch; ctx.drawImage(v, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
      return read(c);
    };
  }
  const loop = async () => {
    if (session !== scan.session || $('scanner').hidden || scan.busy) return;
    let code = null; try { code = await detect(); } catch (e) {}
    if (code && toIsbn13(code) !== null || code && /^\d{8,13}$/.test(code)) { onCode(code); return; }
    scan.timer = setTimeout(loop, 160);
  };
  loop();
}
function stopStream(){ if (scan.stream) { scan.stream.getTracks().forEach(t => t.stop()); scan.stream = null; } }
function closeScanner(){
  scan.session++; clearTimeout(scan.timer); stopStream();
  const v = $('scanVideo'); v.pause(); v.srcObject = null;
  $('scanner').hidden = true; document.body.style.overflow = '';
}
async function decodePhoto(file){
  scanHint('Lecture de la photo…');
  let Z; try { Z = await loadZXing(); } catch (e) { scanHint('Le lecteur de code-barres n’a pas pu se charger. Tape l’ISBN.'); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    const read = zxingReader(Z), c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * s), H = Math.round(img.naturalHeight * s);
    const tries = [[0, 0, W, H], [0, H * 0.25, W, H * 0.5], [W * 0.1, H * 0.35, W * 0.8, H * 0.3]];
    for (const [x, y, w, h] of tries) {
      c.width = Math.round(w); c.height = Math.round(h);
      ctx.drawImage(img, x / s, y / s, w / s, h / s, 0, 0, c.width, c.height);
      const code = read(c); if (code) { onCode(code); return; }
    }
    scanHint('Je ne trouve pas de code-barres sur cette photo. Rapproche-toi, ou tape l’ISBN.');
  } catch (e) { scanHint('Cette image ne s’ouvre pas. Essaie une autre photo.'); }
  finally { URL.revokeObjectURL(url); }
}
async function onCode(raw){
  if (scan.busy) return; scan.busy = true;
  clearTimeout(scan.timer);
  const code = String(raw).replace(/[^0-9X]/gi, '');
  const isbn = toIsbn13(code);
  if (!isbn) {
    if (/^\d{8,13}$/.test(code) && !/^97[89]/.test(code)) {
      closeScanner();
      createFromScan({ note: `Code-barres ${code}`, type: ['jeu', 'lego', 'objet'].includes(state.filter) ? state.filter : 'objet' }, 'Ce code-barres n’est pas celui d’un livre : indique le titre et choisis le type.');
    } else { scan.busy = false; scanHint('Ce numéro n’est pas un ISBN valide. Vérifie les chiffres.'); }
    return;
  }
  const dup = state.items.find(i => i.isbn === isbn);
  if (dup) { closeScanner(); openSheet(dup.id); toast(`Déjà dans tes fiches : « ${STATUS[dup.status] || ''} »`); return; }
  stopStream(); scanHint(`ISBN ${isbn} lu. Recherche du livre…`);
  const info = await lookupIsbn(isbn);
  closeScanner();
  if (info) createFromScan({ ...info, isbn }, info.photo ? 'Fiche remplie d’après le code-barres : vérifie et corrige si besoin.' : 'Livre trouvé, sans couverture : je cherche une couverture ailleurs en fermant la fiche.');
  else createFromScan({ isbn, note: `ISBN ${isbn}` }, navigator.onLine ? 'ISBN introuvable en ligne : indique le titre et l’auteur.' : 'Pas de connexion : indique le titre, la couverture sera cherchée plus tard.');
}
function createFromScan(d, note){
  const id = store.newId(), base = newBase(id);
  const it = { ...base, type: d.type || (['livre', 'bd'].includes(base.type) ? base.type : 'livre'),
    title: d.title || '', creator: d.creator || '', note: d.note || '', photo: d.photo || null, coverFrom: d.photo ? d.coverFrom : null, isbn: d.isbn || null };
  showTarget();
  createItem(it); state.idNote[id] = note; renderAll(); openSheet(id);
  if (!it.title) setTimeout(() => $('fTitle') && $('fTitle').focus(), 60);
}
$('scanClose').onclick = closeScanner;
$('scanPhoto').onclick = () => $('scanFile').click();
$('scanFile').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) decodePhoto(f); };
$('isbnForm').addEventListener('submit', e => { e.preventDefault(); const v = $('isbnIn').value.trim(); if (!v) { scanHint('Tape les 10 ou 13 chiffres de l’ISBN.'); return; } scan.busy = false; onCode(v); });
document.addEventListener('visibilitychange', () => { if (document.hidden && !$('scanner').hidden) closeScanner(); });

/* ---------- account + backup ---------- */
const USER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
function openAccount(){
  if (!user) return;
  state.accountOpen = true;
  $('sheet').innerHTML = `
    <div class="sheet-bar"><h2 id="sheetTitle">Mon compte</h2>
      <button type="button" class="iconbtn" id="sClose" aria-label="Fermer"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <p class="sub">Connecté avec <strong>${esc(user.email)}</strong> · ${state.items.length} fiche${state.items.length > 1 ? 's' : ''}</p>
    <div class="panel">
      <h2>Sauvegarde</h2>
      <p class="sub">Télécharge toutes tes fiches dans un fichier, ou importe un fichier de sauvegarde, par exemple celui de la version de test.</p>
      <div class="acts"><button type="button" class="btn" data-acc="export">Exporter mes fiches</button><button type="button" class="btn" data-acc="import">Importer une sauvegarde</button></div>
    </div>
    <div class="panel">
      <h2>Infos des livres</h2>
      <p class="sub">Cherche en ligne la couverture, le nombre de pages, l’année et le genre des livres et BD où ils manquent.</p>
      <div class="acts"><button type="button" class="btn" data-acc="covers">Compléter mes fiches</button></div>
    </div>
    <p id="accMsg" aria-live="polite"></p>
    <button type="button" class="link" data-acc="logout" style="align-self:flex-start">Se déconnecter</button>`;
  $('sheetWrap').hidden = false; document.body.style.overflow = 'hidden';
  $('sClose').focus({preventScroll: true});
}
function exportBackup(){
  const data = {app: 'ma-pile', version: 1, exportedAt: new Date().toISOString(), items: state.items};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'}));
  a.download = `ma-pile-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
let importing = false;
async function importBackup(file){
  const msg = t => { const m = $('accMsg'); if (m) m.innerHTML = t; };
  let list;
  try { const j = JSON.parse(await file.text()); list = Array.isArray(j) ? j : j && j.items; } catch (e) { list = null; }
  if (!Array.isArray(list)) { msg('Ce fichier n’est pas une sauvegarde Ma Pile.'); return; }
  const have = new Set(state.items.map(i => i.id));
  const todo = list.filter(x => x && x.id && !have.has(String(x.id)) && TYPES[x.type] && STATUS[x.status]);
  if (!todo.length) { msg('Rien à importer : toutes ces fiches sont déjà là.'); return; }
  importing = true; let done = 0, fail = 0, firstErr = '';
  for (const x of todo) {
    msg(`<span class="busy"><span class="spin"></span>Import en cours : ${done + fail} / ${todo.length}</span>`);
    let uploaded = null;
    try {
      let photo = typeof x.photo === 'string' ? x.photo : null;
      if (photo && photo.startsWith('data:')) photo = uploaded = await store.uploadPhoto(dataToBlob(photo));
      await store.put(String(x.id), {...x, photo});
      done++;
    } catch (e) {
      fail++; if (!firstErr) firstErr = String(e && e.message || e);
      if (uploaded) store.removePhoto(uploaded);
    }
  }
  importing = false;
  if (fail && !done) { msg(`Aucune fiche importée. Le serveur a répondu : « ${esc(firstErr)} ». Envoie-moi ce message si ça se reproduit.`); return; }
  const skipped = list.length - todo.length;
  msg(`<strong>${done} fiche${done > 1 ? 's' : ''} importée${done > 1 ? 's' : ''}.</strong>${skipped ? ` ${skipped} déjà présente${skipped > 1 ? 's' : ''}, ignorée${skipped > 1 ? 's' : ''}.` : ''}${fail ? ` ${fail} en échec : relance l’import pour réessayer.` : ''}`);
  store.reload().catch(() => {});
}
$('sheet').addEventListener('click', e => {
  const b = e.target.closest('[data-acc]'); if (!b) return;
  if (b.dataset.acc === 'export') exportBackup();
  else if (b.dataset.acc === 'import') { if (!importing) $('backupFile').click(); }
  else if (b.dataset.acc === 'covers') fillDetails();
  else if (b.dataset.acc === 'logout') { try { localStorage.removeItem(CACHE_KEY); } catch (err) {} sb.auth.signOut().finally(() => location.reload()); }
});
$('backupFile').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importBackup(f); };
$('acctBtn').onclick = openAccount;

/* ---------- sign in ---------- */
function lock(on){ document.body.classList.toggle('locked', on); $('auth').hidden = !on; }
function authMsg(t, bad){ const m = $('authMsg'); m.textContent = t; m.classList.toggle('bad', !!bad); }
const frErr = e => {
  const m = String(e && e.message || '');
  if (/invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/not confirmed/i.test(m)) return 'Confirme d’abord ton adresse : ouvre l’e-mail reçu, puis reviens te connecter.';
  if (/signups? not allowed|disabled/i.test(m)) return 'La création de compte est fermée sur cette app.';
  if (/password/i.test(m) && /6|short|least/i.test(m)) return 'Mot de passe trop court : 6 caractères minimum.';
  if (/already registered|already exists/i.test(m)) return 'Ce compte existe déjà : utilise « Se connecter ».';
  if (/fetch|network/i.test(m)) return 'Pas de connexion. Réessaie quand tu as du réseau.';
  return m || 'Une erreur est survenue. Réessaie.';
};
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!sb) return;
  const email = $('aEmail').value.trim(), password = $('aPass').value;
  if (!email || !password) { authMsg('Indique ton e-mail et ton mot de passe.', true); return; }
  const signup = e.submitter && e.submitter.dataset.mode === 'signup';
  const btns = $('authForm').querySelectorAll('button'); btns.forEach(b => b.disabled = true);
  authMsg(signup ? 'Création du compte…' : 'Connexion…');
  try {
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) authMsg(frErr(error), true);
      else if (data.session) enter(data.session.user);
      else authMsg('Compte créé. Ouvre l’e-mail de confirmation, puis reviens ici pour te connecter.');
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) authMsg(frErr(error), true); else enter(data.user);
    }
  } catch (err) { authMsg(frErr(err), true); }
  finally { btns.forEach(b => b.disabled = false); }
});

function enter(u){
  if (user) return;
  user = u; lock(false);
  store = supabaseStore(sb, u.id);
  loadGiftLink();
  store.subscribe(items => {
    for (const [id, it] of pendingNew) { if (items.some(x => x.id === id)) pendingNew.delete(id); else items.push(it); }
    state.items = items; state.ready = true; renderAll();
  });
}

/* ---------- start ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
renderAll();
(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    lock(true); $('authForm').hidden = true;
    authMsg('Configuration manquante : renseigne l’adresse et la clé Supabase dans config.js.', true);
    return;
  }
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  let session = null;
  try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
  setView(location.hash.slice(1) || 'collection');
  if (session) enter(session.user); else lock(true);
  sb.auth.onAuthStateChange((ev, s) => { if (s && !user) enter(s.user); });
})();
})();
