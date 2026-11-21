import { unzipSync, strFromU8 } from 'fflate';
import { csvToObjects } from '../lib/csv.js';
import { parseMapsUrl } from '../lib/mapsUrl.js';
import { isCountryCode } from '../lib/countries.js';

// F1 — Import de l'export Google Takeout.
// Takeout « Enregistré » (Saved) : un CSV par liste, colonnes Title, Note, URL, (Tags), Comment.
// Takeout « Maps (vos adresses) » : « Saved Places.json » (GeoJSON des lieux suivis d'une étoile).

const baseName = (path) => path.split('/').pop().replace(/\.(csv|json)$/i, '');

export function parseTakeoutCsv(text, fileName) {
  const rows = csvToObjects(text);
  const items = rows.map((r) => {
    const url = r.url || r['google maps url'] || '';
    const info = parseMapsUrl(url);
    return {
      title: r.title || r.titre || r.name || info.name || '',
      note: r.note || '',
      comment: r.comment || r.commentaire || '',
      url: url || null,
      cid: info.cid,
      placeId: info.placeId,
      lat: info.lat,
      lng: info.lng,
    };
  }).filter((i) => i.title || i.url);
  // Un lieu sans titre (épingle déposée) reçoit ses coordonnées comme titre.
  for (const i of items) {
    if (!i.title) i.title = Number.isFinite(i.lat) ? `${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}` : 'Lieu sans nom';
  }
  return { name: baseName(fileName), items };
}

export function parseSavedPlacesJson(text, fileName) {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) return null;
  const items = data.features.map((f) => {
    const p = f.properties || {};
    const loc = p.location || p.Location || {};
    const url = p.google_maps_url || p['Google Maps URL'] || '';
    const info = parseMapsUrl(url);
    const [lng, lat] = f.geometry?.coordinates || [];
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
    const cc = (loc.country_code || loc['Country Code'] || '').toUpperCase();
    return {
      title: loc.name || loc['Business Name'] || p.Title || info.name || loc.address || 'Lieu sans nom',
      address: loc.address || loc.Address || null,
      note: p.Comment || p.comment || '',
      url: url || null,
      cid: info.cid,
      placeId: info.placeId,
      lat: hasCoords ? lat : info.lat,
      lng: hasCoords ? lng : info.lng,
      countryCode: isCountryCode(cc) ? cc : undefined,
    };
  });
  const name = /saved places|lieux enregistr/i.test(fileName) ? 'Lieux suivis (étoile)' : baseName(fileName);
  return { name, items };
}

// Accepte un .zip Takeout, un .csv ou un .json. Renvoie une liste de { name, items }.
export function parseTakeoutFile(buffer, fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip') || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    const files = unzipSync(new Uint8Array(buffer), {
      filter: (f) => /\.(csv|json)$/i.test(f.name) && !f.name.split('/').pop().startsWith('.'),
    });
    const lists = [];
    for (const [path, bytes] of Object.entries(files)) {
      const parsed = parseEntry(strFromU8(bytes), path);
      if (parsed?.items.length) lists.push(parsed);
    }
    return lists;
  }
  const parsed = parseEntry(buffer.toString('utf8'), fileName);
  return parsed?.items.length ? [parsed] : [];
}

function parseEntry(text, path) {
  if (/\.csv$/i.test(path)) {
    const head = text.slice(0, 500).toLowerCase();
    if (!/url/.test(head)) return null; // CSV sans colonne URL : pas une liste Google
    return parseTakeoutCsv(text, path);
  }
  if (/\.json$/i.test(path)) {
    try { return parseSavedPlacesJson(text, path); } catch { return null; }
  }
  return null;
}
