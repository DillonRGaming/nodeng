// A Japanese mountain pass (touge): a forested mountain, and one long, twisting two-lane road looping
// round it - climbing, switching back, dropping. The road is cut into the terrain (the ground under
// and beside it is flattened to the road, then blends back into the hillside), its height follows the
// mountain but smoothed and grade-limited, and guardrails run wherever it's on a drop.
// Builds a height field (used by the physics for everything), the terrain, road, rails and forest
// meshes, an AI route, and the guardrail colliders.
import * as THREE from 'three';
import { setHeightField } from './physics.js';

const EXT = 900, CELL = 2; // physics height field: +-900 m at 2 m
const ROAD_HALF = 3.6, FLAT = 5.2, BLEND = 18; // carriageway half width, flattened half width, blend to hillside
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// value noise + fbm (ridged for mountain spines)
const R = rng(5), PERM = new Float32Array(4096).map(() => R());
const hash = (x, z) => PERM[((x * 73856093) ^ (z * 19349663)) & 4095];
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function baseHeight(x, z) {
  const d = Math.hypot(x, z);
  let h = 165 * Math.exp(-((d / 360) ** 2)); // the main mountain
  let amp = 1, f = 1 / 240, ridge = 0;
  for (let o = 0; o < 5; o++) { const n = 1 - Math.abs(vnoise(x * f + 31 * o, z * f - 17 * o) * 2 - 1); ridge += n * n * amp; amp *= 0.5; f *= 2.05; }
  h += ridge * 55 - 20;
  h += Math.max(0, d - 620) * 0.55 + Math.max(0, d - 760) * 0.8; // ring of higher peaks closing the valley in
  return Math.max(0, h);
}

