/*
 * Ask AISHub for the vessels in a box and turn its reply into plain
 * vessel records.
 *
 * AISHub's web service (https://www.aishub.net/api) answers a GET on
 * ws.php with a JSON array: the first element is a header, the second the
 * list of vessels. With format=1 the numbers are in degrees and knots and
 * the "not available" markers are the AIS ones: course 360, heading 511,
 * speed 102.4, rate of turn 128 (the raw -128 in the AIS message).
 *
 * AISHub allows one request per minute per account. Nothing here sends
 * anything to AISHub except the request itself.
 */
const http = require('http')
const https = require('https')

const DEFAULT_URL = 'https://data.aishub.net/ws.php'
const REQUEST_TIMEOUT_MS = 30000

function buildUrl (apiKey, box, baseUrl) {
  const url = new URL(baseUrl || DEFAULT_URL)
  url.searchParams.set('username', apiKey)
  url.searchParams.set('format', '1')
  url.searchParams.set('output', 'json')
  url.searchParams.set('compress', '0')
  url.searchParams.set('latmin', String(box.latmin))
  url.searchParams.set('latmax', String(box.latmax))
  url.searchParams.set('lonmin', String(box.lonmin))
  url.searchParams.set('lonmax', String(box.lonmax))
  return url.toString()
}

// The URL with the API key blanked, for logs and status lines.
function redact (url) {
  return String(url).replace(/username=[^&]*/, 'username=HIDDEN')
}

function fetchText (url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, { headers: { 'user-agent': 'aishub-to-n2k' } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`AISHub answered HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
          return
        }
        resolve(text)
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => req.destroy(new Error('AISHub request timed out')))
    req.on('error', reject)
  })
}

// Returns { header, vessels } or throws with AISHub's own error message.
function parseReply (text) {
  let reply
  try {
    reply = JSON.parse(text)
  } catch (err) {
    throw new Error(`AISHub reply is not JSON: ${String(text).slice(0, 200)}`)
  }
  if (!Array.isArray(reply) || reply.length === 0 || typeof reply[0] !== 'object') {
    throw new Error('AISHub reply has an unexpected shape')
  }
  const header = reply[0]
  if (header.ERROR) {
    throw new Error(`AISHub: ${header.ERROR_MESSAGE || 'error'}`)
  }
  const records = Array.isArray(reply[1]) ? reply[1] : []
  return { header, vessels: records.map(normalize).filter(Boolean) }
}

// AISHub's TIME looks like "2026-09-24 01:27:07 GMT".
function parseTime (s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''))
  if (!m) return undefined
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

function num (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function unless (v, sentinel) {
  return v === sentinel ? undefined : v
}

// One AISHub record as a plain vessel. Units are left as AISHub gives
// them (degrees, knots, metres); the "not available" markers become
// undefined. Records without an MMSI or a position are dropped.
function normalize (r) {
  const mmsi = num(r.MMSI)
  const latitude = num(r.LATITUDE)
  const longitude = num(r.LONGITUDE)
  if (!mmsi || latitude === undefined || longitude === undefined) return undefined
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined
  const imo = num(r.IMO) || 0
  const a = num(r.A) || 0
  const b = num(r.B) || 0
  const c = num(r.C) || 0
  const d = num(r.D) || 0
  const rot = num(r.ROT)
  const v = {
    mmsi,
    time: parseTime(r.TIME),
    latitude,
    longitude,
    cogDegrees: unless(num(r.COG), 360),
    sogKnots: unless(num(r.SOG), 102.4),
    headingDegrees: unless(num(r.HEADING), 511),
    // AISHub passes the AIS rate-of-turn field through as is: -128 (or
    // 128) means not available, the rest is the coded AIS value.
    rotCoded: rot === undefined || rot === 128 || rot === -128 ? undefined : rot,
    positionAccuracy: num(r.PAC) === 1 ? 1 : 0,
    navStatus: num(r.NAVSTAT) !== undefined ? num(r.NAVSTAT) : 15,
    imo,
    name: cleanText(r.NAME),
    callsign: cleanText(r.CALLSIGN),
    shipType: num(r.TYPE) || 0,
    toBow: a,
    toStern: b,
    toPort: c,
    toStarboard: d,
    length: a + b,
    beam: c + d,
    draught: num(r.DRAUGHT) || 0,
    destination: cleanText(r.DEST),
    eta: cleanEta(r.ETA),
    class: undefined
  }
  v.class = chooseClass(v)
  return v
}

// AISHub does not say what kind of transponder a vessel has, so the class
// is chosen from the data: anything that only fits in the class A messages
// (navigation status, destination, ETA, draught, rate of turn, IMO number)
// makes it class A, so none of it is dropped. Everything else fits in the
// class B messages, and small boats keep their class B symbol.
function chooseClass (v) {
  const classAOnly = v.navStatus !== 15 || v.destination !== '' || v.eta !== '' ||
    v.draught > 0 || v.rotCoded !== undefined || (v.imo >= 1000000 && v.imo <= 9999999)
  return classAOnly ? 'A' : 'B'
}

// AISHub sends "00-00 00:00" when there is no ETA.
function cleanEta (text) {
  const eta = cleanText(text)
  return /^0*-0* 0*:0*$/.test(eta) ? '' : eta
}

function cleanText (s) {
  if (s === undefined || s === null) return ''
  return String(s).replace(/@+$/, '').trim()
}

async function fetchVessels (apiKey, box, options) {
  const opts = options || {}
  const url = buildUrl(apiKey, box, opts.baseUrl)
  const text = await (opts.fetchText || fetchText)(url, opts.timeoutMs)
  return parseReply(text)
}

module.exports = { DEFAULT_URL, buildUrl, redact, fetchText, parseReply, parseTime, normalize, fetchVessels }
