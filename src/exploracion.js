/**
 * PRUEBA 2 — Exploracion: login + paso 3.1 (menu → Bookings y cotizaciones → FITs).
 *
 * Ademas de navegar, VUELCA los elementos clickeables de cada pantalla a
 * capturas/elementos_*.json — con eso se escriben los selectores exactos de
 * las etapas 3.2 a 3.7 sin adivinar.
 *
 * Ejecutar:  npm run explorar
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
dotenv.config();

const URL  = process.env.TP_URL;
const USER = process.env.TP_USER;
const PASS = process.env.TP_PASS;

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function captura(page, nombre) {
  const file = `capturas/${ts()}_${nombre}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`  [captura] ${file}`);
}

/** Espera a que el overlay "PLEASE WAIT..." se vaya y la app quede quieta. */
async function esperarApp(page, maxMs = 60_000) {
  const inicio = Date.now();
  let quieto = 0;
  while (Date.now() - inicio < maxMs) {
    const spinners = await page.getByText(/please wait/i).count().catch(() => 0);
    if (spinners === 0) {
      quieto += 500;
      if (quieto >= 2000) return;   // 2s seguidos sin spinner = app lista
    } else {
      quieto = 0;
    }
    await sleep(500);
  }
  console.warn('  ⚠ La app siguio mostrando PLEASE WAIT tras el maximo de espera');
}

/** Vuelca los elementos interactivos visibles a un JSON para analisis. */
async function volcarElementos(page, nombre) {
  const els = await page.$$eval(
    'a, button, [role="button"], [role="menuitem"], [role="tab"], li, mat-icon, i[class], span[class*="icon"]',
    nodes => nodes
      .filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < 2000;
      })
      .slice(0, 400)
      .map(n => ({
        tag: n.tagName.toLowerCase(),
        texto: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        aria: n.getAttribute('aria-label') || undefined,
        title: n.getAttribute('title') || undefined,
        clase: (n.className && typeof n.className === 'string') ? n.className.slice(0, 120) : undefined,
        pos: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })(),
      }))
  ).catch(() => []);
  const file = `capturas/${ts()}_elementos_${nombre}.json`;
  fs.writeFileSync(file, JSON.stringify(els, null, 1));
  console.log(`  [elementos] ${file} (${els.length} elementos)`);
}

async function login(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await esperarApp(page);
  const userInput = page.getByPlaceholder('Username');
  const passInput = page.getByPlaceholder('Password');
  await userInput.waitFor({ state: 'visible', timeout: 15_000 });
  await userInput.click();
  await userInput.pressSequentially(USER, { delay: 60 });
  await passInput.click();
  await passInput.pressSequentially(PASS, { delay: 60 });
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.getByPlaceholder('Password').waitFor({ state: 'hidden', timeout: 20_000 });
  console.log('Login OK — esperando que cargue la app...');
  await esperarApp(page);
  await sleep(1500);
}

async function logout(page) {
  try {
    const candidatos = page.locator(
      'button:has-text("Logout"), a:has-text("Logout"), [aria-label*="logout" i], [title*="logout" i], button:has-text("Log out"), [aria-label*="salir" i]'
    ).first();
    if (await candidatos.count()) {
      await candidatos.click();
      await sleep(2000);
      console.log('Logout ejecutado');
    } else {
      console.warn('⚠ Boton de logout no encontrado aun — revisar el JSON de elementos para ubicarlo');
    }
  } catch (e) {
    console.warn('⚠ Logout fallo:', e.message.split('\n')[0]);
  }
  await captura(page, '99_post_logout');
}

async function main() {
  if (!URL || !USER || !PASS) {
    console.error('Faltan variables en .env'); process.exit(1);
  }
  let browser;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, slowMo: 150, channel }); break; }
    catch { /* siguiente */ }
  }
  if (!browser) { console.error('Sin navegador disponible'); process.exit(1); }

  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  // Popups JS (alert/confirm): aceptar siempre y dejar registro
  page.on('dialog', async d => { console.log(`  [dialog] ${d.type()}: ${d.message().slice(0, 120)}`); await d.accept().catch(() => {}); });

  let paginaActiva = page;
  try {
    await login(page);
    await captura(page, '05_home');
    await volcarElementos(page, 'home');

    // ---- Paso 3.1: menu superior izquierdo → Bookings y cotizaciones → FITs ----
    console.log('Buscando el menu superior izquierdo...');
    // Candidatos tipicos de hamburguesa/menu en la esquina superior izquierda
    const menuCandidatos = [
      page.locator('[aria-label*="menu" i]').first(),
      page.locator('button:has(mat-icon:text("menu"))').first(),
      page.locator('mat-icon:text("menu")').first(),
      page.locator('.hamburger, [class*="hamburger"], [class*="menu-toggle"], [class*="navbar-toggle"]').first(),
    ];
    let menuAbierto = false;
    for (const cand of menuCandidatos) {
      if (await cand.count().catch(() => 0)) {
        try {
          await cand.click({ timeout: 3000 });
          menuAbierto = true;
          console.log('  Menu clickeado');
          break;
        } catch { /* probar siguiente */ }
      }
    }
    await sleep(1000);
    await captura(page, '06_menu_abierto');
    await volcarElementos(page, 'menu');

    // "Bookings y cotizaciones" — texto exacto segun la guia (probamos variantes)
    const bookings = page.getByText(/bookings\s*(y|and)\s*(cotizaciones|quotes)/i).first();
    if (await bookings.count()) {
      await bookings.click({ timeout: 5000 });
      console.log('  Click en "Bookings y cotizaciones"');
      await sleep(1000);
      await captura(page, '07_bookings_abierto');
      await volcarElementos(page, 'bookings');
    } else {
      console.warn('  ⚠ No encontre "Bookings y cotizaciones" — revisar 06/JSON del menu');
    }

    // "FITs" — puede abrir pestana nueva: escuchar por si acaso
    const nuevaPagina = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    const fits = page.getByText(/^\s*FITs?\s*$/i).first();
    if (await fits.count()) {
      await fits.click({ timeout: 5000 });
      console.log('  Click en "FITs"');
      const maybeNueva = await nuevaPagina;
      if (maybeNueva) {
        paginaActiva = maybeNueva;
        await paginaActiva.waitForLoadState('domcontentloaded').catch(() => {});
        console.log('  FITs abrio una PESTANA NUEVA (dato clave para el flujo)');
      }
      await esperarApp(paginaActiva);
      await sleep(1500);
      await captura(paginaActiva, '08_fits');
      await volcarElementos(paginaActiva, 'fits');
    } else {
      console.warn('  ⚠ No encontre "FITs" — revisar capturas/JSON anteriores');
    }

    console.log('Exploracion completa.');
  } catch (e) {
    console.error('ERROR en exploracion:', e.message.split('\n')[0]);
    await captura(paginaActiva, '90_error');
  } finally {
    // Cerrar pestana de FITs si quedo abierta (regla de la guia) y logout SIEMPRE
    if (paginaActiva !== page && !paginaActiva.isClosed()) await paginaActiva.close().catch(() => {});
    if (!page.isClosed()) await logout(page);
    await browser.close();
  }
}

main();
