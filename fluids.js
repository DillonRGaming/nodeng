// Fluid leaks. The systems that hold fluid can be holed by damage where they sit: the radiator and
// coolant reservoir (coolant), the oil pan and gearbox lines (oil). Drops fall from the leak with the
// car's velocity, land, and either feed a puddle that spreads while the car stands still, or smear into
// a streak in the direction of travel when it's moving.
// Puddles look like liquid on asphalt: an irregular procedural outline per puddle (noise, seeded),
// a damp dark rim, a translucent film tinted where it's thick (the ground shows through), a glossy
// reflective surface, and a thin-film rainbow sheen on oil. Coolant slowly dries up; oil stays.
import * as THREE from 'three';
import { heightAt } from './physics.js';

// volume (L), tint, how strongly the tint shows when thick, film thickness (mm: sets how far a
// litre spreads), spread speed, evaporation (L per s per m²), thin-film sheen
export const FLUIDS = { // tint: how much of the fluid's colour shows; alpha: how opaque the film gets (both are see-through)
  coolant: { name: 'coolant', volume: 6.5, color: 0x3fd67c, tint: 0.42, alpha: 0.42, film: 1.5, spread: 0.7, evap: 0.0015, sheen: 0, steam: true },
  oil: { name: 'engine oil', volume: 4.2, color: 0x7a4410, tint: 0.62, alpha: 0.7, film: 3.0, spread: 0.25, evap: 0, sheen: 0.55 },
};
const MAXD = 400, MAXP = 1500; // drops in flight; puddles per fluid

// ---------------------------------------------------------------- drops
const dropMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshStandardMaterial({ roughness: 0.04, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false }), MAXD);
dropMesh.frustumCulled = false; dropMesh.count = 0;
const drops = [];
let dropIdx = 0;

