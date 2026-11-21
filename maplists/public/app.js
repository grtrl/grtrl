/* global L, JSZip */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  me: null,
  lists: [],
  places: [],
  friends: [],
  selectedList: null, // id ou null = toutes
  selectedPlace: null,
  placing: null,      // lieu en cours de placement manuel
  geoCounts: null,
};
const isOwner = () => state.me && state.me.role === 'owner';

// ------------------------------------------------------------------ API
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login')) { showAuth(); }
    throw new Error((data && data.error) || `Erreur ${res.status}`);
  }
  return data;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Lien copié'); }
  catch { prompt('Copie ce lien :', text); }
}

// ------------------------------------------------------------------ Auth
async function boot() {
  state.me = await api('/api/me');
  if (!state.me.role) return showAuth();
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  document.body.classList.toggle('is-owner', isOwner());
  $$('.owner-only').forEach(el => {
    if (isOwner()) el.classList.remove('hidden');
    else if (el.tagName === 'OPTION') el.disabled = el.hidden = true; // Safari ignore display:none sur <option>
    else el.classList.add('hidden');
  });
  $('#btn-logout').classList.toggle('hidden', !isOwner());
  $('#brand-title').textContent = isOwner() ? 'Mes listes' : `Listes partagées avec ${state.me.friendName}`;
  initMap();
  await refresh();
  if (isOwner()) pollGeo();
}

function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  const setup = state.me && state.me.needsSetup;
  $('#auth-text').textContent = setup
    ? 'Première connexion : choisis ton mot de passe (8 caractères minimum). C\'est toi le propriétaire du site.'
    : 'Connecte-toi pour gérer tes listes. Si un ami t\'a partagé ses listes, utilise le lien qu\'il t\'a envoyé.';
  $('#auth-btn').textContent = setup ? 'Créer mon mot de passe' : 'Se connecter';
  $('#auth-password').autocomplete = setup ? 'new-password' : 'current-password';
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const password = $('#auth-password').value;
    await api(state.me && state.me.needsSetup ? '/api/setup' : '/api/login', { method: 'POST', body: { password } });
    $('#auth-password').value = '';
    await boot();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

// ------------------------------------------------------------------ Données
async function refresh() {
  const [lists, places] = await Promise.all([api('/api/lists'), api('/api/places')]);
  state.lists = lists;
  state.places = places;
  if (state.selectedList && !lists.find(l => l.id === state.selectedList)) state.selectedList = null;
  if (isOwner()) state.friends = await api('/api/friends');
  renderAll();
}

const listById = (id) => state.lists.find(l => l.id === id);
const placeById = (id) => state.places.find(p => p.id === id);
const tagsOf = (p) => [...new Set([p.tags, p.takeout_tags].join(',').split(',').map(t => t.trim()).filter(Boolean))];

function renderAll() {
  renderLists();
  renderListHeader();
  renderTagFilter();
  renderPlaces();
  renderMarkers();
  if (state.selectedPlace) {
    if (placeById(state.selectedPlace)) renderDetail(); else closeDetail();
  }
}

// ------------------------------------------------------------------ Listes (sidebar)
const VIS_ICON = { private: '🔒', friends: '👥', selected: '👤' };

function renderLists() {
  const ul = $('#lists');
  const total = state.places.length;
  let html = `<li data-id="" class="${state.selectedList == null ? 'active' : ''}">
    <span class="dot" style="background:conic-gradient(#e6194b,#3cb44b,#4363d8,#f58231,#e6194b)"></span>
    <span class="name">Toutes les listes</span><span class="n">${total}</span></li>`;
  for (const l of state.lists) {
    html += `<li data-id="${l.id}" class="${state.selectedList === l.id ? 'active' : ''}">
      <span class="dot" style="background:${esc(l.color)}"></span>
      <span class="name" title="${esc(l.name)}">${esc(l.name)}</span>
      ${isOwner() ? `<span class="vis" title="${visLabel(l)}">${VIS_ICON[l.visibility] || ''}</span>` : ''}
      <span class="n">${l.count}</span></li>`;
  }
  if (!state.lists.length) {
    html += `<li class="muted" style="cursor:default">${isOwner() ? 'Aucune liste. Commence par importer ton Google Takeout.' : 'Aucune liste partagée pour l\'instant.'}</li>`;
  }
  ul.innerHTML = html;
}

