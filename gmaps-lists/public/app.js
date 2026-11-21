// Listes Maps — interface mobile (SPA sans build, routage par hash).
const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('back');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const $tabbar = document.getElementById('tabbar');

// ---------- utilitaires ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.json !== undefined ? { 'content-type': 'application/json', ...opts.headers } : opts.headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  if (res.status === 401 && path !== '/login') { renderLogin(); throw new Error('Non connecté'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 3500);
}

const flag = (code) => (code ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '❓');
const plural = (n, s, p = s.endsWith('eu') ? `${s}x` : `${s}s`) => `${n} ${n > 1 ? p : s}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

function setHeader(title, backHref) {
  $title.textContent = title;
  document.title = `${title} · Listes Maps`;
  $back.hidden = !backHref;
  $back.onclick = () => (location.hash = backHref);
}

function openSheet(...content) {
  $sheet.replaceChildren(h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true' }, ...content));
  $sheet.hidden = false;
}
function closeSheet() { $sheet.hidden = true; $sheet.replaceChildren(); }
$sheet.addEventListener('click', (e) => { if (e.target === $sheet) closeSheet(); });

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Lien copié'); }
  catch { prompt('Copiez le lien :', text); }
}

let countryCodesCache;
const countryCodes = async () => (countryCodesCache ??= await api('/country-codes'));

let pollTimer;
function poll(fn, ms) { clearTimeout(pollTimer); pollTimer = setTimeout(fn, ms); }

// ---------- connexion ----------
function renderLogin() {
  $tabbar.hidden = true;
  setHeader('Listes Maps');
  const input = h('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Mot de passe' });
  const err = h('p', { class: 'muted' });
  $view.replaceChildren(h('form', {
    class: 'card login',
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api('/login', { method: 'POST', json: { password: input.value } }); $tabbar.hidden = false; route(); }
      catch (ex) { err.textContent = ex.message; }
    },
  }, h('h2', {}, 'Connexion'), h('label', { class: 'field' }, input), h('button', { class: 'btn primary block' }, 'Entrer'), err));
  input.focus();
}

// ---------- F5 : liste des pays ----------
async function renderCountries() {
  setHeader('Mes pays');
  const data = await api('/overview');
  const { stats } = data;
  const nodes = [];
  if (!data.resolverEnabled && stats.total) {
    nodes.push(h('div', { class: 'banner warn' }, 'Tri automatique désactivé : la clé API Google Maps n’est pas configurée sur le serveur. Les lieux sans pays sont dans « À classer ».'));
  }
  if (stats.pending > 0) {
    const done = stats.total - stats.pending;
    nodes.push(h('div', { class: 'banner' },
      `Tri par pays en cours… ${plural(stats.pending, 'lieu restant', 'lieux restants')}`,
      h('div', { class: 'progress' }, h('div', { style: `width:${Math.round((done / Math.max(stats.total, 1)) * 100)}%` }))));
    poll(() => location.hash.replace('#', '') === '/' || !location.hash ? renderCountries() : null, 2500);
  }
  if (!data.countries.length) {
    nodes.push(h('div', { class: 'empty' }, h('div', { class: 'big' }, '🗺️'),
      h('p', {}, 'Aucun lieu pour l’instant.'), h('a', { class: 'btn primary', href: '#/import' }, 'Importer mes listes')));
  } else {
    nodes.push(h('p', { class: 'muted' }, `${plural(stats.total, 'lieu')} · ${plural(data.countries.filter((c) => c.code).length, 'pays', 'pays')}`));
    nodes.push(h('ul', { class: 'list' }, data.countries.map((c) =>
      h('li', {}, h('a', { class: 'row', href: `#/country/${c.code || 'none'}` },
        h('span', { class: 'flag' }, flag(c.code)),
        h('span', { class: 'main' }, h('div', { class: 'title' }, c.name)),
        h('span', { class: 'count' }, c.count),
        h('span', { class: 'chev' }, '›'))))));
  }
  $view.replaceChildren(...nodes);
}

// ---------- F5 : lieux d'un pays (liste + carte) ----------
const countryState = { mode: 'list', selected: new Set(), code: null };

