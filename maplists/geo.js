// Outils de localisation des lieux.
// Les CSV de listes Google Takeout ne contiennent PAS de coordonnées, seulement un titre
// et une URL Google Maps. On essaie, dans l'ordre :
//   1. les coordonnées présentes dans l'URL (@lat,lng / !3d…!4d… / ?q=lat,lng)
//   2. l'API Google Places (si GOOGLE_MAPS_API_KEY est défini) — le plus fiable
//   3. la page Google Maps du lieu (lecture du centre de la carte)
//   4. Nominatim / OpenStreetMap par le nom du lieu (marqué « approximatif »)
// Si tout échoue, tu peux placer le lieu à la main sur la carte.

const UA = 'maplists-personal/1.0 (self-hosted)';

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function coordsFromUrl(url) {
  if (!url) return null;
  let s = url;
  try { s = decodeURIComponent(url); } catch { /* garder brut */ }
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,                     // data=…!3dLAT!4dLNG (le plus précis)
    /[?&](?:q|query|ll|center|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /\/maps\/search\/(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/,
    /\/maps\/place\/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,                           // centre de la vue
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (validCoord(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

// "0x47e66e2964e34e2d:0x8ddca9ee380ef7e0" -> CID décimal (2e partie)
function cidFromUrl(url) {
  if (!url) return null;
  const cidParam = url.match(/[?&]cid=(\d+)/);
  if (cidParam) return cidParam[1];
  const m = url.match(/0x[0-9a-f]+:(0x[0-9a-f]+)/i);
  if (!m) return null;
  try { return BigInt(m[1]).toString(); } catch { return null; }
}

// Normalise une URL Google Maps pour comparer deux imports.
function placeKey(url, title) {
  if (url) {
    const ftid = url.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
    if (ftid) return 'ftid:' + ftid[0].toLowerCase();
    const cid = url.match(/[?&]cid=(\d+)/);
    if (cid) return 'cid:' + cid[1];
    const c = coordsFromUrl(url);
    if (c) return `geo:${c.lat.toFixed(5)},${c.lng.toFixed(5)}`;
    return 'url:' + url.trim().toLowerCase();
  }
  return 'title:' + String(title || '').trim().toLowerCase();
}

function placeNameFromUrl(url) {
  const m = (url || '').match(/\/maps\/place\/([^/@?]+)/);
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
  return res.json();
}

async function viaGooglePlaces(place, key) {
  const query = [place.title, place.address].filter(Boolean).join(', ');
  const data = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.location,places.formattedAddress',
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1 }),
  });
  const p = data.places && data.places[0];
  if (!p || !p.location) return null;
  return { lat: p.location.latitude, lng: p.location.longitude, address: p.formattedAddress || '', source: 'google-places', status: 'ok' };
}

async function viaGooglePage(place) {
  const cid = cidFromUrl(place.gmaps_url);
  const url = cid ? `https://maps.google.com/?cid=${cid}&hl=fr` : place.gmaps_url;
  if (!url || !/^https:\/\/((www\.|maps\.)?google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)\//.test(url)) return null;
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      Cookie: 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmZyIAEaBgiA_LyaBg',
    },
  });
  if (!res.ok) return null;
  const fromFinalUrl = coordsFromUrl(res.url);
  const html = await res.text();
  const precise = html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (precise) {
    const lat = parseFloat(precise[1]); const lng = parseFloat(precise[2]);
    if (validCoord(lat, lng)) return { lat, lng, source: 'google-page', status: 'ok' };
  }
  if (fromFinalUrl && /\/place\//.test(res.url)) return { ...fromFinalUrl, source: 'google-page', status: 'ok' };
  // APP_INITIALIZATION_STATE=[[[altitude, lng, lat], …  -> centre de la carte = le lieu
  const init = html.match(/APP_INITIALIZATION_STATE=\[\[\[(-?[\d.e+]+),(-?\d+\.\d+),(-?\d+\.\d+)\]/);
  if (init) {
    const lng = parseFloat(init[2]); const lat = parseFloat(init[3]);
    if (validCoord(lat, lng)) return { lat, lng, source: 'google-page', status: 'ok' };
  }
  return null;
}

async function viaNominatim(place) {
  const q = place.address || place.title || placeNameFromUrl(place.gmaps_url);
  if (!q) return null;
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1' });
  const data = await fetchJson(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr' } });
  if (!data.length) return null;
  const r = data[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), address: r.display_name || '', source: 'nominatim', status: 'approx' };
}

async function locate(place) {
  const fromUrl = coordsFromUrl(place.gmaps_url);
  if (fromUrl) return { ...fromUrl, source: 'url', status: 'ok' };

  const errors = [];
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const steps = [];
  if (key) steps.push(() => viaGooglePlaces(place, key));
  if (process.env.DISABLE_GOOGLE_PAGE !== '1') steps.push(() => viaGooglePage(place));
  if (process.env.DISABLE_NOMINATIM !== '1') steps.push(() => viaNominatim(place));

  for (const step of steps) {
    try {
      const r = await step();
      if (r && validCoord(r.lat, r.lng)) return r;
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { failed: true, errors };
}

module.exports = { coordsFromUrl, cidFromUrl, placeKey, placeNameFromUrl, locate, validCoord };