function visLabel(l) {
  if (l.visibility === 'friends') return 'Visible par tous tes amis';
  if (l.visibility === 'selected') return `Visible par ${l.friend_ids.length} ami(s) choisi(s)`;
  return 'Privée';
}

$('#lists').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  state.selectedList = li.dataset.id ? Number(li.dataset.id) : null;
  $('#sidebar').classList.remove('open');
  renderAll();
  fitToPlaces();
});
$('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

function renderListHeader() {
  const el = $('#list-header');
  const l = listById(state.selectedList);
  if (!l) { el.innerHTML = ''; return; }
  const follow = l.gmaps_url
    ? `<div class="gmaps-follow">
         <a class="btn primary big" href="${esc(l.gmaps_url)}" target="_blank" rel="noopener">Ouvrir dans Google Maps → « Suivre »</a>
         <small>${isOwner() ? 'C\'est ce lien que tes amis utilisent pour ajouter la liste dans leur appli.' : 'Le lien ouvre la liste dans l\'appli Google Maps : appuie sur « Suivre » pour la retrouver dans tes listes enregistrées.'}</small>
       </div>`
    : (isOwner()
      ? `<div class="gmaps-follow"><button class="btn big" data-act="settings">🔗 Ajouter le lien de partage Google Maps</button>
           <small>Sans ce lien, tes amis voient la liste ici mais ne peuvent pas la suivre dans Google Maps.</small></div>`
      : `<div class="gmaps-follow"><small>Le lien Google Maps de cette liste n'est pas encore disponible. Tu peux ouvrir chaque lieu dans Google Maps.</small></div>`);
  el.innerHTML = `
    <div class="title-row">
      <span class="dot" style="width:12px;height:12px;border-radius:50%;background:${esc(l.color)}"></span>
      <h2>${esc(l.name)}</h2>
      ${isOwner() ? `<span class="badge" title="${visLabel(l)}">${VIS_ICON[l.visibility]} ${l.visibility === 'private' ? 'privée' : 'partagée'}</span>` : ''}
    </div>
    ${l.description ? `<p>${esc(l.description)}</p>` : ''}
    ${follow}
    ${isOwner() ? `<div class="actions">
      <button class="btn small" data-act="settings">⚙ Réglages & partage</button>
      <button class="btn small" data-act="add-place">+ Lieu</button>
    </div>` : ''}`;
}

$('#list-header').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'settings') openListSettings(state.selectedList);
  if (b.dataset.act === 'add-place') openAddPlace(state.selectedList);
});

