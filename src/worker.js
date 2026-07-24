/**
 * WORKER — el puente Salesforce → robot Tourplan.
 *
 * Corre como servicio: cada X segundos le pregunta a Salesforce si hay Leads
 * esperando cotizacion, los procesa DE A UNO (arma el JSON y ejecuta el robot),
 * y escribe el resultado de vuelta en cada Lead.
 *
 * POR QUE COLA Y NO WEBHOOK (decision de diseño):
 *   Tourplan tiene 75 licencias concurrentes y NO permite 2 pestañas de FITs a
 *   la vez. Un webhook podria recibir 5 leads simultaneos y romper todo. La cola
 *   garantiza que el robot procese DE A UNO, a su ritmo. Ademas no hay que
 *   exponer el robot a internet (menos superficie de ataque) y los reintentos
 *   salen gratis: si algo falla, el lead sigue en la cola.
 *
 * POR QUE NO setInterval:
 *   Procesar un lead puede tardar MAS que el intervalo (abre un browser). Con
 *   setInterval dos ciclos se solaparian y abririan DOS scrapers a la vez → mata
 *   la sesion unica de Tourplan. Por eso el loop espera a que TERMINE el ciclo y
 *   recien ahi cuenta el intervalo.
 *
 * Ejecutar (servicio):         npm run worker
 * Una sola vuelta (probar):    npm run worker -- --una-vez
 * Sin abrir Tourplan (mapeo):  npm run worker -- --una-vez --simular
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { leadATourplan } from './mapeo.js';
dotenv.config();

const ORG          = process.env.SF_ORG || 'sayhueque-sb';
const INTERVALO_MS = parseInt(process.env.WORKER_INTERVALO_MS || '60000', 10);
const UNA_VEZ      = process.argv.includes('--una-vez');
const SIMULAR      = process.argv.includes('--simular');   // no abre Tourplan, solo muestra el mapeo
const LOTE         = parseInt(process.env.WORKER_LOTE || '5', 10);  // cuantos pendientes agarra por ciclo

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log   = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** Campos que el robot necesita del Lead. */
const CAMPOS = [
  'Id', 'FirstName', 'LastName', 'Email', 'LeadSource', 'Language__c',
  'Number_of_Passengers__c', 'Trip_Start_Date__c', 'Trip_End_Date__c',
  'Trip_Duration__c', 'Destinations_of_Interest__c', 'Customer_Type__c',
  'Tipo_de_viaje__c', 'Description', 'Company',
  'Estado_Clonacion__c', 'File_Origen_Clonacion__c', 'Referencia_Tourplan__c',
  'Agencia_Tourplan__c',
].join(', ');

/**
 * Leads listos para clonar: los de Valentin, no convertidos, marcados PENDIENTE
 * (o sin estado todavia). Apenas Valentin crea un lead, el flow lo deja PENDIENTE
 * y el worker lo detecta en la proxima vuelta. El propio worker va marcando
 * EN_PROCESO/OK/ERROR/SIN_PLANTILLA, asi nunca reprocesa el mismo.
 */
function leadsPendientes(limite = LOTE) {
  const soql = `SELECT ${CAMPOS} FROM Lead ` +
    `WHERE LeadSource = 'Valentín' AND IsConverted = false ` +
    `AND (Estado_Clonacion__c = null OR Estado_Clonacion__c = 'PENDIENTE') ` +
    `ORDER BY CreatedDate ASC LIMIT ${limite}`;
  // La query va por ARCHIVO: en Windows las comillas y los acentos se rompen
  // si se pasa como argumento con shell.
  const tmp = '.soql-tmp.soql';
  fs.writeFileSync(tmp, soql, 'utf8');
  try {
    const out = execFileSync('sf', [
      'data', 'query', '--file', tmp, '--target-org', ORG, '--json',
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: true });
    return JSON.parse(out)?.result?.records ?? [];
  } catch (e) {
    log('⚠ No pude consultar Salesforce: ' + String(e.message).split('\n')[0]);
    return [];
  } finally {
    fs.existsSync(tmp) && fs.unlinkSync(tmp);
  }
}

