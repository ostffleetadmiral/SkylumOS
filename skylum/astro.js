// astro.js — SKYLUM celestial service: real astronomy over UTC.
// Sun: standard J2000 low-precision ephemeris (~0.01°). Moon: truncated
// Meeus perturbation series (~1°, honest approximation — sufficient for
// sky maps, not occultations). Stars: fixed J2000 navigational catalog.
// All functions are pure and DOM-free; ECHO renders, SKYLUM computes.

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const norm360 = x => ((x % 360) + 360) % 360;
const norm24 = x => ((x % 24) + 24) % 24;

export function julianDate(date = new Date()) {
  return date.getTime() / 86400000 + 2440587.5;
}

// GMST in hours (IAU 1982 polynomial form).
export function gmst(date = new Date()) {
  const d = julianDate(date) - 2451545.0;
  return norm24(18.697374558 + 24.06570982441908 * d);
}

// Solar apparent RA (hours) and declination (deg), plus the subsolar
// point on the geoid (lat = dec, lng = -GHA).
export function solarState(date = new Date()) {
  const n = julianDate(date) - 2451545.0;
  const L = norm360(280.460 + 0.9856474 * n);          // mean longitude
  const g = (357.528 + 0.9856003 * n) * D2R;           // mean anomaly
  const lambda = norm360(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;          // obliquity
  const ra = norm24(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D / 15);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  const gha = norm360(15 * (gmst(date) - ra));         // Greenwich hour angle
  return { ra, dec, gha, lng: gha > 180 ? 360 - gha : -gha, lat: dec };
}

// Back-compat name used by globe.js terminator rendering.
export const subsolarPoint = date => {
  const s = solarState(date);
  return { lat: s.lat, lng: s.lng };
};

// Geocentric lunar RA/Dec plus phase angle (deg) and illuminated
// fraction [0,1]. Truncated to the principal perturbation terms.
export function lunarState(date = new Date()) {
  const n = julianDate(date) - 2451545.0;
  const Lp = norm360(218.316 + 13.176396 * n);         // mean longitude
  const Mp = (134.963 + 13.064993 * n) * D2R;          // mean anomaly (moon)
  const Ms = (357.529 + 0.9856003 * n) * D2R;          // mean anomaly (sun)
  const D = (297.850 + 12.190749 * n) * D2R;           // mean elongation
  const F = (93.272 + 13.229350 * n) * D2R;            // argument of latitude
  const lambda = norm360(Lp + 6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp)
    + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mp)
    - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(2 * F)) * D2R;
  const beta = (5.128 * Math.sin(F) + 0.280 * Math.sin(Mp + F)
    + 0.277 * Math.sin(Mp - F) + 0.173 * Math.sin(2 * D - F)
    + 0.055 * Math.sin(2 * D + F - Mp) + 0.046 * Math.sin(2 * D - F - Mp)
    + 0.041 * Math.sin(2 * D - Ms)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const ra = norm24(Math.atan2(
    Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
    Math.cos(lambda)) * R2D / 15);
  const dec = Math.asin(Math.sin(beta) * Math.cos(eps)
    + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda)) * R2D;
  const phase = 180 - D * R2D - 6.289 * Math.sin(Mp) + 2.100 * Math.sin(Ms)
    - 1.274 * Math.sin(2 * D - Mp) - 0.658 * Math.sin(2 * D)
    - 0.214 * Math.sin(2 * Mp) - 0.110 * Math.sin(D);
  return { ra, dec, phase: norm360(phase), illum: (1 + Math.cos(phase * D2R)) / 2 };
}