// ------------------------------------------------------------------ Filtres
function renderTagFilter() {
  const sel = $('#f-tag');
  const cur = sel.value;
  const tags = new Set();
  for (const p of placesInScope()) tagsOf(p).forEach(t => tags.add(t));
  sel.innerHTML = '<option value="">Tous les tags</option>' +
    [...tags].sort((a, b) => a.localeCompare(b, 'fr')).map(t => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

const placesInScope = () => state.selectedList == null ? state.places : state.places.filter(p => p.list_id === state.selectedList);

function filteredPlaces() {
  const q = $('#f-search').value.trim().toLowerCase();
  const tag = $('#f-tag').value;
  const status = $('#f-status').value;
  const minRating = Number($('#f-rating').value);
  const bounds = $('#f-bounds').checked && map ? map.getBounds() : null;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nq = norm(q);

  let res = placesInScope().filter(p => {
    if (nq && !norm([p.title, p.note, p.takeout_note, p.takeout_comment, p.tags, p.takeout_tags, p.address].join(' ')).includes(nq)) return false;
    if (tag && !tagsOf(p).includes(tag)) return false;
    if (minRating && (p.rating || 0) < minRating) return false;
    if (status === 'todo' && p.visited) return false;
    if (status === 'visited' && !p.visited) return false;
    if (status === 'noted' && !(p.note || p.takeout_note || p.takeout_comment)) return false;
    if (status === 'unlocated' && p.lat != null) return false;
    if (status === 'approx' && p.geo_status !== 'approx') return false;
    if (bounds && (p.lat == null || !bounds.contains([p.lat, p.lng]))) return false;
    return true;
  });
  const sort = $('#f-sort').value;
  const byName = (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
  if (sort === 'name') res.sort(byName);
  if (sort === 'recent') res.sort((a, b) => (b.added_at || '').localeCompare(a.added_at || '') || b.id - a.id);
  if (sort === 'rating') res.sort((a, b) => (b.rating || 0) - (a.rating || 0) || byName(a, b));
  if (sort === 'list') res.sort((a, b) => (listById(a.list_id)?.name || '').localeCompare(listById(b.list_id)?.name || '', 'fr') || byName(a, b));
  return res;
}

['#f-search', '#f-tag', '#f-status', '#f-rating', '#f-sort', '#f-bounds'].forEach(s =>
  $(s).addEventListener(s === '#f-search' ? 'input' : 'change', () => { renderPlaces(); renderMarkers(); }));

// ------------------------------------------------------------------ Liste des lieux
const stars = (n) => n ? `<span class="stars">${'★'.repeat(n)}</span>` : '';

function renderPlaces() {
  const list = filteredPlaces();
  const scope = placesInScope().length;
  $('#count').textContent = list.length === scope ? `${scope} lieu${scope > 1 ? 'x' : ''}` : `${list.length} / ${scope} lieux`;
  const ul = $('#places');
  if (!list.length) {
    ul.innerHTML = `<li class="muted" style="cursor:default">${scope ? 'Aucun lieu ne correspond aux filtres.' : 'Aucun lieu ici.'}</li>`;
    return;
  }
  ul.innerHTML = list.slice(0, 1500).map(p => {
    const l = listById(p.list_id);
    const note = p.note || p.takeout_note || p.takeout_comment;
    const badges = [
      p.visited ? '<span class="badge ok">✓ visité</span>' : '',
      p.lat == null ? (p.geo_status === 'pending' ? '<span class="badge">localisation…</span>' : '<span class="badge warn">non localisé</span>') : '',
      isOwner() && p.geo_status === 'approx' ? '<span class="badge warn">position à vérifier</span>' : '',
    ].join('');
    return `<li data-id="${p.id}" class="${state.selectedPlace === p.id ? 'active' : ''}">
      <span class="dot" style="background:${esc(l?.color)}"></span>
      <div class="body">
        <div class="t">${esc(p.title)} ${stars(p.rating)}</div>
        <div class="meta">${state.selectedList == null ? esc(l?.name) + ' · ' : ''}${esc(p.address || '')}</div>
        ${note ? `<div class="note">${esc(note)}</div>` : ''}
        ${badges || tagsOf(p).length ? `<div>${badges}${tagsOf(p).map(t => `<span class="badge">#${esc(t)}</span>`).join('')}</div>` : ''}
      </div></li>`;
  }).join('');
}

$('#places').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) selectPlace(Number(li.dataset.id), true);
});

// ------------------------------------------------------------------ Carte
let map, cluster;
const markers = new Map();

function initMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([46.6, 2.4], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; contributeurs OpenStreetMap',
  }).addTo(map);
  cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, disableClusteringAtZoom: 16 });
  map.addLayer(cluster);
  map.on('moveend', () => { if ($('#f-bounds').checked) renderPlaces(); });
  map.on('click', onMapClick);
}

function pinIcon(color, approx) {
  return L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -20],
    html: `<div class="pin ${approx ? 'approx' : ''}" style="background:${color}"></div>`,
  });
}

let firstFit = true;
function renderMarkers() {
  if (!map) return;
  cluster.clearLayers();
  markers.clear();
  const list = filteredPlaces().filter(p => p.lat != null);
  const layers = list.map(p => {
    const l = listById(p.list_id);
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(l?.color || '#555', p.geo_status === 'approx'), title: p.title });
    m.bindTooltip(esc(p.title), { direction: 'top', offset: [0, -18] });
    m.on('click', () => selectPlace(p.id, false));
    markers.set(p.id, m);
    return m;
  });
  cluster.addLayers(layers);
  if (firstFit && layers.length) { firstFit = false; fitToPlaces(); }
}

function fitToPlaces() {
  if (!map) return;
  const pts = filteredPlaces().filter(p => p.lat != null).map(p => [p.lat, p.lng]);
  if (pts.length === 1) map.setView(pts[0], 15);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
}

function selectPlace(id, fly) {
  state.selectedPlace = id;
  $$('#places li').forEach(li => li.classList.toggle('active', Number(li.dataset.id) === id));
  renderDetail();
  const p = placeById(id);
  if (fly) showView('map');
  if (fly && p && p.lat != null) {
    const m = markers.get(id);
    if (m) cluster.zoomToShowLayer(m, () => m.openTooltip());
    else map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
  }
}

