/*
 * Turn one AISHub vessel record into NMEA 2000 messages (as canboat JSON,
 * which the Signal K NMEA 2000 connection encodes and sends) and into a
 * Signal K delta.
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

// AIS ship type numbers, as Signal K names them.
function shipTypeName (t) {
  const names = {
    0: 'Not available',
    20: 'Wing In Ground',
    30: 'Fishing',
    31: 'Towing',
    32: 'Towing exceeds 200m or wider than 25m',
    33: 'Engaged in dredging or underwater operations',
    34: 'Engaged in diving operations',
    35: 'Engaged in military operations',
    36: 'Sailing',
    37: 'Pleasure',
    40: 'High speed craft',
    50: 'Pilot vessel',
    51: 'SAR',
    52: 'Tug',
    53: 'Port tender',
    54: 'Anti-pollution',
    55: 'Law enforcement',
    56: 'Spare',
    57: 'Spare #2',
    58: 'Medical',
    59: 'RR Resolution No.18',
    60: 'Passenger ship',
    70: 'Cargo ship',
    80: 'Tanker',
    90: 'Other Type'
  }
  if (names[t]) return names[t]
  if (t >= 20 && t <= 29) return 'Wing In Ground'
  if (t >= 40 && t <= 49) return 'High speed craft'
  if (t >= 60 && t <= 69) return 'Passenger ship'
  if (t >= 70 && t <= 79) return 'Cargo ship'
  if (t >= 80 && t <= 89) return 'Tanker'
  if (t >= 90 && t <= 99) return 'Other Type'
  return undefined
}

const NAV_STATES = {
  0: 'motoring',
  1: 'anchored',
  2: 'not under command',
  3: 'restricted manouverability',
  4: 'constrained by draft',
  5: 'moored',
  6: 'aground',
  7: 'fishing',
  8: 'sailing',
  9: 'hazardous material high speed',
  10: 'hazardous material wing in ground',
  14: 'ais-sart'
}

// The Signal K delta for this vessel, using the same paths and shapes the
// server itself uses for AIS heard on NMEA 2000.
function delta (v, sourceLabel, now) {
  const values = [
    { path: '', value: { mmsi: String(v.mmsi) } },
    { path: 'navigation.position', value: { latitude: v.latitude, longitude: v.longitude } },
    { path: 'sensors.ais.class', value: v.class }
  ]
  if (v.name) values.push({ path: '', value: { name: v.name } })
  if (v.callsign) values.push({ path: '', value: { communication: { callsignVhf: v.callsign } } })
  if (v.imo) values.push({ path: '', value: { registrations: { imo: `IMO ${v.imo}` } } })
  if (v.cogDegrees !== undefined) values.push({ path: 'navigation.courseOverGroundTrue', value: round(v.cogDegrees * DEG_TO_RAD, 5) })
  if (v.sogKnots !== undefined) values.push({ path: 'navigation.speedOverGround', value: round(v.sogKnots * KNOTS_TO_MS, 3) })
  if (v.headingDegrees !== undefined) values.push({ path: 'navigation.headingTrue', value: round(v.headingDegrees * DEG_TO_RAD, 5) })
  const rot = rateOfTurn(v.rotCoded)
  if (rot !== undefined) values.push({ path: 'navigation.rateOfTurn', value: rot })
  if (NAV_STATES[v.navStatus]) values.push({ path: 'navigation.state', value: NAV_STATES[v.navStatus] })
  if (v.length) values.push({ path: 'design.length', value: { overall: v.length } })
  if (v.beam) values.push({ path: 'design.beam', value: v.beam })
  if (v.draught) values.push({ path: 'design.draft', value: { maximum: v.draught } })
  if (v.length) values.push({ path: 'sensors.ais.fromBow', value: v.toBow })
  if (v.beam) values.push({ path: 'sensors.ais.fromCenter', value: round(v.beam / 2 - v.toStarboard, 2) })
  const typeName = shipTypeName(v.shipType)
  if (typeName) values.push({ path: 'design.aisShipType', value: { id: v.shipType, name: typeName } })
  if (v.destination) values.push({ path: 'navigation.destination.commonName', value: v.destination })
  return {
    context: `vessels.urn:mrn:imo:mmsi:${v.mmsi}`,
    updates: [{
      source: { label: sourceLabel, type: 'aishub' },
      timestamp: new Date(v.time !== undefined ? v.time : now).toISOString(),
      values
    }]
  }
}

module.exports = { positionReport, staticData, delta, rateOfTurn, shipTypeName, NAV_STATES }