/** Ejecuta el robot con los datos ya mapeados. Devuelve el resultado.json. */
function ejecutarRobot(datos) {
  fs.writeFileSync('datos-entrada.json', JSON.stringify(datos, null, 1));
  if (fs.existsSync('resultado.json')) fs.unlinkSync('resultado.json');

  const r = spawnSync(process.execPath, ['src/clonar.js', '--datos', 'datos-entrada.json'], {
    encoding: 'utf8', stdio: 'inherit',
  });
  if (fs.existsSync('resultado.json')) {
    return JSON.parse(fs.readFileSync('resultado.json', 'utf8'));
  }
  return { estado: 'ERROR', motivo: `El robot no dejo resultado (exit ${r.status})` };
}

/**
 * Escribe el resultado de vuelta en el Lead (estado + referencia + log).
 *
 * VIA APEX A PROPOSITO (no `sf data update record`):
 *   La REST API de Salesforce, por defecto, RE-EJECUTA la regla de asignacion en
 *   cada update de Lead (Sforce-Auto-Assign: true). Es decir: cada writeback de
 *   estado le robaba el lead al vendedor asignado (Izabela) y lo mandaba a la cola
 *   por defecto ("Formularios"). El DML de Apex NO aplica reglas de asignacion, asi
 *   que el owner se respeta. Bonus: al ir por --file (un archivo .apex) desaparece
 *   todo el problema de comillas/espacios en el shell de Windows.
 */
function guardarResultado(leadId, resultado) {
  if (!leadId) return;
  // Escape para literal de string de Apex: backslash y comilla simple.
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ');
  const sets = [`Estado_Clonacion__c='${esc(resultado.estado)}'`];
  if (resultado.referencia)     sets.push(`Referencia_Tourplan__c='${esc(resultado.referencia)}'`);
  if (resultado.linkItinerario) sets.push(`Link_Itinerario__c='${esc(resultado.linkItinerario)}'`);
  sets.push('Fecha_Clonacion__c=Datetime.now()');
  if (resultado.motivo) {
    sets.push(`Log_Clonacion__c='${esc(String(resultado.motivo).replace(/\s+/g, ' ').trim().slice(0, 480))}'`);
  }
  const apex = `update new Lead(Id='${leadId}', ${sets.join(', ')});`;
  const tmp = '.writeback.apex';
  fs.writeFileSync(tmp, apex, 'utf8');
  try {
    const out = execFileSync('sf', [
      'apex', 'run', '--file', tmp, '--target-org', ORG, '--json',
    ], { encoding: 'utf8', shell: true });
    const r = JSON.parse(out)?.result;
    if (r && r.success === false) {
      log(`  ⚠ El writeback Apex no se ejecuto: ${(r.exceptionMessage || r.compileProblem || 'ver org').split('\n')[0]}`);
    } else {
      log(`  ✓ Lead actualizado → ${resultado.estado}${resultado.referencia ? ' / ' + resultado.referencia : ''}`);
    }
  } catch (e) {
    log(`  ⚠ No pude escribir en el Lead: ${String(e.message).split('\n')[0]}`);
  } finally {
    fs.existsSync(tmp) && fs.unlinkSync(tmp);
  }
}

/**
 * Procesa UN lead: lo mapea, aplica los frenos (lujo / sin plantilla) y, si esta
 * todo, ejecuta el robot. Devuelve el estado final (para el log del ciclo).
 */
