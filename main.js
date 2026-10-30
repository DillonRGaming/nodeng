import * as THREE from 'three';
import {
  createCar, stepCar, resetCar, autoGearbox, shift, gearLabel, DT, PHYS_HZ,
  heightAt, ZONES, FEATURES, FLAT_MAP, MAP, TEST, SURFACES, DRIVE_MODES, v3, qRotate, qConj, clamp, lerp, vehicleSpecs,
} from './physics.js';
import { CarAudio } from './audio.js';
import { loadCarTemplate, instantiateCar } from './carModel.js';
import { Hud } from './hud.js';
import { prepareCollider, bindShell, fitShell, collideCars, groundCrush, collideStatic } from './collision.js';
import { tearOff, spawnPiece, updateDebris, clearDebris, debrisCount, prewarmDebris } from './debris.js';
import { LightRig } from './lights.js';
import { addPoliceKit, POLICE_PAINT } from './police.js';
import { FireSystem } from './fire.js';
import { loadSettings, saveSettings } from './settings.js';
import { createMenu, VEHICLES } from './menu.js';
import { buildRoute, reverseRoute, AIDriver, signals, DRIVER_TYPES } from './ai.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Profiler } from './profiler.js';
import { buildWorld } from './lowpolyWorld.js';
import { buildCountryside } from './countryside.js';
import { buildMountain } from './mountain.js';
import { addFluidsTo, startLeak, updateLeaks, updateFluids } from './fluids.js';

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }); // MSAA happens in the HDR target
// integrated graphics (Intel UHD / Iris, most laptops): never render above 1:1, start lower
const INTEGRATED = (() => { const g = renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return /intel|uhd|iris|mesa/i.test(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)); })();
const MAX_PR = Math.min(devicePixelRatio, INTEGRATED ? 1 : 1.5); // sharp on high-DPI screens when the GPU can afford it
let pixelRatio = Math.min(INTEGRATED ? 0.8 : 1, MAX_PR); // start at native-ish; the adaptive loop climbs if there's headroom
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;
document.body.prepend(renderer.domElement);
const prof = new Profiler(renderer.getContext());
renderer.info.autoReset = false; // the composer renders several times a frame: count the whole frame
// shadows are drawn once per frame: without this every renderer.render() (the AO pass re-renders the
// scene for its normals) redrew the shadow map too
renderer.shadowMap.autoUpdate = false;
{
  const sm = renderer.shadowMap, render = sm.render.bind(sm);
  sm.render = (...a) => { prof.gbegin('shadows'); render(...a); prof.gend(); };
}

const scene = new THREE.Scene();
const HORIZON = new THREE.Color(0xc9c3c4); // warm, hazy
scene.fog = new THREE.Fog(HORIZON, 90, 700);
const SUN_DIR = new THREE.Vector3(-0.5, 0.72, -0.48).normalize();

// Outdoor sky used both as the visible backdrop and (rendered once into a PMREM) as the
// reflection/ambient environment: blue zenith, hazy horizon, dark ground, HDR sun highlight.
function skyMaterial(sunBoost, below) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x2c5f9e) }, hor: { value: HORIZON.clone() }, grnd: { value: below },
      sunDir: { value: SUN_DIR }, sunBoost: { value: sunBoost }, uTime: { value: 0 }, uLit: { value: 1 },
    },
    vertexShader: 'varying vec3 vd; void main(){ vd = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    // a heavy broken cumulus layer (fbm noise projected on a cloud plane, domain-warped), mostly
    // cover with blue gaps; shaded by a step towards the sun: lit tops near white, shaded undersides a
    // soft mauve-grey, warm gold + silver linings round the sun, everything hazing out at the horizon
    fragmentShader: `uniform vec3 zenith, hor, grnd, sunDir; uniform float sunBoost, uTime, uLit; varying vec3 vd;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float v = 0., a = 0.5; for (int i = 0; i < 6; i++) { v += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
      float clouds(vec2 p) { vec2 w = vec2(fbm(p * 0.6 + 3.1), fbm(p * 0.6 + 7.4)); return fbm(p + w * 1.4); }
      void main(){ vec3 d = normalize(vd);
        vec3 c = d.y > 0. ? mix(hor, zenith, pow(d.y, 0.5)) : mix(hor, grnd, smoothstep(0., 0.12, -d.y));
        float s = max(dot(d, sunDir), 0.);
        vec3 sunCol = vec3(1., 0.84, 0.6);
        c += sunCol * (pow(s, 6.) * 0.45 + pow(s, 40.) * 0.5);                         // warm haze round the sun
        if (d.y > 0.0) {
          vec2 p = d.xz / (d.y + 0.38) * 2.6 + vec2(uTime * 0.012, uTime * 0.004);
          float n = clouds(p);
          float cov = smoothstep(0.3, 0.52, n);                                          // mostly cloud, blue gaps
          vec2 toSun = normalize(sunDir.xz + 1e-4) * 0.18;
          float shade = clamp((n - clouds(p + toSun)) * 4.5 + 0.45 + (n - 0.5) * 0.6, 0., 1.);              // thinner towards the sun = lit
          vec3 under = vec3(0.5, 0.46, 0.54), top = vec3(1.0, 0.97, 0.96), warm = vec3(0.84, 0.62, 0.6);
          vec3 cc = mix(under, top, shade);
          cc = mix(cc, warm * (0.8 + 0.4 * shade), smoothstep(0.4, 0.95, s) * 0.6 + 0.3 * (1. - shade)); // pink-mauve, warmer near the sun
          cc += sunCol * pow(s, 10.) * (1. - cov * 0.5) * 0.9;                            // silver lining / glare through thin cloud
          float fade = smoothstep(0.0, 0.12, d.y);                                        // hazes into the horizon
          c = mix(c, cc * uLit, cov * fade * 0.94);
        }
        c += vec3(1., 0.93, 0.82) * pow(s, 900.) * sunBoost;
        gl_FragColor = vec4(c, 1.); }`,
  });
}
// day + night environments, both prebuilt so switching is just a texture swap (no shader recompiles)
const NIGHT_HORIZON = new THREE.Color(0x141a24);
const DAY_ZENITH = 0x4f7fbf; // a softer blue than a clear sky: it only shows through the gaps
const ENV = (() => {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const bake = (mat) => { const sc = new THREE.Scene(); sc.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat)); return pmrem.fromScene(sc, 0.02).texture; };
  const nightMat = skyMaterial(2, new THREE.Color(0x060708));
  nightMat.uniforms.zenith.value.set(0x05080f); nightMat.uniforms.hor.value.copy(NIGHT_HORIZON); nightMat.uniforms.uLit.value = 0.05;
  const dayMat = skyMaterial(60, new THREE.Color(0x3a3b3e)); dayMat.uniforms.zenith.value.set(DAY_ZENITH);
  return { day: bake(dayMat), night: bake(nightMat) };
})();
scene.environment = ENV.day;
const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), skyMaterial(6, HORIZON)); sky.material.uniforms.zenith.value.set(DAY_ZENITH); // below the horizon = fog colour, no seam
sky.renderOrder = -1;
scene.add(sky);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3000);
const hemi = new THREE.HemisphereLight(0xc4d8ff, 0x2a2b2e, 0.25); // the sky env map does most of the ambient
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe6c8, 3.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera; sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 150;
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);

