const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

const AIS700 = 'c078c37ae76baa6d'

function fakeApp () {
  const app = new EventEmitter()
  app.config = {
    settings: {
      pipedProviders: [
        { id: 'gps-0183', pipeElements: [{ options: { type: 'NMEA0183', subOptions: { type: 'udp' } } }] },
        { id: 'ydwg-n2k-udp', pipeElements: [{ options: { type: 'NMEA2000', subOptions: { type: 'ydwg02-udp-canboatjs', port: 1458 } } }] }
      ]
    }
  }
  app.self = { mmsi: '368066270', position: { latitude: 18.06888, longitude: -67.19 } }
  app.getSelfPath = p => {
    if (p === 'mmsi') return app.self.mmsi
    if (p === 'navigation.position') return app.self.position && { value: app.self.position }
    return undefined
  }
  app.getDataDirPath = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aishub-to-n2k-'))
  app.setPluginStatus = t => { app.status = t }
  app.setPluginError = () => {}
  app.debug = () => {}
  app.error = m => { app.errors = (app.errors || []).concat(m) }
  app.deltas = []
  app.handleMessage = (id, delta) => app.deltas.push(delta)
  app.n2kOut = []
  app.on('nmea2000JsonOut', m => app.n2kOut.push(m))
  app.signalk = {
    retrieve: () => ({
      sources: {
        'ydwg-n2k-udp': {
          1: { n2k: { canName: AIS700, modelId: 'AIS700' } },
          7: { n2k: { canName: 'c0f08261e7701bfb', modelId: 'i70s' } }
        }
      }
    })
  }
  return app
}

// Run the plugin's own processing on a set of vessels without waiting
// for a poll: start it, feed the bus, then call the internals through
// the reply the fetcher would have given. To keep the plugin honest we
// go through the real poll by swapping the fetcher.
function startWith (app, options, reply) {
  const aishub = require('../lib/aishub')
  const original = aishub.fetchVessels
  aishub.fetchVessels = async () => ({ header: {}, vessels: reply.map(aishub.normalize) })
  const plugin = require('..')(app)
  plugin.start({
    apiKey: 'AH_TEST',
    connection: 'ydwg-n2k-udp',
    devices: [AIS700],
    dryRun: false,
    plotterRangeNm: 50,
    ...options
  })
  return { plugin, restore: () => { aishub.fetchVessels = original } }
}

const NEAR_HEARD = { MMSI: 367704910, TIME: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' GMT', LONGITUDE: -67.18911, LATITUDE: 18.07371, COG: 360, SOG: 0, HEADING: 511, ROT: 128, PAC: 0, NAVSTAT: 15, IMO: 0, NAME: 'CARPE DIEM', CALLSIGN: 'WD15075', TYPE: 36, A: 13, B: 8, C: 4, D: 4 }
const NEAR_UNHEARD = { ...NEAR_HEARD, MMSI: 367642060, NAME: 'VIDA', CALLSIGN: 'WDL1234', LATITUDE: 18.1, LONGITUDE: -67.2 }
const OWN = { ...NEAR_HEARD, MMSI: 368066270, NAME: 'ORION' }
const FAR = { ...NEAR_HEARD, MMSI: 311000123, NAME: 'BIG SHIP', IMO: 9123456, TYPE: 70, LATITUDE: 19.5, LONGITUDE: -68.5 }
const STALE = { ...NEAR_HEARD, MMSI: 367000001, NAME: 'OLD NEWS', TIME: '2026-01-01 00:00:00 GMT' }

const sleep = ms => new Promise(r => setTimeout(r, ms))

