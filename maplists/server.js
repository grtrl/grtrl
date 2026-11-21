const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSetting, setSetting, transaction } = require('./db');
const { parseTakeoutFiles } = require('./takeout');
const { placeKey, locate, validCoord } = require('./geo');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------- sessions
// Cookie signé HMAC, sans stockage serveur. Le secret est généré au 1er lancement.
let SECRET = process.env.SESSION_SECRET || getSetting('session_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('session_secret', SECRET); }

const COOKIE = 'ml_sid';
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function setSession(req, res, payload) {
  const data = Buffer.from(JSON.stringify({ ...payload, v: getSetting('session_version') || '1' })).toString('base64url');
  res.cookie(COOKIE, `${data}.${sign(data)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 180, path: '/',
  });
}

function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [data, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (s.role === 'owner' && s.v !== (getSetting('session_version') || '1')) return null;
    if (s.role === 'friend') {
      const f = db.prepare('SELECT id, name FROM friends WHERE id = ? AND token = ?').get(s.fid, s.token);
      if (!f) return null; // ami supprimé ou lien régénéré
      s.friend = f;
    }
    return s;
  } catch { return null; }
}

app.use((req, res, next) => { req.session = readSession(req); next(); });

const isOwner = (req) => req.session && req.session.role === 'owner';
function requireOwner(req, res, next) {
  if (!isOwner(req)) return res.status(401).json({ error: 'Connexion requise' });
  next();
}
function requireViewer(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'Connexion requise' });
  next();
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

// ---------------------------------------------------------------- auth
const failedLogins = new Map();

app.get('/api/me', (req, res) => {
  const s = req.session;
  res.json({
    role: s ? s.role : null,
    friendName: s && s.friend ? s.friend.name : null,
    needsSetup: !getSetting('password_hash') && !process.env.ADMIN_PASSWORD,
    googleKey: !!process.env.GOOGLE_MAPS_API_KEY,
  });
});

app.post('/api/setup', (req, res) => {
  if (getSetting('password_hash') || process.env.ADMIN_PASSWORD) return res.status(400).json({ error: 'Déjà configuré' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  setSetting('password_hash', hashPassword(pw));
  setSession(req, res, { role: 'owner' });
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const f = failedLogins.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans une minute' });
  const pw = String(req.body.password || '');
  const ok = process.env.ADMIN_PASSWORD
    ? pw.length === process.env.ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(process.env.ADMIN_PASSWORD))
    : checkPassword(pw, getSetting('password_hash'));
  if (!ok) {
    f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
    failedLogins.set(ip, f);
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  failedLogins.delete(ip);
  setSession(req, res, { role: 'owner' });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/logout-everywhere', requireOwner, (req, res) => {
  setSetting('session_version', crypto.randomBytes(6).toString('hex'));
  setSession(req, res, { role: 'owner' });
  res.json({ ok: true });
});

// Lien d'accès d'un ami : /f/<token>
app.get('/f/:token', (req, res) => {
  const f = db.prepare('SELECT id, token FROM friends WHERE token = ?').get(req.params.token);
  if (!f) return res.status(404).send('Lien invalide ou révoqué.');
  if (!isOwner(req)) setSession(req, res, { role: 'friend', fid: f.id, token: f.token });
  res.redirect('/');
});

// ---------------------------------------------------------------- visibilité
function visibleListIds(req) {
  if (isOwner(req)) return null; // tout
  const fid = req.session.friend.id;
  return db.prepare(`
    SELECT id FROM lists WHERE visibility = 'friends'
    UNION SELECT l.id FROM lists l JOIN list_friends lf ON lf.list_id = l.id
      WHERE l.visibility = 'selected' AND lf.friend_id = ?`).all(fid).map(r => r.id);
}

// Seuls les liens de LISTES Google Maps sont acceptés (pas Google My Maps).
function normalizeGmapsListUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  let url;
  try { url = new URL(u); } catch { throw new Error('Lien invalide'); }
  const host = url.hostname.replace(/^www\./, '');
  if (/mymaps|\/maps\/d\//.test(u) || host === 'mymaps.google.com') {
    throw new Error('Ceci est un lien Google My Maps. Il faut le lien de partage d\'une liste Google Maps (maps.app.goo.gl/…).');
  }
  const ok = host === 'maps.app.goo.gl'
    || (host === 'goo.gl' && url.pathname.startsWith('/maps'))
    || (/^google\.[a-z.]+$/.test(host) && url.pathname.startsWith('/maps'))
    || host === 'maps.google.com';
  if (!ok || url.protocol !== 'https:') throw new Error('Il faut un lien de partage Google Maps (https://maps.app.goo.gl/…)');
  return url.toString();
}

// ---------------------------------------------------------------- listes
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075'];
function nextColor() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM lists').get().n;
  return COLORS[n % COLORS.length];
}

app.get('/api/lists', requireViewer, (req, res) => {
  const ids = visibleListIds(req);
  let lists = db.prepare(`
    SELECT l.*, COUNT(p.id) AS count,
      SUM(CASE WHEN p.lat IS NOT NULL THEN 1 ELSE 0 END) AS located
    FROM lists l LEFT JOIN places p ON p.list_id = l.id
    GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).all();
  if (ids) lists = lists.filter(l => ids.includes(l.id));
  const lf = isOwner(req) ? db.prepare('SELECT list_id, friend_id FROM list_friends').all() : [];
  res.json(lists.map(l => ({
    id: l.id, name: l.name, description: l.description, gmaps_url: l.gmaps_url, color: l.color,
    count: l.count, located: l.located || 0, updated_at: l.updated_at,
    ...(isOwner(req) ? {
      visibility: l.visibility, source: l.source,
      friend_ids: lf.filter(x => x.list_id === l.id).map(x => x.friend_id),
    } : {}),
  })));
});

