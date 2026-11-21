// Lecture des fichiers Google Takeout.
//  - Takeout/Saved (ou « Enregistré »)/<Nom de la liste>.csv  -> une liste par fichier
//    colonnes : Title, Note, URL[, Tags, Comment]
//  - Takeout/Maps (vos adresses)/Saved Places.json (« Lieux enregistrés.json ») -> lieux étoilés (GeoJSON)
//  - Labeled places.json (« Adresses étiquetées.json ») -> GeoJSON aussi

const { coordsFromUrl, validCoord, placeNameFromUrl } = require('./geo');

function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const HEADER_ALIASES = {
  title: ['title', 'titre', 'name', 'nom'],
  note: ['note', 'notes'],
  url: ['url', 'google maps url', 'lien'],
  tags: ['tags', 'libellés', 'labels'],
  comment: ['comment', 'commentaire', 'comments'],
};

function listNameFromPath(p) {
  const base = String(p).split(/[\\/]/).pop();
  return base.replace(/\.(csv|json|geojson)$/i, '').trim() || 'Liste';
}

function parseListCsv(text, filename) {
  const rows = parseCsv(text).filter(r => r.some(c => c.trim() !== ''));
  if (!rows.length) return { name: listNameFromPath(filename), places: [] };

  let idx = { title: 0, note: 1, url: 2, tags: 3, comment: 4 };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const looksLikeHeader = header.some(h => HEADER_ALIASES.title.includes(h) || HEADER_ALIASES.url.includes(h));
  if (looksLikeHeader) {
    idx = {};
    for (const [k, aliases] of Object.entries(HEADER_ALIASES)) {
      idx[k] = header.findIndex(h => aliases.includes(h));
    }
    rows.shift();
  }
  const get = (r, k) => (idx[k] >= 0 && r[idx[k]] != null ? String(r[idx[k]]).trim() : '');

  const places = [];
  for (const r of rows) {
    const url = get(r, 'url');
    const title = get(r, 'title') || placeNameFromUrl(url);
    if (!title && !url) continue;
    const c = coordsFromUrl(url);
    places.push({
      title: title || 'Lieu sans nom',
      gmaps_url: url,
      takeout_note: get(r, 'note'),
      takeout_comment: get(r, 'comment'),
      takeout_tags: get(r, 'tags'),
      lat: c ? c.lat : null,
      lng: c ? c.lng : null,
    });
  }
  return { name: listNameFromPath(filename), places };
}

function parseGeoJson(text, filename) {
  let data;
  try { data = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return null; }
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) return null;

  const places = [];
  for (const f of data.features) {
    const p = f.properties || {};
    const loc = p.location || p.Location || {};
    const url = p.google_maps_url || p['Google Maps URL'] || '';
    const title = loc.name || loc['Business Name'] || p.Title || p.name || loc.address || loc.Address || placeNameFromUrl(url);
    if (!title && !url) continue;

    let lat = null, lng = null;
    const geo = loc['Geo Coordinates'];
    if (geo && validCoord(parseFloat(geo.Latitude), parseFloat(geo.Longitude))) {
      lat = parseFloat(geo.Latitude); lng = parseFloat(geo.Longitude);
    } else if (f.geometry && Array.isArray(f.geometry.coordinates)) {
      const [x, y] = f.geometry.coordinates.map(Number);
      if (validCoord(y, x)) { lat = y; lng = x; }
    }
    if (lat == null) {
      const c = coordsFromUrl(url);
      if (c) { lat = c.lat; lng = c.lng; }
    }
    places.push({
      title: title || 'Lieu sans nom',
      gmaps_url: url,
      takeout_note: '',
      takeout_comment: p.Comment || p.comment || '',
      takeout_tags: '',
      address: loc.address || loc.Address || '',
      lat, lng,
    });
  }
  return { name: listNameFromPath(filename), places };
}

// files: [{ name, content }] -> [{ name, places }]
function parseTakeoutFiles(files) {
  const lists = [];
  for (const f of files) {
    if (!f || typeof f.content !== 'string') continue;
    if (/\.csv$/i.test(f.name)) lists.push(parseListCsv(f.content, f.name));
    else if (/\.(geo)?json$/i.test(f.name)) {
      const l = parseGeoJson(f.content, f.name);
      if (l) lists.push(l);
    }
  }
  return lists.filter(l => l.places.length > 0);
}

module.exports = { parseCsv, parseListCsv, parseGeoJson, parseTakeoutFiles };
