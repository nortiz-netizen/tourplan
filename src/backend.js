/**
 * FASE BACKEND (guia paso 4) — genera el link del itinerario en backend.sayhueque.com
 * a partir de la REFERENCIA de la reserva que creo el scraper en Tourplan.
 *
 * Handoff:  Tourplan crea la reserva → REFERENCIA → aca se pega en el backend →
 *           se elige sitio (sayhueque=SWEK / saysouthamerica=SAT) + idioma → link.
 *
 * ✅ MAPEADO (probado en la exploracion): login, campo Reference, boton Find.
 * ⚠️ HIPOTESIS (falta 1 corrida con ref REAL para confirmar): lo que aparece
 *    despues de Find — elegir sitio/idioma, generar y extraer el link. Los selectores
 *    de esa parte son best-guess + captura; se ajustan apenas tengamos una ref real.
 *
 * Uso standalone (para probar cuando haya ref):
 *    node src/backend.js <referencia> [sayhueque|saysouthamerica] [EN|ES|DE|IT]
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
  const els = await page.$$eval('a, button, input, select, textarea, label, li, [role="button"]',
    ns => ns.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 400)
      .map(n => ({ tag: n.tagName.toLowerCase(), type: n.getAttribute('type') || undefined,
        texto: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
        href: n.getAttribute('href') || undefined, clase: (typeof n.className === 'string') ? n.className.slice(0, 90) : undefined }))
  ).catch(() => []);
  fs.writeFileSync(`capturas/${ts()}_backend_elementos_${nombre}.json`, JSON.stringify(els, null, 1));
  log(`  [elementos] backend_${nombre} (${els.length})`);
}

/** SWEK (directos) → sitio "sayhueque"; SAT (South American Travel) → "saysouthamerica". */
export function siteDesdeBackendLink(backendLink) {
  const v = (backendLink || '').toUpperCase();
  if (v === 'SAT') return 'saysouthamerica';
  return 'sayhueque';   // SWEK / Say Hueque / Argentina Pura / default
}

/**
 * Loguea en el backend y genera el link del itinerario para una referencia.
 * Recibe un `browser` de Playwright ya abierto (lo reusa el scraper) para no
 * levantar otro. Devuelve { estado, link, motivo }.
 */
