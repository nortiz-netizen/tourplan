/**
 * LISTAR FILES existentes en el sandbox de Tourplan.
 *
 * Para probar la clonacion (paso 3.5) necesitamos el codigo de un booking que
 * YA exista y tenga servicios cargados. Este script entra a FITs, mira la lista
 * de bookings y vuelca sus referencias, para elegir uno como file origen de
 * prueba (en produccion ese codigo lo entregara la consulta SQL).
 *
 * Ejecutar:  npm run listar-files
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
dotenv.config();

const { TP_URL: URL, TP_USER: USER, TP_PASS: PASS } = process.env;
const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function esperarApp(page, maxMs = 60_000) {
  const t0 = Date.now(); let quieto = 0;
  while (Date.now() - t0 < maxMs) {
    const n = await page.getByText(/please wait/i).count().catch(() => 0);
    if (n === 0) { quieto += 500; if (quieto >= 2000) return; } else quieto = 0;
    await sleep(500);
  }
}

async function login(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await esperarApp(page);
  const u = page.getByPlaceholder('Username'), p = page.getByPlaceholder('Password');
  await u.waitFor({ state: 'visible', timeout: 15_000 });
  await u.click(); await u.pressSequentially(USER, { delay: 60 });
  await p.click(); await p.pressSequentially(PASS, { delay: 60 });
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Login' }).click();
  await p.waitFor({ state: 'hidden', timeout: 20_000 });
  await esperarApp(page); await sleep(1500);
}

async function main() {
  let browser;
  for (const ch of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, slowMo: 120, channel: ch }); break; } catch {}
  }
  if (!browser) { console.error('Sin navegador'); process.exit(1); }
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  let fits = page;

  try {
    await login(page);
    console.log('Login OK');

    // Menu -> Bookings y cotizaciones -> FITs
    for (const sel of ['[aria-label*="menu" i]', 'mat-icon:text("menu")', '[class*="hamburger"]']) {
      const c = page.locator(sel).first();
      if (await c.count().catch(() => 0)) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
    }
    await sleep(800);
    const b = page.getByText(/bookings\s*(y|and)\s*(cotizaciones|quotes)/i).first();
    if (await b.count()) { await b.click(); await sleep(800); }
    const nueva = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    const f = page.getByText(/^\s*FITs?\s*$/i).first();
    if (await f.count()) { await f.click(); const n = await nueva; if (n) fits = n; }
    await esperarApp(fits); await sleep(1500);

    // Si abrio el modal "Crear Booking", salir para ver la LISTA
    const salir = fits.getByRole('button', { name: /^salir$/i }).first();
    if (await salir.count().catch(() => 0) && await salir.isVisible().catch(() => false)) {
      await salir.click().catch(() => {}); await sleep(1200);
    }
    await esperarApp(fits);

    // La pantalla NO lista sola: hay que buscar. El buscador NOMBRE es un input
    // con una lupa al lado. Se prueba: (1) lupa con vacio, (2) escribir "a" + lupa.
    async function buscar(termino) {
      const nombreInput = fits.locator('input:visible').first();
      if (termino) {
        await nombreInput.click().catch(() => {});
        await nombreInput.fill('').catch(() => {});
        await nombreInput.pressSequentially(termino, { delay: 60 }).catch(() => {});
      }
      // apretar Enter y tambien la lupa (el primer icono de busqueda visible)
      await nombreInput.press('Enter').catch(() => {});
      const lupa = fits.locator('[class*="search" i], [class*="lupa" i], mat-icon:text("search"), svg').first();
      if (await lupa.count().catch(() => 0)) await lupa.click({ timeout: 3000 }).catch(() => {});
      await esperarApp(fits); await sleep(2000);
    }

    console.log('Buscando (lupa con campo vacio)...');
    await buscar('');
    let hayResultados = await fits.evaluate(() => [...document.querySelectorAll('td, div, span')].some(n => /^\d{6,8}$/.test((n.textContent || '').trim())));
    if (!hayResultados) {
      console.log('Sin resultados con vacio. Probando con "a"...');
      await buscar('a');
    }

    await fits.screenshot({ path: `capturas/lista_files_${ts()}.png`, fullPage: true }).catch(() => {});
    await sleep(1000);
    const filas = await fits.evaluate(() => {
      const out = [];
      // buscar celdas/filas con patron de referencia (6+ digitos) + nombre cercano
      const nodos = [...document.querySelectorAll('td, div, span, a, li')];
      for (const n of nodos) {
        const t = (n.textContent || '').trim();
        if (/^\d{6,8}$/.test(t)) {
          const r = n.getBoundingClientRect();
          if (r.width <= 0) continue;
          // nombre = texto a la derecha, misma fila
          const enFila = nodos.filter(m => {
            const mr = m.getBoundingClientRect();
            return mr.width > 0 && Math.abs(mr.top - r.top) < 14 && mr.left > r.left
              && (m.textContent || '').trim().length > 2;
          }).sort((a, c) => a.getBoundingClientRect().left - c.getBoundingClientRect().left);
          const nombre = enFila.length ? (enFila[0].textContent || '').trim().slice(0, 50) : '';
          out.push({ ref: t, nombre });
        }
      }
      // unicos por ref
      const vistos = new Set();
      return out.filter(o => !vistos.has(o.ref) && vistos.add(o.ref));
    });

    fs.writeFileSync('capturas/files-existentes.json', JSON.stringify(filas, null, 1));
    console.log(`\n=== ${filas.length} referencia(s) encontrada(s) en la lista ===`);
    filas.slice(0, 40).forEach(o => console.log(`   ${o.ref}   ${o.nombre}`));
    if (!filas.length) {
      console.log('   (ninguna en la vista actual — puede requerir buscar o hacer scroll)');
      console.log('   Revisa la captura capturas/lista_files_*.png');
    } else {
      console.log('\nElegi una CON servicios cargados y ponela en .env como TP_FILE_ORIGEN.');
    }
    await sleep(2000);
  } catch (e) {
    console.error('ERROR:', e.message.split('\n')[0]);
    await fits.screenshot({ path: `capturas/lista_error_${ts()}.png`, fullPage: true }).catch(() => {});
  } finally {
    if (fits !== page && !fits.isClosed()) await fits.close().catch(() => {});
    const lo = page.locator('button:has-text("Logout"), a:has-text("Logout"), [aria-label*="logout" i]').first();
    if (await lo.count().catch(() => 0)) await lo.click().catch(() => {});
    await sleep(1500);
    await browser.close();
  }
}

main();