// ---------------------------------------------------------------- post: HDR + MSAA -> GTAO -> bloom -> grade -> ACES
const hdrTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, hdrTarget);
composer.addPass(new RenderPass(scene, camera));
// ground-truth AO: contact darkening under and inside the car, in wheel arches, around ramps
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
gtao.blendIntensity = 0.85;
{ // its depth/normal pass must not see sprites, decals, lines or the sky dome (car glass stays: it hides the cabin)
  const render = gtao.render.bind(gtao), hidden = [];
  gtao.render = (...a) => {
    scene.traverseVisible((o) => { if (o !== scene && (o.isPoints || o.isLine || o.isSprite || o === sky || (o.material && o.material.transparent && (o.material.isMeshBasicMaterial || o.material.isShaderMaterial)))) hidden.push(o); });
    for (const o of hidden) o.visible = false;
    render(...a);
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  };
}
{ // AO at half resolution: it's soft anyway, and this was the single most expensive pass
  const setSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
}
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.22, 0.55, 1.6); // only true HDR highlights bloom
bloom.enabled = false; // night only (setNight)
composer.addPass(bloom);
// filmic grade in linear HDR, before ACES: gentle warm/cool split, a touch of saturation, vignette
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.38 }, uSat: { value: 0.88 }, uSharp: { value: 0 }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig, uSat, uSharp; uniform vec2 uTexel; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv);
      if (uSharp > 0.) { // contrast-adaptive sharpening: restores detail when rendering below native resolution
        vec3 n = texture2D(tDiffuse, vUv + vec2(0., uTexel.y)).rgb, so = texture2D(tDiffuse, vUv - vec2(0., uTexel.y)).rgb;
        vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.)).rgb, w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.)).rgb;
        vec3 mn = min(c.rgb, min(min(n, so), min(e, w))), mx = max(c.rgb, max(max(n, so), max(e, w)));
        vec3 amp = sqrt(clamp(min(mn, 2. - mx) / max(mx, 1e-4), 0., 1.)) * uSharp * -0.18;
        c.rgb = max((c.rgb + (n + so + e + w) * amp) / (1. + 4. * amp), 0.); }
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      c.rgb = max(c.rgb, 0.) * mix(0.9, 1.05, smoothstep(0.02, 0.5, l)); // a little contrast: deeper shadows
      float t = l / (l + 0.6);
      c.rgb *= mix(vec3(0.96, 0.99, 1.05), vec3(1.04, 1.0, 0.95), t); // cool shadows, warm highlights
      vec2 d = vUv - 0.5; c.rgb *= 1. - uVig * dot(d, d) * 2.2;
      gl_FragColor = c; }`,
});
composer.addPass(grade);
addFluidsTo(scene);
const world = MAP === 'proto' ? buildWorld(scene, heightAt) : null;
composer.addPass(new OutputPass()); // ACES + sRGB
// per-pass GPU timing (debug overlay)
['scene', 'ao', 'bloom', 'grade', 'output'].forEach((name, i) => {
  const p = composer.passes[i], render = p.render.bind(p);
  p.render = (...a) => { prof.gbegin(name); render(...a); prof.gend(); };
});

// ---------------------------------------------------------------- textures
function canvasTex(size, draw, repeat = 1, flip = false) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); // 16x is very costly on integrated GPUs
  t.colorSpace = THREE.SRGBColorSpace;
  if (flip) { t.center.set(0.5, 0.5); t.rotation = Math.PI; }
  return t;
}
// Prototype grid tile: TILE x TILE metres, 1 m sub-grid with faint diagonals, bold tile border, corner label.
const TILE = 4;
const SKIDPAD = { x: 185, z: 0, r: 26 };
// Low-poly look: flat colour with a faint 4 m tile seam (still readable for judging speed and distance).
// grass: mottled, never one flat colour (that's what reads as a toy) - patches of lighter / darker /
// drier grass at a few scales, plus fine speckle
function grassTex() {
  const t = canvasTex(512, (g, s) => {
    g.fillStyle = '#6f7f44'; g.fillRect(0, 0, s, s);
    const blob = (n, r0, r1, cols, a) => { for (let i = 0; i < n; i++) { const x = Math.random() * s, y = Math.random() * s, r = r0 + Math.random() * (r1 - r0); const gr = g.createRadialGradient(x, y, 0, x, y, r); const c = cols[(Math.random() * cols.length) | 0]; gr.addColorStop(0, c + a + ')'); gr.addColorStop(1, c + '0)'); g.fillStyle = gr; for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) { g.save(); g.translate(dx, dy); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); } } };
    blob(40, 60, 160, ['rgba(92,108,52,', 'rgba(128,132,70,', 'rgba(104,118,58,', 'rgba(140,128,78,'], 0.55);
    blob(260, 8, 30, ['rgba(80,96,46,', 'rgba(132,140,80,', 'rgba(150,140,90,'], 0.35);
    for (let i = 0; i < 9000; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(60,72,34,0.35)' : 'rgba(160,160,100,0.25)'; g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5); }
  });
  return t;
}
function protoTex(base, seam = 0.045) {
  return canvasTex(256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    if (seam > 0) { g.strokeStyle = `rgba(255,255,255,${seam})`; g.lineWidth = 3; g.strokeRect(0, 0, s, s); }
  }, 1, true);
}

// ---------------------------------------------------------------- ground + zones + features
// the flat map gets a prototype grid floor (TILE m tiles, 1 m sub-grid, bold border); the others grass
const groundTex = MAP === 'flat' ? canvasTex(512, (g, s) => {
  g.fillStyle = '#8a8d93'; g.fillRect(0, 0, s, s);
  const c = s / TILE;
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2;
  for (let i = 1; i < TILE; i++) { g.beginPath(); g.moveTo(i * c, 0); g.lineTo(i * c, s); g.moveTo(0, i * c); g.lineTo(s, i * c); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  for (let i = 0; i < TILE; i++) for (let k = 0; k < TILE; k++) { g.beginPath(); g.moveTo(i * c, k * c); g.lineTo((i + 1) * c, (k + 1) * c); g.stroke(); }
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 6; g.strokeRect(0, 0, s, s);
}) : grassTex();
groundTex.repeat.set(...(MAP === 'flat' ? [2000 / TILE, 2000 / TILE] : [2000 / 24, 2000 / 24])); // flat: one tile per TILE m, grass: per 24 m
const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: groundTex }));
ground.receiveShadow = true;
scene.add(ground);

const ZONE_LOOK = { ice: '#bfe0ee', grass: '#5f9a48', gravel: '#c4a06a', wet: '#33485a' };
for (const z of ZONES) {
  const w = z.x1 - z.x0, d = z.z1 - z.z0;
  const tex = protoTex(ZONE_LOOK[z.s], SURFACES[z.s].name, `grip μ ${SURFACES[z.s].mu}`);
  tex.repeat.set(w / TILE, d / TILE);
  const slick = z.s === 'ice' || z.s === 'wet';
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
    slick
      ? new THREE.MeshStandardMaterial({ map: tex, roughness: z.s === 'ice' ? 0.12 : 0.25, metalness: 0, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -2 })
      : new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: tex, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.position.set((z.x0 + z.x1) / 2, 0.005, (z.z0 + z.z1) / 2);
  m.receiveShadow = true;
  scene.add(m);
  addLabel(SURFACES[z.s].name + `  μ ${SURFACES[z.s].mu}`, (z.x0 + z.x1) / 2, (z.z0 + z.z1) / 2 - d / 2 - 3);
}

function heightMesh(x0, x1, z0, z1, nx, nz, mat) {
  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz).rotateX(-Math.PI / 2);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + (x0 + x1) / 2, z = p.getZ(i) + (z0 + z1) / 2;
    p.setXYZ(i, x, heightAt(x, z) + 0.008, z);
    uv.setXY(i, x / TILE, -z / TILE); // world-aligned so the grid lines up with the floor
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true; m.castShadow = true;
  scene.add(m);
  return m;
}
if (MAP === 'proto') {
  const j = FEATURES.jump;
  heightMesh(j.x0, j.x1, j.z0 - 0.5, j.z0 + j.up + j.top + j.down + 0.5, 4, 120, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#d9893e', 'RAMP', 'h 1.6 m') }));
  addLabel('JUMP', 0, j.z0 - 4);
  const b = FEATURES.bumps;
  const bumpMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#d6c24a', 'BUMP', 'h 0.11 m') });
  for (const bz of b.zs) heightMesh(b.x0, b.x1, bz - b.w / 2, bz + b.w / 2, 4, 16, bumpMat);
  addLabel('SPEED BUMPS', 0, b.zs[0] + 5);
  const w = FEATURES.wash;
  heightMesh(w.x0, w.x1, w.z0, w.z1, 6, 600, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#5a5d63', 'WASHBOARD', 'amp 5 cm') }));
  addLabel('WASHBOARD', (w.x0 + w.x1) / 2, w.z0 - 4);
  const r = FEATURES.rollers;
  heightMesh(r.x0, r.x1, r.z0, r.z1, 4, 240, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#6aa34f', 'ROLLERS', `h ${r.h} m`) }));
  addLabel('ROLLERS', (r.x0 + r.x1) / 2, r.z0 - 5);
  const k = FEATURES.kickers;
  const kickMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#c9563f', 'KICKER', `h ${k.h} m`) });
  for (const kz of k.zs) { heightMesh(k.x0, k.x1, kz - 0.5, kz + k.len + 0.02, 4, 40, kickMat); addLabel('KICKER', (k.x0 + k.x1) / 2, kz - 5); }
  const bw = FEATURES.bowl, R = bw.r1 + 14;
  heightMesh(bw.x - R, bw.x + R, bw.z - R, bw.z + R, 140, 140, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.82, metalness: 0, envMapIntensity: 0.35, map: protoTex('#4f7fa8', 'BOWL', `bank ${bw.h} m`) }));
  addLabel('BANKED BOWL', bw.x, bw.z);
  // skidpad: painted circle with cones on the inside line
  const pad = new THREE.Mesh(new THREE.RingGeometry(SKIDPAD.r - 1, SKIDPAD.r + 1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  pad.position.set(SKIDPAD.x, 0.02, SKIDPAD.z); scene.add(pad);
  addLabel('SKIDPAD', SKIDPAD.x, SKIDPAD.z);
  addLabel('SLALOM', -85, -100);
}

function addLabel(text, x, z) {
  const tex = canvasTex(512, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.font = 'bold 64px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(text, s / 2, s / 2);
  });
  tex.repeat.set(1, 1);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
  m.position.set(x, 0.02, z);
  m.rotation.y = Math.PI;
  scene.add(m);
}


// ---------------------------------------------------------------- day / night
// debug toggles (F opens the overlay, then the number keys): switch features off to see what they cost
const dbgOff = { soft: false, ground: false, adapt: false };
const dbgOn = { lines: false };
const DBG_KEYS = {
  Digit1: ['ambient occlusion', () => { dbgForce.noAO = !dbgForce.noAO; applyQuality(); return gtao.enabled; }],
  Digit2: ['bloom', () => (bloom.enabled = !bloom.enabled)],
  Digit3: ['shadows', () => { sun.castShadow = !sun.castShadow; return sun.castShadow; }],
  Digit4: ['MSAA 4x', () => { const n = composer.renderTarget1.samples ? 0 : 4; for (const rt of [composer.renderTarget1, composer.renderTarget2]) { rt.samples = n; rt.dispose(); } return n > 0; }],
  Digit5: ['soft body sim', () => !(dbgOff.soft = !dbgOff.soft)],
  Digit6: ['ground damage', () => !(dbgOff.ground = !dbgOff.ground)],
  Digit7: ['particles + shards', () => (pts.visible = shardMesh.visible = !pts.visible)],
  Digit8: ['adaptive resolution', () => !(dbgOff.adapt = !dbgOff.adapt)],
  Digit9: ['physics lines', () => (dbgOn.lines = !dbgOn.lines)],
};
const dbgState = () => ({ Digit1: gtao.enabled, Digit2: bloom.enabled, Digit3: sun.castShadow, Digit4: composer.renderTarget1.samples > 0,
  Digit5: !dbgOff.soft, Digit6: !dbgOff.ground, Digit7: pts.visible, Digit8: !dbgOff.adapt, Digit9: dbgOn.lines });
const ui = { debug: false, cam: 0, paused: false, slowmo: false, muted: false, night: false, headlights: 0, indicator: 0, hazard: false };
function setNight(on) {
  ui.night = on;
  world?.setNight(on);
  const u = sky.material.uniforms;
  if (on) {
    u.zenith.value.set(0x05080f); u.hor.value.copy(NIGHT_HORIZON); u.grnd.value.copy(NIGHT_HORIZON); u.sunBoost.value = 0; u.uLit.value = 0.05;
    scene.fog.color.copy(NIGHT_HORIZON); scene.fog.near = 30; scene.fog.far = 320;
    scene.environment = ENV.night;
    sun.color.set(0x9fb4ff); sun.intensity = 0.32; hemi.intensity = 0.14; // moonlight
    renderer.toneMappingExposure = 1.1; bloom.strength = 0.55; bloom.threshold = 0.9; bloom.enabled = true;
    if (ui.headlights === 0) ui.headlights = 1;
  } else {
    u.zenith.value.set(DAY_ZENITH); u.hor.value.copy(HORIZON); u.grnd.value.copy(HORIZON); u.sunBoost.value = 6; u.uLit.value = 1;
    scene.fog.color.copy(HORIZON); scene.fog.near = 90; scene.fog.far = 700;
    scene.environment = ENV.day;
    sun.color.set(0xffe6c8); sun.intensity = 3.0; hemi.intensity = 0.25;
    renderer.toneMappingExposure = 0.82; bloom.enabled = false; // in daylight almost nothing crosses the threshold: not worth 7 ms
  }
  pMat.uniforms.fogColor.value.copy(scene.fog.color);
}

// ---------------------------------------------------------------- contact shadow texture
const contactTex = canvasTex(256, (g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});
function makeContactShadow() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 5.0).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, map: contactTex }));
  m.renderOrder = 1; scene.add(m); return m;
}

// ---------------------------------------------------------------- vehicles
// the mountain pass (MAP 'touge'): terrain + road + rails + forest; its road is the AI route
const MTN = MAP === 'touge' ? buildMountain(scene, { grassTex: grassTex() }) : null;
if (MTN) { ground.visible = false; scene.fog.near = 140; scene.fog.far = 1300; }
const LANE = MTN ? -1.8 : -2;
const route = MTN ? MTN.route : buildRoute({ x0: -14, x1: 150, z0: -100, z1: 110 }); // the blue car's loop: two blocks wide

// ---------------------------------------------------------------- test area: road loop, kerbs, hill, bumps, bollards, wall, barriers
// traffic signal heads: one per approach, on the near-right pavement corner, facing the oncoming driver
// (right-hand traffic; +x is a northbound driver's left)
const SIG_NODES = FLAT_MAP ? TEST.gridX.flatMap((x) => TEST.gridZ.map((z) => [x, z])) : [];
const SIG_HEADS = [];
SIG_NODES.forEach(([x, z], ni) => {
  // on the pavement at the rounded corner: 1.3 m behind the kerb arc (radius J - W round the corner centre)
  const o = TEST.J - (TEST.J - TEST.roadW / 2 - 1.3) / Math.SQRT2;
  SIG_HEADS.push({ ni, ns: true, x: x - o, z: z - o, yaw: Math.PI }, { ni, ns: true, x: x + o, z: z + o, yaw: 0 },
    { ni, ns: false, x: x - o, z: z + o, yaw: -Math.PI / 2 }, { ni, ns: false, x: x + o, z: z - o, yaw: Math.PI / 2 });
});
const OBSTACLES = FLAT_MAP ? [...TEST.bollards, ...TEST.boxes, ...SIG_HEADS.map((hd) => ({ x: hd.x, z: hd.z, r: 0.09, h: 3.2 }))] : [];
if (MTN) OBSTACLES.push(...MTN.obstacles);
if (FLAT_MAP) {
  const T = TEST, std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.35, ...o });
  const decal = (o) => std({ polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide, ...o });
  // road grid: straight roads between intersections (edge lines, dashed centre), plain junction pads
  const quads = (list, y, mat) => { // list of [x0, z0, x1, z1] axis-aligned rectangles
    const pos = [];
    for (const [x0, z0, x1, z1] of list) pos.push(x0, y, z0, x1, y, z1, x1, y, z0, x0, y, z0, x0, y, z1, x1, y, z1);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; scene.add(m); return m;
  };
  const W = T.roadW / 2, J = 12; // half width, junction pad half size
  const asphalt = [], lines = [], dashes = [], stops = [];
  const gx = T.gridX, gz = T.gridZ;
  for (const x of gx) for (const z of gz) asphalt.push([x - W, z - W, x + W, z + W]);
  // rounded corner fillets at each junction (radius J - W), so turning cars stay on the asphalt
  const fil = [], FR = J - W;
  for (const x of gx) for (const z of gz) for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const cx = x + sx * J, cz = z + sz * J, k0 = [x + sx * W, 0.006, z + sz * W], N = 8;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI / 2, a1 = ((i + 1) / N) * Math.PI / 2;
      const P = (a) => [cx - sx * FR * Math.cos(a), 0.006, cz - sz * FR * Math.sin(a)];
      fil.push(...k0, ...P(a0), ...P(a1));
    }
  }
  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(fil, 3)); g.computeVertexNormals(); const m = new THREE.Mesh(g, decal({ color: 0x55585c, roughness: 0.92 })); m.receiveShadow = true; scene.add(m); }
  const road = (horiz, c, a0, a1) => { // a stretch of road along an axis between two junctions
    const A = a0 + J, B = a1 - J, R = (u0, v0, u1, v1) => (horiz ? [u0, v0, u1, v1] : [v0, u0, v1, u1]);
    asphalt.push(R(a0 + W, c - W, a1 - W, c + W));
    for (const s2 of [-1, 1]) lines.push(R(A, c + s2 * (W - 0.32), B, c + s2 * (W - 0.2)));
    for (let u = A + 1; u < B - 3; u += 6) dashes.push(R(u, c - 0.07, u + 3, c + 0.07));
    stops.push(R(A, c - W + 0.3, A + 0.4, c - 0.1), R(B - 0.4, c + 0.1, B, c + W - 0.3)); // stop lines on the approach side
  };
  for (const x of gx) for (let i = 0; i < gz.length - 1; i++) road(false, x, gz[i], gz[i + 1]);
  for (const z of gz) for (let i = 0; i < gx.length - 1; i++) road(true, z, gx[i], gx[i + 1]);
  const paint = decal({ color: 0xc9cbcd, roughness: 0.6 });
  quads(asphalt, 0.006, decal({ color: 0x55585c, roughness: 0.92 }));
  quads(lines, 0.009, paint); quads(dashes, 0.009, paint); quads(stops, 0.009, paint);
  // rumble strips along two lane edges
  { const pos = [], col = [];
    for (const r of T.rumble) for (let z = r.z0; z < r.z1; z += 0.5) {
      const c = Math.floor(z) % 2 ? [0.62, 0.08, 0.06] : [0.86, 0.86, 0.84];
      for (let j = 0; j < 4; j++) {
        const xa = r.x0 + (r.x1 - r.x0) * j / 4, xb = r.x0 + (r.x1 - r.x0) * (j + 1) / 4, P = (x, zz) => [x, heightAt(x, zz) + 0.004, zz];
        pos.push(...P(xa, z), ...P(xb, z + 0.5), ...P(xb, z), ...P(xa, z), ...P(xa, z + 0.5), ...P(xb, z + 0.5));
        for (let k = 0; k < 6; k++) col.push(...c);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, std({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7 })); m.receiveShadow = true; scene.add(m); }
  // rumble kerbs on the corners: red / white blocks, shaped by the height field (ribs and all)
  {
    const pos = [], col = [], red = [0.62, 0.08, 0.06], white = [0.86, 0.86, 0.84];
    for (const [cx, cz, sx, sz] of T.corners) for (const [r0, r1] of [T.kerbIn, T.kerbOut]) {
      const base = sx > 0 ? (sz > 0 ? 0 : -Math.PI / 2) : (sz > 0 ? Math.PI / 2 : -Math.PI);
      const segs = Math.ceil(((Math.PI / 2) * r1) / 0.25);
      for (let k = 0; k < segs; k++) {
        const t0 = base + (k / segs) * Math.PI / 2, t1 = base + ((k + 1) / segs) * Math.PI / 2;
        const c = Math.floor(((k + 0.5) / segs) * (Math.PI / 2) * r1) % 2 ? red : white;
        const across = 4;
        for (let j = 0; j < across; j++) {
          const ra = r0 + ((r1 - r0) * j) / across, rb = r0 + ((r1 - r0) * (j + 1)) / across;
          const P = (r, t) => { const x = cx + Math.cos(t) * r, z = cz + Math.sin(t) * r; return [x, heightAt(x, z) + 0.004, z]; };
          const A = P(ra, t0), B = P(rb, t0), C = P(rb, t1), D = P(ra, t1);
          pos.push(...A, ...B, ...C, ...A, ...C, ...D); for (let v = 0; v < 6; v++) col.push(...c);
        }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, std({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.7 })); m.receiveShadow = true; scene.add(m);
  }
  // kerbs + pavements: a rounded ring round every block (the height field matches it)
  {
    const R = T.J - W, w = T.walkW, mats = [std({ color: 0x6c7b44, roughness: 0.95 }), std({ color: 0xa8a59c, roughness: 0.85 })]; // grass verge on top, pale stone kerb faces
    const rr = (sh, x0, z0, x1, z1, r) => { // rounded rect in shape space (x, -z)
      sh.moveTo(x0 + r, -z0); sh.lineTo(x1 - r, -z0); sh.absarc(x1 - r, -(z0 + r), r, Math.PI / 2, 0, true);
      sh.lineTo(x1, -(z1 - r)); sh.absarc(x1 - r, -(z1 - r), r, 0, -Math.PI / 2, true);
      sh.lineTo(x0 + r, -z1); sh.absarc(x0 + r, -(z1 - r), r, -Math.PI / 2, -Math.PI, true);
      sh.lineTo(x0, -(z0 + r)); sh.absarc(x0 + r, -(z0 + r), r, Math.PI, Math.PI / 2, true);
    };
    for (let i = 0; i < T.gridX.length - 1; i++) for (let k = 0; k < T.gridZ.length - 1; k++) {
      const x0 = T.gridX[i] + W, x1 = T.gridX[i + 1] - W, z0 = T.gridZ[k] + W, z1 = T.gridZ[k + 1] - W;
      const sh = new THREE.Shape(); rr(sh, x0, z0, x1, z1, R);
      const hole = new THREE.Path(); rr(hole, x0 + w, z0 + w, x1 - w, z1 - w, Math.max(0.5, R - w)); sh.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(sh, { depth: T.curbH, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mats); m.receiveShadow = true; m.castShadow = true; scene.add(m);
    }
  }
  // hill
  { const h = T.hill; heightMesh(h.x - h.R, h.x + h.R, h.z - h.R, h.z + h.R, 72, 72, std({ map: (() => { const t = grassTex(); t.repeat.set(1 / 6, 1 / 6); return t; })(), roughness: 0.95 })); } // same surface as the floor: no visible edge
  // speed bumps (yellow), over the road
  { const b = T.bumps; for (const bz of b.zs) heightMesh(b.x0, b.x1, bz - b.w / 2, bz + b.w / 2, 4, 12, std({ color: 0xc9a227, polygonOffset: true, polygonOffsetFactor: -3 })); }
  // bollards: yellow steel posts with a black band
  {
    const B = T.bollards, post = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 14).translate(0, 0.5, 0), std({ color: 0xd9a81c, roughness: 0.45, metalness: 0.3 }), B.length);
    const band = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 14).translate(0, 0.5, 0), std({ color: 0x151515, roughness: 0.6 }), B.length);
    const m4 = new THREE.Matrix4();
    B.forEach((o, i) => { post.setMatrixAt(i, m4.makeScale(o.r, o.h, o.r).setPosition(o.x, 0, o.z)); band.setMatrixAt(i, m4.makeScale(o.r * 1.03, 0.1, o.r * 1.03).setPosition(o.x, o.h * 0.72, o.z)); });
    post.castShadow = band.castShadow = true; scene.add(post, band);
  }
  // traffic lights: pole, head, three lamps per approach (lamps recoloured each frame)
  {
    const N = SIG_HEADS.length, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 8).translate(0, 1.6, 0), std({ color: 0x2b2d30, roughness: 0.6, metalness: 0.4 }), N);
    const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.9, 0.22), std({ color: 0x1a1b1d, roughness: 0.7 }), N);
    const lamp = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }), N * 3);
    SIG_HEADS.forEach((hd, i) => {
      q.setFromAxisAngle(Y, hd.yaw);
      pole.setMatrixAt(i, m4.compose(new THREE.Vector3(hd.x, T.curbH, hd.z), q, one));
      head.setMatrixAt(i, m4.compose(new THREE.Vector3(hd.x, T.curbH + 3.0, hd.z), q, one));
      for (let k = 0; k < 3; k++) {
        const p = new THREE.Vector3(0, 0.27 - k * 0.27, 0.12).applyQuaternion(q).add(new THREE.Vector3(hd.x, T.curbH + 3.0, hd.z));
        lamp.setMatrixAt(i * 3 + k, m4.compose(p, q, one));
      }
    });
    pole.castShadow = head.castShadow = true;
    scene.add(pole, head, lamp);
    const ON = { red: new THREE.Color(4, 0.25, 0.15), amber: new THREE.Color(4, 1.8, 0.1), green: new THREE.Color(0.2, 3.5, 1.2) };
    const OFF = [new THREE.Color(0.12, 0.02, 0.02), new THREE.Color(0.12, 0.07, 0.01), new THREE.Color(0.02, 0.1, 0.04)];
    window.__updateSignals = () => { // red, amber, green top to bottom
      SIG_HEADS.forEach((hd, i) => {
        const st = signals.state(hd.ni, hd.ns);
        lamp.setColorAt(i * 3, st === 'red' ? ON.red : OFF[0]);
        lamp.setColorAt(i * 3 + 1, st === 'amber' ? ON.amber : OFF[1]);
        lamp.setColorAt(i * 3 + 2, st === 'green' ? ON.green : OFF[2]);
      });
      lamp.instanceColor.needsUpdate = true;
    };
    window.__updateSignals();
  }
  // the countryside: villages, farms, forests, a park with a pond (the middle block keeps the test area)
  OBSTACLES.push(...buildCountryside(scene, T, { exclude: (i, k) => i === 1 && k === 1 }).obstacles);
  // crash wall + jersey barriers
  for (const o of T.boxes) {
    let geo;
    if (o.kind === 'barrier') { // the classic safety-shape profile, extruded
      const sh = new THREE.Shape([[-0.3, 0], [0.3, 0], [0.3, 0.08], [0.12, 0.33], [0.075, o.h], [-0.075, o.h], [-0.12, 0.33], [-0.3, 0.08]].map(([x, y]) => new THREE.Vector2(x, y)));
      geo = new THREE.ExtrudeGeometry(sh, { depth: o.hz * 2, bevelEnabled: false }).translate(0, 0, -o.hz);
    } else geo = new THREE.BoxGeometry(o.hx * 2, o.h, o.hz * 2).translate(0, o.h / 2, 0);
    const m = new THREE.Mesh(geo, std({ color: o.kind === 'wall' ? 0x8f8d88 : 0xb9b6ae, roughness: 0.95 }));
    m.position.set(o.x, 0, o.z); m.rotation.y = o.yaw; m.castShadow = m.receiveShadow = true; scene.add(m);
  }
}
const vehicles = [];
const randModel = () => (Math.random() < 0.5 ? 'seltos' : 'mustang');
// the cars: which model file (profile) + physics + engine sound
const MODELS = {
  seltos: { profile: 'seltos', P: {}, engine: { cyl: 4, sport: 0 }, mode: 'AWD' },
  // Ford Mustang GT500: ~1900 kg, 57:43, supercharged 5.2 V8 (~850 Nm), 7-speed, rear-wheel drive
  mustang: {
    profile: 'mustang', engine: { cyl: 8, sport: 1 }, mode: 'RWD',
    P: {
      mass: 1900, inertia: v3(2700, 3000, 720), cgHeight: 0.5, wheelbase: 2.727, frontWeight: 0.57, trackF: 1.67, trackR: 1.67, wheelR: 0.351,
      body: { x: 0.98, yLo: -0.34, yHi: 0.95, zF: 2.15, zR: -2.68 }, rideHzF: 1.7, rideHzR: 1.8, arbF: 32000, arbR: 18000,
      muBase: 1.12, brakeF: 3800, brakeR: 2200, cdA: 0.75, engineI: 0.3, idleRpm: 750, limiterRpm: 7800, redlineRpm: 7500,
      gears: [-3.0, 0, 3.13, 2.07, 1.45, 1.1, 0.86, 0.69], finalDrive: 3.73, clutchMax: 1400, maxBoost: 0.8, torqueMul: 3.2,
    },
  },
};
function addVehicle({ name, paint, player, model = 'seltos', police = false }) {
  const M = MODELS[model];
  const car = createCar(M.P);
  car.mode = M.mode;
  prepareCollider(car);
  const group = new THREE.Group();
  scene.add(group);
  const v = { name, car, group, paint, player, inst: null, rig: null, sb: null, lastSkid: [null, null, null, null],
    model, police, kit: null, audio: new CarAudio({ spatial: !player, engine: M.engine }), shadow: makeContactShadow(), hits: [], ai: null, hitCool: 0, scrape: 0 };
  vehicles.push(v);
  return v;
}
// your vehicle and the level's traffic come from the settings (picked in the Esc menu)
const S = loadSettings();
const VEHICLE = ['police', 'seltos', 'mustang'].includes(S.vehicle) ? S.vehicle : 'police';
const me = VEHICLE === 'police'
  ? addVehicle({ name: 'you', paint: POLICE_PAINT, player: true, model: 'seltos', police: true })
  : addVehicle({ name: 'you', paint: S.paint ?? undefined, player: true, model: VEHICLE });
const car = me.car;
if (MTN) { const p = route.pts[0]; resetCar(car, v3(p.x + Math.cos(p.heading) * LANE, 0, p.z - Math.sin(p.heading) * LANE), p.heading); }
else resetCar(car, v3(0, 0, 0), 0);
// two-way traffic on the loop: one car each way, each in its own (right-hand) lane
const NODES = SIG_NODES; // same order as the signal controllers
const other = addVehicle({ name: 'traffic', paint: 0x1d4f91, player: false, model: randModel() });
other.ai = new AIDriver(other.car, route, { lane: LANE });
other.ai.nodes = NODES;
other.ai.placeAt(MTN ? Math.round(route.pts.length * 0.06) : 43); // ahead of you, same way
const other2 = addVehicle({ name: 'traffic 2', paint: 0x7a1d1d, player: false, model: randModel() });
const routeBack = MTN ? reverseRoute(route) : reverseRoute(buildRoute({ x0: -90, x1: 72, z0: -175, z1: 110 })); // the other way round
other2.ai = new AIDriver(other2.car, routeBack, { lane: LANE, cruise: 13 });
other2.ai.nodes = NODES;
other2.ai.placeAt(Math.round(routeBack.pts.length * 0.55)); // across the loop, coming the other way
const other3 = addVehicle({ name: 'traffic 3', paint: 0x2f5d3a, player: false, model: randModel() });
other3.ai = new AIDriver(other3.car, MTN ? route : buildRoute({ x0: -90, x1: 150, z0: -175, z1: -100 }), { lane: LANE, cruise: 14 });
other3.ai.nodes = NODES;
other3.ai.placeAt(MTN ? Math.round(route.pts.length * 0.55) : 30);
// AI traffic on/off (off for now: three extra detailed cars were too heavy). With it off the traffic
// cars are created but never added: no model, physics, audio or collisions.
const TRAFFIC = false;
let traffic = TRAFFIC ? [other, other2, other3] : [];
for (const t of [other, other2, other3]) if (!traffic.includes(t)) { vehicles.splice(vehicles.indexOf(t), 1); scene.remove(t.group, t.shadow); }
// the flat map: AI_COUNT cars driving loops of all sizes over the open ground, both directions (no lights
// out here). The first five are the hand-placed loops round the start; the rest are random rectangles
// (seeded, so the layout is the same every run), spawned clear of you and of each other.
const AI_COUNT = clamp(Math.round(S.traffic ?? 6), 0, 12);
if (MAP === 'flat') {
  let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const TYPES = ['calm', 'calm', 'calm', 'slow', 'distracted', 'racer'];
  const PAINTS = [0x1d4f91, 0x7a1d1d, 0x2f5d3a, 0xc9c9c4, 0x8a6a2a, 0x202226, 0xe8e8e4, 0x6b6f75, 0x3b5f8a, 0x8c1c2c, 0xd0a020, 0x4a3b6b];
  const loops = [
    [route, 0.09, 'calm'], [reverseRoute(route), 0.5, 'racer'],
    [buildRoute({ x0: -90, x1: 72, z0: -175, z1: 110 }), 0.3, 'slow'],
    [reverseRoute(buildRoute({ x0: -90, x1: 150, z0: -175, z1: -100 })), 0.4, 'distracted'],
    [buildRoute({ x0: -150, x1: 210, z0: -240, z1: 200, r: 20 }), 0.65, 'racer'],
  ];
  while (loops.length < AI_COUNT) {
    const w = 120 + rand() * 330, h = 120 + rand() * 330, x0 = -480 + rand() * (960 - w), z0 = -480 + rand() * (960 - h);
    const r = buildRoute({ x0, x1: x0 + w, z0, z1: z0 + h, r: 14 + rand() * 12 });
    loops.push([rand() < 0.5 ? r : reverseRoute(r), rand(), TYPES[Math.floor(rand() * TYPES.length)]]);
  }
  const spots = [{ x: 0, z: 0 }]; // you
  traffic = loops.map(([r, at, type], k) => {
    const t = addVehicle({ name: 'traffic ' + (k + 1), paint: PAINTS[k % PAINTS.length], player: false, model: randModel() });
    t.ai = new AIDriver(t.car, r, { lane: LANE, cruise: 12 + rand() * 5, type });
    let i = Math.round(r.pts.length * at);
    for (let tries = 0; tries < r.pts.length; tries++, i += 7) { // slide along the loop until the spot is clear
      const p = t.ai.laneAt(i);
      if (spots.every((s) => Math.hypot(s.x - p.x, s.z - p.z) > 14)) { spots.push(p); break; }
    }
    t.ai.placeAt(i);
    return t;
  });
}
const cars = vehicles.map((v) => v.car);

// Shaders are compiled for the target they draw into: the frame renders into the HDR buffer (linear,
// no tone mapping), the screen is sRGB + ACES - different programs. Pre-compiles must use the HDR
// target or they warm the wrong variants and the real ones still compile mid-game.
function asFrame(fn) { const rt = renderer.getRenderTarget(); renderer.setRenderTarget(composer.renderTarget1); try { return fn(); } finally { renderer.setRenderTarget(rt); } }
const loadStatus = document.getElementById('load');
// one template per model (cached: switching back to a model you've driven is instant). The model is
// placed so its CG lands where the physics has it.
const templates = {};
const templateFor = (model, c, onProgress) => (templates[model] ||= loadCarTemplate(MODELS[model].profile, { cgHeight: c.P.cgHeight, a: c.a, onProgress }));
// build a vehicle's visible car from its template: body, wheels, police kit, lamps, doors, detail levels
function buildVisual(v, tpl) {
  v.inst = instantiateCar(tpl, { paint: v.paint });
  if (v.police) v.kit = addPoliceKit(v.inst, tpl.bounds);
  v.group.add(v.inst.body);
  for (const k of ['FL', 'FR', 'RL', 'RR']) scene.add(v.inst.wheels[k].root);
  v.sb = v.inst.sb;
  fitShell(v.car, tpl.samples ? [tpl.samples] : tpl.bodyParts.filter((p) => !p.overlay).map((p) => p.geo.attributes.position.array));
  bindShell(v.car, v.sb);
  v.rig = new LightRig(v.inst, v.group, scene, { player: v.player });
  rigDoors(v);
  asFrame(() => prewarmDebris(renderer, scene, camera, v.inst)); // no shader compiles mid-crash
  // detail levels: cabin interior (only seen up close through the glass) and tiny pieces (badges,
  // bolts, switches) are skipped on cars far from the camera. Only fixed body meshes, never parts.
  v.lod = { interior: [], small: [] };
  for (const m of v.inst.body.children) {
    if (!m.isMesh || m.userData.prepass || m.material.transparent) continue;
    const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, size = b.getSize(new THREE.Vector3()).length();
    if (b.min.x > -0.72 && b.max.x < 0.72 && b.min.y > -0.35 && b.max.y < 0.78 && b.min.z > -1.45 && b.max.z < 0.95) v.lod.interior.push(m);
    else if (size < 0.25) v.lod.small.push(m);
  }
}
const needed = [...new Set(vehicles.map((v) => v.model))], prog = {};
Promise.all(needed.map((m) => templateFor(m, vehicles.find((v) => v.model === m).car,
  (f) => { prog[m] = f; loadStatus.textContent = `Loading cars… ${Math.round((Object.values(prog).reduce((x, y) => x + y, 0) / needed.length) * 100)}%`; loadStatus.style.opacity = 1; },
))).then((tpls) => {
  const T = Object.fromEntries(needed.map((m, i) => [m, tpls[i]]));
  for (const v of vehicles) buildVisual(v, T[v.model]);
  // compile every shader the scene can need now (puddles, fire, smoke, shards, decals...), in the
  // background where the driver supports it: no first-crash stall while a program compiles mid-frame
  asFrame(() => (renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve(renderer.compile(scene, camera))).catch(() => {}));
  loadStatus.style.opacity = 0;
  for (const [m, t] of Object.entries(T)) console.info('car template', m, t.meta, 'lamp groups', Object.keys(t.spots).join(' '));
}).catch((err) => { console.error(err); loadStatus.textContent = 'Car model failed to load: ' + err.message; });

// ---------------------------------------------------------------- hinged panels: doors, bonnet, tailgate
// Each panel's meshes hang off a pivot on its hinge line and swing about one axis (car frame).
function rigPanel(v, id, kind, hinge, axis, opt) {
  const part = v.inst.parts[id];
  if (!part?.box) return;
  const b = part.box;
  const pivot = new THREE.Group();
  pivot.position.copy(hinge);
  v.inst.body.add(pivot);
  for (const m of part.meshes) { pivot.add(m); m.position.copy(hinge).negate(); }
  const com = b.getCenter(new THREE.Vector3()).sub(hinge); // centre of mass from the hinge
  const arm = com.clone().sub(axis.clone().multiplyScalar(com.dot(axis))).length(); // lever arm about the hinge
  const len = arm * 2;
  v.doors.push({ id, kind, part, pivot, axis, com, arm, th: 0, w: 0, latched: true, I: (opt.mass * len * len) / 3, ...opt });
}
function rigDoors(v) {
  v.doors = [];
  for (const id of ['doorFL', 'doorFR', 'doorRL', 'doorRR']) {
    const b = v.inst.parts[id]?.box;
    if (!b) continue;
    const side = Math.sign(b.min.x + b.max.x) || 1; // +x is the car's left
    rigPanel(v, id, 'door', new THREE.Vector3(side > 0 ? b.max.x - 0.05 : b.min.x + 0.05, (b.min.y + b.max.y) / 2, b.max.z - 0.05), new THREE.Vector3(0, -side, 0),
      { side, mass: 28, max: 1.15, detents: [0.5, 1.0], aero: 1, area: (b.max.y - b.min.y) * (b.max.z - b.min.z) });
  }
  const hb = v.inst.parts.hood?.box; // bonnet: hinged at the windscreen end, front lifts
  if (hb) rigPanel(v, 'hood', 'hood', new THREE.Vector3(0, hb.max.y - 0.02, hb.min.z + 0.03), new THREE.Vector3(-1, 0, 0),
    { mass: 16, max: 1.0, detents: [], aero: -0.5, area: (hb.max.x - hb.min.x) * (hb.max.z - hb.min.z) * 0.3 });
  const gb = v.inst.parts.tailgate?.box; // tailgate: hinged along the roof edge, gas struts lift it
  if (gb) rigPanel(v, 'tailgate', 'gate', new THREE.Vector3(0, gb.max.y - 0.02, gb.max.z - 0.03), new THREE.Vector3(1, 0, 0),
    { mass: 22, max: 1.35, detents: [], aero: 0, area: 0, strut: 1 });
  v.handles = (v.inst.tagged.handle || []).map((mesh) => ({ mesh, door: v.doors.find((d) => d.part.meshes.includes(mesh)) })).filter((h) => h.door);
  // outside handles are part of the painted skin: give each door a handle-shaped grip that sits on the
  // skin near the trailing edge, below the window line (invisible until hovered, then it glows)
  for (const d of v.doors) {
    if (d.kind !== 'door' || v.inst.lowpoly) continue; // the low-poly car has real handles
    const b = d.part.box, Y = 0.395, Z = b.min.z + 0.2;
    let sx = 0;
    for (const m of d.part.meshes) {
      if (!m.material.userData.paint) continue;
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i) - Y) < 0.04 && Math.abs(p.getZ(i) - Z) < 0.1) sx = Math.max(sx, d.side * p.getX(i));
    }
    if (!sx) sx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x)) - 0.01;
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.17, 4, 10).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff8a1a, transparent: true, opacity: 0, depthWrite: false }));
    grip.scale.set(0.8, 1, 1);
    grip.position.set(d.side * (sx + 0.012), Y, Z).sub(d.pivot.position);
    grip.userData.grip = true;
    d.pivot.add(grip);
    v.handles.push({ mesh: grip, door: d });
  }
  // steering wheel: spin it about its column (the normal of the rim's plane, through the rim's centre)
  const sw = v.inst.tagged.steer || [];
  if (sw.length) {
    const pts = [];
    for (const m of sw) { const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i += 7) pts.push(new THREE.Vector3().fromBufferAttribute(p, i)); }
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j]; }
    // smallest-variance direction = power iteration on (tr·I − C)
    const tr = C[0] + C[4] + C[8];
    let n = new THREE.Vector3(0, 0.4, -1);
    for (let k = 0; k < 40; k++) n = new THREE.Vector3(tr * n.x - (C[0] * n.x + C[1] * n.y + C[2] * n.z), tr * n.y - (C[3] * n.x + C[4] * n.y + C[5] * n.z), tr * n.z - (C[6] * n.x + C[7] * n.y + C[8] * n.z)).normalize();
    if (n.z > 0) n.negate(); // points back at the driver
    const pivot = new THREE.Group();
    pivot.position.copy(c);
    v.inst.body.add(pivot);
    for (const m of sw) { pivot.add(m); m.position.copy(c).negate(); }
    v.steerRig = { pivot, axis: n };
  }
}
// Panel dynamics: one hinge DOF each. Driven by what the car feels (its acceleration + gravity, in its
// own frame), air pressure at speed, hinge friction, door check-strap detents, the bonnet's prop rod,
// the tailgate's gas struts, the end stop, and knocks from impacts. Swinging shut fast enough latches;
// too gently and it rebounds and rests ajar.
const _r = new THREE.Vector3(), _F = new THREE.Vector3();
function stepDoors(v, dt) {
  if (!v.doors) return;
  const c = v.car, qi = qConj(c.q);
  const aL = qRotate(qi, v3(c.accel.x, c.accel.y + 9.81, c.accel.z)); // felt acceleration (no gravity)
  const vL = qRotate(qi, c.vel);
  for (const d of v.doors) {
    if (!d.part.attached || d.latched || d.propped) { if (!d.propped) d.th = d.w = 0; continue; }
    _r.copy(d.com).applyAxisAngle(d.axis, d.th);
    _F.set(-aL.x, -aL.y, -aL.z).multiplyScalar(d.mass); // gravity minus the frame's acceleration
    let tq = _r.cross(_F).dot(d.axis);
    const qd = 0.5 * 1.2 * vL.z * Math.abs(vL.z); // forward wind slams doors shut, lifts an unlatched bonnet
    tq -= d.aero * qd * d.area * Math.sin(Math.max(d.th, 0.03)) * d.arm;
    if (d.lift > 0) { tq += 1.6 * d.mass * 9.81 * d.arm; d.lift -= dt; } // a hand lifting it
    if (d.strut) tq += 1.25 * d.mass * 9.81 * d.arm * THREE.MathUtils.smoothstep(d.th, 0.06, 0.35); // gas struts
    for (const dt0 of d.detents) if (Math.abs(d.th - dt0) < 0.1) tq -= 160 * (d.th - dt0);
    tq -= 3 * d.w;
    if (Math.abs(d.w) < 0.05 && Math.abs(tq) < 5 && !(d.lift > 0)) { d.w = 0; continue; } // static friction holds it
    tq -= Math.sign(d.w || tq) * 5;
    d.w += (tq / d.I) * dt;
    d.th += d.w * dt;
    const top = d.catch ? 0.035 : d.max; // bonnet safety catch
    if (d.th > top) {
      d.th = top;
      if (d.kind === 'hood' && !d.catch && d.w > 0) { d.propped = true; d.w = 0; d.lift = 0; } // the prop rod drops into place
      else if (d.w > 0) d.w *= -0.25;
    }
    if (d.th < 0.004) {
      if (d.w < -0.9) { v.doorClunk = Math.max(v.doorClunk || 0, clamp(-d.w / 5, 0.2, 1)); d.latched = true; d.catch = false; d.th = 0; d.w = 0; }
      else { d.th = 0.004; if (d.w < 0) d.w *= -0.3; }
    }
  }
}
// impacts near a panel knock it shut; a hard one can pop a bent latch
function doorHits(v) {
  for (const d of v.doors || []) {
    if (!d.part.attached) continue;
    const b = d.part.box;
    for (const h of v.hits) {
      if (h.p.y < b.min.y - 0.3 || h.p.y > b.max.y + 0.4 || h.p.z < b.min.z - 0.9 || h.p.z > b.max.z + 0.9 || h.p.x < b.min.x - 0.6 || h.p.x > b.max.x + 0.6) continue;
      if (d.latched) { if (h.speed > 9 && Math.random() < 0.2) { d.latched = false; d.w = 2 + Math.random() * 3; } }
      else { d.propped = false; d.w -= h.speed * 0.6; }
    }
  }
}
// click: what a person would do with that panel
function operate(d) {
  if (d.kind === 'door') { if (d.latched) { d.latched = false; d.th = 0.01; d.w = 2.6; } else d.w = -4.5; }
  else if (d.kind === 'hood') {
    if (d.latched) { d.latched = false; d.catch = true; d.th = 0.01; d.w = 1.5; } // release: pops onto the safety catch
    else if (d.catch) { d.catch = false; d.lift = 1.2; } // reach under, lift it up onto the prop
    else if (d.propped) { d.propped = false; d.w = -0.2; } // stow the prop, let it drop
    else d.w = -3;
  } else {
    if (d.latched) { d.latched = false; d.th = 0.01; d.w = 2.2; } // pop it, the struts take over
    else d.w = -4;
  }
}
function updateDoors(v) {
  if (v.doorClunk) { v.audio.crash(0.12 * v.doorClunk, 0); v.doorClunk = 0; }
  for (const d of v.doors || []) d.pivot.quaternion.setFromAxisAngle(d.axis, d.th);
  if (v.steerRig) v.steerRig.pivot.quaternion.setFromAxisAngle(v.steerRig.axis, (v.car.wheels[0].steer + v.car.wheels[1].steer) / 2 * 14); // ~14:1 rack
}
const ray = new THREE.Raycaster(), mouseNdc = new THREE.Vector2();
let hoverHandle = null, downAt = null;
// ---------------------------------------------------------------- node grabber (middle mouse, or ctrl + left drag)
// Grab a point on a car body and drag it: a damped spring pulls that point towards the cursor
// (on a plane facing the camera through the grab point). Scroll while holding to change the pull.
const grab = { v: null, local: null, target: new THREE.Vector3(), plane: new THREE.Plane(), k: 1 };
const grabLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffd23a, depthTest: false, transparent: true }));
const grabDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd23a, depthTest: false, transparent: true }));
grabLine.renderOrder = grabDot.renderOrder = 20; grabLine.frustumCulled = false; grabLine.visible = grabDot.visible = false;
scene.add(grabLine, grabDot);
function bodyTargets(v) { return v.inst ? [...v.inst.body.children.filter((m) => m.isMesh && !m.userData.prepass && m.visible), ...(v.doors || []).flatMap((d) => d.pivot.children)] : []; }
function rayFrom(e) { mouseNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(mouseNdc, camera); }
function grabWorld() { // the grabbed body point, world space
  const c = grab.v.car, p = qRotate(c.q, grab.local);
  return new THREE.Vector3(c.pos.x + p.x, c.pos.y + p.y, c.pos.z + p.z);
}
addEventListener('mousedown', (e) => {
  if (!(e.button === 1 || (e.button === 0 && e.ctrlKey))) return;
  e.preventDefault();
  rayFrom(e);
  let best = null;
  for (const v of vehicles) { const h = ray.intersectObjects(bodyTargets(v), false)[0]; if (h && (!best || h.distance < best.h.distance)) best = { v, h }; }
  if (!best) return;
  const c = best.v.car, p = best.h.point;
  grab.v = best.v;
  grab.local = qRotate(qConj(c.q), v3(p.x - c.pos.x, p.y - c.pos.y, p.z - c.pos.z));
  grab.target.copy(p);
  grab.plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), p);
  orbit.drag = false;
}, true);
addEventListener('mousemove', (e) => {
  if (!grab.v) return;
  orbit.drag = false;
  rayFrom(e);
  ray.ray.intersectPlane(grab.plane, grab.target);
});
addEventListener('mouseup', () => { grab.v = null; grabLine.visible = grabDot.visible = false; });
addEventListener('wheel', (e) => { if (grab.v) grab.k = clamp(grab.k * (e.deltaY < 0 ? 1.25 : 0.8), 0.1, 6); }, { passive: true });
addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
function applyGrab() {
  if (!grab.v) return;
  const c = grab.v.car, m = c.P.mass;
  const r = qRotate(c.q, grab.local);
  const pv = v3(c.vel.x + c.angVel.y * r.z - c.angVel.z * r.y, c.vel.y + c.angVel.z * r.x - c.angVel.x * r.z, c.vel.z + c.angVel.x * r.y - c.angVel.y * r.x);
  const k = m * 25 * grab.k, damp = 2 * Math.sqrt(k * m) * 0.35;
  let F = v3((grab.target.x - c.pos.x - r.x) * k - pv.x * damp, (grab.target.y - c.pos.y - r.y) * k - pv.y * damp, (grab.target.z - c.pos.z - r.z) * k - pv.z * damp);
  const fl = Math.hypot(F.x, F.y, F.z), cap = m * 40 * grab.k;
  if (fl > cap) F = v3(F.x * cap / fl, F.y * cap / fl, F.z * cap / fl);
  c.extForce = v3(c.extForce.x + F.x, c.extForce.y + F.y, c.extForce.z + F.z);
  c.extTorque = v3(c.extTorque.x + r.y * F.z - r.z * F.y, c.extTorque.y + r.z * F.x - r.x * F.z, c.extTorque.z + r.x * F.y - r.y * F.x);
}
function drawGrab() {
  if (!grab.v) return;
  const p = grabWorld();
  grabLine.geometry.attributes.position.setXYZ(0, p.x, p.y, p.z);
  grabLine.geometry.attributes.position.setXYZ(1, grab.target.x, grab.target.y, grab.target.z);
  grabLine.geometry.attributes.position.needsUpdate = true;
  grabDot.position.copy(p);
  grabLine.visible = grabDot.visible = true;
}

// hover something you'd operate (a door handle, the bonnet, the tailgate): it glows orange; click to use it
const _hp = new THREE.Vector3();
function glow(h, on) {
  if (h.mesh?.userData.grip) h.mesh.material.opacity = on ? 0.85 : 0;
  else if (h.mesh) h.mesh.material.emissiveIntensity = on ? 2.2 : 0;
  else for (const m of h.panel.part.meshes) if (m.material.emissive && m.material.userData.glow !== false && !m.material.emissiveMap) m.material.emissiveIntensity = on ? 0.35 : 0;
}
function setHover(h) {
  if (hoverHandle === h || (h && hoverHandle && h.mesh === hoverHandle.mesh && h.panel === hoverHandle.panel)) return;
  if (hoverHandle) glow(hoverHandle, false);
  hoverHandle = h;
  if (h) glow(h, true);
  renderer.domElement.style.cursor = h ? 'pointer' : '';
}
function pickHover(hit) {
  if (!hit) return null;
  for (const v of vehicles) for (const h of v.handles || []) if (h.mesh === hit.object) return h.door.part.attached ? { mesh: h.mesh, panel: h.door } : null;
  for (const v of vehicles) for (const d of v.doors || []) {
    if (!d.part.attached || !d.part.meshes.includes(hit.object)) continue;
    if (d.kind !== 'door') return { panel: d };
    // a door: only its handle (allow a few cm around it, handles sit recessed in the skin)
    for (const h of v.handles) {
      if (h.door !== d) continue;
      const g = h.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox.clone().expandByScalar(0.04).containsPoint(h.mesh.worldToLocal(_hp.copy(hit.point)))) return { mesh: h.mesh, panel: d };
    }
  }
  return null;
}
addEventListener('mousemove', (e) => {
  if (grab.v) { setHover(null); return; }
  if (orbit.drag && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) { setHover(null); return; }
  rayFrom(e);
  setHover(pickHover(ray.intersectObjects(vehicles.flatMap(bodyTargets), false)[0])); // nearest hit only: the body occludes
});
addEventListener('mousedown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
addEventListener('click', (e) => {
  if (!hoverHandle || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  operate(hoverHandle.panel);
});

function resetVehicle(v, pos, yaw) {
  fire.extinguish(v); v.fireRolled = false;
  resetCar(v.car, pos, yaw);
  for (const w of v.car.wheels) { w.toe = 0; w.detached = false; }
  v.sb?.reset(); v.rig?.repair();
  if (v.inst) {
    for (const part of Object.values(v.inst.parts)) { part.attached = true; part.hit = 0; for (const m of part.meshes) m.visible = true; }
    for (const k of ['FL', 'FR', 'RL', 'RR']) v.inst.wheels[k].root.visible = true;
    clearDebris(v.inst);
    v.inst.skin.reset();
    v.leaks = null;
    for (const d of v.doors || []) { d.th = d.w = 0; d.latched = true; d.catch = d.propped = false; d.pivot.quaternion.identity(); }
  }
  v.lastSkid.fill(null);
}

// ---------------------------------------------------------------- particles (smoke, dust, exhaust, sparks)
const MAXP = 2600; // smoke from a car fire alone keeps a few hundred puffs alive
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 4), pSize = new Float32Array(MAXP), pRot = new Float32Array(MAXP * 2);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 4));
pGeo.setAttribute('size', new THREE.BufferAttribute(pSize, 1));
pGeo.setAttribute('rot', new THREE.BufferAttribute(pRot, 2)); // rotation, glow (sparks ignore the scene light)
// tileable fractal noise: each puff samples it at its own offset, so no two have the same outline
const smokeTex = (() => {
  const N = 128, oct = [[4, 0.5], [8, 0.27], [16, 0.15], [32, 0.08]];
  const grids = oct.map(([f]) => Array.from({ length: f * f }, Math.random));
  const data = new Uint8Array(N * N * 4);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    oct.forEach(([f, amp], o) => {
      const gx = (x / N) * f, gy = (y / N) * f, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = sm(gx - x0), ty = sm(gy - y0);
      const g = grids[o], at = (i, j) => g[((j % f) * f) + (i % f)];
      v += amp * lerp(lerp(at(x0, y0), at(x0 + 1, y0), tx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
    });
    data.set([v * 255, v * 255, v * 255, 255], (y * N + x) * 4);
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
})();
const pMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { fogColor: { value: scene.fog.color.clone() }, tex: { value: smokeTex }, uLight: { value: 1 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 } },
  vertexShader: `attribute float size; attribute vec4 color; attribute vec2 rot; varying vec4 vc; varying vec2 vr; varying float vSeed; varying float vH, vS;
    void main(){ vH = position.y; vS = size; vc = color; vr = rot; vSeed = fract(rot.x * 7.31); vec4 mv = modelViewMatrix*vec4(position,1.); gl_PointSize = size * ${(innerHeight / 2).toFixed(1)} / -mv.z; gl_Position = projectionMatrix*mv; }`,
  // smoke is shaded like a lumpy sphere: a normal from the sprite position bent by the noise
  // gradient, lit by the sun (view space) with wrap-around light, a dark core and a bright rim
  fragmentShader: `uniform sampler2D tex; uniform float uLight, uTime; uniform vec3 uSun; varying vec4 vc; varying vec2 vr; varying float vSeed; varying float vH, vS;
    void main(){ vec2 d = gl_PointCoord - 0.5; d.y = -d.y;
      float r = length(d) * 2.;
      if (vr.y > 1.5) { // soft vapour (exhaust): a plain gaussian haze, no billowy outline
        float a = exp(-r * r * 3.2) * (1. - r * r); if (a <= 0.003 || r > 1.) discard;
        gl_FragColor = vec4(vc.rgb * uLight, vc.a * a); return; }
      if (vr.y > 0.5) { float a = smoothstep(1., 0.2, r); if (a <= 0.003) discard; gl_FragColor = vec4(vc.rgb, vc.a * a); return; }
      float c = cos(vr.x), s = sin(vr.x); vec2 q = mat2(c, -s, s, c) * d;
      vec2 uv = q * 0.55 + vec2(vSeed, fract(vSeed * 13.7)) + vec2(uTime * 0.015, 0.);
      float n = texture2D(tex, uv).r, n2 = texture2D(tex, uv * 2.1 + 0.37).r;
      float dens = (1. - r * r) + (n - 0.5) * 1.1 + (n2 - 0.5) * 0.45;
      float a = smoothstep(0.15, 0.85, dens) * 0.85;
      a *= smoothstep(-0.1, 0.35, (vH + d.y * vS) / max(vS, 0.3)); // soft where it meets the ground
      if (a * vc.a <= 0.004) discard;
      vec3 nrm = normalize(vec3(d * 2. + vec2(dFdx(n), dFdy(n)) * 6., sqrt(max(0.05, 1. - r * r))));
      float lit = 0.5 + 0.5 * dot(nrm, uSun);
      float shade = mix(0.55, 1.08, lit) * mix(0.82, 1., n);
      vec3 col = vc.rgb * shade * uLight;
      gl_FragColor = vec4(col, vc.a * a); }`,
});
pMat.extensions = { derivatives: true };
const pts = new THREE.Points(pGeo, pMat);
pts.frustumCulled = false;
pts.renderOrder = 5; // after skid marks and ground decals, so smoke covers them
scene.add(pts);
const parts = [];
for (let i = 0; i < MAXP; i++) parts.push({ life: 0, max: 1, p: new THREE.Vector3(), v: new THREE.Vector3(), s0: 0.3, s1: 2, c: [1, 1, 1], a: 0.5, rise: 0.4, drag: 1.5 });
let pIdx = 0;
function emit(pos, vel, opt) {
  const q = parts[pIdx]; pIdx = (pIdx + 1) % MAXP;
  q.life = opt.life; q.max = opt.life; q.p.copy(pos); q.v.copy(vel);
  q.s0 = opt.s0; q.s1 = opt.s1; q.c = opt.c; q.a = opt.a; q.rise = opt.rise ?? 0.4; q.drag = opt.drag ?? 1.5;
  q.rot = Math.random() * 6.28; q.spin = (Math.random() - 0.5) * 0.8; q.glow = opt.glow ? 1 : opt.soft ? 2 : 0;
  q.hold = opt.hold || 0; // keep full opacity for this fraction of the life, then fade (dense fire smoke)
}
function updateParticles(dt) {
  for (let i = 0; i < MAXP; i++) {
    const q = parts[i];
    if (q.life > 0) {
      q.life -= dt;
      q.v.multiplyScalar(Math.exp(-q.drag * dt)); q.v.y += q.rise * dt;
      q.p.addScaledVector(q.v, dt);
      if (q.p.y < 0.05) { q.p.y = 0.05; q.v.y = Math.abs(q.v.y) * 0.2; }
      const t = 1 - q.life / q.max;
      pPos[i * 3] = q.p.x; pPos[i * 3 + 1] = q.p.y; pPos[i * 3 + 2] = q.p.z;
      pSize[i] = lerp(q.s0, q.s1, Math.sqrt(t));
      pCol[i * 4] = q.c[0]; pCol[i * 4 + 1] = q.c[1]; pCol[i * 4 + 2] = q.c[2];
      pCol[i * 4 + 3] = q.a * (q.hold ? Math.min(1, (1 - t) / (1 - q.hold)) : 1 - t) * Math.min(1, t * 8);
      q.rot += q.spin * dt; pRot[i * 2] = q.rot; pRot[i * 2 + 1] = q.glow;
    } else pCol[i * 4 + 3] = 0;
  }
  pMat.uniforms.uLight.value = ui.night ? 0.18 : 1;
  pMat.uniforms.uTime.value += dt;
  pMat.uniforms.uSun.value.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true; pGeo.attributes.size.needsUpdate = true; pGeo.attributes.rot.needsUpdate = true;
}

// vehicle fires (flames, black smoke column, fire light, charring): I / Shift+I, or a hard frontal crash
const fire = new FireSystem(scene, smokeTex, emit);

// ---------------------------------------------------------------- traffic cones (knockable)
const CONE_H = 0.7;
const coneGeo = new THREE.CylinderGeometry(0.03, 0.17, CONE_H, 14).translate(0, CONE_H / 2 + 0.03, 0)
  .toNonIndexed();
{ // orange with a white reflective band
  const p = coneGeo.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const y = p.getY(i), w = y > 0.38 && y < 0.52; col.set(w ? [1, 1, 1] : [1, 0.32, 0.04], i * 3); }
  coneGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const coneBase = new THREE.BoxGeometry(0.4, 0.03, 0.4).translate(0, 0.015, 0);
const coneSpots = FLAT_MAP ? [...TEST.slalom, [12, -20], [12, -24], [16, -20], [16, -24]] : [];
if (MAP === 'proto') {
for (let z = -80; z <= 80; z += 14) coneSpots.push([-85, z]); // slalom
for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; coneSpots.push([SKIDPAD.x + Math.cos(a) * (SKIDPAD.r - 3), SKIDPAD.z + Math.sin(a) * (SKIDPAD.r - 3)]); }
for (const kz of FEATURES.kickers.zs) for (const x of [FEATURES.kickers.x0 - 1, FEATURES.kickers.x1 + 1]) coneSpots.push([x, kz - 8], [x, kz - 16]); // kicker run-up gates
}
const coneMesh = new THREE.InstancedMesh(coneGeo, new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0.35, vertexColors: true }), coneSpots.length);
const coneBaseMesh = new THREE.InstancedMesh(coneBase, new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, envMapIntensity: 0.35, color: 0x222222 }), coneSpots.length);
coneMesh.castShadow = true; coneMesh.frustumCulled = coneBaseMesh.frustumCulled = false;
scene.add(coneMesh, coneBaseMesh);
const cones = coneSpots.map(([x, z]) => ({ home: new THREE.Vector3(x, 0, z), p: new THREE.Vector3(x, 0, z), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), down: false }));
const _m = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1), _dq = new THREE.Quaternion();
function resetCones() { for (const c of cones) { c.p.copy(c.home); c.v.set(0, 0, 0); c.w.set(0, 0, 0); c.q.identity(); c.down = false; } }
function updateCones(dt) {
  for (const c of cones) {
    for (const v of vehicles) { // hit test in the car's frame against its body box
      const k = v.car, P = k.P.body;
      const rel = qRotate(qConj(k.q), v3(c.p.x - k.pos.x, c.p.y + 0.3 - k.pos.y, c.p.z - k.pos.z));
      if (Math.abs(rel.x) < P.x + 0.18 && rel.y > P.yLo - 0.4 && rel.y < P.yHi && rel.z > P.zR - 0.18 && rel.z < P.zF + 0.18) {
        const sp = Math.hypot(k.vel.x, k.vel.z);
        if (sp < 0.3) continue;
        const away = new THREE.Vector3(c.p.x - k.pos.x, 0, c.p.z - k.pos.z).normalize();
        c.v.set(k.vel.x * 1.15, 0, k.vel.z * 1.15).addScaledVector(away, 1.5 + sp * 0.3); c.v.y = 1 + sp * 0.12;
        c.w.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize().multiplyScalar(4 + sp * 0.6);
        c.p.addScaledVector(c.v, 0.03);
        c.down = true;
      }
    }
    if (!c.down) continue;
    c.v.y -= 9.81 * dt;
    c.p.addScaledVector(c.v, dt);
    const gy = heightAt(c.p.x, c.p.z);
    if (c.p.y < gy) { // bounce, scrub and roll to a stop lying on its side
      c.p.y = gy; c.v.y = Math.abs(c.v.y) * 0.3;
      c.v.x *= Math.exp(-dt * 5); c.v.z *= Math.exp(-dt * 5); c.w.multiplyScalar(Math.exp(-dt * 6));
    }
    const wl = c.w.length();
    if (wl > 1e-3) { _dq.setFromAxisAngle(c.w.clone().divideScalar(wl), wl * dt); c.q.premultiply(_dq); }
  }
  cones.forEach((c, i) => {
    _m.compose(c.p, c.q, _one);
    coneMesh.setMatrixAt(i, _m); coneBaseMesh.setMatrixAt(i, _m);
  });
  coneMesh.instanceMatrix.needsUpdate = coneBaseMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- skid marks (ring buffer of quads)
const MAXQ = 8000;
const skGeo = new THREE.BufferGeometry();
const skPos = new Float32Array(MAXQ * 4 * 3), skCol = new Float32Array(MAXQ * 4 * 4);
const skIdx = new Uint32Array(MAXQ * 6);
for (let i = 0; i < MAXQ; i++) { const b = i * 4; skIdx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6); }
skGeo.setAttribute('position', new THREE.BufferAttribute(skPos, 3));
skGeo.setAttribute('color', new THREE.BufferAttribute(skCol, 4));
skGeo.setIndex(new THREE.BufferAttribute(skIdx, 1));
const skids = new THREE.Mesh(skGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
skids.frustumCulled = false;
scene.add(skids);
let skN = 0, skDirtyLo = Infinity, skDirtyHi = -1;
function addSkid(v, i, w, intensity, color) {
  const p = new THREE.Vector3(w.cp.x, w.cp.y + 0.012, w.cp.z);
  const side = new THREE.Vector3(w.lat.x, w.lat.y, w.lat.z).multiplyScalar(0.1);
  const prev = v.lastSkid[i];
  const cur = { l: p.clone().add(side), r: p.clone().sub(side), a: intensity };
  if (prev && prev.l.distanceTo(cur.l) < 1.5) {
    if (prev.l.distanceTo(cur.l) < 0.12) return;
    const q = skN % MAXQ; skN++;
    const b = q * 4;
    const set = (k, x) => { skPos[(b + k) * 3] = x.x; skPos[(b + k) * 3 + 1] = x.y; skPos[(b + k) * 3 + 2] = x.z; };
    set(0, prev.l); set(1, prev.r); set(2, cur.l); set(3, cur.r);
    for (let k = 0; k < 4; k++) skCol.set([color[0], color[1], color[2], k < 2 ? prev.a : cur.a], (b + k) * 4);
    skDirtyLo = Math.min(skDirtyLo, q); skDirtyHi = Math.max(skDirtyHi, q);
  }
  v.lastSkid[i] = cur;
}
function flushSkids() {
  if (skDirtyHi < 0) return;
  const pa = skGeo.attributes.position, ca = skGeo.attributes.color;
  pa.clearUpdateRanges(); ca.clearUpdateRanges();
  const n = skDirtyHi - skDirtyLo + 1;
  pa.addUpdateRange(skDirtyLo * 12, n * 12); ca.addUpdateRange(skDirtyLo * 16, n * 16);
  pa.needsUpdate = true; ca.needsUpdate = true;
  skDirtyLo = Infinity; skDirtyHi = -1;
}

// ---------------------------------------------------------------- crashes: parts tearing off, sparks, sound
const velAtW = (c, p) => { const r = v3(p.x - c.pos.x, p.y - c.pos.y, p.z - c.pos.z), w = c.angVel; return v3(c.vel.x + w.y * r.z - w.z * r.y, c.vel.y + w.z * r.x - w.x * r.z, c.vel.z + w.x * r.y - w.y * r.x); };
// paint damage requests, collected over the frame's physics steps (random subset if there are lots)
function paintQ(v, kind, rest, n, dir, speed, sev) {
  const q = (v.paintQ ||= []), item = { kind, rest, n, dir, speed, sev };
  const cap = kind === 'chip' ? 6 : 40;
  v.paintN = (v.paintN || 0) + 1;
  if (q.length < cap) q.push(item); else if (Math.random() < cap / v.paintN) q[(Math.random() * q.length) | 0] = item;
}
function paintDamage(v, dt) {
  const skin = v.inst?.skin;
  if (!skin) return;
  for (const it of v.paintQ || []) {
    if (it.kind === 'chip') { skin.chip(it.rest, it.n, it.sev); continue; }
    const l = Math.hypot(it.dir.x, it.dir.y, it.dir.z) || 1;
    const d = { x: it.dir.x / l, y: it.dir.y / l, z: it.dir.z / l };
    skin.scratch(it.rest, it.n, d, clamp(it.speed * 0.05, 0.04, 0.4), it.sev);
  }
  if (v.paintQ) v.paintQ.length = 0;
  v.paintN = 0;
  skin.update(dt, renderer);
}
const toLocal = (c, p) => qRotate(qConj(c.q), v3(p.x - c.pos.x, p.y - c.pos.y, p.z - c.pos.z));
let crashQueue = []; // { p (world), speed, glass } — sounds/sparks, handled once per frame
const paintOf = (v) => new THREE.Color(v.paint ?? 0xb9bdb5);
const vOf = (car) => vehicles.find((x) => x.car === car);
// hitting the world (bollards, walls, barriers): damage, paint, sparks, sound
function onStaticContacts(events) {
  const worst = new Map();
  for (const e of events) {
    const v = vOf(e.a), c = v.car, speed = -e.vn0;
    if (speed > 2) v.hits.push({ p: toLocal(c, e.p), speed });
    v.ai?.onHit(speed);
    if (!e.core) {
      const qi = qConj(c.q), r = c.shell[e.ia].rest, nl = qRotate(qi, v3(-e.n.x, -e.n.y, -e.n.z));
      if (e.vt > 0.6) { const vs = velAtW(c, e.p), rn = -(vs.x * e.n.x + vs.y * e.n.y + vs.z * e.n.z); paintQ(v, 'scratch', r, nl, qRotate(qi, v3(-vs.x - e.n.x * rn, -vs.y - e.n.y * rn, -vs.z - e.n.z * rn)), e.vt, clamp((e.jn / DT) / 1800, 0.2, 1.6)); }
      if (speed > 4.5 && (e.onset || speed > 8)) paintQ(v, 'chip', r, nl, null, 0, (speed - 4.5) / 9);
    }
    const w = worst.get(v);
    if (!w || speed > w.speed) worst.set(v, { p: e.p, speed, vt: Math.max(w?.vt || 0, e.vt) });
  }
  for (const [v, w] of worst) {
    if (w.speed > 1.5 && v.hitCool <= 0) { crashQueue.push({ p: w.p, speed: w.speed, glass: w.speed > 9 ? clamp((w.speed - 9) / 8, 0, 1) : 0, paint: paintOf(v) }); v.hitCool = 0.15; shakeCam(v, w.speed / 14); }
    v.scrape = Math.max(v.scrape, clamp(w.vt / 8, 0, 1));
    if (w.vt > 4 && Math.random() < 0.3) crashQueue.push({ p: w.p, speed: 0, sparks: w.vt });
  }
}
function onContacts(events) {
  const byPair = new Map();
  for (const e of events) {
    const speed = -e.vn0; // closing speed at this point, m/s
    const va = vOf(e.a), vb = vOf(e.b);
    // remember how hard each spot was hit (parts and wheels tear off from big local impacts)
    for (const v of [va, vb]) { if (speed > 2) v.hits.push({ p: toLocal(v.car, e.p), speed }); v.ai?.onHit(speed, (v === va ? vb : va) === me); }
    if (!e.core) for (const [v, idx, other, sign] of [[va, e.ia, e.b, -1], [vb, e.ib, e.a, 1]]) {
      // paint: the other body sliding over this one scratches along the relative motion; impacts chip
      const c = v.car, r = c.shell[idx].rest, qi = qConj(c.q);
      const nl = qRotate(qi, v3(e.n.x * sign, e.n.y * sign, e.n.z * sign)); // this car's outward normal
      if (e.vt > 0.6) {
        const vo = velAtW(other, e.p), vs = velAtW(c, e.p);
        let rel = v3(vo.x - vs.x, vo.y - vs.y, vo.z - vs.z);
        const rn = rel.x * e.n.x + rel.y * e.n.y + rel.z * e.n.z;
        rel = qRotate(qi, v3(rel.x - e.n.x * rn, rel.y - e.n.y * rn, rel.z - e.n.z * rn));
        paintQ(v, 'scratch', r, nl, rel, e.vt, clamp((e.jn / DT) / 1800, 0.15, 1.5) * clamp(e.vt / 5, 0.3, 1.2));
      }
      if (speed > 4.5 && (e.onset || speed > 8)) paintQ(v, 'chip', r, nl, null, 0, (speed - 4.5) / 9); // impacts only, not every sliding contact
    }
    const k = va.name + vb.name;
    const pr = byPair.get(k) || { va, vb, speed: 0, p: e.p, vt: 0 };
    if (speed > pr.speed) { pr.speed = speed; pr.p = e.p; }
    pr.vt = Math.max(pr.vt, e.jn > 0 ? e.vt : 0);
    byPair.set(k, pr);
  }
  for (const pr of byPair.values()) {
    if (pr.speed > 1.5 && pr.va.hitCool <= 0) {
      for (const v of [pr.va, pr.vb]) { // each car sheds its own paint and plastic
        shakeCam(v, pr.speed / 12);
        crashQueue.push({ p: pr.p, speed: pr.speed * 0.6, glass: pr.speed > 9 ? clamp((pr.speed - 9) / 8, 0, 1) : 0, paint: paintOf(v), quiet: v !== pr.va });
      }
      pr.va.hitCool = pr.vb.hitCool = 0.15;
    }
    pr.va.scrape = Math.max(pr.va.scrape, clamp(pr.vt / 8, 0, 1));
    if (pr.vt > 4 && Math.random() < 0.3) crashQueue.push({ p: pr.p, speed: 0, sparks: pr.vt });
  }
}

// crush (m) / impact speed (m/s) a part can take before it comes off
const TEAR = { mirrorL: [0.04, 5], mirrorR: [0.04, 5], bumperF: [0.15, 11], bumperR: [0.15, 11], hood: [0.3, 20], tailgate: [0.3, 20],
  wiper: [0.08, 8], plateF: [0.06, 7], doorFL: [0.28, 19], doorFR: [0.28, 19], doorRL: [0.28, 19], doorRR: [0.28, 19] };
const sb0 = (v) => v.sb;
// where each fluid lives: crush depth (m) or local impact speed (m/s) that holes it, drip point, base rate (L/s)
const LEAK_SOURCES = [
  { kind: 'coolant', at: v3(0, 0.0, 1.62), r: 0.6, crush: 0.07, hit: 10, drip: v3(0, -0.32, 1.6), rate: 0.03 }, // radiator behind the grille
  { kind: 'coolant', at: v3(-0.62, 0.05, 1.5), r: 0.5, crush: 0.06, hit: 7, drip: v3(-0.62, -0.3, 1.5), rate: 0.02 }, // coolant reservoir + hoses, front corner
  { kind: 'oil', at: v3(0, -0.4, 1.0), r: 0.6, crush: 0.05, hit: 5, drip: v3(0.05, -0.42, 1.0), rate: 0.012 }, // oil pan
  { kind: 'oil', at: v3(0.1, -0.38, 0.5), r: 0.5, crush: 0.06, hit: 6, drip: v3(0.1, -0.4, 0.5), rate: 0.008 }, // gearbox / oil cooler lines
];
function crushAtLocal(sb, x, y, z) { const { c, f } = sb.coords(x, y, z); return sb.crushAt(c, f); }
function checkDamage(v) {
  if (!v.inst) { v.hits.length = 0; return; }
  doorHits(v);
  // fluids: every system that holds liquid can be holed where it sits (car frame, metres)
  for (const L of LEAK_SOURCES) {
    let hit = 0;
    for (const h of v.hits) if (Math.hypot(h.p.x - L.at.x, h.p.y - L.at.y, h.p.z - L.at.z) < L.r) hit = Math.max(hit, h.speed);
    const crush = crushAtLocal(sb0(v), L.at.x, L.at.y, L.at.z);
    if (crush > L.crush || hit > L.hit) startLeak(v, L.kind, L.drip, clamp(L.rate * (1 + crush * 8 + Math.max(0, hit - L.hit) * 0.15), L.rate, L.rate * 6));
  }
  // a hard hit that crushes the engine bay can start a fire: it smokes for a few seconds, then catches
  if (!v.fire && !v.fireRolled) {
    const bay = crushAtLocal(sb0(v), 0, 0.1, v.car.P.body.zF - 0.6);
    if (bay > 0.3) { v.fireRolled = true; if (Math.random() < 0.4) fire.ignite(v, 3 + Math.random() * 6); }
  }
  const sb = v.sb, c = v.car;
  for (const part of Object.values(v.inst.parts)) {
    if (!part.attached) continue;
    const b = part.box, ctr = b.getCenter(new THREE.Vector3());
    let crush = crushAtLocal(sb, ctr.x, ctr.y, ctr.z);
    for (const x of [b.min.x, b.max.x]) for (const z of [b.min.z, b.max.z]) crush = Math.max(crush, crushAtLocal(sb, x, ctr.y, z));
    for (const h of v.hits) if (h.p.x > b.min.x - 0.3 && h.p.x < b.max.x + 0.3 && h.p.y > b.min.y - 0.3 && h.p.y < b.max.y + 0.3 && h.p.z > b.min.z - 0.3 && h.p.z < b.max.z + 0.3) part.hit = Math.max(part.hit || 0, h.speed);
    const [cMax, sMax] = TEAR[part.id] || [0.3, 18];
    if (crush > cMax || (part.hit || 0) > sMax) {
      part.attached = false;
      const out = ctr.clone().normalize().multiplyScalar(1.5).applyQuaternion(v.group.quaternion);
      tearOff(scene, v.inst, part, c, v.group, out.add(new THREE.Vector3(0, 1.2, 0)));
      crashQueue.push({ p: v3(...ctr.clone().applyMatrix4(v.group.matrixWorld).toArray()), speed: 6, glass: part.id.startsWith('door') ? 0.6 : 0, paint: paintOf(v), out });
    }
  }
  // wheels rip off from a big hit right at the hub, or the corner being crushed in
  c.wheels.forEach((w, i) => {
    if (w.detached) return;
    const hy = w.hard.y - 0.25;
    let hit = 0;
    for (const h of v.hits) { const d = Math.hypot(h.p.x - w.hard.x, h.p.y - hy, h.p.z - w.hard.z); if (d < 0.7) hit = Math.max(hit, h.speed); }
    const crush = crushAtLocal(sb, w.hard.x, hy + 0.2, w.hard.z);
    if (hit > 7) w.toe = clamp(w.toe + (Math.random() - 0.5) * 0.004 * hit, -0.08, 0.08); // bent suspension: it pulls
    if (hit > 21 || crush > 0.34) {
      w.detached = true;
      const mw = v.inst.wheels[['FL', 'FR', 'RL', 'RR'][i]];
      const clone = mw.root.clone(true);
      mw.root.visible = false;
      const vel = new THREE.Vector3(c.vel.x, c.vel.y + 1.5, c.vel.z).add(new THREE.Vector3(w.left ? 2 : -2, 0, 0).applyQuaternion(v.group.quaternion));
      spawnPiece(scene, clone, new THREE.Vector3(0.12, 0.35, 0.35), vel, new THREE.Vector3(w.omega, 0, 0).applyQuaternion(v.group.quaternion), v.inst, 18);
    }
  });
  v.hits.length = 0;
  v.rig?.checkCrush((x, y, z) => crushAtLocal(sb, x, y, z));
}
// ---------------------------------------------------------------- shards: small bits of body, plastic and glass
const MAXS = 500;
const shardGeo = new THREE.TetrahedronGeometry(1, 0);
const shardMesh = new THREE.InstancedMesh(shardGeo, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 }), MAXS);
shardMesh.castShadow = true; shardMesh.frustumCulled = false; shardMesh.count = 0;
scene.add(shardMesh);
const shards = []; let shardIdx = 0;
const SHARD_COLS = { black: new THREE.Color(0x141416), grey: new THREE.Color(0x3a3c40), glass: new THREE.Color(0xb8d4e6), chrome: new THREE.Color(0xc8c8cc), red: new THREE.Color(0x9a1010) };
function spawnShard(p, vel, size, color) {
  const s = shards[shardIdx] ||= { p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), scl: new THREE.Vector3(), age: 0 };
  s.p.copy(p); s.v.copy(vel); s.q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
  s.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
  s.scl.set(size * (0.6 + Math.random()), size * (0.15 + Math.random() * 0.3), size * (0.5 + Math.random()));
  s.age = 0; s.rest = false;
  shardMesh.setColorAt(shardIdx, color);
  shardIdx = (shardIdx + 1) % MAXS; shardMesh.count = Math.max(shardMesh.count, shards.length);
  shardMesh.instanceColor.needsUpdate = true;
}
function burstShards(p, speed, glass, paint, out) {
  const n = Math.min(70, Math.round(speed * 3.5));
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    const col = glass && r < glass * 0.5 ? SHARD_COLS.glass : r < 0.45 && paint ? paint : r < 0.75 ? SHARD_COLS.black : r < 0.9 ? SHARD_COLS.grey : r < 0.95 ? SHARD_COLS.red : SHARD_COLS.chrome;
    const vel = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2).multiplyScalar(2 + speed * 0.35);
    if (out) vel.addScaledVector(out, speed * 0.25);
    spawnShard(p, vel, 0.02 + Math.random() * Math.random() * 0.09, col);
  }
}
const _sm = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _sa = new THREE.Vector3();
function updateShards(dt) {
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    s.age += dt;
    if (!s.rest) {
      s.v.y -= 9.81 * dt;
      s.p.addScaledVector(s.v, dt);
      const l = s.w.length();
      if (l > 1e-3) { _sq.setFromAxisAngle(_sa.copy(s.w).divideScalar(l), l * dt); s.q.premultiply(_sq); }
      const gy = heightAt(s.p.x, s.p.z) + s.scl.y * 0.5;
      if (s.p.y < gy) {
        s.p.y = gy; s.v.y = Math.abs(s.v.y) * 0.25; s.v.x *= 0.6; s.v.z *= 0.6; s.w.multiplyScalar(0.5);
        if (s.v.lengthSq() < 0.05) s.rest = true;
      }
    }
    const fade = clamp((40 - s.age) / 3, 0, 1); // tidy up after 40 s
    _sm.compose(s.p, s.q, _sa.copy(s.scl).multiplyScalar(fade));
    shardMesh.setMatrixAt(i, _sm);
  }
  shardMesh.instanceMatrix.needsUpdate = true;
}

function crashFx() {
  for (const c of crashQueue) {
    const p = new THREE.Vector3(c.p.x, c.p.y, c.p.z);
    const n = c.sparks ? 6 : Math.min(60, 8 + c.speed * 4);
    for (let i = 0; i < n; i++) {
      const vel = new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 5, (Math.random() - 0.5) * 8);
      emit(p, vel, { life: 0.25 + Math.random() * 0.35, s0: 0.05, s1: 0.02, c: [1, 0.75 + Math.random() * 0.2, 0.35], a: 1, rise: -9.8, drag: 0.8, glow: 1 });
    }
    if (!c.sparks) {
      for (let i = 0; i < Math.min(30, c.speed * 2); i++) // bits of plastic + glass
        emit(p, new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6),
          { life: 0.8 + Math.random(), s0: 0.05, s1: 0.05, c: c.glass && Math.random() < 0.5 ? [0.8, 0.9, 1] : [0.12, 0.12, 0.13], a: 0.9, rise: -9.8, drag: 0.3 });
      burstShards(p, c.speed, c.glass, c.paint, c.out);
      if (c.quiet) continue;
      const d = camera.position.distanceTo(p);
      me.audio.crash(clamp(c.speed / 14, 0.08, 1) / (1 + d / 20), c.glass);
    }
  }
  crashQueue = [];
}

// ---------------------------------------------------------------- debug lines (the "wheel thing")
const MAXL = 400;
const dbgGeo = new THREE.BufferGeometry();
const dbgPos = new Float32Array(MAXL * 2 * 3), dbgCol = new Float32Array(MAXL * 2 * 3);
dbgGeo.setAttribute('position', new THREE.BufferAttribute(dbgPos, 3));
dbgGeo.setAttribute('color', new THREE.BufferAttribute(dbgCol, 3));
const dbg = new THREE.LineSegments(dbgGeo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
dbg.frustumCulled = false; dbg.renderOrder = 10;
scene.add(dbg);
let dbgN = 0;
function line(a, b, c) {
  if (dbgN >= MAXL) return;
  dbgPos.set([a.x, a.y, a.z, b.x, b.y, b.z], dbgN * 6);
  dbgCol.set([...c, ...c], dbgN * 6);
  dbgN++;
}
const A = (p, d, s) => v3(p.x + d.x * s, p.y + d.y * s, p.z + d.z * s);
function drawDebug() {
  dbgN = 0;
  const P = car.P;
  for (const w of car.wheels) {
    const hard = A(car.pos, qRotate(car.q, w.hard), 1);
    const comp = clamp((P.restLen - w.s) / 0.25, 0, 1);
    line(hard, w.center, [1, 0.15 + 0.6 * (1 - comp), 1]);
    const f = w.contact ? w.fwd : car.fwdBody, u = car.up;
    const c = w.center, R = P.wheelR;
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => A(A(c, f, a * R), u, b * R));
    for (let k = 0; k < 4; k++) line(corners[k], corners[(k + 1) % 4], [1, 0.85, 0.1]);
    if (!w.contact) continue;
    const cp = w.cp;
    line(cp, A(cp, w.n, w.Fz / 7000), [1, 0.2, 0.85]);
    const Fv = v3(w.fwd.x * w.Fx + w.lat.x * w.Fy, w.fwd.y * w.Fx + w.lat.y * w.Fy, w.fwd.z * w.Fx + w.lat.z * w.Fy);
    const lift = A(cp, w.n, 0.03);
    line(lift, A(lift, Fv, 1 / 6000), [0.2, 1, 1]);
    const rad = (SURFACES[w.surface].mu * P.muBase * w.Fz) / 6000;
    let prev = null;
    for (let k = 0; k <= 24; k++) {
      const t = (k / 24) * Math.PI * 2;
      const p = A(A(lift, w.fwd, Math.cos(t) * rad), w.lat, Math.sin(t) * rad);
      if (prev) line(prev, p, [0.3, 1, 0.4]);
      prev = p;
    }
    const sv = v3(w.fwd.x * (w.omega * P.wheelR - w.vx) - w.lat.x * w.vy, 0, w.fwd.z * (w.omega * P.wheelR - w.vx) - w.lat.z * w.vy);
    line(lift, A(lift, sv, 0.08), [1, 0.25, 0.2]);
  }
  line(car.pos, A(car.pos, car.vel, 0.15), [1, 1, 1]);
  // collision boxes of every car
  for (const c of cars) {
    const b = c.P.body, k = [];
    for (const x of [-b.x, b.x]) for (const y of [b.yLo, b.yHi]) for (const z of [b.zR, b.zF]) k.push(A(c.pos, qRotate(c.q, v3(x, y, z)), 1));
    for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) line(k[i], k[j], [1, 0.4, 0.2]);
  }
  dbgGeo.setDrawRange(0, dbgN * 2);
  dbgGeo.attributes.position.needsUpdate = true; dbgGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- input
const keys = new Set();
const ctl = { throttle: 0, brake: 0, steer: 0, revHold: 0 };
const toastEl = document.getElementById('toast');
let toastT = 0;
// the traffic, repaired, each on its loop at the point nearest you plus a bit
function respawnTraffic() {
  for (const [k, t] of traffic.entries()) {
    const ai = t.ai; ai.idx = 0; const { i } = ai.nearestTo(car.pos);
    resetVehicle(t, v3(0, 0, 0), 0); ai.placeAt(i + 26 + k * 30);
    ai.setType(Object.keys(DRIVER_TYPES)[Math.floor(Math.random() * 4)]);
  }
  toast(traffic.length ? 'Traffic respawned ahead' : 'No traffic on this map');
}
function recoverMe() { resetVehicle(me, v3(car.pos.x, 0, car.pos.z), yawOf()); resetCones(); toast('Reset + repaired'); }
function toast() { /* no popups */ }
const yawOf = (c = car) => Math.atan2(c.fwdBody.x, c.fwdBody.z);
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') { keys.clear(); menu.escape(); return; }
  if (menu.isOpen) { menu.key(e.code); return; } // the menu has the keyboard
  keys.add(e.code);
  switch (e.code) {
    case 'KeyE': case 'ShiftLeft': case 'ShiftRight': if (car.autoShift) { car.autoShift = false; toast('Manual gearbox'); } shift(car, +1); break;
    case 'KeyQ': case 'ControlLeft': case 'ControlRight': if (car.autoShift) { car.autoShift = false; toast('Manual gearbox'); } shift(car, -1); break;
    case 'KeyM': car.autoShift = !car.autoShift; toast(car.autoShift ? 'Automatic gearbox' : 'Manual gearbox'); break;
    case 'KeyT': car.tcs = !car.tcs; toast('Stability & traction control ' + (car.tcs ? 'ON' : 'OFF — have fun')); break;
    case 'KeyB': car.abs = !car.abs; toast('ABS ' + (car.abs ? 'ON' : 'OFF')); break;
    case 'KeyV': { const m = Object.keys(DRIVE_MODES); car.mode = m[(m.indexOf(car.mode) + 1) % m.length]; toast('Drivetrain ' + car.mode); break; }
    case 'KeyF': ui.debug = !ui.debug; break;
    default:
      if (ui.debug && DBG_KEYS[e.code]) { const [name, fn] = DBG_KEYS[e.code]; toast(`${name}: ${fn() ? 'ON' : 'OFF'}`); }
      break; // (without this every unhandled key, WASD included, fell through into the camera switch)
    case 'KeyC': ui.cam = (ui.cam + 1) % 5; toast(['Chase cam', 'Far chase cam', 'Bumper cam', 'Cockpit cam', 'Hood cam'][ui.cam]); break;
    case 'KeyR': recoverMe(); break;
    case 'KeyG': respawnTraffic(); break;
    case 'KeyL': ui.headlights = (ui.headlights + 1) % 3; toast(['Headlights off', 'Low beam', 'High beam'][ui.headlights]); break;
    case 'KeyJ': if (me.kit) { const on = me.kit.toggle(); if (!on && ui.siren) { ui.siren = 0; me.audio.siren('off'); } toast(on ? 'Emergency lights on' : 'Emergency lights off'); } break;
    case 'KeyY': if (me.kit) { // siren: off → wail → yelp → hi-lo → off; switching it on also turns the lights on
      ui.siren = ((ui.siren || 0) + 1) % 4;
      const mode = ['off', 'wail', 'yelp', 'hilo'][ui.siren];
      me.audio.siren(mode);
      if (ui.siren) me.kit.set(true);
      toast(ui.siren ? 'Siren: ' + { wail: 'wail', yelp: 'yelp', hilo: 'hi-lo' }[mode] : 'Siren off');
    } break;
    case 'KeyI': if (e.shiftKey) { // set the nearest other car on fire
        const o = vehicles.filter((t) => t !== me && !t.fire).sort((a, b) => a.group.position.distanceTo(me.group.position) - b.group.position.distanceTo(me.group.position))[0];
        if (o) { fire.ignite(o); toast(o.name + ' is on fire'); } else toast('No car to set on fire');
      } else if (me.fire) { fire.extinguish(me); toast('Fire out'); } else { fire.ignite(me); toast('Your car is on fire'); }
      break;
    case 'KeyN': setNight(!ui.night); toast(ui.night ? 'Night' : 'Day'); break;
    // (indArmed is cleared on every press: a stale arm from an earlier turn cancelled the next indicator instantly)
    case 'Comma': ui.indicator = ui.indicator === 1 ? 0 : 1; ui.hazard = false; ui.indArmed = false; break;
    case 'Period': ui.indicator = ui.indicator === -1 ? 0 : -1; ui.hazard = false; ui.indArmed = false; break;
    case 'Slash': ui.hazard = !ui.hazard; ui.indicator = 0; ui.indArmed = false; break;
    case 'KeyK': ui.aiDebug = !ui.aiDebug; toast(ui.aiDebug ? 'AI view: paths, plans, states' : 'AI view off'); break;
    case 'KeyX': ui.muted = !ui.muted; me.audio.setMuted(ui.muted); toast(ui.muted ? 'Muted' : 'Sound on'); break;
    case 'KeyP': ui.paused = !ui.paused; toast(ui.paused ? 'Paused' : 'Running'); break;
    case 'KeyO': ui.slowmo = !ui.slowmo; toast(ui.slowmo ? 'Slow motion 0.25x' : 'Real time'); break;
    case 'KeyH': keys.clear(); menu.pause('controls'); break;
    case 'KeyU': hudC.units = hudC.units === 'mph' ? 'kmh' : 'mph'; break;
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

let orbit = { yaw: 0, pitch: 0, drag: false, lx: 0, ly: 0, idle: 0 };
addEventListener('mousedown', (e) => { orbit.drag = true; orbit.lx = e.clientX; orbit.ly = e.clientY; });
addEventListener('mouseup', () => { orbit.drag = false; orbit.idle = 0; });
addEventListener('mousemove', (e) => {
  if (!orbit.drag) return;
  orbit.yaw -= (e.clientX - orbit.lx) * 0.006; orbit.pitch = clamp(orbit.pitch + (e.clientY - orbit.ly) * 0.004, -0.3, 1.0);
  orbit.lx = e.clientX; orbit.ly = e.clientY;
});

const dotv = (a, b) => (a && b ? a.x * b.x + a.y * b.y + a.z * b.z : 0);
const gpPrev = {};
function gpEdge(gp, b, fn) { const p = !!gp.buttons[b]?.pressed; if (p && !gpPrev[b]) fn(); gpPrev[b] = p; }
function readInput(dt) {
  const k = (...c) => c.some((x) => keys.has(x));
  const thrK = k('KeyW', 'ArrowUp') ? 1 : 0;
  const brkK = k('KeyS', 'ArrowDown') ? 1 : 0;
  const steerK = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
  let hb = k('Space') ? 1 : 0;
  let clutch = k('KeyX') ? 1 : 0;
  let analogSteer = null, analogThr = null, analogBrk = null;
  const gp = navigator.getGamepads?.().find((g) => g && g.connected);
  if (gp) {
    if (!audioStarted && gp.buttons.some((b) => b.pressed)) startAudio();
    const ax = gp.axes[0] || 0;
    if (Math.abs(ax) > 0.06) analogSteer = -Math.sign(ax) * ((Math.abs(ax) - 0.06) / 0.94) ** 1.4;
    const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
    if (rt > 0.02) analogThr = rt;
    if (lt > 0.02) analogBrk = lt;
    if (gp.buttons[0]?.pressed) hb = 1;
    if (gp.buttons[2]?.pressed) clutch = 1;
    gpEdge(gp, 5, () => { car.autoShift = false; shift(car, +1); });
    gpEdge(gp, 4, () => { car.autoShift = false; shift(car, -1); });
    gpEdge(gp, 3, () => resetVehicle(me, v3(car.pos.x, 0, car.pos.z), yawOf()));
    gpEdge(gp, 1, () => { ui.cam = (ui.cam + 1) % 3; });
  }
  const ramp = (cur, tgt, up, down) => cur + clamp(tgt - cur, -down * dt, up * dt);
  let thrT = analogThr ?? thrK, brkT = analogBrk ?? brkK;
  if (car.autoShift) {
    const slow = Math.abs(car.fwdSpeed) < 0.8;
    if (car.gear === 0) { [thrT, brkT] = [brkT, thrT]; }
    if (slow && car.gear !== 0 && brkT > 0.5 && thrT < 0.1) { ctl.revHold += dt; if (ctl.revHold > 0.35) { car.gear = 0; ctl.revHold = 0; } }
    else if (slow && car.gear === 0 && brkT > 0.5 && thrT < 0.1) { ctl.revHold += dt; if (ctl.revHold > 0.35) { car.gear = 2; ctl.revHold = 0; } }
    else ctl.revHold = 0;
    if (car.gear === 1) car.gear = 2;
  }
  ctl.throttle = analogThr !== null ? thrT : ramp(ctl.throttle, thrT, 4, 7);
  ctl.brake = analogBrk !== null ? brkT : ramp(ctl.brake, brkT, 5, 8);
  const v = Math.abs(car.fwdSpeed);
  const beta = Math.abs(Math.atan2(dotv(car.vel, car.leftBody), Math.max(Math.abs(car.fwdSpeed), 1)));
  const gripLock = (car.P.wheelbase * 9) / Math.max(v * v, 1) + 0.085 + beta;
  const lim = clamp(gripLock / car.P.maxSteer, 0.12, 1);
  if (analogSteer !== null) ctl.steer = analogSteer * lerp(1, lim, 0.7);
  else {
    const tgt = steerK * lim;
    const rate = steerK === 0 || Math.sign(tgt) !== Math.sign(ctl.steer) ? 6 : 2.6;
    ctl.steer = ramp(ctl.steer, tgt, rate, rate);
  }
  // self-cancelling indicator once the wheel comes back after a turn
  if (ui.indicator && Math.sign(ctl.steer) === ui.indicator && Math.abs(ctl.steer) > 0.3) ui.indArmed = true;
  if (ui.indArmed && Math.abs(ctl.steer) < 0.05) { ui.indicator = 0; ui.indArmed = false; }
  Object.assign(car.input, { throttle: ctl.throttle, brake: ctl.brake, steer: ctl.steer, handbrake: hb, clutch });
}

// ---------------------------------------------------------------- HUD
const hudC = new Hud(document.getElementById('hud'));
const telem = document.getElementById('telemText'), telemBox = document.getElementById('telemetry'), perfGraph = document.getElementById('perfGraph');
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(pixelRatio); composer.setSize(innerWidth, innerHeight); updateSharpen();
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
let telemT = 0;
function drawHud(fps, dt) {
  const blink = (performance.now() % 750) < 400;
  hudC.draw(car, dt, { gearLabel: gearLabel(car), lamps: { left: (ui.hazard || ui.indicator > 0) && blink, right: (ui.hazard || ui.indicator < 0) && blink, head: ui.headlights } });
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) toastEl.style.opacity = 0; }
  if (!ui.debug) { if (telemBox.style.display !== 'none') telemBox.style.display = 'none'; return; }
  telemBox.style.display = 'block';
  telemT -= dt;
  if (telemT > 0) return;
  telemT = 0.1;
  prof.drawGraph(perfGraph);
  const inf = renderer.info, mem = performance.memory;
  let alive = 0; for (const q of parts) if (q.life > 0) alive++;
  const gpuName = (drawHud.gpu ||= (() => { const g = renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })());
  let p = `GPU: ${gpuName}\n` + `${fps.toFixed(0)} fps · frame ${(1000 / Math.max(fps, 1)).toFixed(1)} ms · gpu ${prof.gpuTotal.toFixed(1)} ms · res ${(pixelRatio * 100).toFixed(0)}% ${innerWidth * pixelRatio | 0}×${innerHeight * pixelRatio | 0} · quality ${['high', 'no AO', 'no AO/MSAA', 'low'][quality]}\n`;
  p += `draws ${inf.render.calls} · tris ${(inf.render.triangles / 1e6).toFixed(2)}M · pts ${inf.render.points} · lines ${inf.render.lines} · programs ${inf.programs?.length ?? '?'} · tex ${inf.memory.textures} · geo ${inf.memory.geometries}${mem ? ` · heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : ''}\n`;
  p += `physics steps/frame ${stepsThisFrame} · car contacts ${lastContacts} · particles ${alive} · debris ${debrisCount()} · soft body ${me.sb?.active > 0 ? 'relaxing' : 'idle'}\n`;
  p += `\nCPU (ms per frame)\n` + prof.table(prof.cpu, ['input + ai', 'car collision', 'soft body', 'vehicle', 'panels', 'ground crush', 'damage + sync', 'debris', 'effects', 'particles', 'render (cpu)', 'hud'], prof.cpu.get('frame')?.avg);
  p += prof.ext ? `\nGPU (ms per frame)\n` + prof.table(prof.gpu, ['shadows', 'scene', 'ao', 'bloom', 'grade', 'output'], 'sum') : `\nGPU timing unavailable (no EXT_disjoint_timer_query_webgl2)\n`;
  const st = dbgState();
  p += `\ntoggles: ` + Object.entries(DBG_KEYS).map(([k, [name]]) => `${k.slice(5)} ${name} ${st[k] ? '●' : '○'}`).join(' · ') + '\n\n';
  const e = car.eng;
  let s = p + `physics ${PHYS_HZ} Hz${ui.slowmo ? ' · slow-mo' : ''}\n`;
  s += `${e.torque.toFixed(0)} Nm · ${(Math.max(0, e.torque) * e.omega / 1000 * 1.341).toFixed(0)} hp · boost ${e.boost.toFixed(2)} bar · clutch ${e.clutchLocked ? 'locked' : (e.clutchCap * 100).toFixed(0) + '%'}\n`;
  const crush = me.sb ? Math.max(...car.shell.map((p) => p.crush)) : 0;
  s += `g long ${(dotv(car.accel, car.fwdBody) / 9.81).toFixed(2)} · lat ${(dotv(car.accel, car.leftBody) / 9.81).toFixed(2)} · max crush ${(crush * 100).toFixed(0)} cm · parts off ${me.inst ? Object.values(me.inst.parts).filter((p) => !p.attached).length : 0}\n\n`;
  s += `      Fz     slip   angle\n`;
  for (const w of car.wheels) s += `${w.name}  ${w.contact ? w.Fz.toFixed(0).padStart(5) : '  air'}  ${w.kappa.toFixed(2).padStart(6)}  ${(w.alpha * 57.3).toFixed(1).padStart(5)}°  ${SURFACES[w.surface].name.toLowerCase()}\n`;
  telem.textContent = s;
}

