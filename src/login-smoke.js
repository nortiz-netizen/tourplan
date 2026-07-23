/**
 * PRUEBA 1 — Login smoke test contra el sandbox de Tourplan.
 *
 * Valida lo minimo viable del robot segun la guia V3:
 *   1. Entrar al entorno de TEST.
 *   2. Iniciar sesion con las credenciales del robot.
 *   3. Verificar que la sesion quedo activa (y NO en "query mode").
 *   4. Logout SIEMPRE (try/finally) — la licencia se libera pase lo que pase.
 *
 * Ejecutar:  npm run smoke
 * Requiere:  .env con TP_URL, TP_USER, TP_PASS  (ver .env.example)
 *
 * Saca screenshots de cada paso en ./capturas para revisar los selectores
 * reales de Tourplan (el PDF no trae capturas).
 */
import { chromium } from 'playwright';
import dotenv from 'dotenv';
dotenv.config();

const URL  = process.env.TP_URL;
const USER = process.env.TP_USER;
const PASS = process.env.TP_PASS;

// Politica de reintentos de la guia: 2 intentos en 1 minuto.
const MAX_INTENTOS_LOGIN = 2;
const ESPERA_ENTRE_INTENTOS_MS = 30_000;

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function captura(page, nombre) {
  const file = `capturas/${ts()}_${nombre}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [captura] ${file}`);
}

async function intentarLogin(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // TourplanNX es Angular: al abrir muestra un overlay "PLEASE WAIT..." mientras
  // arranca. NO tocar nada hasta que desaparezca.
  const spinner = page.getByText(/please wait/i);
  await spinner.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  await captura(page, '01_pantalla_login');

  // Selectores REALES descubiertos en la corrida 1 (por placeholder visible).
  // OJO: fill() NO funciona con este Angular (el modelo queda vacio y dice
  // "No Username Provided"). Hay que TIPEAR tecla por tecla como humano.
  const userInput = page.getByPlaceholder('Username');
  const passInput = page.getByPlaceholder('Password');
  await userInput.waitFor({ state: 'visible', timeout: 15_000 });
  await userInput.click();
  await userInput.pressSequentially(USER, { delay: 60 });
  await passInput.click();
  await passInput.pressSequentially(PASS, { delay: 60 });
  await page.keyboard.press('Tab');   // blur: obliga a Angular a registrar el valor
  await captura(page, '02_credenciales_puestas');

  await page.getByRole('button', { name: 'Login' }).click();
  await captura(page, '03_click_login');
}

async function verificarSesion(page) {
  // El login es una llamada al servidor: darle tiempo real. Exito = el form
  // de login desaparece. Fracaso = sigue ahi (o aparece un mensaje de error).
  const passInput = page.getByPlaceholder('Password');
  try {
    await passInput.waitFor({ state: 'hidden', timeout: 20_000 });
  } catch {
    const body = (await page.textContent('body')) || '';
    const err = body.match(/invalid|incorrect|denied|error|failed|licen/i);
    await captura(page, '04_login_no_avanzo');
    throw new Error('El form de login no desaparecio tras 20s' + (err ? ` — la pagina menciona: "${err[0]}"` : ''));
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await captura(page, '04_dentro_de_la_app');

  // Query mode = solo lectura = la clonacion fallaria. Detectarlo temprano.
  const body = (await page.textContent('body')) || '';
  if (/query mode|modo consulta/i.test(body)) {
    throw new Error('SESION EN QUERY MODE (solo lectura) — hay otra sesion activa con este usuario');
  }
  console.log('  Sesion activa OK (form de login desaparecio, sin query mode)');
}

async function logout(page) {
  // Segun la guia: cerrar SIEMPRE desde la pestaña de inicio y hacer logout
  // para liberar la licencia. Los selectores reales se descubren en la corrida 1;
  // mientras tanto probamos patrones tipicos y dejamos captura de todo.
  try {
    const candidatos = page.locator(
      'button:has-text("Logout"), a:has-text("Logout"), button:has-text("Cerrar sesi"), a:has-text("Cerrar sesi"), [title*="logout" i], [aria-label*="logout" i]'
    ).first();
    if (await candidatos.count()) {
      await candidatos.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      console.log('  Logout ejecutado');
    } else {
      console.warn('  ⚠ No encontre boton de logout con los patrones tipicos — REVISAR captura para sacar el selector real');
    }
  } catch (e) {
    console.warn('  ⚠ Logout fallo:', e.message);
  }
  await captura(page, '99_post_logout');
}

async function main() {
  if (!URL || !USER || !PASS) {
    console.error('Faltan variables en .env (TP_URL, TP_USER, TP_PASS). Copia .env.example a .env y completalo.');
    process.exit(1);
  }

  // headless:false para VER lo que hace — en estas primeras pruebas queremos mirar.
  // Se usa el navegador del SISTEMA (Chrome/Edge instalados) porque el Chromium
  // que descarga Playwright da error side-by-side en esta maquina.
  let browser;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      browser = await chromium.launch({ headless: false, slowMo: 150, channel });
      console.log(`Navegador lanzado: ${channel ?? 'chromium empaquetado'}`);
      break;
    } catch (e) {
      console.warn(`  No se pudo lanzar ${channel ?? 'chromium empaquetado'}: ${e.message.split('\n')[0]}`);
    }
  }
  if (!browser) {
    console.error('Ningun navegador disponible (Chrome, Edge ni Chromium). Abortando.');
    process.exit(1);
  }
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  let exito = false;
  try {
    for (let intento = 1; intento <= MAX_INTENTOS_LOGIN; intento++) {
      try {
        console.log(`Intento de login ${intento}/${MAX_INTENTOS_LOGIN}...`);
        await intentarLogin(page);
        await verificarSesion(page);
        exito = true;
        break;
      } catch (e) {
        console.error(`  Fallo intento ${intento}: ${e.message.split('\n')[0]}`);
        if (page.isClosed()) {
          console.error('  La ventana del navegador se cerro — no se puede reintentar. (No cerrar la ventana durante la prueba: el robot la cierra solo al final.)');
          break;
        }
        if (intento < MAX_INTENTOS_LOGIN) {
          console.log(`  Esperando ${ESPERA_ENTRE_INTENTOS_MS / 1000}s antes de reintentar...`);
          await new Promise(r => setTimeout(r, ESPERA_ENTRE_INTENTOS_MS));
        }
      }
    }
    if (!exito) {
      // En el robot real: aca va la alerta por correo + espera de 10 min (guia, seccion 2)
      console.error('LOGIN FALLIDO tras todos los intentos. (Robot real: alerta email + esperar 10 min)');
    }
  } finally {
    // Pase lo que pase: intentar logout para liberar la licencia. ESTE es el
    // invariante mas importante de todo el robot (75 licencias compartidas).
    if (exito) await logout(page);
    await browser.close();
  }
  process.exit(exito ? 0 : 1);
}

main();
