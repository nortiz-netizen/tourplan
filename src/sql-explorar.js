/**
 * Explora la base SQL de Tourplan para armar src/sql/itinerarios.sql.
 * Solo LEE: no escribe nada en Tourplan.
 *
 *   node src/sql-explorar.js             -> quien soy, que base, y donde estan las
 *                                           columnas de reservas que usa el catalogo
 *   node src/sql-explorar.js <tabla>     -> columnas + 3 filas de ejemplo de esa tabla
 *   node src/sql-explorar.js --probar    -> corre la consulta del catalogo (1 pagina de 5)
 */
import { conexion } from './tourplan-sql.js';
import { paginaDeItinerarios } from './itinerarios.js';

const arg = process.argv[2];

async function main() {
  const db = await conexion();
  const q = async (t) => (await db.request().query(t)).recordset;

  if (arg === '--probar') {
    const p = await paginaDeItinerarios({ pagina: 0, tam: 5 });
    console.log(JSON.stringify(p, null, 1));
    return;
  }

  if (arg) {
    const [esquema, tabla] = arg.includes('.') ? arg.split('.') : [null, arg];
    const cols = await q(`
      SELECT TABLE_SCHEMA s, COLUMN_NAME c, DATA_TYPE t
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = '${tabla.replace(/'/g, "''")}'
      ${esquema ? `AND TABLE_SCHEMA = '${esquema.replace(/'/g, "''")}'` : ''}
      ORDER BY ORDINAL_POSITION`);
    console.table(cols);
    const nombre = esquema ? `[${esquema}].[${tabla}]` : `[${tabla}]`;
    console.table(await q(`SELECT TOP 3 * FROM ${nombre}`));
    return;
  }

  console.table(await q(`SELECT DB_NAME() base, SUSER_NAME() usuario, CAST(SERVERPROPERTY('ProductVersion') AS varchar) version`));
  try {
    console.table(await q(`SELECT name base FROM sys.databases WHERE HAS_DBACCESS(name) = 1`));
  } catch (e) {
    console.log('(sin permiso para listar bases)');
  }

  // Los nombres que ya tiene el catalogo en Salesforce vienen del CSV de Axel;
  // si existen tal cual, la vista de donde salieron esta aca.
  console.log('\nColumnas con nombres de reserva:');
  console.table(await q(`
    SELECT TABLE_SCHEMA s, TABLE_NAME tabla, COLUMN_NAME c
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME IN ('BookingReference','BookingPaxQty','BookingLastWorkDate','BookingConsultantName',
                          'BookingEnteredDate','BookingTravelDate','BookingAgentAmount','BookingMarkupAmount')
       OR COLUMN_NAME LIKE '%LAST_WORK%' OR COLUMN_NAME LIKE '%LastWork%'
    ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME`));

  const tablas = await q(`
    SELECT TABLE_SCHEMA s, TABLE_NAME tabla, TABLE_TYPE tipo
    FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_TYPE DESC, TABLE_SCHEMA, TABLE_NAME`);
  console.log(`\n${tablas.length} tablas/vistas visibles:`);
  console.table(tablas.length > 400 ? tablas.filter((t) => t.tipo === 'VIEW') : tablas);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    // Nunca se imprime la configuracion: lleva la clave.
    console.error('ERROR:', e.code || '', String(e.message).split('\n')[0]);
    if (e.code === 'ETIMEOUT' || e.code === 'ESOCKET') {
      console.error('-> Suele ser la IP: Tourplan tiene que autorizar la IP publica de este servidor.');
    }
    process.exit(1);
  });
