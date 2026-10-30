// Loads the Kia Seltos glTF once as a template, then builds any number of car instances from it.
// Each instance: one rigid body (merged by material, own copy of the vertices so it can be dented),
// four wheels, a depth pre-pass that is also the only shadow caster, and the lamps split into
// controllable groups. The model ships "lit" lamp overlays (Lights_On materials whose emissive
// texture is the mask of the glowing area) hidden by a 1e-10 scale; we restore and drive them.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.21.0/meshopt_simplifier.module.js';
import { DamageSkin } from './damageSkin.js';
import { SoftBody, bindGeometry, latticeMaterial, CORE } from './softbody.js';

// GLTFLoader sanitises node names (spaces -> '_', ':' dropped), so match either form
const WHEEL_RE = /tire[ _](FL|FR|RL|RR)/;
const CALIPER_RE = /disc[ _]brake/i; // steers with the wheel but does not spin
// hidden or barely visible parts (door seals, seatbelt hardware, pedals, ducts): ~40k triangles
const DROP_RE = /door[ _]rubber[ _]frame|door[ _]gum[ _]frame|GROMMET|anchor|seatbelt|belthook|pedal|DUCT|INSULATOR/i;
export const LIGHT_GROUPS = ['head', 'drl', 'tail', 'brake', 'turn', 'reverse'];
const LAMP_COL = { head: 0xfff6e8, drl: 0xffffff, tail: 0xff1a10, brake: 0xff1408, turn: 0xffa020, reverse: 0xffffff };
// parts that can tear off (first match walking from the mesh up its parents)
const PARTS = [
  ['hood', /bonet/i], ['doorFL', /door_FL_\d+$/], ['doorFR', /door_FR_\d+$/],
  ['doorRL', /door_RL_\d+$/], ['doorRR', /door_RR_\d+$/],
  ['bumperF', /FR[ _]BUMPER|FR[ _]BPR|MOLDING[ _]ASSY-FR|GRILLE|PIECE-RAD|FOG[ _]LAMP/],
  ['bumperR', /RR[ _]BUMPER|COVER-RR|MOULDING-RR|SKID[ _]PLATE-RR/],
  ['tailgate', /TAILGATE/], ['wiper', /wiper/i], ['plateF', /L[ _/]PLATE/],
];

