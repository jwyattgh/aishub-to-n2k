# aishub-to-ydwg

[![test](https://github.com/jwyattgh/aishub-to-ydwg/actions/workflows/test.yml/badge.svg)](https://github.com/jwyattgh/aishub-to-ydwg/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@sv-orion/aishub-to-ydwg)](https://www.npmjs.com/package/@sv-orion/aishub-to-ydwg)

A Signal K plugin that puts the vessels AISHub knows about onto your
chart plotters, through a Yacht Devices YDWG-02 NMEA 2000 WiFi gateway,
without doubling up the ones your own AIS receiver already hears.

Until 0.1.7 this plugin was `aishub-to-n2k` and sent through Signal K's
own NMEA 2000 connection. That did not work with the gateway (see
"Why the plugin sends to the gateway itself" below), so from 0.2.0 the
plugin sends to the gateway directly, and the name says so.

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
5. Sends each message straight to the gateway over WiFi, in the
   gateway's own RAW protocol: every message whole in one UDP packet,
   and messages 20 ms apart. The gateway puts them on the bus and the
   plotters show the targets like any other AIS target. A poll of
   twenty-five vessels is on the bus in under a second.

The plugin never sends anything to AISHub except the request itself.
AISHub's terms forbid feeding its data, or anything made from it, back
to AISHub, so if you also upload your AIS to AISHub or MarineTraffic,
upload only what your own receiver hears. `@sv-orion/ais-n2k-to-0183-forwarder`
does exactly that.

## What you need

- Signal K server 2.x.
- An AISHub account with an API key (they email it when your station
  is accepted; it looks like `AH_1234_ABCDEF12`).
- A Yacht Devices YDWG-02 gateway on the same network as Signal K, with
  one of its data servers set to **UDP, RAW protocol, Bidirectional**
  (on the gateway's own web page). Port 1458 is the gateway's default.
  If Signal K already reads the gateway through a "Yacht Devices RAW
  over UDP" connection, that server is the one; nothing on the gateway
  changes.
- Your boat's position in Signal K (the box is drawn around it). Until
  there is one, the plugin does not poll.
- Your own MMSI, so AISHub's copy of your own boat is never sent. It is
  filled in from Signal K's vessel settings (Server → Settings → Vessel
  base data) and can be typed in if that is empty.
- An AIS receiver on the NMEA 2000 bus, if you want the duplicates
  filtered. Without one, everything from AISHub is sent. The plugin
  reads what the receiver hears through Signal K's NMEA 2000 connection
  to the gateway; nothing is sent through that connection.

## Setup

1. Signal K admin page → Appstore → search `aishub-to-ydwg` → Install →
   restart.
2. Server → Plugin Config → AISHub to YDWG:
   - **AISHub API key**.
   - **Your own MMSI**: filled in from Signal K's vessel settings; type
     it in if it is empty.
   - **How far from the boat to ask AISHub for**, and its **unit**
     (kilometres, nautical miles or statute miles). 100 km is plenty
     coastal; go large offshore if you want to know who is out there.
   - **Seconds between requests**: 61 or more.
   - **Address of the gateway** and **its RAW UDP port** (1458 unless
     you changed it on the gateway).
   - **Connection**: the Signal K NMEA 2000 connection your AIS receiver
     is on. Only read.
   - **Your own AIS receivers**: tick them. Vessels they hear are not
     sent to the plotters.
3. To see what it would do first, tick **Dry run** and enable the
   plugin. Nothing is sent; instead every poll writes one line per
   vessel to the server log (Server → Server Log), like:

   ```
   aishub-to-ydwg poll 12: 368341220 NAUTI DREAM | AISHub 16:54:05 | own receiver 16:54:05 | last sent never | 0.3 nm bearing 224 | 9.3341,-76.1204 | class B | sog 0 kn cog 271 hdg - rot - | nav 15 undefined | type 36 | callsign WDA1234 imo - | 12x4 m draught 0 m | dest - eta - | skip: own receiver has it
   aishub-to-ydwg poll 12: 227011340 ESPIGUETTE_RD | AISHub 16:40:23 | own receiver never | last sent 16:40:23 | 148.2 nm bearing 041 | 11.1234,-74.0012 | class A | sog 0.1 kn cog 180 hdg 90 rot 0 | nav 1 at anchor | type 70 | callsign FABC imo 9123456 | 180x28 m draught 9.5 m | dest CARTAGENA eta 09-26 06:00 | would send again: same report as last poll (PGNs 129038, 129794)
   aishub-to-ydwg poll 12: 636024775 ISTANBUL EXPRESS | AISHub 16:55:50 | own receiver never | last sent 16:50:48 | 62.0 nm bearing 305 | 10.2210,-76.8801 | class A | sog 18.3 kn cog 296 hdg 295 rot 0 | nav 0 under way (engine) | type 71 | callsign D5XY7 imo 9234567 | 300x40 m draught 12.1 m | dest COLON eta 09-25 22:00 | would send: own receiver has never heard it (PGNs 129038, 129794)
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

Upgrading from `aishub-to-n2k`: this is a new plugin with a new id, so
its settings start empty. Enter the API key and tick the receivers
again, then remove `aishub-to-n2k` from the Appstore.

## Status

The plugin's status line, on the Plugin Config page and the dashboard,
reads like:

```
12 polls. own receiver c078c37ae76baa6d@1 has reported 11 vessels since start;
last poll: 42 from AISHub, 10 own receiver has, 33 sent to plotters (18 repeats of the last report, 2 held while AISHub is quiet, 79 messages);
sending to gateway 192.168.4.25:1458
```

"Held while AISHub is quiet" counts the vessels sent although AISHub
left them out of this reply. When a hold runs out the status adds
"1 dropped after AISHub went quiet" for that poll. In dry run the
sent part reads "33 would have been sent" and the gateway part reads
"dry run: decisions are in the server log".

Errors from AISHub (a bad key, "Too frequent requests", a timeout) and
errors sending to the gateway go to the server log and to the end of
the status line, and the next poll tries again.

## How the sent data looks on the bus

The gateway puts its own bus address on the messages, so on the bus
they come from the gateway, not from your AIS receiver.

AISHub does not say whether a vessel has a class A or class B
transponder, so the plugin chooses the message format from the data it
holds. A vessel with anything only the class A messages can carry
(navigation status, destination, ETA, draught, rate of turn, IMO number)
is sent as class A, so none of it is dropped. Everything else is sent as
class B. ETA is not sent yet: the NMEA 2000 message wants a full date and
AISHub gives only month, day and time.

Values AISHub does not have (heading 511, course 360, speed 102.4) are
sent as "not available", exactly as a transponder would.

## Why the plugin sends to the gateway itself

Versions up to 0.1.7 handed each message to Signal K's own NMEA 2000
connection to the gateway. Measured on the author's boat, the gateway
put only some of the frames of each multi-frame AIS message on the bus,
so the plotters showed nothing. Sending the same messages from a laptop
to the gateway every way there is showed the cause: Signal K's
connection sends every frame of a message as its own UDP packet, back
to back, and the gateway then loses roughly every other frame. With all
of a message's frames in one packet the gateway never lost a frame. And
fired back to back, a poll's worth of messages (37, one packet each)
had only 13 to 15 confirmed by the gateway; 20 ms apart, 32 to 37 of 37
over nine runs, and no better with longer pauses.

So the plugin does its own sending: one packet per message, 20 ms
apart, straight to the gateway's address. Signal K's connection is
still used to read the bus. The 0.1.7 release notes said the gateway
"drops the tail of a burst", and the old README said the connection
needed `createDevice: true`; both were guesses, and both were wrong.

## Tests

```
npm test
```

The tests encode every message with canboatjs and decode it the way a
plotter would, so the field names and units are checked against the real
NMEA 2000 definitions, and they send through the real sender to a UDP
socket on the same machine, so one packet per message and the pause
between messages are checked too.

The plugin depends on `@canboat/canboatjs` for the encoding.

## Licence

Apache-2.0.
