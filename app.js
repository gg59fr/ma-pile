import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

(function(){
const TYPES = {
  livre:{label:'Livre',plural:'Livres',c:'var(--c-livre)',t:'var(--cover-light)',shape:'spine'},
  bd:{label:'BD',plural:'BD',c:'var(--c-bd)',t:'var(--cover-light)',shape:'spine'},
  jeu:{label:'Jeu',plural:'Jeux',c:'var(--c-jeu)',t:'var(--cover-dark)',shape:'box'},
  lego:{label:'Lego',plural:'Lego',c:'var(--c-lego)',t:'var(--cover-light)',shape:'box'},
  objet:{label:'Objet',plural:'Objets',c:'var(--c-objet)',t:'var(--cover-light)',shape:'box'}
};
const STATUS = {pile:'Ma pile',cadeau:'Liste cadeaux',termine:'Terminé',telecharge:'Téléchargé',achete:'Acheté',abandonne:'Abandonné'};
const SHELVES = ['termine','telecharge','achete','abandonne'];
const ICON = {
  cadeau:'<rect x="3" y="8" width="18" height="4"/><path d="M5 12v8h14v-8M12 8v12M12 8c-1-3-5-4-5-1.5S10 8 12 8zm0 0c1-3 5-4 5-1.5S14 8 12 8z"/>',
  termine:'<path d="m5 12 5 5 9-10"/>',
  telecharge:'<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  achete:'<path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/>',
  abandonne:'<path d="M6 6l12 12M18 6 6 18"/>',
  pile:'<rect x="4" y="15" width="16" height="5"/><rect x="6" y="10" width="13" height="5"/><rect x="5" y="5" width="11" height="5"/>'
};
const ICOLOR = {termine:'var(--ok)',telecharge:'var(--c-livre)',achete:'var(--c-objet)',abandonne:'var(--accent)',cadeau:'currentColor',pile:'currentColor'};
const svg = (k,size=24,color='currentColor') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash = s => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
const titleOf = it => (it.title || '').trim() || 'Nouvelle envie';
const ago = ms => { if (!ms) return ''; const d = Math.floor((Date.now() - ms) / 864e5);
  if (d < 1) return 'Ajouté aujourd’hui'; if (d < 7) return `Ajouté il y a ${d} j`;
  if (d < 60) return `Ajouté il y a ${Math.floor(d / 7)} sem.`; return `Ajouté il y a ${Math.floor(d / 30)} mois`; };
const allowedMoves = it => {
  const base = it.type === 'objet' ? ['cadeau','achete','abandonne'] : ['cadeau','termine','telecharge','abandonne'];
  const out = base.filter(s => s !== it.status); if (it.status !== 'pile') out.push('pile'); return out; };

const state = { items: [], ready: false, view: 'pile', filter: 'all', q: '', shelf: 'termine',
  openId: null, identifying: new Set(), idNote: {}, previews: {}, camTarget: null, delArmed: false, accountOpen: false };
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
  photo: d.photo || null, source: d.source || null, cover_from: d.coverFrom || null,
  created_at: Math.round(d.createdAt || Date.now()), updated_at: Math.round(d.updatedAt || Date.now()),
  done_at: d.doneAt ? Math.round(d.doneAt) : null });
