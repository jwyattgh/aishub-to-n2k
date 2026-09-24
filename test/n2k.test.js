const test = require('node:test')
const assert = require('node:assert')
const cb = require('@canboat/canboatjs')
const n2k = require('../lib/n2k')
const aishub = require('../lib/aishub')

const CLASS_B = aishub.normalize({ MMSI: 368341220, TIME: '2026-09-24 01:27:07 GMT', LONGITUDE: -67.19226, LATITUDE: 18.06746, COG: 108.3, SOG: 6.2, HEADING: 511, ROT: 128, PAC: 1, NAVSTAT: 15, IMO: 0, NAME: 'NAUTI DREAM', CALLSIGN: 'WDP2985', TYPE: 36, A: 5, B: 9, C: 2, D: 2, DRAUGHT: 0, DEST: '', ETA: '00-00 00:00' })
const CLASS_A = aishub.normalize({ MMSI: 311000123, TIME: '2026-09-24 01:26:02 GMT', LONGITUDE: -67.5, LATITUDE: 18.3, COG: 270, SOG: 12, HEADING: 271, ROT: 0, PAC: 0, NAVSTAT: 0, IMO: 9123456, NAME: 'BIG SHIP', CALLSIGN: 'C6XX9', TYPE: 70, A: 100, B: 50, C: 10, D: 12, DRAUGHT: 7.5, DEST: 'SAN JUAN', ETA: '09-25 06:00' })

// Encode the message the way the Signal K connection does, then decode
// the frames the way the plotter does.
function roundTrip (msg) {
  const parser = new cb.FromPgn()
  let decoded
  for (const line of cb.pgnToYdgwRawFormat({ src: 100, ...msg })) {
    const r = parser.parseYDGW02('00:00:00.000 R ' + line)
    if (r) decoded = r
  }
  assert.ok(decoded, `PGN ${msg.pgn} did not decode`)
  return decoded
}

test('class B vessel becomes a class B position report the plotter decodes', () => {
  const msg = n2k.positionReport(CLASS_B)
  assert.strictEqual(msg.pgn, 129039)
  const d = roundTrip(msg)
  assert.strictEqual(d.fields.userId, 368341220)
  assert.ok(Math.abs(d.fields.latitude - 18.06746) < 1e-6)
  assert.ok(Math.abs(d.fields.longitude + 67.19226) < 1e-6)
  assert.ok(Math.abs(d.fields.cog - 108.3 * Math.PI / 180) < 1e-3, 'course in radians')
  assert.ok(Math.abs(d.fields.sog - 6.2 * 0.514444) < 0.01, 'speed in m/s')
  assert.strictEqual(d.fields.heading, undefined, 'heading not available')
  assert.strictEqual(Number(d.fields.timeStamp), 7, 'the UTC second of the report')
  assert.strictEqual(d.fields.repeatIndicator, 'Initial')
  assert.strictEqual(d.fields.positionAccuracy, 'High')
})

test('class A vessel becomes a class A position report with nav status', () => {
  const msg = n2k.positionReport(CLASS_A)
  assert.strictEqual(msg.pgn, 129038)
  const d = roundTrip(msg)
  assert.strictEqual(d.fields.userId, 311000123)
  assert.strictEqual(d.fields.navStatus, 'Under way using engine')
  assert.ok(Math.abs(d.fields.heading - 271 * Math.PI / 180) < 1e-3)
  assert.strictEqual(d.fields.rateOfTurn, 0)
})

test('class A static data carries name, callsign, type, size and destination', () => {
  const msgs = n2k.staticData(CLASS_A)
  assert.deepStrictEqual(msgs.map(m => m.pgn), [129794])
  const d = roundTrip(msgs[0])
  assert.strictEqual(d.fields.name, 'BIG SHIP')
  assert.strictEqual(d.fields.callsign, 'C6XX9')
  assert.strictEqual(d.fields.imoNumber, 9123456)
  assert.strictEqual(d.fields.typeOfShip, 'Cargo ship')
  assert.strictEqual(d.fields.length, 150)
  assert.strictEqual(d.fields.beam, 22)
  assert.strictEqual(d.fields.positionReferenceFromBow, 100)
  assert.strictEqual(d.fields.positionReferenceFromStarboard, 12)
  assert.strictEqual(d.fields.draft, 7.5)
  assert.strictEqual(d.fields.destination, 'SAN JUAN')
})

test('class B static data is the two-part message 24', () => {
  const msgs = n2k.staticData(CLASS_B)
  assert.deepStrictEqual(msgs.map(m => m.pgn), [129809, 129810])
  const a = roundTrip(msgs[0])
  assert.strictEqual(a.fields.name, 'NAUTI DREAM')
  const b = roundTrip(msgs[1])
  assert.strictEqual(b.fields.callsign, 'WDP2985')
  assert.strictEqual(b.fields.typeOfShip, 'Sailing')
  assert.strictEqual(b.fields.length, 14)
  assert.strictEqual(b.fields.beam, 4)
})

test('rate of turn decodes the AIS coding', () => {
  assert.strictEqual(n2k.rateOfTurn(undefined), undefined)
  assert.strictEqual(n2k.rateOfTurn(0), 0)
  assert.strictEqual(n2k.rateOfTurn(127), undefined)
  // coded 47 = 4.733 * sqrt(98.6) → about 98.6 deg/min → 0.0287 rad/s
  assert.ok(Math.abs(n2k.rateOfTurn(47) - 0.0287) < 0.001)
  assert.ok(n2k.rateOfTurn(-47) < 0)
})
