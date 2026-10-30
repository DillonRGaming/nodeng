// A traffic car that drives a loop "normally": pure-pursuit steering, corner speed from the road's
// curvature, slows for whatever is in front of it, recovers if it gets wrecked or stuck.
import { v3, dot, resetCar, clamp } from './physics.js';

// Rounded-rectangle loop through the open lanes of the test area (clear of the zones, jump and bumps).
// traffic signals: one controller per junction, north-south and east-west take turns
// (green 12 s, amber 3 s, all-red 2 s each), offset per junction so they don't all switch together
export const signals = {
  t: 0, G: 12, A: 3, R: 2,
  state(node, ns) {
    const half = this.G + this.A + this.R, cyc = 2 * half;
    let u = (this.t + node * 5.3) % cyc;
    if (!ns) u = (u + half) % cyc;
    return u < this.G ? 'green' : u < this.G + this.A ? 'amber' : 'red';
  },
};
// a rectangular loop over the road grid (corners rounded at the intersections), counter-clockwise
export function buildRoute({ x0 = -14, x1 = 78, z0 = -125, z1 = 125, r = 12 } = {}) {
  const step = 1.5;
  const pts = [];
  const line = (ax, az, bx, bz) => { const n = Math.ceil(Math.hypot(bx - ax, bz - az) / step); for (let i = 0; i < n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, z: az + ((bz - az) * i) / n }); };
  const arc = (cx, cz, a0, a1) => { const n = Math.ceil((Math.abs(a1 - a0) * r) / step); for (let i = 0; i < n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push({ x: cx + r * Math.cos(a), z: cz + r * Math.sin(a) }); } };
  // counter-clockwise seen from above, heading +z along x = x0 (right past the spawn point)
  line(x0, z0 + r, x0, z1 - r); arc(x0 + r, z1 - r, Math.PI, Math.PI / 2);
  line(x0 + r, z1, x1 - r, z1); arc(x1 - r, z1 - r, Math.PI / 2, 0);
  line(x1, z1 - r, x1, z0 + r); arc(x1 - r, z0 + r, 0, -Math.PI / 2);
  line(x1 - r, z0, x0 + r, z0); arc(x0 + r, z0 + r, -Math.PI / 2, -Math.PI);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
    let dh = h2 - h1; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.k = Math.abs(dh) / step; // curvature
    b.heading = h2;
  }
  return { pts, step };
}
// the same loop driven the other way round (for two-way traffic)
export function reverseRoute(route) {
  const pts = route.pts.slice().reverse().map((p) => ({ x: p.x, z: p.z, k: p.k, heading: 0 }));
  const n = pts.length;
  for (let i = 0; i < n; i++) { const b = pts[i], c = pts[(i + 1) % n]; b.heading = Math.atan2(c.x - b.x, c.z - b.z); }
  return { pts, step: route.step };
}

