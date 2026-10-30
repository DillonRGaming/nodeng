// Car-vs-car collisions with crumple zones.
//  shell: spheres spread over each car's body surface, bound to its soft-body lattice (they move as
//         the body deforms). Their contact force is capped by a crush strength that stiffens as
//         metal piles up, so cars keep closing in and the overlap is turned into deformation —
//         energy goes into bending the bodies instead of bouncing.
//  core:  the passenger cell, a rigid box that never lets the cars pass through each other.
// Impulses change velocities directly (run before integrating each physics step).
import { v3, qRotate, qConj, add, sub, scl, dot, cross, len, heightAt, normalAt } from './physics.js';
import { CORE } from './softbody.js';

const R = 0.24; // shell sphere radius
const MU = 0.4;
const ITER = 8;
const SLOP = 0.01, BIAS = 0.25;
const CRUSH_F = 1300; // N per shell contact before metal gives way (the fitted shell has dozens touching at once)
const CRUSH_STIFFEN = 0.45; // crush depth (m) at which the structure is ~6x stronger
const MAX_PUSH = 0.07; // m of crush per contact per step

function shellPoints(b) {
  const pts = [];
  const xs = [-b.x, -b.x / 2, 0, b.x / 2, b.x];
  const ys = [b.yLo + 0.08, b.yLo + (b.yHi - b.yLo) * 0.37, b.yLo + (b.yHi - b.yLo) * 0.66, b.yHi - 0.08];
  const nz = Math.ceil((b.zF - b.zR) / 0.32);
  const zs = Array.from({ length: nz + 1 }, (_, i) => b.zR + ((b.zF - b.zR) * i) / nz);
  for (const y of ys) {
    for (const z of zs) pts.push(v3(-b.x, y, z), v3(b.x, y, z));
    for (const x of xs.slice(1, -1)) pts.push(v3(x, y, b.zF), v3(x, y, b.zR));
  }
  for (const x of xs.slice(1, -1)) for (const z of zs.slice(1, -1)) pts.push(v3(x, b.yHi, z)); // roof
  return pts;
}
function corePoints(c) {
  const pts = [];
  for (const x of [-c.x, 0, c.x]) for (const y of [c.yLo, c.yHi]) for (let z = c.zR; z <= c.zF + 1e-6; z += (c.zF - c.zR) / 5) pts.push(v3(x, y, z));
  return pts;
}

export function prepareCollider(car) {
  const b = car.P.body;
  car.shell = shellPoints(b).map((p) => ({ rest: p, c: null, f: null, crush: 0 }));
  car.core = { box: CORE, pts: corePoints(CORE) };
  car.colRadius = Math.hypot(b.x, Math.max(b.zF, -b.zR), b.yHi) + R;
  car.inContact = new Map();
}
// Shell fitted to the real body: voxelise the model's vertices and keep the outermost voxels in every
// row (sides), column (roof/bonnet/boot line) and lane (nose/tail), each pulled in by the sphere radius
// so the spheres' outside matches the skin. The box shell sticks out where the body tapers (above the
// bonnet, at the corners), which made cars collide in thin air.
export function fitShell(car, positions) {
  const V = 0.26, cells = new Map();
  for (const arr of positions) for (let i = 0; i < arr.length; i += 9) { // every 3rd vertex is plenty
    const x = arr[i], y = arr[i + 1], z = arr[i + 2];
    const k = `${Math.floor(x / V)},${Math.floor(y / V)},${Math.floor(z / V)}`;
    const c = cells.get(k) || cells.set(k, { x: 0, y: 0, z: 0, n: 0, k }).get(k);
    c.x += x; c.y += y; c.z += z; c.n++;
  }
  const list = [...cells.values()].filter((c) => c.n >= 3).map((c) => { const [i, j, k] = c.k.split(',').map(Number); return { i, j, k, x: c.x / c.n, y: c.y / c.n, z: c.z / c.n, push: v3() }; });
  const ext = (keyOf, axis, dir) => {
    const best = new Map();
    for (const c of list) { const key = keyOf(c), b = best.get(key); if (!b || c[axis] * dir > b[axis] * dir) best.set(key, c); }
    for (const c of best.values()) { c.keep = true; c.push[axis === 'i' ? 'x' : axis === 'j' ? 'y' : 'z'] -= dir * R * 0.9; }
  };
  ext((c) => c.j + ',' + c.k, 'i', 1); ext((c) => c.j + ',' + c.k, 'i', -1); // sides
  ext((c) => c.i + ',' + c.k, 'j', 1); // top surfaces
  ext((c) => c.i + ',' + c.j, 'k', 1); ext((c) => c.i + ',' + c.j, 'k', -1); // nose, tail
  const pts = list.filter((c) => c.keep && c.y > car.P.body.yLo + 0.05).map((c) => {
    const l = Math.hypot(c.push.x, c.push.y, c.push.z), s = l > R * 0.9 ? (R * 0.9) / l : 1; // corners: don't pull in twice
    return v3(c.x + c.push.x * s, c.y + c.push.y * s, c.z + c.push.z * s);
  });
  if (pts.length < 40) return;
  car.shell = pts.map((p) => ({ rest: p, c: null, f: null, crush: 0 }));
}
// bind the shell to a soft body (call once the lattice exists)
export function bindShell(car, sb) {
  car.sb = sb;
  for (const s of car.shell) { const { c, f } = sb.coords(s.rest.x, s.rest.y, s.rest.z); s.c = c; s.f = f; }
}

