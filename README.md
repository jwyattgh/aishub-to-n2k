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
3. Drops your own vessel, and every vessel your own AIS receiver already
   has. AISHub puts the time of the vessel's own transmission on each
   record, and the plugin compares it with the time of your receiver's
   last message from that vessel, read straight off the NMEA 2000 bus.
   If your receiver's message is as new as AISHub's, or newer, the vessel
   is left to your receiver. If AISHub's is newer (a vessel that has
   sailed out of your receiver's range, or one it has never heard), it is
   sent.
   Every vessel that passes is sent every poll, even when AISHub's
   record has not changed since the last one, so the plotters keep the
   target through the gaps between a vessel's reports (a moored ship
   reports every three minutes, and AISHub's feeders miss some).
   AISHub's replies also have holes: a vessel drops out of the list for
   a poll or five and comes back. So a vessel AISHub leaves out is kept,
   and sent again every poll, until AISHub has been quiet about it for
   longer than that vessel's own average gap between reports, padded by
   a quarter. The plugin measures the gap itself from AISHub's report
   times, over the vessel's last ten reports. A vessel with no history
   yet gets the average over all the vessels held, or three minutes (a
   ship at anchor's reporting interval) when there is none. The hold is
   never under two polls, so one missing reply never drops anything.
   Once the hold runs out the vessel is dropped, and the plotters drop
   the target on their own lost-target timer. A held vessel your own
   receiver starts hearing is dropped at once.
4. Turns the rest into the same NMEA 2000 AIS messages a transponder
   would send: class A position (PGN 129038) and static data (129794), or
   class B position (129039) and static data (129809, 129810). Position,
   name and details go every poll.
5. Hands them to the NMEA 2000 connection you chose, which sends them to
   the bus, one message every tenth of a second. Sent all at once, a
   poll's worth leaves the gateway in under a second, and a YDWG-02
   drops the tail of such a burst: on the author's boat a quarter of the
   vessels never reached the bus, the same ones every poll. Spread out,
   twenty-five vessels take about five seconds of the minute. Messages
   still waiting when the next poll comes are dropped and counted. The
   plotters show the targets like any other AIS target.

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
- Your boat's position in Signal K (the box is drawn around it). Until
  there is one, the plugin does not poll.
- Your own MMSI, so AISHub's copy of your own boat is never sent. It is
  filled in from Signal K's vessel settings (Server → Settings → Vessel
  base data) and can be typed in if that is empty.
- An AIS receiver on the NMEA 2000 bus, if you want the duplicates
  filtered. Without one, everything from AISHub is sent.

### The connection must be able to send

Signal K's NMEA 2000 connections receive by default. To send, the
connection needs to claim an address on the bus, which happens when
Signal K starts. If the connection was only just set up to send, the
plugin's status reads "NMEA 2000 output not available on <connection>:
restart Signal K to enable it", and nothing is sent until you do.
Changing the plugin's own settings, dry run included, needs no restart.

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
   - **Your own MMSI**: filled in from Signal K's vessel settings; type
     it in if it is empty.
   - **How far from the boat to ask AISHub for**, and its **unit**
     (kilometres, nautical miles or statute miles). 100 km is plenty
     coastal; go large offshore if you want to know who is out there.
   - **Seconds between requests**: 61 or more.
   - **Milliseconds between messages to the bus**: 100 unless your
     gateway is known to cope with a burst; 0 sends a poll's messages
     all at once.
   - **Connection**: the NMEA 2000 connection to send on.
   - **Your own AIS receivers**: tick them. Vessels they hear are not
     sent to the plotters.