function procesarLead(lead) {
  const datos = leadATourplan(lead);

  log(`Lead ${lead.Id} — ${datos.paxNombre} | ${datos.paxCantidad} pax | ${datos.destinos || 'sin destino'} | ${datos.fechaViaje}`);
  log(`  habitaciones: ${datos.habitaciones.dobles} doble(s) + ${datos.habitaciones.singles} single(s)`);
  log(`  Tourplan → agencia:${datos.agencia || '(usa .env)'} moneda:${datos.moneda} division:${datos.division} depto:${datos.depto}`);
  log(`  backend: ${datos.backendLink} · idioma itinerario: ${datos.idiomaBackend} · file: ${datos.fileOrigen || '(sin plantilla)'}`);

  // FRENO 1 — pasajero de lujo: no se cotiza automatico, va a supervision manual.
  if (datos.lujo) {
    log(`  🛑 LUJO (${datos.lujoMotivo.join(', ')}) → supervision manual`);
    if (!SIMULAR) guardarResultado(lead.Id, {
      estado: 'LUJO_SIN_PROCESAR',
      motivo: `Palabras clave de lujo detectadas: ${datos.lujoMotivo.join(', ')}`,
    });
    return 'LUJO_SIN_PROCESAR';
  }

  // FRENO 2 — sin file que clonar: el destino todavia no tiene Plantilla_Tourplan__c.
  // No es un error: se marca SIN_PLANTILLA para no reprocesarlo en loop. Cuando Say
  // cargue la plantilla del destino y re-marque PENDIENTE, el worker lo retoma.
  if (!datos.fileOrigen) {
    log('  ⚠ Sin file origen (el destino no matcheo ninguna Plantilla_Tourplan__c) → SIN_PLANTILLA');
    if (!SIMULAR) guardarResultado(lead.Id, {
      estado: 'SIN_PLANTILLA',
      motivo: `Sin plantilla para el destino "${datos.destinos || datos.resumen || '?'}". Cargar Plantilla_Tourplan__c y re-marcar PENDIENTE.`,
    });
    return 'SIN_PLANTILLA';
  }

  if (SIMULAR) {
    log('  [simular] no se ejecuta Tourplan. Datos mapeados:\n' + JSON.stringify(datos, null, 1));
    return 'SIMULADO';
  }

  // Claim: marca EN_PROCESO antes de abrir el browser, para que ninguna otra
  // corrida (ni el proximo ciclo) tome el mismo lead.
  guardarResultado(lead.Id, { estado: 'EN_PROCESO' });
  const resultado = ejecutarRobot(datos);
  log(`  Resultado robot: ${resultado.estado}${resultado.referencia ? ' → ' + resultado.referencia : ''}${resultado.motivo ? ' (' + resultado.motivo + ')' : ''}`);
  guardarResultado(lead.Id, resultado);
  return resultado.estado;
}

/** Una vuelta del servicio: trae los pendientes y los procesa de a uno. */
async function unaVuelta(ciclo) {
  const leads = leadsPendientes();
  if (!leads.length) { log(`Ciclo ${ciclo}: sin leads pendientes.`); return; }

  log(`Ciclo ${ciclo}: ${leads.length} lead(s) pendiente(s). Procesando de a uno…`);
  // DE A UNO Y EN SERIE: la restriccion de sesion unica de Tourplan lo exige.
  for (const lead of leads) {
    try {
      procesarLead(lead);
    } catch (e) {
      log(`  ⚠ Error procesando ${lead.Id}: ${String(e.message).split('\n')[0]}`);
      if (!SIMULAR) guardarResultado(lead.Id, { estado: 'ERROR', motivo: String(e.message).slice(0, 400) });
    }
  }
}

async function main() {
  log(`Worker iniciado — org ${ORG}, cada ${INTERVALO_MS / 1000}s${SIMULAR ? ' [SIMULACION]' : ''}${UNA_VEZ ? ' [una vez]' : ''}`);
  let ciclo = 0;
  // Loop con espera AL FINAL de cada ciclo: nunca se solapan dos corridas.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    ciclo++;
    try {
      await unaVuelta(ciclo);
    } catch (e) {
      log(`⚠ Fallo el ciclo ${ciclo}: ${String(e.message).split('\n')[0]}`);
    }
    if (UNA_VEZ) break;
    await sleep(INTERVALO_MS);
  }
}

main();
