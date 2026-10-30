// Low-poly countryside filling the blocks between the roads: villages (houses with pitched roofs,
// gardens, hedges), farms (striped fields, a barn, a greenhouse), forests (pines + autumn trees) and
// parks (a pond ringed with trees). Flat shaded, warm palette. Everything static is merged into a
// couple of vertex-coloured meshes and the trees are instanced, so it costs a handful of draw calls.
// Returns the solid obstacles (house boxes, tree trunks) for the collision system.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const PAL = {
  // natural, slightly dusty tones: weathered render and brick, clay / slate roofs, dry fields
  wall: [0xcfc4ad, 0xc4b493, 0xd8d1c2, 0xb9a585, 0xc9b294],
  roof: [0x9a5a3a, 0x8a4a35, 0x7a3f30, 0x4f5a4a, 0x5e5550, 0xa0703f],
  field: [0x8c9650, 0x77864a, 0xa69a5c, 0x6f7f45, 0x9c9a62],
  green: [0x4f6f35, 0x5c7a3a, 0x687f42, 0x56703a],
  autumn: [0xb08a3e, 0xa86a34, 0x9a5434, 0xb59a4c],
  pine: [0x2c4a32, 0x34553a, 0x29432f],
};
const pick = (r, a) => a[Math.floor(r() * a.length)];

