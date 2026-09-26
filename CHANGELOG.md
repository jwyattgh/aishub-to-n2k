# Changelog

## 0.2.0

Renamed from `aishub-to-n2k` to `aishub-to-ydwg`: the plugin now sends
straight to a Yacht Devices YDWG-02 gateway, and nowhere else. New
plugin id, so its settings start empty after the upgrade; remove
`aishub-to-n2k` afterwards.

- Messages go to the gateway from the plugin itself, over UDP to the
  gateway's address and RAW port, every message whole in one packet
  and messages 20 ms apart. Signal K's NMEA 2000 connection is only
  read (for what the own receiver hears), never sent through. Measured
  on the author's boat: Signal K's connection sends each frame of a
  message as its own packet and the gateway loses about every other
  frame; whole messages in one packet lose none; and a poll's worth
  fired back to back had 13 to 15 of 37 messages confirmed by the
  gateway, 20 ms apart 32 to 37 of 37.
- New settings: gateway address (default 192.168.4.25) and port
  (default 1458). The connection setting stays, for reading only.
- Removed: "Milliseconds between messages to the bus" (0.1.7). Its
  release note said the gateway "drops the tail of a burst"; that was a
  guess, and wrong. The loss was inside every message, whatever the
  spacing, because each message's frames went as separate packets.
- Removed: the "NMEA 2000 output not available: restart Signal K"
  status, the "not sent (no NMEA 2000 output)" count and the "still
  waiting for the bus were dropped" count. None of them apply now.
- The README's claim that the connection needed `createDevice: true`
  was wrong too; the connection no longer sends anything.
- `@canboat/canboatjs` is now a runtime dependency (it encodes the
  messages). 0.1.x had no runtime dependencies.

## 0.1.7

- Messages go to the bus one every 100 ms instead of all at once. A
  poll's worth (48 messages, five or six frames each) was leaving the
  gateway in half a second, and the YDWG-02 dropped the tail of the
  burst: on the author's boat 23 vessels were sent each poll and 17 or
  18 reached the bus, the same ones missing every time, since 0.1.0.
  The AIS receiver's own messages on the same gateway arrive complete.
  New setting "Milliseconds between messages to the bus", default 100;
  0 restores the burst. Messages still waiting when the next poll comes
  are dropped and counted in the status.

## 0.1.6

- A vessel AISHub leaves out of a reply is no longer forgotten that
  same poll. It is kept, and sent again every poll, until AISHub has
  been quiet about it for longer than the vessel's own average gap
  between reports, padded by a quarter, and never less than two polls.
  AISHub's replies have holes (a vessel drops out for a poll or five and
  comes back), and 0.1.5 stopped sending the vessel the moment it was
  missing, so quiet vessels still blinked on the plotters. The gap is
  measured from AISHub's report times over the vessel's last ten
  reports; a vessel with no history gets the average over the vessels
  held, or three minutes. A held vessel the own receiver starts hearing
  is dropped at once. The status now counts "held while AISHub is
  quiet" and "dropped after AISHub went quiet", and the dry-run line
  says how long a vessel has been missing and how long its hold is.

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
