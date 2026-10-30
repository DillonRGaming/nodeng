// Lamp logic and glow for one car: drives the model's lamp groups (emissive masks + lit overlays),
// camera-facing glow flares, coloured light pooled on the ground, and — for the player's car —
// real headlight spotlights with low/high beam and a faint visible beam at night.
import * as THREE from 'three';

const flareTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.6)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const poolTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();

// colour, emissive gain (multiplies the lamp texture), flare size (m)
const LOOK = {
  head: { col: 0xf2f6ff, gain: 7, flare: 0.9 },
  drl: { col: 0xf6f8ff, gain: 4, flare: 0.45 },
  tail: { col: 0xff1a10, gain: 3.5, flare: 0.55 },
  brake: { col: 0xff1408, gain: 6, flare: 0.28 },
  turn: { col: 0xffa020, gain: 6, flare: 0.6 },
  reverse: { col: 0xffffff, gain: 2.5, flare: 0.5 },
};

export class LightRig {
  constructor(inst, carGroup, scene, { player }) {
    this.inst = inst; this.scene = scene; this.player = player;
    this.broken = {}; // key -> true when smashed
    this.blink = 0;
    this.flares = {};
    for (const [key, list] of Object.entries(inst.spots)) list.forEach((spot, si) => {
      const look = LOOK[key.slice(0, -1)];
      const mat = new THREE.SpriteMaterial({ map: flareTex, color: look.col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const s = new THREE.Sprite(mat);
      // sit just proud of the lens so the body doesn't hide it
      s.position.copy(spot.pos).add(new THREE.Vector3(0, 0, spot.front ? 0.06 : -0.06));
      s.renderOrder = 5;
      carGroup.add(s);
      this.flares[key + si] = { key, sprite: s, spot, look };
    });
    // light thrown on the ground (cheap additive decals): ahead of the car and behind it
    const pool = (col) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: poolTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -8 }));
      m.renderOrder = 2; scene.add(m); return m;
    };
    this.poolFront = pool(0xfff4e0);
    this.poolRear = pool(0xff2010);
    this.poolRev = pool(0xffffff);
    if (player) this.makeHeadlights(carGroup);
  }

  makeHeadlights(carGroup) {
    this.spots = [];
    // one spotlight centred between the headlamps (each light in the scene costs every lit pixel)
    const heads = ['L', 'R'].map((sd) => (this.inst.spots['head' + sd] || this.inst.spots['drl' + sd])?.find((p) => p.front)).filter(Boolean);
    if (heads.length) {
      const c = heads.reduce((a, h) => a.add(h.pos), new THREE.Vector3()).multiplyScalar(1 / heads.length);
      const sl = new THREE.SpotLight(0xfff2dc, 0, 70, 0.62, 0.75, 1.4);
      sl.position.copy(c);
      sl.target.position.copy(c).add(new THREE.Vector3(0, -1.1, 18));
      sl.visible = false;
      carGroup.add(sl, sl.target);
      this.spots.push(sl);
    }
  }

  // a lamp whose housing got crushed is smashed
  checkCrush(crushAt) {
    for (const f of Object.values(this.flares)) {
      if (this.broken[f.key]) continue;
      const p = f.spot.pos;
      if (crushAt(p.x, p.y, p.z) > 0.07) this.broken[f.key] = true;
    }
  }
  repair() { this.broken = {}; }
  // take everything this rig added off the car and out of the scene (vehicle swap)
  dispose() {
    for (const f of Object.values(this.flares)) { f.sprite.parent?.remove(f.sprite); f.sprite.material.dispose(); }
    for (const p of [this.poolFront, this.poolRear, this.poolRev]) { this.scene.remove(p); p.geometry.dispose(); p.material.dispose(); }
    for (const sl of this.spots || []) { sl.parent?.remove(sl); sl.target.parent?.remove(sl.target); }
  }

  update(car, st, cam, dt, carGroup, groundY) {
    // st: { headlights: 0 off | 1 low | 2 high, indicator: -1/0/1, hazard, night }
    this.blink = (this.blink + dt) % 0.75;
    const blinkOn = this.blink < 0.4;
    const braking = car.input.brake > 0.05;
    const headOn = st.headlights > 0;
    const levels = {
      head: headOn ? (st.headlights === 2 ? 1.25 : 1) : 0,
      drl: headOn ? 0.55 : 1, // daytime running lights dim to position lights with the headlights
      tail: braking ? 1 : headOn ? 0.45 : 0,
      brake: braking ? 1 : 0,
      reverse: car.gear === 0 ? 1 : 0,
    };
    const turn = { L: (st.hazard || st.indicator > 0) && blinkOn ? 1 : 0, R: (st.hazard || st.indicator < 0) && blinkOn ? 1 : 0 };
    const night = st.night ? 1 : 0;

    for (const [key, L] of Object.entries(this.inst.lights)) {
      const g = key.slice(0, -1), side = key.slice(-1);
      let lv = g === 'turn' ? turn[side] : levels[g];
      if (this.broken[key]) lv = 0;
      for (const m of L.mats) m.emissiveIntensity = lv * LOOK[g].gain;
      for (const o of L.overlays) o.visible = lv > 0.01;
    }

    // flares: brighter when you look into the lamp, much stronger at night
    const camLocal = carGroup.worldToLocal(cam.position.clone());
    for (const f of Object.values(this.flares)) {
      const key = f.key, g = key.slice(0, -1), side = key.slice(-1);
      let lv = g === 'turn' ? turn[side] : levels[g];
      if (this.broken[key]) lv = 0;
      const to = camLocal.clone().sub(f.sprite.position);
      const dist = to.length();
      const facing = Math.max(0, (f.spot.front ? 1 : -1) * to.z / dist);
      const view = Math.pow(facing, 1.5);
      f.sprite.material.opacity = lv * view * (0.2 + 0.5 * night);
      const s = f.look.flare * (0.5 + 0.5 * night) * (g === 'head' && st.headlights === 2 ? 1.3 : 1) * (0.6 + Math.min(dist / 30, 1));
      f.sprite.scale.set(s, s, 1);
    }

    // ground pools
    const yaw = Math.atan2(car.fwdBody.x, car.fwdBody.z);
    const place = (m, ahead, w, l, op) => {
      m.position.set(car.pos.x + car.fwdBody.x * ahead, groundY + 0.02, car.pos.z + car.fwdBody.z * ahead);
      m.rotation.y = yaw; m.scale.set(w, 1, l); m.material.opacity = op;
    };
    const air = Math.max(0, 1 - (car.pos.y - groundY - car.P.cgHeight) / 1.5);
    const headPool = this.player && st.night ? 0 : levels.head; // at night the player car uses real spotlights instead
    place(this.poolFront, 9, 6, 14, headPool * 0.4 * night * air);
    place(this.poolRear, car.P.body.zR - 0.45, 2.0, 1.1, levels.tail * 0.12 * night * air);
    place(this.poolRev, car.P.body.zR - 1.2, 2.2, 2.4, levels.reverse * 0.25 * night * air);

    if (this.spots) {
      const hi = st.headlights === 2;
      // real spotlights only at night: every lit pixel pays for a light in the scene, even at 0 intensity
      const wantSpots = headOn && st.night;
      const nBroken = (this.broken.headL ? 1 : 0) + (this.broken.headR ? 1 : 0);
      this.spots.forEach((sl) => {
        sl.visible = wantSpots && nBroken < 2;
        sl.intensity = (hi ? 1300 : 600) * (1 - nBroken * 0.5);
        sl.angle = hi ? 0.5 : 0.65;
        sl.distance = hi ? 140 : 70;
        sl.target.position.y = sl.position.y + (hi ? -0.4 : -1.2);
        sl.target.position.z = sl.position.z + (hi ? 30 : 18);
      });
    }
  }
}
