// Vehicle fires: flames out of the engine bay that grow and spread over the car, a thick column of black
// smoke leaning with the wind, a flickering orange light, and the body slowly charring.
//  - flames: their own additive point sprites (white-yellow core -> orange -> deep red as they rise and
//    cool), shaped like licking tongues by a noise texture, short-lived and fast-rising
//  - smoke: big dark billows through the game's regular smoke particles (passed in as `emitSmoke`),
//    long-lived, buoyant, drifting downwind so the column leans and spreads
//  - light: a couple of point lights created up front (adding lights later would recompile every shader)
import * as THREE from 'three';

const MAXF = 900;
const WIND = new THREE.Vector3(1.6, 0, 0.7); // m/s, the plume leans this way

export class FireSystem {
  constructor(scene, noiseTex, emitSmoke) {
    this.emitSmoke = emitSmoke;
    this.t = 0;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAXF * 3); this.size = new Float32Array(MAXF); this.age = new Float32Array(MAXF); this.seed = new Float32Array(MAXF);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('age', new THREE.BufferAttribute(this.age, 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(this.seed, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { tex: { value: noiseTex }, uTime: { value: 0 }, uBoost: { value: 1 } },
      vertexShader: `attribute float size, age, seed; varying float vAge, vSeed;
        void main() { vAge = age; vSeed = seed; vec4 mv = modelViewMatrix * vec4(position, 1.);
          gl_PointSize = age < 0. ? 0. : size * ${(innerHeight / 2).toFixed(1)} / -mv.z; gl_Position = projectionMatrix * mv; }`,
      // a tongue of flame: narrow at the top, eaten away by scrolling noise; colour from how hot it
      // still is (young = white-yellow core, then orange, then a dull red before it vanishes)
      fragmentShader: `uniform sampler2D tex; uniform float uTime, uBoost; varying float vAge, vSeed;
        void main() { if (vAge < 0.) discard;
          vec2 d = gl_PointCoord - 0.5; d.y = -d.y;
          // soft licking blob: round body, ragged by two scrolling noise layers, thinning upward
          float n = texture2D(tex, vec2(d.x * 0.9 + vSeed, d.y * 0.8 - uTime * 1.6 + vSeed * 3.)).r;
          float n2 = texture2D(tex, vec2(d.x * 2.1 - vSeed, d.y * 1.9 - uTime * 2.7)).r;
          float r = length(vec2(d.x * (1.25 + max(d.y, 0.) * 1.6), d.y + 0.08)) * 2.;
          float a = smoothstep(1., 0.25, r + (n - 0.5) * 1.2 + (n2 - 0.5) * 0.6);
          if (a <= 0.01) discard;
          // colour: mostly saturated orange-red; only the youngest, densest bits run yellow
          float heat = clamp(1. - vAge * 1.25 + (n - 0.5) * 0.35, 0., 1.) * a;
          vec3 col = mix(vec3(0.35, 0.02, 0.0), vec3(0.95, 0.2, 0.01), smoothstep(0.05, 0.45, heat));
          col = mix(col, vec3(1., 0.45, 0.04), smoothstep(0.45, 0.75, heat));
          col = mix(col, vec3(1., 0.72, 0.22), smoothstep(0.8, 1., heat));
          float fade = (1. - smoothstep(0.6, 1., vAge)) * smoothstep(0., 0.1, vAge);
          gl_FragColor = vec4(col * a * fade * 0.45 * uBoost, 1.); }`,
    });
    this.pts = new THREE.Points(geo, this.mat);
    this.pts.frustumCulled = false; this.pts.renderOrder = 6;
    scene.add(this.pts);
    this.parts = Array.from({ length: MAXF }, () => ({ life: 0, max: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), s0: 0.5, s1: 0.3 }));
    this.idx = 0;
    this.age.fill(-1);
    // fire light: always in the scene (intensity 0 when unused) so the shader light count never changes
    this.lights = [0, 1].map(() => { const l = new THREE.PointLight(0xff7a2a, 0, 0, 2); scene.add(l); return l; });
  }

  // set a vehicle burning (already burning: no-op). delay: seconds of smoking before it catches
  ignite(v, delay = 0) {
    if (v.fire) return;
    v.fire = { t: -delay, I: 0, mats: null, smokeAcc: 0, flameAcc: 0 };
  }
  extinguish(v) {
    if (!v.fire) return;
    for (const [m, col, rough] of v.fire.mats || []) { m.color.copy(col); m.roughness = rough; }
    v.fire = null;
  }

  flame(p, v, life, s0, s1) {
    const i = this.idx, q = this.parts[i]; this.idx = (i + 1) % MAXF;
    q.life = life; q.max = life; q.p.copy(p); q.v.copy(v); q.s0 = s0; q.s1 = s1;
    this.seed[i] = Math.random() * 10;
  }

  update(dt, vehicles, night) {
    this.t += dt;
    this.mat.uniforms.uTime.value = this.t;
    this.mat.uniforms.uBoost.value = night ? 1.25 : 1;
    const burning = [];
    const _p = new THREE.Vector3(), _v = new THREE.Vector3();
    for (const veh of vehicles) {
      const F = veh.fire;
      if (!F || !veh.inst) continue;
      F.t += dt;
      const g = veh.group, b = veh.car.P.body;
      const front = b.zF - 0.55, hoodY = b.yHi * 0.45; // engine bay (car frame)
      const toWorld = (x, y, z) => _p.set(x, y, z).applyQuaternion(g.quaternion).add(g.position);
      if (F.t < 0) { // still smouldering: grey smoke leaking out from under the bonnet
        F.smokeAcc += dt * 9;
        for (; F.smokeAcc >= 1; F.smokeAcc--) {
          const p = toWorld((Math.random() - 0.5) * 1.2, hoodY, front + (Math.random() - 0.5) * 0.8);
          this.emitSmoke(p.clone(), new THREE.Vector3(WIND.x * 0.3 + (Math.random() - 0.5) * 0.5, 0.8 + Math.random() * 0.6, WIND.z * 0.3), { life: 3 + Math.random() * 2, s0: 0.3, s1: 1.8, c: [0.42, 0.42, 0.43], a: 0.35, rise: 0.4, drag: 0.6 });
        }
        continue;
      }
      // grows from a small engine fire to the whole front of the car in ~25 s, then the cabin
      F.I = Math.min(1, 0.12 + F.t / 25);
      const spread = Math.min(1, Math.max(0, (F.t - 10) / 30)); // how far back along the car it has spread
      burning.push({ veh, p: toWorld(0, hoodY + 0.3, front - spread * 1.2).clone(), I: F.I });
      // flames
      F.flameAcc += dt * (50 + 170 * F.I);
      for (; F.flameAcc >= 1; F.flameAcc--) {
        const zBack = front + 0.5 - Math.random() * (1.0 + spread * (b.zF - b.zR - 1.2));
        const x = (Math.random() - 0.5) * 2 * b.x * (0.55 + 0.35 * spread);
        const y = (zBack > b.zF - 1.3 ? hoodY : b.yHi * (0.6 + 0.3 * Math.random())) - 0.1 + Math.random() * 0.15;
        const p = toWorld(x, y, zBack);
        _v.set(WIND.x * 0.3 + (Math.random() - 0.5) * 0.7, 1.0 + Math.random() * 1.3 * (0.5 + F.I), WIND.z * 0.3 + (Math.random() - 0.5) * 0.7);
        const s = (0.45 + Math.random() * 0.7) * (0.6 + 0.8 * F.I);
        this.flame(p, _v, 0.3 + Math.random() * 0.35, s, s * 1.2);
      }
      // thick black smoke: big, long-lived, buoyant billows rising off the flames and leaning downwind
      F.smokeAcc += dt * (8 + 26 * F.I);
      for (; F.smokeAcc >= 1; F.smokeAcc--) {
        const zBack = front - Math.random() * (0.6 + spread * 2);
        const p = toWorld((Math.random() - 0.5) * b.x, b.yHi + 0.2 + Math.random() * 0.4, zBack).clone();
        const k = 0.018 + Math.random() * 0.03;
        this.emitSmoke(p, new THREE.Vector3(WIND.x * (0.6 + Math.random() * 0.5) + (Math.random() - 0.5), 2.4 + Math.random() * 2 * F.I + 1.5 * F.I, WIND.z * (0.6 + Math.random() * 0.5) + (Math.random() - 0.5)),
          { life: 11 + Math.random() * 7, s0: 1.2 + 1.4 * F.I, s1: 7 + Math.random() * 7 * F.I + 4 * F.I, c: [k, k, k * 1.04], a: 0.75 + 0.2 * F.I, rise: 0.3, drag: 0.1, hold: 0.55 });
      }
      // char the body: paint and trim darken towards burnt black (front first is implied by the flames)
      if (!F.mats) {
        F.mats = [];
        const seen = new Set();
        veh.inst.body.traverse((o) => { const m = o.isMesh && o.material; if (!m || seen.has(m) || !m.color || m.transparent || m.emissiveIntensity > 0) return; seen.add(m); F.mats.push([m, m.color.clone(), m.roughness ?? 0.5]); });
      }
      const char = Math.min(0.92, F.t / 70);
      for (const [m, col, rough] of F.mats) { m.color.copy(col).lerp(_char, char); if (m.roughness !== undefined) m.roughness = rough + (0.95 - rough) * char; }
    }
    // flame particles
    for (let i = 0; i < MAXF; i++) {
      const q = this.parts[i];
      if (q.life > 0) {
        q.life -= dt;
        q.v.y += 1.6 * dt; // hot gas accelerates upward
        q.p.addScaledVector(q.v, dt);
        const t = 1 - q.life / q.max;
        this.pos[i * 3] = q.p.x; this.pos[i * 3 + 1] = q.p.y; this.pos[i * 3 + 2] = q.p.z;
        this.size[i] = q.s0 + (q.s1 - q.s0) * t; this.age[i] = t;
      } else this.age[i] = -1;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.size.needsUpdate = true; this.geo.attributes.age.needsUpdate = true; this.geo.attributes.seed.needsUpdate = true;
    // the two biggest fires light their surroundings, flickering
    burning.sort((a, b) => b.I - a.I);
    this.lights.forEach((l, k) => {
      const f = burning[k];
      if (!f) { l.intensity = 0; return; }
      l.position.copy(f.p);
      const flick = 0.75 + 0.25 * Math.sin(this.t * 23 + k) * Math.sin(this.t * 7.3 + k * 2) + (Math.random() - 0.5) * 0.15;
      l.intensity = (night ? 260 : 90) * f.I * flick;
    });
  }
}
const _char = new THREE.Color(0x0d0b0a);
