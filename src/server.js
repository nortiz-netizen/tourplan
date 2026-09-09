/**
 * SERVIDOR HTTP del scraper — modelo "conexion por Apex".
 * Salesforce Apex le MANDA leads (POST /procesar) y despues le PIDE los resultados
 * (GET /resultados). El scraper NO toca Salesforce ni guarda credenciales: solo
 * scrapea Tourplan y entrega el resultado cuando se lo piden. Salesforce escribe
 * el resultado en el Lead desde Apex.
 *
 * Single-session de Tourplan: procesa DE A UNO (cola interna, nunca en paralelo).
 * Auth: header  X-Auth-Token: <SCRAPER_TOKEN>  (del .env).
 *
 * Rutas:
 *   POST /procesar   body = {campos del lead}  -> encola, devuelve {estado:'encolado'}
 *   GET  /resultados                           -> devuelve y LIMPIA los resultados listos
 *   GET  /estado                               -> salud + tamano de cola (sin token)
 *
 * Correr:  npm run server   (o node src/server.js)
 */
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { leadATourplan } from './mapeo.js';
import { generarLink } from './backend.js';
dotenv.config();

const PORT  = parseInt(process.env.SCRAPER_PORT || '3000', 10);
const TOKEN = process.env.SCRAPER_TOKEN || '';
const log   = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const app = express();
app.use(express.json({ limit: '256kb' }));

