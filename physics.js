// Vehicle physics core. Pure JS, no rendering deps, so it can run headless in node for tests.
// World: +Y up. Car local frame: +Z forward, +Y up, +X left. Origin at centre of gravity.

import { loadSettings } from './settings.js';
export const PHYS_HZ = 300;
export const DT = 1 / PHYS_HZ;
const G = 9.81;

// ---------- tiny vector / quaternion helpers ----------
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const scl = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a) || 1; return scl(a, 1 / l); };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function qRotate(q, v) {
  // v' = q v q*
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return v3(
    ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x
  );
}
const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function qNormalize(q) { const l = Math.hypot(q.x, q.y, q.z, q.w); q.x /= l; q.y /= l; q.z /= l; q.w /= l; }
export function qFromYaw(yaw) { return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }; }

// ---------- world / ground ----------
// Surfaces: grip multiplier, rolling resistance, and what the tyres throw up.
export const SURFACES = {
  asphalt: { mu: 1.0, crr: 0.013, name: 'ASPHALT', fx: 'smoke' },
  wet:     { mu: 0.68, crr: 0.016, name: 'WET', fx: 'spray' },
  gravel:  { mu: 0.62, crr: 0.04, name: 'GRAVEL', fx: 'dust' },
  grass:   { mu: 0.48, crr: 0.06, name: 'GRASS', fx: 'dirt' },
  ice:     { mu: 0.13, crr: 0.01, name: 'ICE', fx: 'none' },
};

// Rectangular zones on the plane (x0,z0,x1,z1). Shared with the renderer.
// The map: a flat floor with a test area (the old surface zones / ramps stay defined for later).
// which map: 'touge' (mountain pass, height field), 'grid' (flat road grid + test area), 'proto' (old test zones), 'flat' (bare flat ground, 1 AI car)
export const MAP = ['touge', 'grid', 'proto', 'flat'].includes(loadSettings().map) ? loadSettings().map : 'flat'; // picked in the menu (Esc)
export const FLAT_MAP = MAP === 'grid';
// a sampled height field (set by the map builder): bilinear lookup, used for everything
let HF = null;
export function setHeightField(f) { HF = f; }
// Test area: a grid of 8 m roads with intersections; the test features sit inside the middle block.
export const TEST = {
  roadW: 8,
  hill: { x: 32, z: 68, R: 30, H: 6 },
  // road grid: every pairing of these x and z lines is a road; their crossings are intersections
  gridX: [-90, -14, 72, 150], gridZ: [-175, -100, 110, 185],
  J: 12, // junction half-size: corners are rounded with radius J - roadW / 2
  curbH: 0.12, walkW: 2.7, // kerb height, pavement width round every block
  corners: [], // (the corners are intersections now)
  rumble: [{ x0: -17.9, x1: -17.0, z0: -80, z1: -30 }, { x0: 75.0, x1: 75.9, z0: 30, z1: 90 }], // rumble strips along lane edges
  kerbIn: [15.1, 16.0], kerbOut: [24.0, 24.9], kerbH: 0.06,
  bumps: { x0: -18.5, x1: -9.5, zs: [30, 45], w: 0.9, h: 0.08 },
  // static obstacles: bollards (cylinders), a crash wall and jersey barriers (boxes)
  bollards: [...Array.from({ length: 11 }, (_, i) => [20 + i * 2.4, -38]), [30.6, -50], [33.4, -50]].map(([x, z]) => ({ x, z, r: 0.11, h: 1.0 })),
  boxes: [
    { x: 32, z: -82, hx: 6, hz: 0.4, h: 1.6, yaw: 0, kind: 'wall' },
    ...Array.from({ length: 10 }, (_, i) => ({ x: 56, z: -66 + i * 4.05, hx: 0.3, hz: 1.98, h: 0.82, yaw: 0, kind: 'barrier' })),
  ],
  slalom: Array.from({ length: 6 }, (_, i) => [32, -22 + i * 9]),
};
function testHeight(x, z) {
  const T = TEST;
  let h = 0;
  const hl = T.hill, d = Math.hypot(x - hl.x, z - hl.z);
  if (d < hl.R) { const c = Math.cos((Math.PI * d) / (2 * hl.R)); h = hl.H * c * c; }
  for (const [cx, cz, sx, sz] of T.corners) { // rumble kerbs: a low rounded hump with ribs every 0.5 m
    const dx = x - cx, dz = z - cz;
    if (dx * sx < 0 || dz * sz < 0) continue;
    const r = Math.hypot(dx, dz);
    for (const [a, b] of [T.kerbIn, T.kerbOut]) {
      if (r <= a || r >= b) continue;
      const t = (r - a) / (b - a), along = Math.atan2(dz, dx) * r;
      h = Math.max(h, T.kerbH * Math.sin(Math.PI * t) * (0.8 + 0.2 * Math.abs(Math.sin(along * Math.PI * 2))));
    }
  }
  for (const r of T.rumble) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) h = Math.max(h, T.kerbH * Math.sin(Math.PI * (x - r.x0) / (r.x1 - r.x0)) * (0.8 + 0.2 * Math.abs(Math.sin(z * Math.PI * 2))));
  // kerbs + pavements round every block: depth inside the block's rounded outline -> kerb face, pavement, ramp down
  const W = T.roadW / 2, R = T.J - W;
  for (let i = 0; i < T.gridX.length - 1; i++) for (let k = 0; k < T.gridZ.length - 1; k++) {
    const x0 = T.gridX[i] + W, x1 = T.gridX[i + 1] - W, z0 = T.gridZ[k] + W, z1 = T.gridZ[k + 1] - W;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - R), qz = Math.abs(z - (z0 + z1) / 2) - ((z1 - z0) / 2 - R);
    const depth = -(Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - R); // > 0 inside
    if (depth <= 0) break;
    const w = T.walkW;
    h = Math.max(h, depth < w ? T.curbH * smoothstep(0, 0.04, depth) : T.curbH * (1 - smoothstep(w, w + 0.5, depth)));
    break;
  }
  const bm = T.bumps;
  if (x > bm.x0 && x < bm.x1) for (const bz of bm.zs) { const u = (z - bz) / bm.w; if (Math.abs(u) < 0.5) h = Math.max(h, bm.h * 0.5 * (1 + Math.cos(u * 2 * Math.PI))); }
  return h;
}
export const ZONES = MAP !== 'proto' ? [] : [
  { x0: -60, z0: 40, x1: -20, z1: 110, s: 'ice' },
  { x0: 20, z0: 40, x1: 60, z1: 110, s: 'grass' },
  { x0: -60, z0: -110, x1: -20, z1: -40, s: 'gravel' },
  { x0: 20, z0: -110, x1: 60, z1: -40, s: 'wet' },
];