// ------------------------------------------------------------------ Détail d'un lieu
function googleMapsLink(p) {
  if (p.gmaps_url) return p.gmaps_url;
  if (p.lat != null) return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.title + ' ' + (p.address || ''))}`;
}

const GEO_LABEL = {
  ok: 'Position trouvée', approx: 'Position approximative (trouvée par le nom) — vérifie-la',
  manual: 'Position placée à la main', pending: 'Localisation en cours…', failed: 'Lieu non localisé',
};

function renderDetail() {
  const p = placeById(state.selectedPlace);
  const el = $('#detail');
  if (!p) { closeDetail(); return; }
  const l = listById(p.list_id);
  const owner = isOwner();
  const takeout = [p.takeout_note, p.takeout_comment].filter(Boolean).join('\n\n');
  el.innerHTML = `
    <button class="icon-btn close" data-act="close" aria-label="Fermer">✕</button>
    <h3>${esc(p.title)}</h3>
    <div class="list-tag"><span class="dot" style="width:9px;height:9px;border-radius:50%;background:${esc(l?.color)}"></span>${esc(l?.name)}</div>
    ${p.address ? `<div class="muted">${esc(p.address)}</div>` : ''}
    <div class="section row">
      <a class="btn primary" href="${esc(googleMapsLink(p))}" target="_blank" rel="noopener">Ouvrir dans Google Maps</a>
      ${p.lat != null ? `<a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">Itinéraire</a>` : ''}
    </div>
    ${takeout ? `<div class="section"><label class="lbl">Note Google Maps</label><div class="quote">${esc(takeout)}</div></div>` : ''}
    ${owner ? `
      <div class="section"><label class="lbl" for="d-note">Ma note</label>
        <textarea id="d-note" placeholder="Ce que tu veux retenir / conseiller…">${esc(p.note)}</textarea></div>
      <div class="section"><label class="lbl" for="d-tags">Tags (séparés par des virgules)</label>
        <input type="text" id="d-tags" value="${esc(p.tags)}" placeholder="resto, terrasse, pas cher"></div>
      <div class="section row" style="align-items:center;justify-content:space-between">
        <div class="star-input" id="d-rating">${[1, 2, 3, 4, 5].map(i => `<button data-r="${i}" class="${i <= p.rating ? 'on' : ''}" aria-label="${i} étoile(s)">★</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="d-visited" ${p.visited ? 'checked' : ''}> Déjà visité</label>
      </div>
      <div class="section"><label class="lbl" for="d-list">Liste</label>
        <select id="d-list">${state.lists.map(x => `<option value="${x.id}" ${x.id === p.list_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <div class="help muted" style="font-size:12px;margin-top:4px">Déplacer ici ne change pas la liste dans Google Maps.</div></div>
      <div class="section"><label class="lbl">Position</label>
        <div class="muted" style="margin-bottom:6px">${GEO_LABEL[p.geo_status] || ''}${p.geo_source && p.geo_source !== 'manual' ? ` <span class="badge">${esc(p.geo_source)}</span>` : ''}</div>
        <div class="row">
          <button class="btn small" data-act="place">📍 Placer sur la carte</button>
          <button class="btn small" data-act="relocate">↻ Relocaliser</button>
        </div></div>
      <div class="section"><button class="btn small danger" data-act="delete">Supprimer de ce site</button></div>
    ` : `
      ${p.note ? `<div class="section"><label class="lbl">Note</label><div class="quote">${esc(p.note)}</div></div>` : ''}
      ${p.rating ? `<div class="section">${stars(p.rating)}</div>` : ''}
      ${tagsOf(p).length ? `<div class="section">${tagsOf(p).map(t => `<span class="badge">#${esc(t)}</span>`).join('')}</div>` : ''}
    `}`;
  el.classList.remove('hidden');
}

function closeDetail() {
  state.selectedPlace = null;
  $('#detail').classList.add('hidden');
  $$('#places li.active').forEach(li => li.classList.remove('active'));
}

async function savePlace(id, patch) {
  try {
    const updated = await api(`/api/places/${id}`, { method: 'PATCH', body: patch });
    const i = state.places.findIndex(p => p.id === id);
    if (i >= 0) state.places[i] = updated;
    if (patch.list_id !== undefined) await refresh();
    else { renderTagFilter(); renderPlaces(); renderMarkers(); }
    return updated;
  } catch (e) { toast(e.message); }
}

$('#detail').addEventListener('click', async (e) => {
  const p = placeById(state.selectedPlace);
  const r = e.target.closest('[data-r]');
  if (r && p) {
    const v = Number(r.dataset.r) === p.rating ? 0 : Number(r.dataset.r);
    await savePlace(p.id, { rating: v });
    renderDetail();
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'close') closeDetail();
  if (!p) return;
  if (act === 'place') startPlacing(p);
  if (act === 'relocate') {
    await api(`/api/places/${p.id}/relocate`, { method: 'POST' });
    toast('Relocalisation lancée');
    setTimeout(refresh, 2500);
    pollGeo();
  }
  if (act === 'delete' && confirm(`Supprimer « ${p.title} » de ce site ? (Ça ne touche pas à Google Maps.)`)) {
    await api(`/api/places/${p.id}`, { method: 'DELETE' });
    closeDetail();
    await refresh();
  }
});
$('#detail').addEventListener('change', async (e) => {
  const p = placeById(state.selectedPlace);
  if (!p) return;
  if (e.target.id === 'd-note') await savePlace(p.id, { note: e.target.value });
  if (e.target.id === 'd-tags') await savePlace(p.id, { tags: e.target.value });
  if (e.target.id === 'd-visited') await savePlace(p.id, { visited: e.target.checked });
  if (e.target.id === 'd-list') await savePlace(p.id, { list_id: Number(e.target.value) });
});

// Placement manuel
function startPlacing(p) {
  state.placing = p.id;
  $('#place-mode-name').textContent = p.title;
  $('#place-mode').classList.remove('hidden');
  $('#map').style.cursor = 'crosshair';
  showView('map');
}
function stopPlacing() {
  state.placing = null;
  $('#place-mode').classList.add('hidden');
  $('#map').style.cursor = '';
}
$('#place-mode-cancel').addEventListener('click', (e) => { e.preventDefault(); stopPlacing(); });
async function onMapClick(e) {
  if (!state.placing) return;
  const id = state.placing;
  stopPlacing();
  await savePlace(id, { lat: e.latlng.lat, lng: e.latlng.lng });
  renderDetail();
  toast('Position enregistrée');
}

// ------------------------------------------------------------------ Vue mobile
function showView(v) {
  if (window.innerWidth > 700) return;
  $('.layout').classList.toggle('show-map', v === 'map');
  $$('.mobile-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'map') setTimeout(() => map.invalidateSize(), 50);
}
$$('.mobile-tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ------------------------------------------------------------------ Modale
function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
  const first = $('#modal-body input, #modal-body textarea, #modal-body select');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').classList.contains('hidden')) closeModal();
  else if (state.placing) stopPlacing();
  else closeDetail();
});

// ------------------------------------------------------------------ Réglages d'une liste
const GMAPS_HELP = `
  <ol>
    <li>Dans l'appli <b>Google Maps</b> : <b>Vous</b> (ou <b>Enregistrés</b>) → ouvre la liste.</li>
    <li>Appuie sur <b>⋮</b> puis <b>Partager la liste</b> (si demandé, active le partage / « Toute personne disposant du lien »).</li>
    <li>Choisis <b>Copier le lien</b> et colle-le ici (il ressemble à <code>https://maps.app.goo.gl/…</code>).</li>
  </ol>
  Tes amis ouvriront ce lien et appuieront sur <b>Suivre</b> : la liste apparaîtra dans leur Google Maps et restera à jour quand tu la modifies dans Google Maps.`;

function openListSettings(id) {
  const l = listById(id);
  if (!l) return;
  const friendsHtml = state.friends.length
    ? state.friends.map(f => `<label class="check"><input type="checkbox" name="fr" value="${f.id}" ${l.friend_ids.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('')
    : '<span class="muted">Tu n\'as encore ajouté aucun ami (bouton « 👥 Amis »).</span>';
  openModal(`
    <h2>Réglages de la liste</h2>
    <form id="ls-form">
      <div class="field"><label for="ls-name">Nom</label><input type="text" id="ls-name" value="${esc(l.name)}" required>
        <div class="help">Garde le même nom que dans Google Maps pour que les prochains imports Takeout se fusionnent avec cette liste.</div></div>
      <div class="field"><label for="ls-desc">Description</label><textarea id="ls-desc" placeholder="Visible par tes amis">${esc(l.description)}</textarea></div>
      <div class="field"><label for="ls-color">Couleur sur la carte</label><input type="color" id="ls-color" value="${esc(l.color || '#4363d8')}"></div>
      <div class="field"><label for="ls-gmaps">Lien de partage Google Maps</label>
        <input type="url" id="ls-gmaps" value="${esc(l.gmaps_url)}" placeholder="https://maps.app.goo.gl/…">
        <div class="help">${GMAPS_HELP}</div></div>
      <div class="field"><label for="ls-vis">Qui voit cette liste sur ce site ?</label>
        <select id="ls-vis">
          <option value="private" ${l.visibility === 'private' ? 'selected' : ''}>🔒 Moi seul</option>
          <option value="friends" ${l.visibility === 'friends' ? 'selected' : ''}>👥 Tous mes amis</option>
          <option value="selected" ${l.visibility === 'selected' ? 'selected' : ''}>👤 Seulement certains amis</option>
        </select>
        <div id="ls-friends" style="display:${l.visibility === 'selected' ? 'grid' : 'none'};gap:6px;margin-top:8px">${friendsHtml}</div>
        <div class="help">Tes amis voient les lieux, ta note, tes tags et tes étoiles (pas la case « visité »).</div></div>
      <p id="ls-error" class="error"></p>
      <div class="modal-actions">
        <button type="button" class="btn danger" id="ls-delete" style="margin-right:auto">Supprimer la liste</button>
        <button type="button" class="btn" id="ls-cancel">Annuler</button>
        <button type="submit" class="btn primary">Enregistrer</button>
      </div>
    </form>`);
  $('#ls-vis').addEventListener('change', (e) => { $('#ls-friends').style.display = e.target.value === 'selected' ? 'grid' : 'none'; });
  $('#ls-cancel').addEventListener('click', closeModal);
  $('#ls-delete').addEventListener('click', async () => {
    if (!confirm(`Supprimer la liste « ${l.name} » et ses ${l.count} lieux de ce site ? (Rien n'est supprimé dans Google Maps.)`)) return;
    await api(`/api/lists/${l.id}`, { method: 'DELETE' });
    closeModal();
    state.selectedList = null;
    await refresh();
  });
  $('#ls-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/lists/${l.id}`, {
        method: 'PATCH',
        body: {
          name: $('#ls-name').value, description: $('#ls-desc').value, color: $('#ls-color').value,
          gmaps_url: $('#ls-gmaps').value, visibility: $('#ls-vis').value,
          friend_ids: $$('input[name=fr]:checked').map(i => Number(i.value)),
        },
      });
      closeModal();
      toast('Liste enregistrée');
      await refresh();
    } catch (err) { $('#ls-error').textContent = err.message; }
  });
}

