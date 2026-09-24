-- Catalogo de itinerarios para Salesforce (Itinierario__c). Una fila por reserva.
-- La envuelve src/itinerarios.js (filtro por fecha + paginado): sin ORDER BY ni
-- punto y coma al final.
--
-- De donde sale cada columna (comprobado contra la carga del 02-08-2026, el CSV de Axel):
--   Dias      = dias entre el inicio del viaje y el ultimo servicio.
--   Locations = codigos de ubicacion de los servicios, sin repetir, ordenados y
--               separados por "| " (ej. "000| CHL| FTE| PNT"). Va con FOR XML PATH
--               porque esta base no acepta STRING_AGG.
--
-- Reglas de Say Hueque (por correo):
--   - solo cotizaciones: BookingStatus = 'QU' (Ayelen, 04-09-2026);
--   - files de los branches WE (Web) y PL (Plataformas) (Ayelen, 23-07-2026);
--   - sin los consultores HM (Helena Moretti) ni ANR (Analia Rupar Przebieda)
--     (Ayelen, 23-07-2026, con el OK de Axel).
-- Y sin las copias que crea el robot: llevan siempre el mismo alias por idioma
-- (src/mapeo.js, ALIAS_POR_IDIOMA). Si entraran al catalogo, el robot terminaria
-- copiando sus propias copias, con los precios en 999. Ningun booking real usa esos
-- alias exactos (comprobado en la base el 24-09-2026).
SELECT
    RTRIM(h.BookingReference)                                   AS BookingReference,
    h.BookingPaxQty                                             AS BookingPaxQty,
    DATEDIFF(day, h.BookingTravelDate, h.BookingLastServiceDate) AS Dias,
    STUFF((
        SELECT '| ' + RTRIM(x.loc)
        FROM (
            SELECT DISTINCT s.ServiceLocationCode AS loc
            FROM vw_BookingServiceReportData s
            WHERE s.ServiceBookingID = h.BookingID
        ) x
        ORDER BY x.loc
        FOR XML PATH('')
    ), 1, 2, '')                                                AS Locations,
    h.BookingEnteredDate                                        AS BookingEnteredDate,
    h.BookingLastWorkDate                                       AS BookingLastWorkDate,
    h.BookingTravelDate                                         AS BookingTravelDate,
    h.BookingLastServiceDate                                    AS BookingLastServiceDate,
    RTRIM(h.BookingConsultantName)                              AS BookingConsultantName,
    h.BookingAgentAmount                                        AS BookingAgentAmount,
    h.BookingMarkupAmount                                       AS BookingMarkupAmount
FROM vw_BookingHeaderReportData h
WHERE h.BookingStatus = 'QU'
  AND h.BookingBranchCode IN ('WE', 'PL')
  AND RTRIM(h.BookingConsultant) NOT IN ('HM', 'ANR')
  AND ISNULL(RTRIM(h.BookingNameAlias), N'') NOT IN (
        N'wonderful trip for you', N'un viaje maravilloso para ti',
        N'eine wunderbare Reise für dich', N'un viaggio meraviglioso per te')
