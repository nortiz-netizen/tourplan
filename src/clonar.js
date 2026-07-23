/**
 * ROBOT DE CLONACION COMPLETO — Tourplan V3 (guia Say Hueque)
 *
 * Ejecuta el flujo entero:
 *   login → FITs → nuevo booking → campos → habitaciones → guardar (captura REF)
 *   → itinerario → insertar file origen → reemplazar precios → ocultar precios
 *   → guardar → cerrar FITs → logout.
 * Incluye: protocolo de estacionalidad (7 intentos desplazando fecha),
 * freno de pasajeros de LUJO y aceptacion automatica de popups.
 *
 * Ejecutar:  npm run clonar
 * Config:    todo por .env (ver bloque CONFIG abajo)
 *
 * En cada fase guarda captura + volcado de elementos; si una pantalla no
 * coincide, el robot se detiene AHI con la foto exacta para ajustar el selector.
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';
import { aDDMMAA, calcularHabitaciones } from './mapeo.js';
dotenv.config();

// ------------------------------ CONFIG ------------------------------
/**
 * Los datos del booking pueden entrar de 3 formas (en orden de prioridad):
 *   1. Argumento:      node src/clonar.js --datos datos.json
 *   2. Variable:       TP_DATOS_JSON='{"paxNombre":"...", ...}'
 *   3. .env            (modo manual / pruebas)
 * Las formas 1 y 2 son las que usa el worker cuando Salesforce manda un lead.
 */
function cargarDatosExternos() {
  const i = process.argv.indexOf('--datos');
  if (i !== -1 && process.argv[i + 1]) {
    return JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  }
  if (process.env.TP_DATOS_JSON) return JSON.parse(process.env.TP_DATOS_JSON);
  return null;
}
const DATOS = cargarDatosExternos();
if (DATOS) console.log(`Datos recibidos desde Salesforce (Lead ${DATOS.leadId ?? 's/id'})`);

const CFG = {
  url:   process.env.TP_URL,
  user:  process.env.TP_USER,
  pass:  process.env.TP_PASS,
  // Datos del booking: primero lo que mande Salesforce, si no el .env
  leadId:      DATOS?.leadId      ?? null,
  paxNombre:   DATOS?.paxNombre   ?? process.env.TP_PAX_NOMBRE   ?? 'Prueba Robot',
  paxCantidad: DATOS?.paxCantidad ?? parseInt(process.env.TP_PAX_CANTIDAD || '2', 10),
  fechaViaje:  DATOS?.fechaViaje  ?? process.env.TP_FECHA_VIAJE  ?? '',   // ISO o DDMMAA
  alias:       DATOS?.alias       ?? process.env.TP_ALIAS        ?? 'wonderful trip for you',
  agencia:     DATOS?.agencia     ?? process.env.TP_AGENCIA      ?? '',
  depto:       DATOS?.depto       ?? process.env.TP_DEPTO        ?? '',
  division:    DATOS?.division    ?? process.env.TP_DIVISION     ?? 'WE',    // WE = Web
  moneda:      DATOS?.moneda      ?? process.env.TP_MONEDA       ?? 'USD',
  // File origen a clonar (viene de la consulta SQL) — SIN esto no hay paso 3.5
  fileOrigen:  DATOS?.fileOrigen  ?? process.env.TP_FILE_ORIGEN  ?? '',
  // Protocolo estacionalidad
  maxIntentos:        parseInt(process.env.TP_MAX_INTENTOS || '7', 10),
  desplazamientoDias: parseInt(process.env.TP_DESPLAZAMIENTO_DIAS || '1', 10),
  // Freno de lujo: lo decide el mapeo desde Salesforce, o se fuerza por .env
  lujo:       DATOS?.lujo ?? /^true|1|si$/i.test(process.env.TP_LUJO || ''),
  lujoMotivo: DATOS?.lujoMotivo ?? [],
  // Para el backend (guia 4) — se usa despues de clonar
  backendLink:   DATOS?.backendLink   ?? null,
  idiomaBackend: DATOS?.idiomaBackend ?? 'EN',
};
// --------------------------------------------------------------------

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(m);

async function captura(page, nombre) {
  const f = `capturas/${ts()}_${nombre}.png`;
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  log(`  [captura] ${f}`);
}

