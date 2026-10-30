// Our own car, built in code: a low-poly late-90s German sports saloon (E46 3 Series proportions:
// long bonnet, short front overhang, kidney grille, twin round headlamps, a kinked rear side window,
// L-shaped tail lamps split between wing and boot lid). Flat shaded, no badges.
// The body is lofted through cross-sections along its length (each a half-profile mirrored to both
// sides), so every panel has an even grid of small facets: undamaged they read as clean flat planes,
// crushed they fold into crisp low-poly creases. Faces are sorted into panels (doors, bonnet, boot
// lid, bumpers, mirrors, glass, trim) by where they sit. Lamps, grille, handles, mirrors, interior and
// wheels are simple solids. Output matches loadCarTemplate() so the rest of the game is unchanged.
// Car frame: origin at the centre of gravity, +z forward, +x the car's left, ground at y = -cgHeight.
import * as THREE from 'three';
import { SoftBody, bindGeometry, CORE } from './softbody.js';

const FACET = 0.15; // target facet size (m): sets how finely panels can crease
const GROUND = (P) => -P.cgHeight;

// ---------------------------------------------------------------- materials (flat shaded)
function materials() {
  const paint = new THREE.MeshPhysicalMaterial({ name: 'carpaint', color: 0x2c4f9a, roughness: 0.35, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, flatShading: true });
  paint.userData.paint = true;
  const std = (o) => new THREE.MeshStandardMaterial({ flatShading: true, ...o });
  return {
    paint,
    plastic: std({ name: 'plastic', color: 0x232427, roughness: 0.85 }),
    trim: std({ name: 'trim', color: 0x0e0f11, roughness: 0.3, metalness: 0.2 }), // gloss black window frames
    roof: new THREE.MeshPhysicalMaterial({ name: 'roof', color: 0x0f1012, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.06, flatShading: true }),
    grille: std({ name: 'grille', color: 0x111214, roughness: 0.6, metalness: 0.3 }),
    under: std({ name: 'under', color: 0x161616, roughness: 0.95 }),
    glass: new THREE.MeshStandardMaterial({ name: 'glass', color: 0x1a2430, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.62, flatShading: true }),
    chrome: std({ name: 'chrome', color: 0xc9ccd2, roughness: 0.22, metalness: 0.9 }),
    tyre: std({ name: 'tyre', color: 0x18181a, roughness: 0.92 }),
    rim: std({ name: 'rim', color: 0xd4d7dc, roughness: 0.28, metalness: 0.85 }),
    caliper: std({ name: 'caliper', color: 0xb8322a, roughness: 0.5, metalness: 0.2 }),
    interior: std({ name: 'interior', color: 0x2a2b2f, roughness: 0.9 }),
    seat: std({ name: 'seat', color: 0x3b3d42, roughness: 0.95 }),
    lens: new THREE.MeshStandardMaterial({ name: 'lens', color: 0x8a96a3, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.5, flatShading: true }),
    lamp: (col, em) => std({ name: 'lamp', color: col, roughness: 0.15, metalness: 0.1, emissive: new THREE.Color(em), emissiveIntensity: 0 }),
  };
}

