// À lancer UNE FOIS sur un ordinateur (pas sur le serveur) :
//   npm run google:login
// Une fenêtre Chromium s'ouvre : connectez-vous au compte Google DÉDIÉ à l'app,
// puis revenez dans le terminal et appuyez sur Entrée. Le fichier google-session.json
// produit est à importer dans l'app (Réglages › Compte Google dédié).
// Ce fichier donne accès au compte : ne le partagez pas.
import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';

const out = process.argv[2] || 'google-session.json';
const launch = async (opts) => chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'], ...opts });
// Le Chrome installé est moins souvent bloqué par Google que Chromium.
const browser = await launch({ channel: 'chrome' }).catch(() => launch({}));
const context = await browser.newContext({ locale: 'en-US' });
const page = await context.newPage();
await page.goto('https://accounts.google.com/ServiceLogin?continue=https://www.google.com/maps');

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Connectez-vous au compte dédié dans la fenêtre, puis appuyez sur Entrée ici… ');
rl.close();
await page.goto('https://www.google.com/maps?hl=en');
await page.waitForTimeout(3000);
await context.storageState({ path: out });
await browser.close();
console.log(`Session enregistrée dans ${out}. Importez-la dans l'app : Réglages › Compte Google dédié.`);
