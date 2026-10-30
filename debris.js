// Parts that tore off a car: simple rigid bodies (box from the part's extents) with gravity, ground
// contact (bounce, friction, settle) and getting shoved by cars. Each piece keeps the bent shape it
// had when it came off.
import * as THREE from 'three';
import { heightAt } from './physics.js';
import { bakeDeformed } from './softbody.js';
import { compact } from './carModel.js';

const G = 9.81;
const pieces = [];
const MAX = 24;

// inst: car instance; part: inst.parts[id]; car: physics car; impulse: extra velocity (world)
// a torn-off piece no longer follows the lattice: a plain copy of its material, made once per
// material and compiled ahead of time (prewarmDebris) so tearing something off never compiles a shader
const plainCache = new WeakMap();
export function plainMaterial(m) {
  if (!plainCache.has(m)) {
    const c = m.clone(); c.onBeforeCompile = () => {}; c.customProgramCacheKey = () => 'plain';
    if (c.emissive) c.emissiveIntensity = 0; // a torn-off lamp goes dark
    plainCache.set(m, c);
  }
  return plainCache.get(m);
}
export function prewarmDebris(renderer, scene, camera, inst) {
  // compiled inside the real scene (same lights, fog, shadows -> same shader variants), then removed
  // a tiny stand-in per material with the same vertex attributes as the real piece (uv1 for the AO map
  // etc.: a missing attribute is a different shader variant, which then compiled mid-crash)
  const tmp = new THREE.Group(), seen = new Set(), geos = [];
  inst.body.traverse((o) => {
    if (!o.isMesh || o.userData.prepass) return;
    const attrs = ['normal', 'uv', 'uv1'].filter((k) => o.geometry.getAttribute(k)), key = o.material.uuid + attrs.join();
    if (seen.has(key)) return; seen.add(key);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    for (const k of attrs) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(3 * o.geometry.getAttribute(k).itemSize), o.geometry.getAttribute(k).itemSize));
    geos.push(g);
    const m = new THREE.Mesh(g, plainMaterial(o.material)); m.castShadow = !o.material.transparent; m.frustumCulled = false; tmp.add(m);
  });
  scene.add(tmp);
  renderer.compile(scene, camera);
  scene.remove(tmp);
  for (const g of geos) g.dispose();
}
export function tearOff(scene, inst, part, car, carGroup, kick) {
  const sb = inst.sb;
  const group = new THREE.Group();
  const box = new THREE.Box3();
  const baked = [];
  for (const m of part.meshes) {
    // only this piece's own vertices (split pieces share a whole panel's buffer): baking and copying
    // the full buffer was a big hitch the moment something tore off
    const src = m.userData.compact ||= m.geometry.index ? compact(m.geometry) : m.geometry;
    const pos = bakeDeformed(src, sb);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    for (const k of ['normal', 'uv', 'uv1']) if (src.getAttribute(k)) g.setAttribute(k, src.getAttribute(k));
    g.setIndex(src.index);
    // bounds of the triangles this piece draws (split pieces share the whole car's vertex buffer)
    const bb = new THREE.Box3(), v = new THREE.Vector3();
    if (g.index) for (const i of g.index.array) bb.expandByPoint(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    else { g.computeBoundingBox(); bb.copy(g.boundingBox); }
    g.boundingBox = bb; box.union(bb);
    const mat = plainMaterial(m.material);
    baked.push({ g, mat });
    m.visible = false;
  }
  if (box.isEmpty()) return null;
  // centre the piece on its own origin
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).max(new THREE.Vector3(0.08, 0.08, 0.08));
  for (const b of baked) { b.g.translate(-c.x, -c.y, -c.z); b.g.computeBoundingSphere(); const mesh = new THREE.Mesh(b.g, b.mat); mesh.castShadow = !b.mat.transparent; mesh.receiveShadow = true; mesh.userData.ownsGeometry = true; group.add(mesh); }
  // world placement from the car
  // from the mesh's own world transform: a hinged panel that was open leaves from where it was
  const mw = part.meshes[0].matrixWorld;
  group.position.copy(c).applyMatrix4(mw);
  group.quaternion.setFromRotationMatrix(mw);
  scene.add(group);
  const r = c.clone().applyQuaternion(carGroup.quaternion);
  const w = new THREE.Vector3(car.angVel.x, car.angVel.y, car.angVel.z);
  const vel = new THREE.Vector3(car.vel.x, car.vel.y, car.vel.z).add(w.clone().cross(r)).add(kick);
  const mass = Math.max(4, size.x * size.y * size.z * 60);
  const piece = {
    group, vel, ang: w.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4)),
    half: size.clone().multiplyScalar(0.5), mass, sleep: 0, owner: inst,
  };
  const h = piece.half;
  piece.Iavg = ((h.y * h.y + h.z * h.z + h.x * h.x + h.z * h.z + h.x * h.x + h.y * h.y) * mass) / 9;
  pieces.push(piece);
  if (pieces.length > MAX) removePiece(pieces[0]);
  return piece;
}