// Per-model facts. The game's car frame: +z forward, +x left, y up, origin at the centre of gravity.
//  toCar: model -> car orientation/scale; groundY: ground height after toCar; frontAxleZ: front axle z
//  after toCar. The rest says how to find wheels, parts, lamps and paint in that particular file.
export const PROFILES = {
  seltos: {
    url: 'models/seltos.glb', toCar: new THREE.Matrix4().makeRotationY(Math.PI / 2), groundY: 0.02, frontAxleZ: 1.27, mirrors: true,
    paint: /carpaint/i,
    drop: DROP_RE,
    wheelOf: (names) => names.match(WHEEL_RE)?.[1] || null,
    caliper: CALIPER_RE,
    partOf: (n) => { for (const [id, re] of PARTS) if (re.test(n)) return id; return null; },
    tagOf: (n) => (/steering[ _]?wheel/i.test(n) ? 'steer' : /HANDLE[ _]METALLIC|doorbutton/.test(n) ? 'handle' : null),
    lightOf: (names, mat) => {
      if (/LENS[ _]CLEAR/.test(names)) return 'reverse';
      if (!/Lights_On/.test(mat)) return null;
      if (/Turn/i.test(names)) return 'turn';
      if (/LOW&HIGH/.test(names)) return 'head';
      if (/HMSL/.test(names)) return 'brake';
      return 'drl|tail'; // front half drl, rear half tail
    },
  },
  // Ford Mustang GT500 (Sketchfab "with pro rig"): forward +z, left +x, 11% oversize. Doors, bonnet and
  // the steering wheel are skinned to bones - baked to their rest pose and assigned by bone.
  mustang: {
    url: 'models/src/mustang_raw.glb', toCar: new THREE.Matrix4().makeScale(0.9, 0.9, 0.9), groundY: -0.018, frontAxleZ: 3.04 * 0.9, mirrors: false,
    paint: /^primary$/,
    drop: /Cone/,
    skinRoot: /^GLTF_created_0$/,
    wheelOf: (names) => { const m = names.match(/Wheel\.?(Ft|Bk)\.?(L|R)/); return m ? (m[1] === 'Ft' ? 'F' : 'R') + m[2] : null; },
    caliper: /$^/,
    partOf: (n, mat, bone) => (/right[ _]door/i.test(bone) ? 'doorFL' : /left[ _]door/i.test(bone) ? 'doorFR' : /hood/i.test(bone) ? 'hood' // (the rig names doors from the viewer's side)
      : /bump_front/.test(mat) ? 'bumperF' : /bump_rear/.test(mat) ? 'bumperR' : null),
    tagOf: (n, mat, bone) => (/stering/i.test(bone) ? 'steer' : null),
    lightOf: (names, mat) => ({ right_front_light: 'head|tail', foglight_l: 'drl', breaklight_l: 'brake', indicator_lr: 'turn', indicator_rr: 'turn',
      revlight_r: 'reverse', 'Material.004': 'tail' })[mat] || null,
  },
};
// a skinned mesh as static geometry in world space; returns [geometry, dominant bone name]. This rig
// is inconsistent: some pieces are only right with the bones applied, others only in their bind pose
// (their bones were moved after binding) - so bake both and keep the one that lands on the car.
function bakeSkinned(o, carBox, fix) {
  const g = o.geometry, pos = g.getAttribute('position'), v = new THREE.Vector3();
  o.skeleton.update();
  // candidates, in order: posed by its bones; posed but missing the rig's Z-up->Y-up turn (fix); bind pose
  const cands = [{ a: new Float32Array(pos.count * 3), b: new THREE.Box3(), f: (i) => { v.fromBufferAttribute(pos, i); o.applyBoneTransform(i, v); return v.applyMatrix4(o.matrixWorld); } }];
  if (fix) cands.push({ a: new Float32Array(pos.count * 3), b: new THREE.Box3(), f: (i) => { v.fromBufferAttribute(pos, i); o.applyBoneTransform(i, v); return v.applyMatrix4(o.matrixWorld).applyMatrix4(fix); } });
  cands.push({ a: new Float32Array(pos.count * 3), b: new THREE.Box3(), f: (i) => v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld) });
  for (const c of cands) for (let i = 0; i < pos.count; i++) { const p = c.f(i); c.a.set([p.x, p.y, p.z], i * 3); c.b.expandByPoint(p); }
  const use = (cands.find((c) => carBox.containsPoint(c.b.getCenter(new THREE.Vector3()))) || cands[0]).a;
  const ng = g.clone(); ng.setAttribute('position', new THREE.BufferAttribute(use, 3)); ng.deleteAttribute('normal'); ng.computeVertexNormals();
  const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight'), tally = new Map();
  if (si && sw) for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) { const b2 = si.getComponent(i, k), w = sw.getComponent(i, k); if (w > 0) tally.set(b2, (tally.get(b2) || 0) + w); }
  let best = -1, bw = 0; for (const [b2, w] of tally) if (w > bw) { bw = w; best = b2; }
  return [ng, o.skeleton.bones[best]?.name || ''];
}


// Decimate a mesh (car frame, metres): collapse edges while the surface moves < 5 mm, keeping open
// borders (panel edges, UV seams) locked so pieces still meet. The model is ~1M triangles; most of
// that is invisible density. Then drop the vertices nothing uses any more.
function simplify(geo) {
  const idx = geo.index.array;
  if (idx.length < 900) return geo;
  const pos = geo.getAttribute('position').array;
  const [ni] = MeshoptSimplifier.simplify(idx, pos, 3, Math.floor(idx.length * 0.15 / 3) * 3, 0.005, ['LockBorder', 'ErrorAbsolute']);
  if (ni.length < 3 || ni.length >= idx.length * 0.95) return geo;
  return compact(geo, ni);
}
export function compact(geo, indices = geo.index.array) {
  const remap = new Int32Array(geo.getAttribute('position').count).fill(-1);
  let n = 0;
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) { const v = indices[i]; if (remap[v] < 0) remap[v] = n++; out[i] = remap[v]; }
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    const s = a.itemSize, src = a.array, dst = new src.constructor(n * s);
    for (let v = 0; v < remap.length; v++) { const r = remap[v]; if (r >= 0) for (let k = 0; k < s; k++) dst[r * s + k] = src[v * s + k]; }
    g.setAttribute(name, new THREE.BufferAttribute(dst, s, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(out, 1));
  return g;
}