function invI(car, v) {
  const l = qRotate(qConj(car.q), v), I = car.P.inertia;
  return qRotate(car.q, v3(l.x / I.x, l.y / I.y, l.z / I.z));
}
const velAt = (c, p) => add(c.vel, cross(c.angVel, sub(p, c.pos)));
function applyImpulse(c, p, J) {
  c.vel = add(c.vel, scl(J, 1 / c.P.mass));
  c.angVel = add(c.angVel, invI(c, cross(sub(p, c.pos), J)));
}

// world positions of the (deformed) shell spheres
function shellWorld(car) {
  const out = [], d = [0, 0, 0];
  for (const s of car.shell) {
    let lx = s.rest.x, ly = s.rest.y, lz = s.rest.z;
    if (car.sb) { car.sb.dispAt(s.c, s.f, d); lx += d[0]; ly += d[1]; lz += d[2]; s.crush = Math.hypot(d[0], d[1], d[2]); }
    out.push(add(car.pos, qRotate(car.q, v3(lx, ly, lz))));
  }
  return out;
}

function coreContacts(A, B, out) {
  const b = B.core.box, qBi = qConj(B.q);
  for (const lp of A.core.pts) {
    const p = add(A.pos, qRotate(A.q, lp));
    const q = qRotate(qBi, sub(p, B.pos));
    if (q.x < -b.x || q.x > b.x || q.y < b.yLo || q.y > b.yHi || q.z < b.zR || q.z > b.zF) continue;
    const d = [b.x - q.x, q.x + b.x, b.yHi - q.y, q.y - b.yLo, b.zF - q.z, q.z - b.zR];
    let k = 0;
    for (let i = 1; i < 6; i++) if (d[i] < d[k]) k = i;
    const nl = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, -1, 0), v3(0, 0, 1), v3(0, 0, -1)][k];
    out.push({ core: true, p, n: qRotate(B.q, nl), depth: d[k], a: A, b: B, maxJ: Infinity });
  }
}

function shellContacts(A, B, wa, wb, out) {
  // hash B's spheres
  const H = new Map(), cs = 2 * R;
  const key = (x, y, z) => ((Math.floor(x / cs) + 4096) * 8192 + (Math.floor(y / cs) + 4096)) * 8192 + (Math.floor(z / cs) + 4096);
  wb.forEach((p, i) => { const k = key(p.x, p.y, p.z); if (!H.has(k)) H.set(k, []); H.get(k).push(i); });
  for (let ia = 0; ia < wa.length; ia++) {
    const pa = wa[ia];
    const cx = Math.floor(pa.x / cs), cy = Math.floor(pa.y / cs), cz = Math.floor(pa.z / cs);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = H.get(((cx + dx + 4096) * 8192 + (cy + dy + 4096)) * 8192 + (cz + dz + 4096));
      if (!list) continue;
      for (const ib of list) {
        const pb = wb[ib];
        const d = sub(pa, pb), dist = len(d);
        if (dist >= 2 * R || dist < 1e-5) continue;
        const crush = Math.max(A.shell[ia].crush, B.shell[ib].crush);
        const strength = CRUSH_F * (1 + 5 * (crush / CRUSH_STIFFEN) ** 2);
        out.push({ core: false, p: scl(add(pa, pb), 0.5), n: scl(d, 1 / dist), depth: 2 * R - dist, a: A, b: B, ia, ib, strength });
      }
    }
  }
}