// ---------------------------------------------------------------- per-vehicle effects
function effects(v, dt) {
  const c = v.car, P = c.P;
  let squeal = 0, pitchW = 0, pitchN = 0, scrub = 0, wet = 0, crunch = 0, hit = 0;
  c.wheels.forEach((w, i) => {
    if (!w.contact) { v.lastSkid[i] = null; return; }
    const surf = SURFACES[w.surface];
    const load = clamp(w.Fz / 4000, 0, 2);
    const slide = Math.max(0, w.slipSpeed - 1.2);
    const cp = new THREE.Vector3(w.cp.x, w.cp.y + 0.1, w.cp.z);
    const wheelV = new THREE.Vector3(c.vel.x, 0, c.vel.z).multiplyScalar(0.3);
    if (surf.fx === 'smoke' || surf.fx === 'spray') {
      const sq = THREE.MathUtils.smoothstep(w.slipSpeed, 2.2, 7.5) * clamp(load, 0, 1.4);
      const use = w.Fz > 50 ? Math.hypot(w.Fx, w.Fy) / (surf.mu * P.muBase * w.Fz) : 0;
      if (surf.fx === 'smoke') {
        squeal += sq; pitchW += sq * clamp((w.slipSpeed - 1.3) / 16, 0, 1); pitchN += sq;
        scrub += THREE.MathUtils.smoothstep(use, 0.8, 1.0) * THREE.MathUtils.smoothstep(Math.abs(w.vx), 3, 15) * (1 - sq) * 0.35;
      } else wet += 0.12 * THREE.MathUtils.smoothstep(Math.abs(w.vx), 2, 30) + sq * 0.5;
      if (slide > 4) { // proper slide or burnout only (launch slip and ABS stops don't smoke)
        const n = Math.min(2, (slide - 3) * dt * 3.5 * load);
        for (let k = 0; k < Math.floor(n) + (Math.random() < n % 1 ? 1 : 0); k++) {
          const isWet = surf.fx === 'spray';
          emit(cp, wheelV.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2)),
            isWet ? { life: 0.8, s0: 0.3, s1: 1.4, c: [0.85, 0.9, 0.95], a: 0.35, rise: -2, drag: 2 }
              : { life: 2.2 + Math.random() * 1.2, s0: 0.8, s1: 3.6, c: [0.8, 0.8, 0.82], a: clamp(0.05 + (slide - 4) / 60, 0, 0.18), rise: 0.25, drag: 1.6 });
        }
      }
      if (slide > 2.5 && surf.fx === 'smoke') addSkid(v, i, w, clamp((slide - 2) / 8, 0.1, 0.75) * clamp(load, 0.3, 1), [0.05, 0.05, 0.05]);
      else v.lastSkid[i] = null;
    } else if (surf.fx === 'dust' || surf.fx === 'dirt') {
      const sp = Math.abs(w.vx) + slide;
      crunch += clamp(sp / 25, 0, 1) * 0.25 + clamp(slide / 10, 0, 1) * 0.25;
      if (sp > 1.5) {
        const n = Math.min(3, (sp * 0.5 + slide * 2) * dt * load);
        const col = surf.fx === 'dust' ? [0.78, 0.66, 0.45] : [0.38, 0.32, 0.22];
        for (let k = 0; k < Math.floor(n) + (Math.random() < n % 1 ? 1 : 0); k++)
          emit(cp, wheelV.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2.5, Math.random() * 2, (Math.random() - 0.5) * 2.5)),
            { life: 1.6 + Math.random(), s0: 0.4, s1: 3.5, c: col, a: surf.fx === 'dust' ? 0.45 : 0.3, rise: 0.15, drag: 1.4 });
      }
      if (slide > 1.5) addSkid(v, i, w, clamp(slide / 10, 0.1, 0.5), surf.fx === 'dust' ? [0.45, 0.35, 0.2] : [0.2, 0.15, 0.08]);
      else v.lastSkid[i] = null;
    } else v.lastSkid[i] = null;
    if (w.Fz > 13000) hit = Math.max(hit, clamp((w.Fz - 13000) / 20000, 0, 1));
  });
  if (c.bodyContact) hit = Math.max(hit, clamp(c.speed / 20, 0.1, 1));
  v.hitCool -= dt;

  // exhaust: a warm petrol engine shows next to nothing - a faint wisp of vapour, a little more on a
  // hard throttle blip. A cold engine puts out visible condensation that fades as it warms (~90 s).
  const e = c.eng;
  v.warm = Math.min(1, (v.warm || 0) + dt * (0.004 + 0.008 * Math.min(1, e.rpm / 3000))); // warms faster when worked
  const cold = 1 - v.warm, blip = Math.max(0, e.load - (v.prevLoad ?? e.load)) / Math.max(dt, 1e-3); // throttle jabs
  v.prevLoad = e.load;
  const vis = 0.15 + 0.85 * cold + Math.min(0.6, blip * 0.05);
  v.exhaustAcc = (v.exhaustAcc || 0) + (2 + e.load * 4) * vis * dt;
  // the tailpipe: tucked under the rear bumper, left side (from the bumper's real extents)
  const bb = v.inst?.parts.bumperR?.box;
  if (!v.exhaustTip && bb) v.exhaustTip = new THREE.Vector3(0.45, bb.min.y + 0.04, bb.min.z + 0.1);
  const tip = v.exhaustTip || new THREE.Vector3(0.45, -P.cgHeight + 0.22, P.body.zR + 0.1);
  const tipW = tip.clone().applyQuaternion(v.group.quaternion).add(v.group.position);
  const back = new THREE.Vector3(0, -0.35, -1).applyQuaternion(v.group.quaternion);
  while (v.exhaustAcc >= 1) {
    v.exhaustAcc -= 1;
    const vel = back.clone().multiplyScalar(0.5 + e.load * 1.5 + e.rpm / 6000).add(new THREE.Vector3(c.vel.x, 0, c.vel.z)) // rolls out low and slow
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.4, Math.random() * 0.2, (Math.random() - 0.5) * 0.4));
    emit(tipW, vel, { life: 0.7 + Math.random() * 0.5, s0: 0.06, s1: 0.35 + e.load * 0.25, c: [0.86, 0.88, 0.9], a: (0.035 + 0.03 * e.load) * Math.min(1, vis), rise: 0.25, drag: 2.8, soft: true });
  }

  const gy = heightAt(c.pos.x, c.pos.z);
  v.shadow.position.set(c.pos.x, gy + 0.015, c.pos.z);
  v.shadow.rotation.y = yawOf(c);
  v.shadow.material.opacity = clamp(1 - (c.pos.y - gy - P.cgHeight) / 1.2, 0, 1) * (ui.night ? 0.6 : 1);

  v.rig?.update(c, v.player ? ui : { headlights: ui.night ? 1 : 0, indicator: 0, hazard: !!v.ai?.hazard, night: ui.night }, camera, dt, v.group, gy);

  const extra = { timeScale: ui.slowmo ? 0.25 : 1, squeal: clamp(squeal / 2.2, 0, 1.2), pitch: pitchN > 0 ? pitchW / pitchN : 0, scrub: clamp(scrub, 0, 1), wet: clamp(wet, 0, 1), crunch: clamp(crunch, 0, 1), hit, scrape: v.scrape };
  v.scrape *= Math.exp(-dt * 8);
  v.audio.update(c, extra);
  if (v.ai) v.audio.horn(v.ai.hornOn);
  if (!v.player) {
    v.audio.setActive(audibleCars().has(v));
    // hear the other car from where the camera is
    const rel = new THREE.Vector3(c.pos.x, c.pos.y, c.pos.z).sub(camera.position);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    v.audio.place(rel.length(), rel.normalize().dot(right));
  }
}