// Height features: a table-top jump, speed bumps and a washboard strip.
export const FEATURES = {
  jump: { x0: -7, x1: 7, z0: 140, up: 14, top: 8, down: 18, h: 1.6 },
  bumps: { x0: -8, x1: 8, zs: [-140, -150, -160, -170], w: 0.9, h: 0.11 },
  wash: { x0: 90, x1: 104, z0: -60, z1: 60, amp: 0.05, wl: 2.2 },
  rollers: { x0: -125, x1: -105, z0: -90, z1: 90, h: 1.4, wl: 30 }, // rolling hills, crests get light
  kickers: { x0: 128, x1: 140, zs: [-60, 20], len: 7, h: 0.9 }, // short steep launch ramps with a sharp lip
  bowl: { x: 0, z: -270, r0: 22, r1: 40, h: 5 }, // banked ring: flat centre, wall curving up outwards
};

export function surfaceAt(x, z) {
  for (const zn of ZONES) if (x > zn.x0 && x < zn.x1 && z > zn.z0 && z < zn.z1) return zn.s;
  return 'asphalt';
}

export function heightAt(x, z) {
  if (HF) {
    const { H, N, ext, cell } = HF, fx = (x + ext) / cell, fz = (z + ext) / cell;
    const i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fz))), u = fx - i, v = fz - j;
    return H[j * N + i] * (1 - u) * (1 - v) + H[j * N + i + 1] * u * (1 - v) + H[(j + 1) * N + i] * (1 - u) * v + H[(j + 1) * N + i + 1] * u * v;
  }
  if (FLAT_MAP) return testHeight(x, z);
  if (MAP === 'flat') return 0;
  let h = 0;
  const j = FEATURES.jump;
  if (x > j.x0 && x < j.x1) {
    const a = j.z0, b = a + j.up, c = b + j.top, d = c + j.down;
    if (z > a && z < b) h = Math.max(h, j.h * smoothstep(a, b, z));
    else if (z >= b && z <= c) h = Math.max(h, j.h);
    else if (z > c && z < d) h = Math.max(h, j.h * (1 - smoothstep(c, d, z)));
  }
  const bm = FEATURES.bumps;
  if (x > bm.x0 && x < bm.x1) {
    for (const bz of bm.zs) {
      const u = (z - bz) / bm.w;
      if (Math.abs(u) < 0.5) h = Math.max(h, bm.h * 0.5 * (1 + Math.cos(u * 2 * Math.PI)));
    }
  }
  const w = FEATURES.wash;
  if (x > w.x0 && x < w.x1 && z > w.z0 && z < w.z1) {
    const edge = smoothstep(w.z0, w.z0 + 4, z) * (1 - smoothstep(w.z1 - 4, w.z1, z));
    h = Math.max(h, w.amp * (1 + Math.sin((z / w.wl) * 2 * Math.PI)) * edge);
  }
  const r = FEATURES.rollers;
  if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) {
    const edge = smoothstep(r.z0, r.z0 + 8, z) * (1 - smoothstep(r.z1 - 8, r.z1, z));
    h = Math.max(h, r.h * 0.5 * (1 - Math.cos(((z - r.z0) / r.wl) * 2 * Math.PI)) * edge);
  }
  const k = FEATURES.kickers;
  if (x > k.x0 && x < k.x1) for (const kz of k.zs) if (z > kz && z < kz + k.len) h = Math.max(h, k.h * Math.pow((z - kz) / k.len, 1.6));
  const bw = FEATURES.bowl, rr = Math.hypot(x - bw.x, z - bw.z);
  if (rr > bw.r0 && rr < bw.r1 + 14) h = Math.max(h, rr < bw.r1 ? bw.h * Math.pow((rr - bw.r0) / (bw.r1 - bw.r0), 2) : bw.h * (1 - smoothstep(bw.r1, bw.r1 + 14, rr)));
  return h;
}

export function normalAt(x, z) {
  const e = 0.05;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return norm(v3(-hx, 2 * e, -hz));
}