function solve(contacts, dt) {
  for (const c of contacts) {
    const { a, b, p, n } = c;
    c.ra = sub(p, a.pos); c.rb = sub(p, b.pos);
    c.kfun = (x) => 1 / a.P.mass + 1 / b.P.mass + dot(x, cross(invI(a, cross(c.ra, x)), c.ra)) + dot(x, cross(invI(b, cross(c.rb, x)), c.rb));
    c.kN = c.kfun(n);
    c.vn0 = dot(sub(velAt(a, p), velAt(b, p)), n);
    c.target = c.core ? Math.min(BIAS * Math.max(c.depth - SLOP, 0) / dt, 1.5) : 0; // shell: just stop closing (up to crush strength)
    c.maxJ = c.core ? Infinity : c.strength * dt;
    c.jn = 0; c.jt = 0; c.tdir = null;
  }
  for (let it = 0; it < ITER; it++) for (const c of contacts) {
    const { a, b, p, n } = c;
    const vr = sub(velAt(a, p), velAt(b, p));
    const vn = dot(vr, n);
    let dj = (c.target - vn) / c.kN;
    const jn = Math.min(Math.max(c.jn + dj, 0), c.maxJ); dj = jn - c.jn; c.jn = jn;
    if (dj !== 0) { const J = scl(n, dj); applyImpulse(a, p, J); applyImpulse(b, p, scl(J, -1)); }
    const vr2 = sub(velAt(a, p), velAt(b, p));
    const vt = sub(vr2, scl(n, dot(vr2, n)));
    const vtl = len(vt);
    if (vtl > 1e-4) {
      const t = scl(vt, 1 / vtl);
      const maxT = MU * c.jn;
      const jt = Math.max(-maxT, Math.min(maxT, -vtl / c.kfun(t)));
      const J = scl(t, jt);
      applyImpulse(a, p, J); applyImpulse(b, p, scl(J, -1));
    }
  }
}

// crush: whatever overlap the shell couldn't stop becomes permanent deformation of both bodies
function deform(contacts) {
  for (const c of contacts) {
    if (c.core || c.depth <= SLOP) continue;
    const push = Math.min(c.depth - SLOP, MAX_PUSH) * (c.b === WORLD ? 1 : 0.65); // a wall doesn't give: the car takes it all
    for (const [car, idx, sign] of [[c.a, c.ia, 1], [c.b, c.ib, -1]]) {
      if (!car.sb) continue;
      const s = car.shell[idx];
      const dl = qRotate(qConj(car.q), scl(c.n, sign * push)); // into this car
      car.sb.push(s.c, s.f, dl.x, dl.y, dl.z);
    }
  }
}

// returns events: { p, n, depth, vn0, jn, vt, a, b, onset, core, ia, ib }
export function collideCars(cars, dt) {
  const events = [];
  const world = new Map();
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const A = cars[i], B = cars[j];
    if (len(sub(A.pos, B.pos)) > A.colRadius + B.colRadius) { A.inContact.set(B, false); B.inContact.set(A, false); continue; }
    if (!world.has(A)) world.set(A, shellWorld(A));
    if (!world.has(B)) world.set(B, shellWorld(B));
    const contacts = [];
    shellContacts(A, B, world.get(A), world.get(B), contacts);
    coreContacts(A, B, contacts);
    coreContacts(B, A, contacts);
    const hit = contacts.length > 0;
    if (hit) { solve(contacts, dt); deform(contacts); }
    const onset = hit && !A.inContact.get(B);
    for (const c of contacts) {
      const vr = sub(velAt(c.a, c.p), velAt(c.b, c.p));
      events.push({ p: c.p, n: c.n, depth: c.depth, vn0: c.vn0, jn: c.jn, vt: len(sub(vr, scl(c.n, dot(vr, c.n)))), a: c.a, b: c.b, onset, core: c.core, ia: c.ia, ib: c.ib });
    }
    A.inContact.set(B, hit); B.inContact.set(A, hit);
  }
  return events;
}

// Ground impacts dent the body too (roll-overs, landing a jump on the nose, bottoming out): every shell
// sphere whose skin goes below the ground while moving into it pushes its lattice point inwards along
// the ground normal, by an amount that grows with the impact speed. Returns impact events like car hits.
const GROUND_V0 = 2.5; // m/s of closing speed the structure shrugs off
export function groundCrush(car) {
  if (!car.sb) return [];
  // cheap early-out: upright, and the lowest the skin can reach is clear of the highest ground under
  // the footprint (the body's sill line sits ~0.2 m up on its wheels)
  const up = qRotate(car.q, v3(0, 1, 0));
  if (up.y > 0.85) {
    const b = car.P.body, fw = qRotate(car.q, v3(0, 0, 1)), rt = qRotate(car.q, v3(1, 0, 0));
    let gmax = -Infinity;
    for (const [sx, sz] of [[0, 0], [b.x, b.zF], [-b.x, b.zF], [b.x, b.zR], [-b.x, b.zR], [0, b.zF], [0, b.zR]]) {
      gmax = Math.max(gmax, heightAt(car.pos.x + rt.x * sx + fw.x * sz, car.pos.z + rt.z * sx + fw.z * sz));
    }
    const lowest = car.pos.y + b.yLo * up.y - Math.max(Math.abs(b.zF), Math.abs(b.zR)) * Math.hypot(up.x, up.z) - 0.05;
    if (lowest > gmax) return [];
  }
  const world = shellWorld(car), qi = qConj(car.q), out = [];
  for (let i = 0; i < world.length; i++) {
    const p = world[i], h = heightAt(p.x, p.z), pen = h - (p.y - R);
    if (pen <= 0) continue;
    const n = normalAt(p.x, p.z), vp = velAt(car, p), vn = dot(vp, n);
    const vt = qRotate(qi, sub(vp, scl(n, vn))); // sliding over the ground (car frame): scratches
    const crush = vn < -GROUND_V0;
    if (crush) {
      const amt = Math.min(MAX_PUSH, (-vn - GROUND_V0) * 0.006 + pen * 0.3);
      const dl = qRotate(qi, scl(n, amt));
      car.sb.push(car.shell[i].c, car.shell[i].f, dl.x, dl.y, dl.z);
    }
    out.push({ p, local: qRotate(qi, sub(p, car.pos)), speed: Math.max(0, -vn), crush, vt, rest: car.shell[i].rest, nl: qRotate(qi, scl(n, -1)) });
  }
  return out;
}

