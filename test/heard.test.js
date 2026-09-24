const test = require('node:test')
const assert = require('node:assert')
const { parseLine, mmsiFromFrame, HeardList } = require('../lib/heard')

test('reads the MMSI from the first frame of an AIS message', () => {
  // First frame of a class A position report from bus address 1 (AIS700), MMSI 368066270
  const frame = parseLine('11:08:03.123 R 11F80F01 80 1B 12 DE 3E F0 15 95')
  assert.strictEqual(frame.src, 1)
  assert.strictEqual(frame.pgn, 129039)
  assert.strictEqual(mmsiFromFrame(frame), 368066270)
})

test('ignores later frames, other PGNs and transmitted lines', () => {
  assert.strictEqual(mmsiFromFrame(parseLine('11:08:03.123 R 11F80F01 81 12 34 56 78 9A BC DE')), undefined, 'second frame')
  assert.strictEqual(mmsiFromFrame(parseLine('11:08:03.123 R 09F80101 80 1B 12 DE 3E F0 15 95')), undefined, 'not AIS')
  assert.strictEqual(parseLine('11:08:03.123 T 11F80F64 80 1B 12 DE 3E F0 15 95'), undefined, 'our own transmitted frame echoed by the gateway')
  assert.strictEqual(mmsiFromFrame(parseLine('11:08:03.123 R 11F80F01 80 1B')), undefined, 'too short')
})

test('remembers when each vessel was heard and forgets old ones', () => {
  const heard = new HeardList()
  heard.note(111, 1000)
  heard.note(222, 5000)
  assert.ok(heard.heardWithin(111, 4000, 5000))
  assert.ok(!heard.heardWithin(111, 3999, 5000))
  assert.ok(!heard.heardWithin(333, 60000, 5000))
  heard.prune(3000, 5000)
  assert.strictEqual(heard.size, 1)
  assert.strictEqual(heard.lastHeard(222), 5000)
})
