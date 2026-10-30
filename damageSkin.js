// Paint damage painted into a per-car atlas, projected in the car's rest frame (so it sticks to the
// panel as the body dents, doors swing, parts tear off).
//   five views share one canvas: left, right (u = z, v = y), front, rear (u = x, v = y), top (u = z, v = x)
//   channels: R = scuffed clearcoat, G = paint gone to primer, B = bare metal
// Sliding contacts paint bundles of fine parallel scratches along the relative motion, harder ones
// cut through to primer and metal; impacts chip the paint around the hit.
// The shader side lives in softbody.js (latticeMaterial, DMG / DMG_PAINT defines).
import * as THREE from 'three';

export const DMG_W = 2048, DMG_H = 1024;
// canvas regions in pixels: [x0, y0, w, h]
const REG = { L: [0, 0, 1024, 400], R: [1024, 0, 1024, 400], F: [0, 400, 512, 400], B: [512, 400, 512, 400], T: [1024, 400, 1024, 624] };

export class DamageSkin {
  constructor(bounds) {
    this.min = bounds.min.clone(); this.size = bounds.getSize(new THREE.Vector3());
    this.canvas = document.createElement('canvas');
    this.canvas.width = DMG_W; this.canvas.height = DMG_H;
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#000'; this.g.fillRect(0, 0, DMG_W, DMG_H);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.tex.flipY = false; // canvas rows = texture rows, so changed rectangles can be uploaded in place
    this.rect = null; this.full = true;
    this.tex.anisotropy = 4;
    this.dirty = false; this.upT = 0;
    this.uniforms = {
      uDmg: { value: this.tex },
      uDmgMin: { value: this.min },
      uDmgSize: { value: this.size },
    };
  }
  reset() { this.g.globalCompositeOperation = 'source-over'; this.g.fillStyle = '#000'; this.g.fillRect(0, 0, DMG_W, DMG_H); this.dirty = true; this.full = true; }
  mark(x0, y0, x1, y1) { // grow the changed rectangle
    const r = this.rect ||= [1e9, 1e9, -1e9, -1e9];
    r[0] = Math.min(r[0], x0); r[1] = Math.min(r[1], y0); r[2] = Math.max(r[2], x1); r[3] = Math.max(r[3], y1);
  }

  // rest-frame point + outward normal -> region + canvas pixel (same maths as the shader)
  project(p, n) {
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const u = (p.x - this.min.x) / this.size.x, v = (p.y - this.min.y) / this.size.y, w = (p.z - this.min.z) / this.size.z;
    let r, px, py;
    if (ay > ax && ay > az) { if (n.y < 0) return null; r = REG.T; px = w; py = u; }
    else if (ax > az) { r = n.x > 0 ? REG.L : REG.R; px = w; py = 1 - v; }
    else { r = n.z > 0 ? REG.F : REG.B; px = u; py = 1 - v; }
    return { r, x: r[0] + px * r[2], y: r[1] + py * r[3], ppm: r[2] / (r === REG.F || r === REG.B ? this.size.x : this.size.z) };
  }