async function renderCountry(code) {
  if (countryState.code !== code) { countryState.selected = new Set(); countryState.code = code; }
  const data = await api(`/countries/${code}/places`);
  setHeader(`${flag(data.code)} ${data.name}`, '#/');
  const places = data.places;
  const sel = countryState.selected;
  for (const id of [...sel]) if (!places.some((p) => p.id === id)) sel.delete(id);

  const seg = h('div', { class: 'segmented', role: 'tablist' },
    h('button', { class: countryState.mode === 'list' ? 'on' : '', role: 'tab', onclick: () => { countryState.mode = 'list'; renderCountry(code); } }, `Liste (${places.length})`),
    h('button', { class: countryState.mode === 'map' ? 'on' : '', role: 'tab', onclick: () => { countryState.mode = 'map'; renderCountry(code); } }, 'Carte'));

  const nodes = [seg];
  if (!places.length) nodes.push(h('div', { class: 'empty' }, 'Aucun lieu ici.'));
  else if (countryState.mode === 'list') {
    nodes.push(h('ul', { class: 'list' }, places.map((p) => {
      const cb = h('input', {
        type: 'checkbox', 'aria-label': `Sélectionner ${p.title}`, checked: sel.has(p.id),
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { e.target.checked ? sel.add(p.id) : sel.delete(p.id); updateActions(); },
      });
      const sub = p.address || p.lists.map((l) => l.name).join(' · ');
      return h('li', {}, h('div', { class: 'row', role: 'button', tabindex: '0', onclick: () => openPlace(p, code) },
        cb,
        h('span', { class: 'main' },
          h('div', { class: 'title' }, p.title),
          h('div', { class: 'sub' }, p.note ? `📝 ${p.note}` : sub || '—')),
        h('span', { class: 'chev' }, '›')));
    })));
  } else {
    nodes.push(h('div', { id: 'map' }));
  }

  const actions = h('div', { class: 'actionbar' });
  function updateActions() {
    const btns = [];
    if (data.code) btns.push(h('button', { class: `btn ${sel.size ? '' : 'primary'}`, onclick: () => openExport({ countryCode: data.code, name: data.name, count: places.length }) }, `Exporter ${data.name}`));
    if (sel.size) btns.push(h('button', { class: 'btn primary', onclick: () => openExport({ placeIds: [...sel], name: data.code ? `${data.name} – sélection` : 'Sélection', count: sel.size }) }, `Exporter la sélection (${sel.size})`));
    actions.replaceChildren(...btns);
  }
  updateActions();
  if (places.length) nodes.push(actions);
  if (!data.code && places.length) nodes.unshift(h('div', { class: 'banner warn' }, 'Ces lieux n’ont pas de pays détecté. Touchez un lieu pour choisir son pays.'));
  $view.replaceChildren(...nodes);
  if (countryState.mode === 'map' && places.length) drawMap(places, code);
}

function drawMap(places, code) {
  if (!window.L) { document.getElementById('map').replaceChildren(h('p', { class: 'empty' }, 'Carte indisponible (hors ligne ?)')); return; }
  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  const pts = [];
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    pts.push([p.lat, p.lng]);
    const popup = h('div', {}, h('strong', {}, p.title), h('br'),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openPlace(p, code); } }, 'Détails'), ' · ',
      h('a', { href: p.google_url, target: '_blank', rel: 'noopener' }, 'Google Maps'));
    L.marker([p.lat, p.lng]).addTo(map).bindPopup(popup);
  }
  if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  else map.setView([20, 0], 2);
  const missing = places.length - pts.length;
  if (missing) toast(`${plural(missing, 'lieu')} sans position non affiché${missing > 1 ? 's' : ''}`);
}

