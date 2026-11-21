import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dedupeKey } from './lib/mapsUrl.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'takeout' | 'link'
  source_ref TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (source, name)
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  cid TEXT,
  place_id TEXT,
  maps_url TEXT,
  country_code TEXT,
  country_source TEXT,             -- 'import' | 'api' | 'manual'
  resolve_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'failed'
  resolve_error TEXT,
  note TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS places_country ON places(country_code);
CREATE INDEX IF NOT EXISTS places_cid ON places(cid);
CREATE INDEX IF NOT EXISTS places_pid ON places(place_id);
CREATE TABLE IF NOT EXISTS place_lists (
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  source_note TEXT,
  PRIMARY KEY (place_id, list_id)
);
CREATE TABLE IF NOT EXISTS exports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,       -- nom de la liste dans Google Maps
  country_code TEXT,               -- export d'un pays (contenu recalculé à chaque lancement)
  place_ids TEXT,                  -- ou export d'une sélection (JSON)
  status TEXT NOT NULL,            -- 'pending' | 'running' | 'success' | 'failed'
  share_url TEXT,
  exported_keys TEXT,              -- JSON : lieux présents dans la liste Google après le dernier succès
  progress TEXT,
  error TEXT,
  screenshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const now = () => new Date().toISOString();

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(db) {
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  function findExisting(item) {
    if (item.cid) {
      const r = q('SELECT * FROM places WHERE cid = ?').get(item.cid);
      if (r) return r;
    }
    if (item.placeId) {
      const r = q('SELECT * FROM places WHERE place_id = ?').get(item.placeId);
      if (r) return r;
    }
    return q('SELECT * FROM places WHERE dedupe_key = ?').get(dedupeKey(item));
  }

  // Import d'une liste : crée ou réutilise la liste et ses lieux (F1, F2, F4).
  function importList({ name, source, sourceRef, items }) {
    return tx(() => {
      const t = now();
      q(`INSERT INTO lists (name, source, source_ref, imported_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source, name) DO UPDATE SET source_ref = excluded.source_ref, imported_at = excluded.imported_at`)
        .run(name, source, sourceRef ?? null, t);
      const list = q('SELECT id FROM lists WHERE source = ? AND name = ?').get(source, name);
      let created = 0;
      let merged = 0;
      for (const item of items) {
        if (!item.title) continue;
        let place = findExisting(item);
        if (!place) {
          const hasCountry = !!item.countryCode;
          const r = q(`INSERT INTO places (dedupe_key, title, address, lat, lng, cid, place_id, maps_url, country_code,
                        country_source, resolve_status, note, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            dedupeKey(item), item.title, item.address ?? null, item.lat ?? null, item.lng ?? null,
            item.cid ?? null, item.placeId ?? null, item.url ?? null,
            hasCountry ? item.countryCode : null, hasCountry ? 'import' : null,
            hasCountry && Number.isFinite(item.lat) ? 'ok' : 'pending',
            item.note || null, t, t);
          place = { id: Number(r.lastInsertRowid) };
          created++;
        } else {
          merged++;
          // Complète les informations manquantes sans écraser les corrections.
          q(`UPDATE places SET
               address = COALESCE(address, ?), lat = COALESCE(lat, ?), lng = COALESCE(lng, ?),
               cid = COALESCE(cid, ?), place_id = COALESCE(place_id, ?), maps_url = COALESCE(maps_url, ?),
               note = COALESCE(note, ?), updated_at = ?
             WHERE id = ?`).run(
            item.address ?? null, item.lat ?? null, item.lng ?? null, item.cid ?? null, item.placeId ?? null,
            item.url ?? null, item.note || null, t, place.id);
          if (item.countryCode) {
            q(`UPDATE places SET country_code = ?, country_source = 'import'
               WHERE id = ? AND country_code IS NULL`).run(item.countryCode, place.id);
          }
        }
        const sourceNote = [item.note, item.comment].filter(Boolean).join(' — ') || null;
        q(`INSERT INTO place_lists (place_id, list_id, source_note) VALUES (?, ?, ?)
           ON CONFLICT (place_id, list_id) DO UPDATE SET source_note = excluded.source_note`)
          .run(place.id, list.id, sourceNote);
      }
      return { listId: list.id, name, places: items.length, created, merged };
    });
  }

  function placeLists(id) {
    return q(`SELECT l.id, l.name, l.source, pl.source_note FROM place_lists pl JOIN lists l ON l.id = pl.list_id
              WHERE pl.place_id = ? ORDER BY l.name`).all(id);
  }

  // Après résolution : applique le résultat et fusionne avec un doublon éventuel (même place_id/CID).
  function applyResolution(id, res) {
    return tx(() => {
      const t = now();
      const dup = res.placeId
        ? q('SELECT id FROM places WHERE place_id = ? AND id != ?').get(res.placeId, id)
        : null;
      if (dup) {
        q(`INSERT OR IGNORE INTO place_lists (place_id, list_id, source_note)
           SELECT ?, list_id, source_note FROM place_lists WHERE place_id = ?`).run(dup.id, id);
        q(`UPDATE places SET note = COALESCE(note, (SELECT note FROM places WHERE id = ?)) WHERE id = ?`).run(id, dup.id);
        q('DELETE FROM places WHERE id = ?').run(id);
        return { mergedInto: dup.id };
      }
      q(`UPDATE places SET
           lat = COALESCE(?, lat), lng = COALESCE(?, lng), address = COALESCE(address, ?),
           place_id = COALESCE(place_id, ?),
           country_code = CASE WHEN country_source = 'manual' THEN country_code ELSE COALESCE(?, country_code) END,
           country_source = CASE WHEN country_source = 'manual' THEN 'manual' WHEN ? IS NOT NULL THEN 'api' ELSE country_source END,
           resolve_status = 'ok', resolve_error = NULL, updated_at = ?
         WHERE id = ?`).run(
        res.lat ?? null, res.lng ?? null, res.address ?? null, res.placeId ?? null,
        res.countryCode ?? null, res.countryCode ?? null, t, id);
      return {};
    });
  }

  return {
    raw: db,
    importList,
    placeLists,
    applyResolution,

    countries() {
      return q(`SELECT country_code AS code, COUNT(*) AS count FROM places
                WHERE removed = 0 GROUP BY country_code ORDER BY count DESC`).all();
    },
    placesByCountry(code) {
      const sql = code
        ? 'SELECT * FROM places WHERE removed = 0 AND country_code = ? ORDER BY title COLLATE NOCASE'
        : 'SELECT * FROM places WHERE removed = 0 AND country_code IS NULL ORDER BY title COLLATE NOCASE';
      return code ? q(sql).all(code) : q(sql).all();
    },
    removedPlaces() {
      return q('SELECT * FROM places WHERE removed = 1 ORDER BY title COLLATE NOCASE').all();
    },
    getPlace(id) {
      return q('SELECT * FROM places WHERE id = ?').get(id);
    },
    getPlaces(ids) {
      if (!ids.length) return [];
      return q(`SELECT * FROM places WHERE removed = 0 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    },
    // F6 : correction manuelle.
    updatePlace(id, { countryCode, note, removed }) {
      const t = now();
      if (countryCode !== undefined) {
        q(`UPDATE places SET country_code = ?, country_source = 'manual', updated_at = ? WHERE id = ?`)
          .run(countryCode || null, t, id);
      }
      if (note !== undefined) q('UPDATE places SET note = ?, updated_at = ? WHERE id = ?').run(note || null, t, id);
      if (removed !== undefined) q('UPDATE places SET removed = ?, updated_at = ? WHERE id = ?').run(removed ? 1 : 0, t, id);
      return this.getPlace(id);
    },
    pendingResolution(limit) {
      return q(`SELECT * FROM places WHERE resolve_status = 'pending' ORDER BY id LIMIT ?`).all(limit);
    },
    markResolveFailed(id, error) {
      q(`UPDATE places SET resolve_status = 'failed', resolve_error = ?, updated_at = ? WHERE id = ?`).run(error, now(), id);
    },
    requeueFailed() {
      return q(`UPDATE places SET resolve_status = 'pending', resolve_error = NULL
                WHERE resolve_status = 'failed' AND country_source IS NOT 'manual'`).run().changes;
    },
    resolutionStats() {
      return q(`SELECT
          SUM(resolve_status = 'pending') AS pending,
          SUM(resolve_status = 'failed') AS failed,
          SUM(country_code IS NULL AND removed = 0) AS unclassified,
          SUM(removed = 0) AS total
        FROM places`).get();
    },
    lists() {
      return q(`SELECT l.*, COUNT(pl.place_id) AS count FROM lists l
                LEFT JOIN place_lists pl ON pl.list_id = l.id GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).all();
    },

    // Exports (F7–F9).
    exports() {
      return q('SELECT * FROM exports ORDER BY updated_at DESC').all();
    },
    getExport(id) {
      return q('SELECT * FROM exports WHERE id = ?').get(id);
    },
    upsertExport({ name, countryCode, placeIds }) {
      const t = now();
      q(`INSERT INTO exports (name, country_code, place_ids, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (name) DO UPDATE SET country_code = excluded.country_code, place_ids = excluded.place_ids,
           status = 'pending', error = NULL, progress = NULL, screenshot = NULL, updated_at = excluded.updated_at`)
        .run(name, countryCode ?? null, placeIds ? JSON.stringify(placeIds) : null, t, t);
      return q('SELECT * FROM exports WHERE name = ?').get(name);
    },
    requeueExport(id) {
      q(`UPDATE exports SET status = 'pending', error = NULL, progress = NULL, screenshot = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
    },
    updateExport(id, fields) {
      const keys = Object.keys(fields);
      q(`UPDATE exports SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), now(), id);
    },
    deleteExport(id) {
      q('DELETE FROM exports WHERE id = ?').run(id);
    },
    nextPendingExport() {
      return q(`SELECT * FROM exports WHERE status = 'pending' ORDER BY updated_at LIMIT 1`).get();
    },
    resetRunningExports() {
      q(`UPDATE exports SET status = 'failed', error = 'Interrompu (redémarrage du serveur)' WHERE status = 'running'`).run();
    },
    exportTargetPlaces(exp) {
      if (exp.country_code) return this.placesByCountry(exp.country_code);
      return this.getPlaces(JSON.parse(exp.place_ids || '[]'));
    },

    getSetting(key) {
      return q('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    },
    setSetting(key, value) {
      q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    },
  };
}
