// F9 — File d'exports : un export à la fois, statut en attente / en cours / réussi / échec.
export function startExportRunner(db, driver) {
  let running = false;

  async function runOne(exp) {
    const target = db.exportTargetPlaces(exp);
    const previous = new Set(JSON.parse(exp.exported_keys || '[]'));
    const targetKeys = new Set(target.map((p) => p.dedupe_key));
    const toAdd = target.filter((p) => !previous.has(p.dedupe_key));
    // Lieux à retirer : présents lors du dernier export mais plus dans la cible.
    const removedKeys = [...previous].filter((k) => !targetKeys.has(k));
    const toRemove = removedKeys.length
      ? db.raw.prepare(`SELECT * FROM places WHERE dedupe_key IN (${removedKeys.map(() => '?').join(',')})`).all(...removedKeys)
      : [];
    if (!target.length) throw new Error('Aucun lieu à exporter');
    db.updateExport(exp.id, { status: 'running', progress: 'Démarrage…', error: null });
    const { shareUrl } = await driver.run({
      listName: exp.name,
      toAdd,
      toRemove,
      onProgress: (msg) => db.updateExport(exp.id, { progress: msg }),
    });
    db.updateExport(exp.id, {
      status: 'success',
      share_url: shareUrl || exp.share_url,
      exported_keys: JSON.stringify([...targetKeys]),
      progress: `${target.length} lieu(x) dans la liste`,
      last_success_at: new Date().toISOString(),
    });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      let exp;
      while ((exp = db.nextPendingExport())) {
        try {
          await runOne(exp);
        } catch (e) {
          db.updateExport(exp.id, { status: 'failed', error: e.message, screenshot: e.screenshot ?? null });
        }
      }
    } finally {
      running = false;
    }
  }

  db.resetRunningExports();
  tick();
  return { poke: () => tick() };
}
