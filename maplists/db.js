// Base SQLite (module natif node:sqlite, aucune dépendance native à compiler).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'maplists.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  gmaps_url   TEXT NOT NULL DEFAULT '',          -- lien de partage Google Maps (maps.app.goo.gl/…)
  visibility  TEXT NOT NULL DEFAULT 'private',   -- private | friends | selected
  color       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'takeout',   -- takeout | manual
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS places (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id         INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  gmaps_url       TEXT NOT NULL DEFAULT '',
  takeout_note    TEXT NOT NULL DEFAULT '',
  takeout_comment TEXT NOT NULL DEFAULT '',
  takeout_tags    TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',       -- ta note perso (éditée dans le site)
  tags            TEXT NOT NULL DEFAULT '',       -- tags perso, séparés par des virgules
  rating          INTEGER NOT NULL DEFAULT 0,     -- 0..5
  visited         INTEGER NOT NULL DEFAULT 0,
  address         TEXT NOT NULL DEFAULT '',
  lat             REAL,
  lng             REAL,
  geo_status      TEXT NOT NULL DEFAULT 'pending', -- pending | ok | approx | failed | manual
  geo_source      TEXT NOT NULL DEFAULT '',
  geo_attempts    INTEGER NOT NULL DEFAULT 0,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_places_list ON places(list_id);
CREATE INDEX IF NOT EXISTS idx_places_geo ON places(geo_status);

CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_friends (
  list_id   INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, friend_id)
);
`);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, getSetting, setSetting, transaction, DATA_DIR };