async function volcarElementos(page, nombre) {
  const els = await page.$$eval(
    'a, button, input, select, [role="button"], [role="menuitem"], [role="tab"], li, mat-icon',
    ns => ns.filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 500)
      .map(n => ({
        tag: n.tagName.toLowerCase(),
        texto: (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        placeholder: n.getAttribute('placeholder') || undefined,
        aria: n.getAttribute('aria-label') || undefined,
        title: n.getAttribute('title') || undefined,
        name: n.getAttribute('name') || undefined,
        clase: (typeof n.className === 'string') ? n.className.slice(0, 120) : undefined,
        pos: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })(),
      }))
  ).catch(() => []);
  const f = `capturas/${ts()}_elementos_${nombre}.json`;
  fs.writeFileSync(f, JSON.stringify(els, null, 1));
  log(`  [elementos] ${f} (${els.length})`);
}

async function esperarApp(page, maxMs = 60_000) {
  const inicio = Date.now();
  let quieto = 0;
  while (Date.now() - inicio < maxMs) {
    const n = await page.getByText(/please wait/i).count().catch(() => 0);
    if (n === 0) { quieto += 500; if (quieto >= 2000) return; }
    else quieto = 0;
    await sleep(500);
  }
}

/** Cierra modales genericos si aparecen (Aceptar / OK / Yes / Si / Continuar). */
async function cerrarModalSiAparece(page) {
  for (const txt of ['Aceptar', 'OK', 'Ok', 'Yes', 'Sí', 'Si', 'Continuar', 'Close', 'Cerrar']) {
    const b = page.getByRole('button', { name: txt }).first();
    if (await b.count().catch(() => 0)) {
      if (await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 2000 }).catch(() => {});
        log(`  [modal] cerrado con "${txt}"`);
        await sleep(500);
      }
    }
  }
}

/** Fecha del intento: si no hay fecha configurada, 30 dias adelante. */
const fechaIntento = (v, desplazar) => aDDMMAA(v || new Date(Date.now() + 30 * 86400_000), desplazar);

async function login(page) {
  await page.goto(CFG.url, { waitUntil: 'domcontentloaded' });
  await esperarApp(page);
  const u = page.getByPlaceholder('Username');
  const p = page.getByPlaceholder('Password');
  await u.waitFor({ state: 'visible', timeout: 15_000 });
  await u.click(); await u.pressSequentially(CFG.user, { delay: 60 });
  await p.click(); await p.pressSequentially(CFG.pass, { delay: 60 });
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Login' }).click();
  await p.waitFor({ state: 'hidden', timeout: 20_000 });
  await esperarApp(page); await sleep(1500);
  const body = (await page.textContent('body')) || '';
  if (/query mode|modo consulta/i.test(body)) throw new Error('QUERY MODE: hay otra sesion activa con este usuario');
  log('FASE 0 OK — sesion activa');
}

async function logout(page) {
  try {
    const cand = page.locator(
      'button:has-text("Logout"), a:has-text("Logout"), [aria-label*="logout" i], [title*="logout" i], [aria-label*="salir" i], button:has-text("Log out")'
    ).first();
    if (await cand.count()) { await cand.click({ timeout: 4000 }); await sleep(2000); log('Logout OK — licencia liberada'); }
    else { log('⚠ Logout no encontrado — revisar elementos_home.json'); await volcarElementos(page, 'sin_logout'); }
  } catch (e) { log('⚠ Logout fallo: ' + e.message.split('\n')[0]); }
  await captura(page, '99_post_logout');
}

// ------------------------- FASES DEL FLUJO -------------------------

async function faseNavegarFits(page, context) {
  // Menu superior izquierdo
  for (const sel of ['[aria-label*="menu" i]', 'button:has(mat-icon:text("menu"))', 'mat-icon:text("menu")', '[class*="hamburger"], [class*="menu-toggle"]']) {
    const c = page.locator(sel).first();
    if (await c.count().catch(() => 0)) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
  }
  await sleep(800);
  await captura(page, '10_menu'); await volcarElementos(page, 'menu');

  const bookings = page.getByText(/bookings\s*(y|and)\s*(cotizaciones|quotes)/i).first();
  if (!(await bookings.count())) throw new Error('No encontre "Bookings y cotizaciones" en el menu');
  await bookings.click(); await sleep(800);

  const nueva = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const fits = page.getByText(/^\s*FITs?\s*$/i).first();
  if (!(await fits.count())) throw new Error('No encontre "FITs"');
  await fits.click();
  const maybe = await nueva;
  const fitsPage = maybe || page;
  if (maybe) { await fitsPage.waitForLoadState('domcontentloaded').catch(() => {}); log('  FITs abrio pestana nueva'); }
  await esperarApp(fitsPage); await sleep(1200);
  await cerrarModalSiAparece(fitsPage);
  await captura(fitsPage, '11_fits'); await volcarElementos(fitsPage, 'fits');
  log('FASE 3.1 OK — en FITs');
  return fitsPage;
}