export function buildCountryside(scene, T, { exclude = () => false, seed = 11 } = {}) {
  const r = rng(seed), geos = [], obstacles = [], trees = [];
  const col = new THREE.Color();
  const add = (g, color) => { // non-indexed + per-vertex colour, merged later
    g = g.index ? g.toNonIndexed() : g;
    col.set(color);
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'color' && k !== 'normal') g.deleteAttribute(k);
    geos.push(g);
  };
  const box = (x, y, z, sx, sy, sz, color, yaw = 0) => add(new THREE.BoxGeometry(sx, sy, sz).rotateY(yaw).translate(x, y + sy / 2, z), color);

  // ---- a house: walls, two-pitch roof with overhang, windows, door, chimney; yaw faces its road
  const house = (x, z, yaw, big = false) => {
    const w = big ? 12 + r() * 4 : 6 + r() * 3, d = big ? 9 + r() * 3 : 6 + r() * 2.5, h = big ? 5 + r() : 2.8 + r() * 1.6, rh = 1.6 + r() * 1.4;
    const wall = pick(r, PAL.wall), roof = big ? pick(r, [0xb84a2a, 0x8a3a2a]) : pick(r, PAL.roof);
    const c = Math.cos(yaw), s = Math.sin(yaw), at = (lx, lz) => [x + c * lx + s * lz, z - s * lx + c * lz];
    box(x, 0, z, w, h, d, wall, yaw);
    const sh = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.4, 0), new THREE.Vector2(w / 2 + 0.4, 0), new THREE.Vector2(0, rh)]);
    add(new THREE.ExtrudeGeometry(sh, { depth: d + 0.8, bevelEnabled: false }).translate(0, h, -d / 2 - 0.4).rotateY(yaw).translate(x, 0, z), roof);
    // windows on the road side + a door
    const nW = Math.max(2, Math.floor(w / 2.4));
    for (let k = 0; k < nW; k++) {
      const lx = -w / 2 + (w / (nW + 1)) * (k + 1), [wx, wz] = at(lx, d / 2 + 0.03);
      if (k === Math.floor(nW / 2) && !big) box(wx, 0, wz, 1.0, 2.1, 0.08, 0x6b4a2f, yaw);
      else box(wx, h * 0.45, wz, 0.9, 1.0, 0.08, 0x3d5568, yaw);
    }
    if (big) { const [bx, bz] = at(0, d / 2 + 0.05); box(bx, 0, bz, 3.6, 3.4, 0.1, 0x6b3a26, yaw); } // barn doors
    else if (r() < 0.7) { const [cx, cz] = at(w * 0.25, -d * 0.1); box(cx, h + rh * 0.4, cz, 0.6, rh * 0.9, 0.6, 0x8a4a3a, yaw); } // chimney
    obstacles.push({ x, z, hx: (Math.abs(c) * w + Math.abs(s) * d) / 2, hz: (Math.abs(s) * w + Math.abs(c) * d) / 2, h: h + rh, yaw: 0, kind: 'house' });
  };
  const tree = (x, z, kind, s = 0.7 + r() * 0.7) => {
    trees.push({ x, z, kind, s, color: kind === 'pine' ? pick(r, PAL.pine) : r() < 0.45 ? pick(r, PAL.autumn) : pick(r, PAL.green) });
    obstacles.push({ x, z, r: 0.22 * s + 0.05, h: 3 });
  };
  const hedge = (x0, z0, x1, z1) => { const L = Math.hypot(x1 - x0, z1 - z0); box((x0 + x1) / 2, 0, (z0 + z1) / 2, 0.9, 1.0, L, 0x3f5f2f, Math.atan2(x1 - x0, z1 - z0)); };

  const W = T.roadW / 2, inset = W + T.walkW + 1.2;
  const blocks = [];
  for (let i = 0; i < T.gridX.length - 1; i++) for (let k = 0; k < T.gridZ.length - 1; k++) {
    if (exclude(i, k)) continue;
    blocks.push({ i, k, x0: T.gridX[i] + inset, x1: T.gridX[i + 1] - inset, z0: T.gridZ[k] + inset, z1: T.gridZ[k + 1] - inset });
  }
  const kinds = ['village', 'village', 'farm', 'forest', 'park', 'village', 'farm', 'forest'];
  blocks.forEach((b, bi) => {
    const kind = kinds[bi % kinds.length], bw = b.x1 - b.x0, bd = b.z1 - b.z0;
    if (kind === 'village') {
      // houses along each edge, facing the road, gardens behind with trees; hedges between lots
      const lot = 15;
      for (const side of ['n', 's', 'e', 'w']) {
        const along = side === 'n' || side === 's' ? bw : bd, n = Math.floor(along / lot);
        for (let q = 0; q < n; q++) {
          if (r() < 0.25) continue;
          const t = (q + 0.5) / n;
          let x, z, yaw;
          if (side === 'n') { x = b.x0 + t * bw; z = b.z1 - 6; yaw = 0; }
          else if (side === 's') { x = b.x0 + t * bw; z = b.z0 + 6; yaw = Math.PI; }
          else if (side === 'e') { x = b.x1 - 6; z = b.z0 + t * bd; yaw = Math.PI / 2; }
          else { x = b.x0 + 6; z = b.z0 + t * bd; yaw = -Math.PI / 2; }
          if ((side === 'e' || side === 'w') && (z < b.z0 + 14 || z > b.z1 - 14)) continue; // corners are taken by the n/s rows
          house(x, z, yaw);
          if (r() < 0.6) tree(x + (r() - 0.5) * 8, z + (r() - 0.5) * 8 - (side === 'n' ? 6 : side === 's' ? -6 : 0), r() < 0.3 ? 'pine' : 'round');
        }
      }
      // the middle: gardens, a few trees, hedged plots
      for (let g = 0; g < Math.floor(bw * bd / 260); g++) tree(b.x0 + 16 + r() * (bw - 32), b.z0 + 16 + r() * (bd - 32), r() < 0.35 ? 'pine' : 'round');
      hedge(b.x0 + 14, (b.z0 + b.z1) / 2, b.x1 - 14, (b.z0 + b.z1) / 2);
    } else if (kind === 'farm') {
      // striped fields, a farmhouse + barn in a corner, a greenhouse
      const fx0 = b.x0 + 18, fz0 = b.z0 + 2, fx1 = b.x1 - 2, fz1 = b.z1 - 2;
      let x = fx0; const horiz = bw > bd;
      while (x < fx1 - 3) {
        const sw = 6 + r() * 6, xe = Math.min(fx1, x + sw), color = pick(r, PAL.field);
        add(new THREE.PlaneGeometry(xe - x - 0.6, fz1 - fz0 - 0.6).rotateX(-Math.PI / 2).translate((x + xe) / 2, 0.03, (fz0 + fz1) / 2), color);
        for (let rr = fz0 + 1.5; rr < fz1 - 1; rr += 2.2) add(new THREE.PlaneGeometry(xe - x - 1.2, 0.35).rotateX(-Math.PI / 2).translate((x + xe) / 2, 0.035, rr), new THREE.Color(color).multiplyScalar(0.85).getHex()); // furrows
        x = xe;
      }
      void horiz;
      house(b.x0 + 9, b.z0 + 12, -Math.PI / 2);
      house(b.x0 + 9, b.z1 - 14, -Math.PI / 2, true);
      // greenhouse: pale translucent-looking box with a ridge
      const gx = b.x0 + 9, gz = (b.z0 + b.z1) / 2;
      box(gx, 0, gz, 5, 2.4, 10, 0xaebdb9); add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-2.5, 0), new THREE.Vector2(2.5, 0), new THREE.Vector2(0, 1.2)]), { depth: 10, bevelEnabled: false }).translate(0, 2.4, -5).translate(gx, 0, gz), 0xe2efec);
      obstacles.push({ x: gx, z: gz, hx: 2.5, hz: 5, h: 3.6, yaw: 0, kind: 'house' });
      for (let q = 0; q < 6; q++) tree(b.x0 + 3 + r() * 10, b.z0 + 24 + r() * (bd - 50), 'round');
    } else if (kind === 'forest') {
      for (let x = b.x0 + 2; x < b.x1 - 2; x += 4.5) for (let z = b.z0 + 2; z < b.z1 - 2; z += 4.5) {
        if (r() < 0.25) continue;
        tree(x + (r() - 0.5) * 3, z + (r() - 0.5) * 3, r() < 0.7 ? 'pine' : 'round', 0.8 + r() * 0.8);
      }
    } else { // park with a pond
      const px = (b.x0 + b.x1) / 2, pz = (b.z0 + b.z1) / 2, pr = Math.min(bw, bd) * 0.22;
      const pond = new THREE.CircleGeometry(pr, 14).rotateX(-Math.PI / 2);
      const p = pond.attributes.position; for (let q = 1; q < p.count; q++) { const f = 0.8 + r() * 0.35; p.setX(q, p.getX(q) * f * 1.4); p.setZ(q, p.getZ(q) * f); } // irregular, oval
      add(pond.translate(px, 0.04, pz), 0x3d5f68);
      add(new THREE.CircleGeometry(pr * 1.08, 14).rotateX(-Math.PI / 2).scale(1.4, 1, 1).translate(px, 0.03, pz), 0x9c9070); // muddy bank
      for (let q = 0; q < 26; q++) { const a = r() * 6.283, d = pr * (1.6 + r() * 1.1); tree(px + Math.cos(a) * d * 1.4, pz + Math.sin(a) * d, r() < 0.3 ? 'pine' : 'round'); }
      for (let q = 0; q < 3; q++) { const a = r() * 6.283; box(px + Math.cos(a) * pr * 1.9, 0, pz + Math.sin(a) * pr * 1.3, 1.6, 0.5, 0.5, 0x8a5a3a, a); } // benches
    }
  });
  // a ring of forest round the whole grid
  const gx0 = T.gridX[0] - 14, gx1 = T.gridX[T.gridX.length - 1] + 14, gz0 = T.gridZ[0] - 14, gz1 = T.gridZ[T.gridZ.length - 1] + 14;
  for (let q = 0; q < 900; q++) {
    const a = r(), band = 10 + r() * 50;
    let x, z;
    if (q % 4 === 0) { x = gx0 + a * (gx1 - gx0); z = gz0 - band; } else if (q % 4 === 1) { x = gx0 + a * (gx1 - gx0); z = gz1 + band; }
    else if (q % 4 === 2) { x = gx0 - band; z = gz0 + a * (gz1 - gz0); } else { x = gx1 + band; z = gz0 + a * (gz1 - gz0); }
    trees.push({ x, z, kind: r() < 0.65 ? 'pine' : 'round', s: 0.8 + r() * 0.9, color: 0 });
    const t = trees[trees.length - 1]; t.color = t.kind === 'pine' ? pick(r, PAL.pine) : r() < 0.45 ? pick(r, PAL.autumn) : pick(r, PAL.green);
  }

  // ---- build: merged static scenery
  const merged = mergeGeometries(geos, false);
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, envMapIntensity: 0.5 }));
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  // ---- trees, instanced: pines (three stacked cones), round crowns (lumpy icosahedron), trunks
  const jit = (g, a) => { const p = g.attributes.position, m = new Map(); for (let i = 0; i < p.count; i++) { const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`; if (!m.has(k)) m.set(k, [(r() - 0.5) * a, (r() - 0.5) * a, (r() - 0.5) * a]); const d = m.get(k); p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]); } g.computeVertexNormals(); return g; };
  const pineGeo = mergeGeometries([[2.0, 3.0, 2.4], [1.55, 2.6, 3.9], [1.0, 2.2, 5.2]].map(([rad, hh, y]) => new THREE.ConeGeometry(rad, hh, 7).translate(0, y, 0).toNonIndexed()));
  const roundGeo = jit(new THREE.IcosahedronGeometry(2.1, 0).translate(0, 3.6, 0).toNonIndexed(), 0.35);
  const mat = () => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
  const pines = trees.filter((t) => t.kind === 'pine'), rounds = trees.filter((t) => t.kind !== 'pine');
  const pineM = new THREE.InstancedMesh(pineGeo, mat(), pines.length), roundM = new THREE.InstancedMesh(roundGeo, mat(), rounds.length);
  const trunkM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.26, 2.2, 6).translate(0, 1.1, 0), new THREE.MeshStandardMaterial({ color: 0x6b4a33, flatShading: true }), trees.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), S = new THREE.Vector3(), P = new THREE.Vector3();
  const place = (im, list) => list.forEach((t, i) => { q.setFromAxisAngle(up, r() * 6.28); im.setMatrixAt(i, m4.compose(P.set(t.x, 0, t.z), q, S.set(t.s, t.s, t.s))); im.setColorAt(i, col.set(t.color)); });
  place(pineM, pines); place(roundM, rounds);
  trees.forEach((t, i) => trunkM.setMatrixAt(i, m4.compose(P.set(t.x, 0, t.z), q.identity(), S.set(t.s, t.s, t.s))));
  for (const im of [pineM, roundM, trunkM]) { im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; scene.add(im); }
  return { obstacles };
}
