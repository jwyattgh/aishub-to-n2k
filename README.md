# aishub-to-n2k

[![test](https://github.com/jwyattgh/aishub-to-n2k/actions/workflows/test.yml/badge.svg)](https://github.com/jwyattgh/aishub-to-n2k/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@sv-orion/aishub-to-n2k)](https://www.npmjs.com/package/@sv-orion/aishub-to-n2k)

A Signal K plugin that puts the vessels AISHub knows about onto your
chart plotters, over NMEA 2000, without doubling up the ones your own AIS
receiver already hears.

## What it does

Every poll (61 seconds or slower, AISHub's rule):

1. Asks AISHub for every vessel in a box around the boat. The box size is
   yours to set.
2. Reads the JSON reply.
3. Drops your own vessel, and every vessel your own AIS receiver has heard
   in the last few minutes. The receiver's messages are read straight off
   the NMEA 2000 bus, so this works whatever else is on the boat.
4. Turns the rest into the same NMEA 2000 AIS messages a transponder
   would send: class A position (PGN 129038) and static data (129794), or
   class B position (129039) and static data (129809, 129810).
5. Hands them to the NMEA 2000 connection you chose, which sends them to
   the bus. The plotters show the targets like any other AIS target.

Every vessel in the reply (except your own) also goes into Signal K's
vessel list, so Freeboard, KIP and the rest see them too.

The plugin never sends anything to AISHub except the request itself.
AISHub's terms forbid feeding its data, or anything made from it, back
to AISHub, so if you also upload your AIS to AISHub or MarineTraffic,
upload only what your own receiver hears. `@sv-orion/ais-n2k-to-0183-forwarder`
does exactly that.

## What you need

- Signal K server 2.x.
- An AISHub account with an API key (they email it when your station
  is accepted; it looks like `AH_1234_ABCDEF12`).
- An NMEA 2000 connection in Signal K **that can send**. See below.
- Your boat's position in Signal K (the box is drawn around it).
- An AIS receiver on the NMEA 2000 bus, if you want the duplicates
  filtered. Without one, everything from AISHub is sent.

### The connection must be able to send

Signal K's NMEA 2000 connections receive by default. To send, the
connection needs to claim an address on the bus, and the plugin shows
"NMEA 2000 output NOT available" in its status until it does.

For a Yacht Devices YDWG-02 gateway (UDP or TCP):

1. In the gateway's own web page, the server port Signal K uses must be
   set to "Bidirectional", not "Receive only".
2. In Signal K's `settings.json` the connection needs `"createDevice": true`
   in its options. The admin page has no switch for it; add it by hand
   or with the REST API, then restart Signal K:

   ```json
   {
     "id": "ydwg-n2k-udp",
     "pipeElements": [{ "type": "providers/simple", "options": {
       "type": "NMEA2000",
       "subOptions": { "type": "ydwg02-udp-canboatjs", "port": 1458, "createDevice": true }
     }}]
   }
   ```

A direct CAN interface (`canbus-canboatjs`, e.g. a Raspberry Pi with a
CAN hat) or an Actisense NGT-1 can send as delivered.

## Setup

1. Signal K admin page → Appstore → search `aishub-to-n2k` → Install →
   restart.
2. Server → Plugin Config → AISHub to N2K:
   - **AISHub API key**.
   - **How far from the boat to ask for, in km**: 100 is plenty
     coastal; go large offshore if you want to know who is out there.
   - **Seconds between requests**: 61 or more.
   - **Connection**: the NMEA 2000 connection to send on.
   - **Your own AIS receivers**: tick them. Vessels they hear are not
     sent to the plotters.
   - **Minutes to trust your own receiver**: a vessel it heard this
     recently is left to it (default 10).
   - **Only send vessels within N nautical miles**: keeps the plotter
     from filling with targets 100 km away (default 50, 0 = everything
     in the box).
   - **Ignore reports older than N minutes**: a position AISHub last
     updated hours ago is not a live target (default 60).
   - **Also put vessels your own receiver hears into Signal K**: on by
     default. Turn it off if you would rather Signal K held only your
     receiver's version of those vessels.
3. Leave **Dry run** on and enable the plugin. Open
   `http://<server>/plugins/aishub-to-n2k/log` to see the messages it
   would send, and `http://<server>/plugins/aishub-to-n2k/status` for
   the counters.
4. Turn **Dry run** off. Targets appear on the plotters.

## Status

The plugin's status line reads like:

```
12 polls. own receiver c078c37ae76baa6d@1 has heard 11 vessels; last poll: 13 in box,
10 heard by own receiver, 2 sent to plotters (6 messages), 12 into Signal K, 1 beyond 50 nm
```

The `/status` endpoint gives the same as JSON, plus running totals and
the last error.

## How the sent data looks on the bus

The messages carry the plugin's connection address as their source, so
on the bus they come from the gateway (or CAN interface), not from your
AIS receiver. Static data (name, callsign, size, type) is sent when a
vessel is first seen and every 6 minutes after, like a real transponder;
positions go every poll while AISHub still lists the vessel.

Values AISHub does not have (heading 511, course 360, speed 102.4) are
sent as "not available", exactly as a transponder would.

## Tests

```
npm test
```

The tests encode every message with canboatjs and decode it the way a
plotter would, so the field names and units are checked against the real
NMEA 2000 definitions.

## Licence

Apache-2.0.