app.post('/api/lists', requireOwner, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const r = db.prepare('INSERT INTO lists(name, description, color, source) VALUES(?, ?, ?, ?)')
      .run(name, String(req.body.description || ''), nextColor(), 'manual');
    res.json({ id: Number(r.lastInsertRowid) });
  } catch {
    res.status(400).json({ error: 'Une liste porte déjà ce nom' });
  }
});

app.patch('/api/lists/:id', requireOwner, (req, res) => {
  const l = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Liste introuvable' });
  const b = req.body;
  const upd = { name: l.name, description: l.description, gmaps_url: l.gmaps_url, visibility: l.visibility, color: l.color };
  if (b.name !== undefined) upd.name = String(b.name).trim() || l.name;
  if (b.description !== undefined) upd.description = String(b.description);
  if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) upd.color = b.color;
  if (b.visibility !== undefined) {
    if (!['private', 'friends', 'selected'].includes(b.visibility)) return res.status(400).json({ error: 'Visibilité invalide' });
    upd.visibility = b.visibility;
  }
  if (b.gmaps_url !== undefined) {
    try { upd.gmaps_url = normalizeGmapsListUrl(b.gmaps_url); } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  try {
    transaction(() => {
      db.prepare(`UPDATE lists SET name=?, description=?, gmaps_url=?, visibility=?, color=?, updated_at=datetime('now') WHERE id=?`)
        .run(upd.name, upd.description, upd.gmaps_url, upd.visibility, upd.color, l.id);
      if (Array.isArray(b.friend_ids)) {
        db.prepare('DELETE FROM list_friends WHERE list_id = ?').run(l.id);
        const ins = db.prepare('INSERT OR IGNORE INTO list_friends(list_id, friend_id) SELECT ?, id FROM friends WHERE id = ?');
        for (const fid of b.friend_ids) ins.run(l.id, Number(fid));
      }
    });
  } catch {
    return res.status(400).json({ error: 'Une liste porte déjà ce nom' });
  }
  res.json({ ok: true });
});

