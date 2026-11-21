import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createMockDriver } from '../src/export/googleMapsDriver.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
let server, base, dir, cookie = '';
const calls = [];

// Résolveur simulé : Japon pour les lieux japonais, France sinon ; échec pour un titre précis.
const resolver = {
  enabled: true,
  async resolve(p) {
    calls.push(p.title);
    if (p.title === 'Introuvable') throw new Error('Lieu introuvable dans Google Places');
    const jp = /Senso|Fushimi|^35\./.test(p.title);
    return { countryCode: jp ? 'JP' : 'FR', lat: p.lat ?? 1, lng: p.lng ?? 2 };
  },
};

const driverRuns = [];
const mock = createMockDriver({ delayMs: 1 });
const driver = { ...mock, async run(args) { driverRuns.push(args); return mock.run(args); } };

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { cookie, ...(opts.json ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timeout');
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gml-'));
  const app = createApp({ dataDir: dir, db: openDb(':memory:'), password: 'secret', resolver, driver,
    workerOptions: { idleMs: 20 } });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); });

test('mot de passe requis', async () => {
  assert.equal((await req('/api/overview')).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', json: { password: 'non' } })).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', json: { password: 'secret' } })).status, 200);
  assert.equal((await req('/api/overview')).status, 200);
});

test('import Takeout, tri par pays et doublons (F1, F3, F4, F5)', async () => {
  for (const f of ['Japon.csv', 'Favoris.csv']) {
    const r = await req('/api/import/file', { method: 'POST', body: fx(f), headers: { 'x-filename': f } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const ov = await waitFor(async () => { const o = (await req('/api/overview')).body; return o.stats.pending === 0 && o; });
  assert.deepEqual(ov.countries.map((c) => [c.code, c.count]), [['JP', 3], ['FR', 1]]);
  const jp = (await req('/api/countries/JP/places')).body.places;
  const senso = jp.find((p) => p.title === 'Senso-ji');
  assert.deepEqual(senso.lists.map((l) => l.name), ['Favoris', 'Japon']); // un seul lieu, deux listes
  assert.equal(senso.note, 'Y aller tôt, avant 8h');
  // Ré-importer le même fichier ne crée pas de doublon.
  await req('/api/import/file', { method: 'POST', body: fx('Japon.csv'), headers: { 'x-filename': 'Japon.csv' } });
  assert.equal((await req('/api/countries/JP/places')).body.places.length, 3);
});

test('fichier invalide refusé', async () => {
  const r = await req('/api/import/file', { method: 'POST', body: 'bonjour', headers: { 'x-filename': 'x.txt' } });
  assert.equal(r.status, 400);
});

test('correction manuelle (F6)', async () => {
  const fr = (await req('/api/countries/FR/places')).body.places[0];
  let r = await req(`/api/places/${fr.id}`, { method: 'PATCH', json: { countryCode: 'BE', note: 'Pas à Paris ?' } });
  assert.equal(r.body.country_code, 'BE');
  assert.equal(r.body.country_source, 'manual');
  assert.equal((await req(`/api/places/${fr.id}`, { method: 'PATCH', json: { countryCode: 'ZZ' } })).status, 400);
  r = await req(`/api/places/${fr.id}`, { method: 'PATCH', json: { removed: true } });
  const ov = (await req('/api/overview')).body;
  assert.ok(!ov.countries.some((c) => c.code === 'BE'));
  assert.equal((await req('/api/places/removed')).body.length, 1);
  await req(`/api/places/${fr.id}`, { method: 'PATCH', json: { removed: false } });
  // Une correction manuelle n'est jamais écrasée par la détection.
  await req('/api/places/retry-resolution', { method: 'POST' });
  assert.equal((await req('/api/countries/BE/places')).body.places.length, 1);
});

test('export d\'un pays puis mise à jour (F7, F8, F9)', async () => {
  let r = await req('/api/exports', { method: 'POST', json: { countryCode: 'JP' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.name, 'Japon');
  let exp = await waitFor(async () => (await req('/api/exports')).body.find((e) => e.status === 'success'));
  assert.match(exp.share_url, /^https:\/\/maps\.app\.goo\.gl\//);
  assert.equal(driverRuns.at(-1).toAdd.length, 3);

  // On retire un lieu du Japon puis on met à jour : seul ce lieu est retiré de la liste Google.
  const jp = (await req('/api/countries/JP/places')).body.places;
  await req(`/api/places/${jp[0].id}`, { method: 'PATCH', json: { removed: true } });
  await req(`/api/exports/${exp.id}/run`, { method: 'POST' });
  exp = await waitFor(async () => { const e = (await req('/api/exports')).body[0]; return e.status === 'success' && driverRuns.length === 2 && e; });
  assert.equal(driverRuns[1].toAdd.length, 0);
  assert.deepEqual(driverRuns[1].toRemove.map((p) => p.title), [jp[0].title]);
});

test('export d\'une sélection et échec signalé', async () => {
  const jp = (await req('/api/countries/JP/places')).body.places;
  const failing = { ...driver, run: async () => { throw new Error('Google a changé'); } };
  Object.assign(driver, failing);
  await req('/api/exports', { method: 'POST', json: { name: 'Sélection test', placeIds: [jp[0].id] } });
  const e = await waitFor(async () => (await req('/api/exports')).body.find((x) => x.name === 'Sélection test' && x.status === 'failed'));
  assert.equal(e.error, 'Google a changé');
  assert.equal(e.count, 1);
  assert.equal((await req('/api/exports', { method: 'POST', json: { name: 'Vide' } })).status, 400);
});

test('import par lien partagé (F2) avec réponse Google simulée', async () => {
  // Serveur dédié avec fetch simulé.
  const list = fx('getlist.txt').toString();
  const fakeFetch = async (url) => {
    if (url.startsWith('https://maps.app.goo.gl/')) {
      return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2sAbCdEfGhIjKlMnOp!3e3' } });
    }
    if (url.includes('entitylist/getlist') && url.includes('AbCdEfGhIjKlMnOp')) return new Response(list);
    return new Response('', { status: 404 });
  };
  const app = createApp({ dataDir: dir, db: openDb(':memory:'), password: '', resolver, driver, fetchImpl: fakeFetch, workerOptions: { idleMs: 20 } });
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/import/link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://maps.app.goo.gl/abc123' }),
  });
  const body = await res.json();
  s.close();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.lists[0].name, 'Week-end à Lisbonne');
  assert.equal(body.lists[0].created, 2);
});
