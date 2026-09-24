# Changelog

## 0.1.5

- Every vessel that passes the filter is now sent every poll, even when
  AISHub's record is unchanged, so the plotters keep the target through
  the gaps between a vessel's reports. Moored ships report every three
  minutes and AISHub's feeders miss some, so the plotters were dropping
  far targets and showing them again minutes later. A vessel AISHub has
  dropped (about half an hour after its last report) is dropped by the
  plotters on their own timer. The status now says how many of the sent
  vessels were repeats of the last report.

## 0.1.4

- Changing a setting (dry run off, for one) no longer loses the NMEA
  2000 output until Signal K is restarted. Signal K gives a plugin a copy
  of the server taken when the plugin loads, and its "output available"
  flag never changes on that copy; the plugin now keeps its own, outside
  the start and stop a settings change causes.
- After a settings change the plugin waits out the rest of the minute
  before asking AISHub again, instead of getting "Too frequent requests".
- A reply that arrives after a settings change is dropped rather than
  handled with the new settings.
- Vessels that could not be sent because the output was not available
  are now counted as "not sent (no NMEA 2000 output)" in the status, not
  as sent.
- The dry-run line for "skip: own receiver has it" now shows when the
  plugin last sent that vessel, instead of always "never".

## 0.1.3

- Class A or class B is now chosen from the data, not from the IMO
  number. A vessel with a navigation status, destination, ETA, draught,
  rate of turn or IMO number is sent as class A, so none of it is
  dropped; the rest as class B. Ships without an IMO number (tugs, pilot
  boats, coasters) were being sent as class B and losing their status
  and destination.
- Dry-run log and status now say "would send" and "would have been
  sent". "already sent this report" is now "same report as last poll"
  in both.
- "00-00 00:00" from AISHub is read as no ETA.

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