  // a scrape: bundle of fine parallel scratches along dir (rest frame), severity 0..1+
  scratch(p, n, dir, len, sev) {
    const a = this.project(p, n);
    if (!a) return;
    const b = this.project({ x: p.x + dir.x * len, y: p.y + dir.y * len, z: p.z + dir.z * len }, n);
    if (!b || b.r !== a.r) return;
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 0.5) return;
    dx /= L; dy /= L;
    const g = this.g, r = a.r;
    g.save();
    g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip(); // stay inside this view
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    const band = (0.02 + 0.05 * Math.min(sev, 1.5)) * a.ppm; // width of the scrape band
    const lines = 2 + Math.floor(sev * 6 + Math.random() * 3);
    for (let i = 0; i < lines; i++) {
      const off = (Math.random() - 0.5) * band, depth = Math.random() * sev;
      const x0 = a.x - dy * off - dx * L * Math.random() * 0.3, y0 = a.y + dx * off - dy * L * Math.random() * 0.3;
      const l = L * (0.5 + Math.random() * 0.8);
      g.beginPath(); g.moveTo(x0, y0);
      const segs = 3, wob = 0.15;
      for (let s = 1; s <= segs; s++) { // grit makes scratches slightly wavy, never ruler-straight
        const t = (s / segs) * l, j = (Math.random() - 0.5) * wob;
        g.lineTo(x0 + dx * t - dy * j, y0 + dy * t + dx * j);
      }
      const wpx = 0.5 + Math.random() * (0.6 + depth * 1.6);
      // shallow: clearcoat haze; deeper: through to primer; deepest: bright metal in the middle
      const R = Math.round(30 + 90 * Math.min(1, sev)), G = depth > 0.55 ? Math.round(180 * Math.min(1, depth)) : 0, B = depth > 0.9 ? Math.round(255 * Math.min(1, (depth - 0.9) * 4)) : 0;
      g.strokeStyle = `rgba(${R},${G},${B},${0.2 + 0.35 * Math.random()})`;
      g.lineWidth = wpx;
      g.stroke();
      if (Math.random() < 0.3 * sev) { // a wider soft scuff halo around the deep ones
        g.strokeStyle = `rgba(${Math.round(60 * sev)},0,0,0.12)`; g.lineWidth = wpx * 6; g.stroke();
      }
    }
    g.restore();
    const pad = band + 8;
    this.mark(Math.min(a.x, b.x) - L * 0.3 - pad, Math.min(a.y, b.y) - L * 0.3 - pad, Math.max(a.x, b.x) + L * 0.5 + pad, Math.max(a.y, b.y) + L * 0.5 + pad);
    this.dirty = true;
  }

  // impact: chipped paint flakes around the hit, scuffed ring
  chip(p, n, sev) {
    const a = this.project(p, n);
    if (!a) return;
    const g = this.g, r = a.r, rad = (0.03 + 0.12 * Math.min(sev, 1.5)) * a.ppm;
    g.save();
    g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
    g.globalCompositeOperation = 'lighter';
    const scuff = g.createRadialGradient(a.x, a.y, 0, a.x, a.y, rad * 1.6);
    scuff.addColorStop(0, `rgba(${Math.round(150 * Math.min(1, sev))},0,0,0.5)`); scuff.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = scuff; g.fillRect(a.x - rad * 2, a.y - rad * 2, rad * 4, rad * 4);
    const flakes = Math.floor(4 + sev * 18);
    for (let i = 0; i < flakes; i++) { // irregular flakes: primer, some down to metal
      const ang = Math.random() * 6.28, d = Math.pow(Math.random(), 1.5) * rad, s = 0.6 + Math.random() * (1 + sev * 3);
      const x = a.x + Math.cos(ang) * d, y = a.y + Math.sin(ang) * d;
      g.fillStyle = `rgba(30,${Math.round(150 + 100 * Math.random())},${Math.random() < sev * 0.4 ? 200 : 0},0.8)`;
      g.beginPath();
      const k = 5 + (Math.random() * 3 | 0);
      for (let j = 0; j < k; j++) { const t = (j / k) * 6.28, rr = s * (0.5 + Math.random()); g[j ? 'lineTo' : 'moveTo'](x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
      g.closePath(); g.fill();
    }
    g.restore();
    this.mark(a.x - rad * 2.2, a.y - rad * 2.2, a.x + rad * 2.2, a.y + rad * 2.2);
    this.dirty = true;
  }

  // upload only what changed: the first time (and after a reset) the whole atlas, then just the dirty
  // rectangle straight into the existing texture (a full 8 MB re-upload hitched the frame)
  update(dt, renderer) {
    this.upT -= dt;
    if (!this.dirty || this.upT > 0) return;
    this.upT = 0.1;
    const props = renderer.properties.get(this.tex);
    if (this.full || !props.__webglTexture) { this.tex.needsUpdate = true; this.full = false; this.rect = null; this.dirty = false; return; }
    const r = this.rect; this.rect = null; this.dirty = false;
    if (!r) return;
    const x = Math.max(0, Math.floor(r[0])), y = Math.max(0, Math.floor(r[1]));
    const w = Math.min(DMG_W, Math.ceil(r[2])) - x, h = Math.min(DMG_H, Math.ceil(r[3])) - y;
    if (w <= 0 || h <= 0) return;
    const img = this.g.getImageData(x, y, w, h), gl = renderer.getContext();
    renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}

// GLSL shared by vertex + fragment (declared in the lattice material patch)
export const DMG_GLSL = `
#ifdef DMG
uniform sampler2D uDmg; uniform vec3 uDmgMin, uDmgSize;
vec4 dmgSample(vec3 p, vec3 n) {
  vec3 q = (p - uDmgMin) / uDmgSize; vec3 a = abs(n); vec4 r; vec2 t;
  if (a.y > a.x && a.y > a.z) { if (n.y < 0.) return vec4(0.); r = vec4(1024., 400., 1024., 624.); t = vec2(q.z, q.x); }
  else if (a.x > a.z) { r = n.x > 0. ? vec4(0., 0., 1024., 400.) : vec4(1024., 0., 1024., 400.); t = vec2(q.z, 1. - q.y); }
  else { r = n.z > 0. ? vec4(0., 400., 512., 400.) : vec4(512., 400., 512., 400.); t = vec2(q.x, 1. - q.y); }
  vec2 px = r.xy + clamp(t, 0., 1.) * r.zw;
  return texture2D(uDmg, px / vec2(${DMG_W}., ${DMG_H}.)); // flipY off: canvas row = texture row
}
#endif`;