function toFloat(geo) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'uv1']) {
    const a = geo.getAttribute(name);
    if (!a) continue;
    const n = a.count, s = a.itemSize, arr = new Float32Array(n * s);
    for (let i = 0; i < n; i++) {
      arr[i * s] = a.getX(i);
      if (s > 1) arr[i * s + 1] = a.getY(i);
      if (s > 2) arr[i * s + 2] = a.getZ(i);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  if (geo.index) out.setIndex(new THREE.BufferAttribute(Uint32Array.from(geo.index.array), 1));
  else {
    const idx = new Uint32Array(out.getAttribute('position').count);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  if (!out.getAttribute('uv')) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.getAttribute('position').count * 2), 2));
  if (!out.getAttribute('uv1')) out.setAttribute('uv1', out.getAttribute('uv').clone()); // aoMaps sample channel 1
  return out;
}

// keep only the triangles whose centroid is on one side (x > 0 = car's left)
const _v = new THREE.Vector3();
// bounds of the vertices an indexed geometry actually draws (split pieces share whole vertex buffers)
function usedBox(geo) {
  const pos = geo.getAttribute('position').array, bb = new THREE.Box3();
  if (!geo.index) { geo.computeBoundingBox(); return geo.boundingBox; }
  for (const i of geo.index.array) bb.expandByPoint(_v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  return bb;
}
// split an indexed geometry by a per-triangle test (all three corners must pass); shares the attributes
function splitBy(geo, test) {
  const pos = geo.getAttribute('position').array, idx = geo.index ? geo.index.array : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
  const a = [], b = [];
  for (let t = 0; t < idx.length; t += 3) {
    let all = true;
    for (let k = 0; k < 3 && all; k++) { const i = idx[t + k] * 3; all = test(pos[i], pos[i + 1], pos[i + 2]); }
    (all ? a : b).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!a.length) return [null, geo];
  const mk = (list) => {
    const g = new THREE.BufferGeometry();
    for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.getAttribute(k));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(list), 1));
    // bounds of the triangles actually used (the vertex buffer is shared with the other half)
    const bb = new THREE.Box3();
    for (const i of list) bb.expandByPoint(_v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    g.boundingBox = bb;
    return g;
  };
  return [mk(a), b.length ? mk(b) : null];
}
function splitSide(geo, left) {
  const pos = geo.getAttribute('position').array, idx = geo.index.array, keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const cx = pos[idx[t] * 3] + pos[idx[t + 1] * 3] + pos[idx[t + 2] * 3];
    if ((cx > 0) === left) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!keep.length) return null;
  const g = new THREE.BufferGeometry();
  for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.getAttribute(k));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(keep), 1));
  return g;
}

// Physical shaders are expensive; keep them only where clearcoat/transmission is actually used.
function simplifyMaterial(m, paintRe = /carpaint/i) {
  if (paintRe.test(m.name)) {
    const p = new THREE.MeshPhysicalMaterial({
      name: m.name, color: m.color.clone(), map: m.map, roughness: 0.42, metalness: 0.15,
      clearcoat: 1, clearcoatRoughness: 0.05, aoMap: m.aoMap, aoMapIntensity: 1,
    });
    p.userData.paint = true;
    return p;
  }
  if (!m.isMeshPhysicalMaterial || m.clearcoat > 0 || m.transmission > 0) return m;
  const s = new THREE.MeshStandardMaterial();
  for (const k of ['name', 'color', 'map', 'normalMap', 'normalScale', 'roughness', 'metalness', 'roughnessMap', 'metalnessMap',
    'emissive', 'emissiveMap', 'emissiveIntensity', 'aoMap', 'aoMapIntensity', 'transparent', 'opacity', 'side', 'alphaTest',
    'depthWrite', 'alphaMap', 'vertexColors']) {
    if (m[k] === undefined) continue;
    s[k] = m[k] && m[k].isColor ? m[k].clone() : m[k] && m[k].isVector2 ? m[k].clone() : m[k];
  }
  return s;
}

