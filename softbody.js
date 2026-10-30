import { DMG_GLSL } from './damageSkin.js';

// Node-beam soft body for the car shell, BeamNG-style but lighter: a lattice of nodes filling the
// body, joined by beams to their neighbours. Collisions push nodes; beams spread the push to their
// neighbours, bend permanently (plastic rest-length) and snap when torn. The cabin core is rigid.
// The render mesh is bound to the lattice (trilinear weights per vertex) and deformed on the GPU,
// so the body always stays smooth — panels bend, they don't shred.
// All positions are in the car's local frame (origin at the centre of gravity).

const NX = 9, NY = 7, NZ = 20; // fine enough that dents stay local and panels fold instead of shearing as blocks
// passenger cell (rigid), in the car frame around the CG
export const CORE = { x: 0.5, yLo: -0.3, yHi: 0.75, zR: -1.15, zF: 0.85 };
const YIELD = 0.004; // strain before a beam deforms permanently
const BREAK = 0.45; // stretch strain that snaps a beam
const STIFF = 0.35; // fraction of beam error corrected per pass (lower = more local dents)

export class SoftBody {
  constructor(min, max, core) {
    this.min = min; this.max = max;
    this.n = [NX, NY, NZ];
    this.size = [(max.x - min.x) / (NX - 1), (max.y - min.y) / (NY - 1), (max.z - min.z) / (NZ - 1)];
    const N = NX * NY * NZ;
    this.N = N;
    this.rest = new Float32Array(N * 3);
    this.x = new Float32Array(N * 3);
    this.pinned = new Uint8Array(N);
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const id = this.id(i, j, k);
      const px = min.x + i * this.size[0], py = min.y + j * this.size[1], pz = min.z + k * this.size[2];
      this.rest.set([px, py, pz], id * 3);
      // passenger cell: strong cage that does not crush
      if (Math.abs(px) <= core.x && py >= core.yLo && py <= core.yHi && pz >= core.zR && pz <= core.zF) this.pinned[id] = 1;
    }
    this.x.set(this.rest);
    // beams to all 26 neighbours (each pair once)
    const a = [], b = [];
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++)
      for (let dk = 0; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (dk === 0 && (dj < 0 || (dj === 0 && di <= 0))) continue;
        const i2 = i + di, j2 = j + dj, k2 = k + dk;
        if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= NX || j2 >= NY || k2 >= NZ) continue;
        a.push(this.id(i, j, k)); b.push(this.id(i2, j2, k2));
      }
    this.ba = Int32Array.from(a); this.bb = Int32Array.from(b);
    this.L0 = new Float32Array(a.length); // original lengths
    for (let e = 0; e < a.length; e++) this.L0[e] = this.dist(this.rest, a[e], b[e]);
    this.L = Float32Array.from(this.L0); // plastic rest lengths
    this.alive = new Uint8Array(a.length).fill(1);
    this.dirty = true; this.active = 0;
    // GPU: displacement per node, read by the vertex shader
    this.tex = null; this.texData = new Float32Array(N * 4);
    this.uniforms = null;
  }
  id(i, j, k) { return i + NX * (j + NY * k); }
  dist(arr, p, q) { const dx = arr[p * 3] - arr[q * 3], dy = arr[p * 3 + 1] - arr[q * 3 + 1], dz = arr[p * 3 + 2] - arr[q * 3 + 2]; return Math.sqrt(dx * dx + dy * dy + dz * dz); }

  // lattice coordinates of a rest-frame point: cell index + fractional position (may extrapolate a little)
  coords(x, y, z) {
    const u = [(x - this.min.x) / this.size[0], (y - this.min.y) / this.size[1], (z - this.min.z) / this.size[2]];
    const c = [0, 0, 0], f = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      c[a] = Math.max(0, Math.min(this.n[a] - 2, Math.floor(u[a])));
      f[a] = Math.max(-0.5, Math.min(1.5, u[a] - c[a]));
    }
    return { c, f };
  }
  // displacement at lattice coords (trilinear), written to out[o..o+2]
  dispAt(c, f, out, o = 0) {
    out[o] = out[o + 1] = out[o + 2] = 0;
    for (let dk = 0; dk <= 1; dk++) for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      const w = (di ? f[0] : 1 - f[0]) * (dj ? f[1] : 1 - f[1]) * (dk ? f[2] : 1 - f[2]);
      const id = this.id(c[0] + di, c[1] + dj, c[2] + dk) * 3;
      out[o] += w * (this.x[id] - this.rest[id]); out[o + 1] += w * (this.x[id + 1] - this.rest[id + 1]); out[o + 2] += w * (this.x[id + 2] - this.rest[id + 2]);
    }
    return out;
  }
  // move the lattice so the point at (c, f) moves by (dx, dy, dz): spread over its 8 nodes by weight
  push(c, f, dx, dy, dz) {
    let ws = 0;
    const W = [];
    for (let dk = 0; dk <= 1; dk++) for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
      const id = this.id(c[0] + di, c[1] + dj, c[2] + dk);
      const w = this.pinned[id] ? 0 : (di ? f[0] : 1 - f[0]) * (dj ? f[1] : 1 - f[1]) * (dk ? f[2] : 1 - f[2]);
      W.push(id, w); ws += w * w;
    }
    if (ws < 1e-6) return;
    for (let q = 0; q < 16; q += 2) {
      const id = W[q] * 3, s = W[q + 1] / ws;
      this.x[id] += dx * s; this.x[id + 1] += dy * s; this.x[id + 2] += dz * s;
    }
    this.dirty = true; this.active = 0.4; this.damaged = true;
  }

  // relax beams: pull neighbours along (that is how a dent spreads), then let the metal take a set
  relax(iters = 4) {
    const x = this.x, A = this.ba, B = this.bb, L = this.L, P = this.pinned;
    for (let it = 0; it < iters; it++) {
      for (let e = 0; e < A.length; e++) {
        if (!this.alive[e]) continue;
        const p = A[e] * 3, q = B[e] * 3;
        const dx = x[q] - x[p], dy = x[q + 1] - x[p + 1], dz = x[q + 2] - x[p + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = (len - L[e]) / len;
        const wp = P[A[e]] ? 0 : 1, wq = P[B[e]] ? 0 : 1;
        if (wp + wq === 0) continue;
        const s = (0.5 * diff * STIFF) / ((wp + wq) * 0.5);
        x[p] += dx * s * wp; x[p + 1] += dy * s * wp; x[p + 2] += dz * s * wp;
        x[q] -= dx * s * wq; x[q + 1] -= dy * s * wq; x[q + 2] -= dz * s * wq;
      }
    }
    // smooth the displacement field a little: sheet metal bends in curves, not in lattice-cell kinks
    if (!this.dTmp) this.dTmp = new Float32Array(this.N * 3);
    const D = this.dTmp, R = this.rest;
    for (let i = 0; i < this.N * 3; i++) D[i] = x[i] - R[i];
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const id = this.id(i, j, k);
      if (P[id]) continue;
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b2, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const i2 = i + a, j2 = j + b2, k2 = k + c;
        if (i2 < 0 || j2 < 0 || k2 < 0 || i2 >= NX || j2 >= NY || k2 >= NZ) continue;
        const q2 = this.id(i2, j2, k2) * 3; sx += D[q2]; sy += D[q2 + 1]; sz += D[q2 + 2]; n++;
      }
      const o = id * 3, s = 0.12;
      x[o] += (sx / n - D[o]) * s; x[o + 1] += (sy / n - D[o + 1]) * s; x[o + 2] += (sz / n - D[o + 2]) * s;
    }
    // plasticity + tearing
    let broke = 0;
    for (let e = 0; e < A.length; e++) {
      if (!this.alive[e]) continue;
      const len = this.dist(x, A[e], B[e]);
      const strain = (len - L[e]) / L[e];
      if (strain > YIELD) L[e] = len / (1 + YIELD); else if (strain < -YIELD) L[e] = len / (1 - YIELD);
      if ((len - this.L0[e]) / this.L0[e] > BREAK) { this.alive[e] = 0; broke++; }
    }
    this.dirty = true;
    return broke;
  }

  step(dt) {
    // settle at ~100 Hz: plenty for metal that only moves while it's being hit
    if (this.active > 0) { this.active -= dt; if ((this.tick = (this.tick || 0) + 1) % 3 === 0) this.relax(2); }
  }

  crushAt(c, f) { const o = [0, 0, 0]; this.dispAt(c, f, o); return Math.hypot(o[0], o[1], o[2]); }

  reset() {
    this.x.set(this.rest); this.L.set(this.L0); this.alive.fill(1); this.dirty = true; this.active = 0; this.damaged = false;
  }

  // three.js plumbing ---------------------------------------------------------------------------
  initGPU(THREE) {
    this.tex = new THREE.DataTexture(this.texData, this.N, 1, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.uniforms = {
      uLat: { value: this.tex },
      uLatN: { value: new THREE.Vector3(NX, NY, 0) },
      uLatS: { value: new THREE.Vector3(...this.size) },
      uLatOn: { value: 0 },
    };
  }
  upload() {
    if (!this.dirty || !this.tex) return;
    for (let i = 0; i < this.N; i++) {
      this.texData[i * 4] = this.x[i * 3] - this.rest[i * 3];
      this.texData[i * 4 + 1] = this.x[i * 3 + 1] - this.rest[i * 3 + 1];
      this.texData[i * 4 + 2] = this.x[i * 3 + 2] - this.rest[i * 3 + 2];
    }
    this.tex.needsUpdate = true;
    this.uniforms.uLatOn.value = this.damaged ? 1 : 0;
    this.dirty = false;
  }
}