// ---------------------------------------------------------------- puddles (one instanced mesh per fluid)
// Shape and shading live in the fragment shader: the quad's uv + a per-instance seed give each
// puddle its own outline; aFade dries it out.
const NOISE = `
float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float pNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(pHash(i), pHash(i + vec2(1, 0)), f.x), mix(pHash(i + vec2(0, 1)), pHash(i + vec2(1, 1)), f.x), f.y); }`;
function puddleMaterial(F) {
  const m = new THREE.MeshPhysicalMaterial({
    color: F.color, roughness: 0.02, metalness: 0, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -5, envMapIntensity: 1.6,
    iridescence: F.sheen, iridescenceIOR: 1.45, iridescenceThicknessRange: [180, 620],
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTint = { value: F.tint }; sh.uniforms.uAlpha = { value: F.alpha };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSeed; attribute float aFade; varying float vSeed, vFade; varying vec2 vPuv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSeed = aSeed; vFade = aFade; vPuv = uv * 2. - 1.;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTint, uAlpha; varying float vSeed, vFade; varying vec2 vPuv; float gThick = 0.;' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
  { vec2 p = vPuv; float d = length(p); vec2 s = vec2(vSeed * 17.3, vSeed * 9.1);
    // lobed, wobbly outline: low-frequency lobes + finer ragged edge
    float edge = 0.55 + 0.32 * pNoise(p * 1.7 + s) + 0.13 * pNoise(p * 5.3 + s * 2.) - 0.05;
    float t = clamp((edge - d) / max(edge, 0.05), 0., 1.);        // film thickness, 0 at the edge
    float damp = smoothstep(edge + 0.16, edge, d) * (1. - step(edge, -d)); // damp asphalt around it
    if (damp <= 0.001) discard;
    gThick = t;
    float tintAmt = smoothstep(0.0, 0.55, t) * uTint;
    diffuseColor.rgb = mix(vec3(0.012, 0.013, 0.014), diffuseColor.rgb, tintAmt);  // thin: just wet and dark
    diffuseColor.a = (t > 0. ? (0.3 + 0.7 * smoothstep(0., 0.5, t)) * uAlpha : 0.22 * damp) * vFade; }`) // translucent: the ground shows through
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.45, roughnessFactor, smoothstep(0., 0.08, gThick)); // damp rim is satin, the film a mirror');
  };
  m.customProgramCacheKey = () => 'puddle2';
  return m;
}
const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const pools = {}; // kind -> { mesh, list, idx, seed, fade }
for (const [kind, F] of Object.entries(FLUIDS)) {
  const geo = quad.clone();
  const seed = new Float32Array(MAXP), fade = new Float32Array(MAXP);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fade, 1));
  const mesh = new THREE.InstancedMesh(geo, puddleMaterial(F), MAXP);
  mesh.frustumCulled = false; mesh.count = 0; mesh.renderOrder = 2; mesh.receiveShadow = true;
  pools[kind] = { mesh, list: [], idx: 0, seed, fade };
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);

export function addFluidsTo(scene) { scene.add(dropMesh); for (const P of Object.values(pools)) scene.add(P.mesh); }
export function clearFluids() {
  drops.length = 0; dropMesh.count = 0; dropIdx = 0;
  for (const P of Object.values(pools)) { P.list.length = 0; P.idx = 0; P.mesh.count = 0; }
}

// a leak on a vehicle: fluid, local drip point, rate (L/s while the system is under pressure)
export function startLeak(v, kind, local, rate) {
  const L = (v.leaks ||= {});
  if (L[kind]) { L[kind].rate = Math.max(L[kind].rate, rate); return; }
  L[kind] = { kind, local, rate, left: FLUIDS[kind].volume, acc: 0, heat: FLUIDS[kind].steam ? 1 : 0 };
}

function landDrop(d) {
  const F = FLUIDS[d.kind], P = pools[d.kind];
  const sp = Math.hypot(d.vx, d.vz);
  // standing still: feed a puddle under the drip; moving: every drop is its own streak
  if (sp < 1.5) {
    let best = null, bd = 1e9;
    for (let i = P.list.length - 1, n = 0; i >= 0 && n < 60; i--, n++) { // recent puddles only
      const q = P.list[i];
      if (q.streak) continue;
      const dist = Math.hypot(q.x - d.x, q.z - d.z);
      if (dist < q.r * 0.9 + 0.04 && dist < bd) { best = q; bd = dist; }
    }
    if (best) { best.vol += d.vol; best.peak = Math.max(best.peak, best.vol); return; }
  }
  const slot = P.idx;
  const q = P.list[slot] = {
    x: d.x, z: d.z, vol: d.vol, peak: d.vol, r: 0.025, slot,
    rot: sp > 1.5 ? Math.atan2(d.vx, d.vz) : Math.random() * 6.28,
    streak: sp > 1.5 ? Math.min(6, 1 + sp * 0.28) : 1, // smeared along the travel direction
  };
  P.seed[slot] = Math.random() * 100; P.mesh.geometry.attributes.aSeed.needsUpdate = true;
  P.idx = (P.idx + 1) % MAXP; P.mesh.count = Math.max(P.mesh.count, P.list.length);
  q.target = 0; void F;
}

// v: vehicle (car, group, leaks); emit: smoke emitter for steam
export function updateLeaks(v, dt, emit) {
  if (!v.leaks || dt <= 0) return;
  const c = v.car;
  for (const L of Object.values(v.leaks)) {
    if (L.left <= 0) continue;
    const F = FLUIDS[L.kind];
    // pumped circuits leak faster with revs; everything slows as it drains
    const pump = L.kind === 'coolant' || L.kind === 'oil' ? 0.5 + Math.min(1.5, c.eng.rpm / 3000) : 1;
    const flow = Math.min(L.left, L.rate * pump * (0.25 + 0.75 * L.left / F.volume) * dt);
    L.left -= flow;
    L.acc += flow / 0.0015; // ~1.5 ml per drop
    const p = _p.set(L.local.x, L.local.y, L.local.z).applyQuaternion(v.group.quaternion).add(v.group.position);
    while (L.acc >= 1) {
      L.acc -= 1;
      const d = drops[dropIdx] ||= {};
      Object.assign(d, { kind: L.kind, x: p.x + (Math.random() - 0.5) * 0.12, y: p.y, z: p.z + (Math.random() - 0.5) * 0.12,
        vx: c.vel.x, vy: c.vel.y - Math.random() * 0.4, vz: c.vel.z, vol: 0.0015, live: true });
      dropMesh.setColorAt(dropIdx, _c.set(F.color)); dropMesh.instanceColor.needsUpdate = true;
      dropIdx = (dropIdx + 1) % MAXD; dropMesh.count = Math.max(dropMesh.count, drops.length);
    }
    // hot coolant flashes to steam at the radiator for the first minute or so
    if (F.steam && L.heat > 0.02) {
      L.heat *= Math.exp(-dt / 50);
      if (Math.random() < dt * 25 * L.heat) {
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.group.quaternion);
        emit(p.clone().addScaledVector(up, 0.35), new THREE.Vector3(c.vel.x * 0.8 + (Math.random() - 0.5) * 0.6, 0.8 + Math.random(), c.vel.z * 0.8 + (Math.random() - 0.5) * 0.6),
          { life: 1.6 + Math.random(), s0: 0.25, s1: 1.6, c: [0.95, 0.96, 0.97], a: 0.18 * L.heat + 0.04, rise: 0.9, drag: 1.2 });
      }
    }
  }
}

export function updateFluids(dt) {
  if (dt <= 0) return;
  for (let i = 0; i < drops.length; i++) {
    const d = drops[i];
    if (!d.live) { _m.makeScale(0, 0, 0); dropMesh.setMatrixAt(i, _m); continue; }
    d.vy -= 9.81 * dt;
    const k = Math.exp(-dt * 0.6); d.vx *= k; d.vz *= k;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    if (d.y <= heightAt(d.x, d.z)) { d.live = false; landDrop(d); _m.makeScale(0, 0, 0); dropMesh.setMatrixAt(i, _m); continue; }
    const sp = Math.hypot(d.vx, d.vy, d.vz), st = Math.min(3, 1 + sp * 0.08);
    _q.setFromUnitVectors(_up, _s.set(d.vx, d.vy, d.vz).normalize());
    _m.compose(_p.set(d.x, d.y, d.z), _q, _s.set(0.011, 0.011 * st, 0.011));
    dropMesh.setMatrixAt(i, _m);
  }
  dropMesh.instanceMatrix.needsUpdate = true;

  for (const [kind, P] of Object.entries(pools)) {
    if (!P.list.length) continue;
    const F = FLUIDS[kind];
    for (const q of P.list) {
      if (!q) continue;
      // spreads to the area its volume covers at this fluid's film thickness (slower for oils)
      const target = Math.sqrt((q.vol * 1e-3) / (F.film * 1e-3) / Math.PI);
      if (target > q.r) q.r += (target - q.r) * Math.min(1, dt * F.spread);
      // watery fluids dry up (from the surface area), oils stay
      if (F.evap > 0 && q.vol > 0) q.vol = Math.max(0, q.vol - F.evap * Math.PI * q.r * q.r * dt);
      P.fade[q.slot] = Math.min(1, q.vol / Math.max(1e-6, q.peak * 0.35));
      _q.setFromAxisAngle(_up, q.rot);
      const R = Math.max(q.r, 0.02) * 2.3;
      _m.compose(_p.set(q.x, heightAt(q.x, q.z) + 0.011, q.z), _q, _s.set(R / Math.sqrt(q.streak), 1, R * Math.sqrt(q.streak)));
      P.mesh.setMatrixAt(q.slot, _m);
    }
    P.mesh.instanceMatrix.needsUpdate = true;
    P.mesh.geometry.attributes.aFade.needsUpdate = true;
  }
}