// ---------- tyre model ----------
// Combined-slip "normalised slip" model with a Pacejka-shaped curve.
// rho = |(kappa/kappaPeak, tanAlpha/alphaPeak)|, F = mu*Fz*MF(rho), split along the slip direction.
const MF_C = 1.25; // grip after the peak falls to ~92% (road tyre), so slides are catchable
const MF_B = Math.tan(Math.PI / (2 * MF_C)); // puts the peak exactly at rho = 1
// past the peak, a sliding tyre keeps losing grip: ~85% at a drift's ~30 deg, ~70% fully sideways or
// locked (rubber sliding on asphalt, not gripping it) - so a car shoved sideways skids, it doesn't stick
const MF = (r) => Math.sin(MF_C * Math.atan(MF_B * r)) * (1 - 0.24 * clamp((r - 1.5) / 7, 0, 1) ** 0.8);

// ---------- engine torque curve (1.6 L turbo inline-4, before boost: ~265 Nm / ~195 hp on boost) ----------
const TQ_RPM = [0, 800, 1500, 2500, 3500, 4500, 5500, 6000, 6500, 6800, 7200];
const TQ_NM = [95, 118, 138, 152, 158, 156, 148, 138, 122, 100, 70];
function naTorque(rpm) {
  if (rpm <= TQ_RPM[0]) return TQ_NM[0];
  for (let i = 1; i < TQ_RPM.length; i++) {
    if (rpm < TQ_RPM[i]) {
      const t = (rpm - TQ_RPM[i - 1]) / (TQ_RPM[i] - TQ_RPM[i - 1]);
      const s = t * t * (3 - 2 * t);
      return lerp(TQ_NM[i - 1], TQ_NM[i], s);
    }
  }
  return TQ_NM[TQ_NM.length - 1];
}

const RAD2RPM = 60 / (2 * Math.PI);
const RPM2RAD = 1 / RAD2RPM;

// Headline figures for the vehicle menu, from the same engine model the sim drives: the wide-open-
// throttle torque / power curve (full boost), peak figures, and a straight-line run on flat asphalt
// (traction-limited launch, shifts at the redline, aero + rolling drag) for 0-100 km/h and top speed.
export function vehicleSpecs(P, mode) {
  const curve = [];
  for (let rpm = P.idleRpm; rpm <= P.limiterRpm; rpm += 100) {
    const boost = P.maxBoost * smoothstep(1700, 4200, rpm);
    const T = naTorque(rpm) * (P.torqueMul ?? 1) * (1 + 0.85 * boost) - (10 + 0.0032 * rpm + 3.8e-7 * rpm * rpm);
    curve.push({ rpm, T, kw: (T * rpm * RPM2RAD) / 1000 });
  }
  const Tat = (rpm) => { const i = clamp(Math.floor((rpm - P.idleRpm) / 100), 0, curve.length - 2), f = clamp((rpm - curve[i].rpm) / 100, 0, 1); return lerp(curve[i].T, curve[i + 1].T, f); };
  const gears = P.gears.slice(2), fd = P.finalDrive, eff = P.driveEff ?? 0.9, r = P.wheelR, m = P.mass;
  const split = DRIVE_MODES[mode] || DRIVE_MODES.AWD, front = split[0] + split[1];
  const onDriven = front > 0.99 ? P.frontWeight - 0.06 : front < 0.01 ? 1 - P.frontWeight + 0.08 : 1; // weight on the driven wheels under acceleration
  const traction = P.muBase * m * G * onDriven;
  let v = 0, t = 0, t100 = null, gi = 0, shiftT = 0;
  const dt = 0.02;
  for (; t < 150; t += dt) {
    let rpm = (v / r) * gears[gi] * fd * RAD2RPM;
    if (rpm > P.redlineRpm && gi < gears.length - 1) { gi++; shiftT = P.shiftTime ?? 0.2; rpm = (v / r) * gears[gi] * fd * RAD2RPM; }
    const F = shiftT > 0 ? 0 : rpm >= P.limiterRpm ? 0 : Math.min((Tat(Math.max(rpm, 3200)) * gears[gi] * fd * eff) / r, traction); // clutch slips off the line
    const a = (F - 0.5 * 1.2 * P.cdA * v * v - 0.013 * m * G) / (m * 1.06);
    shiftT -= dt; v = Math.max(0, v + a * dt);
    if (t100 === null && v >= 100 / 3.6) t100 = t;
    if (t > 8 && F > 0 && a < 0.004) break; // flat out and no longer gaining: top speed
  }
  const peakT = Math.max(...curve.map((c) => c.T)), peakKw = Math.max(...curve.map((c) => c.kw));
  return { curve, peakNm: peakT, peakHp: peakKw * 1.341, kg: m, zeroTo100: t100, topKmh: v * 3.6, mode, limiter: P.limiterRpm };
}

export const DRIVE_MODES = {
  RWD: [0, 0, 0.5, 0.5],
  AWD: [0.3, 0.3, 0.2, 0.2], // front-biased like the Seltos
  FWD: [0.5, 0.5, 0, 0],
};