/** El modal "Crear Booking" ya esta abierto? (Tourplan a veces lo deja abierto) */
async function modalBookingAbierto(fp) {
  const t = fp.getByText('Crear Booking', { exact: false }).first();
  return (await t.count().catch(() => 0)) > 0 && await t.isVisible().catch(() => false);
}

async function faseNuevoBooking(fp) {
  if (await modalBookingAbierto(fp)) {
    log('  El modal "Crear Booking" ya estaba abierto — no hace falta insertarlo');
  } else {
    const btn = fp.getByRole('button', { name: /insertar nuevo booking/i }).first();
    if (!(await btn.count())) throw new Error('No encontre el boton "Insertar Nuevo Booking"');
    await btn.click(); await esperarApp(fp); await sleep(1200);
  }
  await captura(fp, '12_nuevo_booking'); await volcarElementos(fp, 'nuevo_booking');
  log('FASE 3.2 OK — ventana de nuevo booking');
}

async function tipear(fp, locator, valor) {
  await locator.click({ timeout: 8000 });
  await locator.press('Control+a').catch(() => {});
  await locator.pressSequentially(String(valor), { delay: 50 });
  await locator.press('Tab');   // blur: Angular registra el valor
}

/**
 * Busca el campo que esta a la derecha de una etiqueta (formularios en tabla).
 * Tourplan no asocia label↔input con for/id, asi que se ubica por POSICION:
 * mismo alto (±18px) y mas a la derecha que el texto.
 */