// --- Auth por token compartido (menos /estado, que es healthcheck) ---
app.use((req, res, next) => {
  if (req.path === '/estado') return next();
  const t = req.get('X-Auth-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ error: 'no autorizado' });
  next();
});

// --- Cola en memoria: single-session, de a UNO ---
const cola = [];
const resultados = [];
let procesando = false;

/**
 * Pausa tras un login fallido — guia V4, seccion 2: "esperar 10 minutos antes de
 * reiniciar el ciclo". clonar.js ya hizo sus 2 intentos en 1 minuto y no entro.
 *
 * Se pausa la COLA ENTERA, no solo ese lead: si Tourplan no tiene licencia libre,
 * el lead siguiente tampoco va a entrar, y seguir intentando cada pocos segundos no
 * consigue licencia — solo le compite el turno al resto del equipo, que son 120-130
 * personas para 75 licencias.
 *
 * El lead que fallo NO se vuelve a encolar aca a proposito. Salesforce lo devuelve a
 * PENDIENTE al leer el resultado y lo reenvia en su proximo ciclo. Reencolarlo aca
 * ademas lo haria correr dos veces, que es justamente el problema de doble disparo
 * que ya arrastramos.
 */
const PAUSA_LOGIN_MS = 10 * 60_000;
let pausadoHasta = 0;

app.post('/procesar', (req, res) => {
  const lead = req.body || {};
  const id = lead.Id || lead.leadId;
  if (!id) return res.status(400).json({ error: 'falta el Id del lead' });
  cola.push(lead);
  log(`+ encolado ${id} (${cola.length} en cola)`);
  procesarCola();
  res.json({ estado: 'encolado', enCola: cola.length });
});

app.get('/resultados', (req, res) => {
  const entrega = resultados.splice(0, resultados.length);
  res.json({ resultados: entrega });
});

app.get('/estado', (req, res) => {
  // pausaLoginSeg se expone para no tener que leer el journal del servicio para
  // saber por que la cola no avanza: es la pregunta que uno se hace primero.
  const pausaSeg = Math.max(0, Math.ceil((pausadoHasta - Date.now()) / 1000));
  res.json({
    ok: true, enCola: cola.length, procesando,
    resultadosListos: resultados.length,
    pausaLoginSeg: pausaSeg,
  });
});

/**
 * POST /link  body = { referencia, site?, idioma? }  -> { estado, link?, motivo? }
 *
 * Reintento del paso 4 para una reserva YA clonada. Existe porque el backend de
 * Say Hueque no publica las reservas al instante: clonar.js pide el link tres
 * segundos despues de crearla y ahi todavia no esta, asi que el Lead queda con la
 * referencia y sin link para siempre. Con esto Salesforce puede volver a pedirlo
 * mas tarde, en su ciclo, hasta que el backend la publique.
 *
 * Se respeta el modelo del server: el scraper NO toca Salesforce. Solo abre el
 * navegador, consulta el backend y devuelve lo que encontro; quien guarda es Apex.
 */
app.post('/link', async (req, res) => {
  const { referencia, site, idioma } = req.body || {};
  if (!referencia) return res.status(400).json({ error: 'falta la referencia' });

  // No se pisa una corrida del robot: Tourplan es single-session y el backend usa
  // el mismo navegador. Si esta clonando, que Salesforce reintente en el proximo ciclo.
  if (procesando) return res.json({ estado: 'OCUPADO', motivo: 'El robot esta clonando; reintentar en el proximo ciclo' });

  let browser;
  try {
    browser = await chromium.launch({
      headless: /^(true|1|si)$/i.test(process.env.TP_HEADLESS || ''),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const r = await generarLink(browser, {
      referencia,
      site: site || 'sayhueque',
      idioma: idioma || 'EN',
    });
    log(`  /link ${referencia} -> ${r.estado}${r.link ? ' / ' + r.link : ''}`);
    res.json(r);
  } catch (e) {
    log(`  /link ${referencia} -> ERROR ${String(e.message).split('\n')[0]}`);
    res.json({ estado: 'ERROR', motivo: String(e.message).split('\n')[0] });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

async function procesarCola() {
  if (procesando || cola.length === 0) return;
  // En pausa por login fallido: los leads quedan en la cola y salen solos cuando
  // vence la espera. No se pierde ninguno.
  if (Date.now() < pausadoHasta) return;
  procesando = true;
  const lead = cola.shift();
  const id = lead.Id || lead.leadId;
  try {
    const datos = leadATourplan(lead);
    let r;
    if (datos.lujo) {
      r = { estado: 'LUJO_SIN_PROCESAR', motivo: 'Palabras clave de lujo: ' + (datos.lujoMotivo || []).join(', ') };
    } else if (!datos.fileOrigen) {
      r = { estado: 'SIN_PLANTILLA', motivo: 'Sin plantilla para el destino' };
    } else {
      r = await ejecutarRobot(datos);
    }
    resultados.push({ leadId: id, ...r });
    log(`  -> ${id}: ${r.estado}${r.referencia ? ' / ' + r.referencia : ''}`);

    if (r.estado === 'LOGIN_FALLIDO') {
      pausadoHasta = Date.now() + PAUSA_LOGIN_MS;
      log(`  ⏸ Login fallido -> cola en pausa ${PAUSA_LOGIN_MS / 60_000} min (guia V4 seccion 2). Salesforce le avisa a IT.`);
      // unref: esta espera no debe impedir que el proceso termine si lo apagan.
      setTimeout(() => {
        pausadoHasta = 0;
        log(`  ▶ Fin de la pausa por login: se reanuda la cola (${cola.length} en espera)`);
        procesarCola();
      }, PAUSA_LOGIN_MS).unref();
    }
  } catch (e) {
    resultados.push({ leadId: id, estado: 'ERROR', motivo: String(e.message).slice(0, 400) });
    log(`  -> ${id}: ERROR ${String(e.message).split('\n')[0]}`);
  } finally {
    procesando = false;
    if (cola.length) procesarCola();   // el siguiente, de a uno
  }
}

// spawn ASINCRONO (no spawnSync): NO bloquea el event loop, asi el server sigue
// respondiendo /estado y /resultados mientras el scraper corre. Devuelve una Promise.
function ejecutarRobot(datos) {
  return new Promise((resolve) => {
    fs.writeFileSync('datos-entrada.json', JSON.stringify(datos, null, 1));
    if (fs.existsSync('resultado.json')) fs.unlinkSync('resultado.json');
    const p = spawn(process.execPath, ['src/clonar.js', '--datos', 'datos-entrada.json'], { stdio: 'inherit' });
    p.on('close', (code) => {
      if (fs.existsSync('resultado.json')) resolve(JSON.parse(fs.readFileSync('resultado.json', 'utf8')));
      else resolve({ estado: 'ERROR', motivo: `El robot no dejo resultado (exit ${code})` });
    });
    p.on('error', (e) => resolve({ estado: 'ERROR', motivo: String(e.message).split('\n')[0] }));
  });
}

app.listen(PORT, () => log(`Scraper HTTP escuchando en :${PORT} (auth: ${TOKEN ? 'token ON' : 'SIN TOKEN ⚠'})`));