3. To see what it would do first, tick **Dry run** and enable the
   plugin. Nothing is sent; instead every poll writes one line per
   vessel to the server log (Server → Server Log), like:

   ```
   aishub-to-n2k poll 12: 368341220 NAUTI DREAM | AISHub 16:54:05 | own receiver 16:54:05 | last sent never | 0.3 nm bearing 224 | 9.3341,-76.1204 | class B | sog 0 kn cog 271 hdg - rot - | nav 15 undefined | type 36 | callsign WDA1234 imo - | 12x4 m draught 0 m | dest - eta - | skip: own receiver has it
   aishub-to-n2k poll 12: 227011340 ESPIGUETTE_RD | AISHub 16:40:23 | own receiver never | last sent 16:40:23 | 148.2 nm bearing 041 | 11.1234,-74.0012 | class A | sog 0.1 kn cog 180 hdg 90 rot 0 | nav 1 at anchor | type 70 | callsign FABC imo 9123456 | 180x28 m draught 9.5 m | dest CARTAGENA eta 09-26 06:00 | would send again: same report as last poll (PGNs 129038, 129794)
   aishub-to-n2k poll 12: 636024775 ISTANBUL EXPRESS | AISHub 16:55:50 | own receiver never | last sent 16:50:48 | 62.0 nm bearing 305 | 10.2210,-76.8801 | class A | sog 18.3 kn cog 296 hdg 295 rot 0 | nav 0 under way (engine) | type 71 | callsign D5XY7 imo 9234567 | 300x40 m draught 12.1 m | dest COLON eta 09-25 22:00 | would send: own receiver has never heard it (PGNs 129038, 129794)
   ```

   The times are UTC. "AISHub" is the time on AISHub's record, "own
   receiver" the time of your receiver's last message from that vessel,
   "last sent" the AISHub time of the record the plugin last sent. Then
   everything AISHub sent about the vessel: distance and bearing from
   your boat (in the box unit), position, the class the plugin chose,
   speed, course, heading, rate of turn, navigation status, ship type,
   callsign, IMO number, length by beam, draught, destination and ETA.
   A dash is a value AISHub did not have. The decision ends the line:
   "would send" (a report your receiver does not have), "would send
   again: same report as last poll" (AISHub is still returning the record
   the plugin last sent, so it goes again to keep the target on the
   plotters), "would send again: held, not in AISHub's reply for 2.1 min,
   hold 4.5 min" (AISHub left the vessel out, and it is kept until its
   hold runs out), "drop: not in AISHub's reply for 4.7 min, hold 4.5
   min", or "skip: own receiver has it".
4. Untick **Dry run**. Targets appear on the plotters.

## Status

The plugin's status line, on the Plugin Config page and the dashboard,
reads like:

```
12 polls. own receiver c078c37ae76baa6d@1 has reported 11 vessels since start;
last poll: 42 from AISHub, 10 own receiver has, 33 sent to plotters (18 repeats of the last report, 2 held while AISHub is quiet, 79 messages)
```

"Held while AISHub is quiet" counts the vessels sent although AISHub
left them out of this reply. When a hold runs out the status adds
"1 dropped after AISHub went quiet" for that poll. In dry run the
sent part reads "33 would have been sent". If messages from the previous
poll were still waiting for the bus when the next poll came, the status
adds how many were dropped; that means the spacing times the message
count exceeds the poll interval. If the connection cannot
send yet, the vessels that were not sent are counted as "not sent (no
NMEA 2000 output)".

Errors from AISHub (a bad key, "Too frequent requests", a timeout) go
to the server log and to the end of the status line, and the next poll
tries again.

## How the sent data looks on the bus

The messages carry the plugin's connection address as their source, so
on the bus they come from the gateway (or CAN interface), not from your
AIS receiver.

AISHub does not say whether a vessel has a class A or class B
transponder, so the plugin chooses the message format from the data it
holds. A vessel with anything only the class A messages can carry
(navigation status, destination, ETA, draught, rate of turn, IMO number)
is sent as class A, so none of it is dropped. Everything else is sent as
class B. ETA is not sent yet: the NMEA 2000 message wants a full date and
AISHub gives only month, day and time.

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