app.delete('/api/lists/:id', requireOwner, (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- lieux
const PLACE_COLS = `id, list_id, title, gmaps_url, takeout_note, takeout_comment, takeout_tags, note, tags,
  rating, visited, address, lat, lng, geo_status, geo_source, added_at, updated_at`;

app.get('/api/places', requireViewer, (req, res) => {
  const ids = visibleListIds(req);
  let rows = db.prepare(`SELECT ${PLACE_COLS} FROM places ORDER BY id`).all();
  if (ids) {
    rows = rows.filter(p => ids.includes(p.list_id)).map(p => ({
      id: p.id, list_id: p.list_id, title: p.title, gmaps_url: p.gmaps_url, address: p.address,
      lat: p.lat, lng: p.lng, geo_status: p.geo_status,
      takeout_note: p.takeout_note, takeout_comment: p.takeout_comment, takeout_tags: p.takeout_tags,
      note: p.note, tags: p.tags, rating: p.rating, added_at: p.added_at,
    }));
  }
  res.json(rows);
});

app.post('/api/places', requireOwner, (req, res) => {
  const b = req.body;
  const list = db.prepare('SELECT id FROM lists WHERE id = ?').get(b.list_id);
  if (!list) return res.status(400).json({ error: 'Liste introuvable' });
  const title = String(b.title || '').trim();
  const url = String(b.gmaps_url || '').trim();
  if (!title) return res.status(400).json({ error: 'Nom du lieu requis' });
  const r = db.prepare(`INSERT INTO places(list_id, title, gmaps_url, note, address) VALUES(?, ?, ?, ?, ?)`)
    .run(list.id, title, url, String(b.note || ''), String(b.address || ''));
  kickGeocoder();
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/places/:id', requireOwner, (req, res) => {
  const p = db.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Lieu introuvable' });
  const b = req.body;
  const u = { ...p };
  for (const k of ['title', 'note', 'tags', 'address', 'gmaps_url']) if (b[k] !== undefined) u[k] = String(b[k]);
  if (b.tags !== undefined) u.tags = String(b.tags).split(',').map(t => t.trim()).filter(Boolean).join(', ');
  if (b.rating !== undefined) u.rating = Math.max(0, Math.min(5, parseInt(b.rating, 10) || 0));
  if (b.visited !== undefined) u.visited = b.visited ? 1 : 0;
  if (b.list_id !== undefined) {
    if (!db.prepare('SELECT id FROM lists WHERE id = ?').get(b.list_id)) return res.status(400).json({ error: 'Liste introuvable' });
    u.list_id = Number(b.list_id);
  }
  if (b.lat !== undefined || b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!validCoord(lat, lng)) return res.status(400).json({ error: 'Coordonnées invalides' });
    Object.assign(u, { lat, lng, geo_status: 'manual', geo_source: 'manual' });
  }
  db.prepare(`UPDATE places SET list_id=?, title=?, gmaps_url=?, note=?, tags=?, rating=?, visited=?, address=?,
    lat=?, lng=?, geo_status=?, geo_source=?, updated_at=datetime('now') WHERE id=?`)
    .run(u.list_id, u.title, u.gmaps_url, u.note, u.tags, u.rating, u.visited, u.address, u.lat, u.lng, u.geo_status, u.geo_source, p.id);
  res.json(db.prepare(`SELECT ${PLACE_COLS} FROM places WHERE id = ?`).get(p.id));
});

app.post('/api/places/:id/relocate', requireOwner, (req, res) => {
  db.prepare(`UPDATE places SET geo_status='pending', geo_attempts=0 WHERE id = ?`).run(req.params.id);
  kickGeocoder();
  res.json({ ok: true });
});

app.delete('/api/places/:id', requireOwner, (req, res) => {
  db.prepare('DELETE FROM places WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- import Takeout
app.post('/api/import/preview', requireOwner, (req, res) => {
  const lists = parseTakeoutFiles(req.body.files || []);
  const existing = new Set(db.prepare('SELECT name FROM lists').all().map(r => r.name));
  res.json(lists.map(l => ({
    name: l.name, count: l.places.length,
    located: l.places.filter(p => p.lat != null).length,
    exists: existing.has(l.name),
  })));
});

app.post('/api/import', requireOwner, (req, res) => {
  const selected = Array.isArray(req.body.selected) ? new Set(req.body.selected) : null;
  const sync = !!req.body.sync;
  const lists = parseTakeoutFiles(req.body.files || []).filter(l => !selected || selected.has(l.name));
  const stats = { lists: 0, added: 0, updated: 0, removed: 0 };

  transaction(() => {
    for (const l of lists) {
      let list = db.prepare('SELECT id FROM lists WHERE name = ?').get(l.name);
      if (!list) {
        const r = db.prepare('INSERT INTO lists(name, color, source) VALUES(?, ?, ?)').run(l.name, nextColor(), 'takeout');
        list = { id: Number(r.lastInsertRowid) };
      }
      stats.lists++;
      const current = db.prepare('SELECT id, title, gmaps_url, lat, geo_status FROM places WHERE list_id = ?').all(list.id);
      const byKey = new Map(current.map(p => [placeKey(p.gmaps_url, p.title), p]));
      const seen = new Set();

      for (const p of l.places) {
        const key = placeKey(p.gmaps_url, p.title);
        if (seen.has(key)) continue;
        seen.add(key);
        const ex = byKey.get(key);
        if (ex) {
          // On met à jour les données Takeout sans toucher à tes notes/tags/notes perso.
          db.prepare(`UPDATE places SET title=?, gmaps_url=?, takeout_note=?, takeout_comment=?, takeout_tags=?,
            address=CASE WHEN ?<>'' THEN ? ELSE address END, updated_at=datetime('now') WHERE id=?`)
            .run(p.title, p.gmaps_url, p.takeout_note, p.takeout_comment, p.takeout_tags, p.address || '', p.address || '', ex.id);
          if (p.lat != null && ex.geo_status !== 'manual') {
            db.prepare(`UPDATE places SET lat=?, lng=?, geo_status='ok', geo_source='takeout' WHERE id=?`).run(p.lat, p.lng, ex.id);
          }
          stats.updated++;
        } else {
          db.prepare(`INSERT INTO places(list_id, title, gmaps_url, takeout_note, takeout_comment, takeout_tags, address, lat, lng, geo_status, geo_source)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(list.id, p.title, p.gmaps_url, p.takeout_note, p.takeout_comment, p.takeout_tags, p.address || '',
              p.lat, p.lng, p.lat != null ? 'ok' : 'pending', p.lat != null ? 'takeout' : '');
          stats.added++;
        }
      }
      if (sync) {
        for (const p of current) {
          if (!seen.has(placeKey(p.gmaps_url, p.title))) {
            db.prepare('DELETE FROM places WHERE id = ?').run(p.id);
            stats.removed++;
          }
        }
      }
      db.prepare(`UPDATE lists SET updated_at=datetime('now') WHERE id=?`).run(list.id);
    }
  });
  kickGeocoder();
  res.json(stats);
});

// ---------------------------------------------------------------- amis
app.get('/api/friends', requireOwner, (req, res) => {
  res.json(db.prepare('SELECT id, name, token, created_at FROM friends ORDER BY name COLLATE NOCASE').all());
});
app.post('/api/friends', requireOwner, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const token = crypto.randomBytes(18).toString('base64url');
  const r = db.prepare('INSERT INTO friends(name, token) VALUES(?, ?)').run(name, token);
  res.json({ id: Number(r.lastInsertRowid), name, token });
});
app.post('/api/friends/:id/regenerate', requireOwner, (req, res) => {
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('UPDATE friends SET token = ? WHERE id = ?').run(token, req.params.id);
  res.json({ token });
});
app.delete('/api/friends/:id', requireOwner, (req, res) => {
  db.prepare('DELETE FROM friends WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- géocodage en tâche de fond
const geoState = { running: false, current: null, lastError: '' };

app.get('/api/geo/status', requireOwner, (req, res) => {
  const counts = Object.fromEntries(db.prepare('SELECT geo_status, COUNT(*) AS n FROM places GROUP BY geo_status').all().map(r => [r.geo_status, r.n]));
  res.json({ counts, running: geoState.running, current: geoState.current, lastError: geoState.lastError });
});
app.post('/api/geo/retry-failed', requireOwner, (req, res) => {
  db.prepare(`UPDATE places SET geo_status='pending', geo_attempts=0 WHERE geo_status='failed'`).run();
  kickGeocoder();
  res.json({ ok: true });
});

const GEO_DELAY = Number(process.env.GEO_DELAY_MS || 1100); // Nominatim : 1 requête/seconde max

async function geocodeLoop() {
  if (geoState.running) return;
  geoState.running = true;
  try {
    for (;;) {
      const p = db.prepare(`SELECT id, title, gmaps_url, address FROM places WHERE geo_status = 'pending' ORDER BY id LIMIT 1`).get();
      if (!p) break;
      geoState.current = p.title;
      const r = await locate(p);
      if (r.failed) {
        geoState.lastError = r.errors.join(' | ');
        db.prepare(`UPDATE places SET geo_status='failed', geo_attempts=geo_attempts+1 WHERE id=?`).run(p.id);
      } else {
        db.prepare(`UPDATE places SET lat=?, lng=?, geo_status=?, geo_source=?,
          address=CASE WHEN address='' THEN ? ELSE address END WHERE id=? AND geo_status='pending'`)
          .run(r.lat, r.lng, r.status, r.source, r.address || '', p.id);
      }
      if (r.source !== 'url') await new Promise(ok => setTimeout(ok, GEO_DELAY));
    }
  } finally {
    geoState.running = false;
    geoState.current = null;
  }
}
function kickGeocoder() {
  if (process.env.DISABLE_GEOCODER === '1') return;
  geocodeLoop().catch(e => { geoState.lastError = e.message; geoState.running = false; });
}

// ---------------------------------------------------------------- front
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/markercluster', express.static(path.join(__dirname, 'node_modules/leaflet.markercluster/dist')));
app.use('/vendor/jszip', express.static(path.join(__dirname, 'node_modules/jszip/dist')));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'Fichier trop gros' : 'Erreur serveur' });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Mes listes Google Maps → http://localhost:${port}`);
    kickGeocoder();
  });
}

module.exports = { app, normalizeGmapsListUrl };
