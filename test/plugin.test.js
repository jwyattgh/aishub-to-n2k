const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')

const AIS700 = 'c078c37ae76baa6d'
const CONNECTION = 'ydwg-n2k-udp'

function fakeApp () {
  const app = new EventEmitter()
  app.config = {
    settings: {
      pipedProviders: [
        { id: 'gps-0183', pipeElements: [{ options: { type: 'NMEA0183', subOptions: { type: 'udp' } } }] },
        { id: CONNECTION, pipeElements: [{ options: { type: 'NMEA2000', subOptions: { type: 'ydwg02-udp-canboatjs', port: 1458 } } }] }
      ]
    }
  }
  app.self = { mmsi: '368066270', position: { latitude: 18.06888, longitude: -67.19 } }
  app.getSelfPath = p => {
    if (p === 'mmsi') return app.self.mmsi
    if (p === 'navigation.position') return app.self.position && { value: app.self.position }
    return undefined
  }
  // What Signal K holds for other vessels: app.vessels[mmsi] = navigation.position entry
  app.vessels = {}
  app.getPath = p => {
    const m = /^vessels\.urn:mrn:imo:mmsi:(\d+)\.navigation\.position$/.exec(p)
    return m ? app.vessels[m[1]] : undefined
  }
  app.setPluginStatus = t => { app.status = t }
  app.setPluginError = () => {}
  app.debug = () => {}
  app.error = m => { app.errors = (app.errors || []).concat(m) }
  app.n2kOut = [] // what the fake gateway sender is given
  app.signalk = {
    retrieve: () => ({
      sources: {
        [CONNECTION]: {
          1: { n2k: { canName: AIS700, modelId: 'AIS700' } },
          7: { n2k: { canName: 'c0f08261e7701bfb', modelId: 'i70s' } }
        }
      }
    })
  }
  return app
}

// Start the plugin with the AISHub fetcher swapped for one that answers
// from a list of replies, one per poll (the last one repeats). The box
// each request asked for is kept in `boxes`.
function startWith (app, options, replies) {
  const aishub = require('../lib/aishub')
  const ydwg = require('../lib/ydwg')
  const original = aishub.fetchVessels
  const originalSender = ydwg.createSender
  // The gateway sender is swapped for one that records what it is given.
  ydwg.createSender = () => ({ send: m => app.n2kOut.push(m), close: () => {} })
  const boxes = []
  let n = 0
  aishub.fetchVessels = async (key, box) => {
    boxes.push(box)
    const reply = replies[Math.min(n++, replies.length - 1)]
    return { header: {}, vessels: reply.map(aishub.normalize) }
  }
  const plugin = require('..')(app)
  plugin.start({
    apiKey: 'AH_TEST',
    connection: CONNECTION,
    devices: [AIS700],
    ...options
  })
  return { plugin, boxes, restore: () => { aishub.fetchVessels = original; ydwg.createSender = originalSender } }
}

