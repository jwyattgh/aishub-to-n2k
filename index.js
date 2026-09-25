/*
 * @sv-orion/aishub-to-n2k: a Signal K plugin (plugin id aishub-to-n2k).
 *
 * Every poll:
 *   1. Ask AISHub for the vessels in a box around the boat.
 *   2. Read the JSON reply.
 *   3. Drop our own vessel, and every vessel our own AIS receiver has a
 *      message from that is as new as AISHub's. AISHub puts the time of
 *      the vessel's own transmission on each record, and the receiver's
 *      last message time for each MMSI is read straight off the NMEA 2000
 *      bus (from the devices chosen in the settings) and from what Signal
 *      K already holds for that vessel from those devices.
 *      The rest go every poll, even when AISHub's record is unchanged,
 *      so the plotters keep the target through the gaps between a
 *      vessel's reports. A vessel AISHub leaves out of a reply is kept,
 *      and sent, until AISHub has been quiet about it for longer than
 *      its own average gap between reports (padded a little); then it is
 *      dropped and the plotters drop it the way they drop any lost target.
 *   4. Turn the rest into NMEA 2000 AIS messages: position, name and
 *      details, every poll.
 *   5. Hand those to the chosen NMEA 2000 connection, which sends them to
 *      the bus, so the plotters show the targets.
 *
 * Nothing here ever sends anything to AISHub except the request.
 */
const aishub = require('./lib/aishub')
const geo = require('./lib/geo')
const n2k = require('./lib/n2k')
const { HeardList, parseLine, mmsiFromFrame } = require('./lib/heard')

const ADDRESS_CLAIM = 60928
const MIN_POLL_SECONDS = 61 // AISHub's rule: one request per minute
const LOOKUP_REFRESH_MS = 5000
const HEARD_KEEP_MS = 24 * 60 * 60 * 1000
// AISHub's times are whole seconds and the receiver's carry fractions, so
// the same message can differ by a second either way. Ten seconds covers it.
const CLOCK_TOLERANCE_MS = 10 * 1000
// A vessel AISHub leaves out of a reply is kept for its own average gap
// between reports, padded by this much, before it is dropped.
const HOLD_PADDING = 1.25
const GAP_HISTORY = 10 // gaps per vessel the average is taken over
const ANCHORED_REPORT_MS = 3 * 60 * 1000 // AIS reporting interval of a ship at anchor
const KM_PER_UNIT = { km: 1, nm: 1.852, mi: 1.609344 }
const UNIT_NAMES = { km: 'kilometres', nm: 'nautical miles', mi: 'statute miles' }
const LOG_PREFIX = 'aishub-to-n2k'
const NAV_STATUS = {
  0: 'under way (engine)', 1: 'at anchor', 2: 'not under command', 3: 'restricted manoeuvrability',
  4: 'constrained by draught', 5: 'moored', 6: 'aground', 7: 'fishing', 8: 'under way (sailing)',
  14: 'AIS-SART', 15: 'undefined'
}