$('#btn-new-list').addEventListener('click', () => {
  openModal(`
    <h2>Nouvelle liste</h2>
    <form id="nl-form">
      <div class="field"><label for="nl-name">Nom</label><input type="text" id="nl-name" required></div>
      <div class="help">Astuce : crée plutôt la liste dans Google Maps puis réimporte ton Takeout — Google ne permet pas à un site de créer des listes Google Maps à ta place.</div>
      <p id="nl-error" class="error"></p>
      <div class="modal-actions"><button type="submit" class="btn primary">Créer</button></div>
    </form>`);
  $('#nl-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/lists', { method: 'POST', body: { name: $('#nl-name').value } });
      closeModal();
      state.selectedList = r.id;
      await refresh();
    } catch (err) { $('#nl-error').textContent = err.message; }
  });
});

function openAddPlace(listId) {
  openModal(`
    <h2>Ajouter un lieu</h2>
    <form id="ap-form">
      <div class="field"><label for="ap-title">Nom du lieu</label><input type="text" id="ap-title" required></div>
      <div class="field"><label for="ap-url">Lien Google Maps du lieu (conseillé)</label>
        <input type="url" id="ap-url" placeholder="https://maps.app.goo.gl/…">
        <div class="help">Dans Google Maps : ouvre le lieu → Partager → Copier le lien. Il sert à le localiser et à l'ouvrir en un clic.</div></div>
      <div class="field"><label for="ap-note">Ma note</label><textarea id="ap-note"></textarea></div>
      <p id="ap-error" class="error"></p>
      <div class="modal-actions"><button type="submit" class="btn primary">Ajouter</button></div>
    </form>`);
  $('#ap-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/places', { method: 'POST', body: { list_id: listId, title: $('#ap-title').value, gmaps_url: $('#ap-url').value, note: $('#ap-note').value } });
      closeModal();
      await refresh();
      pollGeo();
    } catch (err) { $('#ap-error').textContent = err.message; }
  });
}