// AISHub's TIME for a moment `secondsAgo` before now.
function timeAgo (secondsAgo) {
  return new Date(Date.now() - secondsAgo * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' GMT'
}

// The first frame of a class B position report from bus address 1 (the AIS700).
function busFrame (mmsi) {
  const b = Buffer.alloc(4); b.writeUInt32LE(mmsi)
  return `11:08:03.123 R 11F80F01 80 1B 12 ${[...b].map(x => x.toString(16).padStart(2, '0')).join(' ')} 95`
}

const BASE = { MMSI: 367704910, TIME: timeAgo(0), LONGITUDE: -67.18911, LATITUDE: 18.07371, COG: 360, SOG: 0, HEADING: 511, ROT: 128, PAC: 0, NAVSTAT: 15, IMO: 0, NAME: 'CARPE DIEM', CALLSIGN: 'WD15075', TYPE: 36, A: 13, B: 8, C: 4, D: 4 }
const OWN = { ...BASE, MMSI: 368066270, NAME: 'ORION' }
const HEARD_ON_BUS = { ...BASE, MMSI: 367704910, NAME: 'CARPE DIEM', TIME: timeAgo(30) }
const HEARD_IN_SIGNALK = { ...BASE, MMSI: 368341220, NAME: 'NAUTI DREAM', TIME: timeAgo(30) }
const NEWER_THAN_OWN = { ...BASE, MMSI: 368178850, NAME: 'DON TUTO', TIME: timeAgo(0) }
const NEVER_HEARD = { ...BASE, MMSI: 367642060, NAME: 'VIDA', CALLSIGN: 'WDL1234', LATITUDE: 18.1, LONGITUDE: -67.2 }
const FAR_SHIP = { ...BASE, MMSI: 311000123, NAME: 'BIG SHIP', IMO: 9123456, TYPE: 70, LATITUDE: 19.5, LONGITUDE: -68.5, TIME: timeAgo(600) }

// Let the poll's promise chain settle.
const settle = () => new Promise(r => setImmediate(r))

// Fake setTimeout so polls can be triggered without waiting 61 seconds:
// every pending timer fires on tick(). Plain replacement of the globals,
// which works the same on every Node version.
function fakeTimers (t) {
  const realSet = global.setTimeout
  const realClear = global.clearTimeout
  const pending = []
  global.setTimeout = (fn, ms) => { const h = { fn, ms }; pending.push(h); return h }
  global.clearTimeout = h => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1) }
  t.after(() => { global.setTimeout = realSet; global.clearTimeout = realClear })
  return { tick: () => pending.splice(0).forEach(h => h.fn()) }
}

test('sends only the vessels the own receiver does not have as new a message from', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  // Signal K already holds NAUTI DREAM from the AIS700 (source label <connection>.<address>),
  // heard a second ago; DON TUTO from it a minute ago.
  app.vessels[368341220] = { values: { [`${CONNECTION}.1`]: { timestamp: new Date(Date.now() - 1000).toISOString() } } }
  app.vessels[368178850] = { $source: `${CONNECTION}.1`, timestamp: new Date(Date.now() - 60000).toISOString() }
  const { plugin, restore } = startWith(app, {}, [[OWN, HEARD_ON_BUS, HEARD_IN_SIGNALK, NEWER_THAN_OWN, NEVER_HEARD, FAR_SHIP]])
  try {
    app.emit('canboatjs:rawoutput', busFrame(367704910)) // the AIS700 reports CARPE DIEM now
    timers.tick()
    await settle()
    assert.match(app.status, /6 from AISHub, 2 own receiver has, 3 sent to plotters \(0 repeats of the last report, 0 held while AISHub is quiet, 8 messages\)/)
    // DON TUTO and VIDA: class B position + two static messages; BIG SHIP: class A position + static
    const byMmsi = {}
    app.n2kOut.forEach(m => { byMmsi[m['User ID']] = (byMmsi[m['User ID']] || []).concat(m.pgn) })
    assert.deepStrictEqual(byMmsi, {
      368178850: [129039, 129809, 129810],
      367642060: [129039, 129809, 129810],
      311000123: [129038, 129794]
    })
    assert.match(app.status, /has reported 1 vessels since start/)
    assert.match(app.status, /sending to gateway 192\.168\.4\.25:1458$/)
  } finally {
    plugin.stop()
    restore()
  }
})

test('a report AISHub keeps returning is sent again every poll, so the plotters keep the target', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const newer = { ...NEVER_HEARD, TIME: timeAgo(-70) }
  const { plugin, restore } = startWith(app, {}, [[NEVER_HEARD, FAR_SHIP], [NEVER_HEARD, FAR_SHIP], [newer]])
  try {
    timers.tick()
    await settle()
    assert.strictEqual(app.n2kOut.length, 5)
    timers.tick()
    await settle()
    assert.strictEqual(app.n2kOut.length, 10, 'same two reports: sent again')
    assert.match(app.status, /2 from AISHub, 0 own receiver has, 2 sent to plotters \(2 repeats of the last report, 0 held while AISHub is quiet, 5 messages\)/)
    timers.tick()
    await settle()
    assert.strictEqual(app.n2kOut.length, 15, 'VIDA had a newer report; BIG SHIP, left out by AISHub, is held and sent again')
    assert.match(app.status, /1 from AISHub, 0 own receiver has, 2 sent to plotters \(1 repeats of the last report, 1 held while AISHub is quiet, 5 messages\)/)
  } finally {
    plugin.stop()
    restore()
  }
})

