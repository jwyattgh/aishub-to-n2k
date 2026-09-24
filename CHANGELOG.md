# Changelog

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