function removePiece(p) {
  p.group.parent?.remove(p.group);
  p.group.traverse((o) => { if (o.isMesh && o.userData.ownsGeometry) o.geometry.dispose(); }); // materials are shared (plainMaterial)
  pieces.splice(pieces.indexOf(p), 1);
}
// any object (already in world placement) as a loose rigid piece, e.g. a wheel that came off
export function spawnPiece(scene, obj, half, vel, ang, owner, mass = 10) {
  obj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(obj);
  const piece = { group: obj, vel: vel.clone(), ang: ang.clone(), half: half.clone(), mass, sleep: 0, owner };
  const h = half;
  piece.Iavg = ((h.y * h.y + h.z * h.z + h.x * h.x + h.z * h.z + h.x * h.x + h.y * h.y) * mass) / 9;
  pieces.push(piece);
  if (pieces.length > MAX) removePiece(pieces[0]);
  return piece;
}
export function clearDebris(owner) { for (const p of [...pieces]) if (!owner || p.owner === owner) removePiece(p); }

const corners = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push(new THREE.Vector3(x, y, z));
const tmp = new THREE.Vector3(), r = new THREE.Vector3(), vp = new THREE.Vector3(), qInv = new THREE.Quaternion();

// Ground contact with proper impulses: each touching corner gets a normal impulse through the body's
// effective mass at that point (little bounce) and a Coulomb friction impulse, then the penetration is
// resolved. Slow pieces that stay in contact go to sleep, so they settle instead of jittering forever.
const rn = new THREE.Vector3(), vt = new THREE.Vector3(), jv = new THREE.Vector3(), N = new THREE.Vector3(0, 1, 0);
const REST = 0.15, MU_G = 0.6;
function impulse(p, rr, dir, j) { // apply impulse j along dir at offset rr
  p.vel.addScaledVector(dir, j / p.mass);
  p.ang.addScaledVector(rn.copy(rr).cross(dir), j / p.Iavg);
}
export function updateDebris(dt, cars) {
  const sub = 6, h = dt / sub;
  for (const p of pieces) {
    shove(p, cars);
    if (p.sleep > 0.5) continue;
    let touching = 0;
    for (let s = 0; s < sub; s++) {
      p.vel.y -= G * h;
      p.group.position.addScaledVector(p.vel, h);
      const a = p.ang, ql = a.length();
      if (ql > 1e-5) { const dq = new THREE.Quaternion().setFromAxisAngle(tmp.copy(a).multiplyScalar(1 / ql), ql * h); p.group.quaternion.premultiply(dq).normalize(); }
      let depth = 0; touching = 0;
      for (const c of corners) {
        r.copy(c).multiply(p.half).applyQuaternion(p.group.quaternion);
        const wy = p.group.position.y + r.y, gy = heightAt(p.group.position.x + r.x, p.group.position.z + r.z);
        if (wy >= gy) continue;
        touching++; depth = Math.max(depth, gy - wy);
        vp.copy(p.ang).cross(r).add(p.vel);
        if (vp.y >= 0) continue;
        const kN = 1 / p.mass + rn.copy(r).cross(N).lengthSq() / p.Iavg;
        const jn = (-(1 + (vp.y < -1 ? REST : 0)) * vp.y) / kN; // no bounce at all for slow contacts
        impulse(p, r, N, jn);
        // friction
        vp.copy(p.ang).cross(r).add(p.vel); vt.set(vp.x, 0, vp.z);
        const vtl = vt.length();
        if (vtl > 1e-5) {
          jv.copy(vt).divideScalar(-vtl);
          const kT = 1 / p.mass + rn.copy(r).cross(jv).lengthSq() / p.Iavg;
          impulse(p, r, jv, Math.min(vtl / kT, MU_G * jn));
        }
      }
      if (depth > 0) p.group.position.y += depth; // resolve penetration (no velocity added)
      if (touching) p.ang.multiplyScalar(1 - Math.min(1, 1.5 * h)); // rolling resistance
    }
    const slow = p.vel.lengthSq() < 0.04 && p.ang.lengthSq() < 0.3;
    if (touching >= 3 && slow) { p.sleep += dt; if (p.sleep > 0.5) { p.vel.set(0, 0, 0); p.ang.set(0, 0, 0); } }
    else p.sleep = 0;
  }
}
// cars shove pieces out of their way
function shove(p, cars) {
    for (const c of cars) {
      tmp.set(c.pos.x, c.pos.y, c.pos.z);
      const d = p.group.position.clone().sub(tmp);
      qInv.set(c.q.x, c.q.y, c.q.z, c.q.w).invert();
      const l = d.clone().applyQuaternion(qInv), b = c.P.body;
      const pad = 0.15;
      if (Math.abs(l.x) < b.x + pad && l.y < b.yHi + pad && l.y > b.yLo - pad && l.z < b.zF + pad && l.z > b.zR - pad) {
        const out = [b.x + pad - l.x, l.x + b.x + pad, b.zF + pad - l.z, l.z - b.zR + pad];
        const k = out.indexOf(Math.min(...out));
        const n = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)][k].applyQuaternion(new THREE.Quaternion(c.q.x, c.q.y, c.q.z, c.q.w));
        const cv0 = new THREE.Vector3(c.vel.x, c.vel.y, c.vel.z);
        if (p.sleep > 0.5 && cv0.lengthSq() < 0.25) continue; // a parked car leaning on a settled piece
        p.group.position.addScaledVector(n, out[k]);
        const cv = new THREE.Vector3(c.vel.x, c.vel.y, c.vel.z);
        const rel = p.vel.clone().sub(cv).dot(n);
        if (rel < 0) { p.vel.addScaledVector(n, -rel * 1.3); p.vel.y += Math.min(2, -rel * 0.25); p.ang.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(-rel)); }
        p.sleep = 0;
      }
    }
}
export const debrisCount = () => pieces.length;