// ---------- F6 : fiche lieu / correction ----------
async function openPlace(p, code) {
  const codes = await countryCodes();
  const select = h('select', { 'aria-label': 'Pays' },
    h('option', { value: '' }, '— À classer —'),
    codes.map((c) => h('option', { value: c.code, selected: c.code === p.country_code }, `${flag(c.code)} ${c.name}`)));
  const note = h('textarea', { placeholder: 'Ma note…' }, p.note || '');
  const sourceNotes = p.lists.filter((l) => l.source_note);
  openSheet(
    h('h2', {}, p.title),
    h('p', { class: 'muted' }, p.address || ''),
    h('p', { class: 'small muted' }, `Listes : ${p.lists.map((l) => l.name).join(', ') || '—'}`,
      p.country_source ? ` · pays ${({ manual: 'corrigé à la main', api: 'détecté', import: 'issu de l’export' })[p.country_source] || ''}` : '',
      p.resolve_status === 'failed' ? ` · détection impossible : ${p.resolve_error}` : ''),
    sourceNotes.length ? h('ul', { class: 'notes' }, sourceNotes.map((l) => h('li', {}, `${l.name} : ${l.source_note}`))) : null,
    h('label', { class: 'field', style: 'margin-top:12px' }, h('span', {}, 'Pays'), select),
    h('label', { class: 'field' }, h('span', {}, 'Note'), note),
    h('div', { class: 'btns' },
      h('button', {
        class: 'btn primary', onclick: async () => {
          const body = {};
          if ((select.value || null) !== (p.country_code || null)) body.countryCode = select.value || null;
          if (note.value !== (p.note || '')) body.note = note.value;
          if (Object.keys(body).length) { await api(`/places/${p.id}`, { method: 'PATCH', json: body }); toast('Enregistré'); }
          closeSheet(); renderCountry(code);
        },
      }, 'Enregistrer'),
      h('a', { class: 'btn', href: p.google_url, target: '_blank', rel: 'noopener' }, 'Google Maps')),
    h('button', {
      class: 'btn danger block', style: 'margin-top:8px', onclick: async () => {
        await api(`/places/${p.id}`, { method: 'PATCH', json: { removed: true } });
        toast('Lieu retiré (restaurable dans Réglages)'); closeSheet(); renderCountry(code);
      },
    }, 'Retirer ce lieu'));
}

// ---------- F7 : lancer un export ----------
function openExport({ countryCode, placeIds, name, count }) {
  const input = h('input', { type: 'text', value: name, maxlength: '40', required: true });
  openSheet(
    h('h2', {}, 'Exporter vers Google Maps'),
    h('p', { class: 'muted' }, `${plural(count, 'lieu')}. Si une liste du même nom a déjà été exportée, elle est mise à jour.`),
    h('label', { class: 'field' }, h('span', {}, 'Nom de la liste Google Maps'), input),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: closeSheet }, 'Annuler'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          try {
            await api('/exports', { method: 'POST', json: { name: input.value, countryCode, placeIds } });
            closeSheet(); toast('Export lancé'); location.hash = '#/exports';
          } catch (e) { toast(e.message); }
        },
      }, 'Exporter')));
}

