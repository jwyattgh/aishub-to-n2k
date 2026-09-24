/*
 * Which vessels has our own AIS receiver heard, and when?
 *
 * Every AIS message on NMEA 2000 starts the same way: message id and
 * repeat indicator in the first byte, then the MMSI as a 32-bit
 * little-endian number. All of them are fast-packet messages, so the
 * MMSI is in the first frame, right after the frame's sequence byte and
 * length byte. That is enough to keep a "last heard" time per MMSI
 * without rebuilding whole messages.
 */

// Every AIS PGN an NMEA 2000 receiver can put on the bus.
const AIS_PGNS = new Set([
  129038, // class A position
  129039, // class B position
  129040, // class B extended position
  129041, // aid to navigation
  129793, // UTC and date report (message 4)
  129794, // class A static and voyage data
  129798, // SAR aircraft position
  129801, // addressed safety message
  129802, // broadcast safety message
  129809, // class B static, part A
  129810 // class B static, part B
])

// Parse one YDWG RAW receive line into { src, pgn, data }.
function parseLine (line) {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 4 || parts[1] !== 'R') return undefined
  const id = parseInt(parts[2], 16)
  if (Number.isNaN(id)) return undefined
  const src = id & 0xff
  const ps = (id >> 8) & 0xff
  const pf = (id >> 16) & 0xff
  const dp = (id >> 24) & 0x01
  const pgn = (dp << 16) | (pf << 8) | (pf >= 240 ? ps : 0)
  const data = Buffer.from(parts.slice(3).map(h => parseInt(h, 16)))
  return { src, pgn, data }
}

// The MMSI in the first frame of an AIS message, or undefined if this is
// not a first frame (or not an AIS message).
function mmsiFromFrame (frame) {
  if (!frame || !AIS_PGNS.has(frame.pgn)) return undefined
  const d = frame.data
  if (d.length < 7) return undefined
  if ((d[0] & 0x1f) !== 0) return undefined // not the first frame
  const mmsi = d.readUInt32LE(3)
  return mmsi > 0 && mmsi <= 999999999 ? mmsi : undefined
}

class HeardList {
  constructor () {
    this.seen = new Map()
  }

  note (mmsi, now) {
    this.seen.set(mmsi, now)
  }

  lastHeard (mmsi) {
    return this.seen.get(mmsi)
  }

  heardWithin (mmsi, ms, now) {
    const at = this.seen.get(mmsi)
    return at !== undefined && now - at <= ms
  }

  // Forget vessels not heard for a while, so the list does not grow forever.
  prune (ms, now) {
    for (const [mmsi, at] of this.seen) {
      if (now - at > ms) this.seen.delete(mmsi)
    }
  }

  get size () {
    return this.seen.size
  }
}

module.exports = { AIS_PGNS, parseLine, mmsiFromFrame, HeardList }
