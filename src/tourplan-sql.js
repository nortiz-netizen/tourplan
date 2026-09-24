/**
 * Conexion a la base SQL Server de Tourplan (la del usuario de lectura tipo "Excel").
 *
 * La clave vive SOLO en el .env del servidor (TP_SQL_PASS). Salesforce nunca la ve:
 * le pide los datos al servidor por HTTP y el servidor es el unico que entra a la base.
 *
 * Tourplan autoriza la conexion por IP (whitelist). Si se corre desde una IP que no
 * esta autorizada, el error es un timeout de conexion, no un "clave incorrecta".
 */
import sql from 'mssql';
import dotenv from 'dotenv';
dotenv.config();

let pool = null;

function configuracion() {
  const faltan = ['TP_SQL_SERVER', 'TP_SQL_USER', 'TP_SQL_PASS'].filter((k) => !process.env[k]);
  if (faltan.length) throw new Error(`Faltan en el .env: ${faltan.join(', ')}`);
  return {
    server: process.env.TP_SQL_SERVER,
    port: parseInt(process.env.TP_SQL_PORT || '1433', 10),
    user: process.env.TP_SQL_USER,
    password: process.env.TP_SQL_PASS,
    // Sin base explicita entra a la base por defecto del usuario, que en Tourplan
    // alojado suele ser la de la agencia.
    database: process.env.TP_SQL_DB || undefined,
    options: {
      encrypt: true,
      // El servidor alojado de Tourplan usa un certificado que no firma una CA publica.
      trustServerCertificate: true,
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: 20_000,
    requestTimeout: 180_000,
  };
}

export async function conexion() {
  if (pool && pool.connected) return pool;
  pool = await new sql.ConnectionPool(configuracion()).connect();
  // Si la conexion se corta (Tourplan reinicia, cae la red), el proximo pedido
  // arma una nueva en vez de quedar pegado a un pool muerto.
  pool.on('error', () => { pool = null; });
  return pool;
}

/**
 * Nombre y fecha de viaje de una reserva. El robot lo pide antes de copiar un file:
 * con el nombre verifica que en Tourplan eligio el itinerario correcto (paso 3.5), y
 * la fecha es la "fecha original" del ultimo intento de disponibilidad (seccion 4).
 */
export async function datosDeReserva(referencia) {
  const db = await conexion();
  const r = await db.request()
    .input('ref', sql.VarChar(20), String(referencia).trim())
    .query(`SELECT TOP 1 RTRIM(BookingName) AS nombre, BookingTravelDate AS fechaViaje
            FROM vw_BookingHeaderReportData WHERE BookingReference = @ref`);
  return r.recordset[0] || null;
}

/** Cierra la conexion: un proceso corto (el robot) no termina con el pool abierto. */
export async function cerrar() {
  if (pool) { await pool.close().catch(() => {}); pool = null; }
}

export { sql };