export async function generarLink(browser, { referencia, site = 'sayhueque', idioma = 'EN' }) {
  if (!referencia) return { estado: 'ERROR', motivo: 'Sin referencia para el backend' };
  if (!URL || !USER || !PASS) return { estado: 'ERROR', motivo: 'Faltan BACKEND_URL/USER/PASS en .env' };

  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  try {
    // ---- LOGIN (✅ mapeado) ----
    await page.goto(URL, { waitUntil: 'domcontentloaded' }); await sleep(2500);
    const userInput = page.locator('input[type="email"], input[type="text"], input:not([type])').first();
    const passInput = page.locator('input[type="password"]').first();
    await userInput.click(); await userInput.fill(''); await userInput.pressSequentially(USER, { delay: 60 });
    await passInput.click(); await passInput.fill(''); await passInput.pressSequentially(PASS, { delay: 60 });
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    if (await submit.count().catch(() => 0)) await submit.click().catch(() => {});
    else await page.getByRole('button', { name: /login|ingresar|entrar|iniciar|sign in|acceder/i }).first().click().catch(() => {});
    await sleep(4000);
    await captura(page, 'bk01_home');

    // ---- PEGAR REFERENCIA + FIND (✅ mapeado: 3er form-control = Reference) ----
    const refInput = page.locator('input.form-control').nth(2);
    if (!(await refInput.count().catch(() => 0))) return { estado: 'ERROR', motivo: 'No encontre el campo Reference en el backend' };
    await refInput.click(); await refInput.fill(''); await refInput.pressSequentially(String(referencia), { delay: 60 });
    await page.getByRole('button', { name: /^Find$/i }).first().click().catch(() => {});
    await sleep(4000);
    await captura(page, 'bk02_find'); await volcar(page, 'find');

    // ---- ELEGIR SITIO + IDIOMA ----
    // Son pestanias que RE-RENDERIZAN la fila de resultado con otra URL (el mismo
    // file sale como yourtrip/…/testing y con Lang=EN|ES|DE|IT segun lo elegido).
    // Por eso se clickean ANTES de extraer y se espera a que la tabla se rearme.
    await page.getByText(new RegExp('^\\s*' + site + '\\s*$', 'i')).first().click().catch(() => {});
    await sleep(1200);
    await page.getByText(new RegExp('^\\s*' + idioma + '\\s*$', 'i')).first().click().catch(() => {});
    await sleep(2000);
    await captura(page, 'bk03_opciones'); await volcar(page, 'opciones');

    // NO se clickea ningun boton de "generar": el backend no tiene tal paso. Despues
    // del Find la tabla YA trae la URL en su columna. El codigo viejo buscaba un boton
    // con /generate|link|view/i y en esa tabla lo unico que matchea es el "Copy"/"View"
    // de la fila — clickearlo navegaba a otra pagina y se perdia el resultado. Ese era
    // el motivo por el que el link volvia vacio.
    await captura(page, 'bk04_link'); await volcar(page, 'link');

    // ---- EXTRAER EL LINK ----
    // Se busca el href que contenga la REFERENCIA que pedimos (Code=WEFI…). Anclar en
    // la referencia es lo unico seguro: si la tabla trae varias filas, o quedo el
    // resultado de una busqueda anterior, el "primer link que parezca de itinerario"
    // puede ser el de OTRO pasajero, y mandarle a un cliente el viaje de otro es peor
    // que no mandarle nada.
    const ref = String(referencia);
    const link = await page.evaluate((ref) => {
      const urls = [];
      for (const a of document.querySelectorAll('a[href^="http"]')) urls.push(a.href);
      for (const i of document.querySelectorAll('input, textarea')) {
        const v = i.value || ''; if (/^https?:\/\//.test(v)) urls.push(v);
      }
      // 1) el que trae nuestra referencia en el query string
      const exacto = urls.find(u => new RegExp('[?&]Code=' + ref + '(&|$)', 'i').test(u));
      if (exacto) return exacto;
      // 2) el que la trae en cualquier parte de la URL
      return urls.find(u => u.toUpperCase().includes(ref.toUpperCase())) || null;
    }, ref).catch(() => null);

    if (link) { log(`  ✅ Link generado: ${link}`); return { estado: 'OK', link }; }

    // FALLBACK DEMO (solo con TP_SKIP_35): no hay reserva real en el backend, asi que
    // no hay link de itinerario. Para poder MOSTRAR el flujo completo (que el campo de
    // SF se llena), se usa la URL del backend como placeholder. NO es un itinerario real.
    const demo = /^(true|1|si)$/i.test(process.env.TP_SKIP_35 || '');
    if (demo) {
      const urlActual = page.url();
      log(`  ⚠ Sin link real (ref sin reserva). Fallback DEMO → ${urlActual}`);
      return { estado: 'OK', link: urlActual, motivo: 'DEMO/sandbox: sin reserva real en el backend; placeholder = URL del backend, NO es el link de itinerario real' };
    }
    // Sin link NO se inventa uno. El ID interno del backend (?ID=28114) no se puede
    // derivar de la referencia: aunque en las corridas viejas la diferencia diera
    // constante, basta que el backend saltee un numero para que el link apunte al
    // itinerario de otro pasajero.
    return {
      estado: 'SIN_LINK',
      motivo: `El backend no devolvio ninguna URL con la referencia ${ref} tras el Find. ` +
              `Revisar capturas bk02_find y bk04_link: puede que la referencia todavia no ` +
              `este publicada en el sitio "${site}", o que el Find no haya traido resultados.`
    };
  } catch (e) {
    await captura(page, '90_error').catch(() => {});
    return { estado: 'ERROR', motivo: String(e.message).split('\n')[0] };
  } finally {
    await context.close().catch(() => {});
  }
}

// -------- Modo standalone: node src/backend.js <ref> [site] [idioma] --------
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('backend.js')) {
  const referencia = process.argv[2];
  const site = process.argv[3] || 'sayhueque';
  const idioma = process.argv[4] || 'EN';
  if (!referencia) { console.error('Uso: node src/backend.js <referencia> [sayhueque|saysouthamerica] [EN|ES|DE|IT]'); process.exit(1); }
  const browser = await chromium.launch({ headless: false, slowMo: 150, channel: 'chrome' }).catch(() => chromium.launch({ headless: false }));
  const r = await generarLink(browser, { referencia, site, idioma });
  console.log('RESULTADO:', JSON.stringify(r));
  await browser.close();
}
