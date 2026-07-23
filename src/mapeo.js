/**
 * MAPEO Salesforce (Lead de Valentin) → inputs de Tourplan.
 *
 * Esta es la traduccion entre los dos mundos: lo que Valentin capturo en el
 * chat vive en el Lead, y Tourplan necesita otros nombres y formatos.
 * Todo lo especifico del negocio (alias por idioma, agencia por LeadSource,
 * keywords de lujo) esta aca y en un solo lugar.
 */

/** Alias estatico por idioma (guia 3.3: "wonderful trip for you" en el idioma que toque). */
const ALIAS_POR_IDIOMA = {
  Espanol:  'un viaje maravilloso para ti',
  Ingles:   'wonderful trip for you',
  Aleman:   'eine wunderbare Reise für dich',
  Italiano: 'un viaggio meraviglioso per te',
};

/**
 * ===== CODIGOS REALES DE TOURPLAN (descubiertos en el sandbox 2026-07-23) =====
 * Todo esto se deriva de los datos del Lead: el .env es solo para pruebas manuales.
 *
 * DIVISION:     AL Aliwen | BN Booknow | DM DMC FITS | GR Grupos DMC | MK Marketing
 *               PL Plataformas | TE Test | WE Web | WI Walk In
 * DEPARTAMENTO: FA Family | FE Ferias | FI FIT's | FT FAM Tours | GP Grupales
 *               GS Grupos Say Hueque | MD Multidays | PP Personal Trips | PS Prensa
 *               SI Sites | ST Sat | TE Test
 */

/** Division: los leads de Valentin entran por la web → WE. */
const DIVISION_POR_ORIGEN = {
  'Valentín': 'WE',   // chat de la web
  'SAT':      'WE',
  'SWEK':     'WE',
};
const DIVISION_DEFAULT = 'WE';

/**
 * Departamento segun el TIPO DE CLIENTE del Lead (Customer_Type__c).
 * Es el campo que ya llena Valentin, asi que sale solo.
 */
const DEPTO_POR_TIPO_CLIENTE = {
  'Grupo':          'GP',   // Grupales
  'Grupos':         'GP',
  'Agencia':        'GP',
  'Family':         'FI',   // familias siguen siendo FIT (viaje individual a medida)
  'Honeymoon':      'FI',
  'Individual':     'FI',
  'Single Traveler':'FI',
  'Multidestino':   'MD',   // Multidays
};
const DEPTO_DEFAULT = 'FI';   // FIT's

/**
 * Agencia segun el origen del lead (guia 3.3).
 * ⚠️ FALTA EL DATO DE SAY: cual es el codigo de agencia para un cliente directo
 * de la web. La lista de Tourplan tiene cientos (000661 Elcano Tours, 1 10Adventures...).
 * Mientras no lo tengamos, se usa TP_AGENCIA del .env como provisorio.
 */
const AGENCIA_POR_ORIGEN = {
  // 'Valentín': '???',   ← pendiente de confirmar con Say
};

/** Moneda. ⚠️ A CONFIRMAR con Say si varia por origen/idioma del cliente. */
const MONEDA_DEFAULT = 'USD';

/** Link del backend segun tipo de cliente (guia 4.4). */
const BACKEND_POR_ORIGEN = {
  'SAT':                  'SAT',
  'South America Travel': 'SAT',
  'Valentín':             'SWEK',
  'Say Hueque':           'SWEK',
  'Argentina Pura':       'SWEK',
};
const BACKEND_DEFAULT = 'SWEK';

/** Idioma del itinerario en el backend (guia 4.5): EN por defecto; ES/DE/IT si son explicitos. */
const IDIOMA_BACKEND = { Espanol: 'ES', Ingles: 'EN', Aleman: 'DE', Italiano: 'IT' };

/**
 * Palabras clave de LUJO (guia 5): si aparecen, el robot NO cotiza automatico.
 * Propiedades = nombres propios, NO se traducen. Generales = en los 4 idiomas.
 */
const KEYWORDS_PROPIEDADES = [
  'llao llao', 'melia iguazu', 'meliá iguazú', 'australis', 'explora',
  'four season', 'awasi', 'palacio duhau', 'hyatt', 'glamping',
];
const KEYWORDS_GENERALES = [
  // ingles
  'business', 'all inclusive', 'private flight', 'secretary', 'personal assistant',
  'helicopter', 'private jet', 'luxury',
  // espanol
  'lujo', 'todo incluido', 'vuelo privado', 'secretaria', 'asistente personal',
  'helicoptero', 'helicóptero', 'jet privado',
  // aleman
  'luxus', 'alles inklusive', 'privatflug', 'sekretärin', 'sekretarin',
  'persönlicher assistent', 'hubschrauber', 'privatjet',
  // italiano
  'lusso', 'tutto incluso', 'volo privato', 'segretaria', 'assistente personale',
  'elicottero', 'jet privato',
];

/**
 * Convierte una fecha (Date | ISO string | DDMMAA) al formato estricto DDMMAA.
 * OJO: un string "2026-10-10" lo interpreta JS como medianoche UTC; al pasarlo
 * a hora local (Chile UTC-4) retrocede un dia. Por eso las fechas ISO se
 * construyen con componentes LOCALES.
 */
