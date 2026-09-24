/**
 * Catalogo de itinerarios de Tourplan -> Salesforce (objeto Itinierario__c).
 *
 * Salesforce lo pide una vez al dia (GET /itinerarios) y hace upsert por
 * BookingReference__c. Es el catalogo del que BuscarItinerarioTourplan elige que
 * file clonar, asi que si se queda viejo el robot clona viajes viejos.
 *
 * La consulta vive en src/sql/itinerarios.sql. Reglas para ese archivo:
 *   - devuelve UNA fila por reserva, con las columnas de COLUMNAS (mismos nombres);
 *   - sin ORDER BY ni punto y coma final: aca se envuelve para filtrar por fecha y
 *     paginar, y SQL Server no acepta ORDER BY dentro de un CTE.
 *
 * Reglas de negocio que Say Hueque pidio por correo (van en el WHERE de la consulta):
 *   - Booking Status = QUOTE unicamente (Ayelen, 04-09-2026);
 *   - files de branch WE y tambien PL (Ayelen, 23-07-2026; el filtro PL/WE va en la SQL
 *     segun el checkpoint 28/7);
 *   - excluir los consultores HM (Helena Moretti) y ANR (Analia Rupar Przebieda)
 *     (Ayelen, 23-07-2026, Axel dio el OK).
 * Y correrla de noche: 1-2 AM de Argentina (Alveiro, 15-07-2026).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conexion, sql } from './tourplan-sql.js';

const CONSULTA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', 'itinerarios.sql');

/** Columnas de la consulta = campos de Itinierario__c sin el __c. */
export const COLUMNAS = [
  'BookingReference', 'BookingPaxQty', 'Dias', 'Locations',
  'BookingEnteredDate', 'BookingLastWorkDate', 'BookingTravelDate', 'BookingLastServiceDate',
  'BookingConsultantName', 'BookingAgentAmount', 'BookingMarkupAmount',
];

export const TAM_DEFECTO = 2000;
export const TAM_MAXIMO = 5000;

function leerConsulta() {
  if (!fs.existsSync(CONSULTA)) {
    throw new Error('Falta src/sql/itinerarios.sql (la consulta a Tourplan)');
  }
  return fs.readFileSync(CONSULTA, 'utf8').trim().replace(/;+\s*$/, '');
}

/**
 * Una pagina del catalogo.
 * @param {object} p
 * @param {Date|null} p.desde  solo reservas trabajadas desde esa fecha; null = todas
 * @param {number} p.pagina    0, 1, 2...
 * @param {number} p.tam       filas por pagina
 */
export async function paginaDeItinerarios({ desde = null, pagina = 0, tam = TAM_DEFECTO }) {
  const db = await conexion();
  const req = db.request();
  req.input('offset', sql.Int, pagina * tam);
  // Se pide una fila de mas para saber si hay otra pagina sin contar toda la tabla.
  req.input('tam', sql.Int, tam + 1);
  let filtro = '';
  if (desde) {
    req.input('desde', sql.DateTime2, desde);
    filtro = 'WHERE BookingLastWorkDate >= @desde';
  }

  const { recordset } = await req.query(`
    WITH itinerarios AS (
      ${leerConsulta()}
    )
    SELECT ${COLUMNAS.join(', ')}
    FROM itinerarios
    ${filtro}
    ORDER BY BookingReference
    OFFSET @offset ROWS FETCH NEXT @tam ROWS ONLY`);

  const hayMas = recordset.length > tam;
  return { hayMas, filas: recordset.slice(0, tam).map(aSalesforce) };
}

/** Fila de SQL -> campos de Itinierario__c. Las fechas salen en ISO (UTC). */
export function aSalesforce(fila) {
  const r = {};
  for (const c of COLUMNAS) {
    let v = fila[c];
    if (v instanceof Date) v = v.toISOString();
    else if (typeof v === 'string') v = v.trim();
    r[`${c}__c`] = v ?? null;
  }
  return r;
}