test('a vessel AISHub leaves out is held for its own padded gap between reports, then dropped', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const vida = { ...NEVER_HEARD, TIME: timeAgo(0) }
  const vidaLater = { ...NEVER_HEARD, TIME: timeAgo(-70) } // reported again 70 s later
  const { plugin, restore } = startWith(app, {}, [[vida, FAR_SHIP], [vidaLater, FAR_SHIP], [FAR_SHIP]])
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  try {
    timers.tick(); await settle()
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 10)
    // VIDA's gap between reports is 70 s; padded that is 88 s, but the hold
    // is never under two polls (122 s). 60 s of silence: still held.
    offset = 60 * 1000
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 15, 'VIDA held and sent, BIG SHIP repeated')
    assert.match(app.status, /1 from AISHub, 0 own receiver has, 2 sent to plotters \(2 repeats of the last report, 1 held while AISHub is quiet, 5 messages\); sending to gateway/)
    // 130 s of silence: past the hold, dropped.
    offset = 130 * 1000
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 17, 'only BIG SHIP now')
    assert.match(app.status, /1 sent to plotters \(1 repeats of the last report, 0 held while AISHub is quiet, 2 messages\), 1 dropped after AISHub went quiet/)
    assert.deepStrictEqual(app.n2kOut.slice(15).map(m => m['User ID']), [311000123, 311000123])
    // Once dropped it stays dropped until AISHub lists it again.
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 19)
    assert.match(app.status, /0 held while AISHub is quiet, 2 messages\); sending to gateway/)
  } finally {
    Date.now = realNow
    plugin.stop()
    restore()
  }
})

test('a held vessel the own receiver starts hearing is dropped at once', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const { plugin, restore } = startWith(app, {}, [[NEVER_HEARD], []])
  try {
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 3)
    app.emit('canboatjs:rawoutput', busFrame(367642060)) // the AIS700 reports VIDA now
    timers.tick(); await settle()
    assert.strictEqual(app.n2kOut.length, 3, 'nothing more sent')
    assert.match(app.status, /0 from AISHub, 1 own receiver has, 0 sent to plotters/)
  } finally {
    plugin.stop()
    restore()
  }
})

test('dry run sends nothing and writes each decision to the server log', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const lines = []
  const log = t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')))
  const { plugin, restore } = startWith(app, { dryRun: true }, [[OWN, HEARD_ON_BUS, NEVER_HEARD]])
  try {
    app.emit('canboatjs:rawoutput', busFrame(367704910))
    timers.tick()
    await settle()
    log.mock.restore()
    assert.strictEqual(app.n2kOut.length, 0)
    assert.match(app.status, /dry run/)
    assert.strictEqual(lines.length, 3)
    assert.match(lines[0], /^aishub-to-ydwg poll 1: 368066270 ORION \| AISHub \d\d:\d\d:\d\d \| own receiver never \| last sent never \| \d+\.\d km bearing \d\d\d \| -?\d+\.\d{4},-?\d+\.\d{4} \| class B \| sog .* \| nav \d+ .* \| type \d+ \| callsign .* imo .* \| \d+x\d+ m draught .* \| dest .* eta .* \| skip: own vessel$/)
    assert.match(lines[1], /367704910 CARPE DIEM \| AISHub \d\d:\d\d:\d\d \| own receiver \d\d:\d\d:\d\d \| last sent never \| .* \| skip: own receiver has it$/)
    assert.match(lines[2], /367642060 VIDA \| .* \| class B \| .* \| would send: own receiver has never heard it \(PGNs 129039, 129809, 129810\)$/)
  } finally {
    log.mock.restore()
    plugin.stop()
    restore()
  }
})

test('box distance is converted from the chosen unit, and the old boxKm setting still works', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const width = box => box.latmax - box.latmin
  const a = startWith(app, { boxDistance: 100, boxUnit: 'nm' }, [[]])
  timers.tick(); await settle(); a.plugin.stop(); a.restore()
  const b = startWith(app, { boxDistance: 100, boxUnit: 'mi' }, [[]])
  timers.tick(); await settle(); b.plugin.stop(); b.restore()
  const c = startWith(app, { boxKm: 100 }, [[]])
  timers.tick(); await settle(); c.plugin.stop(); c.restore()
  assert.ok(Math.abs(width(c.boxes[0]) - 1.797) < 0.01, '100 km each way')
  assert.ok(Math.abs(width(a.boxes[0]) - 1.797 * 1.852) < 0.01, '100 nautical miles each way')
  assert.ok(Math.abs(width(b.boxes[0]) - 1.797 * 1.609344) < 0.01, '100 statute miles each way')
})