export function aDDMMAA(fecha, desplazarDias = 0) {
  let d;
  if (fecha instanceof Date) {
    d = new Date(fecha.getTime());
  } else if (typeof fecha === 'string' && /^\d{6}$/.test(fecha)) {
    // ya viene DDMMAA
    d = new Date(2000 + +fecha.slice(4, 6), +fecha.slice(2, 4) - 1, +fecha.slice(0, 2));
  } else if (typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fecha)) {
    const [y, m, dd] = fecha.slice(0, 10).split('-').map(Number);
    d = new Date(y, m - 1, dd);          // local, no UTC
  } else {
    d = new Date(fecha);
  }
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + desplazarDias);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getDate()) + p(d.getMonth() + 1) + String(d.getFullYear()).slice(2);
}

/** Regla de habitaciones (guia 3.4). */
export function calcularHabitaciones(pax) {
  const n = parseInt(pax, 10) || 1;
  if (n <= 1) return { dobles: 0, singles: 1, total: 1 };
  if (n === 2) return { dobles: 1, singles: 0, total: 1 };
  if (n === 3) return { dobles: 1, singles: 1, total: 2 };
  if (n % 2 === 0) return { dobles: n / 2, singles: 0, total: n / 2 };
  return { dobles: (n - 1) / 2, singles: 1, total: (n - 1) / 2 + 1 };
}

/**
 * Detecta si el lead es de LUJO revisando el texto libre del Lead.
 * Devuelve { esLujo, coincidencias[] } para poder explicar POR QUE se freno.
 */
export function detectarLujo(lead) {
  const texto = [
    lead.Description, lead.Mensaje_Cliente__c, lead.Destinations_of_Interest__c,
    lead.Company, lead.Trip_Duration__c,
  ].filter(Boolean).join(' ')
   .toLowerCase()
   // saca etiquetas HTML (el campo Mensaje Cliente llega con el mail crudo)
   .replace(/<[^>]+>/g, ' ')
   .replace(/\s+/g, ' ');

  const coincidencias = [...KEYWORDS_PROPIEDADES, ...KEYWORDS_GENERALES]
    .filter(k => texto.includes(k));
  return { esLujo: coincidencias.length > 0, coincidencias };
}

/**
 * Traduce un Lead de Salesforce a los inputs que necesita el robot.
 * @param {object} lead  registro de Lead (campos de Valentin)
 * @param {object} extra { fileOrigen }  el file a clonar (viene de la consulta SQL)
 */
export function leadATourplan(lead, extra = {}) {
  const idioma = lead.Language__c || 'Ingles';
  const { esLujo, coincidencias } = detectarLujo(lead);

  // Los 4 campos obligatorios de Tourplan se DERIVAN del Lead:
  const division = DIVISION_POR_ORIGEN[lead.LeadSource] || DIVISION_DEFAULT;
  const depto    = DEPTO_POR_TIPO_CLIENTE[lead.Customer_Type__c] || DEPTO_DEFAULT;
  const agencia  = extra.agencia || lead.Agencia_Tourplan__c
                   || AGENCIA_POR_ORIGEN[lead.LeadSource] || '';
  const moneda   = extra.moneda || MONEDA_DEFAULT;
  const backend  = BACKEND_POR_ORIGEN[lead.LeadSource] || BACKEND_DEFAULT;

  // Nombre del titular: Valentin guarda todo en LastName
  const nombre = [lead.FirstName, lead.LastName].filter(Boolean).join(' ').trim() || 'Sin Nombre';

  // Fecha de viaje: la del Lead; si no hay, 30 dias adelante (placeholder visible).
  // Se pasa el string tal cual: aDDMMAA lo interpreta en hora local.
  const fechaBase = lead.Trip_Start_Date__c || new Date(Date.now() + 30 * 86400_000);

  const pax = parseInt(lead.Number_of_Passengers__c, 10) || 1;

  return {
    leadId:      lead.Id,
    paxNombre:   nombre,
    paxCantidad: pax,
    habitaciones: calcularHabitaciones(pax),
    fechaViaje:  aDDMMAA(fechaBase),
    fechaFin:    lead.Trip_End_Date__c ? aDDMMAA(lead.Trip_End_Date__c) : null,
    alias:       ALIAS_POR_IDIOMA[idioma] || ALIAS_POR_IDIOMA.Ingles,
    // Los 4 obligatorios del modal Crear Booking
    agencia,
    depto,
    division,
    moneda,
    // Para el backend (guia 4)
    backendLink:   backend,
    idiomaBackend: IDIOMA_BACKEND[idioma] || 'EN',
    // File a clonar: lo provee la consulta SQL (o un campo del Lead)
    fileOrigen:  extra.fileOrigen || lead.File_Origen_Clonacion__c || '',
    // Freno de lujo (guia 5)
    lujo: esLujo,
    lujoMotivo: coincidencias,
    // Contexto util para el log / trazabilidad
    destinos:   lead.Destinations_of_Interest__c || '',
    email:      lead.Email || '',
    idioma,
    resumen:    lead.Description || '',
  };
}

export const _internals = {
  ALIAS_POR_IDIOMA, DIVISION_POR_ORIGEN, DEPTO_POR_TIPO_CLIENTE,
  KEYWORDS_PROPIEDADES, KEYWORDS_GENERALES,
};
