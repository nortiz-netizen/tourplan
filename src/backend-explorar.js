/**
 * EXPLORADOR DEL BACKEND — Say Hueque (paso 4 de la guia).
 *
 * El backend genera el LINK del itinerario a partir de la referencia que el
 * robot creo en Tourplan. Este script es de DESCUBRIMIENTO: entra, hace login,
 * busca la seccion "FITs" y fotografia cada pantalla + vuelca sus elementos,
 * para poder escribir despues el flujo real (pegar ref -> SWEK/SAT -> idioma
 * -> generar link).
 *
 * Ejecutar:  npm run backend-explorar
 * Config:    BACKEND_URL / BACKEND_USER / BACKEND_PASS en .env
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
dotenv.config();

const URL  = process.env.BACKEND_URL;
const USER = process.env.BACKEND_USER;
const PASS = process.env.BACKEND_PASS;

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function captura(page, nombre) {
  const f = `capturas/backend_${ts()}_${nombre}.png`;
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  console.log(`  [captura] ${f}`);
}

async function volcarElementos(page, nombre) {
  const els = await page.$$eval(
    'a, button, input, select, [role="button"], [role="menuitem"], [role="tab"], li, nav *',
    ns => ns.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 400)
      .map(n => ({
        tag: n.tagName.toLowerCase(),
        texto: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        placeholder: n.getAttribute('placeholder') || undefined,
        name: n.getAttribute('name') || undefined,
        type: n.getAttribute('type') || undefined,
        href: n.getAttribute('href') || undefined,
        clase: (typeof n.className === 'string') ? n.className.slice(0, 80) : undefined,
        pos: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })(),
      }))
  ).catch(() => []);
  const f = `capturas/backend_${ts()}_elementos_${nombre}.json`;
  fs.writeFileSync(f, JSON.stringify(els, null, 1));
  console.log(`  [elementos] ${f} (${els.length})`);
}

async function main() {
  if (!URL || !USER || !PASS) { console.error('Faltan BACKEND_* en .env'); process.exit(1); }
  let browser;
  for (const ch of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, slowMo: 150, channel: ch }); break; } catch {}
  }
  if (!browser) { console.error('Sin navegador'); process.exit(1); }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', async d => { console.log(`  [dialog] ${d.message().slice(0, 80)}`); await d.accept().catch(() => {}); });

  try {
    console.log('1) Abriendo el backend...');
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    await captura(page, '01_login');
    await volcarElementos(page, 'login');

    // Login: patrones tipicos (el backend NO es Tourplan, puede ser cualquier stack)
    console.log('2) Intentando login...');
    const userCand = page.locator(
      'input[name*="user" i], input[name*="email" i], input[type="email"], input[type="text"]:not([type="hidden"])'
    ).first();
    const passCand = page.locator('input[type="password"]').first();
    if (await userCand.count() && await passCand.count()) {
      await userCand.click(); await userCand.fill(USER);
      await passCand.click(); await passCand.fill(PASS);
      await captura(page, '02_credenciales');
      const btn = page.locator(
        'button[type="submit"], input[type="submit"], button:has-text("Log"), button:has-text("Ingresar"), button:has-text("Entrar"), button:has-text("Sign")'
      ).first();
      if (await btn.count()) await btn.click();
      else await passCand.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await sleep(3000);
    } else {
      console.log('  ⚠ No ubique el form de login con los patrones tipicos — revisar captura 01');
    }
    await captura(page, '03_post_login');
    await volcarElementos(page, 'post_login');

    // Buscar la seccion "FITs"
    console.log('3) Buscando la seccion FITs...');
    const fits = page.getByText(/^\s*FITs?\s*$/i).first();
    if (await fits.count()) {
      await fits.click().catch(() => {});
      await sleep(2500);
      await captura(page, '04_fits');
      await volcarElementos(page, 'fits');
      console.log('  Seccion FITs abierta');
    } else {
      console.log('  ⚠ No encontre "FITs" a la primera — ver capturas para ubicar el menu');
    }

    console.log('\nExploracion del backend lista. Revisa capturas/backend_*.png');
    console.log('Con esas pantallas escribo: pegar ref -> elegir SWEK/SAT -> idioma -> generar link.');
    await sleep(1500);
  } catch (e) {
    console.error('ERROR:', e.message.split('\n')[0]);
    await captura(page, '90_error');
  } finally {
    await browser.close();
  }
}

main();