// A traffic driver: keeps its lane, follows traffic, and behaves like a person around you.
//  - predicts collision courses with every car (time to closest approach) and brakes / swerves away,
//    leaning on the horn when it's you
//  - honks if you cut in close in front of it (not if you were already ahead and just slow down)
//  - sat behind you while you're stopped: honks after a few seconds, again every few seconds, and
//    eventually pulls out into the other lane to get round you when it's clear
//  - after a crash it stops with its hazards on, waits, then pulls away gently; wrecked (on its roof,
//    a wheel off) it stays put
// Driver types. cruise: x the route's speed; latG: cornering grip they'll use; gap: following distance
// factor; react: + seconds; thr: max throttle; amber / red: chance to run an amber / a red; phone: chance
// to pick up the phone at a red light; lapses: random attention lapses while driving; flee: chance to
// try and get away from you when you chase or bump them.
export const DRIVER_TYPES = {
  calm: { cruise: 1, latG: 3.2, gap: 1, react: 0, thr: 0.75, amber: 0.15, red: 0, phone: 0.15, lapses: false, flee: 0.3 },
  slow: { cruise: 0.72, latG: 2.4, gap: 1.4, react: 0.2, thr: 0.5, amber: 0, red: 0, phone: 0.2, lapses: false, flee: 0.15 },
  racer: { cruise: 1.45, latG: 5.5, gap: 0.6, react: -0.15, thr: 1, amber: 1, red: 0.35, phone: 0.05, lapses: false, flee: 0.8 },
  distracted: { cruise: 0.95, latG: 3.0, gap: 1.1, react: 0.5, thr: 0.7, amber: 0.3, red: 0.05, phone: 0.75, lapses: true, flee: 0.1 },
};
export class AIDriver {
  // lane: lateral offset from the route's centre line (negative = to the right of the direction of travel)
  constructor(car, route, { cruise = 15, lane = -2, type } = {}) {
    this.car = car; this.route = route; this.cruise = cruise;
    this.setType(type || Object.keys(DRIVER_TYPES)[Math.floor(Math.random() * 4)]);
    this.state = 'cruising'; this.fleeT = 0; this.chaseT = 0; this.lapseT = 0; this.nextLapse = 8 + Math.random() * 15;
    this.phone = false; this.greenDelay = 0; this.lightPlan = new Map(); this.dbg = {};
    this.laneBase = lane; this.lane = lane; this.laneTarget = lane;
    this.idx = 0; this.steer = 0; this.t = 0;
    this.mode = 'drive'; this.wait = 0; this.resume = 99; this.hazardT = 0;
    this.pAhead = false; this.blockT = 0; this.nextBlockHonk = 0; this.passing = false; this.passT = 0;
    this.hornSeq = []; this.hornCool = 0; this.hornOn = false; this.flipT = 0;
    // a person: own reaction time, eyes forward (~200 deg, ~80 m), mirrors behind (~30 m, blind spots
    // over the shoulders). Things are only acted on once they've been seen for the reaction time.
    this.react = Math.max(0.35, 0.7 + Math.random() * 0.6 + this.T.react);
    this.seen = new Map(); // car -> seconds continuously seen
  }
  setType(t) { this.type = t; this.T = DRIVER_TYPES[t]; }
  get fleeing() { return this.fleeT > 0; }
  get hazard() { return this.mode !== 'drive' || this.hazardT > 0 || (this.damaged && this.car.speed < 1); }
  // the game reports every real impact (car, wall, bollard, ground): that's a crash for this driver
  onHit(speed, byPlayer) {
    if (speed > 1.5) this.damaged = true;
    // a bump from you might make them bolt instead of stopping (a hit-and-run, from their side)
    if (byPlayer && speed < 6 && this.mode === 'drive' && Math.random() < this.T.flee) { this.fleeT = 40; return; }
    if (speed > 3 && this.mode === 'drive' && !this.fleeing) { this.mode = 'crashed'; this.wait = 7 + Math.random() * 8; }
  }
  // a point on our lane (the route's centre line shifted sideways)
  laneAt(i) {
    const n = this.route.pts.length, p = this.route.pts[((i % n) + n) % n];
    return { x: p.x + Math.cos(p.heading) * this.lane, z: p.z - Math.sin(p.heading) * this.lane, heading: p.heading, k: p.k };
  }
  placeAt(i) {
    this.lane = this.laneTarget = this.laneBase; this.passing = false;
    const p = this.laneAt(i);
    resetCar(this.car, v3(p.x, 0, p.z), p.heading);
    this.car.gear = 2; this.idx = i;
    this.mode = 'drive'; this.resume = 99; this.hazardT = 0; this.blockT = 0; this.flipT = 0; this.pv = null; this.damaged = false; this.fleeT = 0; this.phone = false; // a teleport isn't a crash
  }
  nearest(windowOnly) {
    const { pts } = this.route, c = this.car, n = pts.length;
    let best = this.idx, bd = Infinity;
    const range = windowOnly ? 60 : n;
    for (let k = -10; k < range; k++) {
      const i = (this.idx + k + n) % n, p = this.laneAt(i);
      const d = (p.x - c.pos.x) ** 2 + (p.z - c.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, d: Math.sqrt(bd) };
  }
  honk(pattern) { // [[start offset s, duration s], ...]
    if (this.t < this.hornCool) return;
    this.hornSeq = pattern.map(([o, d]) => [this.t + o, d]);
    this.hornCool = this.t + Math.max(...pattern.map(([o, d]) => o + d)) + 1.5;
  }
  // what the driver can see of another car: 'front' | 'mirror' | null
  view(o) {
    const c = this.car, ox = o.pos.x - c.pos.x, oz = o.pos.z - c.pos.z, d = Math.hypot(ox, oz);
    const ang = Math.acos(clamp((ox * c.fwdBody.x + oz * c.fwdBody.z) / Math.max(d, 1e-3), -1, 1)) * 57.3;
    if (ang < 100) return d < 80 ? 'front' : null;
    if (ang > 150) return d < 30 ? 'mirror' : null; // rear-view + door mirrors
    return d < 4 ? 'front' : null; // blind spot (unless it's right beside us)
  }
  // seconds this car has been noticed for, minus our reaction time (> 0 = we're responding to it)
  aware(o) {
    const s = this.seen.get(o);
    return s ? s.t - this.react * (s.how === 'mirror' ? 1.6 : 1) : -1;
  }
  // police: { lights, siren } of the player's car (emergency lights / siren on), or null
  update(dt, cars, player, police = null) {
    const c = this.car, { pts, step } = this.route, n = pts.length;
    this.t += dt; this.atLight = false; this.nearRed = false; this.dbg = {};
    const T = this.T, flee = this.fleeing;
    this.fleeT = Math.max(0, this.fleeT - dt);
    // attention lapses (distracted drivers): eyes off the road, nothing new gets noticed, the car wanders
    if (T.lapses && this.t > this.nextLapse && this.lapseT <= 0) { this.lapseT = 1.2 + Math.random() * 2; this.nextLapse = this.t + 10 + Math.random() * 20; }
    this.lapseT = Math.max(0, this.lapseT - dt);
    const lapse = this.lapseT > 0 || (this.phone && this.atLightPrev);
    if (!lapse) for (const o of cars) {
      if (o === c) continue;
      const how = this.view(o), s = this.seen.get(o);
      if (!how) this.seen.delete(o); else if (s) { s.t += dt; s.how = how; } else this.seen.set(o, { t: 0, how });
    }
    const v = Math.max(0, c.fwdSpeed);
    // horn
    this.hornOn = this.hornSeq.some(([t0, d]) => this.t >= t0 && this.t < t0 + d);
    this.hornSeq = this.hornSeq.filter(([t0, d]) => this.t < t0 + d);
    this.hazardT = Math.max(0, this.hazardT - dt);

    // ---- crashed / wrecked: stop, hazards, wait
    // a crash shows up as a sudden velocity jump (collision impulses act directly on velocity)
    const pv = this.pv || c.vel, jerk = Math.hypot(c.vel.x - pv.x, c.vel.z - pv.z) / Math.max(dt, 1e-4);
    this.pv = { x: c.vel.x, y: c.vel.y, z: c.vel.z };
    const hit = jerk > 35; // > 3.5 g in one step: we hit something
    this.flipT = c.up.y < 0.4 ? this.flipT + dt : 0;
    if (this.mode !== 'disabled' && (this.flipT > 1 || c.wheels.some((w) => w.detached))) this.mode = 'disabled';
    else if (hit && this.mode === 'drive') { this.mode = 'crashed'; this.wait = 7 + Math.random() * 8; }
    if (this.mode !== 'drive') {
      this.state = this.mode === 'disabled' ? 'wrecked' : 'crashed';
      if (this.mode === 'crashed' && v < 0.5) this.wait -= dt;
      if (this.mode === 'crashed' && this.wait <= 0) { this.mode = 'drive'; this.resume = 0; this.hazardT = 6; }
      // the driver needs a moment to get on the brakes after being hit: the car slides free first
      this.crashT = (this.crashT || 0) + dt;
      const onBrakes = this.crashT > 0.7 + this.react * 0.5;
      c.input.throttle = 0; c.input.brake = onBrakes ? 1 : 0; c.input.handbrake = onBrakes && v < 0.5 ? 1 : 0; c.input.clutch = 0;
      c.input.steer = this.steer *= 0.95;
      return;
    }
    this.resume += dt; this.crashT = 0;

    let { i, d } = this.nearest(true);
    if (d > 12) ({ i, d } = this.nearest(false));
    this.idx = i;
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * (this.yielding ? 1.3 : 0.7)); // lane changes take a couple of seconds (quicker when giving way)

    // ---- steering: pure pursuit along our lane
    const look = clamp(4 + v * 0.5, 5, 16);
    const t = this.laneAt(i + Math.round(look / step));
    const rx = t.x - c.pos.x, rz = t.z - c.pos.z;
    const lx = rx * c.leftBody.x + rz * c.leftBody.z, lz = rx * c.fwdBody.x + rz * c.fwdBody.z;
    const alpha = Math.atan2(lx, lz);
    let want = clamp(Math.atan((2 * c.P.wheelbase * Math.sin(alpha)) / look) / c.P.maxSteer, -1, 1);
    this.dbg.target = t;
    if (this.lapseT > 0) want += Math.sin(this.t * 0.9) * 0.06; // drifting in the lane while not looking
    let state = 'cruising';

    // ---- speed: cruise, slow for the bends ahead, ease away gently after a crash
    const latG = flee ? 6 : T.latG;
    let vT = Math.min(flee ? 30 : 26, this.cruise * T.cruise * (flee ? 1.8 : 1));
    for (let k = 0; k < 50 / step; k += 2) vT = Math.min(vT, Math.sqrt(latG / Math.max(pts[(i + k) % n].k, 1e-4)) + k * step * 0.12);
    if (flee) state = 'fleeing';
    if (this.resume < 20) vT = Math.min(vT, 1 + this.resume * 0.8);
    if (this.passing) vT = Math.min(vT, 7);

    const rel = (o) => { // other car in our frame: ahead, side (+ = left), same direction?
      const ox = o.pos.x - c.pos.x, oz = o.pos.z - c.pos.z;
      return { ahead: ox * c.fwdBody.x + oz * c.fwdBody.z, side: ox * c.leftBody.x + oz * c.leftBody.z, same: o.fwdBody.x * c.fwdBody.x + o.fwdBody.z * c.fwdBody.z > 0.3 };
    };
    // ---- follow traffic going our way in our lane (stop behind it). Oncoming cars aren't "traffic
    // ahead" - only the collision prediction below deals with them. A stopped oncoming car in our path
    // (a face-off): creep and squeeze to our right instead of freezing nose to nose.
    for (const o of cars) {
      if (o === c || (this.passing && o === player) || this.aware(o) < 0) continue;
      const r = rel(o);
      if (r.ahead <= 0 || Math.abs(r.side) > 2.4) continue;
      if (r.same || o === player) { const g = T.gap * (flee ? 0.5 : 1); if (r.ahead < (8 + v * 2.2) * g && Math.abs(r.side) < 2.2) { const lim = Math.max(0, (r.ahead - 7 * Math.max(g, 0.7)) * 0.5); if (lim < vT) { vT = lim; if (state === 'cruising') state = 'following'; } } }
      else if (r.ahead < 16 && o.speed < 1) { vT = Math.min(vT, 1.5); want = clamp(want - 0.35, -1, 1); }
    }

    // ---- collision prediction, proportionate: only a predicted meeting point in our lane, ahead of
    // us, is a real threat. Someone merely heading our way (off the road, or passing) makes us ease
    // off; a crossing with time to spare, slow down; only an imminent hit means hard braking, a
    // last-moment swerve, and the horn.
    let brakeHard = 0;
    for (const o of cars) {
      if (o === c || this.aware(o) < 0) continue; // haven't seen it yet / still reacting
      const rx2 = o.pos.x - c.pos.x, rz2 = o.pos.z - c.pos.z, ux = o.vel.x - c.vel.x, uz = o.vel.z - c.vel.z, uu = ux * ux + uz * uz;
      if (uu < 0.5) continue;
      const tc = -(rx2 * ux + rz2 * uz) / uu;
      if (tc <= 0 || tc > 4) continue;
      if (rx2 * c.fwdBody.x + rz2 * c.fwdBody.z < -2) continue; // from behind: hold the line
      const cx = rx2 + ux * tc, cz = rz2 + uz * tc, dmin = Math.hypot(cx, cz);
      // where we'd meet, in our frame, at the moment of closest approach
      const mx = c.pos.x + c.vel.x * tc + cx, mz = c.pos.z + c.vel.z * tc + cz;
      const ml = (mx - c.pos.x) * c.leftBody.x + (mz - c.pos.z) * c.leftBody.z, ma = (mx - c.pos.x) * c.fwdBody.x + (mz - c.pos.z) * c.fwdBody.z;
      const inPath = ma > -1 && Math.abs(ml) < 2.4 && dmin < 2.8;
      if (!inPath) { if (dmin < 6) vT = Math.min(vT, v * 0.85); continue; } // just wary
      this.dbg.threat = o;
      if (tc < 1.4 && dmin < 1.9) { // it's happening
        state = 'avoiding';
        brakeHard = Math.max(brakeHard, clamp(1.6 - tc, 0.6, 1));
        vT = 0;
        if (tc < 0.9 && v > 5) { const sideAt = cx * c.leftBody.x + cz * c.leftBody.z; want = clamp(want - Math.sign(sideAt || 1) * 0.35, -1, 1); }
        if (o === player) this.honk([[0, 1.1]]);
      } else { vT = Math.min(vT, v * clamp(0.35 + 0.15 * tc, 0.4, 0.9)); if (state !== 'avoiding') state = 'wary'; } // slow down, keep watching
    }
    // ---- junctions: the light, and what this driver does about it
    if (this.nodes) this.nodes.forEach((nd, ni) => {
      const ax = nd[0] - c.pos.x, az = nd[1] - c.pos.z, ah = ax * c.fwdBody.x + az * c.fwdBody.z;
      if (ah < -6 || ah > 45 || Math.abs(ax * c.leftBody.x + az * c.leftBody.z) > 14) { this.lightPlan.delete(ni); return; }
      const ns = Math.abs(c.fwdBody.z) > Math.abs(c.fwdBody.x), light = signals.state(ni, ns);
      const stopDist = ah - 13.5; // the stop line sits 12 m before the junction centre
      const canStop = stopDist > (v * v) / (2 * 3.5);
      // decide once per light phase whether to run it
      let plan = this.lightPlan.get(ni);
      if (!plan || plan.light !== light) { plan = { light, run: light === 'red' ? Math.random() < (flee ? 1 : T.red) && v > 6 : light === 'amber' ? !canStop || Math.random() < (flee ? 1 : T.amber) : false }; this.lightPlan.set(ni, plan); }
      if (light !== 'green' && stopDist > -0.5 && stopDist < 40) this.nearRed = true; // the queue ahead is waiting: no honking
      if (stopDist > -0.5 && light !== 'green' && !plan.run) {
        vT = Math.min(vT, Math.max(0, stopDist * 0.55));
        state = v > 1 ? 'stopping for ' + light : 'waiting at red';
        this.dbg.stopAt = { x: c.pos.x + c.fwdBody.x * stopDist, z: c.pos.z + c.fwdBody.z * stopDist };
        if (stopDist < 0.6) { this.atLight = true; if (!this.lightDecided && v < 0.5) { this.lightDecided = true; this.phone = Math.random() < T.phone; this.greenDelay = this.phone ? 2 + Math.random() * 6 : 0.3 + this.react * 0.5; } }
      } else if (stopDist > -0.5 && light !== 'green' && plan.run) state = 'running ' + light;
      else if (stopDist > -0.5 && light === 'green' && this.atLightPrev && this.greenDelay > 0) { // waiting to notice the green
        this.greenDelay -= dt; vT = 0; this.atLight = true; state = this.phone ? 'on the phone' : 'pulling away';
      } else if (ah < 30) vT = Math.min(vT, (flee ? 14 : 8) + Math.max(0, ah - 12) * 0.4);
    });
    if (!this.atLight) { this.phone = false; this.lightDecided = false; }
    if (this.phone && this.atLight && state === 'waiting at red') state = 'on the phone at red';

    // ---- an emergency vehicle (you, with lights / siren on). A siren is heard all round (~90 m); lights
    // only count once seen (windscreen or mirrors). Once noticed (after the reaction time), each
    // encounter: some drivers bolt (racers most), the rest give way - siren: brake gently, pull over
    // to the right and stop until you've gone past; lights only: move right and ease off while you're close.
    const em = player && police && (police.lights || police.siren) ? police : null;
    let yield_ = null;
    if (em) {
      const ox = player.pos.x - c.pos.x, oz = player.pos.z - c.pos.z, dist = Math.hypot(ox, oz);
      const pa = ox * c.fwdBody.x + oz * c.fwdBody.z; // + = you're ahead of us
      const heard = em.siren && dist < 90, seen = dist < 60 && (this.aware(player) > 0 || pa < 0); // flashing lights catch the eye in the mirror from well back
      this.emT = heard || seen ? (this.emT || 0) + dt : 0;
      if (this.emT > this.react) {
        this.emOffT = 0;
        if (!this.emRolled) { this.emRolled = true; if (Math.random() < T.flee * 0.7) this.fleeT = 45; }
        if (this.fleeing) { if (dist < 80) this.fleeT = Math.max(this.fleeT, 12); } // keep running while you're on them
        else if (em.siren && pa < 8 && dist < 70) yield_ = 'stop';
        else if (pa < 4 && dist < 45) yield_ = 'move';
      }
    } else this.emT = 0;
    if (!em || this.emT === 0) { this.emOffT = (this.emOffT || 0) + dt; if (this.emOffT > 10) this.emRolled = false; } // a new encounter later on
    if (yield_ && !this.fleeing) {
      this.laneTarget = this.laneBase - (yield_ === 'stop' ? 2.6 : 1.6); // over to the right
      if (yield_ === 'stop') {
        this.pullV = Math.min(this.pullV ?? v, v + 0.5) - 2.4 * dt; // a steady, gentle stop
        // keep rolling at walking pace until we're actually over at the side, then stop
        const over = Math.abs(this.lane - this.laneTarget) < 0.35;
        vT = Math.min(vT, Math.max(over ? 0 : Math.min(v, 2.5), this.pullV));
        state = v > 0.5 ? 'pulling over' : 'stopped for police';
      } else { vT = Math.min(vT, this.cruise * T.cruise * 0.6); state = 'moving over for police'; this.pullV = null; }
      this.yielding = true;
    } else if (this.yielding) {
      this.yielding = false; this.pullV = null;
      if (!this.passing) this.laneTarget = this.laneBase;
      if (v < 2) this.resume = 0; // pull away gently
    }

    // ---- being chased: you right behind them for a while -> some drivers try to get away
    if (player && !flee && !this.yielding) {
      const ox = player.pos.x - c.pos.x, oz = player.pos.z - c.pos.z, pa = ox * c.fwdBody.x + oz * c.fwdBody.z;
      this.chaseT = pa < -2 && pa > -12 && player.speed > 6 && this.aware(player) > 0 ? this.chaseT + dt : Math.max(0, this.chaseT - dt);
      if (this.chaseT > 4) { this.chaseT = 0; if (Math.random() < T.flee) this.fleeT = 35; }
    }

    // ---- you: cut in front of me / sitting stopped in front of me
    if (player) {
      const r = rel(player), inLane = r.ahead > 2 && r.ahead < 12 + v * 1.2 && Math.abs(r.side) < 2.2;
      if (inLane && !this.pAhead && this.aware(player) > -this.react + 0.2 && v > 4 && r.ahead < 6 + v * 0.8) this.honk([[0, 0.22], [0.32, 0.35]]); // cut-in: toot-toot
      this.pAhead = inLane;
      const blocked = !this.yielding && inLane && r.ahead < 15 && player.speed < 0.7 && v < 0.7 && !this.passing && !this.atLight && !this.nearRed;
      this.blockT = blocked ? this.blockT + dt : Math.max(0, this.blockT - dt * 2);
      if (this.blockT > 4 && this.t > this.nextBlockHonk) { this.honk([[0, 0.9]]); this.nextBlockHonk = this.t + 5; }
      if (blocked) state = this.blockT > 4 ? 'honking at you' : 'waiting behind you';
      if (this.blockT > 12 && !this.passing) { // give up waiting: go round when the other lane is clear
        const clear = !cars.some((o) => { if (o === c || o === player) return false; const q = rel(o); return !q.same && q.ahead > -5 && q.ahead < 70; });
        if (clear) { this.passing = true; this.passT = 0; this.laneTarget = -this.laneBase; this.blockT = 0; }
      }
      if (this.passing) {
        this.passT += dt; state = 'overtaking you';
        // oncoming traffic before we're past you: abort, tuck back in, try again later
        const oncoming = cars.some((o) => { if (o === c || o === player) return false; const q = rel(o); return !q.same && q.ahead > 0 && q.ahead < 45; });
        if (oncoming && r.ahead > -2) { this.passing = false; this.laneTarget = this.laneBase; this.blockT = 6; }
        else if (r.ahead < -8 || this.passT > 20) { this.passing = false; this.laneTarget = this.laneBase; }
      }
    }

    if (this.lapseT > 0 && state === 'cruising') state = 'not looking';
    this.state = state; this.atLightPrev = this.atLight; this.vT = vT;
    this.steer += clamp(want - this.steer, -(flee ? 4 : 2.5) * dt, (flee ? 4 : 2.5) * dt);
    const err = vT - v;
    c.input.throttle = brakeHard ? 0 : clamp(err * (T.thr > 0.9 || flee ? 0.6 : 0.35), 0, flee ? 1 : T.thr);
    c.input.brake = brakeHard || (err < -0.6 ? clamp(-err * 0.18, 0, 0.8) : vT < 0.3 && v < 1 ? 0.4 : 0);
    c.input.steer = this.steer;
    c.input.handbrake = 0; c.input.clutch = 0;
    if (c.gear < 2) c.gear = 2;
  }
  nearestTo(p) {
    let best = 0, bd = Infinity;
    this.route.pts.forEach((q, i) => { const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2; if (d < bd) { bd = d; best = i; } });
    return { i: best, d: Math.sqrt(bd) };
  }
}
