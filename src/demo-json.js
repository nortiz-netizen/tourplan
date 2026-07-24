/**
 * DEMO: muestra el JSON que Salesforce le inyecta al scraper para un lead.
 * Uso:  node src/demo-json.js "Venezuela"   (filtra por texto del resumen)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { leadATourplan } from './mapeo.js';
dotenv.config();

const ORG = process.env.SF_ORG || 'sayhueque-sb';
const filtro = process.argv[2] || 'Venezuela';

const CAMPOS = 'Id, FirstName, LastName, Email, LeadSource, Language__c, ' +
  'Number_of_Passengers__c, Trip_Start_Date__c, Trip_End_Date__c, Trip_Duration__c, ' +
  'Destinations_of_Interest__c, Customer_Type__c, Tipo_de_viaje__c, Description, Company, ' +
  'File_Origen_Clonacion__c, Owner.Name';

// Description es LongTextArea → NO se puede filtrar en SOQL. Traigo los ultimos
// y filtro por el texto del resumen del lado del cliente.
const soql = `SELECT ${CAMPOS} FROM Lead WHERE LeadSource = 'Valentín' ` +
  `ORDER BY CreatedDate DESC LIMIT 20`;
fs.writeFileSync('.demo.soql', soql, 'utf8');

const out = execFileSync('sf', ['data', 'query', '--file', '.demo.soql', '--target-org', ORG, '--json'],
  { encoding: 'utf8', shell: true });
fs.unlinkSync('.demo.soql');

const recs = JSON.parse(out).result.records || [];
const rec = recs.find(r => (r.Description || '').toLowerCase().includes(filtro.toLowerCase())) || recs[0];
if (!rec) { console.log('No hay leads de Valentin'); process.exit(0); }

console.log('=== 1) LEAD en Salesforce (lo capturo Valentin) ===');
console.log('   Paciente:', rec.LastName);
console.log('   Owner (asignacion):', rec.Owner ? rec.Owner.Name : '(?)');
console.log('   Pax:', rec.Number_of_Passengers__c, '| Idioma:', rec.Language__c);
console.log('   Destino (campo):', rec.Destinations_of_Interest__c || '(vacio)');
console.log('   File origen (plantilla):', rec.File_Origen_Clonacion__c || '(vacio)');
console.log('   Resumen:', (rec.Description || '').slice(0, 70));
console.log();
console.log('=== 2) JSON que Salesforce le INYECTA al scraper (clonar.js --datos) ===');
console.log(JSON.stringify(leadATourplan(rec, {}), null, 2));
