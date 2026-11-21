const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maplists-'));
process.env.DATA_DIR = tmp;
process.env.DISABLE_GEOCODER = '1';

const { coordsFromUrl, cidFromUrl, placeKey } = require('../geo');
const { parseListCsv, parseGeoJson } = require('../takeout');
const { app, normalizeGmapsListUrl } = require('../server');

const CSV = `Title,Note,URL,Tags,Comment
,,,,
Café de Flore,"Super terrasse, ""mythique""",https://www.google.com/maps/place/Caf%C3%A9+de+Flore/data=!4m2!3m1!1s0x47e671d1c4e4dbc5:0x6e0e6fbf6b6f1b87,,
Point précis,,"https://www.google.com/maps/search/48.8584,+2.2945",,
Avec 3d4d,,"https://www.google.com/maps/place/X/@48.1,2.1,17z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d48.123!4d2.456",,
`;

test('coordonnées extraites des URLs', () => {
  assert.deepStrictEqual(coordsFromUrl('https://www.google.com/maps/search/48.8584,+2.2945'), { lat: 48.8584, lng: 2.2945 });
  assert.deepStrictEqual(coordsFromUrl('https://x/maps/place/X/@48.1,2.1,17z/data=!8m2!3d48.123!4d2.456'), { lat: 48.123, lng: 2.456 });
  assert.strictEqual(coordsFromUrl('https://www.google.com/maps/place/A/data=!4m2!3m1!1s0x1:0x2'), null);
  assert.strictEqual(cidFromUrl('https://maps.google.com/?cid=123'), '123');
  assert.strictEqual(cidFromUrl('…1s0x47e671d1c4e4dbc5:0xff'), '255');
  assert.strictEqual(placeKey('https://a/data=!1s0xAB:0xCD', 'x'), 'ftid:0xab:0xcd');
});

test('parse CSV Takeout', () => {
  const l = parseListCsv(CSV, 'Takeout/Enregistré/Paris à faire.csv');
  assert.strictEqual(l.name, 'Paris à faire');
  assert.strictEqual(l.places.length, 3);
  assert.strictEqual(l.places[0].takeout_note, 'Super terrasse, "mythique"');
  assert.strictEqual(l.places[0].lat, null);
  assert.strictEqual(l.places[1].lat, 48.8584);
  assert.strictEqual(l.places[2].lng, 2.456);
});

test('parse GeoJSON (nouveau et ancien format)', () => {
  const l = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [2.35, 48.85] }, properties: { google_maps_url: 'http://maps.google.com/?cid=1', location: { name: 'Lieu A', address: '1 rue X' } } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { 'Google Maps URL': 'u', Title: 'B', Location: { 'Geo Coordinates': { Latitude: '45.1', Longitude: '4.2' } } } },
  ] }), 'Saved Places.json');
  assert.strictEqual(l.places.length, 2);
  assert.deepStrictEqual([l.places[0].lat, l.places[0].lng, l.places[0].address], [48.85, 2.35, '1 rue X']);
  assert.deepStrictEqual([l.places[1].lat, l.places[1].lng], [45.1, 4.2]);
});

test('liens Google Maps acceptés / My Maps refusé', () => {
  assert.ok(normalizeGmapsListUrl('https://maps.app.goo.gl/abc123'));
  assert.ok(normalizeGmapsListUrl('https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2sXYZ!3e3'));
  assert.throws(() => normalizeGmapsListUrl('https://www.google.com/maps/d/viewer?mid=1'), /My Maps/);
  assert.throws(() => normalizeGmapsListUrl('https://example.com/x'));
});

