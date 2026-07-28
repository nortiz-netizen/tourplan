/**
 * EXPLORADOR del backend Say Hueque (backend.sayhueque.com) — guia paso 4.
 * Loguea el robot (credenciales del .env: BACKEND_URL/USER/PASS) y CAPTURA las
 * pantallas (login + home) para poder codear la fase real de generar el link del
 * itinerario. NO genera nada todavia: solo mira y fotografia.
 *
 * Uso:  node src/backend-smoke.js
 * ⚠️ backend.sayhueque.com es PRODUCCION → solo login + navegacion + capturas.
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
dotenv.config();

const URL  = process.env.BACKEND_URL  || 'https://backend.sayhueque.com/login';
const USER = process.env.BACKEND_USER;
const PASS = process.env.BACKEND_PASS;

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(m);

async function captura(page, nombre) {
  const f = `capturas/${ts()}_backend_${nombre}.png`;
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  log(`  [captura] ${f}`);
}
async function volcar(page, nombre) {
  const els = await page.$$eval(
    'a, button, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], label, li',
    ns => ns.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 400)
      .map(n => ({
        tag: n.tagName.toLowerCase(),
        type: n.getAttribute('type') || undefined,
        texto: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
        placeholder: n.getAttribute('placeholder') || undefined,
        name: n.getAttribute('name') || undefined,
        id: n.getAttribute('id') || undefined,
        aria: n.getAttribute('aria-label') || undefined,
        clase: (typeof n.className === 'string') ? n.className.slice(0, 90) : undefined,
      }))
  ).catch(() => []);
  const f = `capturas/${ts()}_backend_elementos_${nombre}.json`;
  fs.writeFileSync(f, JSON.stringify(els, null, 1));
  log(`  [elementos] ${f} (${els.length})`);
}

async function main() {
  if (!URL || !USER || !PASS) { console.error('Faltan BACKEND_URL/USER/PASS en .env'); process.exit(1); }
  let browser;
  for (const ch of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, slowMo: 150, channel: ch }); log(`Navegador (${ch ?? 'chromium'})`); break; } catch { /* next */ }
  }
  if (!browser) { console.error('Sin navegador'); process.exit(1); }
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  try {
    log(`Abriendo ${URL} ...`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    // 1) LOGIN screen: fotografiar ANTES de tocar nada, para ver los campos reales.
    await captura(page, '01_login'); await volcar(page, 'login');

    // 2) Intento de login generico: primer input de texto/email = usuario, input password = clave.
    const userInput = page.locator('input[type="email"], input[type="text"], input:not([type])').first();
    const passInput = page.locator('input[type="password"]').first();
    if (await userInput.count().catch(() => 0) && await passInput.count().catch(() => 0)) {
      await userInput.click(); await userInput.fill(''); await userInput.pressSequentially(USER, { delay: 60 });
      await passInput.click(); await passInput.fill(''); await passInput.pressSequentially(PASS, { delay: 60 });
      await sleep(500);
      // Boton submit: por type o por texto tipico.
      const submit = page.locator('button[type="submit"], input[type="submit"]').first();
      if (await submit.count().catch(() => 0)) await submit.click().catch(() => {});
      else await page.getByRole('button', { name: /login|ingresar|entrar|iniciar|sign in|acceder/i }).first().click().catch(() => {});
      log('  Login enviado — esperando...');
      await sleep(4000);
      await captura(page, '02_post_login'); await volcar(page, 'post_login');
      const body = (await page.textContent('body').catch(() => '')) || '';
      log('  Texto post-login (primeros 300): ' + body.replace(/\s+/g, ' ').slice(0, 300));

      // 3) La home YA es la pantalla FIT (buscador Code/ID/Reference + Find).
      //    Probar si nuestra ref de test aparece en el backend: pegar en Reference + Find.
      const ref = process.argv[2] || '120177';
      const refInput = page.locator('input.form-control').nth(2); // orden: Code, ID, Reference, Search
      if (await refInput.count().catch(() => 0)) {
        await refInput.click(); await refInput.fill(''); await refInput.pressSequentially(ref, { delay: 60 });
        log(`  Reference = ${ref} → Find...`);
        await page.getByRole('button', { name: /^Find$/i }).first().click().catch(() => {});
        await sleep(4000);
        await captura(page, '03_find_result'); await volcar(page, 'find_result');
        const bodyFind = (await page.textContent('body').catch(() => '')) || '';
        log('  Texto tras Find (primeros 400): ' + bodyFind.replace(/\s+/g, ' ').slice(0, 400));
      } else {
        log('  ⚠ No encontre el campo Reference — ver 02_post_login + JSON.');
      }
    } else {
      log('  ⚠ No encontre inputs de login estandar — ver 01_login + JSON.');
    }
  } catch (e) {
    console.error('ERROR:', e.message.split('\n')[0]);
    await captura(page, '90_error'); await volcar(page, 'error');
  } finally {
    await sleep(1500);
    await browser.close();
  }
}
main();