// ---------------------------------------------------------------- body sections
// Key stations, heights from the ground. Columns: z, floor half-width wb / height hb, lower side
// ws / hlow, lower character crease wcl / hcl, shoulder crease wsh / hsh, belt line wbelt / hbelt,
// roof edge wr / hr, roof crown. Ahead of the windscreen the "roof" is the bonnet; behind the rear
// window it is the boot lid.
const KEY = [
  // z      wb   hb    ws   hlow  wcl  hcl   wsh   hsh   wbelt hbelt wr   hr    crown
  [2.16, 0.60, 0.24, 0.66, 0.28, 0.68, 0.42, 0.66, 0.56, 0.62, 0.62, 0.52, 0.66, 0.01],
  [2.06, 0.70, 0.18, 0.78, 0.22, 0.82, 0.40, 0.82, 0.62, 0.80, 0.68, 0.66, 0.73, 0.02],
  [1.75, 0.74, 0.16, 0.84, 0.22, 0.86, 0.42, 0.865, 0.70, 0.85, 0.76, 0.72, 0.82, 0.035],
  [0.95, 0.76, 0.15, 0.86, 0.21, 0.87, 0.43, 0.875, 0.78, 0.865, 0.88, 0.76, 0.92, 0.03],
  [0.10, 0.76, 0.15, 0.86, 0.21, 0.87, 0.43, 0.875, 0.79, 0.865, 0.91, 0.66, 1.40, 0.03],
  [-0.95, 0.76, 0.15, 0.86, 0.21, 0.87, 0.43, 0.875, 0.80, 0.865, 0.93, 0.64, 1.38, 0.03],
  [-1.55, 0.76, 0.16, 0.86, 0.22, 0.87, 0.44, 0.87, 0.81, 0.86, 0.96, 0.78, 0.985, 0.015],
  [-2.20, 0.74, 0.20, 0.84, 0.26, 0.86, 0.44, 0.86, 0.80, 0.84, 0.95, 0.75, 0.99, 0.01],
  [-2.31, 0.68, 0.30, 0.76, 0.34, 0.78, 0.46, 0.78, 0.78, 0.75, 0.92, 0.66, 0.95, 0.01],
];
function keyAt(z) {
  for (let i = 0; i < KEY.length - 1; i++) {
    const a = KEY[i], b = KEY[i + 1];
    if (z <= a[0] && z >= b[0]) { const t = (a[0] - z) / (a[0] - b[0]); return a.map((v, k) => v + (b[k] - v) * t); }
  }
  return (z > KEY[0][0] ? KEY[0] : KEY[KEY.length - 1]).slice();
}
const ZF = KEY[0][0], ZR = KEY[KEY.length - 1][0];
const COWL = 0.93, ROOF_F = 0.1, ROOF_R = -0.95, DECK = -1.55; // windscreen foot / top, rear window top / foot
const DOOR_F = [0.93, -0.24], B_PILLAR = [-0.24, -0.3], DOOR_R = [-0.3, -0.94], KINK = -1.15;

// ---------------------------------------------------------------- mesh building helpers
class Builder {
  constructor() { this.groups = new Map(); } // key -> { mat, part, light, tag, pos: [], idx: [] }
  group(mat, part = null, light = null, tag = null) {
    const k = [mat.name, mat.uuid, part, light, tag].join('|');
    if (!this.groups.has(k)) this.groups.set(k, { mat, part, light, tag, pos: [], idx: [] });
    return this.groups.get(k);
  }
  tri(g, a, b, c) { // unshared vertices: crisp flat facets
    const n = g.pos.length / 3;
    g.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    g.idx.push(n, n + 1, n + 2);
  }
  // a solid from a list of corner points (convex), e.g. lamp lenses, mirrors, seats
  hull(g, pts) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const ch = convexTris(pts);
    for (const [a, b, c] of ch) this.tri(g, pts[a], pts[b], pts[c]);
    geo.dispose();
  }
  box(g, c, s, rot = null) {
    const pts = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const p = new THREE.Vector3(x * s.x / 2, y * s.y / 2, z * s.z / 2);
      if (rot) p.applyEuler(rot);
      pts.push(p.add(c));
    }
    const F = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const [a, b, cc, d] of F) { this.tri(g, pts[a], pts[b], pts[cc]); this.tri(g, pts[a], pts[cc], pts[d]); }
  }
  geometries() {
    const out = [];
    for (const g of this.groups.values()) {
      if (!g.idx.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setIndex(g.idx);
      geo.computeVertexNormals(); // unshared verts: these are the face normals
      const uv = new Float32Array((g.pos.length / 3) * 2); // (unused, but standard materials expect uvs)
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.computeBoundingBox();
      out.push({ geo, mat: g.mat, part: g.part, light: g.light, tag: g.tag });
    }
    return out;
  }
}
// tiny convex hull for small point sets (gift-wrapping all triples; fine for <= 16 points)
function convexTris(pts) {
  const out = [], n = pts.length, e = new THREE.Vector3(), f = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) {
    nn.crossVectors(e.subVectors(pts[b], pts[a]), f.subVectors(pts[c], pts[a]));
    if (nn.lengthSq() < 1e-10) continue;
    let pos = 0, neg = 0;
    for (let k = 0; k < n; k++) { if (k === a || k === b || k === c) continue; const d = nn.dot(e.subVectors(pts[k], pts[a])); if (d > 1e-7) pos++; else if (d < -1e-7) neg++; }
    if (pos && neg) continue;
    out.push(pos ? [a, c, b] : [a, b, c]);
  }
  return out;
}

