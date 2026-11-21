import express from 'express';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { parseTakeoutFile } from './importers/takeout.js';
import { importSharedList } from './importers/sharedList.js';
import { createResolver, startResolutionWorker } from './resolver.js';
import { createGoogleMapsDriver, createMockDriver } from './export/googleMapsDriver.js';
import { startExportRunner } from './export/jobs.js';
import { COUNTRY_CODES, countryName, isCountryCode } from './lib/countries.js';
import { placeMapsUrl } from './lib/mapsUrl.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? join(ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = opts.db ?? openDb(join(dataDir, 'app.db'));
  const password = opts.password ?? process.env.APP_PASSWORD ?? '';
  const secret = process.env.SESSION_SECRET || db.getSetting('session_secret') || (() => {
    const s = randomBytes(32).toString('hex');
    db.setSetting('session_secret', s);
    return s;
  })();
  const storageStatePath = join(dataDir, 'google-session.json');
  const screenshotDir = join(dataDir, 'screenshots');

  const resolver = opts.resolver ?? createResolver({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
  if (resolver.enabled) db.requeueFailed();
  const worker = startResolutionWorker(db, resolver, opts.workerOptions);
  const driver = opts.driver ?? (process.env.EXPORT_DRIVER === 'mock'
    ? createMockDriver()
    : createGoogleMapsDriver({ storageStatePath, screenshotDir, headless: process.env.HEADLESS !== 'false' }));
  const runner = startExportRunner(db, driver);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Authentification (un seul utilisateur, mot de passe APP_PASSWORD) ---
  const sign = (v) => createHmac('sha256', secret).update(v).digest('base64url');
  const token = () => { const v = `ok.${Date.now()}`; return `${v}.${sign(v)}`; };
  const valid = (t) => {
    if (!t) return false;
    const i = t.lastIndexOf('.');
    const a = Buffer.from(t.slice(i + 1));
    const b = Buffer.from(sign(t.slice(0, i)));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookie = (req) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('sid='))?.slice(4);
  const authed = (req) => !password || valid(cookie(req));

  app.post('/api/login', express.json(), async (req, res) => {
    const given = Buffer.from(String(req.body?.password ?? ''));
    const expected = Buffer.from(password);
    if (!password || (given.length === expected.length && timingSafeEqual(given, expected))) {
      res.setHeader('Set-Cookie', `sid=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
      return res.json({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 800));
    res.status(401).json({ error: 'Mot de passe incorrect' });
  });
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });
  app.get('/api/session', (req, res) => res.json({ authenticated: authed(req), passwordRequired: !!password }));
  app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Non connecté' })));

  const decorate = (p) => ({
    ...p,
    country_name: countryName(p.country_code),
    google_url: placeMapsUrl(p),
    lists: db.placeLists(p.id),
  });

  // --- Import (F1, F2) ---
  app.post('/api/import/file', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
    const fileName = decodeURIComponent(req.get('x-filename') || 'import.zip');
    if (!req.body?.length) return res.status(400).json({ error: 'Fichier vide' });
    let lists;
    try { lists = parseTakeoutFile(req.body, fileName); }
    catch (e) { return res.status(400).json({ error: `Fichier illisible : ${e.message}` }); }
    if (!lists.length) return res.status(400).json({ error: 'Aucune liste trouvée dans ce fichier (attendu : export Takeout « Enregistré »).' });
    const results = lists.map((l) => db.importList({ name: l.name, source: 'takeout', sourceRef: fileName, items: l.items }));
    worker.poke();
    res.json({ lists: results });
  });

  app.post('/api/import/link', express.json(), async (req, res) => {
    try {
      const l = await importSharedList(String(req.body?.url || ''), fetchImpl);
      const r = db.importList({ name: l.name, source: 'link', sourceRef: l.sourceRef, items: l.items });
      worker.poke();
      res.json({ lists: [r] });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // --- Consultation (F5) ---
  app.get('/api/overview', (req, res) => {
    const countries = db.countries().map((c) => ({ ...c, name: countryName(c.code) }));
    countries.sort((a, b) => (a.code ? 0 : -1) - (b.code ? 0 : -1) || b.count - a.count || a.name.localeCompare(b.name, 'fr'));
    res.json({
      countries,
      stats: db.resolutionStats(),
      resolverEnabled: resolver.enabled,
      exportReady: driver.isReady(),
      exportDriver: driver.name,
    });
  });
  app.get('/api/countries/:code/places', (req, res) => {
    const code = req.params.code === 'none' ? null : req.params.code.toUpperCase();
    res.json({ code, name: countryName(code), places: db.placesByCountry(code).map(decorate) });
  });
  app.get('/api/country-codes', (req, res) => {
    res.json(COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  });
  app.get('/api/lists', (req, res) => res.json(db.lists()));

  // --- Correction manuelle (F6) ---
  app.patch('/api/places/:id', express.json(), (req, res) => {
    const id = Number(req.params.id);
    if (!db.getPlace(id)) return res.status(404).json({ error: 'Lieu introuvable' });
    const { countryCode, note, removed } = req.body || {};
    if (countryCode !== undefined && countryCode !== null && !isCountryCode(countryCode)) {
      return res.status(400).json({ error: 'Pays inconnu' });
    }
    res.json(decorate(db.updatePlace(id, {
      countryCode: countryCode === undefined ? undefined : countryCode?.toUpperCase() ?? null,
      note: note === undefined ? undefined : String(note).slice(0, 2000),
      removed,
    })));
  });
  app.get('/api/places/removed', (req, res) => res.json(db.removedPlaces().map(decorate)));
  app.post('/api/places/retry-resolution', (req, res) => {
    const n = db.requeueFailed();
    worker.poke();
    res.json({ requeued: n });
  });

  // --- Export (F7, F8, F9) ---
  app.get('/api/exports', (req, res) => {
    res.json(db.exports().map((e) => ({
      ...e,
      country_name: e.country_code ? countryName(e.country_code) : null,
      count: db.exportTargetPlaces(e).length,
    })));
  });
  app.post('/api/exports', express.json(), (req, res) => {
    const { countryCode, placeIds } = req.body || {};
    const name = String(req.body?.name || (countryCode ? countryName(countryCode) : '')).trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Nom de liste requis' });
    if (!countryCode && !(Array.isArray(placeIds) && placeIds.length)) {
      return res.status(400).json({ error: 'Choisissez un pays ou des lieux' });
    }
    if (countryCode && !isCountryCode(countryCode)) return res.status(400).json({ error: 'Pays inconnu' });
    const exp = db.upsertExport({
      name,
      countryCode: countryCode ? countryCode.toUpperCase() : null,
      placeIds: countryCode ? null : placeIds.map(Number).filter(Number.isInteger),
    });
    runner.poke();
    res.status(202).json(exp);
  });
  app.post('/api/exports/:id/run', (req, res) => {
    const exp = db.getExport(Number(req.params.id));
    if (!exp) return res.status(404).json({ error: 'Export introuvable' });
    if (exp.status === 'running') return res.status(409).json({ error: 'Export déjà en cours' });
    db.requeueExport(exp.id);
    runner.poke();
    res.status(202).json(db.getExport(exp.id));
  });
  app.delete('/api/exports/:id', (req, res) => {
    db.deleteExport(Number(req.params.id));
    res.json({ ok: true });
  });
  app.get('/api/screenshots/:file', (req, res) => {
    if (!/^export-\d+\.png$/.test(req.params.file)) return res.status(404).end();
    res.sendFile(join(screenshotDir, req.params.file));
  });

  // --- Réglages : session du compte Google dédié ---
  app.get('/api/settings', (req, res) => {
    res.json({
      googleSession: existsSync(storageStatePath) ? { updatedAt: statSync(storageStatePath).mtime } : null,
      resolverEnabled: resolver.enabled,
      exportDriver: driver.name,
      passwordProtected: !!password,
    });
  });
  app.put('/api/settings/google-session', express.text({ type: () => true, limit: '5mb' }), (req, res) => {
    let state;
    try { state = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'JSON invalide' }); }
    const ok = Array.isArray(state?.cookies) && state.cookies.some((c) => /google\./.test(c.domain || ''));
    if (!ok) return res.status(400).json({ error: 'Ce fichier ne contient pas de session Google (cookies).' });
    writeFileSync(storageStatePath, JSON.stringify(state), { mode: 0o600 });
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Introuvable' }));
  app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));

  app.locals = { db, worker, runner };
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Listes Maps → http://localhost:${port}`);
    if (!process.env.APP_PASSWORD) console.warn('⚠ APP_PASSWORD non défini : app accessible sans mot de passe.');
    if (!process.env.GOOGLE_MAPS_API_KEY) console.warn('⚠ GOOGLE_MAPS_API_KEY non définie : tri par pays automatique désactivé.');
  });
}
