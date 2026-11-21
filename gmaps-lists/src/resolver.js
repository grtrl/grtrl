import { isCountryCode } from './lib/countries.js';

// F3 — Tri par pays via Google Maps Platform.
//  - lieu avec coordonnées → Geocoding API (géocodage inverse, type « country »)
//  - sinon → Places API (New) Text Search avec le nom du lieu (+ indice de position si disponible)

const pickCountry = (components, codeKey) => {
  const c = (components || []).find((x) => (x.types || []).includes('country'));
  const code = c?.[codeKey]?.toUpperCase();
  return isCountryCode(code) ? code : null;
};

export function createResolver({ apiKey, fetchImpl = fetch }) {
  async function reverseGeocode(lat, lng) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=country&language=fr&key=${apiKey}`;
    const res = await fetchImpl(url);
    const data = await res.json();
    if (data.status === 'ZERO_RESULTS') return { countryCode: null };
    if (data.status !== 'OK') throw new Error(`Geocoding: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    return { countryCode: pickCountry(data.results?.[0]?.address_components, 'short_name') };
  }

  async function textSearch(place) {
    const body = { textQuery: place.address ? `${place.title}, ${place.address}` : place.title, languageCode: 'fr', pageSize: 1 };
    const bias = Number.isFinite(place.lat) ? { lat: place.lat, lng: place.lng } : null;
    if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 2000 } };
    const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Places: ${data?.error?.message || res.status}`);
    const p = data.places?.[0];
    if (!p) return null;
    return {
      placeId: p.id,
      address: p.formattedAddress,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      countryCode: pickCountry(p.addressComponents, 'shortText'),
    };
  }

  return {
    enabled: !!apiKey,
    async resolve(place) {
      if (!apiKey) throw new Error('Clé API Google Maps absente (GOOGLE_MAPS_API_KEY)');
      const hasCoords = Number.isFinite(place.lat) && Number.isFinite(place.lng);
      // Coordonnées connues : le géocodage inverse suffit et ne dépend pas du nom.
      if (hasCoords && !place.country_code) {
        const r = await reverseGeocode(place.lat, place.lng);
        if (r.countryCode) return r;
      }
      if (hasCoords && place.country_code) return {};
      const found = await textSearch(place);
      if (!found) throw new Error('Lieu introuvable dans Google Places');
      if (!found.countryCode && Number.isFinite(found.lat)) {
        found.countryCode = (await reverseGeocode(found.lat, found.lng)).countryCode;
      }
      if (!found.countryCode && !place.country_code) throw new Error('Pays non déterminé');
      return found;
    },
  };
}

// Tâche de fond : résout les lieux en attente, quelques-uns à la fois.
export function startResolutionWorker(db, resolver, { concurrency = 4, idleMs = 3000 } = {}) {
  let stopped = false;
  let wake = null;
  const sleep = (ms) => new Promise((r) => { wake = r; setTimeout(r, ms); });

  async function loop() {
    while (!stopped) {
      const batch = db.pendingResolution(concurrency);
      if (!batch.length) { await sleep(idleMs); continue; }
      await Promise.all(batch.map(async (p) => {
        try {
          db.applyResolution(p.id, await resolver.resolve(p));
        } catch (e) {
          db.markResolveFailed(p.id, e.message);
        }
      }));
    }
  }
  loop();
  return { poke: () => wake?.(), stop: () => { stopped = true; wake?.(); } };
}