// ---------------------------------------------------------------- static obstacles
// Bollards (vertical cylinders) and walls / barriers (yawed boxes) standing on the ground. The world
// is an immovable body, so the same solver and crush model apply: the car's shell gives way up to its
// crush strength, its rigid cabin core never passes through.
export const WORLD = { P: { mass: Infinity, inertia: v3(Infinity, Infinity, Infinity) }, pos: v3(), vel: v3(), angVel: v3(), q: { x: 0, y: 0, z: 0, w: 1 } };
function obstacleHit(o, p, rad, out) { // p world point, rad sphere radius -> { n, depth, at } or null
  const gy = heightAt(o.x, o.z);
  if (p.y - rad > gy + o.h) return null; // over the top
  if (o.r !== undefined) {
    const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
    if (d >= o.r + rad || d < 1e-6) return null;
    const n = v3(dx / d, 0, dz / d);
    out.n = n; out.depth = o.r + rad - d; out.at = v3(o.x + n.x * o.r, p.y, o.z + n.z * o.r);
    return out;
  }
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw), dx = p.x - o.x, dz = p.z - o.z;
  const lx = c * dx - s * dz, lz = s * dx + c * dz;
  const qx = Math.max(-o.hx, Math.min(o.hx, lx)), qz = Math.max(-o.hz, Math.min(o.hz, lz));
  let nx = lx - qx, nz = lz - qz, d = Math.hypot(nx, nz), depth;
  if (d > 1e-6) { if (d >= rad) return null; nx /= d; nz /= d; depth = rad - d; }
  else { // centre inside the box: push out along the shallowest side
    const ex = o.hx - Math.abs(lx), ez = o.hz - Math.abs(lz);
    if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; depth = ex + rad; } else { nx = 0; nz = Math.sign(lz) || 1; depth = ez + rad; }
  }
  out.n = v3(c * nx + s * nz, 0, -s * nx + c * nz);
  out.depth = depth; out.at = v3(p.x - out.n.x * (rad - Math.min(depth, rad)), p.y, p.z - out.n.z * (rad - Math.min(depth, rad)));
  return out;
}
export function collideStatic(cars, obstacles, dt) {
  const events = [], hit = {};
  for (const A of cars) {
    const near = obstacles.filter((o) => Math.hypot(o.x - A.pos.x, o.z - A.pos.z) < A.colRadius + (o.r ?? Math.hypot(o.hx, o.hz)) + 0.3);
    if (!near.length) { A.inContact.set(WORLD, false); continue; }
    const contacts = [], world = shellWorld(A);
    world.forEach((p, ia) => {
      for (const o of near) if (obstacleHit(o, p, R, hit)) {
        const crush = A.shell[ia].crush, strength = CRUSH_F * (1 + 5 * (crush / CRUSH_STIFFEN) ** 2);
        contacts.push({ core: false, p: hit.at, n: hit.n, depth: hit.depth, a: A, b: WORLD, ia, ib: -1, strength });
      }
    });
    for (const lp of A.core.pts) { // the cabin never goes through
      const p = add(A.pos, qRotate(A.q, lp));
      for (const o of near) if (obstacleHit(o, p, 0.02, hit)) contacts.push({ core: true, p: hit.at, n: hit.n, depth: hit.depth, a: A, b: WORLD, maxJ: Infinity });
    }
    const any = contacts.length > 0;
    if (any) { solve(contacts, dt); deform(contacts); }
    const onset = any && !A.inContact.get(WORLD);
    for (const c of contacts) {
      const vr = sub(velAt(c.a, c.p), v3());
      events.push({ p: c.p, n: c.n, depth: c.depth, vn0: c.vn0, jn: c.jn, vt: len(sub(vr, scl(c.n, dot(vr, c.n)))), a: c.a, b: null, onset, core: c.core, ia: c.ia });
    }
    A.inContact.set(WORLD, any);
  }
  return events;
}
