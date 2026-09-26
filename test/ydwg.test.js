const test = require('node:test')
const assert = require('node:assert')
const dgram = require('dgram')
const cb = require('@canboat/canboatjs')
const ydwg = require('../lib/ydwg')
const n2k = require('../lib/n2k')
const aishub = require('../lib/aishub')

const CLASS_A = aishub.normalize({ MMSI: 311000123, TIME: '2026-09-24 01:26:02 GMT', LONGITUDE: -67.5, LATITUDE: 18.3, COG: 270, SOG: 12, HEADING: 271, ROT: 0, PAC: 0, NAVSTAT: 0, IMO: 9123456, NAME: 'BIG SHIP', CALLSIGN: 'C6XX9', TYPE: 70, A: 100, B: 50, C: 10, D: 12, DRAUGHT: 7.5, DEST: 'SAN JUAN', ETA: '09-25 06:00' })

// A stand-in gateway: a UDP socket on this machine that keeps each packet.
function fakeGateway () {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    const packets = []
    socket.on('message', m => packets.push(m.toString()))
    socket.bind(0, '127.0.0.1', () => resolve({ port: socket.address().port, packets, close: () => socket.close() }))
  })
}

const until = (check, ms = 2000) => new Promise((resolve, reject) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (check()) { clearInterval(timer); resolve() } else if (Date.now() - started > ms) { clearInterval(timer); reject(new Error('timed out')) }
  }, 10)
})

test('a message is one packet: every frame of it, one per line, in the gateway RAW format', () => {
  const [pos, stat] = [n2k.positionReport(CLASS_A), ...n2k.staticData(CLASS_A)]
  const lines = ydwg.encode(stat).split('\r\n')
  assert.strictEqual(lines[lines.length - 1], '', 'ends with the gateway line ending')
  lines.pop()
  assert.strictEqual(lines.length, 11, 'class A static data is eleven frames')
  for (const line of lines) assert.match(line, /^[0-9a-f]{8}( [0-9a-f]{2}){8}$/, `frame line: ${line}`)
  assert.strictEqual(ydwg.encode(pos).split('\r\n').length - 1, 5, 'class A position is five frames')
})

test('the gateway receives each message whole, in one packet, spaced out, and decodes it', async () => {
  const gw = await fakeGateway()
  const errors = []
  const sender = ydwg.createSender('127.0.0.1', gw.port, e => errors.push(e))
  try {
    const messages = [n2k.positionReport(CLASS_A), ...n2k.staticData(CLASS_A)]
    const started = Date.now()
    messages.forEach(m => sender.send(m))
    assert.strictEqual(sender.queued(), 1, 'the first message went at once, the second waits its turn')
    await until(() => gw.packets.length >= 2)
    assert.ok(Date.now() - started >= ydwg.SEND_GAP_MS - 2, `the second message waited ${ydwg.SEND_GAP_MS} ms`)
    assert.strictEqual(gw.packets.length, 2, 'one packet per message')
    assert.strictEqual(sender.queued(), 0)
    assert.deepStrictEqual(errors, [])
    const parser = new cb.FromPgn()
    const decoded = gw.packets.map(p => {
      let out
      for (const line of p.split('\r\n').filter(Boolean)) {
        const r = parser.parseYDGW02('00:00:00.000 R ' + line)
        if (r) out = r
      }
      return out
    })
    assert.deepStrictEqual(decoded.map(d => d && d.pgn), [129038, 129794])
    assert.strictEqual(decoded[1].fields.name, 'BIG SHIP')
    assert.strictEqual(decoded[0].fields.userId, 311000123)
  } finally {
    sender.close()
    gw.close()
  }
})

test('close drops what is still queued, and nothing more is sent or raised', async () => {
  const gw = await fakeGateway()
  const errors = []
  const sender = ydwg.createSender('127.0.0.1', gw.port, e => errors.push(e))
  try {
    const messages = [n2k.positionReport(CLASS_A), ...n2k.staticData(CLASS_A)]
    messages.forEach(m => sender.send(m)) // the first goes now, the second is queued
    await until(() => gw.packets.length >= 1)
    sender.close()
    sender.send(n2k.positionReport(CLASS_A))
    await new Promise(r => setTimeout(r, ydwg.SEND_GAP_MS * 3))
    assert.strictEqual(gw.packets.length, 1, 'only the message already on its way')
    assert.deepStrictEqual(errors, [])
  } finally {
    gw.close()
  }
})
