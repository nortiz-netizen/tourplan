/**
 * DESCUBRIR OPCIONES de los campos obligatorios del booking.
 *
 * AGENCIA, MONEDA, DIVISION y DEPARTAMENTO son obligatorios (rojo) y sin ellos
 * no se habilita GUARDAR. Este script abre el modal y vuelca TODAS las opciones
 * de cada uno, para poder elegir los codigos correctos y ponerlos en el .env.
 *
 * Ejecutar:  npm run opciones
 * Resultado: capturas/opciones-campos.json  (+ lo imprime en consola)
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
dotenv.config();

const { TP_URL: URL, TP_USER: USER, TP_PASS: PASS } = process.env;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ETIQUETAS = ['AGENCIA', 'MONEDA', 'SUBTIPO DE MONEDA', 'DIVISIÓN', 'DIVISION', 'DEPARTAMENTO', 'ESTADO DE BOOKING'];

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

    // Ir a FITs
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

    // Asegurar el modal abierto
    const abierto = await fits.getByText('Crear Booking', { exact: false }).first().isVisible().catch(() => false);
    if (!abierto) {
      const ins = fits.getByRole('button', { name: /insertar nuevo booking/i }).first();
      if (await ins.count()) { await ins.click(); await esperarApp(fits); await sleep(1500); }
    }
    console.log('Modal "Crear Booking" listo. Inspeccionando campos...\n');

    // Para cada etiqueta: ubicar el control a su derecha y volcar sus opciones
    const resultado = await fits.evaluate((etiquetas) => {
      const norm = s => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
      const out = {};
      for (const et of etiquetas) {
        const labels = [...document.querySelectorAll('label, span, div, td')]
          .filter(n => norm(n.textContent) === et && n.getBoundingClientRect().width > 0);
        if (!labels.length) continue;
        const lr = labels[0].getBoundingClientRect();
        const campos = [...document.querySelectorAll('input, select')]
          .filter(n => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && Math.abs(r.top - lr.top) < 20 && r.left > lr.left;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        if (!campos.length) { out[et] = { encontrado: false }; continue; }
        const c = campos[0];
        const info = {
          encontrado: true,
          tag: c.tagName.toLowerCase(),
          clase: (typeof c.className === 'string' ? c.className : '').slice(0, 120),
          valorActual: c.value ?? null,
          requerido: /tpinvalid|invalid|required/i.test(c.className || '') || c.getAttribute('title') === 'Requerido!',
        };
        if (c.tagName.toLowerCase() === 'select') {
          info.opciones = [...c.options].map(o => ({ value: o.value, label: o.textContent.trim() }));
        } else {
          // input con dropdown custom: buscar un <select> hermano/cercano
          const cerca = [...document.querySelectorAll('select')].filter(s => {
            const r = s.getBoundingClientRect();
            return Math.abs(r.top - lr.top) < 20;
          });
          if (cerca.length) info.opciones = [...cerca[0].options].map(o => ({ value: o.value, label: o.textContent.trim() }));
        }
        out[et] = info;
      }
      return out;
    }, ETIQUETAS);

    // Los campos NO son <select> nativos: son inputs con dropdown propio de
    // Angular. Las opciones solo existen en el DOM cuando el campo esta ABIERTO,
    // asi que hay que clickear cada uno y capturar lo que aparece.
    const desplegables = {};
    for (const et of ['MONEDA', 'DIVISIÓN', 'DEPARTAMENTO', 'AGENCIA']) {
      const info = resultado[et];
      if (!info?.encontrado) continue;
      console.log(`\n--- abriendo ${et} ---`);
      try {
        const el = await fits.evaluateHandle((etq) => {
          const norm = s => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
          const lbl = [...document.querySelectorAll('label, span, div, td')]
            .find(n => norm(n.textContent) === etq && n.getBoundingClientRect().width > 0);
          if (!lbl) return null;
          const lr = lbl.getBoundingClientRect();
          return [...document.querySelectorAll('input')]
            .filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && Math.abs(r.top - lr.top) < 20 && r.left > lr.left; })
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null;
        }, et);
        const campo = el.asElement();
        if (!campo) { console.log('   no lo pude tomar'); continue; }

        // Fotografiar los textos visibles ANTES de abrir: lo que aparezca despues
        // y no estuviera antes, son las opciones. Mas robusto que adivinar el
        // selector o la region.
        const textosAntes = await fits.$$eval('*', ns => {
          const s = new Set();
          for (const n of ns) {
            const r = n.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.height > 50) continue;
            if ([...n.children].some(h => (h.textContent || '').trim())) continue;
            const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
            if (t && t.length < 60) s.add(t);
          }
          return [...s];
        });

        await campo.click();
        await sleep(400);
        await campo.press('ArrowDown').catch(() => {});   // muchos dropdowns abren con flecha
        await sleep(1200);

        // El panel de opciones se renderiza JUSTO DEBAJO del campo. En vez de
        // adivinar el selector (los labels del form ensucian todo), se capturan
        // los elementos-hoja dentro de esa region geometrica.
        // Screenshot con el dropdown ABIERTO (evidencia visual)
        await fits.screenshot({ path: `capturas/dropdown_${et.replace(/[^A-ZÁÉÍÓÚÑ]/gi, '')}.png`, fullPage: true }).catch(() => {});

        // Lo nuevo respecto de "antes" = las opciones del dropdown, agrupadas por fila
        const opciones = await fits.evaluate((antes) => {
          const set = new Set(antes);
          const nuevos = [];
          for (const n of document.querySelectorAll('*')) {
            const r = n.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.height > 50) continue;
            if ([...n.children].some(h => (h.textContent || '').trim())) continue;
            const t = (n.textContent || '').trim().replace(/\s+/g, ' ');
            if (!t || t.length >= 60 || set.has(t)) continue;
            nuevos.push({ t, x: Math.round(r.x), y: Math.round(r.y) });
          }
          const filas = {};
          for (const o of nuevos) { const k = Math.round(o.y / 6); (filas[k] ||= []).push(o); }
          return Object.values(filas)
            .sort((a, b) => a[0].y - b[0].y)
            .map(f => f.sort((a, b) => a.x - b.x).map(o => o.t).join('  '))
            .filter(Boolean);
        }, textosAntes);

        const unicas = [...new Set(opciones)];
        desplegables[et] = unicas;
        console.log(`   ${unicas.length} opcion(es):`);
        unicas.slice(0, 60).forEach(o => console.log(`     • ${o}`));
        if (unicas.length > 60) console.log(`     ... y ${unicas.length - 60} mas (ver JSON)`);

        // NO usar Escape: cierra el modal "Crear Booking" entero. El click en el
        // proximo campo cierra este dropdown solo.
        await sleep(300);
      } catch (e) {
        console.log('   error:', e.message.split('\n')[0]);
      }
    }

    const salida = { porEtiqueta: resultado, desplegables };
    fs.writeFileSync('capturas/opciones-campos.json', JSON.stringify(salida, null, 1));

    for (const [et, info] of Object.entries(resultado)) {
      if (!info.encontrado) { console.log(`❌ ${et}: no ubicado`); continue; }
      console.log(`\n=== ${et} === (${info.tag}${info.requerido ? ', REQUERIDO' : ''}) valor="${info.valorActual}"`);
      if (info.opciones?.length) {
        info.opciones.slice(0, 30).forEach(o => console.log(`   ${o.value || '(vacio)'} → ${o.label}`));
        if (info.opciones.length > 30) console.log(`   ... y ${info.opciones.length - 30} mas`);
      } else {
        console.log('   (sin opciones detectadas — es un input con buscador propio)');
      }
    }
    console.log('\nDetalle completo en capturas/opciones-campos.json');
    console.log('Screenshots de cada dropdown abierto: capturas/dropdown_*.png');
    await fits.screenshot({ path: 'capturas/opciones_modal.png', fullPage: true }).catch(() => {});
  } catch (e) {
    console.error('ERROR:', e.message.split('\n')[0]);
    await fits.screenshot({ path: 'capturas/opciones_error.png', fullPage: true }).catch(() => {});
  } finally {
    // Salir del modal sin guardar (no queremos crear bookings basura)
    const salir = fits.getByRole('button', { name: /^salir$/i }).first();
    if (await salir.count().catch(() => 0)) await salir.click().catch(() => {});
    await sleep(1000);
    if (fits !== page && !fits.isClosed()) await fits.close().catch(() => {});
    const lo = page.locator('button:has-text("Logout"), a:has-text("Logout"), [aria-label*="logout" i]').first();
    if (await lo.count().catch(() => 0)) await lo.click().catch(() => {});
    await sleep(1500);
    await browser.close();
  }
}

main();
