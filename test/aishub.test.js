const test = require('node:test')
const assert = require('node:assert')
const aishub = require('../lib/aishub')
const geo = require('../lib/geo')

// Shaped like a real AISHub reply (format=1), names and numbers changed.
const REPLY = JSON.stringify([
  { ERROR: false, USERNAME: 'AH_TEST', FORMAT: 'AIS', RECORDS: 3 },
  [
    { MMSI: 368341220, TIME: '2026-09-24 01:27:07 GMT', LONGITUDE: -67.19226, LATITUDE: 18.06746, COG: 108.3, SOG: 0.1, HEADING: 511, ROT: 128, PAC: 1, NAVSTAT: 15, IMO: 0, NAME: 'NAUTI DREAM', CALLSIGN: 'WDP2985', TYPE: 36, A: 5, B: 9, C: 2, D: 2, DRAUGHT: 0, DEST: '', ETA: '00-00 00:00' },
    { MMSI: 311000123, TIME: '2026-09-24 01:26:02 GMT', LONGITUDE: -67.5, LATITUDE: 18.3, COG: 360, SOG: 102.4, HEADING: 90, ROT: 0, PAC: 0, NAVSTAT: 0, IMO: 9123456, NAME: 'BIG SHIP', CALLSIGN: 'C6XX9', TYPE: 70, A: 100, B: 50, C: 10, D: 12, DRAUGHT: 7.5, DEST: 'SAN JUAN', ETA: '09-25 06:00' },
    { MMSI: 0, TIME: '2026-09-24 01:26:02 GMT', LONGITUDE: -67.5, LATITUDE: 18.3 }
  ]
])

test('builds the AISHub request without leaking the key into logs', () => {
  const box = geo.boxAround(18.07, -67.19, 100)
  const url = aishub.buildUrl('AH_SECRET', box)
  assert.match(url, /^https:\/\/data\.aishub\.net\/ws\.php\?/)
  assert.match(url, /username=AH_SECRET/)
  assert.match(url, /format=1/)
  assert.match(url, /output=json/)
  assert.match(url, /latmin=17\.17/)
  assert.doesNotMatch(aishub.redact(url), /SECRET/)
})

test('parses a reply into plain vessel records with AIS "not available" markers removed', () => {
  const { header, vessels } = aishub.parseReply(REPLY)
  assert.strictEqual(header.RECORDS, 3)
  assert.strictEqual(vessels.length, 2, 'the record without an MMSI is dropped')
  const [b, a] = vessels
  assert.strictEqual(b.mmsi, 368341220)
  assert.strictEqual(b.class, 'B', 'no IMO number means class B')
  assert.strictEqual(b.headingDegrees, undefined, '511 = heading not available')
  assert.strictEqual(b.rotCoded, undefined, '128 = rate of turn not available')
  assert.strictEqual(b.cogDegrees, 108.3)
  assert.strictEqual(b.sogKnots, 0.1)
  assert.strictEqual(b.length, 14)
  assert.strictEqual(b.beam, 4)
  assert.strictEqual(b.time, Date.UTC(2026, 8, 24, 1, 27, 7))
  assert.strictEqual(a.class, 'A')
  assert.strictEqual(a.cogDegrees, undefined, '360 = course not available')
  assert.strictEqual(a.sogKnots, undefined, '102.4 = speed not available')
  assert.strictEqual(a.headingDegrees, 90)
  assert.strictEqual(a.rotCoded, 0)
  assert.strictEqual(a.draught, 7.5)
  assert.strictEqual(a.destination, 'SAN JUAN')
})

test('AISHub errors come back as errors', () => {
  assert.throws(() => aishub.parseReply('[{"ERROR":true,"ERROR_MESSAGE":"Too frequent requests!"}]'), /Too frequent/)
  assert.throws(() => aishub.parseReply('<html>'), /not JSON/)
})

test('fetchVessels uses the injected fetcher', async () => {
  let asked
  const { vessels } = await aishub.fetchVessels('AH_X', geo.boxAround(18, -67, 10), {
    fetchText: async url => { asked = url; return REPLY }
  })
  assert.match(asked, /username=AH_X/)
  assert.strictEqual(vessels.length, 2)
})

test('box', () => {
  const box = geo.boxAround(18.07, -67.19, 100)
  assert.ok(box.latmin < 18.07 && box.latmax > 18.07)
  assert.ok(box.lonmin < -67.19 && box.lonmax > -67.19)
  assert.ok(Math.abs((box.latmax - box.latmin) - 1.797) < 0.01, 'about 1.8 degrees of latitude for 200 km')
  const polar = geo.boxAround(89.9, 10, 100)
  assert.strictEqual(polar.latmax, 90)
  assert.strictEqual(polar.lonmin, -180)
  assert.strictEqual(polar.lonmax, 180)
  const dateline = geo.boxAround(0, 179.9, 100)
  assert.strictEqual(dateline.lonmax, 180)
})