// ------------------------------------------------------------------ Import Takeout
let importFiles = [];

$('#btn-import').addEventListener('click', () => {
  importFiles = [];
  openModal(`
    <h2>Importer depuis Google Takeout</h2>
    <ol>
      <li>Va sur <a href="https://takeout.google.com/" target="_blank" rel="noopener">takeout.google.com</a>, clique sur <b>Tout désélectionner</b>.</li>
      <li>Coche <b>Enregistré</b> (tes listes) et, si tu veux tes lieux étoilés, <b>Maps (vos adresses)</b>.</li>
      <li>Exporte, télécharge le <b>.zip</b> et dépose-le ici (ou directement les fichiers .csv / .json).</li>
    </ol>
    <div class="drop" id="drop">
      <b>Dépose ton .zip Takeout ici</b><br><span class="muted">ou clique pour choisir (.zip, .csv, .json)</span>
      <input type="file" id="file-input" multiple accept=".zip,.csv,.json,.geojson" hidden>
    </div>
    <div id="import-preview"></div>`);
  const drop = $('#drop');
  const input = $('#file-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleImportFiles([...e.dataTransfer.files]); });
  input.addEventListener('change', () => handleImportFiles([...input.files]));
});

const LIKELY_LIST = /(saved|enregistr|gespeichert|guardado|salvat|opgeslagen)[^/]*\//i;
const LIKELY_JSON = /(saved places|lieux enregistr|labeled places|adresses [ée]tiquet)/i;

async function handleImportFiles(files) {
  const out = [];
  const prev = $('#import-preview');
  prev.innerHTML = '<p class="muted">Lecture des fichiers…</p>';
  try {
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        const zip = await JSZip.loadAsync(f);
        for (const entry of Object.values(zip.files)) {
          if (entry.dir) continue;
          const isCsv = /\.csv$/i.test(entry.name);
          const isJson = /\.(geo)?json$/i.test(entry.name);
          if (!isCsv && !isJson) continue;
          if (isJson && !LIKELY_JSON.test(entry.name) && !/maps/i.test(entry.name)) continue;
          const content = await entry.async('string');
          if (isJson && !content.includes('FeatureCollection')) continue;
          out.push({ name: entry.name, content, likely: isCsv ? LIKELY_LIST.test(entry.name) : LIKELY_JSON.test(entry.name) });
        }
      } else if (/\.(csv|json|geojson)$/i.test(f.name)) {
        out.push({ name: f.name, content: await f.text(), likely: true });
      }
    }
  } catch (e) {
    prev.innerHTML = `<p class="error">Impossible de lire le fichier : ${esc(e.message)}</p>`;
    return;
  }
  if (!out.length) {
    prev.innerHTML = '<p class="error">Aucune liste trouvée. Vérifie que tu as bien coché « Enregistré » dans Takeout.</p>';
    return;
  }
  importFiles = out;
  const preview = await api('/api/import/preview', { method: 'POST', body: { files: out.map(({ name, content }) => ({ name, content })) } });
  if (!preview.length) { prev.innerHTML = '<p class="error">Les fichiers ne contiennent aucun lieu.</p>'; return; }
  const likelyNames = new Set(out.filter(f => f.likely).map(f => f.name.split('/').pop().replace(/\.(csv|json|geojson)$/i, '').trim()));
  prev.innerHTML = `
    <h3 style="margin-top:16px">${preview.length} liste(s) trouvée(s)</h3>
    <ul class="preview-list">${preview.map(l => `
      <li><label class="check"><input type="checkbox" name="imp" value="${esc(l.name)}" ${likelyNames.has(l.name) || likelyNames.size === 0 ? 'checked' : ''}>
        <span><b>${esc(l.name)}</b> — ${l.count} lieux${l.exists ? ' <span class="badge">mise à jour</span>' : ' <span class="badge ok">nouvelle</span>'}</span></label></li>`).join('')}
    </ul>
    <label class="check"><input type="checkbox" id="imp-sync"> Supprimer ici les lieux qui ne sont plus dans la liste Google Maps</label>
    <p class="help">Tes notes, tags, étoiles et positions corrigées sont conservés lors d'une mise à jour.</p>
    <div class="modal-actions"><button class="btn primary" id="imp-go">Importer</button></div>`;
  $('#imp-go').addEventListener('click', async () => {
    const selected = $$('input[name=imp]:checked').map(i => i.value);
    if (!selected.length) return toast('Sélectionne au moins une liste');
    $('#imp-go').disabled = true;
    $('#imp-go').textContent = 'Import…';
    try {
      const r = await api('/api/import', { method: 'POST', body: { files: importFiles.map(({ name, content }) => ({ name, content })), selected, sync: $('#imp-sync').checked } });
      closeModal();
      toast(`${r.lists} liste(s) : ${r.added} ajouté(s), ${r.updated} mis à jour${r.removed ? `, ${r.removed} supprimé(s)` : ''}`, 4500);
      firstFit = true;
      await refresh();
      pollGeo();
    } catch (e) {
      toast(e.message);
      $('#imp-go').disabled = false;
      $('#imp-go').textContent = 'Importer';
    }
  });
}

