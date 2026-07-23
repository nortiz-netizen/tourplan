/**
 * WORKER — el puente Salesforce → robot Tourplan.
 *
 * Cada X segundos le pregunta a Salesforce si hay Leads esperando cotizacion,
 * toma UNO, lo traduce a inputs de Tourplan y ejecuta el robot. Al terminar,
 * escribe el resultado de vuelta en el Lead.
 *
 * POR QUE COLA Y NO WEBHOOK (decision de diseño):
 *   Tourplan tiene 75 licencias concurrentes y NO permite 2 pestañas de FITs a
 *   la vez. Un webhook podria recibir 5 leads simultaneos y romper todo. La cola
 *   garantiza que el robot procese DE A UNO, a su ritmo. Ademas no hay que
 *   exponer el robot a internet (menos superficie de ataque) y los reintentos
 *   salen gratis: si algo falla, el lead sigue en la cola.
 *
 * Ejecutar:  npm run worker
 * Una sola vuelta (para probar):  npm run worker -- --una-vez
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { leadATourplan } from './mapeo.js';
dotenv.config();

const ORG            = process.env.SF_ORG    || 'sayhueque-sb';
const INTERVALO_MS   = parseInt(process.env.WORKER_INTERVALO_MS || '60000', 10);
const UNA_VEZ        = process.argv.includes('--una-vez');
const SIMULAR        = process.argv.includes('--simular');   // no abre Tourplan, solo muestra el mapeo

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

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
 * Leads pendientes de cotizar.
 * ⚠️ El filtro definitivo depende de como Say quiera marcar "listo para cotizar".
 * Hoy toma los Leads creados por Valentin que aun no tienen cotizacion.
 * Cuando exista el campo de control (ej. Estado_Clonacion__c), se cambia ACA.
 */
function leadsPendientes(limite = 5) {
  // Toma solo los marcados PENDIENTE: asi Say controla que se cotiza y cuando,
  // y el robot nunca reprocesa un lead ya resuelto.
  const soql = `SELECT ${CAMPOS} FROM Lead ` +
    `WHERE Estado_Clonacion__c = 'PENDIENTE' AND IsConverted = false ` +
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
 * Escribe el resultado de vuelta en Salesforce.
 * ⚠️ Requiere campos en el Lead para guardar la referencia/estado. Mientras no
 * existan, solo lo deja en el log (no rompe nada).
 */
function guardarResultado(leadId, resultado) {
  if (!leadId) return;
  const campos = [`Estado_Clonacion__c=${resultado.estado}`];
  if (resultado.referencia) campos.push(`Referencia_Tourplan__c=${resultado.referencia}`);
  if (resultado.linkItinerario) campos.push(`Link_Itinerario__c=${resultado.linkItinerario}`);
  campos.push(`Fecha_Clonacion__c=${new Date().toISOString()}`);
  if (resultado.motivo) {
    // Las comillas rompen el parser de --values: se limpian.
    campos.push(`Log_Clonacion__c="${String(resultado.motivo).replace(/["']/g, '').slice(0, 500)}"`);
  }
  try {
    execFileSync('sf', [
      'data', 'update', 'record', '--sobject', 'Lead', '--record-id', leadId,
      '--values', campos.join(' '), '--target-org', ORG, '--json',
    ], { encoding: 'utf8', shell: true });
    log(`  ✓ Lead actualizado → ${resultado.estado}${resultado.referencia ? ' / ' + resultado.referencia : ''}`);
  } catch (e) {
    log(`  ⚠ No pude escribir en el Lead: ${String(e.message).split('\n')[0]}`);
  }
}

async function unaVuelta() {
  const leads = leadsPendientes();
  if (!leads.length) { log('Sin leads pendientes.'); return; }

  // DE A UNO: la restriccion de licencias de Tourplan lo exige.
  const lead = leads[0];
  const datos = leadATourplan(lead);

  log(`Lead ${lead.Id} — ${datos.paxNombre} | ${datos.paxCantidad} pax | ${datos.destinos || 'sin destino'} | ${datos.fechaViaje}`);
  log(`  habitaciones: ${datos.habitaciones.dobles} doble(s) + ${datos.habitaciones.singles} single(s)`);
  log(`  Tourplan → agencia:${datos.agencia || '(FALTA)'} moneda:${datos.moneda} division:${datos.division} depto:${datos.depto}`);
  log(`  backend: ${datos.backendLink} · idioma itinerario: ${datos.idiomaBackend}`);

  if (datos.lujo) {
    log(`  🛑 LUJO (${datos.lujoMotivo.join(', ')}) → sin cotizacion automatica, va a supervision manual`);
    if (!SIMULAR) guardarResultado(lead.Id, {
      estado: 'LUJO_SIN_PROCESAR',
      motivo: `Palabras clave de lujo detectadas: ${datos.lujoMotivo.join(', ')}`,
    });
    return;
  }
  if (!datos.fileOrigen) {
    log('  ⚠ Sin file origen que clonar (File_Origen_Clonacion__c vacio; lo debe entregar la consulta SQL). Se omite.');
    if (!SIMULAR) guardarResultado(lead.Id, {
      estado: 'ERROR', motivo: 'Falta el file origen a clonar (File_Origen_Clonacion__c)',
    });
    return;
  }
  if (SIMULAR) { log('  [simular] no se ejecuta Tourplan. Datos mapeados:\n' + JSON.stringify(datos, null, 1)); return; }

  // Marcar EN_PROCESO: evita que otra corrida tome el mismo lead
  guardarResultado(lead.Id, { estado: 'EN_PROCESO' });
  const resultado = ejecutarRobot(datos);
  log(`  Resultado: ${resultado.estado} ${resultado.referencia ? '→ ' + resultado.referencia : ''}`);
  guardarResultado(lead.Id, resultado);
}

async function main() {
  log(`Worker iniciado — org ${ORG}, cada ${INTERVALO_MS / 1000}s${SIMULAR ? ' [MODO SIMULACION]' : ''}`);
  await unaVuelta();
  if (UNA_VEZ) return;
  setInterval(unaVuelta, INTERVALO_MS);
}

main();
