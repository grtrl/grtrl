import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { placeMapsUrl } from '../lib/mapsUrl.js';

// F7 — Export vers une vraie liste Google Maps.
// Google ne propose AUCUNE API pour créer une liste : ce module pilote Google Maps web
// avec Chromium (Playwright), connecté au compte Google dédié. C'est non autorisé par
// Google et fragile : les sélecteurs ci-dessous peuvent cesser de fonctionner si
// l'interface change. L'interface est forcée en anglais (hl=en) pour des libellés stables.

const SHARE_LINK_RE = /https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9]+/;

class StepError extends Error {
  constructor(step, cause) {
    super(`${step} : ${cause?.message?.split('\n')[0] || cause}`);
    this.step = step;
  }
}

async function step(name, fn) {
  try { return await fn(); } catch (e) { throw e instanceof StepError ? e : new StepError(name, e); }
}

async function firstVisible(page, locators, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const l of locators) {
      const loc = l.first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('élément introuvable');
}

async function dismissConsent(page) {
  const btn = page.getByRole('button', { name: /^(Accept all|Reject all|Tout accepter|Tout refuser)$/ });
  if (await btn.first().isVisible().catch(() => false)) await btn.first().click();
}

async function openSaveMenu(page, place) {
  await page.goto(placeMapsUrl(place, { hl: 'en' }), { waitUntil: 'domcontentloaded' });
  await dismissConsent(page);
  // Une recherche peut renvoyer plusieurs résultats : on ouvre le premier.
  const firstResult = page.locator('a.hfpxzc').first();
  if (await firstResult.isVisible({ timeout: 1500 }).catch(() => false)) await firstResult.click();
  const save = await firstVisible(page, [
    page.locator('button[data-value="Save"]'),
    page.getByRole('button', { name: /^(Save|Saved)\b/ }),
  ], 20000);
  await save.click();
  return firstVisible(page, [page.getByRole('menu'), page.getByRole('dialog')]);
}