// ------------------------------------------------------------------ Amis
$('#btn-friends').addEventListener('click', openFriends);

function openFriends() {
  const link = (f) => `${location.origin}/f/${f.token}`;
  const shared = (f) => state.lists.filter(l => l.visibility === 'friends' || (l.visibility === 'selected' && l.friend_ids.includes(f.id))).length;
  openModal(`
    <h2>Mes amis</h2>
    <p class="muted">Chaque ami a son propre lien d'accès, sans mot de passe. Il voit seulement les listes que tu partages (réglages de chaque liste). Tu peux révoquer un lien à tout moment.</p>
    <div id="fr-list">${state.friends.map(f => `
      <div class="friend-row" data-id="${f.id}">
        <span class="name">${esc(f.name)} <span class="muted" style="font-weight:400">· ${shared(f)} liste(s)</span></span>
        <button class="btn small" data-act="copy">Copier le lien</button>
        <button class="btn small" data-act="regen" title="L'ancien lien ne marchera plus">Nouveau lien</button>
        <button class="btn small danger" data-act="del">Retirer</button>
        <input type="text" readonly value="${esc(link(f))}">
      </div>`).join('') || '<p class="muted">Aucun ami pour l\'instant.</p>'}</div>
    <form class="inline-form" id="fr-form">
      <input type="text" id="fr-name" placeholder="Prénom de ton ami" required>
      <button class="btn primary" type="submit">Ajouter</button>
    </form>`);
  $('#fr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = await api('/api/friends', { method: 'POST', body: { name: $('#fr-name').value } });
    state.friends = await api('/api/friends');
    openFriends();
    copy(link(f));
  });
  $('#fr-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.closest('.friend-row').dataset.id);
    const f = state.friends.find(x => x.id === id);
    if (b.dataset.act === 'copy') copy(link(f));
    if (b.dataset.act === 'regen' && confirm(`Générer un nouveau lien pour ${f.name} ? L'ancien ne fonctionnera plus.`)) {
      await api(`/api/friends/${id}/regenerate`, { method: 'POST' });
      state.friends = await api('/api/friends');
      openFriends();
    }
    if (b.dataset.act === 'del' && confirm(`Retirer l'accès de ${f.name} ?`)) {
      await api(`/api/friends/${id}`, { method: 'DELETE' });
      await refresh();
      openFriends();
    }
  });
}