function updateLod(v) {
  if (!v.lod) return;
  const d = camera.position.distanceTo(v.group.position);
  const inside = v.player && ui.cam === 3;
  const showIn = inside || d < 14, showSmall = inside || d < 35;
  if (v.lod.showIn !== showIn) { v.lod.showIn = showIn; for (const m of v.lod.interior) m.visible = showIn; }
  if (v.lod.showSmall !== showSmall) { v.lod.showSmall = showSmall; for (const m of v.lod.small) m.visible = showSmall; }
}
function syncVisuals(v) {
  const c = v.car;
  v.group.position.set(c.pos.x, c.pos.y, c.pos.z);
  v.group.quaternion.set(c.q.x, c.q.y, c.q.z, c.q.w);
  if (!v.inst) return;
  ['FL', 'FR', 'RL', 'RR'].forEach((k, i) => {
    const w = c.wheels[i], mw = v.inst.wheels[k];
    if (w.detached) return;
    // from the car's current pose (w.center was computed before the last integration step, so it
    // trails by one physics step: a visible offset at speed)
    const h = qRotate(c.q, w.hard), up = qRotate(c.q, v3(0, 1, 0));
    mw.root.position.set(c.pos.x + h.x - up.x * w.s, c.pos.y + h.y - up.y * w.s, c.pos.z + h.z - up.z * w.s);
    mw.root.quaternion.copy(v.group.quaternion);
    mw.root.rotateY(w.steer);
    mw.spin.rotation.x = w.angle;
  });
}