test('sends only the vessels our own receiver has not heard, and only those in range', async () => {
  const app = fakeApp()
  app.isNmea2000OutAvailable = true
  const { plugin, restore } = startWith(app, {}, [NEAR_HEARD, NEAR_UNHEARD, OWN, FAR, STALE])
  try {
    // The AIS700 (bus address 1) reports CARPE DIEM: first frame of a class B position report.
    const mmsiBytes = Buffer.alloc(4); mmsiBytes.writeUInt32LE(367704910)
    app.emit('canboatjs:rawoutput', `11:08:03.123 R 11F80F01 80 1B 12 ${[...mmsiBytes].map(b => b.toString(16).padStart(2, '0')).join(' ')} 95`)
    await sleep(1200)
    const status = JSON.parse(JSON.stringify(statusOf(plugin)))
    assert.strictEqual(status.lastPoll.inBox, 5)
    assert.strictEqual(status.lastPoll.ownVessel, 1)
    assert.strictEqual(status.lastPoll.heardByOwnReceiver, 1)
    assert.strictEqual(status.lastPoll.outOfRange, 1)
    assert.strictEqual(status.lastPoll.tooOld, 1)
    assert.strictEqual(status.lastPoll.sentToPlotters, 1)
    assert.deepStrictEqual(status.lastPoll.sentMmsis, [367642060])
    // VIDA: position + the two class B static messages on first sight
    assert.deepStrictEqual(app.n2kOut.map(m => m.pgn), [129039, 129809, 129810])
    assert.ok(app.n2kOut.every(m => m['User ID'] === 367642060))
    // Every vessel except our own went into Signal K
    assert.strictEqual(status.lastPoll.intoSignalK, 4)
    assert.ok(app.deltas.some(d => d.context.endsWith('367704910')), 'heard vessel still goes into Signal K')
    assert.ok(!app.deltas.some(d => d.context.endsWith('368066270')), 'own vessel never does')
    assert.match(app.status, /1 heard by own receiver, 1 sent to plotters \(3 messages\)/)
  } finally {
    plugin.stop()
    restore()
  }
})

test('with output unavailable nothing is emitted and the status says why', async () => {
  const app = fakeApp()
  app.isNmea2000OutAvailable = false
  const { plugin, restore } = startWith(app, {}, [NEAR_UNHEARD])
  try {
    await sleep(1200)
    assert.strictEqual(app.n2kOut.length, 0)
    assert.strictEqual(statusOf(plugin).lastPoll.notSentNoOutput, 3)
    assert.match(app.status, /NMEA 2000 output NOT available/)
    // The connection becomes able to send: the next poll goes out.
    app.emit('nmea2000OutAvailable')
    assert.strictEqual(statusOf(plugin).nmea2000OutAvailable, true)
  } finally {
    plugin.stop()
    restore()
  }
})

test('dry run writes the messages to a log file instead', async () => {
  const app = fakeApp()
  app.isNmea2000OutAvailable = true
  const { plugin, restore } = startWith(app, { dryRun: true }, [NEAR_UNHEARD])
  try {
    await sleep(1200)
    assert.strictEqual(app.n2kOut.length, 0)
    const s = statusOf(plugin)
    assert.ok(s.dryRun)
    const lines = fs.readFileSync(s.logPath, 'utf8').trim().split('\n')
    assert.strictEqual(lines.length, 3)
    assert.match(lines[0], /"pgn":129039/)
  } finally {
    plugin.stop()
    restore()
  }
})

test('settings form lists NMEA 2000 connections and AIS devices, and enforces the AISHub minimum interval', () => {
  const plugin = require('..')(fakeApp())
  const p = plugin.schema().properties
  assert.deepStrictEqual(p.connection.enum, ['ydwg-n2k-udp'])
  assert.deepStrictEqual(p.devices.items.enum, [AIS700])
  assert.match(p.devices.items.enumNames[0], /AIS700/)
  assert.strictEqual(p.pollSeconds.minimum, 61)
  assert.strictEqual(p.pollSeconds.default, 61)
  assert.strictEqual(p.boxKm.default, 100)
  assert.strictEqual(plugin.uiSchema().apiKey['ui:widget'], 'password')
})

test('no API key: says so and does not poll', async () => {
  const app = fakeApp()
  const { plugin, restore } = startWith(app, { apiKey: '' }, [NEAR_UNHEARD])
  try {
    await sleep(1200)
    assert.strictEqual(statusOf(plugin).polls, 0)
    assert.match(app.status, /No AISHub API key/)
  } finally {
    plugin.stop()
    restore()
  }
})

// Read the plugin's /status endpoint through its router registration.
function statusOf (plugin) {
  let out
  plugin.registerWithRouter({
    get: (route, handler) => {
      if (route === '/status') handler({}, { json: v => { out = v } })
    }
  })
  return out
}