function listItem(menu, listName) {
  const exact = new RegExp(`^\\s*${listName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return menu.getByRole('menuitemcheckbox', { name: exact })
    .or(menu.getByRole('menuitemradio', { name: exact }))
    .or(menu.getByRole('menuitem', { name: exact }));
}

// Ajoute (want=true) ou retire (want=false) un lieu de la liste. Crée la liste si besoin.
async function setMembership(page, place, listName, want) {
  const menu = await step(`Ouverture de « ${place.title} »`, () => openSaveMenu(page, place));
  const item = listItem(menu, listName).first();
  const exists = await item.isVisible({ timeout: 2000 }).catch(() => false);
  if (!exists) {
    if (!want) { await page.keyboard.press('Escape'); return; }
    await step('Création de la liste', async () => {
      await menu.getByRole('menuitem', { name: /New list/ }).or(menu.getByText(/^New list$/)).first().click();
      const input = await firstVisible(page, [
        page.getByRole('textbox', { name: /List name/i }),
        page.locator('input[aria-label*="List name" i]'),
        page.getByRole('dialog').getByRole('textbox'),
      ]);
      await input.fill(listName);
      await page.getByRole('button', { name: /^Create$/ }).first().click();
      await page.waitForTimeout(1500);
    });
    return;
  }
  const checked = (await item.getAttribute('aria-checked')) === 'true';
  if (checked !== want) {
    await step(`${want ? 'Ajout' : 'Retrait'} de « ${place.title} »`, async () => {
      await item.click();
      await page.waitForTimeout(800);
    });
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function readShareLink(page, listName) {
  return step('Récupération du lien de partage', async () => {
    await page.goto('https://www.google.com/maps/@46.6,2.4,6z/data=!4m2!10m1!1e1?hl=en', { waitUntil: 'domcontentloaded' });
    await dismissConsent(page);
    const savedTab = page.getByRole('button', { name: /^Saved$/ }).or(page.getByRole('tab', { name: /^Lists$/ }));
    if (await savedTab.first().isVisible({ timeout: 3000 }).catch(() => false)) await savedTab.first().click();
    const row = await firstVisible(page, [
      page.getByRole('button', { name: new RegExp(listName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }),
      page.getByText(listName, { exact: true }),
    ], 15000);
    await row.click();
    const share = await firstVisible(page, [
      page.getByRole('button', { name: /^Share/ }),
      page.locator('button[aria-label*="Share" i]'),
    ]);
    await share.click();
    const dialog = await firstVisible(page, [page.getByRole('dialog')]);
    // Active le partage par lien si un interrupteur est présent et désactivé.
    const toggle = dialog.getByRole('switch').or(dialog.getByRole('checkbox')).first();
    if (await toggle.isVisible({ timeout: 1500 }).catch(() => false) &&
        (await toggle.getAttribute('aria-checked')) === 'false') {
      await toggle.click();
      await page.waitForTimeout(1500);
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const inputs = await dialog.locator('input').evaluateAll((els) => els.map((e) => e.value));
      const text = (await dialog.innerText().catch(() => '')) + ' ' + inputs.join(' ');
      const m = text.match(SHARE_LINK_RE);
      if (m) return m[0];
      const copy = dialog.getByRole('button', { name: /Copy link/i });
      if (await copy.isVisible().catch(() => false)) {
        await copy.click();
        const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
        const c = clip.match(SHARE_LINK_RE);
        if (c) return c[0];
      }
      await page.waitForTimeout(500);
    }
    throw new Error('lien de partage non trouvé');
  });
}

export function createGoogleMapsDriver({ storageStatePath, screenshotDir, headless = true }) {
  return {
    name: 'google',
    isReady: () => existsSync(storageStatePath),
    async run({ listName, toAdd, toRemove, onProgress }) {
      if (!existsSync(storageStatePath)) {
        throw new Error("Compte Google dédié non connecté : importez la session dans Réglages.");
      }
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless, args: ['--disable-blink-features=AutomationControlled'] });
      const context = await browser.newContext({
        storageState: storageStatePath,
        locale: 'en-US',
        viewport: { width: 1280, height: 900 },
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      try {
        await step('Vérification de la connexion', async () => {
          await page.goto('https://www.google.com/maps?hl=en', { waitUntil: 'domcontentloaded' });
          await dismissConsent(page);
          const signIn = page.getByRole('link', { name: /^Sign in$/ }).or(page.getByRole('button', { name: /^Sign in$/ }));
          if (await signIn.first().isVisible({ timeout: 4000 }).catch(() => false)) {
            throw new Error('session expirée, reconnectez le compte dédié');
          }
        });
        const total = toAdd.length + toRemove.length;
        let done = 0;
        for (const p of toAdd) {
          onProgress?.(`Ajout ${++done}/${total} : ${p.title}`);
          await setMembership(page, p, listName, true);
        }
        for (const p of toRemove) {
          onProgress?.(`Retrait ${++done}/${total} : ${p.title}`);
          await setMembership(page, p, listName, false);
        }
        onProgress?.('Récupération du lien de partage…');
        const shareUrl = await readShareLink(page, listName);
        await context.storageState({ path: storageStatePath }); // garde la session à jour
        return { shareUrl };
      } catch (e) {
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true });
          const file = `export-${Date.now()}.png`;
          await page.screenshot({ path: join(screenshotDir, file) }).catch(() => {});
          e.screenshot = file;
        }
        throw e;
      } finally {
        await browser.close();
      }
    },
  };
}

// Pilote factice pour essayer l'app sans compte Google (EXPORT_DRIVER=mock).
export function createMockDriver({ delayMs = 300, fail = false } = {}) {
  return {
    name: 'mock',
    isReady: () => true,
    async run({ listName, toAdd, toRemove, onProgress }) {
      const all = [...toAdd, ...toRemove];
      for (let i = 0; i < all.length; i++) {
        onProgress?.(`${i < toAdd.length ? 'Ajout' : 'Retrait'} ${i + 1}/${all.length} : ${all[i].title}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (fail) throw new Error('Échec simulé');
      const slug = Buffer.from(listName).toString('base64url').slice(0, 12);
      return { shareUrl: `https://maps.app.goo.gl/mock${slug}` };
    },
  };
}