export function createCar(opts = {}) {
  const P = {
    // dimensions measured from the Kia Seltos model
    mass: 1420,
    inertia: v3(2300, 2500, 640), // pitch (x), yaw (y), roll (z)
    cgHeight: 0.62,
    wheelbase: 2.61,
    frontWeight: 0.58,
    trackF: 1.54,
    trackR: 1.54,
    wheelR: 0.35,
    wheelI: 1.3,
    restLen: 0.32, // spring free length
    maxLen: 0.36, // full droop (ray length minus radius)
    body: { x: 0.88, yLo: -0.42, yHi: 0.95, zF: 1.95, zR: -2.38 }, // collision box around the CG
    bumpStop: 0.07, // below this suspension length the bump stop engages
    rideHzF: 1.45, rideHzR: 1.55,
    dampBump: 0.32, dampReb: 0.55, // fraction of critical
    arbF: 26000, arbR: 14000, // N/m
    kappaPeak: 0.09,
    alphaPeak: 0.115, // ~6.6 degrees
    muBase: 1.02,
    loadSens: 0.1,
    maxSteer: 0.62, // rad at the wheel (~35 deg)
    brakeF: 2500, brakeR: 1400, handbrake: 3200,
    cdA: 0.66,
    // engine + driveline
    idleRpm: 800, limiterRpm: 6700, redlineRpm: 6300,
    engineI: 0.24,
    gears: [-3.4, 0, 3.64, 2.17, 1.43, 1.03, 0.81, 0.66], // R, N, 1..6 (tall top gears: a cruiser)
    finalDrive: 4.1,
    driveEff: 0.9,
    clutchMax: 620,
    shiftTime: 0.20,
    maxBoost: 0.8, // bar (with the 0.85/bar factor: 158 Nm -> ~265 Nm)
    lsd: 60, // Nm per rad/s of side-to-side speed difference on a driven axle
    ...opts,
  };

  const a = P.wheelbase * (1 - P.frontWeight); // CG -> front axle
  const b = P.wheelbase * P.frontWeight; // CG -> rear axle
  const cornerMass = [P.mass * P.frontWeight / 2, P.mass * P.frontWeight / 2,
    P.mass * (1 - P.frontWeight) / 2, P.mass * (1 - P.frontWeight) / 2];

  const wheels = [0, 1, 2, 3].map((i) => {
    const front = i < 2;
    const left = i % 2 === 0;
    const m = cornerMass[i];
    const hz = front ? P.rideHzF : P.rideHzR;
    const k = m * (2 * Math.PI * hz) ** 2;
    const cc = 2 * Math.sqrt(k * m);
    const staticComp = (m * G) / k;
    const sStatic = P.restLen - staticComp;
    // hardpoint such that at static ride the wheel centre sits at radius height
    const hy = -(P.cgHeight - P.wheelR) + sStatic;
    const track = front ? P.trackF : P.trackR;
    return {
      name: ['FL', 'FR', 'RL', 'RR'][i],
      front, left,
      hard: v3(left ? track / 2 : -track / 2, hy, front ? a : -b),
      k, cBump: cc * P.dampBump, cReb: cc * P.dampReb,
      s: sStatic, sPrev: sStatic, sStatic, // suspension length
      omega: 0, angle: 0, steer: 0,
      contact: false, cp: v3(), n: v3(0, 1, 0),
      Fz: 0, Fx: 0, Fy: 0, kappa: 0, alpha: 0, slipSpeed: 0, vx: 0, vy: 0,
      surface: 'asphalt', absF: 1, fwd: v3(0, 0, 1), lat: v3(1, 0, 0),
      toe: 0, // alignment error from crash damage (rad)
      center: v3(), // wheel centre world pos
    };
  });

  const bp = [];
  for (const x of [-P.body.x, P.body.x]) for (const z of [P.body.zR, P.body.zF]) for (const y of [P.body.yLo, P.body.yHi]) bp.push(v3(x, y, z));
  bp.push(v3(0, P.body.yHi + 0.05, -0.2));
  const car = {
    P, wheels, a, b, bodyPoints: bp,
    pos: v3(0, P.cgHeight + 0.02, 0),
    q: qFromYaw(0),
    vel: v3(), angVel: v3(),
    // inputs (0..1, steer -1..1, + = left)
    input: { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0 },
    // driveline state
    eng: {
      omega: P.idleRpm * RPM2RAD, rpm: P.idleRpm, torque: 0, throttle: 0, load: 0,
      boost: 0, fuelCut: false, idleI: 0.1, clutchCap: 0, clutchLocked: false,
      blowoff: 0, popEnergy: 0, pops: 0, lastLoad: 0,
    },
    gear: 1, // index into gears (1 = N)
    shiftTimer: 0, pendingGear: -1, blip: 0,
    autoShift: true, abs: true, tcs: true, mode: 'AWD', // tcs = traction + stability control
    escBrake: [0, 0, 0, 0], escActive: 0,
    tcsCut: 0,
    time: 0,
    extForce: v3(), extTorque: v3(), // collision forces gathered before each step (world frame)
    bodyContact: false,
    speed: 0, fwdSpeed: 0,
  };
  setAxes(car);
  return car;
}

function setAxes(car) {
  car.up = qRotate(car.q, v3(0, 1, 0)); car.fwdBody = qRotate(car.q, v3(0, 0, 1)); car.leftBody = qRotate(car.q, v3(1, 0, 0));
  car.speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z); car.fwdSpeed = dot(car.vel, car.fwdBody); car.accel = v3();
}