const fromRow = r => ({
  id: r.id, type: r.type, status: r.status, title: r.title, creator: r.creator, detail: r.detail, note: r.note,
  photo: r.photo, source: r.source, coverFrom: r.cover_from,
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
function setView(v){
  if (!['pile','cadeaux','etageres','stats'].includes(v)) v = 'pile';
  state.view = v;
  document.querySelectorAll('section[data-view]').forEach(s => s.hidden = s.dataset.view !== v);
  document.querySelectorAll('.tab').forEach(t => { if (t.dataset.go === v) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current'); });
  if (location.hash.slice(1) !== v) { try { history.replaceState(null, '', '#' + v); } catch (e) {} }
  window.scrollTo(0, 0);
}

function renderPile(){
  const pile = state.items.filter(i => i.status === 'pile');
  const gifts = state.items.filter(i => i.status === 'cadeau').length;
  $('pileSub').textContent = !state.ready ? 'Chargement…' :
    `${pile.length} envie${pile.length > 1 ? 's' : ''} en attente · ${gifts} dans la liste cadeaux`;
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
      : `<div class="empty" style="grid-column:1/-1"><strong>Ta pile est vide</strong>Prends en photo une couverture, une boîte de jeu ou un objet, ou note une idée sans photo : la fiche arrive ici.<button type="button" class="btn sun" data-act="photo">${'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>'}Ajouter une envie</button></div>`;
    return;
  }
  grid.innerHTML = list.map(it => `<button type="button" class="card" data-open="${esc(it.id)}">
      ${coverHTML(it)}
      <span class="meta"><span class="t">${esc(titleOf(it))}</span>
      <span class="w">${state.identifying.has(it.id) ? '<span class="busy"><span class="spin"></span>Envoi de la photo…</span>' : esc(it.creator || ago(it.createdAt))}</span></span>
    </button>`).join('');
}

function giftLines(){
  return state.items.filter(i => i.status === 'cadeau').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function renderGifts(){
  const g = giftLines();
  $('giftCount').textContent = `${g.length} envie${g.length > 1 ? 's' : ''}`;
  $('copyGifts').disabled = !g.length;
  $('giftList').innerHTML = !state.ready ? '' : g.length ? g.map(it => `<li><button type="button" class="rowitem" data-open="${esc(it.id)}">
      <span class="mini m-${esc(it.type)}" style="--c:${TYPES[it.type]?.c || TYPES.livre.c}">${it.photo ? `<img src="${esc(it.photo)}" alt="">` : ''}</span>
      <span class="meta"><span class="t">${esc(titleOf(it))}${it.detail ? ', ' + esc(it.detail) : ''}</span>
      <span class="w">${TYPES[it.type]?.label || ''}${it.creator ? ' · ' + esc(it.creator) : ''}</span></span></button></li>`).join('')
    : `<li class="empty"><strong>Liste vide</strong>Depuis une fiche de ta pile, choisis « Mettre dans ma liste cadeaux ».</li>`;
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
    <p class="idline" id="sId" aria-live="polite"></p>
    <div class="field"><label for="fTitle">Titre</label><input id="fTitle" autocomplete="off" value="${esc(it.title)}" placeholder="Titre"></div>
    <div class="two">
      <div class="field"><label for="fCreator">Auteur, éditeur ou marque</label><input id="fCreator" autocomplete="off" value="${esc(it.creator)}"></div>
      <div class="field"><label for="fDetail">Détail</label><input id="fDetail" autocomplete="off" value="${esc(it.detail)}" placeholder="Tome, n° de set…"></div>
    </div>
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
  state.openId = null; $('sheetWrap').hidden = true; $('sheet').innerHTML = ''; document.body.style.overflow = '';
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
  $('sPill').innerHTML = `${svg(it.status, 16, ICOLOR[it.status])} ${STATUS[it.status] || ''}`;
  $('sPhoto').textContent = shown ? 'Changer la photo' : 'Ajouter une photo';
  $('sId').innerHTML = state.identifying.has(it.id) ? '<span class="busy"><span class="spin"></span>Envoi de la photo…</span>' : esc(state.idNote[it.id] || '');
  document.querySelectorAll('#fType .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === it.type)));
  const moves = allowedMoves(it);
  const primary = moves.includes('cadeau') ? 'cadeau' : null;
  const rest = moves.filter(m => m !== primary && m !== 'pile');
  $('sMoves').innerHTML =
    (primary ? `<button type="button" class="big" data-move="cadeau">${svg('cadeau')}<span>Mettre dans ma liste cadeaux</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>` : '') +
    (rest.length ? `<div class="moves">${rest.map(m => `<button type="button" class="move" data-move="${m}">${svg(m, 24, ICOLOR[m])}${STATUS[m]}</button>`).join('')}</div>` : '') +
    (moves.includes('pile') ? `<button type="button" class="link" data-move="pile" style="align-self:center">Remettre dans ma pile</button>` : `<button type="button" class="link" data-act="close" style="align-self:center">Laisser dans ma pile pour l’instant</button>`);
  $('sDanger').innerHTML = state.delArmed
    ? `<button type="button" class="link confirm" data-act="del-yes">Oui, supprimer la fiche</button><button type="button" class="link" data-act="del-no">Garder</button>`
    : `<button type="button" class="link" data-act="del">Supprimer la fiche</button>`;
}

let saveTimer = null;
function formPatch(){
  if (!state.openId || !$('fTitle')) return {};
  return { title: $('fTitle').value.trim().slice(0, 200), creator: $('fCreator').value.trim().slice(0, 200),
    detail: $('fDetail').value.trim().slice(0, 80), note: $('fNote').value.slice(0, 2000) };
}
function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600); }
function flushSave(){
  clearTimeout(saveTimer); saveTimer = null;
  const it = state.openId && find(state.openId); if (!it || !$('fTitle')) return;
  const p = formPatch();
  if (['title','creator','detail','note'].every(k => (it[k] || '') === p[k])) return;
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
  const prev = it.status, prevDone = it.doneAt || null;
  save(id, {status, doneAt: SHELVES.includes(status) ? Date.now() : null});
  closeSheet();
  toast(status === 'pile' ? 'Remis dans ta pile' : `Rangé dans « ${STATUS[status]} »`, () => save(id, {status: prev, doneAt: prevDone}));
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
    const it = {id, type: state.filter !== 'all' ? state.filter : 'livre', status: state.view === 'cadeaux' ? 'cadeau' : 'pile', title: '', creator: '', detail: '', note: '', photo: null, createdAt: now, updatedAt: now};
    state.previews[id] = preview;
    createItem(it);
    if (state.view === 'etageres' || state.view === 'stats') setView('pile');
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

function addManual(){
  const now = Date.now(), id = store.newId();
  const it = {id, type: state.filter !== 'all' ? state.filter : 'livre', status: state.view === 'cadeaux' ? 'cadeau' : 'pile', title: '', creator: '', detail: '', note: '', photo: null, createdAt: now, updatedAt: now};
  if (state.view === 'etageres') setView('pile');
  createItem(it); renderAll(); openSheet(id);
  setTimeout(() => $('fTitle') && $('fTitle').focus(), 50);
}

function renderAll(){ renderPile(); renderGifts(); renderShelf(); renderStats(); refreshSheet(); }

/* ---------- stats ---------- */
const MOIS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
const plur = (n, one, many) => `${n} ${n > 1 ? many : one}`;
function renderStats(){
  const when = i => new Date(i.doneAt || i.updatedAt || 0);
  const reads = state.items.filter(i => i.status === 'termine' && (i.type === 'livre' || i.type === 'bd'));
  const now = new Date(), cur = now.getFullYear();
  const years = [...new Set(reads.map(i => when(i).getFullYear()).concat(cur))].sort((a, b) => b - a);
  if (!years.includes(state.statYear)) state.statYear = cur;
  const y = state.statYear;
  $('statYears').innerHTML = years.map(yy => `<button type="button" class="chip" data-syear="${yy}" aria-pressed="${yy === y}">${yy}</button>`).join('');
  const body = $('statBody');
  if (!state.ready) { body.innerHTML = '<p class="sub">Chargement…</p>'; return; }
  const list = reads.filter(i => when(i).getFullYear() === y).sort((a, b) => when(a) - when(b));
  if (!list.length) {
    body.innerHTML = `<div class="empty"><strong>Aucune lecture terminée en ${y}</strong>Range un livre ou une BD dans « Terminé » depuis sa fiche, ou importe tes lectures Goodreads depuis l’onglet Étagères.</div>`;
    return;
  }
  const m = Array.from({length: 12}, () => ({livre: [], bd: []}));
  list.forEach(i => m[when(i).getMonth()][i.type].push(i));
  const tot = k => m[k].livre.length + m[k].bd.length;
  const max = Math.max(1, ...m.map((_, k) => tot(k)));
  const nl = list.filter(i => i.type === 'livre').length, nb = list.length - nl;
  const lastM = y === cur ? now.getMonth() : 11;
  const avg = (list.length / (lastM + 1)).toLocaleString('fr-FR', {maximumFractionDigits: 1});
  let best = 0; for (let k = 1; k < 12; k++) if (tot(k) > tot(best)) best = k;
  const piece = (n, type) => n ? `<span class="piece m-${type}" style="--c:${TYPES[type].c};height:${(n / max * 100).toFixed(2)}%"></span>` : '';
  const label = MOIS.map((mm, k) => `${mm} ${tot(k)}`).join(', ');
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <div class="tiles">
      <div class="tile"><b>${list.length}</b><span>${list.length > 1 ? 'lectures' : 'lecture'}</span></div>
      <div class="tile"><b>${nl}</b><span><i class="sw" style="--c:${TYPES.livre.c}"></i>${nl > 1 ? 'livres' : 'livre'}</span></div>
      <div class="tile"><b>${nb}</b><span><i class="sw m-bd" style="--c:${TYPES.bd.c}"></i>BD</span></div>
    </div>
    <div class="chart">
      <div class="top"><h2>Par mois</h2><div class="legend" aria-hidden="true"><span><i class="sw" style="--c:${TYPES.livre.c}"></i>Livres</span><span><i class="sw m-bd" style="--c:${TYPES.bd.c}"></i>BD</span></div></div>
      <div class="cols" role="img" aria-label="Lectures terminées par mois en ${y} : ${esc(label)}">
        ${m.map((x, k) => `<button type="button" class="col" data-smonth="${k}" ${tot(k) ? '' : 'disabled'} aria-hidden="true" tabindex="-1"><span class="n">${tot(k) || ''}</span><span class="bar">${piece(x.bd.length, 'bd')}${piece(x.livre.length, 'livre')}</span></button>`).join('')}
      </div>
      <div class="mos" aria-hidden="true">${MOIS.map((mm, k) => `<span class="${y === cur && k === lastM ? 'now' : ''}">${mm[0]}</span>`).join('')}</div>
      <p class="chart-note">${avg} par mois en moyenne${y === cur ? ' depuis janvier' : ''} · meilleur mois : ${MOIS[best].toLowerCase()} (${tot(best)})</p>
    </div>
    <div class="months">
      ${m.map((x, k) => ({x, k})).filter(o => tot(o.k)).reverse().map(({x, k}) => `<section class="mrow" id="sm-${k}" aria-labelledby="smh-${k}">
        <div class="mhead"><h3 id="smh-${k}">${MOIS[k]}</h3><span>${[x.livre.length ? plur(x.livre.length, 'livre', 'livres') : '', x.bd.length ? `${x.bd.length} BD` : ''].filter(Boolean).join(' · ')}</span></div>
        <ul class="mlist">${[...x.livre, ...x.bd].sort((a, b) => when(a) - when(b)).map(i => `<li><button type="button" class="mitem" data-open="${esc(i.id)}"><i class="sw${i.type === 'bd' ? ' m-bd' : ''}" style="--c:${TYPES[i.type].c}" aria-label="${TYPES[i.type].label}"></i><span class="t">${esc(titleOf(i))}${i.detail ? ', ' + esc(i.detail) : ''}</span><span class="w">${esc(i.creator || '')}</span></button></li>`).join('')}</ul>
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
  box.innerHTML = `<div class="top"><h2>Import Goodreads</h2><span class="sub">${gr.books.length} lus au total</span></div>
    <div class="field"><label for="grYear">Année de lecture</label>
      <select id="grYear">${ys.map(y => `<option value="${y}"${y === gr.year ? ' selected' : ''}>${y} · ${years[y]} livre${years[y] > 1 ? 's' : ''} lu${years[y] > 1 ? 's' : ''}</option>`).join('')}</select></div>
    <p><strong>${fresh.length} à ajouter</strong> dans « Terminé »${bd ? ` (dont ${bd} rangés en BD d’après tes étagères Goodreads)` : ''}${pick.length - fresh.length ? `. ${pick.length - fresh.length} y sont déjà, je les saute` : ''}.${added ? ` ${added} n’ont pas de date de lecture : je prends leur date d’ajout dans Goodreads.` : ''}${undated ? ` ${undated} livres sans aucune date sont ignorés.` : ''}</p>
    ${fresh.length ? `<ol>${fresh.slice(0, 5).map(b => `<li>${esc(b.title)} · ${esc(b.creator)}</li>`).join('')}${fresh.length > 5 ? `<li style="list-style:none;color:var(--muted)">et ${fresh.length - 5} autres</li>` : ''}</ol>` : ''}
    <div class="acts">${fresh.length ? `<button type="button" class="btn sun" data-gr="go">Importer ${fresh.length} livre${fresh.length > 1 ? 's' : ''}</button>` : ''}<button type="button" class="link" data-gr="close">Annuler</button></div>`;
}
async function grImport(){
  if (gr.busy || !store) return;
  const pick = gr.books.filter(b => b.doneAt && String(new Date(b.doneAt).getFullYear()) === gr.year && !grKnown(b));
  gr.busy = true; let done = 0;
  const now = Date.now();
  for (const b of pick) {
    $('grBox').innerHTML = `<p class="busy"><span class="spin"></span>Import en cours : ${done} / ${pick.length}</p>`;
    const id = b.gid ? 'gr-' + b.gid : store.newId();
    try {
      await store.put(id, { type: b.type, status: 'termine', title: b.title, creator: b.creator, detail: b.detail,
        note: 'Importé de Goodreads', photo: null, createdAt: b.addedAt || b.doneAt, updatedAt: now, doneAt: b.doneAt, source: 'goodreads' });
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
  grRender(`<strong>${done} livre${done > 1 ? 's' : ''} ajouté${done > 1 ? 's' : ''}</strong> à l’étagère « Terminé » pour ${gr.year}.`);
}
$('grBtn').onclick = () => { if (!store) { toast('Encore un instant, ta pile se charge.'); return; } $('grFile').click(); };
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
  if (t.dataset.shelf) { state.shelf = t.dataset.shelf; renderShelf(); return; }
  if (t.dataset.syear) { state.statYear = +t.dataset.syear; renderStats(); return; }
  if (t.dataset.smonth) { const el = $('sm-' + t.dataset.smonth); if (el) el.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'}); return; }
  if (t.dataset.type && state.openId) { save(state.openId, {type: t.dataset.type}); refreshSheet(); renderPile(); return; }
  if (t.dataset.move && state.openId) { move(state.openId, t.dataset.move); return; }
  const act = t.dataset.act;
  if (act === 'photo') { if (!store) return; setMenu(true); }
  else if (act === 'library') { state.camTarget = null; $('lib').click(); }
  else if (act === 'zoom' && state.openId) { const it = find(state.openId); const src = it && (it.photo || state.previews[it.id]); if (src) openPhoto(src, t); }
  else if (act === 'close') closeSheet();
  else if (act === 'del') { state.delArmed = true; refreshSheet(); }
  else if (act === 'del-no') { state.delArmed = false; refreshSheet(); }
  else if (act === 'del-yes') { const id = state.openId; clearTimeout(saveTimer); state.openId = null; $('sheetWrap').hidden = true; document.body.style.overflow = '';
    const gone = find(id); pendingNew.delete(id); state.items = state.items.filter(i => i.id !== id); store.remove(id, gone && gone.photo).catch(() => toast('Suppression impossible. Réessaie.')); renderAll(); toast('Fiche supprimée'); }
});
function setMenu(open){
  $('addMenu').hidden = !open; $('fab').setAttribute('aria-expanded', String(open));
  if (open) $('addMenu').querySelector('button').focus({preventScroll: true});
}
$('fab').onclick = () => { if (!store) { toast('Encore un instant, ta pile se charge.'); return; } setMenu($('addMenu').hidden); };
$('addMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  setMenu(false); state.camTarget = null;
  if (b.dataset.add === 'cam') $('cam').click(); else if (b.dataset.add === 'lib') $('lib').click(); else addManual();
});
document.addEventListener('pointerdown', e => { if (!$('addMenu').hidden && !e.target.closest('#addMenu, #fab')) setMenu(false); });
$('cam').onchange = $('lib').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); };
$('q').oninput = e => { state.q = e.target.value; renderPile(); };
$('sheetWrap').addEventListener('click', e => { if (e.target === $('sheetWrap')) closeSheet(); });
$('sheet').addEventListener('input', e => { if (['fTitle','fCreator','fDetail','fNote'].includes(e.target.id)) { scheduleSave(); $('sheetTitle').textContent = $('fTitle').value.trim() || 'Nouvelle envie'; $('sCreator').textContent = $('fCreator').value; } });
$('sheet').addEventListener('click', e => { if (e.target.closest('#sClose')) closeSheet(); if (e.target.closest('#sPhoto')) { flushSave(); state.camTarget = state.openId; $('lib').click(); } });
let lbReturn = null;
function openPhoto(src, from){ lbReturn = from || null; $('lbImg').src = src; $('lightbox').hidden = false; $('lbClose').focus({preventScroll: true}); }
function closePhoto(){ if ($('lightbox').hidden) return false; $('lightbox').hidden = true; $('lbImg').removeAttribute('src'); if (lbReturn && document.contains(lbReturn)) lbReturn.focus({preventScroll: true}); lbReturn = null; return true; }
$('lightbox').addEventListener('click', e => { e.stopPropagation(); closePhoto(); });
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (closePhoto()) return; if (!$('addMenu').hidden) { setMenu(false); $('fab').focus(); return; } if (state.openId || state.accountOpen) closeSheet(); });
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
$('copyGifts').onclick = () => {
  const text = giftText(), ta = $('giftText');
  const fallback = () => { ta.value = text; ta.hidden = false; ta.focus(); ta.select(); toast('Sélectionne le texte et copie-le.'); };
  try { navigator.clipboard.writeText(text).then(() => toast('Liste copiée. Colle-la dans un message.'), fallback); } catch (err) { fallback(); }
};

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
      <p id="accMsg" aria-live="polite"></p>
    </div>
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
  if (!todo.length) { msg('Rien à importer : toutes ces fiches sont déjà dans ta pile.'); return; }
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
  setView(location.hash.slice(1) || 'pile');
  if (session) enter(session.user); else lock(true);
  sb.auth.onAuthStateChange((ev, s) => { if (s && !user) enter(s.user); });
})();
})();
