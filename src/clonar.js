/**
 * ROBOT DE CLONACION COMPLETO — Tourplan V4 (guia Say Hueque)
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
import { generarLink, siteDesdeBackendLink } from './backend.js';
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

/**
 * Primer valor "con contenido". OJO: `??` solo cae al fallback con null/undefined,
 * NO con string vacio. El JSON de Salesforce manda campos como agencia:"" cuando el
 * dato no aplica, y eso pisaba el fallback del .env (el booking no se podia guardar).
 * `primero()` trata ""/espacios como ausencia y sigue al proximo fallback.
 */
const primero = (...vals) => {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};

const CFG = {
  url:   process.env.TP_URL,
  user:  process.env.TP_USER,
  pass:  process.env.TP_PASS,
  // Datos del booking: primero lo que mande Salesforce, si no el .env (primer no-vacio)
  leadId:      DATOS?.leadId      ?? null,
  paxNombre:   primero(DATOS?.paxNombre, process.env.TP_PAX_NOMBRE, 'Prueba Robot'),
  paxCantidad: DATOS?.paxCantidad ?? parseInt(process.env.TP_PAX_CANTIDAD || '2', 10),
  fechaViaje:  primero(DATOS?.fechaViaje, process.env.TP_FECHA_VIAJE),   // ISO o DDMMAA
  alias:       primero(DATOS?.alias, process.env.TP_ALIAS, 'wonderful trip for you'),
  agencia:     primero(DATOS?.agencia, process.env.TP_AGENCIA),
  depto:       primero(DATOS?.depto, process.env.TP_DEPTO),
  division:    primero(DATOS?.division, process.env.TP_DIVISION, 'WE'),    // WE = Web
  moneda:      primero(DATOS?.moneda, process.env.TP_MONEDA, 'USD'),
  // File origen a clonar (viene de la consulta SQL) — SIN esto no hay paso 3.5
  fileOrigen:  primero(DATOS?.fileOrigen, process.env.TP_FILE_ORIGEN),
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

// Bitacora: todo lo que se loguea queda tambien guardado para mandarselo a
// Salesforce. Sin esto, un SIN_DISPONIBILIDAD llega sin explicacion y el
// vendedor no tiene como saber que intento el robot ni por que se rindio.
const BITACORA = [];
const log = (m) => { console.log(m); BITACORA.push(String(m)); };
// Se manda la COLA del log, no el principio: el campo del Lead aguanta 2000
// caracteres y lo que importa es como termino, no como arranco.
const bitacoraTexto = () => BITACORA.join('\n').slice(-1900);

/** DDMMAA -> yyyy-MM-dd, que es lo que Apex puede convertir con Date.valueOf(). */
function ddmmaaAIso(ddmmaa) {
  const s = String(ddmmaa || '').replace(/\D/g, '');
  if (s.length !== 6) return null;
  return `20${s.slice(4, 6)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;
}

// DEMO: saltear el clon 3.5 (que todavia no esta mapeado) para poder mostrar el
// flujo COMPLETO encadenado — crear reserva → backend → link → SF — en una sola
// sesion. Se activa con TP_SKIP_35=1. En produccion va apagado (el 3.5 debe correr).
const SKIP_35 = /^(true|1|si)$/i.test(process.env.TP_SKIP_35 || '');

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

/** Primer elemento realmente visible de un locator (no solo presente en el DOM). */
async function primerVisible(loc) {
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 12); i++) {
    const c = loc.nth(i);
    if (await c.isVisible().catch(() => false)) return c;
  }
  return null;
}

async function logout(page) {
  // Tourplan no tiene un boton de logout suelto: esta dentro del menu del
  // usuario, arriba a la derecha ("conectado como QUI" + flecha). Y el rotulo
  // existe en el DOM aun con el menu cerrado, asi que hay que exigir que sea
  // VISIBLE antes de clickearlo. Sin logout la licencia queda tomada y la
  // corrida siguiente entra en QUERY MODE (la guia V4 lo pide explicitamente).
  const rotulos = /^\s*(logout|log\s*out|cerrar\s+sesi[oó]n|salir\s+del\s+sistema|desconectar)\s*$/i;
  try {
    let cand = await primerVisible(page.getByText(rotulos));

    if (!cand) {
      const usuario = await primerVisible(page.getByText(/conectado\s+como/i));
      if (usuario) {
        await usuario.click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(1500);
        await captura(page, '98_menu_usuario'); await volcarElementos(page, 'menu_usuario');
        cand = await primerVisible(page.getByText(rotulos));
      }
    }

    if (!cand) {
      cand = await primerVisible(page.locator(
        'button:has-text("Logout"), a:has-text("Logout"), [aria-label*="logout" i], [title*="logout" i], button:has-text("Log out")'
      ));
    }

    if (cand) {
      await cand.click({ timeout: 5000 });
      await sleep(2500);
      log('Logout OK — licencia liberada');
    } else {
      log('⚠ Logout no encontrado — revisar elementos_menu_usuario.json');
      await volcarElementos(page, 'sin_logout');
    }
  } catch (e) { log('⚠ Logout fallo: ' + e.message.split('\n')[0]); }
  await captura(page, '99_post_logout');
}

// ------------------------- FASES DEL FLUJO -------------------------

async function faseNavegarFits(page, context) {
  // A veces el menu carga INCOMPLETO (timing: la app todavia no renderizo la nav,
  // aparecen ~5 elementos). Se reintenta abrir el menu y encontrar "Bookings y
  // cotizaciones" hasta 4 veces, esperando a que la app termine entre intentos.
  const abrirMenu = async () => {
    for (const sel of ['[aria-label*="menu" i]', 'button:has(mat-icon:text("menu"))', 'mat-icon:text("menu")', '[class*="hamburger"], [class*="menu-toggle"]']) {
      const c = page.locator(sel).first();
      if (await c.count().catch(() => 0)) { await c.click({ timeout: 3000 }).catch(() => {}); break; }
    }
    await sleep(1000);
  };
  const bookings = page.getByText(/bookings\s*(y|and)\s*(cotizaciones|quotes)/i).first();
  let ok = false;
  for (let intento = 1; intento <= 4; intento++) {
    await abrirMenu();
    if (await bookings.count().catch(() => 0)) { ok = true; break; }
    log(`  menu incompleto (intento ${intento}/4) — espero a que cargue la app y reintento`);
    await esperarApp(page); await sleep(1800);
  }
  await captura(page, '10_menu'); await volcarElementos(page, 'menu');
  if (!ok) throw new Error('No encontre "Bookings y cotizaciones" en el menu (tras 4 reintentos)');
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
  // Confirmado = el campo muestra "CODIGO - Nombre" Y ya no esta marcado invalido.
  const confirmado = async () => {
    const v = (await el.inputValue().catch(() => '')) || '';
    if (!(v.includes(' - ') && v.toUpperCase().includes(String(codigo).toUpperCase()))) return false;
    // el borde rojo (tpinvalid/ng-invalid) significa que NO se comprometio la seleccion
    const clase = (await el.getAttribute('class').catch(() => '')) || '';
    return !/invalid/i.test(clase);
  };
  try {
    // 1) Abrir el dropdown y CLICKEAR la opcion real (dispara el evento Angular).
    await el.click();
    await sleep(700);
    const clickeado = await fp.evaluate(({ cod, etq }) => {
      const norm = s => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');
      const lbl = [...document.querySelectorAll('label, span, div, td')]
        .find(n => norm(n.textContent) === etq && n.getBoundingClientRect().width > 0);
      if (!lbl) return false;
      const lr = lbl.getBoundingClientRect();
      const field = [...document.querySelectorAll('input')]
        .filter(n => { const r = n.getBoundingClientRect(); return r.width > 0 && Math.abs(r.top - lr.top) < 20 && r.left > lr.left; })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
      if (!field) return false;
      const fr = field.getBoundingClientRect();
      // opciones = hojas visibles cuyo texto empieza con el codigo. El dropdown
      // puede abrir hacia ABAJO o hacia ARRIBA (campos bajos en la pantalla), asi
      // que se busca en una banda vertical a ambos lados, excluyendo la fila del campo.
      const codEsc = cod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('^' + codEsc + '\\b', 'i');
      const opt = [...document.querySelectorAll('*')].find(n => {
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.height > 40) return false;
        if (r.top > fr.bottom + 450 || r.bottom < fr.top - 450) return false;  // banda arriba+abajo
        if (Math.abs(r.top - fr.top) < 6) return false;                        // no es la fila del campo
        if ([...n.children].some(h => (h.textContent || '').trim())) return false;
        return re.test((n.textContent || '').trim());
      });
      if (!opt) return false;
      opt.scrollIntoView({ block: 'nearest' });
      // Disparar la secuencia completa: los dropdowns Angular suelen responder a
      // mousedown, no solo a click. Con solo .click() la seleccion no se comprometia.
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    }, { cod: String(codigo), etq: etiqueta.toUpperCase() });
    await sleep(500);
    if (clickeado && await confirmado()) return true;

    // 2) Fallback: escribir el codigo + teclas (por si la lista no se pudo clickear)
    await el.click();
    await el.press('Control+a').catch(() => {});
    await el.type(String(codigo), { delay: 90 });
    await sleep(700);
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
  // ORDEN CRITICO: AGENCIA primero. En Tourplan la agencia determina que
  // division/departamento aplican, y al seleccionarla RESETEA esos campos.
  // Si se llena la agencia al final, invalida division/depto ya cargados.
  for (const [etiqueta, valor] of [
    ['AGENCIA', CFG.agencia], ['MONEDA', CFG.moneda],
    ['DIVISIÓN', CFG.division], ['DEPARTAMENTO', CFG.depto],
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
  // Cerrado el modal de creacion, la referencia queda en la cabecera del
  // booking (la misma que se ve arriba a la izquierda en toda la app).
  const cabecera = fp.locator('input[class*="bookingfullreference" i]').first();
  if (await cabecera.count().catch(() => 0)) {
    const v = (await cabecera.inputValue().catch(() => '')).trim();
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

  // Si GUARDAR esta deshabilitado, algun campo obligatorio quedo invalido (rojo).
  // Cortar ACA con un mensaje claro en vez de arrastrar el error a fases siguientes.
  const habilitado = await guardar.isEnabled().catch(() => true);
  if (!habilitado) {
    const invalidos = await fp.$$eval('input', ns => ns
      .filter(n => /invalid/i.test(n.getAttribute('class') || '') && n.getBoundingClientRect().width > 0)
      .map(n => (n.getAttribute('class') || '').split(' ').find(c => /^tp/.test(c)) || 'campo')
      .slice(0, 8)).catch(() => []);
    await captura(fp, '15_guardar_deshabilitado');
    throw new Error(`GUARDAR deshabilitado: campos obligatorios invalidos [${invalidos.join(', ')}]. Ver captura 15_guardar_deshabilitado.`);
  }

  await guardar.click();
  await esperarApp(fp);

  // Tras Guardar, Tourplan puede mostrar modales de ADVERTENCIA (ej: "The booking
  // name already exists"). Son avisos blandos: se aceptan con OK y guarda igual.
  // Pueden aparecer con delay o encadenados → loop con reintentos.
  for (let i = 0; i < 6; i++) {
    await sleep(1200);
    if (!(await modalBookingAbierto(fp))) break;   // ya cerro = guardado OK
    let confirmo = false;
    for (const txt of ['OK', 'Ok', 'Aceptar', 'Sí', 'Si', 'Yes', 'Continuar']) {
      const b = fp.getByRole('button', { name: new RegExp('^' + txt + '$', 'i') }).first();
      if (await b.count().catch(() => 0) && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 2000 }).catch(() => {});
        log(`  [advertencia] confirmada con "${txt}"`);
        confirmo = true;
        await sleep(600);
      }
    }
    if (!confirmo && i >= 1) break;   // no hay mas modales para cerrar
  }

  // Verificar que el modal "Crear Booking" se cerro: si sigue abierto, no guardo.
  if (await modalBookingAbierto(fp)) {
    await captura(fp, '15_no_guardo');
    throw new Error('El modal "Crear Booking" sigue abierto tras Guardar y confirmar advertencias — el guardado no se completo. Ver captura 15_no_guardo.');
  }
  await captura(fp, '15_booking_guardado'); await volcarElementos(fp, 'booking_guardado');
  log('  Booking guardado (modal cerrado OK)');
}

/**
 * Abre el menu lateral izquierdo de Tourplan y lo MANTIENE abierto.
 *
 * El menu es <div class="tpnav">. Cuando esta colapsado lleva ademas la clase
 * "nav-closed" y mide unos 75px: sus items (RESUMEN, ITINERARIO, ...) no estan
 * ocultos por CSS, no existen en el DOM. Se despliega al pasar el mouse por
 * encima y se vuelve a cerrar en cuanto el puntero sale.
 *
 * Eso explica los tres sintomas que veniamos viendo: el clic por texto daba
 * timeout (el item no existia), el clic en la fila padre "funcionaba" pero
 * dejaba el menu cerrado (el mouse habia salido), y en el intento siguiente
 * la seccion ya no aparecia.
 *
 * La regla, entonces: mantener el puntero DENTRO del nav mientras se navega.
 */
async function menuAbierto(fp) {
  return (await fp.locator('.nav-closed').count().catch(() => 0)) === 0;
}

async function abrirMenuLateral(fp) {
  const nav = fp.locator('div.tpnav, [class*="tpnav"]').first();
  if (await menuAbierto(fp)) { log('  Menu lateral ya estaba abierto'); return true; }

  // 1) Pasar el mouse por encima: es como lo abre una persona.
  await nav.hover({ timeout: 3000 }).catch(() => {});
  await sleep(700);
  if (await menuAbierto(fp)) { log('  Menu lateral abierto (hover sobre el nav)'); return true; }

  // 2) La hamburguesa, que lo deja fijo.
  const hamb = fp.locator('img[class*="hamburger" i], [class*="hamburger" i]').first();
  if (await hamb.count().catch(() => 0)) {
    await hamb.click({ timeout: 3000 }).catch(() => {});
    await sleep(900);
    if (await menuAbierto(fp)) { log('  Menu lateral abierto (hamburguesa)'); return true; }
  }

  // 3) Ultimo recurso: sobre la franja, por coordenada.
  await fp.mouse.move(45, 300).catch(() => {});
  await sleep(800);
  if (await menuAbierto(fp)) { log('  Menu lateral abierto (mouse sobre la franja)'); return true; }

  log('  No pude abrir el menu lateral (sigue con clase nav-closed)');
  return false;
}

/**
 * Abre una seccion del menu lateral y entra a uno de sus items.
 *
 * El nav (div.tpnav) se despliega al pasarle el mouse y se cierra al salir, y
 * las secciones son plegables: mientras estan plegadas sus items NO existen en
 * el DOM. Por eso hay que re-hoverear antes de cada clic y reintentar.
 * Devuelve true si entro al item.
 */
async function abrirItemMenu(fp, seccionRx, itemRx, etiqueta) {
  await abrirMenuLateral(fp);
  await sleep(800);
  const nav = fp.locator('div.tpnav, [class*="tpnav"]').first();

  for (let intento = 1; intento <= 4; intento++) {
    let item = fp.getByText(itemRx).first();
    if (await item.count().catch(() => 0)) {
      // force: el nav esta animando y nunca pasa el chequeo de estabilidad.
      await item.click({ timeout: 5000, force: true }).catch(() => {});
      await esperarApp(fp); await sleep(1600);
      log('  Menu: entre a ' + etiqueta);
      return true;
    }
    await nav.hover({ timeout: 3000 }).catch(() => {});
    await sleep(600);
    const seccion = fp.getByText(seccionRx).first();
    if (!(await seccion.count().catch(() => 0))) {
      log('  Menu: la seccion de ' + etiqueta + ' no esta visible (intento ' + intento + '/4) — reabro el nav');
      await abrirMenuLateral(fp);
      continue;
    }
    await seccion.click({ timeout: 4000, force: true }).catch(() => {});
    await fp.getByText(itemRx).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }

  // Volcado del nav para poder ajustar el selector sin adivinar.
  const items = await fp.evaluate(() => {
    const out = [];
    document.querySelectorAll('*').forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.left > 300 || r.width > 320) return;
      if (e.childElementCount !== 0) return;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t.slice(0, 40));
    });
    return out.slice(0, 40);
  }).catch(() => []);
  log('  ⚠ Menu: no encontre ' + etiqueta + '. Items visibles del nav: ' + items.join(' | '));
  return false;
}

/**
 * Marca una de las opciones tipo radio de Tourplan.
 *
 * No son input[type="radio"]: son <input> sin type y el seleccionado se
 * distingue por la clase "checked". Buscarlos por tipo devolvia siempre vacio
 * y quedaba marcada la opcion por defecto. Se ubica el input subiendo desde el
 * rotulo hasta el primer contenedor que tenga UNO solo.
 */
async function marcarOpcion(fp, textoExacto) {
  return await fp.evaluate((texto) => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const buscado = norm(texto);
    const candidatos = [...document.querySelectorAll('*')]
      .filter((e) => norm(e.textContent) === buscado)
      .sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length);
    const rotulo = candidatos[0];
    if (!rotulo) return 'sin rotulo';

    let n = rotulo, control = null;
    for (let i = 0; i < 6 && n; i++) {
      const ins = n.querySelectorAll('input');
      if (ins.length === 1) { control = ins[0]; break; }
      if (ins.length > 1) break;   // nos pasamos: este contenedor tiene varias opciones
      n = n.parentElement;
    }
    if (!control) return 'sin control';

    control.click();
    control.dispatchEvent(new Event('change', { bubbles: true }));
    const clases = (control.className || '').toString();
    return /checked/i.test(clases) || control.checked ? 'ok' : 'clickeado pero sigue sin "checked" (' + clases.slice(0, 40) + ')';
  }, textoExacto).catch((e) => 'error: ' + e.message);
}

async function faseInsertarServicios(fp) {
  if (!CFG.fileOrigen) throw new Error('FALTA TP_FILE_ORIGEN en .env — el codigo del file a clonar (viene de la consulta SQL). Sin el no hay paso 3.5.');

  await sleep(1200);
  await captura(fp, '16_pantalla_3_5'); await volcarElementos(fp, 'pantalla_3_5');

  // PASO 3.5, corregido con las capturas de la guia V4.
  //
  // Esto estuvo trabado por una suposicion equivocada: se buscaba "Insertar
  // booking" entre los BOTONES del panel. No esta ahi. En esa botonera solo hay
  // "Insertar Nuevo Servicio", "Insertas servcio de texto", "Buscar Productos"
  // y "Buscar Proveedores". "INSERTAR BOOKING" es el ULTIMO item del MENU
  // LATERAL izquierdo, dentro de la seccion desplegable ITINERARIO. Si la
  // seccion esta plegada el item no existe en el DOM, y por eso toda busqueda
  // por texto o por clase devolvia vacio.

  // 3.5.a — salir de la pantalla de insercion de linea (la guia lo pide)
  const salir = fp.locator('button, [role="button"], a')
    .filter({ hasText: /^\s*(salir|cerrar|cancelar|close|exit)\s*$/i }).last();
  if (await salir.count().catch(() => 0)) {
    await salir.click().catch(() => {});
    log('  Sali de la pantalla de insercion de linea');
  } else {
    await fp.keyboard.press('Escape').catch(() => {});
    log('  No encontre boton de salida — probe con Escape (ver captura 16)');
  }
  await esperarApp(fp); await sleep(900);

  // 3.5.b — zoom 75%: la guia lo pide para que menu y botonera entren completos.
  await fp.evaluate(() => { document.documentElement.style.zoom = '0.75'; }).catch(() => {});
  await sleep(800);

  // 3.5.c — MENU LATERAL: abrirlo, expandir ITINERARIO y entrar a INSERTAR BOOKING.
  // Tras guardar, Tourplan colapsa el menu a una franja con la hamburguesa: los
  // items no estan en el DOM hasta abrirlo.
  await abrirMenuLateral(fp);
  await sleep(900);

  // ITINERARIO es una seccion plegable DENTRO del nav. Antes de cada accion se
  // vuelve a pasar el mouse por el nav: si el puntero sale, el menu se cierra y
  // la seccion desaparece a mitad de camino.
  const nav = fp.locator('div.tpnav, [class*="tpnav"]').first();
  let insertar = fp.getByText(/^\s*insertar\s+booking\s*$/i).first();
  for (let intento = 1; intento <= 4 && !(await insertar.count().catch(() => 0)); intento++) {
    await nav.hover({ timeout: 3000 }).catch(() => {});
    await sleep(600);
    const seccion = fp.getByText(/^\s*itinerari[oa]\s*$/i).first();
    if (!(await seccion.count().catch(() => 0))) {
      log('  ITINERARIO no visible (intento ' + intento + '/4) — el menu se cerro, reabro');
      await abrirMenuLateral(fp);
      continue;
    }
    // force:true evita que Playwright aborte por el chequeo de "estabilidad":
    // el nav se esta animando y nunca queda quieto el tiempo que el pide.
    await seccion.click({ timeout: 4000, force: true }).catch((e) =>
      log('  Fallo el clic: ' + String(e.message).split('\n')[0].slice(0, 60)));
    await fp.getByText(/^\s*insertar\s+booking\s*$/i).first()
      .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    insertar = fp.getByText(/^\s*insertar\s+booking\s*$/i).first();
    if (await insertar.count().catch(() => 0)) { log('  Seccion ITINERARIO desplegada'); break; }
  }

  await captura(fp, '17_menu_itinerario'); await volcarElementos(fp, 'menu_itinerario');
  if (!(await insertar.count().catch(() => 0))) {
    // Volcado del DOM REAL de la franja del menu: el volcado normal solo mira
    // el panel principal y por eso nunca mostro estos elementos.
    const menu = await fp.evaluate(() => {
      const out = [];
      document.querySelectorAll('*').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.left > 300 || r.width > 320) return;
        const txt = (e.childElementCount === 0 ? (e.textContent || '') : '').trim();
        out.push({
          tag: e.tagName.toLowerCase(),
          clase: (e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || '').toString().slice(0, 80),
          texto: txt.slice(0, 34),
          hijos: e.childElementCount,
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        });
      });
      return out.slice(0, 60);
    }).catch(() => []);
    log('  --- DOM del menu lateral (para ajustar el selector) ---');
    for (const m of menu) {
      log('    ' + m.tag.padEnd(7) + ' [' + m.clase + '] "' + m.texto + '" hijos=' + m.hijos + ' @' + m.x + ',' + m.y + ' ' + m.w + 'x' + m.h);
    }
    throw new Error('No encontre "INSERTAR BOOKING" en el menu lateral, seccion Itinerario (paso 3.5.c). Ver el volcado de arriba.');
  }
  await insertar.click();
  await esperarApp(fp); await sleep(1600);
  await captura(fp, '17b_seleccionar_booking'); await volcarElementos(fp, 'seleccionar_booking');

  // 3.5.d — pantalla "SELECCIONAR BOOKING A INSERTAR".
  // Tiene DOS buscadores: NOMBRE y REFERENCIA. El codigo del file va en
  // REFERENCIA. Antes se tecleaba "en el input que estuviera enfocado" y
  // terminaba escribiendose en NOMBRE, que busca por pasajero y no devuelve nada.
  const codigo = String(CFG.fileOrigen);

  // El modal "Insertar Booking" repite las MISMAS clases que la cabecera del
  // booking recien creado: hay dos inputs tpdescription-bookingfullreference en
  // la pagina. El de la cabecera es la referencia del file nuevo; el del modal
  // es el que hay que llenar. Como el modal se dibuja despues, es el ULTIMO.
  // Buscar por la etiqueta "Referencia" agarraba el de arriba, y el codigo
  // terminaba escrito en NOMBRE.
  const refInput = fp.locator('input[class*="bookingfullreference" i]').last();
  if (!(await refInput.count().catch(() => 0))) {
    throw new Error('No encontre el campo REFERENCIA del modal Insertar Booking (paso 3.5.d). Ver JSON seleccionar_booking.');
  }

  // Se teclea y se sale con Tab. NO se toca la lupa "Buscar Bookings": abre otro
  // modal de filtros donde lo tecleado cae en "Nombre inicia con" (busca por
  // nombre de pasajero) y el file no aparece nunca.
  await refInput.click().catch(() => {});
  await refInput.fill('').catch(() => {});
  await fp.keyboard.type(codigo, { delay: 60 });
  await fp.keyboard.press('Tab').catch(() => {});
  await esperarApp(fp); await sleep(2000);
  await captura(fp, '17c_referencia'); await volcarElementos(fp, 'referencia');

  // 3.5.e — verificar que Tourplan resolvio la referencia a un booking real.
  // Si no resuelve, el campo NOMBRE del modal queda vacio y Guardar deshabilitado.
  const nombreModal = fp.locator('input[class*="bookingname" i]').last();
  const nombreResuelto = await nombreModal.inputValue().catch(() => '');
  const refFinal = await refInput.inputValue().catch(() => '');
  log('  REFERENCIA = "' + refFinal + '"  |  NOMBRE resuelto = "' + nombreResuelto + '"');

  if (!String(refFinal).toUpperCase().includes(codigo.toUpperCase())) {
    throw new Error('La referencia no quedo escrita en el modal (quedo "' + refFinal + '"). Ver captura 17c.');
  }
  if (!nombreResuelto.trim()) {
    // Puede que necesite la lista: se abre la lupa de REFERENCIA y se elige.
    log('  La referencia no resolvio sola — abro la lupa de REFERENCIA');
    const lupaRef = fp.locator('button[class*="tplookupbooking" i]').last();
    if (await lupaRef.count().catch(() => 0)) {
      await lupaRef.click().catch(() => {});
      await esperarApp(fp); await sleep(2500);
      await captura(fp, '17d_lupa'); await volcarElementos(fp, 'lupa_referencia');
      const fila = fp.locator(
        'tr:has-text("' + codigo + '"), [role="row"]:has-text("' + codigo + '"), li:has-text("' + codigo + '")'
      ).first();
      if (await fila.count().catch(() => 0)) {
        await fila.dblclick().catch(async () => { await fila.click().catch(() => {}); });
        await esperarApp(fp); await sleep(1800);
      }
    }
  }
  await captura(fp, '17e_referencia_resuelta');

  // 3.5.f — INSERTAR TIPO debe quedar en "Insertar", nunca en "Mezclar":
  // Mezclar pisa los servicios existentes en vez de agregarlos. Viene marcado
  // asi por defecto (es el primer radio), pero se fuerza por las dudas.
  // El radio "Insertar" ya viene marcado por defecto (el volcado lo muestra con
  // el atributo checked). Solo se fuerza si por algun motivo no lo estuviera:
  // clickearlo a ciegas puede caer en "Mezclar", que pisa los servicios.
  log('  INSERTAR TIPO = Insertar: ' + (await marcarOpcion(fp, 'Insertar')));

  // "Insertar en Dia/Sec" viene VACIO. El booking nuevo no tiene ninguna linea,
  // asi que los servicios clonados van al dia 1, secuencia 1. Sin esto Tourplan
  // acepta el guardado pero el itinerario queda sin lineas.
  const dia = fp.locator('input[class*="tpnumber-detailsday" i]').last();
  const sec = fp.locator('input[class*="tpnumber-servicesequence" i]').last();
  for (const [campo, valor, nombre] of [[dia, '1', 'Dia'], [sec, '1', 'Sec']]) {
    if (!(await campo.count().catch(() => 0))) { log('  ⚠ No encontre el campo ' + nombre); continue; }
    await campo.click({ timeout: 5000 }).catch(() => {});
    await fp.keyboard.press('Control+a').catch(() => {});
    await fp.keyboard.type(valor, { delay: 40 });
    await fp.keyboard.press('Tab').catch(() => {});
  }
  log('  Insertar en Dia/Sec = "' + (await dia.inputValue().catch(() => '?')) +
      '" / "' + (await sec.inputValue().catch(() => '?')) + '"');
  await sleep(400);
  await captura(fp, '17e_parametros');

  // 3.5.g — confirmar la insercion
  // En este modal el boton de confirmar es GUARDAR (arriba a la derecha), y
  // queda deshabilitado hasta que la referencia resuelve a un booking real.
  // El confirmar del modal es button.tpsave ("Guardar"), arriba a la derecha.
  // Queda deshabilitado hasta que la referencia resuelve a un booking real.
  let confirmar = fp.locator('button[class*="tpsave" i]').last();
  if (!(await confirmar.count().catch(() => 0))) {
    confirmar = fp.getByRole('button', { name: /^\s*(guardar|insertar|aceptar|ok|confirmar)\s*$/i }).last();
  }
  if (await confirmar.count().catch(() => 0)) {
    await confirmar.click();
    log('  Confirme la insercion');
  } else {
    await fp.keyboard.press('Enter').catch(() => {});
    log('  No encontre boton de confirmar — probe con Enter (ver captura 17e)');
  }
  await esperarApp(fp); await sleep(2000);

  // Al guardar, Tourplan abre el dialogo "Recalcular Booking" y NO inserta nada
  // hasta que se confirma. Trae marcada "Reemplazar todos MENOS modificaciones
  // manuales"; la guia V4 exige "Reemplazar todos" a secas. Se elige por DOM
  // porque los dos rotulos empiezan igual y un selector por texto casa con
  // ambos, y porque el modal de atras tambien tiene radios (Insertar/Mezclar).
  const dialogo = fp.getByText(/recalcular\s+booking/i).first();
  if (await dialogo.count().catch(() => 0)) {
    await captura(fp, '17f_recalcular');
    await volcarElementos(fp, 'recalcular');
    // Tourplan no dibuja radios nativos aca: son cuadraditos propios a la
    // izquierda de cada rotulo. Buscar input[type=radio] devolvia "sin radio" y
    // quedaba marcada la opcion por defecto ("...menos modificaciones
    // manuales"), que no es la que pide la guia. Se ubica el control por
    // geometria: el elemento chico mas pegado al rotulo, a su izquierda y a la
    // misma altura.
    const marcado = await marcarOpcion(fp, 'Reemplazar Todos');
    log('  "Reemplazar todos": ' + marcado);
    await sleep(800);
    await captura(fp, '17f2_recalcular_elegido');

    const si = fp.getByRole('button', { name: /^\s*s[ií]\s*$/i }).first();
    if (await si.count().catch(() => 0)) {
      await si.click({ timeout: 8000 }).catch((e) => log('  No pude clickear SI: ' + String(e.message).slice(0, 60)));
      log('  Confirme el recalculo con "Si"');
    } else {
      log('  No encontre el boton "Si" del dialogo Recalcular');
    }
    // Tourplan muestra "GUARDANDO DATOS ..." y la insercion tarda varios
    // segundos. Si se sigue de largo, la validacion corre con el modal todavia
    // arriba y termina contando las filas del modal como si fueran servicios.
    await fp.getByText(/guardando\s+datos/i).first()
      .waitFor({ state: 'hidden', timeout: 90000 })
      .then(() => log('  Guardado terminado'))
      .catch(() => log('  El cartel "Guardando datos" no desaparecio en 90s'));
    await captura(fp, '17f3_tras_recalculo'); await volcarElementos(fp, 'tras_recalculo');

    // ORDEN IMPORTANTE. El modal "Insertar Booking" no se cierra solo porque
    // Tourplan esta esperando que se coticen a mano los servicios que no tienen
    // tarifa para la fecha nueva. Si se le da SALIR ahi, se cancela la
    // insercion: el panel de tarifas igual aparece, se deja guardar sin
    // protestar, y el itinerario termina vacio. Primero las tarifas.
    await fp.getByText(ROTULO_TARIFA_MANUAL).first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => log('  Tourplan pide tarifas manuales antes de cerrar el modal'))
      .catch(() => log('  Todavia no pidio tarifas manuales'));
    await faseTarifasManuales(fp);

    // Recien ahora, si el modal quedo abierto, se sale.
    let sigueAbierto = await fp.getByText(/seleccionar\s+booking\s+a\s+insertar/i)
      .first().isVisible().catch(() => false);
    if (sigueAbierto) {
      const salirModal = fp.locator('button[class*="tpcancel" i]').last();
      if (await salirModal.count().catch(() => 0)) {
        await salirModal.click({ timeout: 8000 }).catch(() => {});
        log('  Cerre el modal con SALIR (ya cotizado)');
      }
      await esperarApp(fp); await sleep(2500);
      sigueAbierto = await fp.getByText(/seleccionar\s+booking\s+a\s+insertar/i)
        .first().isVisible().catch(() => false);
    } else {
      log('  El modal Insertar Booking se cerro solo');
    }
    log(sigueAbierto ? '  El modal Insertar Booking sigue abierto' : '  El modal Insertar Booking se cerro');
    await esperarApp(fp); await sleep(2000);
  }

  await captura(fp, '17g_insertado'); await volcarElementos(fp, 'post_insercion');

  // Los servicios sin tarifa vigente abren un modal pidiendola a mano. Hay que
  // despacharlos aca: si no, tapan el itinerario y el resto del proceso mide
  // el modal en vez del booking.
  await faseTarifasManuales(fp);

  log('FASE 3.5 OK — servicios del file ' + CFG.fileOrigen + ' insertados');
}

/**
 * Devuelve el <input> de una etiqueta de Tourplan.
 * Tourplan no usa <label for>: arma filas etiqueta + control, asi que hay que
 * probar varias vias antes de rendirse.
 */
async function inputDeCampo(fp, textoEtiqueta, clases) {
  clases = clases || [];
  const porLabel = fp.getByLabel(textoEtiqueta).first();
  if (await porLabel.count().catch(() => 0)) return porLabel;
  for (const c of clases) {
    const porClase = fp.locator('input[class*="' + c + '" i]').first();
    if (await porClase.count().catch(() => 0)) return porClase;
  }
  const fila = fp.locator('div,tr,li').filter({ hasText: textoEtiqueta }).last();
  if (await fila.count().catch(() => 0)) {
    const dentro = fila.locator('input:visible').first();
    if (await dentro.count().catch(() => 0)) return dentro;
  }
  return null;
}

/**
 * Modal "Servicio requiere ingr. manual de tarifas".
 *
 * Aparece DESPUES de cerrar "Insertar Booking": los servicios clonados que no
 * tienen tarifa vigente para la fecha nueva no se pueden costear solos y
 * Tourplan pide la tarifa a mano, un servicio por vez. Mientras el modal este
 * arriba no se ve el itinerario, asi que todo lo que venga despues (3.6, 3.7)
 * mide el modal y no el booking.
 *
 * La guia V4 (paso 3.6) dice que los precios quedan en el valor indicativo
 * "999" justamente para que el vendedor sepa que hay que ajustarlos a mano:
 * eso es lo que se carga aca.
 */
// OJO: este patron tambien vive DUPLICADO dentro de un page.evaluate() en
// faseValidarLineas (el navegador no puede ver closures de Node) — si se
// ensancha aca, ensanchar tambien alla.
const ROTULO_TARIFA_MANUAL = /(requiere\s+ingr\.?\s*manual\s+de\s+tarifas|extensi[oó]n\s+tarifa\s+(expirada|vencida)|tarifa\s+no\s+vigente)/i;

async function modalTarifasVisible(fp) {
  return await fp.getByText(ROTULO_TARIFA_MANUAL).first().isVisible().catch(() => false);
}

async function faseTarifasManuales(fp) {
  if (!(await modalTarifasVisible(fp))) {
    log('  No quedaron servicios pidiendo tarifa manual');
    return;
  }
  await captura(fp, '17h_tarifa_manual'); await volcarElementos(fp, 'tarifa_manual');

  let anterior = null;
  for (let vuelta = 1; vuelta <= 20; vuelta++) {
    if (!(await modalTarifasVisible(fp))) {
      log('  Tarifas manuales resueltas (' + (vuelta - 1) + ' servicio/s)');
      return;
    }

    // Que servicio esta pidiendo tarifa: sirve para el log y para detectar que
    // el modal se quedo trabado en el mismo (Guardar no lo esta cerrando).
    const cual = await fp.evaluate(() => {
      const hojas = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0);
      const n = hojas.find((e) => /\d{3}\s*\/\s*\w+\s*\/\s*\d+\s*\/\s*\w+/.test((e.textContent || '').trim()));
      return n ? (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    }).catch(() => '');

    // Solo tpnumber-costamount es editable; tpnumber-default viene tpreadonly.
    const campos = fp.locator('input[class*="tpnumber-costamount" i]');
    const n = await campos.count().catch(() => 0);
    let puestos = 0;
    for (let i = 0; i < n; i++) {
      const c = campos.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      // fill() no dispara el change detection de Angular en Tourplan: se teclea.
      await c.click({ timeout: 5000 }).catch(() => {});
      await fp.keyboard.press('Control+a').catch(() => {});
      await fp.keyboard.type('999', { delay: 30 });
      await fp.keyboard.press('Tab').catch(() => {});
      puestos++;
    }
    log('  Tarifa manual ' + vuelta + ' [' + (cual || 'servicio ?') + ']: ' + puestos + ' campo(s) en 999');
    await captura(fp, '17h2_tarifa_cargada_' + vuelta);

    // "Guardar Todo" cierra el servicio completo (todos sus componentes).
    let guardar = fp.locator('button[class*="tpsaveall" i]').last();
    if (!(await guardar.count().catch(() => 0))) guardar = fp.locator('button[class*="tpsave" i]').last();
    if (await guardar.count().catch(() => 0)) {
      await guardar.click({ timeout: 8000 }).catch((e) =>
        log('  No pude clickear Guardar del modal de tarifas: ' + String(e.message).split('\n')[0].slice(0, 60)));
    } else {
      log('  ⚠ No encontre el boton Guardar del modal de tarifas');
      break;
    }
    await esperarApp(fp); await sleep(2500);
    await fp.getByText(/guardando\s+datos/i).first()
      .waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
    // El itinerario quedaba vacio y no se sabia en que momento: se fotografia
    // la pantalla inmediatamente despues de guardar cada tarifa.
    await captura(fp, '17i_tras_guardar_tarifa_' + vuelta);
    await volcarElementos(fp, 'tras_guardar_tarifa_' + vuelta);

    if (cual && cual === anterior) {
      await captura(fp, '17h_tarifa_trabada');
      throw new Error('El modal de tarifas manuales se trabo en el servicio ' + cual +
        ': Guardar no lo cierra (paso 3.5). Ver captura 17h_tarifa_trabada.');
    }
    anterior = cual;
  }

  if (await modalTarifasVisible(fp)) {
    await captura(fp, '17h_tarifa_trabada');
    throw new Error('Quedaron servicios pidiendo tarifa manual despues de 20 vueltas (paso 3.5).');
  }
}

/**
 * PASO 3.7 (V4) — validacion por COLOR de las lineas del itinerario.
 * Blanca = el servicio se inserto bien. Roja = no opera en esa fecha.
 * Es la unica forma de saber si el clon sirve: Tourplan no tira error, pinta.
 */
async function faseValidarLineas(fp) {
  const itinerario = fp.getByText(/^\s*itinerari[oa]\s*$/i).first();
  if (await itinerario.count().catch(() => 0)) {
    await itinerario.click().catch(() => {});
    await esperarApp(fp); await sleep(1200);
  }
  await captura(fp, '17e_validacion_color');

  const rojas = await fp.evaluate(() => {
    const esRojo = (c) => {
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c || '');
      if (!m) return false;
      const [r, g, b] = [ +m[1], +m[2], +m[3] ];
      // rojo "de verdad": componente roja dominante y clara sobre las otras dos
      return r > 130 && r - g > 55 && r - b > 55;
    };
    const filas = document.querySelectorAll('tr, [role="row"]');
    const malas = [];
    for (const f of filas) {
      const st = getComputedStyle(f);
      let rojo = esRojo(st.backgroundColor) || esRojo(st.color);
      if (!rojo) {
        for (const c of f.querySelectorAll('td, [role="cell"]')) {
          const cs = getComputedStyle(c);
          if (esRojo(cs.backgroundColor) || esRojo(cs.color)) { rojo = true; break; }
        }
      }
      if (rojo) malas.push((f.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90));
    }
    return malas;
  }).catch(() => []);

  // Antes esto cantaba exito con la tabla vacia: solo miraba si habia filas
  // rojas, y cero filas tambien es "cero rojas". Si el clon no inserto nada,
  // hay que enterarse aca y no dos pasos mas adelante.
  const lineas = await fp.evaluate(() => {
    // Solo la grilla del itinerario. Antes se contaba cualquier <tr> de la
    // pagina y las filas del modal ("Doble", "Adulto 01") pasaban por servicios.
    // Cualquiera de los dos modales tapa el itinerario: contar filas con uno
    // arriba fue exactamente el falso positivo de las corridas anteriores.
    const modalArriba = [...document.querySelectorAll('*')].some((e) =>
      e.childElementCount === 0 &&
      /(seleccionar\s+booking\s+a\s+insertar|requiere\s+ingr\.?\s*manual\s+de\s+tarifas|extensi[oó]n\s+tarifa\s+(expirada|vencida)|tarifa\s+no\s+vigente)/i
        .test(e.textContent || ''));
    if (modalArriba) return -1;
    const filas = [...document.querySelectorAll('tbody tr, [role="rowgroup"] [role="row"]')];
    return filas.filter((f) => {
      const celdas = f.querySelectorAll('td, [role="cell"]');
      return celdas.length >= 3 && (f.textContent || '').trim().length > 8;
    }).length;
  }).catch(() => 0);
  if (lineas === -1) {
    throw new Error('Habia un modal abierto al validar (Insertar Booking o tarifas manuales): la insercion no termino (paso 3.7). Ver captura 17e_validacion_color.');
  }
  log('  Lineas de servicio en el itinerario: ' + lineas);

  let lineasFinal = lineas;
  if (!lineas) {
    // Antes de acusar a la insercion: la grilla de Tourplan no siempre se
    // repinta sola despues de guardar. Las flechas de la barra de pax fuerzan
    // un re-render sin tocar los datos.
    log('  Grilla vacia — fuerzo un refresco con las flechas de la barra de pax');
    const der = fp.locator('button[class*="tpbutton-navright" i]').first();
    const izq = fp.locator('button[class*="tpbutton-navleft" i]').first();
    if (await der.count().catch(() => 0)) { await der.click({ timeout: 5000, force: true }).catch(() => {}); await esperarApp(fp); await sleep(1500); }
    if (await izq.count().catch(() => 0)) { await izq.click({ timeout: 5000, force: true }).catch(() => {}); await esperarApp(fp); await sleep(1500); }
    await captura(fp, '17e2_tras_refresco'); await volcarElementos(fp, 'tras_refresco');

    lineasFinal = await fp.evaluate(() => {
      const filas = [...document.querySelectorAll('tbody tr, [role="rowgroup"] [role="row"]')];
      return filas.filter((f) => {
        const celdas = f.querySelectorAll('td, [role="cell"]');
        return celdas.length >= 3 && (f.textContent || '').trim().length > 8;
      }).length;
    }).catch(() => 0);
    log('  Lineas despues del refresco: ' + lineasFinal);
  }

  if (!lineasFinal) {
    throw new Error('El itinerario quedo VACIO incluso tras refrescar: la insercion del file ' +
      CFG.fileOrigen + ' no dejo lineas (paso 3.7). Ver capturas 17h2 / 17i / 17e2.');
  }
  const lineasOk = lineasFinal;

  if (rojas.length) {
    log(`  ⚠ ${rojas.length} servicio(s) en ROJO — no operan en la fecha elegida`);
    rojas.slice(0, 3).forEach(r => log(`     · ${r}`));
    throw Object.assign(new Error('DISPONIBILIDAD (lineas rojas): ' + rojas.slice(0, 2).join(' | ')), { estacional: true });
  }
  log('FASE 3.7 OK — ' + lineasOk + ' lineas, todas blancas: el file se inserto correctamente');
}

/**
 * Seccion 4 (V4), ultimo recurso: si en la fecha original tampoco hay
 * disponibilidad, se ocultan las fechas para poder mandar igual la cotizacion.
 */
async function faseOcultarFechas(fp) {
  // "Ocultar fechas" vive en la misma pantalla que "Mostrar precios"
  // (Detalles de booking -> Configuracion general) y es el mismo tipo de campo:
  // un campo-lista de Tourplan, no un <select>.
  await fp.evaluate(() => { document.documentElement.style.zoom = '0.75'; }).catch(() => {});
  const entro = await abrirItemMenu(
    fp,
    /^\s*detalles\s+de\s+booking\s*$/i,
    /^\s*configuraci[oó]n\s+general\s*$/i,
    'Configuracion general'
  );
  if (entro) {
    const ok = await seleccionarEnLista(fp, 'Ocultar fechas', '1');
    log(ok ? '  "Ocultar fechas" -> 1 - SI ok' : '  ! No pude dejar "Ocultar fechas" en SI');
  } else {
    log('  ! No pude llegar a Configuracion general para ocultar fechas');
  }
  await fp.evaluate(() => { document.documentElement.style.zoom = '1'; }).catch(() => {});
  await captura(fp, '19c_ocultar_fechas'); await volcarElementos(fp, 'ocultar_fechas');
}

async function faseReemplazarPrecios(fp) {
  // Al insertar, pregunta por precios → SIEMPRE "Reemplazar todos"
  // El dialogo normalmente ya se resolvio en el paso 3.5 (aparece al Guardar).
  // Esto queda como red por si Tourplan lo muestra mas tarde. Con timeout: sin
  // el, un click sobre algo no clickeable colgaba la corrida 30 segundos.
  const reemplazar = fp.getByText(/^\s*reemplazar\s+todos\s*$/i).first();
  if (await reemplazar.count().catch(() => 0)) {
    await reemplazar.click({ timeout: 5000, force: true })
      .then(() => log('  "Reemplazar todos" clickeado (dialogo tardio)'))
      .catch(() => log('  "Reemplazar todos" visible pero no clickeable — sigo'));
  }
  else log('  El recalculo ya se confirmo en el paso 3.5 — nada que hacer aca');
  await esperarApp(fp); await sleep(1500);
  await captura(fp, '18_precios'); await volcarElementos(fp, 'precios');
  // Deteccion de disponibilidad (estacionalidad) SOLO en alertas/dialogos visibles,
  // NO en todo el body (evita falsos positivos que dispararian los 7 reintentos).
  const alerta = await fp.evaluate(() => {
    const sels = '[role="alert"], [class*="alert" i], [class*="dialog" i], [class*="toast" i], [class*="error" i], [class*="mensaje" i], [class*="warning" i]';
    for (const n of document.querySelectorAll(sels)) {
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = (n.textContent || '').toLowerCase().replace(/\s+/g, ' ');
      if (/no\s+disponible|not\s+available|sin\s+disponibilidad|no\s+operativ|servicio\s+cerrado/.test(t)) return t.slice(0, 160);
    }
    return null;
  }).catch(() => null);
  if (alerta) {
    throw Object.assign(new Error('DISPONIBILIDAD (estacional): ' + alerta), { estacional: true });
  }
  log('FASE 3.6a OK — precios reemplazados (quedan en 999)');
}

async function faseOcultarPrecios(fp) {
  // Zoom 75%: la guia lo exige para que entren todos los controles en pantalla.
  await fp.evaluate(() => { document.documentElement.style.zoom = '0.75'; }).catch(() => {});

  // "Mostrar precios" no esta en el itinerario: cuelga de DETALLES DE BOOKING ->
  // Configuracion general.
  const entro = await abrirItemMenu(
    fp,
    /^\s*detalles\s+de\s+booking\s*$/i,
    /^\s*configuraci[oó]n\s+general\s*$/i,
    'Configuracion general'
  );
  await captura(fp, '19_analisis'); await volcarElementos(fp, 'analisis');
  if (!entro) {
    log('  ! No pude llegar a Configuracion general — el booking queda CON precios visibles');
    await fp.evaluate(() => { document.documentElement.style.zoom = '1'; }).catch(() => {});
    log('FASE 3.6b incompleta (revisar captura 19)');
    return;
  }

  // Es un campo-lista de Tourplan (input con dropdown propio), no un <select>:
  // por eso selectOption no encontraba ninguna opcion. Se reutiliza el helper
  // que ya resuelve AGENCIA / MONEDA / DIVISION. Codigo "2" = NO.
  const ok = await seleccionarEnLista(fp, 'Mostrar precios', '2');
  log(ok ? '  "Mostrar precios" -> 2 - NO ok'
         : '  ! No pude dejar "Mostrar precios" en NO — la cotizacion saldria CON precios');

  await fp.evaluate(() => { document.documentElement.style.zoom = '1'; }).catch(() => {});
  await captura(fp, '19b_mostrar_precios');
  log('FASE 3.6b hecha');
}

async function faseGuardarYCerrar(fp, page, refAntes) {
  // Sin timeout, este click colgaba 30 segundos: getByRole enganchaba el primer
  // boton que dijera "guardar" aunque estuviera tapado. Se prioriza el tpsave de
  // la pantalla (y se excluye tpsaveall, que es otro boton).
  let guardar = fp.locator('button[class*="tpsave" i]:not([class*="tpsaveall" i])').last();
  if (!(await guardar.count().catch(() => 0))) {
    guardar = fp.getByRole('button', { name: /^\s*guardar\s*$/i }).last();
  }
  if (await guardar.count().catch(() => 0)) {
    await guardar.click({ timeout: 10000, force: true })
      .then(() => log('  Cambios guardados'))
      .catch((e) => log('  ! No pude clickear Guardar: ' + String(e.message).split('\n')[0].slice(0, 60)));
    await esperarApp(fp); await sleep(1500); await cerrarModalSiAparece(fp);
  } else {
    log('  ! No encontre el boton Guardar final');
  }
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
      log: bitacoraTexto(),
    }, null, 1));
    process.exit(0);
  }

  // HEADLESS: en tu PC va visible (para ver/depurar). En AWS (sin pantalla) tiene
  // que ir headless → se activa con TP_HEADLESS=true en el .env del servidor.
  // slowMo solo en modo visible; en headless corre a full para no perder tiempo.
  const headless = /^true|1|si$/i.test(process.env.TP_HEADLESS || '');
  const argsBase = ['--disable-features=Translate,TranslateUI', '--lang=es-CL'];
  const argsHeadless = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']; // requeridos en contenedores/AWS

  let browser;
  // En headless conviene el Chromium empaquetado de Playwright (no depende del
  // Chrome del sistema, que en un server no esta). En visible, el Chrome del sistema.
  const canales = headless ? [undefined, 'chrome'] : ['chrome', 'msedge', undefined];
  for (const ch of canales) {
    try {
      browser = await chromium.launch({
        headless,
        slowMo: headless ? 0 : 120,
        channel: ch,
        args: headless ? [...argsBase, ...argsHeadless] : argsBase,
      });
      log(`Navegador: ${headless ? 'HEADLESS' : 'visible'} (${ch ?? 'chromium empaquetado'})`);
      break;
    } catch { /* siguiente */ }
  }
  if (!browser) { console.error('Sin navegador'); process.exit(1); }
  // Viewport ANCHO: Tourplan es mas ancho que 1600px y corta botones a la derecha
  // (ej. "Insertar booking"). La guia menciona zoom 75% "para visibilidad total de
  // los controles" — aca se resuelve con una ventana ancha, mas confiable.
  const context = await browser.newContext({ viewport: { width: 2200, height: 1050 } });
  const page = await context.newPage();
  page.on('dialog', async d => { log(`  [dialog] ${d.type()}: ${d.message().slice(0, 100)}`); await d.accept().catch(() => {}); });

  let fitsPage = page;
  let ultimaRef = null;   // fuera del try: el catch (error) tambien la necesita
  try {
    await login(page);
    await captura(page, '09_home'); await volcarElementos(page, 'home');

    // Protocolo de disponibilidad de la guia V4 (seccion 4). Ya no son 7 intentos
    // a ciegas corriendo la fecha: son 4 pasos con un proposito cada uno.
    //   1) la fecha que pidio el pasajero
    //   2) +1 dia
    //   3) +2 dias   (la guia permite "hasta 2 intentos desplazando la fecha")
    //   4) vuelta a la fecha ORIGINAL, y si valida, se ocultan las fechas para
    //      poder mandar igual la cotizacion
    // Si despues de eso siguen las lineas rojas -> abortar y derivar a Taylor Made.
    const PLAN = [
      { dias: 0, ocultarFechas: false, nota: 'fecha pedida' },
      { dias: 1, ocultarFechas: false, nota: '+1 dia' },
      { dias: 2, ocultarFechas: false, nota: '+2 dias' },
      { dias: 0, ocultarFechas: true,  nota: 'fecha original, ocultando fechas' },
    ];
    let exito = false, refFinal = null, fechaUsada = null, fechasOcultas = false;
    for (let i = 0; i < PLAN.length && !exito; i++) {
      const paso  = PLAN[i];
      const fecha = fechaIntento(CFG.fechaViaje, paso.dias);
      log(`\n===== INTENTO ${i + 1}/${PLAN.length} — ${paso.nota} (${fecha}) =====`);
      try {
        fitsPage = await faseNavegarFits(page, context);
        await faseNuevoBooking(fitsPage);
        await faseCamposIniciales(fitsPage, fecha);
        await faseHabitaciones(fitsPage);
        const ref = await capturarReferencia(fitsPage);   // se asigna al abrir el modal
        ultimaRef = ref;                                  // se recuerda por si algo falla despues de guardar
        await faseGuardarBooking(fitsPage);
        if (SKIP_35) {
          log('  ⏭ TP_SKIP_35 (DEMO): salteo clon 3.5 + precios → voy directo al backend con la ref ' + ref);
          refFinal = ref; fechaUsada = fecha; exito = true; break;
        }
        await faseInsertarServicios(fitsPage);
        await faseValidarLineas(fitsPage);                // 3.7 — blancas o rojas
        await faseReemplazarPrecios(fitsPage);
        await faseOcultarPrecios(fitsPage);
        if (paso.ocultarFechas) { await faseOcultarFechas(fitsPage); fechasOcultas = true; }
        refFinal = await faseGuardarYCerrar(fitsPage, page, ref);
        fechaUsada = fecha;
        exito = true;
      } catch (e) {
        if (e.estacional && i < PLAN.length - 1) {
          log(`  Sin disponibilidad en ${fecha} — paso al siguiente intento: ${PLAN[i + 1].nota}`);
          if (fitsPage !== page && !fitsPage.isClosed()) await fitsPage.close().catch(() => {});
          continue;
        }
        throw e;
      }
    }

    if (exito) {
      log(`\n✅ CLONACION COMPLETA. Referencia nueva: ${refFinal ?? '(no detectada, ver capturas)'}`);

      // PASO 4 — backend: con la referencia recien creada, generar el link del itinerario.
      // Si algo falla, NO se pierde la clonacion: se guarda OK igual y el link queda pendiente.
      let linkItinerario = null, backendMotivo = null;
      const refBackend = refFinal ?? ultimaRef;
      if (refBackend) {
        log(`Paso 4 (backend): generando link para ref ${refBackend} → ${CFG.backendLink} / ${CFG.idiomaBackend}...`);
        const rb = await generarLink(browser, {
          referencia: refBackend,
          site: siteDesdeBackendLink(CFG.backendLink),
          idioma: CFG.idiomaBackend,
        }).catch(e => ({ estado: 'ERROR', motivo: String(e.message).split('\n')[0] }));
        if (rb.estado === 'OK' && rb.link) { linkItinerario = rb.link; log(`  ✅ Link: ${linkItinerario}`); }
        else { backendMotivo = rb.motivo || rb.estado; log(`  ⚠ Backend sin link: ${backendMotivo}`); }
      }

      fs.writeFileSync('resultado.json', JSON.stringify({
        leadId: CFG.leadId, estado: 'OK', referencia: refFinal,
        backendLink: CFG.backendLink, idioma: CFG.idiomaBackend,
        linkItinerario, backendMotivo,
        // V4: si el robot corrio la fecha o escondio las fechas, el vendedor
        // tiene que enterarse ANTES de mandarle la cotizacion al pasajero.
        fechaViajeUsada: ddmmaaAIso(fechaUsada),
        fechasOcultas,
        log: bitacoraTexto(),
      }, null, 1));
    } else {
      log('\n🛑 Sin disponibilidad tras todos los intentos → protocolo "Taylor Made": abortar y derivar a venta especializada.');
      fs.writeFileSync('resultado.json', JSON.stringify({
        leadId: CFG.leadId, estado: 'SIN_DISPONIBILIDAD',
        motivo: 'Sin disponibilidad en la fecha pedida, +1 dia, +2 dias ni ocultando fechas (guia V4 seccion 4)',
        fechasOcultas,
        log: bitacoraTexto(),
      }, null, 1));
    }
  } catch (e) {
    console.error('\nERROR:', e.message.split('\n')[0]);
    const p = (fitsPage && !fitsPage.isClosed()) ? fitsPage : page;
    await captura(p, '90_error'); await volcarElementos(p, 'error');
    log('El robot se detuvo AQUI — la captura 90 + JSON muestran la pantalla exacta para ajustar el selector.');
    fs.writeFileSync('resultado.json', JSON.stringify({
      // Si el booking ya se habia guardado (falla despues, ej. paso 3.5), igual
      // dejamos la referencia para no perder la reserva creada en Tourplan.
        /* Un fallo de DISPONIBILIDAD no es un error tecnico: es el desenlace que
           preve la guia V4 cuando el ultimo intento sigue con lineas rojas.
           Marcarlo como ERROR hacia que Salesforce lo tratara como falla del robot
           y el pasajero NO recibiera el mensaje Taylor Made: se quedaba esperando
           una cotizacion que nunca iba a llegar. */
        leadId: CFG.leadId,
        estado: (e && e.estacional === true) ? 'SIN_DISPONIBILIDAD' : 'ERROR',
        referencia: ultimaRef,
        motivo: e.message.split(String.fromCharCode(10))[0],
      log: bitacoraTexto(),
    }, null, 1));
  } finally {
    if (fitsPage !== page && fitsPage && !fitsPage.isClosed()) await fitsPage.close().catch(() => {});
    if (!page.isClosed()) await logout(page);
    await browser.close();
  }
}

main();
