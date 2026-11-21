import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { parseCsv } from '../src/lib/csv.js';
import { parseMapsUrl, dedupeKey } from '../src/lib/mapsUrl.js';
import { parseTakeoutFile, parseSavedPlacesJson } from '../src/importers/takeout.js';
import { parseGetListResponse, extractListId } from '../src/importers/sharedList.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));

test('CSV : guillemets, virgules, retours ligne, BOM', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","multi\nligne ""q"""\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'multi\nligne "q"']]);
});

test('URL Maps : FID → CID, coordonnées, place_id', () => {
  const a = parseMapsUrl('https://www.google.com/maps/place/Tour+Eiffel/data=!4m2!3m1!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0');
  assert.equal(a.cid, BigInt('0x8ddca9ee380ef7e0').toString());
  assert.equal(a.name, 'Tour Eiffel');
  assert.deepEqual([parseMapsUrl('https://www.google.com/maps/search/35.0116,135.7681').lat, 135.7681][0], 35.0116);
  assert.equal(parseMapsUrl('https://maps.google.com/?cid=123456').cid, '123456');
  assert.equal(parseMapsUrl('https://www.google.com/maps/place/?q=place_id:ChIJLU7jZClu5kcR4PcOOO6p3I0').placeId, 'ChIJLU7jZClu5kcR4PcOOO6p3I0');
  const b = parseMapsUrl('https://www.google.com/maps/place/X/@48.1,2.2,17z/data=!3m1!4b1!4m6!3m5!1s0x1:0x2!8m2!3d48.8584!4d2.2945');
  assert.equal(b.lat, 48.8584);
  assert.equal(b.lng, 2.2945);
});

test('Clé de dédoublonnage', () => {
  assert.equal(dedupeKey({ cid: '1', placeId: 'p' }), 'cid:1');
  assert.equal(dedupeKey({ title: 'Café de Flore' }), 'name:cafe de flore');
});

test('Takeout : zip avec plusieurs listes et Saved Places.json', () => {
  const geo = JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2.2945, 48.8584] },
      properties: { google_maps_url: 'http://maps.google.com/?cid=10222232094831998944',
        location: { name: 'Tour Eiffel', address: 'Paris', country_code: 'FR' } } }],
  });
  const zip = zipSync({
    'Takeout/Enregistré/Japon.csv': new Uint8Array(fx('Japon.csv')),
    'Takeout/Enregistré/Favoris.csv': new Uint8Array(fx('Favoris.csv')),
    'Takeout/Maps (vos adresses)/Saved Places.json': strToU8(geo),
    'Takeout/archive_browser.html': strToU8('<html>'),
  });
  const lists = parseTakeoutFile(Buffer.from(zip), 'takeout.zip');
  assert.deepEqual(lists.map((l) => l.name).sort(), ['Favoris', 'Japon', 'Lieux suivis (étoile)']);
  const japon = lists.find((l) => l.name === 'Japon');
  assert.equal(japon.items.length, 3);
  assert.equal(japon.items[0].note, 'Y aller tôt, avant 8h');
  assert.equal(japon.items[2].title, '35.01160, 135.76810');
  const star = lists.find((l) => l.name.startsWith('Lieux suivis'));
  assert.equal(star.items[0].countryCode, 'FR');
  assert.equal(star.items[0].lat, 48.8584);
});

test('Saved Places.json : coordonnées 0,0 ignorées', () => {
  const r = parseSavedPlacesJson(JSON.stringify({ type: 'FeatureCollection', features: [
    { geometry: { coordinates: [0, 0] }, properties: { location: { name: 'X' } } }] }), 'Saved Places.json');
  assert.equal(r.items[0].lat, undefined);
});

test('Lien partagé : identifiant et réponse getlist', () => {
  assert.equal(extractListId('https://www.google.com/maps/@/data=!3m1!4b1!4m3!11m2!2sAbCdEfGhIjKlMnOp!3e3'), 'AbCdEfGhIjKlMnOp');
  const r = parseGetListResponse(fx('getlist.txt').toString());
  assert.equal(r.name, 'Week-end à Lisbonne');
  assert.equal(r.items.length, 2);
  assert.deepEqual(
    { t: r.items[0].title, n: r.items[0].note, lat: r.items[0].lat, cid: r.items[0].cid },
    { t: 'Praça do Comércio', n: 'Coucher de soleil', lat: 38.7075, cid: BigInt('0x1234abcd').toString() });
});
