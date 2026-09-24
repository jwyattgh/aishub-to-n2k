/*
 * The box to ask AISHub for, and distance and bearing between positions.
 */

const KM_PER_DEGREE_LAT = 111.32
const EARTH_RADIUS_KM = 6371.0088
const toRad = deg => deg * Math.PI / 180

// A box `km` kilometres each way from a position, as AISHub wants it.
// Near the poles or the date line the box is clamped to what exists.
function boxAround (lat, lon, km) {
  const dLat = km / KM_PER_DEGREE_LAT
  const cos = Math.cos(lat * Math.PI / 180)
  const dLon = cos > 0.01 ? km / (KM_PER_DEGREE_LAT * cos) : 180
  const latmin = Math.max(-90, lat - dLat)
  const latmax = Math.min(90, lat + dLat)
  let lonmin = lon - dLon
  let lonmax = lon + dLon
  if (dLon >= 180 || lonmin < -180 || lonmax > 180) {
    lonmin = -180
    lonmax = 180
  }
  return {
    latmin: round(latmin),
    latmax: round(latmax),
    lonmin: round(lonmin),
    lonmax: round(lonmax)
  }
}

function round (n) {
  return Math.round(n * 10000) / 10000
}

// Great-circle distance in kilometres between two positions.
function distanceKm (lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

// Initial bearing in degrees true, 0-359, from the first position to the second.
function bearingDegrees (lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1)
  const y = Math.sin(dLon) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
  return (Math.round(Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

module.exports = { boxAround, distanceKm, bearingDegrees }