test('settings form: gateway, connections, AIS devices, own MMSI from Signal K, units, dry run off, AISHub minimum interval', () => {
  const plugin = require('..')(fakeApp())
  const p = plugin.schema().properties
  assert.strictEqual(p.gatewayHost.default, '192.168.4.25')
  assert.strictEqual(p.gatewayPort.default, 1458)
  assert.deepStrictEqual(p.connection.enum, [CONNECTION])
  assert.deepStrictEqual(p.devices.items.enum, [AIS700])
  assert.match(p.devices.items.enumNames[0], /AIS700/)
  assert.strictEqual(p.mmsi.default, '368066270')
  assert.strictEqual(p.boxDistance.default, 100)
  assert.deepStrictEqual(p.boxUnit.enum, ['km', 'nm', 'mi'])
  assert.strictEqual(p.boxUnit.default, 'km')
  assert.strictEqual(p.pollSeconds.minimum, 61)
  assert.strictEqual(p.pollSeconds.default, 61)
  assert.strictEqual(p.dryRun.default, false)
  assert.deepStrictEqual(plugin.schema().required, ['apiKey', 'mmsi', 'gatewayHost', 'connection'])
  assert.strictEqual(plugin.uiSchema().apiKey['ui:widget'], 'password')
})

test('no API key, or no MMSI anywhere: says so and does not poll', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const a = startWith(app, { apiKey: '' }, [[NEVER_HEARD]])
  timers.tick(); await settle()
  assert.match(app.status, /No AISHub API key/)
  assert.strictEqual(a.boxes.length, 0)
  a.plugin.stop(); a.restore()
  app.self.mmsi = undefined
  const b = startWith(app, { mmsi: '' }, [[NEVER_HEARD]])
  timers.tick(); await settle()
  assert.match(app.status, /No MMSI set/)
  assert.strictEqual(b.boxes.length, 0)
  b.plugin.stop(); b.restore()
})

test('no own position: the poll is skipped until there is one', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  app.self.position = undefined
  const { plugin, boxes, restore } = startWith(app, {}, [[NEVER_HEARD]])
  try {
    timers.tick(); await settle()
    assert.strictEqual(boxes.length, 0)
    assert.match(app.status, /not polling: no own position yet/)
    app.self.position = { latitude: 18, longitude: -67 }
    timers.tick(); await settle()
    assert.strictEqual(boxes.length, 1)
  } finally {
    plugin.stop()
    restore()
  }
})

test('an AISHub error goes to the server log and the status, and the next poll tries again', async t => {
  const timers = fakeTimers(t)
  const app = fakeApp()
  const aishub = require('../lib/aishub')
  const original = aishub.fetchVessels
  let calls = 0
  aishub.fetchVessels = async () => {
    calls++
    if (calls === 1) throw new Error('AISHub: Too frequent requests!')
    return { header: {}, vessels: [aishub.normalize(NEVER_HEARD)] }
  }
  const ydwg = require('../lib/ydwg')
  const originalSender = ydwg.createSender
  ydwg.createSender = () => ({ send: m => app.n2kOut.push(m), close: () => {} })
  const plugin = require('..')(app)
  plugin.start({ apiKey: 'AH_TEST', connection: CONNECTION, devices: [AIS700] })
  try {
    timers.tick(); await settle()
    assert.deepStrictEqual(app.errors, ['AISHub: Too frequent requests!'])
    assert.match(app.status, /1 errors \(last: AISHub: Too frequent requests!\)/)
    timers.tick(); await settle()
    assert.strictEqual(calls, 2)
    assert.strictEqual(app.n2kOut.length, 3)
  } finally {
    plugin.stop()
    aishub.fetchVessels = original
    ydwg.createSender = originalSender
  }
})