function mergeEntries(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const k = e.mat.uuid + '|' + (e.light || '') + '|' + (e.overlay ? 1 : 0) + '|' + (e.part || '') + '|' + (e.tag || '');
    if (!byKey.has(k)) byKey.set(k, { mat: e.mat, light: e.light, overlay: e.overlay, part: e.part, tag: e.tag, geos: [] });
    byKey.get(k).geos.push(e.geo);
  }
  return [...byKey.values()].map((b) => ({ ...b, geo: b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false) }));
}

const isSolid = (p) => !p.mat.transparent && !(p.mat.alphaTest > 0) && !p.mat.alphaMap && !p.overlay && !p.part && !p.tag;
function prepassGeometry(parts) {
  const solid = parts.filter(isSolid);
  if (!solid.length) return null;
  return mergeGeometries(solid.map((p) => {
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'aCell', 'aFrac']) if (p.geo.getAttribute(k)) g.setAttribute(k, p.geo.getAttribute(k));
    g.setIndex(p.geo.index);
    return g;
  }), false);
}

export async function loadCarTemplate(profile, { cgHeight, a, onProgress }) {
  const PR = typeof profile === 'string' ? PROFILES[profile] : profile, url = PR.url, cgZ = PR.frontAxleZ - a;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  await MeshoptSimplifier.ready;
  const root = gltf.scene;
  // un-hide the "lights on" overlays (the exporter parks them at scale 1e-10)
  root.traverse((n) => { if (n.scale.x < 1e-6 && n.scale.y < 1e-6) { n.scale.set(1, 1, 1); n.userData.overlay = true; } });
  root.updateMatrixWorld(true);

  const toCar = PR.toCar;
  const cg = new THREE.Vector3(0, PR.groundY + cgHeight, cgZ);
  const matCache = new Map();
  // materials that only differ by name/uuid are merged (fewer meshes after merging = fewer draw calls)
  const texKey = (t) => (t ? t.source?.uuid || t.uuid : '');
  const sigOf = (m) => [m.type, m.color?.getHexString(), texKey(m.map), texKey(m.normalMap), texKey(m.roughnessMap), texKey(m.metalnessMap), texKey(m.aoMap),
    texKey(m.emissiveMap), texKey(m.alphaMap), m.roughness?.toFixed(3), m.metalness?.toFixed(3), m.transparent, m.opacity?.toFixed(3), m.emissive?.getHexString(),
    m.side, m.alphaTest, m.clearcoat, m.transmission, PR.paint.test(m.name) ? 'paint' : '', m.name.slice(0, 40), /Lights_On/.test(m.name) ? 'lit' : ''].join('|');
  const getMat = (m) => { const k = sigOf(m); if (!matCache.has(k)) matCache.set(k, simplifyMaterial(m, PR.paint)); return matCache.get(k); };

  // the rig's armature turn (Z-up -> Y-up) and height, which some skinned pieces' poses lack
  let skinFix = null;
  root.traverse((n) => { if (!skinFix && PR.skinRoot?.test(n.name)) { const p = new THREE.Vector3().setFromMatrixPosition(n.matrixWorld); skinFix = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, p.y, 0); } });
  const carBox = new THREE.Box3(); // the car's extent from its plain meshes (to sanity-check baked skinned ones)
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && !PR.drop.test(o.name) && !PR.drop.test(o.parent?.name || '')) carBox.expandByObject(o); });
  const body = [], wheels = { FL: [], FR: [], RL: [], RR: [] }, calipers = { FL: [], FR: [], RL: [], RR: [] };
  root.traverse((o) => {
    if (!o.isMesh) return;
    let wheel = null, caliper = false, drop = false, overlay = false, names = '', part = null, tag = null;
    let baked = null, bone = '';
    if (o.isSkinnedMesh) [baked, bone] = bakeSkinned(o, carBox, skinFix);
    const matName = o.material.name || '';
    for (let p = o; p; p = p.parent) {
      const n = p.name || '';
      names += n + '/';
      if (!part) part = PR.partOf(n, matName, bone);
      if (PR.drop.test(n)) drop = true;
      if (!tag) tag = PR.tagOf(n, matName, bone);
      if (!wheel) wheel = PR.wheelOf(n);
      if (PR.caliper.test(n)) caliper = true;
      if (p.userData.overlay) overlay = true;
    }
    if (drop) return;
    let geo = toFloat(baked || o.geometry);
    geo.applyMatrix4(baked ? toCar : new THREE.Matrix4().multiplyMatrices(toCar, o.matrixWorld));
    geo = simplify(geo);
    geo.computeBoundingBox();
    const mat = getMat(o.material);
    if (wheel) { (caliper ? calipers : wheels)[wheel].push({ geo, mat }); return; }
    geo.translate(-cg.x, -cg.y, -cg.z);
    // side mirrors by where they are (their node names are unreliable)
    geo.computeBoundingBox();
    const bc = geo.boundingBox.getCenter(new THREE.Vector3()), bs = geo.boundingBox.getSize(new THREE.Vector3());
    if (part && bs.z > 1.6) part = null; // long pieces (sills, underbody covers) belong to the shell, whatever they're called
    if (PR.mirrors && Math.abs(bc.x) > 0.82 && bc.y > 0.3 && bc.z > 0.0 && bc.z < 1.0 && bs.length() < 0.6) part = bc.x > 0 ? 'mirrorL' : 'mirrorR';

    // lamp classification
    const light = PR.lightOf(names, matName);
    if (!light) { body.push({ geo, mat, part, tag }); return; }
    // 'front|rear' lamp materials cover both ends: split per triangle (front of the CG / behind it)
    const ends = light.includes('|') ? [[light.split('|')[0], true], [light.split('|')[1], false]] : [[light, null]];
    for (const [grp, front] of ends) {
      const eg = front === null ? geo : splitBy(geo, (x, y, z) => (z > 0) === front)[0];
      if (!eg) continue;
      for (const side of ['L', 'R']) {
        const g = splitSide(eg, side === 'L');
        if (g) body.push({ geo: g, mat, light: grp + side, overlay, part });
      }
    }
  });

  // the steering wheel's rim, spokes and buttons have generic names: take every small piece that sits
  // inside the wheel's disc (around the named hub, across the column axis)
  const hub = new THREE.Box3();
  for (const e of body) if (e.tag === 'steer') hub.union(e.geo.boundingBox);
  if (!hub.isEmpty()) {
    const c = hub.getCenter(new THREE.Vector3()), ax = new THREE.Vector3(0, 0.45, -0.89).normalize(), q = new THREE.Vector3();
    const inDisc = (b) => [0, 1, 2, 3, 4, 5, 6, 7].every((i) => {
      q.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(c);
      const along = q.dot(ax);
      return Math.abs(along) < 0.09 && q.addScaledVector(ax, -along).length() < 0.23;
    });
    for (const e of body) if (!e.tag && !e.part && !e.light && inDisc(e.geo.boundingBox)) e.tag = 'steer';
  }
  // the tailgate is one named skin; its glass, lamps, spoiler, wiper and trim are loose pieces that sit on it
  for (const e of body) if (!e.geo.boundingBox) e.geo.computeBoundingBox();
  // the tailgate: its named skin is only the top trim, so take every piece that lives in the back
  // opening (behind the rear seats, above the bumper, inside the D-pillars) and reaches the back face
  const all = new THREE.Box3();
  for (const e of body) all.union(e.geo.boundingBox);
  const top = new THREE.Box3();
  for (const e of body) if (e.part === 'tailgate') top.union(e.geo.boundingBox);
  if (!top.isEmpty()) {
    // the gate is the skin of the car's back face (plus its inner trim, a hand's depth behind it), above
    // the bumper and between the tail-lamp ends. Map that back face, then cut every triangle that lies on it.
    const zone = new THREE.Box3(new THREE.Vector3(-0.76, 0.03, all.min.z - 0.05), new THREE.Vector3(0.76, top.max.y + 0.06, top.min.z - 0.02));
    const B = 0.05, bin = (x, y) => Math.round(x / B) * 4096 + Math.round(y / B), env = new Map();
    for (const e of body) {
      const p = e.geo.getAttribute('position').array;
      for (let i = 0; i < p.length; i += 3) { const k = bin(p[i], p[i + 1]); if (!(env.get(k) <= p[i + 2])) env.set(k, p[i + 2]); }
    }
    // down to the bumper's top edge; pieces labelled bumper only count high up (the window garnish)
    const onGate = (x, y, z) => x > zone.min.x && x < zone.max.x && y > zone.min.y && y < zone.max.y && z < zone.max.z && z < (env.get(bin(x, y)) ?? -9) + 0.2;
    const extra = [];
    for (const e of body) {
      if (e.tag || (e.part && e.part !== 'bumperR') || !zone.intersectsBox(e.geo.boundingBox)) continue;
      const minY = e.part === 'bumperR' ? 0.55 : -9;
      const [inG, outG] = splitBy(e.geo, (x, y, z) => y > minY && onGate(x, y, z));
      if (!inG) continue;
      if (!outG) { e.part = 'tailgate'; continue; }
      e.geo = outG;
      extra.push({ ...e, geo: inG, part: 'tailgate' });
    }
    body.push(...extra);
  }
  const bodyParts = mergeEntries(body);
  // lattice bounds = body extents (car frame); bind every body vertex to it once, shared by all cars
  const bounds = new THREE.Box3();
  for (const p of bodyParts) { p.geo.boundingBox = usedBox(p.geo); bounds.union(p.geo.boundingBox); }
  bounds.expandByScalar(0.02);
  const refSB = new SoftBody(bounds.min, bounds.max, CORE);
  for (const p of bodyParts) bindGeometry(THREE, p.geo, refSB);
  const prepass = prepassGeometry(bodyParts);
  // part extents (for crush checks and tearing off)
  const partInfo = {};
  for (const p of bodyParts) if (p.part) (partInfo[p.part] ||= new THREE.Box3()).union(p.geo.boundingBox);

  // Lamp spots for flares/beams (car frame, CG origin): every lamp group side is clustered into
  // front / mirror / rear pieces, measured from the triangles it actually uses (the split geometries
  // share their vertex buffers, so a plain bounding box would span both sides).
  const acc = {};
  for (const p of bodyParts) {
    if (!p.light) continue;
    const pos = p.geo.getAttribute('position').array, idx = p.geo.index.array;
    for (let t = 0; t < idx.length; t++) {
      const i = idx[t] * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const zone = z > 0.9 ? 'f' : z < -0.9 ? 'r' : 'm';
      const a = (acc[p.light + zone] ||= { key: p.light, n: 0, s: new THREE.Vector3(), box: new THREE.Box3() });
      a.n++; a.s.x += x; a.s.y += y; a.s.z += z; a.box.expandByPoint(new THREE.Vector3(x, y, z));
    }
  }
  const spots = {};
  for (const a of Object.values(acc)) {
    if (a.n < 30) continue;
    const pos = a.s.multiplyScalar(1 / a.n);
    (spots[a.key] ||= []).push({ pos, size: a.box.getSize(new THREE.Vector3()).length(), front: pos.z > 0.9 || (pos.z > -0.9 && pos.z > 0) });
  }

  const wheelParts = {};
  const wheelInfo = {};
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const box = new THREE.Box3();
    for (const e of wheels[k]) { e.geo.computeBoundingBox(); box.union(e.geo.boundingBox); }
    const c = box.getCenter(new THREE.Vector3());
    wheelInfo[k] = { center: c, radius: (box.max.y - box.min.y) / 2 };
    for (const e of [...wheels[k], ...calipers[k]]) e.geo.translate(-c.x, -c.y, -c.z);
    const spin = mergeEntries(wheels[k]), cal = mergeEntries(calipers[k]);
    wheelParts[k] = { spin, cal, prepass: prepassGeometry(spin) };
  }
  const fl = wheelInfo.FL, rl = wheelInfo.RL;
  const meta = { wheelR: fl.radius, wheelbase: fl.center.z - rl.center.z, tris: bodyParts.reduce((a, p) => a + p.geo.index.count / 3, 0) };
  return { bodyParts, prepass, spots, wheelParts, meta, bounds, partInfo };
}