// ------------------------------------------------------------------ Statut du géocodage
let geoTimer = null;
async function pollGeo() {
  if (!isOwner()) return;
  clearTimeout(geoTimer);
  try {
    const s = await api('/api/geo/status');
    const pending = s.counts.pending || 0;
    const failed = s.counts.failed || 0;
    const el = $('#geo-status');
    const prev = state.geoCounts;
    state.geoCounts = s.counts;
    if (pending || failed) {
      el.classList.remove('hidden');
      el.innerHTML = [
        pending ? `⏳ Localisation des lieux : ${pending} restant(s)` : '',
        failed ? `⚠ ${failed} non localisé(s) <button class="btn small" id="geo-retry">Réessayer</button>` : '',
      ].filter(Boolean).join(' · ');
      const retry = $('#geo-retry');
      if (retry) retry.onclick = async () => { await api('/api/geo/retry-failed', { method: 'POST' }); pollGeo(); };
    } else el.classList.add('hidden');
    if (prev && JSON.stringify(prev) !== JSON.stringify(s.counts)) {
      // des lieux viennent d'être localisés : on rafraîchit (sans trop de fréquence)
      const now = Date.now();
      if (!pollGeo._last || now - pollGeo._last > 4000 || !pending) { pollGeo._last = now; await refresh(); }
    }
    if (pending) geoTimer = setTimeout(pollGeo, 3000);
  } catch { /* ignore */ }
}

boot().catch(e => { console.error(e); toast(e.message); });
