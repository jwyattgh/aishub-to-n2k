/*
 * Send an AISHub vessel straight to the Yacht Devices YDWG-02 gateway.
 *
 * The gateway takes CAN frames over UDP, one per line ("canId b0 .. b7").
 * Each of the vessel's messages (position, then static data) is written
 * as its frames, and sent to the gateway in a way measured on ORION to
 * arrive whole:
 *
 *   - every message goes in ONE UDP packet, all its frames together. Sent
 *     as one packet per frame, the gateway lost roughly every other frame
 *     of every message; as one packet per message it never lost a frame.
 *   - messages go to the gateway SEND_GAP_MS apart. Fired back to back, a
 *     poll's worth (37 messages) had only 13 to 15 confirmed by the
 *     gateway; 10 ms apart, 22; 20 ms apart, 32 to 37 of 37 over nine
 *     runs (mostly 34 or more), and no better at 50 or 100 ms. A poll of
 *     25 vessels takes under a second. Every vessel is sent again next
 *     poll, so a message the gateway misses is made good a minute later.
 *
 * The gateway puts its own bus address on what it transmits, so the
 * source address written here never reaches the bus.
 */
const dgram = require('dgram')
const cb = require('@canboat/canboatjs')

const SOURCE_ADDRESS = 101
const SEND_GAP_MS = 20

// One message as the gateway's lines, ready to go in one packet.
function encode (msg) {
  return cb.pgnToYdgwRawFormat({ src: SOURCE_ADDRESS, ...msg }).join('\r\n') + '\r\n'
}

// A sender to one gateway. send(msg) queues the message and returns at
// once; messages leave one packet each, SEND_GAP_MS apart. A send error
// is reported through onError(err). close() drops what is still queued.
function createSender (host, port, onError) {
  const socket = dgram.createSocket('udp4')
  socket.on('error', err => onError && onError(err))
  const queue = []
  let timer
  let closed = false

  function sendNext () {
    const msg = queue.shift()
    if (msg === undefined) {
      timer = undefined
      return
    }
    socket.send(Buffer.from(encode(msg)), port, host, err => {
      if (err && onError && !closed) onError(err)
    })
    timer = setTimeout(sendNext, SEND_GAP_MS)
  }

  return {
    send (msg) {
      if (closed) return
      queue.push(msg)
      if (!timer) sendNext()
    },
    queued () {
      return queue.length
    },
    close () {
      closed = true
      queue.length = 0
      clearTimeout(timer)
      timer = undefined
      try { socket.close() } catch (err) { /* already closed */ }
    }
  }
}

module.exports = { encode, createSender, SOURCE_ADDRESS, SEND_GAP_MS }