// Per-vertex lattice binding attributes (aCell = cell index, aFrac = fraction inside the cell).
export function bindGeometry(THREE, geo, sb) {
  const pos = geo.getAttribute('position'), n = pos.count;
  const cell = new Float32Array(n * 3), frac = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { c, f } = sb.coords(pos.getX(i), pos.getY(i), pos.getZ(i));
    cell.set(c, i * 3); frac.set(f, i * 3);
  }
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 3));
  geo.setAttribute('aFrac', new THREE.BufferAttribute(frac, 3));
}

// Bake current deformation into plain positions (for parts that tear off).
export function bakeDeformed(geo, sb) {
  const pos = geo.getAttribute('position'), cell = geo.getAttribute('aCell'), frac = geo.getAttribute('aFrac');
  const out = new Float32Array(pos.count * 3), d = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    sb.dispAt([cell.getX(i), cell.getY(i), cell.getZ(i)], [frac.getX(i), frac.getY(i), frac.getZ(i)], d);
    out[i * 3] = pos.getX(i) + d[0]; out[i * 3 + 1] = pos.getY(i) + d[1]; out[i * 3 + 2] = pos.getZ(i) + d[2];
  }
  return out;
}

// Patch a material so its vertices (and normals) follow the lattice.
const LAT_GLSL = `
attribute vec3 aCell; attribute vec3 aFrac;
uniform sampler2D uLat; uniform vec3 uLatN; uniform vec3 uLatS; uniform float uLatOn;
vec3 gLatD = vec3(0.); mat3 gLatG = mat3(0.); bool gLatDone = false;
vec3 latN(ivec3 c) { return texelFetch(uLat, ivec2(c.x + int(uLatN.x) * (c.y + int(uLatN.y) * c.z), 0), 0).xyz; }
void latSample(out vec3 d, out mat3 G) {
  ivec3 c = ivec3(aCell + 0.5); vec3 f = aFrac;
  vec3 a000 = latN(c), a100 = latN(c + ivec3(1,0,0)), a010 = latN(c + ivec3(0,1,0)), a110 = latN(c + ivec3(1,1,0));
  vec3 a001 = latN(c + ivec3(0,0,1)), a101 = latN(c + ivec3(1,0,1)), a011 = latN(c + ivec3(0,1,1)), a111 = latN(c + ivec3(1,1,1));
  vec3 x00 = mix(a000, a100, f.x), x10 = mix(a010, a110, f.x), x01 = mix(a001, a101, f.x), x11 = mix(a011, a111, f.x);
  vec3 y0 = mix(x00, x10, f.y), y1 = mix(x01, x11, f.y);
  d = mix(y0, y1, f.z);
  vec3 gx = mix(mix(a100 - a000, a110 - a010, f.y), mix(a101 - a001, a111 - a011, f.y), f.z) / uLatS.x;
  vec3 gy = mix(x10 - x00, x11 - x01, f.z) / uLatS.y;
  vec3 gz = (y1 - y0) / uLatS.z;
  G = mat3(gx, gy, gz);
}`;
export function latticeMaterial(mat, sb) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, sb.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + LAT_GLSL)
      // undamaged cars skip the lattice entirely; damaged ones sample it once for position + normal
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nif (uLatOn > 0.5) { latSample(gLatD, gLatG); gLatDone = true; objectNormal = normalize(objectNormal - transpose(gLatG) * objectNormal); }')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef DMG\nvRestP = position; vRestN = normal;\n#endif\nif (uLatOn > 0.5) { if (!gLatDone) latSample(gLatD, gLatG); transformed += gLatD; }')
      .replace('#include <common>', '#include <common>\n#ifdef DMG\nvarying vec3 vRestP; varying vec3 vRestN;\n#endif\n' + DMG_GLSL);
    // paint damage: scuffed clearcoat, primer, bare metal, and a groove bump along the scratches
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n#ifdef DMG\nvarying vec3 vRestP; varying vec3 vRestN; float gDmg = 0., gDmgH = 0.;\n#endif\n' + DMG_GLSL)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
#ifdef DMG
{ vec4 dm = dmgSample(vRestP, normalize(vRestN)); float sc = dm.r, pr = dm.g, mt = dm.b;
#ifdef DMG_PAINT
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.8 + 0.1, sc * 0.5);   // hazed clearcoat
  roughnessFactor = mix(roughnessFactor, 0.7, sc);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.23, 0.22), pr);                 // grey primer
  roughnessFactor = mix(roughnessFactor, 0.85, pr);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.6, 0.62), mt);                   // bright steel
  metalnessFactor = mix(metalnessFactor, 1.0, mt); roughnessFactor = mix(roughnessFactor, 0.3, mt);
#else
  float w = clamp(sc + pr + mt, 0., 1.);                                                   // plastic: white stress marks
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42), w * 0.7); roughnessFactor = mix(roughnessFactor, 0.9, w);
#endif
  gDmg = clamp(sc + pr + mt, 0., 1.); gDmgH = pr + mt + 0.3 * sc; }
#endif`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n#ifdef DMG\nnormal = normalize(normal - vec3(dFdx(gDmgH), dFdy(gDmgH), 0.) * 6.);\n#endif')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#if defined(DMG) && defined(USE_CLEARCOAT)\nmaterial.clearcoat *= 1. - gDmg;\n#endif');
  };
  mat.customProgramCacheKey = () => 'lattice-v1';
  return mat;
}
