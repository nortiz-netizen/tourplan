/**
 * CORRER-ULTIMO — toma el ULTIMO lead que entro a Salesforce (Valentin),
 * lo traduce a JSON y ejecuta el robot de Tourplan con esos datos.
 *
 * Es el mismo puente que el worker, pero en vez de la cola (mas antiguo primero)
 * agarra el mas reciente. Sirve para probar en vivo con el lead que se acaba de
 * crear.  Uso:  node src/correr-ultimo.js   (agrega --simular para no abrir Tourplan)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { leadATourplan } from './mapeo.js';
dotenv.config();

const ORG     = process.env.SF_ORG || 'sayhueque-sb';
const SIMULAR = process.argv.includes('--simular');

const CAMPOS = [
  'Id', 'FirstName', 'LastName', 'Email', 'LeadSource', 'Language__c',
  'Number_of_Passengers__c', 'Trip_Start_Date__c', 'Trip_End_Date__c',
  'Trip_Duration__c', 'Destinations_of_Interest__c', 'Customer_Type__c',
  'Tipo_de_viaje__c', 'Description', 'Company',
  'Estado_Clonacion__c', 'File_Origen_Clonacion__c', 'Referencia_Tourplan__c',
  'Agencia_Tourplan__c', 'Owner.Name',
].join(', ');

// El ULTIMO lead de Valentin (mas reciente primero).
const soql = `SELECT ${CAMPOS} FROM Lead WHERE LeadSource = 'Valentín' ` +
  `AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1`;
fs.writeFileSync('.ultimo.soql', soql, 'utf8');
const out = execFileSync('sf', ['data', 'query', '--file', '.ultimo.soql',
  '--target-org', ORG, '--json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: true });
fs.unlinkSync('.ultimo.soql');

const lead = (JSON.parse(out)?.result?.records ?? [])[0];
if (!lead) { console.log('No hay leads de Valentin.'); process.exit(0); }

const datos = leadATourplan(lead);
console.log(`ULTIMO lead: ${lead.Id} — ${datos.paxNombre}`);
console.log(`  Owner:  ${lead.Owner ? lead.Owner.Name : '(?)'}`);
console.log(`  Destino: ${datos.destinos || '(vacio)'} | file: ${datos.fileOrigen || '(vacio)'} | ${datos.paxCantidad} pax | ${datos.fechaViaje}`);

if (!datos.fileOrigen) {
  console.log('\n⚠ Este lead no tiene File_Origen_Clonacion__c (no matcheo ninguna Plantilla_Tourplan__c).');
  console.log('  El robot no sabria que file clonar. Cargá la plantilla del destino y volvé a crear el lead.');
  process.exit(0);
}

fs.writeFileSync('datos-entrada.json', JSON.stringify(datos, null, 1));
console.log('  → datos-entrada.json escrito con el JSON del lead.\n');

if (SIMULAR) { console.log('[simular] no se abre Tourplan.\n' + JSON.stringify(datos, null, 1)); process.exit(0); }

spawnSync(process.execPath, ['src/clonar.js', '--datos', 'datos-entrada.json'],
  { encoding: 'utf8', stdio: 'inherit' });