let server, base;
before(() => new Promise(ok => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
after(() => server.close());

function client() {
  let cookie = '';
  return async (p, opts = {}) => {
    const res = await fetch(base + p, {
      method: opts.method || 'GET', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

test('parcours complet : setup, import, réimport, partage ami', async () => {
  const owner = client();
  assert.strictEqual((await owner('/api/lists')).status, 401);
  assert.strictEqual((await owner('/api/me')).data.needsSetup, true);
  assert.strictEqual((await owner('/api/setup', { method: 'POST', body: { password: 'motdepasse1' } })).status, 200);
  assert.strictEqual((await owner('/api/me')).data.role, 'owner');

  const files = [{ name: 'Takeout/Saved/Paris.csv', content: CSV }, { name: 'Takeout/Saved/Vide.csv', content: 'Title,Note,URL\n' }];
  const prev = await owner('/api/import/preview', { method: 'POST', body: { files } });
  assert.deepStrictEqual(prev.data.map(l => [l.name, l.count, l.located]), [['Paris', 3, 2]]);
  const imp = await owner('/api/import', { method: 'POST', body: { files } });
  assert.deepStrictEqual(imp.data, { lists: 1, added: 3, updated: 0, removed: 0 });

  let places = (await owner('/api/places')).data;
  const flore = places.find(p => p.title === 'Café de Flore');
  assert.strictEqual(flore.geo_status, 'pending');
  await owner(`/api/places/${flore.id}`, { method: 'PATCH', body: { note: 'Ma note', tags: 'café , terrasse', rating: 4, lat: 48.854, lng: 2.333 } });

  // Réimport avec un lieu en moins + sync : notes conservées, lieu supprimé
  const csv2 = CSV.split('\n').filter(l => !l.startsWith('Point précis')).join('\n');
  const imp2 = await owner('/api/import', { method: 'POST', body: { files: [{ name: 'Paris.csv', content: csv2 }], sync: true } });
  assert.deepStrictEqual(imp2.data, { lists: 1, added: 0, updated: 2, removed: 1 });
  places = (await owner('/api/places')).data;
  const f2 = places.find(p => p.title === 'Café de Flore');
  assert.deepStrictEqual([f2.note, f2.tags, f2.rating, f2.geo_status, f2.lat], ['Ma note', 'café, terrasse', 4, 'manual', 48.854]);

  // Une 2e liste privée
  const priv = await owner('/api/lists', { method: 'POST', body: { name: 'Secret' } });
  await owner('/api/places', { method: 'POST', body: { list_id: priv.data.id, title: 'Cachette' } });

  const lists = (await owner('/api/lists')).data;
  const paris = lists.find(l => l.name === 'Paris');
  const bad = await owner(`/api/lists/${paris.id}`, { method: 'PATCH', body: { gmaps_url: 'https://www.google.com/maps/d/edit?mid=abc' } });
  assert.strictEqual(bad.status, 400);

  // Ami
  const fr = (await owner('/api/friends', { method: 'POST', body: { name: 'Léa' } })).data;
  const friend = client();
  const r = await friend(`/f/${fr.token}`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual((await friend('/api/me')).data.role, 'friend');
  assert.deepStrictEqual((await friend('/api/lists')).data, []);
  assert.strictEqual((await friend('/api/lists', { method: 'POST', body: { name: 'x' } })).status, 401);

  await owner(`/api/lists/${paris.id}`, { method: 'PATCH', body: { visibility: 'selected', friend_ids: [fr.id], gmaps_url: 'https://maps.app.goo.gl/AbC' } });
  const fl = (await friend('/api/lists')).data;
  assert.deepStrictEqual(fl.map(l => [l.name, l.gmaps_url]), [['Paris', 'https://maps.app.goo.gl/AbC']]);
  assert.strictEqual(fl[0].visibility, undefined);
  const fp = (await friend('/api/places')).data;
  assert.strictEqual(fp.length, 2);
  assert.ok(fp.every(p => p.visited === undefined));
  assert.ok(!fp.some(p => p.title === 'Cachette'));

  // Révocation
  await owner(`/api/friends/${fr.id}/regenerate`, { method: 'POST' });
  assert.strictEqual((await friend('/api/lists')).status, 401);
});
