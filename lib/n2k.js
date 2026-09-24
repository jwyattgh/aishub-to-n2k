/*
 * Turn one AISHub vessel record into NMEA 2000 messages (as canboat JSON,
 * which the Signal K NMEA 2000 connection encodes and sends).
 *
 * Class A vessels get a class A position report (PGN 129038) and static
 * and voyage data (129794). Class B vessels get a class B position report
 * (129039) and the two-part class B static data (129809 and 129810). That
 * is what a real transponder of each class puts on the bus, so plotters
 * treat the targets exactly like ones heard over the air.
 *
 * Fields left out are encoded by canboatjs as "not available", which is
 * what an AIS transponder sends when it does not know either.
 */

const KNOTS_TO_MS = 0.514444
const DEG_TO_RAD = Math.PI / 180

// Not available markers of the NMEA 2000 fields.
const TIME_STAMP_NOT_AVAILABLE = 60
const NAV_STATUS_UNDEFINED = 15

// PGN 129038 / 129039
function positionReport (v, opts) {
  const o = opts || {}
  const common = {
    prio: 4,
    dst: 255,
    'Repeat Indicator': 0,
    'User ID': v.mmsi,
    Longitude: v.longitude,
    Latitude: v.latitude,
    'Position Accuracy': v.positionAccuracy ? 1 : 0,
    RAIM: 0,
    'Time Stamp': secondOfReport(v.time),
    'AIS Transceiver information': 0
  }
  if (v.cogDegrees !== undefined) common.COG = v.cogDegrees * DEG_TO_RAD
  if (v.sogKnots !== undefined) common.SOG = round(v.sogKnots * KNOTS_TO_MS, 2)
  if (v.headingDegrees !== undefined) common.Heading = v.headingDegrees * DEG_TO_RAD
  if (v.class === 'A') {
    const msg = {
      pgn: 129038,
      'Message ID': 1,
      ...common,
      'Nav Status': v.navStatus !== undefined ? v.navStatus : NAV_STATUS_UNDEFINED,
      'Special Maneuver Indicator': 0
    }
    const rot = rateOfTurn(v.rotCoded)
    if (rot !== undefined) msg['Rate of Turn'] = rot
    return withSource(msg, o.src)
  }
  return withSource({
    pgn: 129039,
    'Message ID': 18,
    ...common,
    'Unit type': 1, // CS (carrier sense), the common class B kind
    'Integrated Display': 0,
    DSC: 0,
    Band: 0,
    'Can handle Msg 22': 0,
    'AIS mode': 0,
    'AIS communication state': 0
  }, o.src)
}

// PGN 129794, or 129809 + 129810
function staticData (v, opts) {
  const o = opts || {}
  if (v.class === 'A') {
    const msg = {
      pgn: 129794,
      prio: 6,
      dst: 255,
      'Message ID': 5,
      'Repeat Indicator': 0,
      'User ID': v.mmsi,
      'IMO number': v.imo || 0,
      Callsign: v.callsign || '',
      Name: v.name || '',
      'Type of ship': v.shipType || 0,
      Length: v.length || 0,
      Beam: v.beam || 0,
      'Position reference from Starboard': v.toStarboard || 0,
      'Position reference from Bow': v.toBow || 0,
      Draft: v.draught || 0,
      Destination: v.destination || '',
      'AIS version indicator': 0,
      'GNSS type': 1,
      DTE: 0,
      'AIS Transceiver information': 0
    }
    return [withSource(msg, o.src)]
  }
  return [
    withSource({
      pgn: 129809,
      prio: 6,
      dst: 255,
      'Message ID': 24,
      'Repeat Indicator': 0,
      'User ID': v.mmsi,
      Name: v.name || '',
      'AIS Transceiver information': 0,
      'Sequence ID': 0
    }, o.src),
    withSource({
      pgn: 129810,
      prio: 6,
      dst: 255,
      'Message ID': 24,
      'Repeat Indicator': 0,
      'User ID': v.mmsi,
      'Type of ship': v.shipType || 0,
      'Vendor ID': '',
      Callsign: v.callsign || '',
      Length: v.length || 0,
      Beam: v.beam || 0,
      'Position reference from Starboard': v.toStarboard || 0,
      'Position reference from Bow': v.toBow || 0,
      'GNSS type': 1,
      'AIS Transceiver information': 0,
      'Sequence ID': 0
    }, o.src)
  ]
}

function withSource (msg, src) {
  if (src !== undefined) msg.src = src
  return msg
}

// The AIS time stamp is the UTC second the position was taken.
function secondOfReport (timeMs) {
  if (timeMs === undefined) return TIME_STAMP_NOT_AVAILABLE
  return new Date(timeMs).getUTCSeconds()
}

// The AIS rate-of-turn field is coded: value = 4.733 * sqrt(deg/min),
// sign kept. canboatjs wants radians per second.
function rateOfTurn (coded) {
  if (coded === undefined || coded === 0) return coded === 0 ? 0 : undefined
  if (Math.abs(coded) >= 127) return undefined // turning faster than the field can say
  const degPerMin = Math.sign(coded) * (coded / 4.733) ** 2
  return round(degPerMin * DEG_TO_RAD / 60, 5)
}

function round (n, places) {
  const f = 10 ** places
  return Math.round(n * f) / f
}

module.exports = { positionReport, staticData, rateOfTurn }
