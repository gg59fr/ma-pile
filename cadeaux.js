// Public gift list: anyone with the link can see the gifts and reserve one.
// Reservations go through database functions; the list owner never sees them.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import * as CONFIG from './config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPES = {
  livre: { label: 'Livre', c: 'var(--c-livre)' }, bd: { label: 'BD', c: 'var(--c-bd)' }, jeu: { label: 'Jeu', c: 'var(--c-jeu)' },
  lego: { label: 'Lego', c: 'var(--c-lego)' }, objet: { label: 'Objet', c: 'var(--c-objet)' }
};

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const token = decodeURIComponent(location.hash.slice(1));
const MINE_KEY = 'mapile-resa-' + token;
let mine = {}, list = null, busy = new Set();
try { mine = JSON.parse(localStorage.getItem(MINE_KEY) || '{}'); } catch (e) {}
const saveMine = () => { try { localStorage.setItem(MINE_KEY, JSON.stringify(mine)); } catch (e) {} };

let toastTimer = null;
function toast(msg){
  const t = $('toast'); t.innerHTML = `<span>${esc(msg)}</span>`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function render(){
  if (!list) return;
  document.title = list.title;
  $('pTitle').textContent = list.title;
  const items = list.items || [];
  const free = items.filter(i => !i.reserved).length;
  const mineCount = items.filter(i => mine[i.id]).length;
  $('pSub').textContent = items.length
    ? `${items.length} idée${items.length > 1 ? 's' : ''} · ${free} encore libre${free > 1 ? 's' : ''}${mineCount ? ` · tu en offres ${mineCount}` : ''}`
    : 'La liste est vide pour l’instant. Reviens plus tard !';
  $('pInfo').hidden = !items.length;
  $('pBgg').hidden = !items.some(i => /geekdo-images\.com/.test(i.photo || ''));
  $('pList').innerHTML = items.map(it => {
    const T = TYPES[it.type] || TYPES.objet;
    const own = !!mine[it.id], taken = it.reserved && !own, wait = busy.has(it.id);
    const action = own
      ? `<span class="pub-state ok">Tu l’offres</span><button type="button" class="link" data-cancel="${esc(it.id)}"${wait ? ' disabled' : ''}>Annuler</button>`
      : taken ? `<span class="pub-state">Déjà réservé</span>`
      : `<button type="button" class="btn sun pub-btn" data-take="${esc(it.id)}"${wait ? ' disabled' : ''}>${wait ? 'Un instant…' : 'Je l’offre'}</button>`;
    return `<li class="pub-row${taken ? ' taken' : ''}">
      <span class="mini m-${esc(it.type)}" style="--c:${T.c}">${it.photo ? `<img src="${esc(it.photo)}" alt="" loading="lazy">` : ''}</span>
      <span class="meta"><span class="t">${esc(it.title || 'Sans titre')}${it.detail ? ', ' + esc(it.detail) : ''}</span>
        <span class="w">${T.label}${it.creator ? ' · ' + esc(it.creator) : ''}</span></span>
      <span class="pub-act">${action}</span></li>`;
  }).join('');
}

async function load(){
  if (!token) { fail('Ce lien est incomplet. Demande à nouveau le lien de la liste.'); return; }
  const { data, error } = await sb.rpc('gift_list', { p_token: token });
  if (error) { if (!list) fail(navigator.onLine ? 'La liste ne s’est pas chargée. Recharge la page.' : 'Pas de connexion. Recharge la page quand tu as du réseau.'); return; }
  if (!data) { fail('Ce lien ne fonctionne plus : la liste a peut-être été partagée avec un nouveau lien. Demande le lien à jour.'); return; }
  list = data;
  // Forget reservations of mine that no longer exist (cancelled elsewhere, gift removed from the list).
  for (const id of Object.keys(mine)) if (!list.items.some(i => i.id === id && i.reserved)) delete mine[id];
  saveMine(); render();
}
function fail(msg){ $('pSub').textContent = msg; $('pList').innerHTML = ''; $('pInfo').hidden = true; }

$('pList').addEventListener('click', async e => {
  const take = e.target.closest('[data-take]'), cancel = e.target.closest('[data-cancel]');
  const id = take ? take.dataset.take : cancel ? cancel.dataset.cancel : null;
  if (!id || busy.has(id)) return;
  busy.add(id); render();
  if (take) {
    const { data, error } = await sb.rpc('reserve_gift', { p_token: token, p_item: id });
    if (error) toast(/already_reserved/.test(error.message) ? 'Quelqu’un vient de le réserver. Choisis une autre idée !' : 'Réservation impossible pour le moment. Réessaie.');
    else { mine[id] = data; saveMine(); toast('C’est noté : tu l’offres. Garde cette page pour annuler si besoin.'); }
  } else {
    const { data, error } = await sb.rpc('unreserve_gift', { p_token: token, p_item: id, p_secret: mine[id] || '' });
    if (error || !data) toast('Annulation impossible. Réessaie.');
    else { delete mine[id]; saveMine(); toast('Réservation annulée.'); }
  }
  busy.delete(id); await load();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
window.addEventListener('hashchange', () => location.reload());
load();