// ---------- F1/F2 : import ----------
function renderImport() {
  setHeader('Importer');
  const out = h('div');
  const fileInput = h('input', { type: 'file', accept: '.zip,.csv,.json', multiple: true, hidden: true });
  const report = (results) => {
    const lists = results.flatMap((r) => r.lists);
    out.replaceChildren(h('div', { class: 'card' }, h('h2', {}, `✅ ${plural(lists.length, 'liste importée', 'listes importées')}`),
      h('ul', { class: 'notes' }, lists.map((l) => h('li', {}, `${l.name} : ${plural(l.places, 'lieu')} (${l.created} nouveau${l.created > 1 ? 'x' : ''}, ${l.merged} déjà connu${l.merged > 1 ? 's' : ''})`))),
      h('a', { class: 'btn primary block', href: '#/', style: 'margin-top:12px' }, 'Voir mes pays')));
  };
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    if (!files.length) return;
    const results = [];
    for (const f of files) {
      out.replaceChildren(h('div', { class: 'banner' }, `Import de ${f.name}…`));
      try {
        results.push(await api('/import/file', { method: 'POST', body: f, headers: { 'x-filename': encodeURIComponent(f.name) } }));
      } catch (e) {
        out.replaceChildren(h('div', { class: 'banner err' }, `${f.name} : ${e.message}`));
        return;
      }
    }
    fileInput.value = '';
    report(results);
  };
  const urlInput = h('input', { type: 'url', placeholder: 'https://maps.app.goo.gl/…', inputmode: 'url' });
  $view.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, 'Depuis l’export Google (Takeout)'),
      h('p', { class: 'muted small' }, 'Sur takeout.google.com, cochez seulement « Enregistré » (et éventuellement « Maps (vos adresses) »), puis choisissez ici le fichier .zip reçu — ou un des fichiers .csv.'),
      fileInput,
      h('button', { class: 'btn primary block', onclick: () => fileInput.click() }, 'Choisir le fichier')),
    h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        out.replaceChildren(h('div', { class: 'banner' }, 'Récupération de la liste…'));
        try { report([await api('/import/link', { method: 'POST', json: { url: urlInput.value } })]); urlInput.value = ''; }
        catch (ex) { out.replaceChildren(h('div', { class: 'banner err' }, ex.message)); }
      },
    },
      h('h2', {}, 'Depuis un lien de liste partagée'),
      h('p', { class: 'muted small' }, 'Dans Google Maps : Enregistré › liste › Partager › copier le lien.'),
      h('label', { class: 'field' }, urlInput),
      h('button', { class: 'btn primary block' }, 'Importer la liste')),
    out);
}

// ---------- F8/F9 : exports ----------
async function renderExports() {
  setHeader('Exports');
  const [exports, overview] = await Promise.all([api('/exports'), api('/overview')]);
  const nodes = [];
  if (!overview.exportReady) {
    nodes.push(h('div', { class: 'banner warn' }, 'Compte Google dédié non connecté : les exports échoueront. ', h('a', { href: '#/settings' }, 'Réglages')));
  }
  if (overview.exportDriver === 'mock') nodes.push(h('div', { class: 'banner' }, 'Mode démo : les exports sont simulés (EXPORT_DRIVER=mock).'));
  if (!exports.length) {
    nodes.push(h('div', { class: 'empty' }, h('div', { class: 'big' }, '⤴'), h('p', {}, 'Aucun export. Ouvrez un pays puis « Exporter ».')));
  }
  const label = { pending: 'En attente', running: 'En cours', success: 'Réussi', failed: 'Échec' };
  for (const e of exports) {
    nodes.push(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'padding:0;min-height:0' },
        h('span', { class: 'main' }, h('div', { class: 'title' }, e.name),
          h('div', { class: 'sub' }, e.country_code ? `${flag(e.country_code)} ${e.country_name}` : 'Sélection', ` · ${plural(e.count, 'lieu')}`)),
        h('span', { class: `badge ${e.status}` }, label[e.status])),
      e.status === 'running' || e.status === 'pending' ? h('p', { class: 'small muted' }, e.progress || 'En file d’attente…') : null,
      e.status === 'failed' ? h('p', { class: 'small', style: 'color:var(--err)' }, e.error,
        e.screenshot ? [' · ', h('a', { href: `/api/screenshots/${e.screenshot}`, target: '_blank' }, 'capture')] : null) : null,
      e.share_url ? h('div', { class: 'link-box' }, h('code', {}, e.share_url)) : null,
      h('div', { class: 'btns', style: 'margin-top:10px' },
        e.share_url ? h('a', { class: 'btn primary', href: e.share_url, target: '_blank', rel: 'noopener' }, 'Ouvrir dans Google Maps') : null,
        e.share_url ? h('button', { class: 'btn', onclick: () => copy(e.share_url) }, 'Copier') : null,
        e.status !== 'running' && e.status !== 'pending' ? h('button', {
          class: 'btn', onclick: async () => { await api(`/exports/${e.id}/run`, { method: 'POST' }); renderExports(); },
        }, e.status === 'failed' ? 'Réessayer' : 'Mettre à jour') : null),
      h('p', { class: 'small muted', style: 'margin:8px 0 0' }, e.last_success_at ? `Dernier succès : ${fmtDate(e.last_success_at)}` : `Créé : ${fmtDate(e.created_at)}`)));
  }
  $view.replaceChildren(...nodes);
  if (exports.some((e) => e.status === 'pending' || e.status === 'running')) {
    poll(() => (location.hash === '#/exports' ? renderExports() : null), 2000);
  }
}

