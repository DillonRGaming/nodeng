// Police kit for a car instance (US patrol style: black car, white slanted livery): decals projected
// onto the body, a slim roof lightbar, a tall push bar with LED pods and a roof antenna. Everything is
// built in the car frame (CG origin, forward +z, left +x) from rays cast at the undamaged body, and
// bound to the car's soft-body lattice so it dents and bends with the panels it sits on.
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { bindGeometry, latticeMaterial } from './softbody.js';

export const POLICE_PAINT = 0x0b0c0e;
const FONT = (px, w = 900) => `italic ${w} ${px}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// side livery (front of the car on the left of the canvas on both sides, see the decal rotations):
// big slanted POLICE over the doors and rear quarter, INTERCEPTOR under it, thin green accent line
// low down, a small 911 badge on the rear quarter
const sideTex = (frontLeft) => canvasTex(2048, 512, (g, w, h) => {
  const L = (x) => (frontLeft ? x : w - x); // mirror the layout (not the text) so it stays anchored to the car's front
  g.fillStyle = '#ffffff'; g.textBaseline = 'alphabetic';
  // POLICE: tall, heavy, slanted, with letters slightly stretched
  // slanted by hand (an italic of the heavy fonts is often missing), always leaning the reading way
  const slant = (x, y, s) => { g.setTransform(s, 0, -0.24 * s, s, x, y); };
  g.textAlign = frontLeft ? 'left' : 'right'; g.font = FONT(250);
  const sx = 1720 / g.measureText('POLICE').width; // extended letters, stretched to fill doors + rear quarter
  slant(L(70), 335, 1); g.transform(sx, 0, 0, 1.25, 0, 0); g.fillText('POLICE', 0, 0);
  g.font = FONT(64, 800); slant(L(300), 415, 1); g.fillText('INTERCEPTOR', 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // green accent: a thin line rising slightly towards the rear
  g.strokeStyle = '#1fae4a'; g.lineWidth = 10; g.beginPath();
  g.moveTo(L(120), 490); g.lineTo(L(1300), 470); g.stroke();
  // 911 badge on the rear quarter
  g.font = FONT(70, 900); g.textAlign = 'center'; g.fillText('911', L(1935), 330);
  g.font = FONT(20, 700); g.fillText('EMERGENCY', L(1935), 262); g.fillText('RESPONSE', L(1935), 356);
});
const fenderTex = () => canvasTex(1024, 128, (g, w, h) => {
  g.fillStyle = '#ffffff'; g.font = FONT(64, 800); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('TO PROTECT & SERVE', w / 2, h / 2);
});
const unitTex = (n) => canvasTex(256, 128, (g, w, h) => {
  g.fillStyle = '#ffffff'; g.font = FONT(84, 900); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(n, w / 2, h / 2);
});

const RAYS = {}; // model key -> remembered ray hits
export function addPoliceKit(inst, bounds, { unit = '003' } = {}) {
  const sb = inst.sb, body = inst.body;
  const meshes = body.children.filter((m) => m.isMesh && m.visible && !m.userData.prepass);
  const paintMeshes = meshes.filter((m) => m.material.userData?.paint);
  const solid = meshes.filter((m) => !m.material.transparent);
  body.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  // Every measurement is a ray against the detailed body (hundreds of rays x 200+ meshes: seconds of
  // work). The answers only depend on the model, so they're remembered per model - in memory, and in
  // localStorage across sessions - and later builds of the kit cost almost nothing.
  const ck = 'carsim.kitrays.v1.' + [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].map((v) => v.toFixed(3)).join(',');
  const C = (RAYS[ck] ||= (() => { try { return JSON.parse(localStorage.getItem(ck) || '{}'); } catch { return {}; } })());
  let fresh = 0;
  const hit = (o, d, list = meshes) => {
    const k = (list === meshes ? 'm' : list === solid ? 's' : 'p') + [o.x, o.y, o.z, d.x, d.y, d.z].map((v) => v.toFixed(3)).join(',');
    let e = C[k];
    if (e === undefined) {
      ray.set(o, d); const r = ray.intersectObjects(list, false)[0];
      e = C[k] = r ? [r.point.x, r.point.y, r.point.z, meshes.indexOf(r.object)] : 0; fresh++;
    }
    return e ? { point: new THREE.Vector3(e[0], e[1], e[2]), object: meshes[e[3]] } : null;
  };
  const B = bounds, V = (x, y, z) => new THREE.Vector3(x, y, z), DOWN = V(0, -1, 0);
  const kit = (geo, mat, parent = body) => {
    bindGeometry(THREE, geo, sb);
    const m = new THREE.Mesh(geo, latticeMaterial(mat, sb));
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  };
  const black = (rough = 0.5) => new THREE.MeshStandardMaterial({ color: 0x111215, roughness: rough, metalness: 0.25 });
  const flashers = { red: [], blue: [], white: [] };

  // ---- blackout package: the chrome / silver trim (the metallic palette materials) goes dark; the
  // wheels get their own copies (wheel materials are shared with every car of this model), painted
  // black like steelies, with chrome centre caps
  for (const m of meshes) { const mt = m.material; if (!mt.userData.paint && !mt.transparent && mt.metalness > 0.9 && mt.map) mt.color.setHex(0x2a2a2c); }
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.12, metalness: 1 });
  for (const [k, wh] of Object.entries(inst.wheels)) {
    const wb = new THREE.Box3();
    wh.spin.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      wb.union(o.geometry.boundingBox);
      if (/Palette/.test(o.material.name)) { o.material = o.material.clone(); o.material.color.setHex(0x161616); o.material.metalness = 0.35; }
    });
    // which face is outboard depends on how the wheel was exported: cap both faces (the inner one is hidden)
    for (const out of [1, -1]) {
      const x = (out > 0 ? wb.max.x : wb.min.x) - out * 0.02;
      wh.spin.add(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.035, 24).rotateZ(-out * Math.PI / 2).translate(x, (wb.min.y + wb.max.y) / 2, (wb.min.z + wb.max.z) / 2), chrome));
    }
  }

  const lamp = (geo, col, kind, dim = col === 0xff1010 ? 0xa01414 : 0x1a3cc0) => {
    const mat = new THREE.MeshStandardMaterial({ color: dim, emissive: col, emissiveIntensity: 0, roughness: 0.2, metalness: 0 });
    flashers[kind].push(mat);
    kit(geo, mat).castShadow = false;
  };

  // ---- roof: sample the top of the body along the centre line; the roof is the high flat run
  const top = [];
  for (let z = B.min.z; z <= B.max.z; z += 0.05) { const h = hit(V(0, B.max.y + 1, z), DOWN); if (h) top.push({ z, y: h.point.y }); }
  const yMax = Math.max(...top.map((t) => t.y));
  const roof = top.filter((t) => t.y > yMax - 0.06);
  const rz0 = Math.min(...roof.map((t) => t.z)), rz1 = Math.max(...roof.map((t) => t.z));
  const roofAt = (z, x = 0) => hit(V(x, B.max.y + 1, z), DOWN)?.point.y ?? yMax;
  const barZ = rz0 + (rz1 - rz0) * 0.8; // just behind the windscreen header
  let halfW = 0.5;
  for (let x = 0.2; x < B.max.x; x += 0.02) { const y = roofAt(barZ, x); if (y < roofAt(barZ) - 0.1) break; halfW = x; }

  // ---- slim lightbar: aluminium-black housing on two brackets, 8 lens modules (outer reds / blues,
  // white takedowns in the middle), smoked lens cover
  const LB = { w: Math.min(1.15, halfW * 2 - 0.05), d: 0.22, h: 0.05 };
  const by = Math.max(roofAt(barZ, LB.w * 0.42), roofAt(barZ, -LB.w * 0.42));
  LB.y = Math.max(by, roofAt(barZ)) + 0.02; // underside of the bar
  for (const s of [-1, 1]) {
    const fx = s * LB.w * 0.42, fy = roofAt(barZ, fx);
    kit(new THREE.BoxGeometry(0.05, LB.y - fy + 0.01, 0.08).translate(fx, (LB.y + fy) / 2, barZ), black());
    kit(new THREE.BoxGeometry(0.07, 0.012, 0.16).translate(fx, fy + 0.006, barZ), black()); // foot pad
  }
  kit(new THREE.BoxGeometry(LB.w, 0.01, LB.d).translate(0, LB.y + 0.005, barZ), black(0.4)); // base plate
  kit(new THREE.BoxGeometry(LB.w * 0.97, 0.008, LB.d * 0.92).translate(0, LB.y + LB.h - 0.004, barZ), black(0.35)); // top cap
  for (const s of [-1, 1]) kit(new THREE.BoxGeometry(0.03, LB.h, LB.d).translate(s * (LB.w / 2 - 0.015), LB.y + LB.h / 2, barZ), black(0.4)); // end caps
  const N = 8, mw = (LB.w - 0.06) / N;
  for (let i = 0; i < N; i++) {
    const x = LB.w / 2 - 0.03 - mw * (i + 0.5); // i = 0 is the far left (+x)
    const kind = i === 3 || i === 4 ? 'white' : i < 4 ? 'red' : 'blue';
    const col = { red: 0xff1010, blue: 0x1844ff, white: 0xffffff }[kind], dim = { red: 0xa01414, blue: 0x1a3cc0, white: 0xc8cacc }[kind];
    lamp(new THREE.BoxGeometry(mw - 0.006, LB.h - 0.018, LB.d - 0.016).translate(x, LB.y + LB.h / 2, barZ), col, kind, dim);
  }
  // clear outer cover over the modules
  kit(new THREE.BoxGeometry(LB.w - 0.06, LB.h - 0.016, LB.d + 0.004).translate(0, LB.y + LB.h / 2, barZ),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, clearcoat: 1 })).castShadow = false;

  // ---- antenna: thin whip at the back of the roof
  const az = rz0 + (rz1 - rz0) * 0.1;
  kit(new THREE.CylinderGeometry(0.003, 0.005, 0.6, 6).translate(-0.2, roofAt(az, -0.2) + 0.3, az), black());
  kit(new THREE.CylinderGeometry(0.018, 0.022, 0.02, 10).translate(-0.2, roofAt(az, -0.2) + 0.01, az), black());

  // ---- push bar: two uprights whose face follows the bumper profile and bends back over the bonnet
  // edge, rubber pads, cross bars, mounting arms into the bumper, red / blue LEDs on the top bar
  const front = (x, y) => hit(V(x, y, B.max.z + 1), V(0, 0, -1), solid)?.point.z ?? -Infinity;
  let nose = -Infinity, noseY0 = Infinity;
  for (let y = B.min.y + 0.03; y < B.min.y + 0.7; y += 0.02) { const z = front(0, y); if (z > -Infinity) { nose = Math.max(nose, z); noseY0 = Math.min(noseY0, y); } }
  const hoodY = roofAt(nose - 0.25); // bonnet leading edge height
  const ux = 0.4, py0 = noseY0 + 0.03, py1 = hoodY + 0.03;
  // at each height: just ahead of the most forward point of the bumper between the uprights
  const faceZ = (y) => {
    let z = -Infinity;
    for (let x = -ux - 0.05; x <= ux + 0.05; x += 0.05) z = Math.max(z, front(x, Math.min(y, hoodY - 0.03)));
    return (z > -Infinity ? z : nose) + 0.06;
  };
  const steel = () => new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.5, metalness: 0.45 });
  const rubber = () => new THREE.MeshStandardMaterial({ color: 0x070707, roughness: 0.95, metalness: 0 });
  const tube = (pts, r, mat = steel()) => kit(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, r, 10, false), mat);
  const box = (w, h, d, x, y, z, mat = steel()) => kit(new THREE.BoxGeometry(w, h, d).translate(x, y, z), mat);
  const ys = Array.from({ length: 7 }, (_, i) => py0 + ((py1 - py0) * i) / 6), fz = ys.map(faceZ);
  for (let i = 1; i < fz.length; i++) fz[i] = Math.min(fz[i], fz[i - 1] + 0.01); // never lean forward going up
  const at = (y) => { const t = Math.max(0, Math.min(5.999, ((y - py0) / (py1 - py0)) * 6)), i = Math.floor(t); return fz[i] + (fz[i + 1] - fz[i]) * (t - i); };
  for (const s of [-1, 1]) {
    const x = s * ux;
    tube([...ys.map((y, i) => V(x, y, fz[i])), V(x, py1 + 0.04, fz[6] - 0.04), V(x, py1 + 0.05, fz[6] - 0.09)], 0.042); // upright, curling back at the top
    box(0.075, (py1 - py0) * 0.7, 0.035, x, py0 + (py1 - py0) * 0.45, at(py0 + (py1 - py0) * 0.45) + 0.045, rubber()); // push pad
    for (const f of [0.2, 0.6]) { // mounting arms back into the bumper
      const y = py0 + (py1 - py0) * f, zb = front(x, y);
      if (zb > -Infinity) box(0.045, 0.045, at(y) - zb + 0.1, x, y, (at(y) + zb - 0.1) / 2);
    }
    // LED head on the top bar next to each upright: red left, blue right (as seen from the driver)
    lamp(new THREE.BoxGeometry(0.1, 0.035, 0.025).translate(s * (ux - 0.1), py1 - 0.005, at(py1) + 0.03), s > 0 ? 0xff1010 : 0x1844ff, s > 0 ? 'red' : 'blue');
  }
  for (const f of [0.32, 0.68, 1]) { const y = py0 + (py1 - py0) * f; tube([V(-ux, y, at(y)), V(ux, y, at(y))], f === 1 ? 0.03 : 0.024); }
  box(ux * 2, 0.05, 0.12, 0, py0 + 0.02, at(py0) - 0.04); // bottom skid rail
  { // LED bar between the uprights, sitting on the lower cross bar: white takedown light
    const y = py0 + (py1 - py0) * 0.32 + 0.045, z = at(y);
    box(ux * 1.3, 0.06, 0.05, 0, y, z, steel());
    lamp(new THREE.BoxGeometry(ux * 1.24, 0.035, 0.01).translate(0, y, z + 0.026), 0xffffff, 'white', 0xd8dade);
  }
  // grille lights behind the bar
  for (const s of [-1, 1]) { const y = hoodY - 0.12, z = front(s * 0.2, y); if (z > -Infinity) lamp(new THREE.BoxGeometry(0.07, 0.025, 0.012).translate(s * 0.2, y, z + 0.006), s > 0 ? 0xff1010 : 0x1844ff, s > 0 ? 'red' : 'blue'); }

  // ---- visor lights: a red / blue strip behind the top of the windscreen
  {
    const y = yMax - 0.1, g = hit(V(0, y, B.max.z + 1), V(0, 0, -1));
    if (g) for (let i = 0; i < 6; i++) {
      const x = 0.4 - 0.8 * (i + 0.5) / 6, red = x > 0;
      lamp(new THREE.BoxGeometry(0.12, 0.03, 0.025).translate(x, y - 0.02, g.point.z - 0.06), red ? 0xff1010 : 0x1844ff, red ? 'red' : 'blue');
    }
  }
  // ---- A-pillar spotlight on the driver's side (+x), at the base of the windscreen pillar
  const glass = meshes.find((m) => /Front_Glass/i.test(m.material.name));
  if (glass) {
    if (!glass.geometry.boundingBox) glass.geometry.computeBoundingBox();
    const gb = glass.geometry.boundingBox, y = gb.min.y + 0.13, z = gb.max.z - 0.2;
    const g = hit(V(B.max.x + 1, y, z), V(-1, 0, 0), solid), x = (g ? g.point.x : gb.max.x) + 0.085;
    kit(new THREE.CylinderGeometry(0.014, 0.014, 0.09, 8).rotateZ(Math.PI / 2).translate(x - 0.045, y, z - 0.02), black()); // stalk into the pillar
    kit(new THREE.CylinderGeometry(0.06, 0.07, 0.15, 18).rotateX(Math.PI / 2).translate(x, y, z), black(0.3));
    kit(new THREE.CircleGeometry(0.055, 18).translate(x, y, z + 0.076), new THREE.MeshStandardMaterial({ color: 0xeef2f6, roughness: 0.05, metalness: 0.9 }));
  }
  // front plate: a black POLICE plate over the stock one (which is part of a lamp mesh, so it stays)
  {
    let best = null;
    for (let y = B.min.y + 0.1; y < B.min.y + 0.6; y += 0.01) { const h = hit(V(0, y, B.max.z + 1), V(0, 0, -1), solid); if (h && /Lights_On/.test(h.object.material.name) && (!best || h.point.z > best.z)) best = { y, z: h.point.z, b: h.object.geometry.boundingBox }; }
    if (best) {
      const tex = canvasTex(512, 128, (g, w, h) => {
        g.fillStyle = '#0c0d10'; g.fillRect(0, 0, w, h); g.strokeStyle = '#3a3d44'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
        g.fillStyle = '#2f6bff'; g.font = '900 78px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('POLICE', w / 2, h / 2 + 3);
      });
      const yc = best.b ? (best.b.min.y + best.b.max.y) / 2 : best.y;
      kit(new THREE.BoxGeometry(0.54, 0.135, 0.006).translate(0, yc, best.z + 0.006), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.2 }));
    }
  }

  // ---- livery: decals projected onto the painted panels (each piece rides on the mesh it lies on,
  // so the door pieces swing with the doors)
  const decal = (tex, pos, rot, size) => {
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.3, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false });
    const reach = new THREE.Box3().setFromCenterAndSize(pos, V(Math.max(size.x, size.z) * 1.5, size.y * 1.5, Math.max(size.x, size.z) * 1.5));
    for (const m of paintMeshes) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      if (!reach.intersectsBox(m.geometry.boundingBox)) continue;
      const g = new DecalGeometry(m, pos, rot, size);
      if (!g.getAttribute('position').count) continue;
      kit(g, mat.clone(), m).castShadow = false;
    }
  };
  const len = B.max.z - B.min.z, sideLen = len * 0.76, sideZ = (B.max.z + B.min.z) / 2 - len * 0.07; // biased rearwards
  for (const s of [1, -1]) {
    const yMid = B.min.y + 0.6;
    const h = hit(V(s * (B.max.x + 1), yMid, sideZ), V(-s, 0, 0), paintMeshes);
    const x = h ? h.point.x : s * B.max.x;
    // left side (+x): canvas left is the car's front; right side: canvas left is the rear
    decal(sideTex(s > 0), V(x, yMid, sideZ), new THREE.Euler(0, s * Math.PI / 2, 0), V(sideLen, sideLen / 4, 0.5));
    // TO PROTECT & SERVE along the front fender, just ahead of the front door
    const fz = B.max.z - len * 0.2, fy = B.min.y + 0.74, fh = hit(V(s * (B.max.x + 1), fy, fz), V(-s, 0, 0), paintMeshes);
    if (fh) decal(fenderTex(), fh.point, new THREE.Euler(0, s * Math.PI / 2, 0), V(0.5, 0.0625, 0.4));
  }
  // unit number on the front bumper corner (driver's side, +x)
  const uh = hit(V(0.55, py0 + 0.12, B.max.z + 1), V(0, 0, -1), paintMeshes.length ? paintMeshes : solid);
  if (uh) decal(unitTex(unit), uh.point, new THREE.Euler(0, 0, 0), V(0.2, 0.1, 0.3));

  if (fresh) try { localStorage.setItem(ck, JSON.stringify(C)); } catch { /* storage full: just recompute next time */ }
  // ---- flash pattern: left reds and right blues alternate in quick triple bursts, the white
  // takedowns blink between them
  let on = false; // off until switched on (J, or the siren)
  const set = (list, v) => { for (const m of list) m.emissiveIntensity = v; };
  const update = (t) => {
    const ph = (t * 1.5) % 1, burst = (a) => [0, 0.07, 0.14].some((o) => ph > a + o && ph < a + o + 0.04);
    set(flashers.red, on && burst(0) ? 10 : 0);
    set(flashers.blue, on && burst(0.5) ? 10 : 0);
    set(flashers.white, on && ((ph > 0.3 && ph < 0.33) || (ph > 0.8 && ph < 0.83)) ? 6 : 0);
  };
  return { update, toggle() { on = !on; return on; }, set(v) { on = v; }, get on() { return on; } };
}