module.exports = function (app) {
  const plugin = {
    id: 'aishub-to-n2k',
    name: 'AISHub to N2K',
    description:
      'Fetch vessels from AISHub, drop the ones your own AIS receiver hears, and send the rest to the NMEA 2000 bus for your plotters'
  }

  let config
  let state
  let onRawLine
  let pollTimer
  let statusTimer
  // Signal K hands a plugin a copy of the server object, taken when the
  // plugin is loaded, so app.isNmea2000OutAvailable on it keeps its
  // loading-time value. Keep the flag here, outside start and stop, so it
  // also survives the restart Signal K gives the plugin on a settings change.
  let outAvailable = !!app.isNmea2000OutAvailable
  app.on('nmea2000OutAvailable', () => { outAvailable = true })
  // When we last asked AISHub, so that a restart on a settings change does
  // not ask again within the minute.
  let lastRequestAt = 0

  plugin.schema = () => {
    const devices = knownDevices()
    const deviceItems = { type: 'string', title: 'Device' }
    if (devices.length > 0) {
      deviceItems.enum = devices.map(d => d.canName)
      deviceItems.enumNames = devices.map(d => d.label)
    }
    const connectionItem = {
      type: 'string',
      title: 'NMEA 2000 connection to send on (it must be able to send: see the README)'
    }
    const connections = knownConnections()
    if (connections.length > 0) {
      connectionItem.enum = connections
      connectionItem.default = connections[0]
    }
    return {
      type: 'object',
      required: ['apiKey', 'mmsi', 'connection'],
      properties: {
        apiKey: {
          type: 'string',
          title: 'AISHub API key (the "username" AISHub emailed you)'
        },
        mmsi: {
          type: 'string',
          title: "Your own MMSI (filled in from Signal K's vessel settings; AISHub's copy of you is never sent)",
          default: String(app.getSelfPath('mmsi') || '')
        },
        boxDistance: {
          type: 'number',
          title: 'How far from the boat to ask AISHub for, each way (100 = a box 200 across)',
          default: 100,
          minimum: 1
        },
        boxUnit: {
          type: 'string',
          title: 'Unit of that distance',
          enum: Object.keys(KM_PER_UNIT),
          enumNames: Object.values(UNIT_NAMES),
          default: 'km'
        },
        pollSeconds: {
          type: 'number',
          title: `Seconds between requests to AISHub (${MIN_POLL_SECONDS} is the fastest AISHub allows)`,
          default: MIN_POLL_SECONDS,
          minimum: MIN_POLL_SECONDS
        },
        connection: connectionItem,
        devices: {
          type: 'array',
          title: 'Your own AIS receivers: vessels they hear are not sent to the plotters',
          items: deviceItems,
          uniqueItems: true
        },
        dryRun: {
          type: 'boolean',
          title: "Dry run: send nothing, write each poll's decisions to the Signal K server log instead",
          default: false
        }
      }
    }
  }

  plugin.uiSchema = () => ({
    'ui:order': ['apiKey', 'mmsi', 'boxDistance', 'boxUnit', 'pollSeconds', 'connection', 'devices', 'dryRun'],
    apiKey: { 'ui:widget': 'password' },
    devices: { 'ui:widget': 'checkboxes' }
  })

  plugin.start = options => {
    const unit = KM_PER_UNIT[options.boxUnit] ? options.boxUnit : 'km'
    // boxKm is the name the setting had in 0.1.0.
    const distance = Number(options.boxDistance) || Number(options.boxKm) || 100
    config = {
      apiKey: String(options.apiKey || '').trim(),
      mmsi: parseMmsi(options.mmsi) || parseMmsi(app.getSelfPath('mmsi')),
      boxKm: Math.max(1, distance) * KM_PER_UNIT[unit],
      boxText: `${Math.max(1, distance)} ${UNIT_NAMES[unit]}`,
      unit,
      pollSeconds: Math.max(MIN_POLL_SECONDS, Number(options.pollSeconds) || MIN_POLL_SECONDS),
      connection: options.connection,
      devices: options.devices || [],
      dryRun: options.dryRun === true
    }
    state = {
      addresses: new Map(),
      checkedAt: 0,
      heard: new HeardList(),
      // mmsi -> { v: last AISHub record, listedAt: when AISHub last listed
      // it, gaps: ms between its recent reports, sentTime: AISHub time of
      // the record last sent }
      tracked: new Map(),
      polls: 0,
      lastPoll: undefined,
      errors: 0,
      lastError: undefined
    }

    // Step 3 needs the receiver's last message time per MMSI: read them
    // straight off the bus from the chosen devices.
    onRawLine = line => {
      if (typeof line !== 'string') return
      const frame = parseLine(line)
      if (!frame) return
      if (frame.pgn === ADDRESS_CLAIM && frame.data.length === 8) {
        onAddressClaim(String(frame.src), canNameOf(frame.data))
        return
      }
      const mmsi = mmsiFromFrame(frame)
      if (mmsi === undefined || !isChosenDevice(frame.src)) return
      state.heard.note(mmsi, Date.now())
    }
    app.on('canboatjs:rawoutput', onRawLine)

    statusTimer = setInterval(reportStatus, 10000)
    reportStatus()
    if (!config.apiKey || !config.mmsi) return
    schedulePoll(Math.max(1000, lastRequestAt + config.pollSeconds * 1000 - Date.now()))
  }

  plugin.stop = () => {
    clearTimeout(pollTimer)
    clearInterval(statusTimer)
    if (onRawLine) app.removeListener('canboatjs:rawoutput', onRawLine)
    onRawLine = undefined
    state = undefined
  }

  function schedulePoll (ms) {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      poll().catch(err => recordError(err)).then(() => {
        if (!state) return
        reportStatus()
        schedulePoll(config.pollSeconds * 1000)
      })
    }, ms)
  }

  // Steps 1 and 2: ask AISHub, read the reply.
  async function poll () {
    const own = ownPosition()
    if (!own) {
      state.lastPoll = { skipped: 'no own position yet' }
      return
    }
    const box = geo.boxAround(own.latitude, own.longitude, config.boxKm)
    state.polls++
    lastRequestAt = Date.now()
    const run = state
    const reply = await aishub.fetchVessels(config.apiKey, box)
    if (state !== run) return // stopped, or restarted with new settings, while waiting
    state.heard.prune(HEARD_KEEP_MS, Date.now())
    state.lastPoll = process(reply.vessels, Date.now(), own)
  }

  // Steps 3, 4 and 5 for one reply.
  function process (vessels, now, own) {
    const counts = emptyCounters()
    state.own = own
    counts.fromAishub = vessels.length
    const listed = new Set()
    for (const v of vessels) {
      if (v.mmsi === config.mmsi) {
        counts.ownVessel++
        decision(v, 'skip: own vessel')
        continue
      }
      listed.add(v.mmsi)
      const t = track(v, now)
      const ownAt = ownReceiverLastMessage(v.mmsi)
      if (ownAt !== undefined && (v.time === undefined || v.time <= ownAt + CLOCK_TOLERANCE_MS)) {
        counts.ownReceiverHasIt++
        state.tracked.delete(v.mmsi) // our receiver has it: nothing to hold
        decision(v, 'skip: own receiver has it', ownAt, t.sentTime)
        continue
      }
      // A record AISHub is still returning is sent again every poll, so the
      // plotters keep the target through the gaps between the vessel's
      // reports.
      sendVessel(t, ownAt, counts)
    }
    // Vessels AISHub listed earlier but left out of this reply. AISHub's
    // replies have holes: a vessel drops out for a poll or five and comes
    // back. Each one is kept, and sent again, until AISHub has been quiet
    // about it for longer than its own measured gap between reports, with
    // some padding. Then it is dropped, and the plotters drop it on their
    // lost-target timer.
    const typicalGap = averageGap()
    for (const [mmsi, t] of state.tracked) {
      if (listed.has(mmsi)) continue
      const quiet = now - t.listedAt
      const hold = holdFor(t, typicalGap)
      const how = `not in AISHub's reply for ${minutes(quiet)} min, hold ${minutes(hold)} min`
      if (quiet > hold) {
        state.tracked.delete(mmsi)
        counts.dropped++
        decision(t.v, `drop: ${how}`, undefined, t.sentTime)
        continue
      }
      const ownAt = ownReceiverLastMessage(mmsi)
      if (ownAt !== undefined && (t.v.time === undefined || t.v.time <= ownAt + CLOCK_TOLERANCE_MS)) {
        counts.ownReceiverHasIt++
        state.tracked.delete(mmsi)
        decision(t.v, 'skip: own receiver has it', ownAt, t.sentTime)
        continue
      }
      counts.held++
      sendVessel(t, ownAt, counts, `would send again: held, ${how}`)
    }
    if (config.devices.length === 0) counts.warning = 'no AIS device chosen, so nothing is filtered out'
    return counts
  }

  // Steps 4 and 5 for one vessel: build its messages and send them.
  function sendVessel (t, ownAt, counts, why) {
    const v = t.v
    const lastSent = t.sentTime
    const repeat = lastSent !== undefined && v.time !== undefined && v.time <= lastSent
    const messages = [n2k.positionReport(v), ...n2k.staticData(v)]
    const delivered = messages.map(msg => send(msg, counts)).every(Boolean)
    if (delivered) {
      t.sentTime = repeat ? lastSent : v.time
      counts.sentToPlotters++
      if (repeat) counts.repeats++
    } else {
      counts.notSentNoOutput++
    }
    decision(v, why || (repeat ? 'would send again: same report as last poll'
      : ownAt === undefined ? 'would send: own receiver has never heard it' : 'would send: newer than own receiver\'s last message'),
    ownAt, lastSent, messages.map(m => m.pgn))
  }

  // Remember this vessel from this reply, and how long it went since its
  // previous report (AISHub's time is the vessel's own transmission time).
  function track (v, now) {
    let t = state.tracked.get(v.mmsi)
    if (!t) {
      t = { v, listedAt: now, gaps: [], sentTime: undefined }
      state.tracked.set(v.mmsi, t)
      return t
    }
    if (v.time !== undefined && t.v.time !== undefined && v.time > t.v.time) {
      t.gaps.push(v.time - t.v.time)
      if (t.gaps.length > GAP_HISTORY) t.gaps.shift()
    }
    t.v = v
    t.listedAt = now
    return t
  }

  // How long to keep a vessel AISHub has left out: its own average gap
  // between reports, padded. A vessel with no history yet gets the average
  // over every vessel we hold, and if there is none yet, the AIS reporting
  // interval of a ship at anchor. Never less than two polls, so a vessel
  // missing from one reply is never dropped.
  function holdFor (t, typicalGap) {
    const own = mean(t.gaps)
    const gap = own !== undefined ? own : typicalGap !== undefined ? typicalGap : ANCHORED_REPORT_MS
    return Math.max(2 * config.pollSeconds * 1000, gap * HOLD_PADDING)
  }

  function averageGap () {
    const all = []
    for (const t of state.tracked.values()) all.push(...t.gaps)
    return mean(all)
  }

  function mean (xs) {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined
  }

  function minutes (ms) {
    return (ms / 60000).toFixed(1)
  }

  // Step 5: one NMEA 2000 message to the connection. Returns whether it went.
  function send (msg, counts) {
    if (config.dryRun) {
      counts.messages++
      return true
    }
    if (!outAvailable) return false
    app.emit('nmea2000JsonOut', msg)
    counts.messages++
    return true
  }

  // In a dry run, one line per vessel per poll in the server log.
  // One line per vessel per poll in dry run: the decision, then everything
  // AISHub sent about the vessel, with its distance and bearing from us.
  function decision (v, action, ownAt, lastSent, pgns) {
    if (!config.dryRun) return
    const when = t => t === undefined ? 'never' : new Date(t).toISOString().slice(11, 19)
    console.log(`${LOG_PREFIX} poll ${state.polls}: ${v.mmsi} ${v.name || '?'} | AISHub ${when(v.time)} | own receiver ${when(ownAt)}` +
      ` | last sent ${when(lastSent)} | ${describe(v)} | ${action}${pgns ? ` (PGNs ${pgns.join(', ')})` : ''}`)
  }

  function describe (v) {
    const or = (x, suffix = '') => x === undefined || x === '' ? '-' : `${x}${suffix}`
    const own = state.own
    const range = own
      ? `${(geo.distanceKm(own.latitude, own.longitude, v.latitude, v.longitude) / KM_PER_UNIT[config.unit]).toFixed(1)} ${config.unit}` +
        ` bearing ${String(geo.bearingDegrees(own.latitude, own.longitude, v.latitude, v.longitude)).padStart(3, '0')}`
      : 'range -'
    return [
      range,
      `${v.latitude.toFixed(4)},${v.longitude.toFixed(4)}`,
      `class ${v.class}`,
      `sog ${or(v.sogKnots, ' kn')} cog ${or(v.cogDegrees)} hdg ${or(v.headingDegrees)} rot ${or(v.rotCoded)}`,
      `nav ${v.navStatus} ${NAV_STATUS[v.navStatus] || 'undefined'}`,
      `type ${v.shipType}`,
      `callsign ${or(v.callsign)} imo ${v.imo || '-'}`,
      `${v.length}x${v.beam} m draught ${v.draught} m`,
      `dest ${or(v.destination)} eta ${or(v.eta)}`
    ].join(' | ')
  }

  // When did our own receiver last have a message from this vessel? The
  // later of what we heard on the bus since the plugin started and what
  // Signal K holds for the vessel from the chosen devices (which covers
  // the minutes after a restart, before we have heard much ourselves).
  function ownReceiverLastMessage (mmsi) {
    let at = state.heard.lastHeard(mmsi)
    let pos
    try {
      pos = app.getPath(`vessels.urn:mrn:imo:mmsi:${mmsi}.navigation.position`)
    } catch (err) {
      pos = undefined
    }
    if (pos && typeof pos === 'object') {
      const entries = pos.values ? Object.entries(pos.values) : (pos.$source ? [[pos.$source, pos]] : [])
      for (const [label, entry] of entries) {
        if (!isOwnReceiverLabel(label)) continue
        const t = Date.parse(entry && entry.timestamp)
        if (!Number.isNaN(t) && (at === undefined || t > at)) at = t
      }
    }
    return at
  }

  // Signal K labels a source "<connection>.<bus address>".
  function isOwnReceiverLabel (label) {
    const dot = String(label).lastIndexOf('.')
    if (dot < 0) return false
    refreshFromSignalK()
    return label.slice(0, dot) === config.connection && state.addresses.has(label.slice(dot + 1))
  }

  function ownPosition () {
    const pos = app.getSelfPath('navigation.position')
    const value = pos && pos.value !== undefined ? pos.value : pos
    if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') return undefined
    return value
  }

  function parseMmsi (s) {
    const n = Number(String(s === undefined || s === null ? '' : s).trim())
    return Number.isInteger(n) && n > 0 ? n : undefined
  }

  function emptyCounters () {
    return {
      fromAishub: 0,
      ownVessel: 0,
      ownReceiverHasIt: 0,
      repeats: 0,
      held: 0,
      dropped: 0,
      sentToPlotters: 0,
      messages: 0,
      notSentNoOutput: 0
    }
  }

  // ---- Which bus addresses are our own AIS receivers? (same approach as
  // ---- @sv-orion/ais-n2k-to-0183-forwarder)

  function isChosenDevice (src) {
    refreshFromSignalK()
    return state.addresses.has(String(src))
  }

  function onAddressClaim (addr, canName) {
    if (config.devices.includes(canName)) {
      for (const [a, c] of state.addresses) {
        if (c === canName && a !== addr) state.addresses.delete(a)
      }
      state.addresses.set(addr, canName)
    } else if (state.addresses.has(addr)) {
      state.addresses.delete(addr)
    }
  }

  function canNameOf (bytes) {
    return bytes.readBigUInt64LE(0).toString(16)
  }

  function missingDevices () {
    if (!state) return []
    const found = new Set(state.addresses.values())
    return config.devices.filter(c => !found.has(c))
  }

  function refreshFromSignalK () {
    const now = Date.now()
    if (now - state.checkedAt < LOOKUP_REFRESH_MS) return
    state.checkedAt = now
    const own = allSources()[config.connection] || {}
    const missing = new Set(missingDevices())
    Object.keys(own).forEach(addr => {
      const canName = own[addr] && own[addr].n2k && own[addr].n2k.canName
      if (canName && missing.has(canName) && !state.addresses.has(addr)) {
        state.addresses.set(addr, canName)
      }
    })
  }

  function allSources () {
    try {
      return app.signalk.retrieve().sources || {}
    } catch (err) {
      return {}
    }
  }

  function knownConnections () {
    const providers = (app.config && app.config.settings && app.config.settings.pipedProviders) || []
    const driverOf = p => {
      const el = p.pipeElements && p.pipeElements[0]
      const opts = (el && el.options) || {}
      const type = (opts.subOptions && opts.subOptions.type) || opts.type
      return typeof type === 'string' ? type : ''
    }
    return providers.filter(p => driverOf(p).includes('canboatjs')).map(p => p.id)
  }

  // Only AIS devices are offered: NMEA 2000 device class 60 (Navigation)
  // with device function 195 (AIS), read from the permanent name itself.
  function isAisDevice (canName) {
    if (typeof canName !== 'string' || !/^[0-9a-f]{1,16}$/i.test(canName)) return false
    const name = BigInt('0x' + canName)
    const deviceFunction = Number((name >> 40n) & 0xffn)
    const deviceClass = Number((name >> 49n) & 0x7fn)
    return deviceClass === 60 && deviceFunction === 195
  }

  function knownDevices () {
    const devices = []
    const sources = allSources()
    Object.keys(sources).forEach(connection => {
      Object.keys(sources[connection] || {}).forEach(addr => {
        const n2kInfo = sources[connection][addr] && sources[connection][addr].n2k
        if (!n2kInfo || !n2kInfo.canName || !isAisDevice(n2kInfo.canName)) return
        const model = (n2kInfo.modelVersion || n2kInfo.modelId || n2kInfo.manufacturerCode || 'AIS device')
          .replace(/^Raymarine /, '')
        const serial = n2kInfo.modelSerialCode ? ` s/n ${n2kInfo.modelSerialCode}` : ''
        devices.push({ canName: n2kInfo.canName, label: `${model}${serial}`, connection })
      })
    })
    return devices
  }

  // ---- Errors and status. Errors go to the server log and the status
  // ---- line; the next poll simply tries again.

  function recordError (err) {
    if (!state) return
    state.errors++
    state.lastError = err.message
    app.error(err.message)
  }

  function reportStatus () {
    if (!state) return
    if (!config.apiKey) return app.setPluginStatus('No AISHub API key set')
    if (!config.mmsi) return app.setPluginStatus("No MMSI set: fill in your own MMSI so AISHub's copy of you is not sent")
    refreshFromSignalK()
    const parts = []
    const missing = missingDevices()
    if (config.devices.length === 0) parts.push('no AIS device chosen: nothing is filtered')
    else if (missing.length > 0) parts.push(`waiting to identify ${missing.join(', ')}`)
    else parts.push(`own receiver ${[...state.addresses].map(([a, n]) => `${n}@${a}`).join(', ')} has reported ${state.heard.size} vessels since start`)
    const last = state.lastPoll
    if (!last) parts.push(`no poll yet (box ${config.boxText})`)
    else if (last.skipped) parts.push(`not polling: ${last.skipped}`)
    else {
      parts.push(`last poll: ${last.fromAishub} from AISHub, ${last.ownReceiverHasIt} own receiver has, ` +
        `${last.sentToPlotters} ${config.dryRun ? 'would have been sent' : 'sent to plotters'} (${last.repeats} repeats of the last report, ` +
        `${last.held} held while AISHub is quiet, ${last.messages} messages)` +
        (last.dropped ? `, ${last.dropped} dropped after AISHub went quiet` : '') +
        (last.notSentNoOutput ? `, ${last.notSentNoOutput} not sent (no NMEA 2000 output)` : ''))
    }
    if (config.dryRun) parts.push('dry run: decisions are in the server log')
    else if (!outAvailable) parts.push(`NMEA 2000 output not available on ${config.connection}: restart Signal K to enable it (see README)`)
    if (state.errors) parts.push(`${state.errors} errors (last: ${state.lastError})`)
    app.setPluginStatus(`${state.polls} polls. ${parts.join('; ')}`)
  }

  return plugin
}