// ---------- réglages ----------
async function renderSettings() {
  setHeader('Réglages');
  const [s, lists, removed, overview] = await Promise.all([api('/settings'), api('/lists'), api('/places/removed'), api('/overview')]);
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try { await api('/settings/google-session', { method: 'PUT', body: await f.text() }); toast('Session Google enregistrée'); renderSettings(); }
    catch (e) { toast(e.message); }
  };
  $view.replaceChildren(
    h('div', { class: 'card' }, h('h2', {}, 'Compte Google dédié (export)'),
      h('p', { class: 'muted small' }, s.googleSession
        ? `Session importée le ${fmtDate(s.googleSession.updatedAt)}.`
        : 'Aucune session. Sur un ordinateur, lancez « npm run google:login », connectez-vous au compte dédié, puis importez ici le fichier google-session.json.'),
      fileInput,
      h('button', { class: 'btn block', onclick: () => fileInput.click() }, s.googleSession ? 'Remplacer la session' : 'Importer la session')),
    h('div', { class: 'card' }, h('h2', {}, 'Tri par pays'),
      h('p', { class: 'muted small' }, s.resolverEnabled ? 'Clé API Google Maps configurée.' : 'Clé API absente (variable GOOGLE_MAPS_API_KEY sur le serveur).'),
      overview.stats.failed ? h('button', {
        class: 'btn block', onclick: async () => { const r = await api('/places/retry-resolution', { method: 'POST' }); toast(`${plural(r.requeued, 'lieu relancé', 'lieux relancés')}`); },
      }, `Relancer la détection (${overview.stats.failed} en échec)`) : null),
    h('div', { class: 'card' }, h('h2', {}, `Listes importées (${lists.length})`),
      lists.length ? h('ul', { class: 'notes' }, lists.map((l) => h('li', {}, `${l.name} — ${plural(l.count, 'lieu')} · ${l.source === 'link' ? 'lien' : 'Takeout'} · ${fmtDate(l.imported_at)}`))) : h('p', { class: 'muted small' }, 'Aucune.')),
    h('div', { class: 'card' }, h('h2', {}, `Lieux retirés (${removed.length})`),
      removed.length ? h('ul', { class: 'list' }, removed.map((p) => h('li', {}, h('div', { class: 'row' },
        h('span', { class: 'main' }, h('div', { class: 'title' }, p.title), h('div', { class: 'sub' }, p.country_name)),
        h('button', { class: 'btn', onclick: async () => { await api(`/places/${p.id}`, { method: 'PATCH', json: { removed: false } }); renderSettings(); } }, 'Restaurer'))))) : h('p', { class: 'muted small' }, 'Aucun.')),
    s.passwordProtected ? h('button', { class: 'btn block', onclick: async () => { await api('/logout', { method: 'POST' }); renderLogin(); } }, 'Se déconnecter') : null);
}

// ---------- routeur ----------
async function route() {
  clearTimeout(pollTimer);
  closeSheet();
  const path = location.hash.replace(/^#/, '') || '/';
  const tab = path.startsWith('/import') ? 'import' : path.startsWith('/exports') ? 'exports' : path.startsWith('/settings') ? 'settings' : 'countries';
  for (const a of $tabbar.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
  try {
    const m = path.match(/^\/country\/([A-Za-z]{2}|none)$/);
    if (m) await renderCountry(m[1]);
    else if (path === '/import') renderImport();
    else if (path === '/exports') await renderExports();
    else if (path === '/settings') await renderSettings();
    else await renderCountries();
  } catch (e) {
    if (e.message !== 'Non connecté') $view.replaceChildren(h('div', { class: 'banner err' }, e.message));
  }
}

window.addEventListener('hashchange', route);
(async () => {
  const s = await fetch('/api/session').then((r) => r.json()).catch(() => ({ authenticated: true }));
  if (!s.authenticated) renderLogin(); else route();
})();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