export function resetCar(car, pos = v3(0, 0, 0), yaw = 0) {
  car.pos = v3(pos.x, heightAt(pos.x, pos.z) + car.P.cgHeight + 0.05, pos.z);
  car.q = qFromYaw(yaw);
  car.vel = v3(); car.angVel = v3();
  for (const w of car.wheels) { w.omega = 0; w.s = w.sPrev = w.sStatic; w.absF = 1; }
  car.extForce = v3(); car.extTorque = v3();
  car.gear = 1; car.shiftTimer = 0; car.pendingGear = -1;
  setAxes(car);
  car.eng.omega = car.P.idleRpm * RPM2RAD; car.eng.boost = 0;
}

export function gearLabel(car) {
  const g = car.gear;
  return g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1);
}

export function shift(car, dir) {
  if (car.shiftTimer > 0) return;
  const ng = clamp((car.pendingGear >= 0 ? car.pendingGear : car.gear) + dir, 0, car.P.gears.length - 1);
  if (ng === car.gear) return;
  car.pendingGear = ng;
  car.shiftTimer = car.P.shiftTime;
  // rev-match blip on downshifts into a real gear
  car.blip = dir < 0 && ng >= 2 ? 1 : 0;
}

function tyreForce(car, w, omega, Fz, vx, vy, mu) {
  const P = car.P;
  const denom = Math.max(Math.abs(vx), 1.5);
  const kappa = (omega * P.wheelR - vx) / denom;
  const tanA = vy / denom;
  const sx = kappa / P.kappaPeak;
  const sy = tanA / Math.tan(P.alphaPeak);
  const rho = Math.hypot(sx, sy);
  const muEff = mu * P.muBase * clamp(1 - P.loadSens * (Fz / 3800 - 1), 0.75, 1.15);
  if (rho < 1e-6) return { Fx: 0, Fy: 0, kappa, tanA };
  const F = muEff * Fz * MF(rho);
  return { Fx: (F * sx) / rho, Fy: (-F * sy) / rho, kappa, tanA };
}