// ---------------------------------------------------------------- AI view (K): plans, predictions, states
// per AI car: its lane path ahead (cyan), where it will actually go in the next 3 s from its current
// steering and speed (yellow - this is what moves when it swerves), the point it steers for (white),
// where it means to stop (red bar), a line to whatever it's reacting to (red), and a label.
const aiViz = new Map();
function lineObj(color) {
  const l = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  l.renderOrder = 30; l.frustumCulled = false; scene.add(l); return l;
}
function setLine(l, pts) { l.geometry.dispose(); l.geometry = new THREE.BufferGeometry().setFromPoints(pts); }
// with lots of traffic only the nearest few cars (within 150 m of the camera) run a synth; the rest sleep
let audibleAt = -1, audible = new Set();
function audibleCars() {
  const now = performance.now();
  if (now - audibleAt > 250) {
    audibleAt = now;
    audible = new Set(vehicles.filter((o) => !o.player).map((o) => [o, camera.position.distanceToSquared(o.group.position)])
      .filter(([, d]) => d < 150 * 150).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([o]) => o));
  }
  return audible;
}
function updateAiViz() {
  for (const v of traffic) {
    let z = aiViz.get(v);
    if (!z) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;transform:translate(-50%,-100%);font:600 11px ui-monospace,Menlo,monospace;color:#e8eaec;background:rgba(12,13,15,0.75);padding:3px 6px;border-left:2px solid #37c8ff;pointer-events:none;white-space:pre;display:none';
      document.body.appendChild(el);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
      const bar = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.08, 0.25), new THREE.MeshBasicMaterial({ color: 0xff3b30, depthTest: false }));
      dot.renderOrder = bar.renderOrder = 31; scene.add(dot, bar);
      z = { path: lineObj(0x37c8ff), pred: lineObj(0xffd23a), threat: lineObj(0xff3b30), dot, bar, el };
      aiViz.set(v, z);
    }
    const on = !!ui.aiDebug && !!v.inst;
    for (const o of [z.path, z.pred, z.threat, z.dot, z.bar]) o.visible = on;
    z.el.style.display = on ? 'block' : 'none';
    if (!on) continue;
    const ai = v.ai, c = v.car, y = (x, zz) => heightAt(x, zz) + 0.25;
    const pp = []; // planned lane path, ~70 m ahead
    for (let k = 0; k < 48; k++) { const p = ai.laneAt(ai.idx + k); pp.push(new THREE.Vector3(p.x, y(p.x, p.z), p.z)); }
    setLine(z.path, pp);
    // predicted trajectory: bicycle model from the car's current state and steering, 3 s ahead
    const pr = [];
    let px = c.pos.x, pz = c.pos.z, yaw = Math.atan2(c.fwdBody.x, c.fwdBody.z), sp = Math.max(0, c.fwdSpeed);
    const delta = (c.wheels[0].steer + c.wheels[1].steer) / 2, acc = c.input.throttle * 3 - c.input.brake * 8;
    for (let k = 0; k <= 30; k++) {
      pr.push(new THREE.Vector3(px, y(px, pz) + 0.05, pz));
      yaw += ((sp * Math.tan(delta)) / c.P.wheelbase) * 0.1;
      px += Math.sin(yaw) * sp * 0.1; pz += Math.cos(yaw) * sp * 0.1;
      sp = Math.max(0, sp + acc * 0.1);
    }
    setLine(z.pred, pr);
    const t = ai.dbg.target;
    z.dot.visible = !!t; if (t) z.dot.position.set(t.x, y(t.x, t.z) + 0.2, t.z);
    const sa = ai.dbg.stopAt;
    z.bar.visible = !!sa; if (sa) { z.bar.position.set(sa.x, y(sa.x, sa.z), sa.z); z.bar.rotation.y = Math.atan2(c.fwdBody.x, c.fwdBody.z); }
    const th = ai.dbg.threat;
    z.threat.visible = !!th; if (th) setLine(z.threat, [new THREE.Vector3(c.pos.x, c.pos.y + 0.8, c.pos.z), new THREE.Vector3(th.pos.x, th.pos.y + 0.8, th.pos.z)]);
    const lp = new THREE.Vector3(c.pos.x, c.pos.y + 1.9, c.pos.z).project(camera);
    if (lp.z > 1) { z.el.style.display = 'none'; continue; }
    z.el.style.left = ((lp.x + 1) / 2) * innerWidth + 'px'; z.el.style.top = ((1 - lp.y) / 2) * innerHeight + 'px';
    z.el.style.borderLeftColor = ai.fleeing ? '#ff3b30' : ai.lapseT > 0 || ai.phone ? '#f2b233' : '#37c8ff';
    z.el.textContent = `${v.name} · ${ai.type}${ai.fleeing ? ' · FLEEING' : ''}\n${ai.state} · ${Math.round(c.speed * 3.6)}→${Math.round((ai.vT ?? 0) * 3.6)} km/h · react ${ai.react.toFixed(2)}s`;
  }
}

