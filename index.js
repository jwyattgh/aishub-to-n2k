/*
 * @sv-orion/aishub-to-n2k: a Signal K plugin (plugin id aishub-to-n2k).
 *
 * Every poll:
 *   1. Ask AISHub for the vessels in a box around the boat.
 *   2. Read the JSON reply.
 *   3. Drop the vessels our own AIS receiver has heard recently (their
 *      MMSIs are read straight off the NMEA 2000 bus, from the devices
 *      chosen in the settings), and our own vessel.
 *   4. Turn the rest into NMEA 2000 AIS messages.
 *   5. Hand those to the chosen NMEA 2000 connection, which sends them to
 *      the bus, so the plotters show the targets. Every vessel AISHub sent
 *      also goes into Signal K's vessel list.
 *
 * Nothing here ever sends anything to AISHub except the request.
 */
const fs = require('fs')
const path = require('path')
const aishub = require('./lib/aishub')
const geo = require('./lib/geo')
const n2k = require('./lib/n2k')
const { HeardList, parseLine, mmsiFromFrame } = require('./lib/heard')

const ADDRESS_CLAIM = 60928
const MIN_POLL_SECONDS = 61 // AISHub's rule: one request per minute
const LOOKUP_REFRESH_MS = 5000
const STATIC_DATA_INTERVAL_MS = 6 * 60 * 1000 // like a real transponder
const HEARD_KEEP_MS = 24 * 60 * 60 * 1000
const DRY_RUN_LOG_MAX_BYTES = 5 * 1024 * 1024
const SOURCE_LABEL = 'aishub-to-n2k'

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
  let onOutAvailable
  let pollTimer
  let statusTimer
  let lastStatus = ''

  // Web endpoints under /plugins/aishub-to-n2k/:
  //   GET status   the status line plus counters and the last poll's result
  //   GET log      the tail of the dry-run log (?lines=N, default 50, max 1000)
  plugin.registerWithRouter = router => {
    router.get('/status', (req, res) => {
      if (!state) return res.json({ status: lastStatus, running: false })
      res.json({
        status: lastStatus,
        running: true,
        dryRun: !!state.logPath,
        logPath: state.logPath,
        nmea2000OutAvailable: state.outAvailable,
        box: state.lastBox,
        addresses: Object.fromEntries(state.addresses),
        waitingFor: missingDevices(),
        heardVessels: state.heard.size,
        polls: state.polls,
        lastPollAt: state.lastPollAt ? new Date(state.lastPollAt).toISOString() : undefined,
        lastPoll: state.lastPoll,
        totals: state.totals,
        errors: state.errors,
        lastError: state.lastError
      })
    })
    router.get('/log', (req, res) => {
      if (!state || !state.logPath) return res.status(404).json({ error: 'plugin is not in dry-run mode' })
      const lines = Math.min(1000, Math.max(1, parseInt(req.query.lines, 10) || 50))
      let text = ''
      try {
        text = fs.readFileSync(state.logPath, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') return res.status(500).json({ error: err.message })
      }
      const all = text.split('\n').filter(Boolean)
      res.type('text/plain').send(all.slice(-lines).join('\n') + (all.length ? '\n' : ''))
    })
  }

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
      required: ['apiKey', 'connection'],
      properties: {
        apiKey: {
          type: 'string',
          title: 'AISHub API key (the "username" AISHub emailed you)'
        },
        boxKm: {
          type: 'number',
          title: 'How far from the boat to ask AISHub for, in km (each way; 100 km = a 200 km box)',
          default: 100,
          minimum: 1
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
        trustMinutes: {
          type: 'number',
          title: 'Minutes to trust your own receiver: a vessel it heard this recently is not sent',
          default: 10,
          minimum: 1
        },
        plotterRangeNm: {
          type: 'number',
          title: 'Only send vessels within this many nautical miles of the boat (0 = send everything in the box)',
          default: 50,
          minimum: 0
        },
        maxAgeMinutes: {
          type: 'number',
          title: 'Ignore AISHub reports older than this many minutes',
          default: 60,
          minimum: 1
        },
        heardIntoSignalK: {
          type: 'boolean',
          title: 'Also put vessels your own receiver hears into Signal K (off = only the extra ones)',
          default: true
        },
        dryRun: {
          type: 'boolean',
          title: 'Dry run: write the NMEA 2000 messages to a log file instead of sending them',
          default: true
        }
      }
    }
  }

  plugin.uiSchema = () => ({
    'ui:order': ['apiKey', 'boxKm', 'pollSeconds', 'connection', 'devices', 'trustMinutes', 'plotterRangeNm', 'maxAgeMinutes', 'heardIntoSignalK', 'dryRun'],
    apiKey: { 'ui:widget': 'password' },
    devices: { 'ui:widget': 'checkboxes' }
  })

  plugin.start = options => {
    config = {
      apiKey: String(options.apiKey || '').trim(),
      boxKm: Math.max(1, Number(options.boxKm) || 100),
      pollSeconds: Math.max(MIN_POLL_SECONDS, Number(options.pollSeconds) || MIN_POLL_SECONDS),
      connection: options.connection,
      devices: options.devices || [],
      trustMinutes: Math.max(1, Number(options.trustMinutes) || 10),
      plotterRangeNm: Math.max(0, Number(options.plotterRangeNm) || 0),
      maxAgeMinutes: Math.max(1, Number(options.maxAgeMinutes) || 60),
      heardIntoSignalK: options.heardIntoSignalK !== false,
      dryRun: options.dryRun !== false
    }
    state = {
      addresses: new Map(),
      checkedAt: 0,
      heard: new HeardList(),
      staticSentAt: new Map(),
      // The plugin sees a copy of the server object taken when it was
      // loaded, so the flag is a starting point and the event keeps it current.
      outAvailable: !!app.isNmea2000OutAvailable,
      polls: 0,
      lastPollAt: undefined,
      lastPoll: undefined,
      lastBox: undefined,
      totals: emptyCounters(),
      errors: 0,
      lastError: undefined
    }
    if (config.dryRun) {
      state.logPath = path.join(app.getDataDirPath(), 'aishub-to-n2k-dryrun.log')
    }

    // Step 3 needs to know what our own receiver hears: read the MMSIs
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

    onOutAvailable = () => { state.outAvailable = true }
    app.on('nmea2000OutAvailable', onOutAvailable)

    statusTimer = setInterval(reportStatus, 10000)
    reportStatus()
    if (!config.apiKey) {
      setStatus('No AISHub API key set')
      return
    }
    schedulePoll(1000)
  }

  plugin.stop = () => {
    clearTimeout(pollTimer)
    clearInterval(statusTimer)
    if (onRawLine) app.removeListener('canboatjs:rawoutput', onRawLine)
    if (onOutAvailable) app.removeListener('nmea2000OutAvailable', onOutAvailable)
    onRawLine = onOutAvailable = undefined
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
    state.lastBox = box
    state.polls++
    state.lastPollAt = Date.now()
    const reply = await aishub.fetchVessels(config.apiKey, box)
    if (!state) return // stopped while waiting
    state.heard.prune(HEARD_KEEP_MS, Date.now())
    state.lastPoll = process(reply.vessels, own, Date.now())
  }

  // Steps 3, 4 and 5 for one reply.
  function process (vessels, own, now) {
    const counts = emptyCounters()
    counts.inBox = vessels.length
    const ownMmsi = Number(app.getSelfPath('mmsi')) || undefined
    const trustMs = config.trustMinutes * 60 * 1000
    const maxAgeMs = config.maxAgeMinutes * 60 * 1000
    const noDevices = config.devices.length === 0
    const sent = []
    for (const v of vessels) {
      if (ownMmsi && v.mmsi === ownMmsi) {
        counts.ownVessel++
        continue
      }
      const heard = state.heard.heardWithin(v.mmsi, trustMs, now)
      if (config.heardIntoSignalK || !heard) {
        app.handleMessage(plugin.id, n2k.delta(v, SOURCE_LABEL, now))
        counts.intoSignalK++
      }
      if (heard) {
        counts.heardByOwnReceiver++
        continue
      }
      if (v.time !== undefined && now - v.time > maxAgeMs) {
        counts.tooOld++
        continue
      }
      if (config.plotterRangeNm > 0 &&
          geo.distanceNm(own.latitude, own.longitude, v.latitude, v.longitude) > config.plotterRangeNm) {
        counts.outOfRange++
        continue
      }
      const messages = [n2k.positionReport(v)]
      const lastStatic = state.staticSentAt.get(v.mmsi)
      if (lastStatic === undefined || now - lastStatic > STATIC_DATA_INTERVAL_MS) {
        messages.push(...n2k.staticData(v))
        state.staticSentAt.set(v.mmsi, now)
      }
      messages.forEach(msg => send(msg, counts))
      counts.sentToPlotters++
      sent.push(v.mmsi)
    }
    for (const mmsi of state.staticSentAt.keys()) {
      if (now - state.staticSentAt.get(mmsi) > HEARD_KEEP_MS) state.staticSentAt.delete(mmsi)
    }
    if (noDevices) counts.warning = 'no AIS device chosen, so nothing is filtered out'
    Object.keys(counts).forEach(k => {
      if (typeof counts[k] === 'number') state.totals[k] += counts[k]
    })
    counts.sentMmsis = sent
    return counts
  }

  // Step 5: one NMEA 2000 message to the connection (or the dry-run log).
  function send (msg, counts) {
    if (state.logPath) {
      appendDryRun(JSON.stringify(msg))
      counts.messages++
      return
    }
    if (!state.outAvailable) {
      counts.notSentNoOutput++
      return
    }
    app.emit('nmea2000JsonOut', msg)
    counts.messages++
  }

  function appendDryRun (line) {
    try {
      const size = fs.existsSync(state.logPath) ? fs.statSync(state.logPath).size : 0
      if (size > DRY_RUN_LOG_MAX_BYTES) fs.renameSync(state.logPath, state.logPath + '.1')
      fs.appendFileSync(state.logPath, `${new Date().toISOString()} ${line}\n`)
    } catch (err) {
      recordError(err)
    }
  }

  function ownPosition () {
    const pos = app.getSelfPath('navigation.position')
    const value = pos && pos.value !== undefined ? pos.value : pos
    if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number') return undefined
    return value
  }

  function emptyCounters () {
    return {
      inBox: 0,
      ownVessel: 0,
      intoSignalK: 0,
      heardByOwnReceiver: 0,
      tooOld: 0,
      outOfRange: 0,
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

  // ---- Status

  function recordError (err) {
    if (!state) return
    state.errors++
    state.lastError = err.message
    app.error(err.message)
  }

  function setStatus (text) {
    lastStatus = text
    app.setPluginStatus(text)
  }

  function reportStatus () {
    if (!state) return
    if (!config.apiKey) return setStatus('No AISHub API key set')
    refreshFromSignalK()
    const parts = []
    const missing = missingDevices()
    if (config.devices.length === 0) parts.push('no AIS device chosen: nothing is filtered')
    else if (missing.length > 0) parts.push(`waiting to identify ${missing.join(', ')}`)
    else parts.push(`own receiver ${[...state.addresses].map(([a, n]) => `${n}@${a}`).join(', ')} has heard ${state.heard.size} vessels`)
    const last = state.lastPoll
    if (!last) parts.push('no poll yet')
    else if (last.skipped) parts.push(`not polling: ${last.skipped}`)
    else {
      parts.push(`last poll: ${last.inBox} in box, ${last.heardByOwnReceiver} heard by own receiver, ` +
        `${last.sentToPlotters} sent to plotters (${last.messages} messages), ${last.intoSignalK} into Signal K` +
        (last.tooOld ? `, ${last.tooOld} too old` : '') +
        (last.outOfRange ? `, ${last.outOfRange} beyond ${config.plotterRangeNm} nm` : ''))
    }
    if (state.logPath) parts.push('dry run')
    else if (!state.outAvailable) parts.push('NMEA 2000 output NOT available on this connection (see README), nothing reaches the bus')
    if (state.errors) parts.push(`${state.errors} errors (last: ${state.lastError})`)
    setStatus(`${state.polls} polls. ${parts.join('; ')}`)
  }

  return plugin
}