// Integrate one fixed physics step.
export function stepCar(car, dt = DT) {
  const P = car.P;
  const inp = car.input;
  car.time += dt;

  const up = qRotate(car.q, v3(0, 1, 0));
  const fwdBody = qRotate(car.q, v3(0, 0, 1));
  const leftBody = qRotate(car.q, v3(1, 0, 0));

  let force = add(v3(0, -P.mass * G, 0), car.extForce);
  let torque = car.extTorque;
  car.extForce = v3(); car.extTorque = v3();
  const applyAt = (F, point) => {
    force = add(force, F);
    torque = add(torque, cross(sub(point, car.pos), F));
  };

  // ---- steering with Ackermann ----
  const delta = inp.steer * P.maxSteer;
  let steerL = delta, steerR = delta;
  if (Math.abs(delta) > 1e-4) {
    const R = P.wheelbase / Math.tan(Math.abs(delta));
    const inner = Math.atan(P.wheelbase / (R - P.trackF / 2));
    const outer = Math.atan(P.wheelbase / (R + P.trackF / 2));
    if (delta > 0) { steerL = inner; steerR = outer; } else { steerL = -outer; steerR = -inner; }
  }
  car.wheels[0].steer = steerL + car.wheels[0].toe;
  car.wheels[1].steer = steerR + car.wheels[1].toe;
  car.wheels[2].steer = car.wheels[2].toe;
  car.wheels[3].steer = car.wheels[3].toe;

  // ---- suspension raycasts ----
  const sampleOffsets = [0, 0.11, -0.11, 0.2, -0.2];
  for (const w of car.wheels) {
    const origin = add(car.pos, qRotate(car.q, w.hard));
    const fw = w.steer !== 0 ? qRotate(car.q, v3(Math.sin(w.steer), 0, Math.cos(w.steer))) : fwdBody;
    if (w.detached) { // torn off in a crash: no suspension, no tyre
      w.sPrev = w.s = P.maxLen; w.contact = false; w.center = sub(origin, scl(up, w.s)); w.fwdW = fw;
      continue;
    }
    // find suspension length that puts the tyre circle on the ground (sample several points of the tyre)
    let best = P.maxLen + 1, bestPt = null;
    for (const off of sampleOffsets) {
      const lift = P.wheelR - Math.sqrt(P.wheelR * P.wheelR - off * off); // circle shape
      const o = add(origin, scl(fw, off));
      // ray o - up*t : solve o.y - up.y*t = h(o.xz - up.xz*t) by bisection
      const tMax = P.maxLen + P.wheelR - lift;
      const f = (t) => (o.y - up.y * t) - heightAt(o.x - up.x * t, o.z - up.z * t);
      if (f(tMax) > 0) continue;
      let lo = 0, hi = tMax;
      if (f(0) <= 0) { hi = 0; } else {
        for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
      }
      const s = hi - (P.wheelR - lift);
      if (s < best) { best = s; bestPt = sub(o, scl(up, hi)); }
    }
    w.sPrev = w.s;
    if (bestPt) {
      w.contact = true;
      w.s = Math.max(best, 0);
      w.cp = bestPt;
      w.n = normalAt(bestPt.x, bestPt.z);
      w.surface = surfaceAt(bestPt.x, bestPt.z);
    } else {
      w.contact = false;
      w.s = P.maxLen;
    }
    w.center = sub(origin, scl(up, w.s));
    w.fwdW = fw;
  }

  // spring + damper + bump stop + anti-roll bars
  const comp = car.wheels.map((w) => P.restLen - w.s);
  const arb = [
    P.arbF * (comp[0] - comp[1]), -P.arbF * (comp[0] - comp[1]),
    P.arbR * (comp[2] - comp[3]), -P.arbR * (comp[2] - comp[3]),
  ];
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    if (!w.contact) { w.Fz = 0; continue; }
    const sVel = (w.s - w.sPrev) / dt; // negative = compressing
    const c = sVel < 0 ? w.cBump : w.cReb;
    let F = w.k * comp[i] - c * sVel + arb[i];
    if (w.s < P.bumpStop) F += 120000 * (P.bumpStop - w.s) - 6000 * Math.min(sVel, 0);
    F = Math.max(F, 0);
    w.Fz = F * Math.max(dot(up, w.n), 0.2);
    applyAt(scl(up, F), w.cp);
  }

  // ---- tyre kinematics ----
  for (const w of car.wheels) {
    if (!w.contact) { w.vx = w.vy = 0; continue; }
    const r = sub(w.cp, car.pos);
    const vc = add(car.vel, cross(car.angVel, r));
    let f = w.fwdW;
    f = norm(sub(f, scl(w.n, dot(f, w.n))));
    const l = cross(w.n, f);
    w.fwd = f; w.lat = l;
    w.vx = dot(vc, f);
    w.vy = dot(vc, l);
  }

  // ---- driver aids ----
  const split = DRIVE_MODES[car.mode];
  let throttle = inp.throttle;
  if (car.tcs) {
    let maxK = 0;
    for (let i = 0; i < 4; i++) if (split[i] > 0 && car.wheels[i].contact) maxK = Math.max(maxK, car.wheels[i].kappa);
    car.tcsCut = clamp(car.tcsCut + (maxK > 0.28 ? 5 : -9) * dt, 0, 0.4); // a sporty setting: plenty of slip allowed, gentle cut, quick recovery
    throttle *= 1 - car.tcsCut;
  } else car.tcsCut = 0;

  // stability control: compare yaw rate with what the steering asks for (bicycle model);
  // too much yaw -> brake the outside front, too little -> brake the inside rear, and cut power
  car.escBrake.fill(0);
  car.escActive = Math.max(0, car.escActive - dt);
  {
    const vx = dot(car.vel, fwdBody), vy = dot(car.vel, leftBody), r = dot(car.angVel, up);
    if (car.tcs && vx > 8) {
      const delta = inp.steer * P.maxSteer;
      let rRef = (vx * delta) / (P.wheelbase * (1 + 0.0022 * vx * vx));
      const rMax = (0.85 * P.muBase * G) / vx;
      rRef = clamp(rRef, -rMax, rMax);
      const beta = Math.atan2(vy, vx);
      const over = Math.abs(r) - Math.abs(rRef) - 0.22; // yaw-rate excess
      const slide = Math.abs(beta) - 0.2; // ~11 deg of slip angle before it steps in // body slip angle excess
      if ((over > 0 && Math.sign(r) !== -Math.sign(rRef)) || slide > 0) {
        const amt = clamp(over * 2000 + Math.max(0, slide) * 3000, 0, 1000);
        car.escBrake[r > 0 ? 1 : 0] = amt; // outside front
        throttle *= 1 - clamp(amt / 3500, 0, 0.3);
        car.escActive = 0.3;
      } else if (Math.abs(rRef) - Math.abs(r) > 0.12 && Math.abs(rRef) > 0.1) {
        const amt = clamp((Math.abs(rRef) - Math.abs(r) - 0.12) * 3000, 0, 900);
        car.escBrake[rRef > 0 ? 2 : 3] = amt; // inside rear
        throttle *= 1 - clamp(amt / 1200, 0, 0.5);
        car.escActive = 0.3;
      }
    }
  }

  // ---- gearbox / auto clutch ----
  const eng = car.eng;
  if (car.shiftTimer > 0) {
    car.shiftTimer -= dt;
    if (car.shiftTimer < P.shiftTime * 0.5 && car.pendingGear >= 0) { car.gear = car.pendingGear; car.pendingGear = -1; }
    if (car.shiftTimer <= 0) { car.shiftTimer = 0; car.blip = 0; }
  }
  const shifting = car.shiftTimer > 0;
  const ratio = P.gears[car.gear] * P.finalDrive;
  const inGear = ratio !== 0;

  // drivetrain-side speed (carrier speed) for the auto clutch
  let W = 0;
  for (let i = 0; i < 4; i++) W += split[i] * car.wheels[i].omega;
  const transRpm = Math.abs(W * ratio) * RAD2RPM;

  let clutchTarget = 0;
  if (inGear && !shifting) {
    // centrifugal-style launch: engagement follows engine rpm while the gearbox is slow
    const bite = P.idleRpm + 250 + (car.tcs ? 1500 : 2700) * inp.throttle; // launch rpm rises with throttle (gentler with traction control)
    const launch = smoothstep(bite - 250, bite + 600, eng.rpm);
    const lo = Math.max(Math.min(bite, 3400) - 500, 1050);
    const caught = smoothstep(lo, lo + 400, transRpm); // gearbox has caught up with the engine
    clutchTarget = transRpm > 3400 ? 1 : Math.max(launch, caught);
  }
  clutchTarget *= 1 - inp.clutch;
  const rate = clutchTarget > eng.clutchCap ? 6 : 14;
  eng.clutchCap += clamp(clutchTarget - eng.clutchCap, -rate * dt, rate * dt);

  // ---- engine ----
  const rpm = eng.omega * RAD2RPM;
  // idle controller (PI) keeps it from stalling
  const idleErr = (P.idleRpm - rpm) / 300;
  eng.idleI = clamp(eng.idleI + idleErr * dt * 0.6, 0, 0.25);
  const idleThrottle = clamp(eng.idleI + idleErr * 0.25, 0, 0.35);
  let thr = Math.max(throttle, idleThrottle);
  if (shifting) thr = car.blip ? Math.max(0.55, idleThrottle) : idleThrottle; // throttle cut / blip
  if (rpm > P.limiterRpm) eng.fuelCut = true;
  else if (rpm < P.limiterRpm - 180) eng.fuelCut = false;
  if (eng.fuelCut) thr = 0;
  eng.throttle = thr;

  // turbo: boost target needs throttle and exhaust flow; spools with lag, dumps via blow-off valve
  const flow = smoothstep(1700, 4200, rpm);
  const boostTarget = P.maxBoost * thr * flow * (0.35 + 0.65 * smoothstep(0, 1, eng.load + 0.3));
  if (boostTarget > eng.boost) eng.boost += (boostTarget - eng.boost) * dt * (0.6 + 3.2 * flow);
  else {
    if (thr < 0.15 && eng.boost > 0.35 && eng.blowoff <= 0) eng.blowoff = eng.boost;
    eng.boost += (boostTarget - eng.boost) * dt * (thr < 0.15 ? 7 : 2.5);
  }
  if (eng.blowoff > 0) eng.blowoff = Math.max(0, eng.blowoff - dt * 2.2);

  const friction = 10 + 0.0032 * rpm + 3.8e-7 * rpm * rpm + (1 - thr) * 0.0035 * rpm;
  const combustion = thr * naTorque(rpm) * (P.torqueMul ?? 1) * (1 + 0.85 * eng.boost);
  const Te = combustion - friction;
  eng.torque = Te;
  eng.load = clamp(combustion / 420, 0, 1);

  // ---- wheel spin + driveline: semi-implicit solve ----
  // Linearise tyre Fx in omega per wheel, then solve wheels + engine + clutch together.
  const Ai = [0, 0, 0, 0], Ei = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    let E = 0, K = 0;
    if (w.contact) {
      const mu = SURFACES[w.surface].mu;
      const f0 = tyreForce(car, w, w.omega, w.Fz, w.vx, w.vy, mu);
      const d = 0.05;
      const f1 = tyreForce(car, w, w.omega + d, w.Fz, w.vx, w.vy, mu);
      K = Math.max((f1.Fx - f0.Fx) / d, 0);
      E -= P.wheelR * f0.Fx;
      E -= SURFACES[w.surface].crr * w.Fz * P.wheelR * (w.omega / (Math.abs(w.omega) + 0.5));
      w.kappa = f0.kappa;
    }
    // limited-slip: couples left/right on driven axles
    if (split[i] > 0) {
      const o = car.wheels[i ^ 1];
      E -= P.lsd * (w.omega - o.omega);
    }
    E -= w.omega * 0.4; // bearing drag
    Ai[i] = P.wheelI / dt + P.wheelR * K;
    Ei[i] = E;
  }

  const G_ = ratio;
  let T = 0; // torque into the differential carrier
  eng.clutchLocked = false;
  const IeDt = P.engineI / dt;
  if (inGear && eng.clutchCap > 0.001) {
    let Wsum = 0, Psum = 0, Qsum = 0;
    for (let i = 0; i < 4; i++) {
      if (!split[i]) continue;
      Wsum += split[i] * car.wheels[i].omega;
      Psum += (split[i] * Ei[i]) / Ai[i];
      Qsum += (split[i] * split[i]) / Ai[i];
    }
    // locked clutch solution
    const Tlock = (Te - IeDt * (G_ * (Wsum + Psum) - eng.omega)) / (IeDt * G_ * Qsum + 1 / G_);
    const cap = eng.clutchCap * P.clutchMax;
    if (Math.abs(Tlock / G_) <= cap) {
      T = Tlock; eng.clutchLocked = eng.clutchCap > 0.98;
    } else {
      T = Math.sign(Tlock / G_) * cap * G_;
    }
  }
  const Tclutch = T / (G_ || 1);
  eng.omega += (dt / P.engineI) * (Te - (inGear ? Tclutch : 0));
  eng.omega = Math.max(eng.omega, 300 * RPM2RAD);

  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    let om = w.omega + (split[i] * T * P.driveEff + Ei[i]) / Ai[i];
    // brakes: friction that can stop but never reverse the wheel
    let Tb = inp.brake * (w.front ? P.brakeF : P.brakeR);
    if (car.abs && inp.brake > 0.05 && Math.abs(w.vx) > 2 && w.contact) {
      if (w.kappa < -0.13) w.absF = Math.max(0.15, w.absF - dt * 25);
      else w.absF = Math.min(1, w.absF + dt * 12);
      Tb *= w.absF;
    } else w.absF = 1;
    Tb += car.escBrake[i];
    if (!w.front) Tb += inp.handbrake * P.handbrake;
    const dB = Tb / Ai[i];
    if (Math.abs(om) <= dB) om = 0; else om -= Math.sign(om) * dB;
    w.omega = om;
    w.angle += om * dt;
  }
  if (eng.clutchLocked) {
    // keep the engine exactly on the drivetrain when locked (removes drift from the linearisation)
    let Wn = 0;
    for (let i = 0; i < 4; i++) Wn += split[i] * car.wheels[i].omega;
    eng.omega = Math.max(G_ * Wn, 300 * RPM2RAD);
  }
  eng.rpm = eng.omega * RAD2RPM;

  // ---- tyre forces on the chassis, with the updated spin ----
  for (const w of car.wheels) {
    if (!w.contact) { w.Fx = w.Fy = 0; w.slipSpeed = 0; continue; }
    const mu = SURFACES[w.surface].mu;
    const f = tyreForce(car, w, w.omega, w.Fz, w.vx, w.vy, mu);
    w.Fx = f.Fx; w.Fy = f.Fy; w.kappa = f.kappa; w.alpha = Math.atan(f.tanA);
    w.slipSpeed = Math.hypot(w.omega * P.wheelR - w.vx, w.vy);
    applyAt(add(scl(w.fwd, f.Fx), scl(w.lat, f.Fy)), w.cp);
  }

  // ---- body/ground contact (roll-overs, bottoming out) ----
  car.bodyContact = false;
  for (const lp of car.bodyPoints) {
    const p = add(car.pos, qRotate(car.q, lp));
    const h = heightAt(p.x, p.z);
    const depth = h - p.y;
    if (depth <= 0) continue;
    car.bodyContact = true;
    const n = normalAt(p.x, p.z);
    const r = sub(p, car.pos);
    const vp = add(car.vel, cross(car.angVel, r));
    const vn = dot(vp, n);
    const Fn = Math.max(0, 250000 * depth - 9000 * vn);
    const vt = sub(vp, scl(n, vn));
    const vtl = len(vt);
    let F = scl(n, Fn);
    if (vtl > 1e-3) F = add(F, scl(vt, -Math.min(0.55 * Fn, 4000 * vtl) / vtl));
    applyAt(F, p);
  }

  // ---- aero ----
  const sp = len(car.vel);
  if (sp > 0.01) applyAt(scl(car.vel, -0.5 * 1.2 * P.cdA * sp), add(car.pos, scl(up, 0.1)));

  // ---- integrate rigid body (semi-implicit Euler) ----
  car.vel = add(car.vel, scl(force, dt / P.mass));
  car.pos = add(car.pos, scl(car.vel, dt));
  // angular: work in body frame for the diagonal inertia
  const qi = qConj(car.q);
  const wb = qRotate(qi, car.angVel);
  const tb = qRotate(qi, torque);
  const I = P.inertia;
  const Iw = v3(I.x * wb.x, I.y * wb.y, I.z * wb.z);
  const gyro = cross(wb, Iw);
  const dw = v3((tb.x - gyro.x) / I.x, (tb.y - gyro.y) / I.y, (tb.z - gyro.z) / I.z);
  const wb2 = add(wb, scl(dw, dt));
  car.angVel = qRotate(car.q, wb2);
  const wv = car.angVel;
  const q = car.q;
  const hdt = 0.5 * dt;
  const nq = {
    x: q.x + hdt * (wv.x * q.w + wv.y * q.z - wv.z * q.y),
    y: q.y + hdt * (wv.y * q.w + wv.z * q.x - wv.x * q.z),
    z: q.z + hdt * (wv.z * q.w + wv.x * q.y - wv.y * q.x),
    w: q.w + hdt * (-wv.x * q.x - wv.y * q.y - wv.z * q.z),
  };
  qNormalize(nq);
  car.q = nq;

  car.speed = sp;
  car.fwdSpeed = dot(car.vel, fwdBody);
  car.up = up; car.fwdBody = fwdBody; car.leftBody = leftBody;
  car.accel = scl(force, 1 / P.mass);
}


