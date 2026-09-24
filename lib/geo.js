/*
 * The box to ask AISHub for.
 */

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

module.exports = { boxAround }