// ---------------------------------------------------------------- camera
const camPos = new THREE.Vector3(0, 3, -8);
let camYaw = 0;
// ---- camera physicality: a camera mount with mass (it lags under acceleration and overshoots a
// little), trauma-driven shake (impacts, landings, kerbs, speed buzz), a slight roll into corners and
// an FOV kick under acceleration. The cockpit view gets a head that's thrown around by g-forces.
const cam = { pp: null, pv: new THREE.Vector3(), trauma: 0, t: 0, head: new THREE.Vector3(), headV: new THREE.Vector3(), roll: 0, fovK: 0, prevVy: 0 };
function shakeCam(v, amt) {
  const d = camera.position.distanceTo(v.group.position);
  cam.trauma = Math.min(1, cam.trauma + amt / (1 + d / 15));
}
const shakeN = (t, k) => Math.sin(t * 13.1 + k) * 0.5 + Math.sin(t * 27.3 + k * 2.1) * 0.3 + Math.sin(t * 51.7 + k * 3.7) * 0.2;
function camFeel(dt) {
  cam.t += dt;
  const aw = v3(car.accel.x, car.accel.y + 9.81, car.accel.z); // felt acceleration (world)
  const aL = qRotate(qConj(car.q), aw);
  // jolts: vertical felt accel far from 1 g (landings, kerbs, bottoming out)
  const jolt = Math.abs(aL.y - 9.81);
  if (jolt > 6) cam.trauma = Math.min(1, cam.trauma + (jolt - 6) * 0.004);
  cam.trauma = Math.max(0, cam.trauma - dt * 1.4);
  const buzz = clamp(car.speed / 45, 0, 1) * 0.06; // fine high-speed vibration
  const sh = cam.trauma * cam.trauma + buzz * 0.15;
  return { aL, sh, lat: aL.x / 9.81, lon: aL.z / 9.81 };
}
function applyShake(sh, posAmp, rotAmp) {
  if (sh <= 0.0005) return;
  const t = cam.t;
  camera.position.x += shakeN(t, 1) * posAmp * sh; camera.position.y += shakeN(t, 2) * posAmp * sh; camera.position.z += shakeN(t, 3) * posAmp * sh;
  camera.rotateX(shakeN(t, 4) * rotAmp * sh); camera.rotateY(shakeN(t, 5) * rotAmp * sh); camera.rotateZ(shakeN(t, 6) * rotAmp * 0.6 * sh);
}
function updateCamera(dt) {
  const pos = new THREE.Vector3(car.pos.x, car.pos.y, car.pos.z);
  const feel = camFeel(dt);
  const fwd = new THREE.Vector3(car.fwdBody.x, 0, car.fwdBody.z).normalize();
  let targetYaw = Math.atan2(fwd.x, fwd.z);
  const vflat = new THREE.Vector3(car.vel.x, 0, car.vel.z);
  if (vflat.length() > 3 && car.fwdSpeed > 0) {
    let d = Math.atan2(vflat.x, vflat.z) - targetYaw; d = Math.atan2(Math.sin(d), Math.cos(d));
    targetYaw += d * 0.55;
  }
  let dy = targetYaw - camYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  camYaw += dy * (1 - Math.exp(-dt * 4));
  if (ui.attract) { orbit.drag = true; orbit.attract = true; orbit.yaw += dt * 0.12; orbit.pitch = -0.05; } // title screen: slow turntable round the car
  else if (orbit.attract) { orbit.attract = false; orbit.drag = false; orbit.idle = 2; }
  if (!orbit.drag) { orbit.idle += dt; if (orbit.idle > 1.5) { orbit.yaw *= Math.exp(-dt * 2); orbit.pitch *= Math.exp(-dt * 2); } }
  if (ui.cam === 3) { // driver's eyes (left-hand drive), looking out the windscreen
    // the head is a damped mass on the neck: braking throws it forward, corners sideways, bumps up
    const want = new THREE.Vector3(clamp(-feel.aL.x * 0.006, -0.07, 0.07), clamp(-(feel.aL.y - 9.81) * 0.004, -0.05, 0.05), clamp(-feel.aL.z * 0.006, -0.08, 0.08));
    cam.headV.addScaledVector(want.sub(cam.head).multiplyScalar(160).addScaledVector(cam.headV, -18), Math.min(dt, 0.05));
    cam.head.addScaledVector(cam.headV, Math.min(dt, 0.05));
    camera.position.copy(new THREE.Vector3(0.37, 0.72, -0.25).add(cam.head).applyQuaternion(me.group.quaternion).add(pos));
    camera.up.set(car.up.x, car.up.y, car.up.z);
    camera.lookAt(new THREE.Vector3(0.37 + Math.sin(orbit.yaw) * 20, 0.5 - orbit.pitch * 10, Math.cos(orbit.yaw) * 20).applyQuaternion(me.group.quaternion).add(pos));
    camera.rotateZ(clamp(feel.lat * 0.02, -0.04, 0.04)); // head leans against the corner
    applyShake(feel.sh, 0.02, 0.02);
    camera.fov = 72; camera.near = 0.05; camera.updateProjectionMatrix();
    return;
  }
  if (ui.cam === 4) { // on the bonnet, just ahead of the windscreen
    camera.position.copy(new THREE.Vector3(0, 0.74, 0.5).applyQuaternion(me.group.quaternion).add(pos));
    camera.up.set(car.up.x, car.up.y, car.up.z);
    camera.lookAt(new THREE.Vector3(Math.sin(orbit.yaw) * 20, -0.6 - orbit.pitch * 10, Math.cos(orbit.yaw) * 20).applyQuaternion(me.group.quaternion).add(pos));
    applyShake(feel.sh, 0.015, 0.015);
    camera.fov = 68; camera.near = 0.05; camera.updateProjectionMatrix();
    return;
  }
  camera.near = 0.1;
  if (ui.cam === 2) {
    camera.position.copy(new THREE.Vector3(0, 0.55, 1.95).applyQuaternion(me.group.quaternion).add(pos));
    camera.up.set(car.up.x, car.up.y, car.up.z);
    camera.lookAt(new THREE.Vector3(0, 0.3, 20).applyQuaternion(me.group.quaternion).add(pos));
    applyShake(feel.sh, 0.015, 0.015);
    camera.fov = 70; camera.updateProjectionMatrix();
    return;
  }
  camera.up.set(0, 1, 0);
  const dist = ui.cam === 0 ? 6.6 : 11, height = ui.cam === 0 ? 2.1 + orbit.pitch * 4 : 3.6 + orbit.pitch * 6;
  const yaw = camYaw + orbit.yaw;
  const pull = clamp(car.speed / 60, 0, 1) * 1.2;
  // pivot = middle of the body (the CG sits ahead of it); the camera's offset from the pivot is
  // smoothed, never its absolute position, so it can't trail behind at speed
  const mid = qRotate(car.q, v3(0, 0.55, (car.P.body.zF + car.P.body.zR) / 2));
  const pivot = new THREE.Vector3(pos.x + mid.x, pos.y + mid.y, pos.z + mid.z);
  const want = new THREE.Vector3(-Math.sin(yaw) * (dist + pull), height - 0.55, -Math.cos(yaw) * (dist + pull));
  camPos.lerp(want, 1 - Math.exp(-dt * 10)); // camPos now holds the offset
  // the mount has mass: the pivot the camera hangs off is a damped spring chasing the real one, so
  // hard acceleration pushes the view back, braking swings it forward, and it settles with a small overshoot
  if (!cam.pp || cam.pp.distanceTo(pivot) > 6) { cam.pp = pivot.clone(); cam.pv.set(0, 0, 0); }
  for (let k = 0, h = Math.min(dt, 0.05) / 2; k < 2; k++) {
    const acc = pivot.clone().sub(cam.pp).multiplyScalar(110).addScaledVector(cam.pv, -2 * Math.sqrt(110) * 0.6);
    cam.pv.addScaledVector(acc, h); cam.pp.addScaledVector(cam.pv, h);
  }
  const lag = cam.pp.clone().sub(pivot);
  if (lag.length() > 0.9) { lag.setLength(0.9); cam.pp.copy(pivot).add(lag); }
  const at = cam.pp.clone().add(camPos);
  at.y = Math.max(at.y, heightAt(at.x, at.z) + 0.4);
  camera.position.copy(at);
  camera.lookAt(pivot.clone().lerp(cam.pp, 0.6));
  cam.roll += (clamp(-feel.lat * 0.025, -0.05, 0.05) - cam.roll) * (1 - Math.exp(-dt * 4));
  camera.rotateZ(cam.roll); // lean with the corner
  applyShake(feel.sh, 0.12, 0.03);
  cam.fovK += (clamp(feel.lon * 3, -2, 5) - cam.fovK) * (1 - Math.exp(-dt * 3));
  camera.fov = 58 + clamp(car.speed / 70, 0, 1) * 10 + cam.fovK;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- audio start (needs a user gesture)
let audioStarted = false;
async function startAudio() {
  if (audioStarted) return;
  audioStarted = true;
  try { for (const v of vehicles) await v.audio.start(); me.audio.setMuted(ui.muted); } catch (err) { console.error(err); toast('Audio failed: ' + err.message); }
}
addEventListener('keydown', startAudio);
addEventListener('pointerdown', startAudio);

// ---------------------------------------------------------------- adaptive resolution (GPU-timed)
const gl = renderer.getContext();
const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const gpuQueries = [];
let gpuMs = 0, gpuSamples = [], adaptT = 0, frameNo = 0;
function gpuTimed(fn) {
  if (prof.on) { fn(); if (frameNo++ % 4 === 0 && prof.gpuTotal > 0) gpuSamples.push(prof.gpuTotal); return; }
  if (!timerExt || frameNo++ % 4) { fn(); return; }
  const q = gl.createQuery();
  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(timerExt.TIME_ELAPSED_EXT);
  gpuQueries.push(q);
}
function pollGpu() {
  while (gpuQueries.length && gl.getQueryParameter(gpuQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
    const q = gpuQueries.shift();
    if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) gpuSamples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(q);
  }
  if (gpuQueries.length > 30) gpuQueries.splice(0, 10).forEach((q) => gl.deleteQuery(q));
}
function updateSharpen() {
  grade.uniforms.uSharp.value = clamp((devicePixelRatio - pixelRatio) / devicePixelRatio * 2.5, 0, 1);
  grade.uniforms.uTexel.value.set(1 / (innerWidth * pixelRatio), 1 / (innerHeight * pixelRatio));
}
function setPr(nr) {
  nr = clamp(nr, 0.6, MAX_PR);
  if (Math.abs(nr - pixelRatio) < 0.02) return;
  pixelRatio = nr; renderer.setPixelRatio(pixelRatio); renderer.setSize(innerWidth, innerHeight); composer.setPixelRatio(pixelRatio); composer.setSize(innerWidth, innerHeight); updateSharpen();
}
let fpsS = 60;
// quality ladder (0 = everything on): 1 no AO, 2 + no MSAA, 3 + 1024 shadows
let quality = INTEGRATED ? 2 : 0; // laptops start without AO / MSAA (the adaptive loop can raise it)
function applyQuality() {
  gtao.enabled = quality < 1 && !dbgForce.noAO;
  const n = quality < 2 ? 4 : 0;
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== n) { rt.samples = n; rt.dispose(); }
  const sm = quality < 3 ? 2048 : 1024;
  if (sun.shadow.mapSize.x !== sm) { sun.shadow.mapSize.set(sm, sm); sun.shadow.map?.dispose(); sun.shadow.map = null; }
}
const dbgForce = { noAO: false };
function qualityDown() { if (quality >= 3) return false; quality++; applyQuality(); return true; }
function qualityUp() { if (quality <= 0) return; quality--; applyQuality(); }
function adaptResolution() {
  if (dbgOff.adapt) { setPr(MAX_PR); return; }
  adaptT += 1;
  if (timerExt) {
    pollGpu();
    if (gpuSamples.length >= 12) {
      gpuSamples.sort((x, y) => x - y);
      gpuMs = gpuSamples[gpuSamples.length >> 1];
      gpuSamples = [];
      // over budget: shed the costly effects first, resolution last; with headroom, restore in reverse
      if (gpuMs > 13) { if (!qualityDown()) setPr(pixelRatio * Math.sqrt(11 / gpuMs)); }
      else if (gpuMs < 7) { if (pixelRatio < MAX_PR - 0.01) setPr(pixelRatio * 1.06); else qualityUp(); }
    }
  } else if (adaptT % 90 === 0) {
    if (fpsS < 45) setPr(pixelRatio * 0.9); else if (fpsS > 58) setPr(pixelRatio * 1.05);
  }
}