// ---------------------------------------------------------------- the car
export function buildLowPolyTemplate(P) {
  const M = materials(), B = new Builder();
  const g0 = GROUND(P), a = P.wheelbase * (1 - P.frontWeight), b = P.wheelbase * P.frontWeight;
  const axles = [a, -b], archR = P.wheelR + 0.09;

  // stations: key stations + evenly spaced fill + dense round the wheel arches + every shut line
  const zs = new Set(KEY.map((k) => k[0]));
  for (let z = ZF; z > ZR; z -= FACET) zs.add(+z.toFixed(3));
  for (const ax of axles) for (const d of [-1, -0.96, -0.85, -0.66, -0.38, 0, 0.38, 0.66, 0.85, 0.96, 1]) zs.add(+(ax + d * archR).toFixed(3));
  for (const z of [COWL, ROOF_F, ROOF_R, DECK, ...DOOR_F, ...B_PILLAR, ...DOOR_R, KINK, 1.8, 2.0, -2.05]) zs.add(z);
  const Z = [...zs].filter((z) => z <= ZF && z >= ZR).sort((p, q) => q - p);

  // one half-section (+x side), 8 points: bottom centre, floor edge, lower side, lower crease,
  // shoulder crease, belt, roof edge, crown -> 7 strips (0 floor, 1 liner, 2 sill, 3 door, 4 shoulder, 5 glass, 6 roof)
  const section = (z) => {
    const [, wb0, hb, ws, hlow0, wcl, hcl0, wsh, hsh, wbelt, hbelt, wr, hr, crown] = keyAt(z);
    let wb = wb0, hlow = hlow0;
    for (const ax of axles) { // wheel arch: the lower edge climbs round the tyre, the floor steps inboard
      const d = Math.abs(z - ax);
      if (d < archR) { hlow = Math.max(hlow, P.wheelR + Math.sqrt(archR * archR - d * d) - 0.02); wb = Math.min(wb, 0.56); }
      else if (d < archR + 0.02) wb = Math.min(wb, 0.56);
    }
    const hcl = Math.max(hcl0, hlow + 0.004);
    return [[0, hb], [wb, hb], [ws, hlow], [wcl, hcl], [wsh, hsh], [wbelt, hbelt], [wr, hr], [0, hr + crown]].map(([x, hh]) => new THREE.Vector3(x, hh + g0, z));
  };
  const S = Z.map(section);
  const NS = 7;
  const at = (x, hh, z) => new THREE.Vector3(x, hh + g0, z);
  const h = (p) => p.y - g0;
  const inR = (z, [hi, lo]) => z < hi && z > lo;

  // panel + material of a facet: strip j, centroid c, side, sub-row k of n across the strip
  const assign = (j, c, left, k, n) => {
    const z = c.z, sd = left ? 'L' : 'R', H = h(c);
    const door = inR(z, DOOR_F) ? 'doorF' + sd : inR(z, DOOR_R) ? 'doorR' + sd : null;
    const front = z > 1.8, rear = z < -2.05;
    if (j === 0) return [M.under, null];
    if (j === 1) return [M.plastic, front ? 'bumperF' : rear ? 'bumperR' : null];
    if (j === 2) {
      if (front) return [H < 0.3 ? M.plastic : M.paint, 'bumperF'];
      if (rear) return [H < 0.34 ? M.plastic : M.paint, 'bumperR'];
      return [M.paint, door];
    }
    if (j === 3) { // lower body up to the shoulder crease
      if (front) return [M.paint, H < 0.5 ? 'bumperF' : null];
      if (rear) return [M.paint, H < 0.58 ? 'bumperR' : null];
      return [M.paint, door];
    }
    if (j === 4) return [M.paint, front || rear || z > COWL || z < DECK ? null : door];
    if (z > COWL) return [M.paint, 'hood']; // bonnet sides and top
    if (z < DECK) return [M.paint, 'tailgate']; // boot lid sides and top (the game's id for the rear lid)
    if (j === 5) {
      const frame = k === n - 1 || k === 0; // gloss-black frame above, rubber seal along the belt
      if (inR(z, DOOR_F)) return [frame ? M.trim : M.glass, 'doorF' + sd];
      if (inR(z, B_PILLAR)) return [M.trim, null];
      if (inR(z, DOOR_R)) return [frame ? M.trim : M.glass, 'doorR' + sd];
      if (z > KINK) return [!frame && k / n < 0.55 ? M.glass : M.paint, null]; // the kink: glass only low down
      return [M.paint, null]; // C pillar
    }
    if (z > ROOF_F) return [z > COWL - 0.07 ? M.trim : M.glass, null]; // windscreen, black cowl strip at its foot
    if (z > ROOF_R) return [M.paint, null]; // roof
    return [z < DECK + 0.06 ? M.trim : M.glass, null]; // rear window
  };

  // loft: each strip between neighbouring stations, subdivided the same way everywhere (watertight)
  const nAcross = [...Array(NS).keys()].map((j) => Math.max(j === 5 ? 6 : 1, ...S.map((s) => Math.ceil(s[j].distanceTo(s[j + 1]) / (j === 5 ? FACET * 0.5 : FACET)))));
  const lerp3 = (p, q, t) => p.clone().lerp(q, t);
  for (const left of [true, false]) {
    const mx = left ? 1 : -1;
    const M3 = (p) => new THREE.Vector3(p.x * mx, p.y, p.z);
    for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < NS; j++) {
      const n = nAcross[j];
      for (let k = 0; k < n; k++) {
        const p00 = M3(lerp3(S[i][j], S[i][j + 1], k / n)), p01 = M3(lerp3(S[i][j], S[i][j + 1], (k + 1) / n));
        const p10 = M3(lerp3(S[i + 1][j], S[i + 1][j + 1], k / n)), p11 = M3(lerp3(S[i + 1][j], S[i + 1][j + 1], (k + 1) / n));
        const c = p00.clone().add(p01).add(p10).add(p11).multiplyScalar(0.25);
        const [mat, part] = assign(j, c, left, k, n);
        const g = B.group(mat, part);
        if (left) { B.tri(g, p00, p10, p11); B.tri(g, p00, p11, p01); } else { B.tri(g, p00, p11, p10); B.tri(g, p00, p01, p11); }
      }
    }
  }
  // end caps in horizontal bands, so panel lines run straight across
  for (const [s, front] of [[S[0], true], [S[S.length - 1], false]]) {
    const prof = s.slice(1).map((p) => [p.x, h(p)]);
    const xAt = (H) => {
      for (let i = 0; i < prof.length - 1; i++) {
        const [x0, h0] = prof[i], [x1, h1] = prof[i + 1];
        if (H >= h0 - 1e-6 && H <= h1 + 1e-6) return h1 - h0 < 1e-6 ? Math.max(x0, x1) : x0 + (x1 - x0) * (H - h0) / (h1 - h0);
      }
      return 0;
    };
    const splits = front ? [0.3, 0.5] : [0.35, 0.55, 0.8];
    let hs = [...new Set([...prof.map((p) => +p[1].toFixed(4)), ...splits])].sort((p, q) => p - q);
    const fine = [];
    for (let i = 0; i < hs.length - 1; i++) { const n = Math.max(1, Math.ceil((hs[i + 1] - hs[i]) / FACET)); for (let k = 0; k < n; k++) fine.push(hs[i] + (hs[i + 1] - hs[i]) * k / n); }
    fine.push(hs[hs.length - 1]); hs = fine;
    const z = s[0].z;
    for (let i = 0; i < hs.length - 1; i++) {
      const H0 = hs[i], H1 = hs[i + 1], x0 = xAt(H0), x1 = xAt(H1), Hm = (H0 + H1) / 2;
      let mat, part;
      if (front) { mat = Hm < 0.3 ? M.plastic : M.paint; part = Hm < 0.5 ? 'bumperF' : null; }
      else { mat = Hm < 0.35 ? M.plastic : M.paint; part = Hm < 0.55 ? 'bumperR' : Hm > 0.8 ? 'tailgate' : null; }
      const g = B.group(mat, part), n = Math.max(1, Math.ceil((2 * Math.max(x0, x1)) / FACET));
      for (let cc = 0; cc < n; cc++) {
        const u0 = -1 + (2 * cc) / n, u1 = -1 + (2 * (cc + 1)) / n;
        const p00 = new THREE.Vector3(x0 * u0, H0 + g0, z), p10 = new THREE.Vector3(x0 * u1, H0 + g0, z);
        const p01 = new THREE.Vector3(x1 * u0, H1 + g0, z), p11 = new THREE.Vector3(x1 * u1, H1 + g0, z);
        if (front) { B.tri(g, p00, p10, p11); B.tri(g, p00, p11, p01); } else { B.tri(g, p00, p11, p10); B.tri(g, p00, p01, p11); }
      }
    }
  }

  // ---- details: an n-gon disc facing +z (front) or -z (rear), slightly proud of the surface
  const disc = (g, c, r, n, facing, ph = Math.PI / n) => {
    for (let i = 0; i < n; i++) {
      const t0 = ph + (i / n) * Math.PI * 2, t1 = ph + ((i + 1) / n) * Math.PI * 2;
      const p0 = c.clone().add(new THREE.Vector3(Math.cos(t0) * r, Math.sin(t0) * r, 0)), p1 = c.clone().add(new THREE.Vector3(Math.cos(t1) * r, Math.sin(t1) * r, 0));
      facing > 0 ? B.tri(g, c, p0, p1) : B.tri(g, c, p1, p0);
    }
  };
  const lamps = {
    head: M.lamp(0xe6ebf0, 0xfff6e8), drl: M.lamp(0xe6ebf0, 0xffffff), turn: M.lamp(0xd8a24a, 0xffa020),
    tail: M.lamp(0xa3191a, 0xff1a10), brake: M.lamp(0xb01c1c, 0xff1408), reverse: M.lamp(0xdfe3e8, 0xffffff),
  };
  const spots = {};
  const spot = (key, pos, size, front) => (spots[key] ||= []).push({ pos: pos.clone(), size, front });
  for (const [sd, x] of [['L', 1], ['R', -1]]) {
    // headlamp unit: a dark housing under a clear lens, twin round lamps (outer low beam, inner high)
    const hz = (xx) => 2.16 - 0.27 * Math.max(0, (xx - 0.3) / 0.4) ** 1.6; // the nose sweeps back at the corners
    B.hull(B.group(M.grille, 'bumperF'), [at(0.27 * x, 0.66, hz(0.27) - 0.04), at(0.68 * x, 0.66, hz(0.68) - 0.05), at(0.71 * x, 0.56, hz(0.71) - 0.05), at(0.3 * x, 0.565, hz(0.3) - 0.04),
      at(0.27 * x, 0.66, hz(0.27) + 0.012), at(0.68 * x, 0.66, hz(0.68) + 0.005), at(0.71 * x, 0.56, hz(0.71) + 0.005), at(0.3 * x, 0.565, hz(0.3) + 0.012)]);
    for (const [key, xx] of [['head' + sd, 0.56], ['drl' + sd, 0.39]]) {
      const c = at(xx * x, 0.612, hz(xx) + 0.016);
      disc(B.group(lamps[key.slice(0, -1)], 'bumperF', key), c, 0.062, 8, 1);
      disc(B.group(M.chrome, 'bumperF'), c.clone().add(new THREE.Vector3(0, 0, -0.004)), 0.075, 8, 1);
      spot(key, c, 0.15, true);
    }
    B.box(B.group(lamps.turn, 'bumperF', 'turn' + sd), at(0.69 * x, 0.6, hz(0.69) + 0.01), new THREE.Vector3(0.035, 0.07, 0.02));
    spot('turn' + sd, at(0.69 * x, 0.6, hz(0.69)), 0.08, true);
    // kidney grille: two rounded slabs, chrome surround, black slats
    const kc = at(0.115 * x, 0.585, 2.163);
    const kid = (r, dz) => [[-0.075, 0.07], [0.075, 0.07], [0.085, 0.0], [0.07, -0.065], [-0.07, -0.07], [-0.085, 0]].map(([u, v]) => kc.clone().add(new THREE.Vector3(u * r, v * r, dz)));
    B.hull(B.group(M.chrome, 'bumperF'), [...kid(1, 0.012), ...kid(1, -0.02)]);
    B.hull(B.group(M.grille, 'bumperF'), [...kid(0.82, 0.02), ...kid(0.82, 0.0)]);
    // fog lamps + lower intake
    disc(B.group(M.chrome, 'bumperF'), at(0.55 * x, 0.3, hz(0.55) + 0.008), 0.045, 8, 1);
    // tail lamps, L-shaped: the outer block on the rear wing (tail, brake, indicator), the inner bar on the boot lid (tail, reverse)
    const tz = -2.312;
    B.box(B.group(lamps.tail, null, 'tail' + sd), at(0.63 * x, 0.775, tz + 0.006), new THREE.Vector3(0.3, 0.13, 0.03)); // outer block on the wing
    B.box(B.group(lamps.tail, null, 'tail' + sd), at(0.775 * x, 0.775, tz + 0.08), new THREE.Vector3(0.03, 0.13, 0.15)); // wraps round the corner
    spot('tail' + sd, at(0.63 * x, 0.775, tz), 0.3, false);
    B.box(B.group(lamps.brake, null, 'brake' + sd), at(0.63 * x, 0.815, tz - 0.011), new THREE.Vector3(0.26, 0.03, 0.004));
    spot('brake' + sd, at(0.63 * x, 0.815, tz), 0.2, false);
    B.box(B.group(lamps.turn, null, 'turn' + sd), at(0.63 * x, 0.745, tz - 0.011), new THREE.Vector3(0.26, 0.026, 0.004));
    spot('turn' + sd, at(0.63 * x, 0.745, tz), 0.2, false);
    B.box(B.group(lamps.tail, 'tailgate', 'tail' + sd), at(0.355 * x, 0.83, tz + 0.004), new THREE.Vector3(0.21, 0.08, 0.03)); // inner block on the boot lid: the L's foot
    B.box(B.group(lamps.reverse, 'tailgate', 'reverse' + sd), at(0.355 * x, 0.81, tz - 0.012), new THREE.Vector3(0.15, 0.022, 0.004));
    spot('reverse' + sd, at(0.355 * x, 0.81, tz), 0.16, false);
    // door mirror on the front door's top corner
    const mp = 'mirror' + sd;
    B.box(B.group(M.paint, mp), at(0.89 * x, 0.93, 0.86), new THREE.Vector3(0.07, 0.045, 0.09));
    B.hull(B.group(M.paint, mp), [at(0.91 * x, 0.92, 0.9), at(0.91 * x, 1.04, 0.88), at(0.91 * x, 0.92, 0.8), at(0.91 * x, 1.03, 0.81),
      at(1.08 * x, 0.93, 0.85), at(1.08 * x, 1.03, 0.85), at(1.08 * x, 0.93, 0.8), at(1.08 * x, 1.02, 0.81)]);
    B.box(B.group(M.chrome, mp), at(1.0 * x, 0.975, 0.797), new THREE.Vector3(0.15, 0.09, 0.006));
    // door handles: body-coloured pull bars on the shoulder crease (the clickable bit)
    for (const [door, z] of [['doorF' + sd, -0.08], ['doorR' + sd, -0.8]]) B.box(B.group(M.paint, door, null, 'handle'), at(0.885 * x, 0.765, z), new THREE.Vector3(0.025, 0.03, 0.15));
    // side rubbing strip
    B.box(B.group(M.plastic, 'doorF' + sd), at(0.872 * x, 0.5, (DOOR_F[0] + DOOR_F[1]) / 2), new THREE.Vector3(0.012, 0.035, DOOR_F[0] - DOOR_F[1] - 0.04));
    B.box(B.group(M.plastic, 'doorR' + sd), at(0.872 * x, 0.5, (DOOR_R[0] + DOOR_R[1]) / 2), new THREE.Vector3(0.012, 0.035, DOOR_R[0] - DOOR_R[1] - 0.04));
  }
  B.box(B.group(M.grille, 'bumperF'), at(0, 0.27, 2.12), new THREE.Vector3(0.9, 0.09, 0.03)); // lower intake
  B.box(B.group(M.chrome, 'bumperF'), at(0, 0.4, 2.165), new THREE.Vector3(0.52, 0.11, 0.008)); // number plates
  B.box(B.group(M.chrome, 'tailgate'), at(0, 0.9, -2.317), new THREE.Vector3(0.44, 0.1, 0.008));
  B.box(B.group(M.grille, null), at(0, 0.45, 1.86), new THREE.Vector3(0.7, 0.36, 0.06)); // radiator (what leaks)
  B.box(B.group(M.chrome, null), at(0.5, 0.2, -2.33), new THREE.Vector3(0.09, 0.07, 0.12), new THREE.Euler(0, 0, 0)); // exhaust tip

  // ---- interior
  const I = (c, s, rot) => B.box(B.group(M.interior, null), c, s, rot);
  I(at(0, 0.86, 0.66), new THREE.Vector3(1.6, 0.2, 0.42));
  I(at(0, 0.5, -0.4), new THREE.Vector3(1.6, 0.04, 2.4)); // floor
  I(at(0, 0.6, 0.0), new THREE.Vector3(0.24, 0.18, 1.3)); // tunnel
  for (const x of [0.37, -0.37]) {
    B.box(B.group(M.seat, null), at(x, 0.55, -0.02), new THREE.Vector3(0.5, 0.12, 0.5));
    B.box(B.group(M.seat, null), at(x, 0.85, -0.3), new THREE.Vector3(0.5, 0.6, 0.12), new THREE.Euler(-0.22, 0, 0));
  }
  B.box(B.group(M.seat, null), at(0, 0.55, -0.95), new THREE.Vector3(1.3, 0.12, 0.5));
  B.box(B.group(M.seat, null), at(0, 0.82, -1.2), new THREE.Vector3(1.3, 0.5, 0.12), new THREE.Euler(-0.2, 0, 0));
  { // steering wheel: 8-sided rim + hub + spoke, tilted towards the driver
    const g = B.group(M.interior, null, null, 'steer'), c = at(0.37, 0.98, 0.42), tilt = new THREE.Euler(-0.5, 0, 0), R = 0.19;
    for (let k = 0; k < 8; k++) {
      const t0 = (k / 8) * Math.PI * 2, t1 = ((k + 1) / 8) * Math.PI * 2;
      const p = (t, r, dz) => new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, dz).applyEuler(tilt).add(c);
      for (const [r0, r1, d0, d1] of [[R, R, -0.015, 0.015], [R - 0.03, R - 0.03, 0.015, -0.015], [R, R - 0.03, 0.015, 0.015], [R - 0.03, R, -0.015, -0.015]]) {
        B.tri(g, p(t0, r0, d0), p(t1, r0, d0), p(t1, r1, d1)); B.tri(g, p(t0, r0, d0), p(t1, r1, d1), p(t0, r1, d1));
      }
    }
    B.box(g, c, new THREE.Vector3(0.12, 0.12, 0.05), tilt);
    for (const ang of [Math.PI / 2, -Math.PI / 2, Math.PI]) B.box(g, c.clone().add(new THREE.Vector3(Math.cos(ang) * 0.1, Math.sin(ang) * 0.1, 0).applyEuler(tilt)), new THREE.Vector3(Math.abs(Math.cos(ang)) * 0.12 + 0.03, Math.abs(Math.sin(ang)) * 0.12 + 0.03, 0.02), tilt);
  }

  const bodyParts = B.geometries();

  // ---- bounds, lattice binding, part boxes, a depth pre-pass, surface samples (for the collision shell)
  const bounds = new THREE.Box3();
  for (const p of bodyParts) bounds.union(p.geo.boundingBox);
  bounds.expandByScalar(0.02);
  const refSB = new SoftBody(bounds.min, bounds.max, CORE);
  for (const p of bodyParts) bindGeometry(THREE, p.geo, refSB);
  const partInfo = {};
  for (const p of bodyParts) if (p.part) (partInfo[p.part] ||= new THREE.Box3()).union(p.geo.boundingBox);
  const samples = [];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  for (const p of bodyParts) {
    if (p.mat === M.interior || p.mat === M.seat || p.tag) continue;
    const pos = p.geo.attributes.position.array;
    for (let t = 0; t < pos.length; t += 9) {
      _a.fromArray(pos, t); _b.fromArray(pos, t + 3); _c.fromArray(pos, t + 6);
      const n = Math.max(1, Math.round(_b.distanceTo(_a) / 0.06)), m = Math.max(1, Math.round(_c.distanceTo(_a) / 0.06));
      for (let u = 0; u <= n; u++) for (let v = 0; v <= m - (u * m) / n; v++) {
        const s = u / n, w = v / m;
        if (s + w > 1) continue;
        samples.push(_a.x + (_b.x - _a.x) * s + (_c.x - _a.x) * w, _a.y + (_b.y - _a.y) * s + (_c.y - _a.y) * w, _a.z + (_b.z - _a.z) * s + (_c.z - _a.z) * w);
      }
    }
  }

  // ---- wheels: 16-sided tyre, dished rim with five double spokes, centre cap, caliper (car frame axis x, centred)
  const wheelParts = {};
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const out = k[1] === 'L' ? 1 : -1, W = new Builder();
    const ring = (g, r, x0, x1, n, ph = 0) => {
      for (let i = 0; i < n; i++) {
        const t0 = ph + (i / n) * Math.PI * 2, t1 = ph + ((i + 1) / n) * Math.PI * 2;
        const q = (x, t) => new THREE.Vector3(x, Math.cos(t) * r, Math.sin(t) * r);
        if (out * (x1 - x0) > 0) { W.tri(g, q(x0, t0), q(x0, t1), q(x1, t1)); W.tri(g, q(x0, t0), q(x1, t1), q(x1, t0)); }
        else { W.tri(g, q(x0, t0), q(x1, t1), q(x0, t1)); W.tri(g, q(x0, t0), q(x1, t0), q(x1, t1)); }
      }
    };
    const disc = (g, r, x, n, facing, ph = 0) => {
      for (let i = 0; i < n; i++) {
        const t0 = ph + (i / n) * Math.PI * 2, t1 = ph + ((i + 1) / n) * Math.PI * 2;
        const q = (t) => new THREE.Vector3(x, Math.cos(t) * r, Math.sin(t) * r), c = new THREE.Vector3(x, 0, 0);
        facing > 0 ? W.tri(g, c, q(t0), q(t1)) : W.tri(g, c, q(t1), q(t0));
      }
    };
    const tw = 0.1125, tyre = W.group(M.tyre), rim = W.group(M.rim), rr = P.wheelR - 0.085;
    ring(tyre, P.wheelR, -tw * out, tw * out, 16); // tread
    ring(tyre, P.wheelR - 0.012, tw * out, tw * out * 1.04, 16); // sidewall bulge
    const annulus = (g, r0, r1, x, n, facing) => { // flat ring: the sidewall, leaving the rim visible
      for (let i = 0; i < n; i++) {
        const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2, q = (r, t) => new THREE.Vector3(x, Math.cos(t) * r, Math.sin(t) * r);
        if (facing > 0) { W.tri(g, q(r0, t0), q(r1, t0), q(r1, t1)); W.tri(g, q(r0, t0), q(r1, t1), q(r0, t1)); }
        else { W.tri(g, q(r0, t0), q(r1, t1), q(r1, t0)); W.tri(g, q(r0, t0), q(r0, t1), q(r1, t1)); }
      }
    };
    annulus(tyre, rr, P.wheelR, tw * out * 1.04, 16, out); disc(tyre, P.wheelR, -tw * out, 16, -out);
    ring(rim, rr, tw * out * 1.05, tw * out * 0.7, 16); // rim lip, dished in
    disc(W.group(M.grille), rr, tw * out * 0.55, 16, out); // dark barrel behind the spokes
    for (let s5 = 0; s5 < 5; s5++) for (const off of [-0.11, 0.11]) { // five double spokes
      const t = (s5 / 5) * Math.PI * 2 + off;
      W.box(rim, new THREE.Vector3(tw * out * 0.8, Math.cos(t) * rr * 0.5, Math.sin(t) * rr * 0.5), new THREE.Vector3(0.03, 0.028, rr * 0.95), new THREE.Euler(t - Math.PI / 2, 0, 0));
    }
    disc(rim, 0.055, tw * out * 0.92, 10, out); // centre cap
    const spin = W.geometries();
    const C = new Builder();
    C.box(C.group(M.caliper), new THREE.Vector3(out * 0.04, 0.1, 0.12), new THREE.Vector3(0.05, 0.09, 0.11));
    wheelParts[k] = { spin, cal: C.geometries(), prepass: null };
  }

  const meta = { wheelR: P.wheelR, wheelbase: P.wheelbase, tris: bodyParts.reduce((s, p) => s + p.geo.index.count / 3, 0), lowpoly: true };
  return { bodyParts, prepass: null, spots, wheelParts, meta, bounds, partInfo, samples: new Float32Array(samples) };
}
