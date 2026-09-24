/*
 * Small geography helpers: the box to ask AISHub for, and the distance
 * from the boat to a vessel.
 */

const EARTH_RADIUS_M = 6371000
const METRES_PER_NM = 1852
const KM_PER_DEGREE_LAT = 111.32

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

// Great-circle distance in nautical miles.
function distanceNm (lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c / METRES_PER_NM
}

module.exports = { boxAround, distanceNm }