// ---------------------------------------------------------------- main loop
let acc = 0, last = performance.now();
let lastContacts = 0, stepsThisFrame = 0, physTick = 0;
// physics level of detail: AI cars far from you (and not touching anything) run physics + AI at 100 Hz
// (every third step, 3x the time step) instead of 300 Hz: a third of the cost, invisible at that range
const FAR_LOD = 80, FAR_EVERY = 3;
const farCar = (v) => v.ai && !v.fire && v.car.pos && Math.hypot(v.car.pos.x - car.pos.x, v.car.pos.z - car.pos.z) > FAR_LOD && ![...v.car.inContact.values()].some(Boolean);
function physicsStep() {
  stepsThisFrame++;
  const lodTick = physTick++ % FAR_EVERY === 0;
  for (const v of vehicles) v.far = farCar(v);
  prof.begin('input + ai');
  readInput(DT);
  const police = me.kit ? { lights: me.kit.on, siren: !!ui.siren } : null;
  for (const v of vehicles) if (v.ai && (!v.far || lodTick)) v.ai.update(v.far ? DT * FAR_EVERY : DT, cars, car, police);
  for (const c of cars) autoGearbox(c, DT);
  prof.end(); prof.begin('car collision');
  const ev = collideCars(cars, DT); lastContacts = ev.length;
  onContacts(ev); // resolves impacts (velocity changes) before integrating
  if (OBSTACLES.length) onStaticContacts(collideStatic(cars, OBSTACLES, DT));
  prof.end(); prof.begin('soft body');
  if (!dbgOff.soft) for (const v of vehicles) v.sb?.step(DT); // let crushed metal settle
  prof.end(); prof.begin('vehicle');
  applyGrab();
  for (const v of vehicles) if (!v.far) stepCar(v.car); else if (lodTick) stepCar(v.car, DT * FAR_EVERY);
  prof.end(); prof.begin('panels');
  for (const v of vehicles) stepDoors(v, DT);
  prof.end(); prof.begin('ground crush');
  if (!dbgOff.ground) for (const v of vehicles) { // the ground hurts too
    let worst = null;
    for (const e of groundCrush(v.car)) {
      const sl = Math.hypot(e.vt.x, e.vt.y, e.vt.z);
      if (sl > 0.8) paintQ(v, 'scratch', e.rest, e.nl, e.vt, sl, clamp(0.5 + sl / 12, 0.4, 1.6)); // asphalt eats paint
      if (!e.crush) continue;
      if (e.speed > 3) v.hits.push({ p: e.local, speed: e.speed * 0.8 });
      if (e.speed > 4) v.ai?.onHit(e.speed);
      if (e.speed > 4) paintQ(v, 'chip', e.rest, e.nl, null, 0, (e.speed - 4) / 8);
      if (!worst || e.speed > worst.speed) worst = e;
    }
    if (worst && worst.speed > 5 && v.hitCool <= 0) {
      shakeCam(v, worst.speed / 16);
      crashQueue.push({ p: worst.p, speed: worst.speed * 0.7, glass: worst.speed > 11 ? clamp((worst.speed - 11) / 8, 0, 1) : 0, paint: paintOf(v) });
      v.hitCool = 0.2;
    }
  }
  prof.end();
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fpsS = lerp(fpsS, 1 / Math.max(dt, 1e-4), 0.05);
  for (const v of vehicles) v.kit?.update(now / 1000);
  prof.setOn(ui.debug);
  renderer.info.reset();
  adaptResolution();
  stepsThisFrame = 0;
  prof.begin('frame');
  if (!ui.paused) {
    acc += ui.slowmo ? dt * 0.25 : dt;
    let n = 0;
    // at most ~40 ms of physics per frame: a slow frame (a crash) must not make the next one slower
    // still by queueing ever more steps; past that the sim briefly runs slow instead of stuttering
    while (acc >= DT && n < 12) { physicsStep(); acc -= DT; n++; }
    if (n >= 12) acc = Math.min(acc, DT);
  }
  const simDt = ui.paused ? 0 : dt * (ui.slowmo ? 0.25 : 1);
  prof.begin('damage + sync');
  for (const v of vehicles) { syncVisuals(v); checkDamage(v); v.sb?.upload(); }
  prof.end(); prof.begin('debris');
  updateDebris(simDt, cars);
  updateCones(simDt);
  signals.t += simDt; window.__updateSignals?.();
  updateShards(simDt);
  prof.end(); prof.begin('effects');
  for (const v of vehicles) { effects(v, simDt); updateDoors(v); paintDamage(v, dt); updateLeaks(v, simDt, emit); }
  updateFluids(simDt);
  crashFx();
  prof.end(); prof.begin('particles');
  sky.material.uniforms.uTime.value += dt; // clouds drift (real time, even when paused)
  fire.update(simDt, vehicles, ui.night);
  for (const v of traffic) if (v.fire && v.fire.t > 2 && v.ai.mode === 'drive') { v.ai.mode = 'crashed'; v.ai.wait = 1e9; } // a burning car stops for good
  updateParticles(simDt);
  prof.end();
  updateCamera(dt);
  for (const v of vehicles) updateLod(v);
  updateAiViz();
  drawGrab();
  dbg.visible = ui.debug && dbgOn.lines;
  if (ui.debug && dbgOn.lines) drawDebug();
  sun.position.set(car.pos.x + SUN_DIR.x * 60, car.pos.y + SUN_DIR.y * 60, car.pos.z + SUN_DIR.z * 60);
  sun.target.position.set(car.pos.x, car.pos.y, car.pos.z);
  sky.position.copy(camera.position);
  renderer.shadowMap.needsUpdate = true;
  prof.begin('render (cpu)');
  gpuTimed(() => composer.render());
  flushSkids();
  prof.end();
  prof.begin('hud');
  drawHud(fpsS, dt);
  prof.end();
  prof.end(); // frame
  prof.endFrame(dt);
}
// ---------------------------------------------------------------- switch your vehicle in place (no reload)
// The physics object is reset in place (the HUD, AI, collisions and cameras all hold a reference to it),
// the old body / wheels / lamps come off and the new model goes on where you are, facing the same way.
let swapping = false;
async function swapVehicle(id, paint) {
  if (swapping || !me.inst) return;
  swapping = true;
  const def = id === 'police' ? { model: 'seltos', police: true, paint: POLICE_PAINT } : { model: id, police: false, paint: paint ?? undefined };
  const M = MODELS[def.model], fresh = createCar(M.P);
  if (!templates[def.model]) { loadStatus.textContent = 'Loading car…'; loadStatus.style.opacity = 1; }
  try {
    const tpl = await templateFor(def.model, fresh, (f) => { loadStatus.textContent = `Loading car… ${Math.round(f * 100)}%`; });
    const pos = { x: car.pos.x, z: car.pos.z }, yaw = yawOf(), keep = { autoShift: car.autoShift, tcs: car.tcs, abs: car.abs };
    // off with the old one
    clearDebris(me.inst);
    me.fire = null; me.fireRolled = false;
    me.group.remove(me.inst.body);
    for (const k of ['FL', 'FR', 'RL', 'RR']) scene.remove(me.inst.wheels[k].root);
    me.rig.dispose();
    if (ui.siren) { ui.siren = 0; me.audio.siren('off'); }
    // new physics in the same object
    for (const k of Object.keys(car)) delete car[k];
    Object.assign(car, fresh, keep);
    car.mode = M.mode;
    prepareCollider(car);
    Object.assign(me, { model: def.model, police: def.police, paint: def.paint, kit: null, doors: [], hits: [], scrape: 0, leaks: null, exhaustTip: null, warm: 1 });
    me.lastSkid.fill(null);
    me.audio.setEngine(M.engine);
    buildVisual(me, tpl);
    resetCar(car, v3(pos.x, 0, pos.z), yaw);
    saveSettings({ ...loadSettings(), vehicle: id, paint: def.police ? null : paint ?? null });
    toast(VEHICLES[id].name);
  } catch (err) { console.error(err); toast('Vehicle failed to load: ' + err.message); }
  loadStatus.style.opacity = 0;
  swapping = false;
}

