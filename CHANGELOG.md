# Changelog

## 0.1.2

- Every dry-run log line now carries everything AISHub sent about the
  vessel: distance and bearing from your boat, position, class, speed,
  course, heading, rate of turn, navigation status, ship type, callsign,
  IMO number, dimensions, draught, destination and ETA.

## 0.1.1

The filter now works by time, and the plugin does only what it says.

- A vessel is skipped when your own receiver's last message from it is
  as new as AISHub's record (AISHub's time is the vessel's own
  transmission time). The "minutes to trust your own receiver" setting
  is gone. Your receiver's last message times are also read from what
  Signal K already holds, so the first poll after a restart filters
  properly too.
- A record already sent is not sent again until AISHub has a newer one,
  so a vessel that goes quiet drops off the plotters on their own timer.
  The "ignore reports older than N minutes" setting is gone.
- The "only send vessels within N nautical miles" setting is gone: the
  box is the only limit.
- The box distance has a unit setting: kilometres, nautical miles or
  statute miles. The old `boxKm` setting is still read.
- Own MMSI setting, filled in from Signal K's vessel settings, editable,
  required.
- Position, name and details are sent every poll.
- Nothing is written into Signal K's own vessel table any more; the
  plugin only sends to the NMEA 2000 connection.
- Dry run is off by default and writes one decision line per vessel per
  poll to the server log. The dry-run log file and the `/status` and
  `/log` web endpoints are gone.
- Status line says "restart Signal K to enable it" when the connection
  cannot send yet.

## 0.1.0

First release.

- Poll AISHub for the vessels in an adjustable box around the boat, no
  faster than once every 61 seconds.
- Drop your own vessel and the vessels your own AIS receiver (chosen from
  the NMEA 2000 devices on the bus) has heard recently.
- Send the rest to the bus as class A or class B position and static
  data messages through the chosen NMEA 2000 connection, within a chosen
  range and age.
- Put every vessel AISHub sent into Signal K's vessel list.
- Dry-run log, `/status` and `/log` endpoints.
- No runtime dependencies.