// the road: a closed polar loop round the mountain - lobes climb towards the summit and drop away
function roadCentre(t) {
  const a = t * Math.PI * 2;
  const r = 330 + 150 * Math.sin(3 * a + 0.4) + 45 * Math.sin(7 * a + 1.3) + 18 * Math.sin(13 * a);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

export function buildMountain(scene, { grassTex } = {}) {
  // ---- road samples every ~1.5 m
  const raw = [];
  for (let i = 0; i < 6000; i++) raw.push(roadCentre(i / 6000));
  const pts = [];
  let acc = 0;
  pts.push({ x: raw[0][0], z: raw[0][1] });
  for (let i = 1; i <= raw.length; i++) {
    const [x, z] = raw[i % raw.length], p = pts[pts.length - 1];
    acc = Math.hypot(x - p.x, z - p.z);
    if (acc >= 1.5) pts.push({ x, z });
  }
  const n = pts.length, step = 1.5;
  // heading, curvature
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
    let dh = h2 - h1; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.heading = h2; b.k = Math.abs(dh) / step;
  }
  // road height: the terrain along the line, smoothed (+-45 m) and grade-limited (max 9 %)
  const tH = pts.map((p) => baseHeight(p.x, p.z));
  const W = 30;
  let rh = pts.map((_, i) => { let s = 0; for (let k = -W; k <= W; k++) s += tH[(i + k + n) % n]; return s / (2 * W + 1); });
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < n * 2; i++) { const a = (i - 1) % n, b = i % n; rh[b] = Math.min(rh[b], rh[a] + 0.09 * step); rh[b] = Math.max(rh[b], rh[a] - 0.09 * step); }
  }
  pts.forEach((p, i) => (p.y = rh[i]));

  // ---- height field: base terrain, then stamp the road in (nearest road sample wins)
  const N = (2 * EXT) / CELL + 1, H = new Float32Array(N * N), D = new Float32Array(N * N).fill(1e9), RH = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = baseHeight(-EXT + i * CELL, -EXT + j * CELL);
  const reach = FLAT + BLEND, rc = Math.ceil(reach / CELL);
  for (const p of pts) {
    const ci = Math.round((p.x + EXT) / CELL), cj = Math.round((p.z + EXT) / CELL);
    for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const x = -EXT + i * CELL, z = -EXT + j * CELL, d = Math.hypot(x - p.x, z - p.z), k = j * N + i;
      if (d < D[k]) { D[k] = d; RH[k] = p.y; }
    }
  }
  for (let k = 0; k < N * N; k++) {
    if (D[k] > reach) continue;
    const t = Math.min(1, Math.max(0, (D[k] - FLAT) / BLEND)), s = t * t * (3 - 2 * t);
    H[k] = RH[k] + (H[k] - RH[k]) * s;
  }
  setHeightField({ H, N, ext: EXT, cell: CELL });
  const hAt = (x, z) => { // same bilinear lookup as the physics
    const fx = (x + EXT) / CELL, fz = (z + EXT) / CELL, i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fz))), u = fx - i, v = fz - j;
    return H[j * N + i] * (1 - u) * (1 - v) + H[j * N + i + 1] * u * (1 - v) + H[(j + 1) * N + i] * (1 - u) * v + H[(j + 1) * N + i + 1] * u * v;
  };

  // ---- terrain mesh: 6 m grid, coloured by slope (forest floor / grass / rock), mottled texture
  const TS = 6, TN = (2 * EXT) / TS + 1, pos = new Float32Array(TN * TN * 3), uv = new Float32Array(TN * TN * 2), col = new Float32Array(TN * TN * 3), idx = [];
  // tints multiplied onto the grass texture (so near-white): open grass, darker forest floor higher up, pale rock on steep faces
  const cGrass = new THREE.Color(1.15, 1.15, 1.05), cForest = new THREE.Color(0.85, 0.92, 0.8), cRock = new THREE.Color(1.6, 1.45, 1.35), c = new THREE.Color();
  for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const x = -EXT + i * TS, z = -EXT + j * TS, y = hAt(x, z), k = j * TN + i;
    pos.set([x, y, z], k * 3); uv.set([x / 24, z / 24], k * 2);
    const slope = Math.hypot(hAt(x + 2, z) - hAt(x - 2, z), hAt(x, z + 2) - hAt(x, z - 2)) / 4;
    c.copy(cGrass).lerp(cForest, Math.min(1, y / 60)).lerp(cRock, Math.min(1, Math.max(0, (slope - 0.7) / 0.5)));
    col.set([c.r, c.g, c.b], k * 3);
  }
  for (let j = 0; j < TN - 1; j++) for (let i = 0; i < TN - 1; i++) { const a = j * TN + i, b = a + 1, d = a + TN, e = d + 1; idx.push(a, d, b, b, d, e); }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tg.setIndex(idx); tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ map: grassTex, vertexColors: true, roughness: 0.95, envMapIntensity: 0.35 }));
  terrain.receiveShadow = true; scene.add(terrain);

  // ---- road ribbon + markings (white edge lines, solid yellow centre: no overtaking on the pass)
  const ribbon = (o0, o1, lift, color, keep = () => true) => {
    const P = [];
    const at = (p, o) => { const x = p.x + Math.cos(p.heading) * o, z = p.z - Math.sin(p.heading) * o; return [x, p.y + lift, z]; };
    for (let i = 0; i < n; i++) {
      if (!keep(i)) continue;
      const p = pts[i], q = pts[(i + 1) % n];
      P.push(...at(p, o0), ...at(q, o1), ...at(p, o1), ...at(p, o0), ...at(q, o0), ...at(q, o1));
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
    m.receiveShadow = true; scene.add(m); return m;
  };
  ribbon(-ROAD_HALF - 0.6, ROAD_HALF + 0.6, 0.03, 0x4a4c50);
  for (const s of [-1, 1]) ribbon(s * (ROAD_HALF - 0.25), s * (ROAD_HALF - 0.1), 0.045, 0xd8d8d2);
  ribbon(-0.2, -0.08, 0.045, 0xd9a62a); ribbon(0.08, 0.2, 0.045, 0xd9a62a);

  // ---- guardrails: on whichever side the hillside falls away; galvanised W-beam on posts, solid
  const obstacles = [], railPos = [], postPos = [];
  for (let i = 0; i < n; i += 3) {
    const p = pts[i];
    for (const s of [-1, 1]) {
      const ox = Math.cos(p.heading) * s, oz = -Math.sin(p.heading) * s;
      const drop = p.y - baseHeight(p.x + ox * 14, p.z + oz * 14);
      if (drop < 2.5) continue;
      const e = ROAD_HALF + 0.9, x = p.x + ox * e, z = p.z + oz * e;
      railPos.push([x, p.y, z, p.heading]);
      if ((i / 3) % 2 === 0) postPos.push([x, p.y, z]);
      obstacles.push({ x, z, hx: 0.12, hz: 2.4, h: 0.8, yaw: p.heading, kind: "rail" }); // short boxes along the road edge
    }
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), S = new THREE.Vector3(1, 1, 1), P3 = new THREE.Vector3();
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.32, 4.6).translate(0, 0.62, 0), new THREE.MeshStandardMaterial({ color: 0xc7cbcf, metalness: 0.7, roughness: 0.35 }), railPos.length);
  railPos.forEach(([x, y, z, h], k) => { q.setFromAxisAngle(up, h); rails.setMatrixAt(k, m4.compose(P3.set(x, y, z), q, S)); });
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6).translate(0, 0.45, 0), new THREE.MeshStandardMaterial({ color: 0xa9adb1, metalness: 0.6, roughness: 0.45 }), postPos.length);
  postPos.forEach(([x, y, z], k) => posts.setMatrixAt(k, m4.compose(P3.set(x, y, z), q.identity(), S)));
  rails.castShadow = posts.castShadow = true;
  scene.add(rails, posts);

  // ---- forest: tall narrow cedars (sugi) + a few broadleaf, kept off the road
  const r = rng(9), cedars = [], broad = [];
  for (let t = 0; t < 14000 && cedars.length + broad.length < 5200; t++) {
    const x = (r() * 2 - 1) * (EXT - 20), z = (r() * 2 - 1) * (EXT - 20);
    const fi = Math.round((x + EXT) / CELL), fj = Math.round((z + EXT) / CELL);
    if (D[fj * N + fi] < FLAT + 4) continue; // not on (or right beside) the road
    const y = hAt(x, z), slope = Math.hypot(hAt(x + 2, z) - hAt(x - 2, z), hAt(x, z + 2) - hAt(x, z - 2)) / 4;
    if (slope > 1.1 || y > 250) continue;
    (r() < 0.82 ? cedars : broad).push([x, y, z, 0.8 + r() * 0.7]);
  }
  const cedarGeo = new THREE.ConeGeometry(1.6, 9, 6).translate(0, 7.5, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 3.5, 5).translate(0, 1.75, 0);
  const broadGeo = new THREE.IcosahedronGeometry(2.6, 0).translate(0, 4.2, 0);
  const mk = (geo, color, list, rough = 0.9) => {
    const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: rough }), list.length);
    list.forEach(([x, y, z, s], k) => { q.setFromAxisAngle(up, r() * 6.28); im.setMatrixAt(k, m4.compose(P3.set(x, y - 0.3, z), q, S.set(s, s * (0.9 + r() * 0.3), s))); im.setColorAt(k, c.set(color).multiplyScalar(0.8 + r() * 0.35)); });
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; scene.add(im); S.set(1, 1, 1); return im;
  };
  mk(cedarGeo, 0x456a42, cedars); mk(trunkGeo, 0x5a4232, [...cedars, ...broad]); mk(broadGeo, 0x6a8045, broad);
  // trunks near the road are solid (leaving the road into the trees hurts)
  for (const [x, , z, s] of [...cedars, ...broad]) {
    const fi = Math.round((x + EXT) / CELL), fj = Math.round((z + EXT) / CELL);
    if (D[fj * N + fi] < 40) obstacles.push({ x, z, r: 0.28 * s, h: 4 });
  }

  return { route: { pts: pts.map((p) => ({ x: p.x, z: p.z, k: p.k, heading: p.heading })), step }, obstacles, start: pts[0] };
}