// Auto gearbox logic, called once per physics step by the input layer.
export function autoGearbox(car, dt) {
  if (!car.autoShift || car.shiftTimer > 0) return;
  const P = car.P;
  const g = car.gear;
  const rpm = car.eng.rpm;
  if (g >= 2) {
    const thr = car.input.throttle;
    const up = lerp(2600, P.redlineRpm - 100, thr);
    const down = lerp(1400, 3600, thr);
    const nextRatio = P.gears[g + 1];
    const wheelRpm = Math.abs(car.fwdSpeed / P.wheelR) * P.finalDrive * RAD2RPM;
    const slipping = car.wheels.some((w, i) => DRIVE_MODES[car.mode][i] && w.kappa > 0.25);
    const nearLimiter = rpm > P.limiterRpm - 250; // shift even through wheelspin rather than sit on the limiter
    if (g < P.gears.length - 1 && rpm > up && (nearLimiter || (car.eng.clutchLocked && !slipping)) && wheelRpm * nextRatio > 1100) shift(car, +1);
    else if (g > 2) {
      const lowerRpm = wheelRpm * P.gears[g - 1];
      if (wheelRpm * P.gears[g] < down && lowerRpm < P.redlineRpm - 600) shift(car, -1);
    }
  }
}

export { clamp, lerp, smoothstep, len, dot, add, sub, scl, cross, norm, RAD2RPM, qConj };