// ---------------------------------------------------------------- pause menu (Esc) + saved settings
const CAMS = ['Chase', 'Far chase', 'Bumper', 'Cockpit', 'Hood'];
function setQuality(q) {
  if (q === 'auto') { dbgOff.adapt = false; quality = 0; }
  else { dbgOff.adapt = true; quality = q; setPr([MAX_PR, 1, 0.8, 0.65][q]); } // each level also renders fewer pixels
  applyQuality();
}
hudC.units = S.units === 'kmh' ? 'kmh' : 'mph';
CarAudio.setVolume(S.volume ?? 0.8);
if (S.quality !== 'auto') setQuality(+S.quality); else applyQuality();
// start a drive: same map (and traffic) -> swap the car and set the time live; otherwise save it all and
// reload straight into the level (the go flag skips the title screen)
async function launch({ map, vehicle, paint = null, night = false, traffic = AI_COUNT }) {
  saveSettings({ ...loadSettings(), map, vehicle, paint, night, traffic });
  if (map === MAP && (MAP !== 'flat' || traffic === AI_COUNT)) {
    const cur = menuApi.current();
    if (cur.vehicle !== vehicle || (cur.paint ?? null) !== (paint ?? null)) await swapVehicle(vehicle, paint);
    if (night !== ui.night) setNight(night);
    menu.close();
  } else { try { sessionStorage.setItem('carsim.go', '1'); } catch { /* fine: title screen then */ } location.reload(); }
}
// live vehicle preview for the menus: the real model in the chosen paint, in its own little studio scene.
// Drawn on demand into the main canvas right after a frame (so it gets the same tone mapping), then
// copied into the menu's canvas.
const preview = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 100), insts: {}, shown: null, n: 0 };
preview.scene.background = new THREE.Color(0x1d1e22);
preview.scene.environment = ENV.day;
{ const l = new THREE.DirectionalLight(0xffffff, 2.2); l.position.set(3, 6, 4); preview.scene.add(l, new THREE.HemisphereLight(0xdfe6f0, 0x202124, 0.5)); }
// one studio car per vehicle, built once (building is the slow part: soft body, materials, police kit)
async function previewCar(id) {
  if (preview.insts[id]) return preview.insts[id];
  const model = id === 'police' ? 'seltos' : id, fresh = createCar(MODELS[model].P);
  const tpl = await templateFor(model, fresh);
  if (preview.insts[id]) return preview.insts[id];
  const inst = instantiateCar(tpl, { paint: id === 'police' ? POLICE_PAINT : undefined });
  if (id === 'police') addPoliceKit(inst, tpl.bounds);
  resetCar(fresh, v3(0, 0, 0), 0);
  ['FL', 'FR', 'RL', 'RR'].forEach((k, i) => { const w = fresh.wheels[i]; inst.wheels[k].root.position.set(w.hard.x, w.hard.y - w.s, w.hard.z); });
  const paints = new Set(); inst.body.traverse((o) => { if (o.isMesh && o.material.userData?.paint) paints.add(o.material); });
  const P = { inst, bounds: tpl.bounds, paints: [...paints], factory: [...paints].map((m) => m.color.clone()) };
  // compile its shaders now (in the studio's lighting), not on the first draw
  preview.scene.add(inst.body); renderer.compile(preview.scene, preview.cam); preview.scene.remove(inst.body);
  if (preview.shown) preview.scene.add(preview.shown.inst.body);
  return (preview.insts[id] = P);
}
async function drawPreview(canvas, id, paint) {
  const n = ++preview.n;
  const P = await previewCar(id);
  if (n !== preview.n) return; // a newer request superseded this one
  if (preview.shown !== P) {
    if (preview.shown) { preview.scene.remove(preview.shown.inst.body); for (const k of ['FL', 'FR', 'RL', 'RR']) preview.scene.remove(preview.shown.inst.wheels[k].root); }
    preview.scene.add(P.inst.body); for (const k of ['FL', 'FR', 'RL', 'RR']) preview.scene.add(P.inst.wheels[k].root);
    preview.shown = P;
    const b = P.bounds, c = b.getCenter(new THREE.Vector3()), len = b.max.z - b.min.z;
    preview.cam.position.set(c.x + len * 1.45, c.y + len * 0.3, c.z + len * 1.75); preview.cam.lookAt(c.x, c.y - 0.1, c.z);
  }
  if (id !== 'police') P.paints.forEach((m, i) => (paint == null ? m.color.copy(P.factory[i]) : m.color.set(paint))); // recolour, no rebuild
  requestAnimationFrame(() => { // after this frame's render: draw the studio into the canvas corner, copy it out
    const W = canvas.width = 960, H = canvas.height = 540;
    const gl = renderer.domElement, pr = renderer.getPixelRatio(), k = Math.min(1, gl.width / W, gl.height / H), w = Math.floor(W * k), h = Math.floor(H * k);
    preview.cam.aspect = W / H; preview.cam.updateProjectionMatrix();
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, w / pr, h / pr); renderer.setScissor(0, 0, w / pr, h / pr); renderer.setScissorTest(true);
    renderer.render(preview.scene, preview.cam);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
    canvas.getContext('2d').drawImage(gl, 0, gl.height - h, w, h, 0, 0, W, H);
  });
}
// build the studio cars in the background once the game is up, one per idle moment, so menus open instantly
setTimeout(() => { const ids = ['police', 'seltos', 'mustang']; const next = () => { const id = ids.shift(); if (id) previewCar(id).then(() => (window.requestIdleCallback || setTimeout)(next)); }; next(); }, 4000);
const specFor = (id) => { const M = MODELS[id === 'police' ? 'seltos' : id]; return vehicleSpecs(createCar(M.P).P, M.mode); };
// pause menu > Fun: things to do to your car (and the others)
function fun(action) {
  const c = car, others = vehicles.filter((t) => t !== me);
  const doorsOpen = (me.doors || []).some((d) => d.propped || !d.latched);
  ({
    fire: () => (me.fire ? fire.extinguish(me) : fire.ignite(me)),
    fireNearest: () => { const o = others.filter((t) => !t.fire).sort((a, b) => a.group.position.distanceTo(me.group.position) - b.group.position.distanceTo(me.group.position))[0]; if (o) fire.ignite(o); },
    launch: () => { c.vel.y += 16; c.angVel = v3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3); },
    flip: () => { c.vel.y += 7; const ax = qRotate(c.q, v3(0, 0, 1)); c.angVel = v3(ax.x * 7, ax.y * 7, ax.z * 7); },
    spin: () => { c.angVel = v3(0, 9, 0); c.vel.y += 1; },
    boost: () => { const f = qRotate(c.q, v3(0, 0, 1)); c.vel = v3(c.vel.x + f.x * 25, c.vel.y + 2, c.vel.z + f.z * 25); },
    doors: () => { for (const d of me.doors || []) { if (doorsOpen) { d.th = d.w = 0; d.latched = true; d.propped = false; } else { d.latched = false; d.propped = true; d.th = d.max * 0.92; d.w = 0; } } },
    blast: () => { for (const o of others) { const dx = o.car.pos.x - c.pos.x, dz = o.car.pos.z - c.pos.z, d = Math.hypot(dx, dz); if (d > 40) continue; const k = 30 * (1 - d / 40); o.car.vel = v3(o.car.vel.x + (dx / (d || 1)) * k, o.car.vel.y + k * 0.6, o.car.vel.z + (dz / (d || 1)) * k); o.car.angVel = v3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4); } },
    rain: () => { others.forEach((o, i) => { resetVehicle(o, v3(c.pos.x + (Math.random() - 0.5) * 12, 0, c.pos.z + (Math.random() - 0.5) * 12), Math.random() * 6.28); o.car.pos.y += 12 + i * 4; if (o.ai) { o.ai.mode = 'crashed'; o.ai.wait = 8; } }); },
  })[action]?.();
}
const menuApi = {
  boot: { map: MAP, traffic: AI_COUNT },
  current: () => ({ vehicle: me.police ? 'police' : me.model, paint: me.police ? null : me.paint ?? null, night: ui.night }),
  swapVehicle, launch, specs: specFor, drawPreview, fun,
  funState: () => ({ onFire: !!me.fire, doorsOpen: (me.doors || []).some((d) => d.propped || !d.latched) }), attract: (on) => { ui.attract = on; },
  paused: () => ui.paused, setPaused: (p) => { ui.paused = p; }, duck: (d) => CarAudio.setDuck(d),
  night: () => ui.night, setNight: (n) => { if (n !== ui.night) setNight(n); },
  respawnTraffic, recover: recoverMe,
  setQuality, setVolume: (v) => CarAudio.setVolume(v), muted: () => ui.muted, setMuted: (m) => { ui.muted = m; me.audio.setMuted(m); },
  assists: () => ({ auto: car.autoShift, tcs: car.tcs, abs: car.abs, mode: car.mode, modes: Object.keys(DRIVE_MODES) }),
  setAssist: (k, v) => { if (k === 'auto') car.autoShift = v; else if (k === 'tcs') car.tcs = v; else if (k === 'abs') car.abs = v; else if (k === 'mode') car.mode = v; },
  units: () => hudC.units, setUnits: (u) => { hudC.units = u; },
  cams: () => CAMS, cam: () => ui.cam, setCam: (c) => { ui.cam = c; },
};
const menu = createMenu(menuApi);
if (S.night) setNight(true);
{ let go = false; try { go = sessionStorage.getItem('carsim.go') === '1'; sessionStorage.removeItem('carsim.go'); } catch { /* no session storage */ }
  if (!go) menu.title(); }
document.getElementById('help').innerHTML = '<kbd>Esc</kbd> Menu';
requestAnimationFrame(frame);
window.__orbit = orbit; window.__car = car; window.__vehicles = vehicles; window.__renderer = renderer; window.__scene = scene; window.__ui = ui; window.__setNight = setNight;
