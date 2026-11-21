import { parseMapsUrl } from '../lib/mapsUrl.js';

// F2 — Import depuis le lien d'une liste partagée.
// Google ne fournit pas d'API pour lire une liste : on utilise l'endpoint interne
// « entitylist/getlist » utilisé par Google Maps web. Non officiel, il peut changer.

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

export function extractListId(url) {
  const u = decodeURIComponent(url);
  const m =
    u.match(/!11m\d+!2s([A-Za-z0-9_-]{10,})/) ||
    u.match(/placelists\/list\/([A-Za-z0-9_-]{10,})/) ||
    u.match(/[?&]list(?:_?id)?=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}

// Suit les redirections d'un lien court (maps.app.goo.gl, goo.gl/maps) jusqu'à l'URL finale.
export async function resolveShortLink(url, fetchImpl = fetch) {
  let current = url;
  for (let i = 0; i < 8; i++) {
    if (extractListId(current)) return current;
    const res = await fetchImpl(current, { redirect: 'manual', headers: { 'user-agent': UA } });
    const loc = res.headers.get('location');
    if (!loc) {
      // Certaines pages font la redirection en HTML.
      const body = await res.text();
      const id = body.match(/!11m\d+!2s([A-Za-z0-9_-]{10,})/) || body.match(/placelists\/list\/([A-Za-z0-9_-]{10,})/);
      if (id) return `https://www.google.com/maps/placelists/list/${id[1]}`;
      return current;
    }
    current = new URL(loc, current).toString();
  }
  return current;
}

const isCoordPair = (a) =>
  Array.isArray(a) && a.length >= 4 && a[0] == null && a[1] == null &&
  typeof a[2] === 'number' && typeof a[3] === 'number' && Math.abs(a[2]) <= 90 && Math.abs(a[3]) <= 180;

function findDeep(node, pred, depth = 0) {
  if (depth > 12 || node == null) return undefined;
  if (pred(node)) return node;
  if (Array.isArray(node)) {
    for (const c of node) {
      const r = findDeep(c, pred, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function parsePlaceEntry(entry) {
  if (!Array.isArray(entry)) return null;
  const json = JSON.stringify(entry);
  const coords = findDeep(entry[1] ?? entry, isCoordPair);
  const fids = json.match(/0x[0-9a-f]{1,16}:0x[0-9a-f]{1,16}/gi) || [];
  const info = fids.map((f) => parseMapsUrl(f)).find((i) => i.cid) || {};
  const title = typeof entry[2] === 'string' ? entry[2] : null;
  if (!title) return null;
  const address = Array.isArray(entry[1]) && typeof entry[1][4] === 'string' ? entry[1][4]
    : Array.isArray(entry[1]) && typeof entry[1][2] === 'string' ? entry[1][2] : null;
  return {
    title,
    note: typeof entry[3] === 'string' ? entry[3] : '',
    address,
    lat: coords ? coords[2] : undefined,
    lng: coords ? coords[3] : undefined,
    cid: info.cid,
    url: info.cid ? `https://maps.google.com/?cid=${info.cid}` : null,
  };
}

export function parseGetListResponse(text) {
  const data = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
  const root = Array.isArray(data?.[0]) ? data[0] : data;
  const name = typeof root?.[4] === 'string' ? root[4] : 'Liste partagée';
  let entries = Array.isArray(root?.[8]) ? root[8] : null;
  if (!entries) {
    // Repli : premier tableau dont les éléments ressemblent à des lieux.
    entries = findDeep(root, (n) => Array.isArray(n) && n.length > 0 && n.every((e) => parsePlaceEntry(e)));
  }
  const items = (entries || []).map(parsePlaceEntry).filter(Boolean);
  return { name, items };
}

export async function importSharedList(url, fetchImpl = fetch) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Lien invalide');
  const finalUrl = await resolveShortLink(url.trim(), fetchImpl);
  const listId = extractListId(finalUrl);
  if (!listId) throw new Error("Ce lien ne ressemble pas à une liste Google Maps partagée.");
  const pb = `!1m4!1s${listId}!2e1!3m1!1e1!2e2!3e2!4i500!16b1`;
  const res = await fetchImpl(`https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=fr&gl=fr&pb=${pb}`, {
    headers: { 'user-agent': UA, 'accept-language': 'fr-FR,fr;q=0.9' },
  });
  if (!res.ok) throw new Error(`Google a répondu ${res.status} pour cette liste`);
  const parsed = parseGetListResponse(await res.text());
  if (!parsed.items.length) throw new Error('Aucun lieu trouvé : la liste est-elle bien partagée par lien ?');
  return { ...parsed, listId, sourceRef: url };
}