async function campoPorEtiqueta(fp, etiqueta) {
  const handle = await fp.evaluateHandle((txt) => {
    const norm = s => (s || '').trim().toUpperCase();
    const labels = [...document.querySelectorAll('label, span, div, td')]
      .filter(n => norm(n.textContent) === txt && n.getBoundingClientRect().width > 0);
    if (!labels.length) return null;
    const lr = labels[0].getBoundingClientRect();
    const campos = [...document.querySelectorAll('input, select')]
      .filter(n => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && Math.abs(r.top - lr.top) < 18 && r.left > lr.left;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return campos[0] || null;
  }, etiqueta.toUpperCase());
  const el = handle.asElement();
  return el || null;
}

/**
 * Selecciona un valor en un campo-lista de Tourplan (input con dropdown propio).
 * Se escribe el CODIGO (ej. "WE", "FI", "USD"): la lista salta a esa opcion.
 * Devuelve true si el campo quedo con un valor que contiene el codigo.
 */
async function seleccionarEnLista(fp, etiqueta, codigo) {
  const el = await campoPorEtiqueta(fp, etiqueta);
  if (!el) return false;
  // Confirmado = el campo muestra "CODIGO - Nombre". Si solo quedo el texto
  // tipeado (sin " - "), la opcion no se selecciono de verdad.
  const confirmado = async () => {
    const v = (await el.inputValue().catch(() => '')) || '';
    return v.includes(' - ') && v.toUpperCase().includes(String(codigo).toUpperCase());
  };
  try {
    await el.click();
    await sleep(300);
    await el.press('Control+a').catch(() => {});
    await el.type(String(codigo), { delay: 90 });   // la lista salta al codigo
    await sleep(700);
    // Tres formas de cerrar la seleccion: no todas funcionan en todos los campos
    for (const tecla of ['Enter', 'ArrowDown', 'Tab']) {
      if (await confirmado()) return true;
      await el.press(tecla).catch(() => {});
      await sleep(500);
      if (tecla === 'ArrowDown') { await el.press('Enter').catch(() => {}); await sleep(400); }
    }
    return await confirmado();
  } catch {
    return false;
  }
}

async function faseCamposIniciales(fp, fechaDDMMAA) {
  // Selectores REALES (clases semanticas de Tourplan, descubiertas en la corrida).
  // .last() porque el mismo class existe en el buscador de arriba; el del modal
  // aparece despues en el DOM.
  const nombre = fp.locator('input.tpdescription-bookingname').last();
  const alias  = fp.locator('input.tpdescription-bookingnamealias').last();
  const fecha  = fp.locator('input.tpdateinput.tpdate-bookingtraveldate').last();

  await tipear(fp, nombre, CFG.paxNombre);
  log(`  Nombre: ${CFG.paxNombre}`);
  await tipear(fp, alias, CFG.alias);
  log(`  Alias: ${CFG.alias}`);
  await tipear(fp, fecha, fechaDDMMAA);
  log(`  Fecha de viaje: ${fechaDDMMAA}`);

  // Campos de lista obligatorios (rojo). Sin los 4, GUARDAR queda deshabilitado.
  for (const [etiqueta, valor] of [
    ['MONEDA', CFG.moneda], ['DIVISIÓN', CFG.division],
    ['DEPARTAMENTO', CFG.depto], ['AGENCIA', CFG.agencia],
  ]) {
    if (!valor) { log(`  ⚠ ${etiqueta} sin configurar — el booking NO se va a poder guardar`); continue; }
    const ok = await seleccionarEnLista(fp, etiqueta, valor);
    log(`  ${etiqueta}: ${valor} ${ok ? '✓' : '⚠ no confirmado'}`);
  }

  await captura(fp, '13_campos');
  log('FASE 3.3 OK — campos completados');
}

async function faseHabitaciones(fp) {
  const pax = CFG.paxCantidad;
  const { dobles, singles } = calcularHabitaciones(pax);
  log(`  ${pax} pax → ${dobles} doble(s) + ${singles} single(s)`);

  // Tourplan ofrece configuraciones predefinidas por RADIO (names con UUID → ^=)
  const radios = {
    dosEnDoble: 'input[name^="TwoAdultsDouble"]',
    dosEnTwin:  'input[name^="TwoAdultsTwin"]',
    unoSencilla:'input[name^="OneAdultSingle"]',
    otra:       'input[name^="OtherConfig"]',
  };

  if (pax === 2) {
    await fp.locator(radios.dosEnDoble).first().check().catch(() => {});
    log('  Config: DOS ADULTOS EN DOBLE');
  } else if (pax === 1) {
    await fp.locator(radios.unoSencilla).first().check().catch(() => {});
    log('  Config: UN ADULTO EN UNA SENCILLA');
  } else {
    // Grupos: "OTRA CONFIGURACION" + cargar adultos segun la regla de la guia
    await fp.locator(radios.otra).first().check().catch(() => {});
    log('  Config: OTRA CONFIGURACION (grupo)');
    await sleep(800);
    const adultos = fp.locator('input.tpnumber-paxtypeadult').first();
    if (await adultos.count()) { await tipear(fp, adultos, pax); log(`  Adultos: ${pax}`); }
    await captura(fp, '14_config_habitaciones'); await volcarElementos(fp, 'habitaciones');
    log('  ⚠ Reparto en habitaciones dobles/single: verificar captura 14 (puede requerir ajuste fino)');
  }
  await sleep(600);
  await captura(fp, '14b_habitaciones');
  log('FASE 3.4 OK — habitaciones configuradas');
}

/** Lee la REF BOOKING que Tourplan asigna (campo readonly .tpcode1). */
async function capturarReferencia(fp) {
  const campo = fp.locator('input.tpcode1').last();
  if (await campo.count().catch(() => 0)) {
    const v = (await campo.inputValue().catch(() => '')).trim();
    if (v) { log(`  REF BOOKING: ${v}`); return v; }
  }
  const body = (await fp.textContent('body')) || '';
  const m = body.match(/\b\d{6,8}\b/);
  const ref = m ? m[0] : null;
  log(ref ? `  REF BOOKING (por texto): ${ref}` : '  ⚠ No pude leer la referencia');
  return ref;
}

async function faseGuardarBooking(fp) {
  const guardar = fp.getByRole('button', { name: /^guardar$/i }).first();
  if (!(await guardar.count())) throw new Error('No encontre el boton "Guardar" del modal');
  await guardar.click();
  await esperarApp(fp); await sleep(1500);
  await cerrarModalSiAparece(fp);
  await captura(fp, '15_booking_guardado'); await volcarElementos(fp, 'booking_guardado');
  log('  Booking guardado');
}

async function faseInsertarServicios(fp) {
  if (!CFG.fileOrigen) throw new Error('FALTA TP_FILE_ORIGEN en .env — el codigo del file a clonar (viene de la consulta SQL). Sin el no hay paso 3.5.');
  // Salir de la pantalla de insercion de linea (boton superior derecho)
  await cerrarModalSiAparece(fp);
  // Menu → Itinerario → "Insertar booking"
  const itin = fp.getByText(/^\s*Itinerario\s*$/i).first();
  if (await itin.count()) { await itin.click(); await sleep(1000); }
  await captura(fp, '16_itinerario'); await volcarElementos(fp, 'itinerario');
  const insertar = fp.getByText(/insertar\s+booking/i).last();
  if (!(await insertar.count())) throw new Error('No encontre "Insertar booking" en Itinerario');
  await insertar.click(); await sleep(1000);
  // Buscador: pegar el codigo del file origen
  const buscador = fp.locator('input:visible').last();
  await tipear(fp, buscador, CFG.fileOrigen);
  await fp.keyboard.press('Enter');
  await esperarApp(fp); await sleep(1500);
  await captura(fp, '17_resultados_busqueda'); await volcarElementos(fp, 'busqueda');
  // Primera coincidencia EXACTA
  const fila = fp.getByText(CFG.fileOrigen, { exact: false }).first();
  if (!(await fila.count())) throw new Error(`El file origen "${CFG.fileOrigen}" no aparece en los resultados`);
  await fila.click(); await sleep(800);
  log('FASE 3.5 hecha — file origen seleccionado');
}

async function faseReemplazarPrecios(fp) {
  // Al insertar, pregunta por precios → SIEMPRE "Reemplazar todos"
  const reemplazar = fp.getByText(/reemplazar\s+todos/i).first();
  if (await reemplazar.count()) { await reemplazar.click(); log('  "Reemplazar todos" clickeado'); }
  else log('  ⚠ No aparecio el dialogo "Reemplazar todos" (puede venir despues) — capturando');
  await esperarApp(fp); await sleep(1500);
  await captura(fp, '18_precios'); await volcarElementos(fp, 'precios');
  // Deteccion de error de disponibilidad (estacionalidad)
  const body = (await fp.textContent('body')) || '';
  if (/no\s+disponible|not\s+available|cerrad|closed|sin\s+disponibilidad/i.test(body)) {
    throw Object.assign(new Error('DISPONIBILIDAD: servicio estacional cerrado'), { estacional: true });
  }
  log('FASE 3.6a OK — precios reemplazados (quedan en 999)');
}

async function faseOcultarPrecios(fp) {
  // Zoom 75% (la guia lo exige para ver todos los controles)
  await fp.evaluate(() => { document.documentElement.style.zoom = '0.75'; }).catch(() => {});
  // Configuracion general → seccion "Analisis" → "Mostrar precios" = No
  const analisis = fp.getByText(/^\s*An[aá]lisis\s*$/i).first();
  if (await analisis.count()) { await analisis.click(); await sleep(1000); }
  await captura(fp, '19_analisis'); await volcarElementos(fp, 'analisis');
  const mostrar = fp.getByText(/mostrar\s+precios/i).first();
  if (await mostrar.count()) {
    // El control puede ser select o toggle — intento select "No", si no toggle click
    const sel = fp.getByLabel(/mostrar\s+precios/i).first();
    if (await sel.count().catch(() => 0)) await sel.selectOption({ label: 'No' }).catch(() => {});
    else await mostrar.click().catch(() => {});
    log('  "Mostrar precios" → No (verificar captura 19)');
  } else log('  ⚠ No encontre "Mostrar precios" — ver JSON 19');
  await fp.evaluate(() => { document.documentElement.style.zoom = '1'; }).catch(() => {});
  log('FASE 3.6b hecha');
}

async function faseGuardarYCerrar(fp, page, refAntes) {
  const guardar = fp.getByRole('button', { name: /guardar|save/i }).first();
  if (await guardar.count()) { await guardar.click(); await esperarApp(fp); await sleep(1200); await cerrarModalSiAparece(fp); }
  const refDespues = await capturarReferencia(fp);
  if (refAntes && refDespues && refAntes === refDespues) log('  Referencia verificada: ' + refDespues);
  await captura(fp, '20_final');
  // Cerrar pestana FITs (regla de licencias) — el cierre se hace desde la pestana de inicio
  if (fp !== page && !fp.isClosed()) await fp.close().catch(() => {});
  log('FASE 3.7 OK — FITs cerrado');
  return refDespues;
}

// ------------------------------ MAIN ------------------------------
async function main() {
  if (!CFG.url || !CFG.user || !CFG.pass) { console.error('Faltan credenciales en .env'); process.exit(1); }

  // FRENO DE LUJO (seccion 5 de la guia): lujo NO se cotiza automatico
  if (CFG.lujo) {
    log('🛑 PASAJERO DE LUJO detectado: NO se procesa cotizacion automatica.');
    if (CFG.lujoMotivo?.length) log(`   Palabras clave encontradas: ${CFG.lujoMotivo.join(', ')}`);
    log('   → Corresponde notificacion interna para supervision manual inmediata.');
    // Resultado legible por el worker para escribirlo de vuelta en Salesforce
    fs.writeFileSync('resultado.json', JSON.stringify({
      leadId: CFG.leadId, estado: 'LUJO_SIN_PROCESAR',
      motivo: `Palabras clave de lujo: ${(CFG.lujoMotivo || []).join(', ')}`,
    }, null, 1));
    process.exit(0);
  }

  let browser;
  for (const ch of ['chrome', 'msedge', undefined]) {
    try { browser = await chromium.launch({ headless: false, slowMo: 120, channel: ch }); break; } catch { /* sig */ }
  }
  if (!browser) { console.error('Sin navegador'); process.exit(1); }
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', async d => { log(`  [dialog] ${d.type()}: ${d.message().slice(0, 100)}`); await d.accept().catch(() => {}); });

  let fitsPage = page;
  try {
    await login(page);
    await captura(page, '09_home'); await volcarElementos(page, 'home');

    // Protocolo de estacionalidad: hasta N intentos desplazando la fecha
    let exito = false, refFinal = null;
    for (let intento = 1; intento <= CFG.maxIntentos && !exito; intento++) {
      const fecha = fechaIntento(CFG.fechaViaje, (intento - 1) * CFG.desplazamientoDias);
      log(`\n===== INTENTO ${intento}/${CFG.maxIntentos} — fecha ${fecha} =====`);
      try {
        fitsPage = await faseNavegarFits(page, context);
        await faseNuevoBooking(fitsPage);
        await faseCamposIniciales(fitsPage, fecha);
        await faseHabitaciones(fitsPage);
        const ref = await capturarReferencia(fitsPage);   // se asigna al abrir el modal
        await faseGuardarBooking(fitsPage);
        await faseInsertarServicios(fitsPage);
        await faseReemplazarPrecios(fitsPage);
        await faseOcultarPrecios(fitsPage);
        refFinal = await faseGuardarYCerrar(fitsPage, page, ref);
        exito = true;
      } catch (e) {
        if (e.estacional && intento < CFG.maxIntentos) {
          log(`  Estacionalidad detectada — reintento con fecha +${CFG.desplazamientoDias * intento} dia(s)`);
          if (fitsPage !== page && !fitsPage.isClosed()) await fitsPage.close().catch(() => {});
          continue;
        }
        throw e;
      }
    }

    if (exito) {
      log(`\n✅ CLONACION COMPLETA. Referencia nueva: ${refFinal ?? '(no detectada, ver capturas)'}`);
      log(`Siguiente paso (backend): pegar ${refFinal ?? 'la ref'} en backend.sayhueque.com → ${CFG.backendLink ?? 'SWEK/SAT'} → idioma ${CFG.idiomaBackend} → generar link.`);
      fs.writeFileSync('resultado.json', JSON.stringify({
        leadId: CFG.leadId, estado: 'OK', referencia: refFinal,
        backendLink: CFG.backendLink, idioma: CFG.idiomaBackend,
      }, null, 1));
    } else {
      log('\n🛑 Sin disponibilidad tras todos los intentos → protocolo "Taylor Made": abortar y derivar a venta especializada.');
      fs.writeFileSync('resultado.json', JSON.stringify({
        leadId: CFG.leadId, estado: 'SIN_DISPONIBILIDAD',
        motivo: `Sin disponibilidad tras ${CFG.maxIntentos} intentos desplazando fecha`,
      }, null, 1));
    }
  } catch (e) {
    console.error('\nERROR:', e.message.split('\n')[0]);
    const p = (fitsPage && !fitsPage.isClosed()) ? fitsPage : page;
    await captura(p, '90_error'); await volcarElementos(p, 'error');
    log('El robot se detuvo AQUI — la captura 90 + JSON muestran la pantalla exacta para ajustar el selector.');
    fs.writeFileSync('resultado.json', JSON.stringify({
      leadId: CFG.leadId, estado: 'ERROR', motivo: e.message.split('\n')[0],
    }, null, 1));
  } finally {
    if (fitsPage !== page && fitsPage && !fitsPage.isClosed()) await fitsPage.close().catch(() => {});
    if (!page.isClosed()) await logout(page);
    await browser.close();
  }
}

main();