function prepassMesh(geo, castShadow, sb) {
  // depth is pushed back a hair: the shaded pass runs the lattice in a different shader, and once the
  // body is dented the tiny float differences made it fail the depth test (holes you could see through)
  const pm = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
  const m = new THREE.Mesh(geo, sb ? latticeMaterial(pm, sb) : pm);
  m.renderOrder = -10; // drawn first so hidden fragments skip the expensive shading
  m.castShadow = castShadow; // and it is the main shadow caster: one draw instead of one per material
  if (sb) m.customDepthMaterial = latticeMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), sb);
  m.userData.prepass = true;
  return m;
}

export function instantiateCar(tpl, { paint } = {}) {
  const sb = new SoftBody(tpl.bounds.min, tpl.bounds.max, CORE);
  sb.initGPU(THREE);
  const skin = new DamageSkin(tpl.bounds); // scratches / chips, sampled by every latticed material
  Object.assign(sb.uniforms, skin.uniforms);
  const body = new THREE.Group();
  const lights = {}; // e.g. lights.brakeL = { mats: [...], overlays: [...] }
  const parts = {}; // e.g. parts.hood = { meshes: [...], box }
  const tagged = {}; // steer: steering wheel meshes, handle: door handle meshes
  const mats = new Map(); // template material -> this car's latticed copy
  const carMat = (m) => {
    if (!mats.has(m)) {
      const c = m.clone();
      if (c.userData.paint) { if (paint !== undefined) c.color.set(paint); c.defines = { ...c.defines, DMG: '', DMG_PAINT: '' }; }
      mats.set(m, latticeMaterial(c, sb));
    }
    return mats.get(m);
  };
  // exterior plastics (bumpers, mirrors, plate trim) scuff white; they get their own copies so the
  // same plastic used inside the cabin stays clean
  const EXT = /^(bumperF|bumperR|mirrorL|mirrorR|plateF)$/, plastics = new Map();
  const extMat = (m) => {
    if (m.userData.paint || m.transparent || !(m.isMeshStandardMaterial)) return m;
    if (!plastics.has(m)) { const c = m.clone(); c.defines = { ...c.defines, DMG: '' }; plastics.set(m, latticeMaterial(c, sb)); }
    return plastics.get(m);
  };
  for (const p of tpl.bodyParts) {
    let mat = carMat(p.mat);
    if (!p.light && EXT.test(p.part || '')) mat = extMat(mat);
    if (p.light) {
      mat = latticeMaterial(mat.clone(), sb); // each lamp group (per car, per side) switches independently
      if (p.light.startsWith('reverse')) { mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = null; }
      else if (!mat.emissiveMap && mat.emissive && mat.emissive.getHex() === 0) mat.emissive = new THREE.Color(LAMP_COL[p.light.slice(0, -1)]); // lamps modelled without a glow colour
      mat.emissiveIntensity = 0;
    }
    if (!p.light && (p.part === 'hood' || p.part === 'tailgate')) { const d = mat.defines; mat = latticeMaterial(mat.clone(), sb); mat.defines = { ...d }; // clone() drops custom defines
      mat.emissive = new THREE.Color(0xff7a00); mat.emissiveIntensity = 0; } // glows on hover
    if (p.tag === 'handle') { mat = latticeMaterial(mat.clone(), sb); mat.emissive = new THREE.Color(0xff7a00); mat.emissiveIntensity = 0; } // glows on hover
    const mesh = new THREE.Mesh(p.geo, mat);
    mesh.receiveShadow = !mat.transparent;
    // detachable parts cast their own shadow (they are not in the shared pre-pass caster)
    if (p.part && !mat.transparent) { mesh.castShadow = true; mesh.customDepthMaterial = latticeMaterial(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), sb); }
    body.add(mesh);
    if (p.light) {
      const L = (lights[p.light] ||= { mats: [], overlays: [] });
      L.mats.push(mat);
      if (p.overlay) { L.overlays.push(mesh); mesh.visible = false; }
    }
    if (p.tag) (tagged[p.tag] ||= []).push(mesh);
    if (p.part) {
      const P = (parts[p.part] ||= { id: p.part, meshes: [], box: tpl.partInfo[p.part], attached: true });
      P.meshes.push(mesh);
    }
  }
  if (tpl.prepass) body.add(prepassMesh(tpl.prepass, true, sb));

  const wheels = {};
  for (const [k, w] of Object.entries(tpl.wheelParts)) {
    const root = new THREE.Group(); // at the wheel centre; steers
    const spin = new THREE.Group(); // rolls about X
    for (const p of w.spin) { const m = new THREE.Mesh(p.geo, p.mat); m.receiveShadow = !p.mat.transparent; spin.add(m); }
    if (w.prepass) spin.add(prepassMesh(w.prepass, true));
    root.add(spin);
    for (const p of w.cal) root.add(new THREE.Mesh(p.geo, p.mat));
    wheels[k] = { root, spin };
  }
  return { body, wheels, lights, parts, tagged, sb, skin, spots: tpl.spots, lowpoly: !!tpl.meta?.lowpoly };
}