// Named bright-star catalog (J2000 RA hours / Dec deg / visual mag).
export const STARS = Object.freeze([
  { name: "Polaris", ra: 2.5303, dec: 89.2641, mag: 1.98 },
  { name: "Dubhe", ra: 11.0621, dec: 61.7508, mag: 1.79 },
  { name: "Mirfak", ra: 3.4054, dec: 49.8612, mag: 1.79 },
  { name: "Aldebaran", ra: 4.5987, dec: 16.5093, mag: 0.86 },
  { name: "Capella", ra: 5.2782, dec: 45.9980, mag: 0.08 },
  { name: "Rigel", ra: 5.2423, dec: -8.2016, mag: 0.13 },
  { name: "Betelgeuse", ra: 5.9195, dec: 7.4070, mag: 0.42 },
  { name: "Bellatrix", ra: 5.4188, dec: 6.3497, mag: 1.64 },
  { name: "Elnath", ra: 5.4382, dec: 28.6075, mag: 1.65 },
  { name: "Alnilam", ra: 5.6036, dec: -1.2019, mag: 1.69 },
  { name: "Sirius", ra: 6.7525, dec: -16.7161, mag: -1.46 },
  { name: "Adhara", ra: 6.9771, dec: -28.9721, mag: 1.50 },
  { name: "Wezen", ra: 7.1399, dec: -26.3932, mag: 1.83 },
  { name: "Canopus", ra: 6.3992, dec: -52.6957, mag: -0.74 },
  { name: "Avior", ra: 8.3752, dec: -59.5095, mag: 1.86 },
  { name: "Castor", ra: 7.5766, dec: 31.8883, mag: 1.58 },
  { name: "Pollux", ra: 7.7553, dec: 28.0262, mag: 1.14 },
  { name: "Procyon", ra: 7.6550, dec: 5.2250, mag: 0.34 },
  { name: "Alhena", ra: 6.6285, dec: 16.3993, mag: 1.93 },
  { name: "Regulus", ra: 10.1395, dec: 11.9672, mag: 1.35 },
  { name: "Alioth", ra: 12.9004, dec: 55.9598, mag: 1.77 },
  { name: "Alkaid", ra: 13.7923, dec: 49.3133, mag: 1.86 },
  { name: "Spica", ra: 13.4199, dec: -11.1613, mag: 0.97 },
  { name: "Arcturus", ra: 14.2610, dec: 19.1825, mag: -0.05 },
  { name: "Antares", ra: 16.4901, dec: -26.4320, mag: 0.96 },
  { name: "Sargas", ra: 17.6219, dec: -42.9978, mag: 1.87 },
  { name: "Kaus Australis", ra: 18.4029, dec: -34.3846, mag: 1.85 },
  { name: "Vega", ra: 18.6157, dec: 38.7837, mag: 0.03 },
  { name: "Altair", ra: 19.8464, dec: 8.8683, mag: 0.76 },
  { name: "Deneb", ra: 20.6905, dec: 45.2803, mag: 1.25 },
  { name: "Peacock", ra: 20.4275, dec: -56.7351, mag: 1.94 },
  { name: "Fomalhaut", ra: 22.9608, dec: -29.6222, mag: 1.16 },
  { name: "Acrux", ra: 12.4433, dec: -63.0991, mag: 0.76 },
  { name: "Rigil Kentaurus", ra: 14.6591, dec: -60.8354, mag: -0.27 },
]);

// Horizontal coordinates of a body (RA hours, Dec deg) for an observer
// at (latDeg, lonDegEast) and a UTC instant. Az is compass convention:
// 0 = north, 90 = east. alt > 0 means above the horizon.
export function altAz(ra, dec, lat, lon, date = new Date()) {
  const ha = (norm24(gmst(date) + lon / 15) - ra) * 15 * D2R;
  const phi = lat * D2R, d = dec * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(ha)) * R2D;
  const az = norm360(Math.atan2(Math.sin(ha),
    Math.cos(ha) * Math.sin(phi) - Math.tan(d) * Math.cos(phi)) * R2D + 180);
  return { alt, az };
}

// Whole-sky snapshot for one observer: sun + moon + catalog stars with
// horizontal coordinates and visibility flags. ECHO renders this.
export function observerSky(date, lat, lon) {
  const sun = solarState(date), moon = lunarState(date);
  return {
    at: date.toISOString(), lat, lon,
    sun: { ...sun, ...altAz(sun.ra, sun.dec, lat, lon, date) },
    moon: { ...moon, ...altAz(moon.ra, moon.dec, lat, lon, date) },
    stars: STARS.map(s => ({ ...s, ...altAz(s.ra, s.dec, lat, lon, date) })),
  };
}
