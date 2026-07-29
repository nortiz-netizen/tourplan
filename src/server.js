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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { leadATourplan } from './mapeo.js';
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
  res.json({ ok: true, enCola: cola.length, procesando, resultadosListos: resultados.length });
});

async function procesarCola() {
  if (procesando || cola.length === 0) return;
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
      r = ejecutarRobot(datos);
    }
    resultados.push({ leadId: id, ...r });
    log(`  -> ${id}: ${r.estado}${r.referencia ? ' / ' + r.referencia : ''}`);
  } catch (e) {
    resultados.push({ leadId: id, estado: 'ERROR', motivo: String(e.message).slice(0, 400) });
    log(`  -> ${id}: ERROR ${String(e.message).split('\n')[0]}`);
  } finally {
    procesando = false;
    if (cola.length) procesarCola();   // el siguiente, de a uno
  }
}

function ejecutarRobot(datos) {
  fs.writeFileSync('datos-entrada.json', JSON.stringify(datos, null, 1));
  if (fs.existsSync('resultado.json')) fs.unlinkSync('resultado.json');
  const p = spawnSync(process.execPath, ['src/clonar.js', '--datos', 'datos-entrada.json'], { encoding: 'utf8', stdio: 'inherit' });
  if (fs.existsSync('resultado.json')) return JSON.parse(fs.readFileSync('resultado.json', 'utf8'));
  return { estado: 'ERROR', motivo: `El robot no dejo resultado (exit ${p.status})` };
}

app.listen(PORT, () => log(`Scraper HTTP escuchando en :${PORT} (auth: ${TOKEN ? 'token ON' : 'SIN TOKEN ⚠'})`));
