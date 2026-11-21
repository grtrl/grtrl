// Extraction des identifiants utiles d'une URL Google Maps.
// Formats rencontrés dans les exports Takeout et les liens partagés :
//   https://www.google.com/maps/place/Nom/data=!4m2!3m1!1s0x47e6...:0x8ddc...
//   https://www.google.com/maps/search/48.8584,2.2945
//   https://maps.google.com/?cid=10222232094831998944
//   https://www.google.com/maps/place/?q=place_id:ChIJ...
//   https://www.google.com/maps/place/Nom/@48.85,2.29,17z/data=...!3d48.858!4d2.294
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const isLat = (n) => Number.isFinite(n) && Math.abs(n) <= 90;
const isLng = (n) => Number.isFinite(n) && Math.abs(n) <= 180;

export function parseMapsUrl(url) {
  const out = {};
  if (!url || typeof url !== 'string') return out;
  const u = safeDecode(url.trim());

  const fid = u.match(/(0x[0-9a-f]{1,16}):(0x[0-9a-f]{1,16})/i);
  if (fid) {
    out.fid = `${fid[1]}:${fid[2]}`.toLowerCase();
    const cid = BigInt(fid[2]);
    if (cid > 0n) out.cid = cid.toString();
  }
  const cid = u.match(/[?&]cid=(\d+)/);
  if (cid) out.cid = cid[1];

  const pid = u.match(/place_id:([A-Za-z0-9_-]{10,})/) || u.match(/[?&]query_place_id=([A-Za-z0-9_-]{10,})/);
  if (pid) out.placeId = pid[1];

  const precise =
    u.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ||
    u.match(/\/search\/(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/) ||
    u.match(/[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)/);
  if (precise) {
    const lat = Number(precise[1]);
    const lng = Number(precise[2]);
    if (isLat(lat) && isLng(lng)) { out.lat = lat; out.lng = lng; }
  } else {
    // Centre de la vue : utile seulement comme indice de localisation.
    const view = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (view && isLat(+view[1]) && isLng(+view[2])) out.approx = { lat: +view[1], lng: +view[2] };
  }

  const name = u.match(/\/maps\/place\/([^/@?]+)/);
  if (name && !name[1].startsWith('?')) out.name = name[1].replace(/\+/g, ' ').trim();
  return out;
}

export function normalizeTitle(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Clé de dédoublonnage : CID > place_id > coordonnées + nom > nom seul.
export function dedupeKey({ cid, placeId, lat, lng, title }) {
  if (cid) return `cid:${cid}`;
  if (placeId) return `pid:${placeId}`;
  const t = normalizeTitle(title);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `geo:${lat.toFixed(5)},${lng.toFixed(5)}:${t}`;
  return `name:${t}`;
}

// Lien Google Maps canonique pour un lieu (ouvre l'appli sur mobile).
export function placeMapsUrl(p, { hl } = {}) {
  const lang = hl ? `&hl=${hl}` : '';
  if (p.place_id) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.title || 'lieu')}&query_place_id=${p.place_id}${lang}`;
  if (p.cid) return `https://maps.google.com/?cid=${p.cid}${lang}`;
  if (p.maps_url) return p.maps_url;
  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}${lang}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.title || '')}${lang}`;
}
