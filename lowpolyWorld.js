// Low-poly scenery around the test grounds: pine and round trees, rocks, distant mountains and
// clouds. All flat shaded, all instanced (a handful of draw calls). Nothing here is in the driving
// areas, so none of it needs collision.
import * as THREE from 'three';

const rnd = (a, b) => a + Math.random() * (b - a);
function jitter(geo, amt) { // irregular low-poly shapes: nudge every (shared) corner
  geo = geo.index ? geo : geo; const p = geo.attributes.position, seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, [rnd(-amt, amt), rnd(-amt, amt), rnd(-amt, amt)]);
    const d = seen.get(k);
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
const flat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9, ...o });

// keep scenery out of everything you can drive on
const KEEP_OUT = [[-140, -320, 220, 320], [-80, -340, 80, -200]]; // [x0, z0, x1, z1]
const clear = (x, z) => !KEEP_OUT.some(([x0, z0, x1, z1]) => x > x0 - 12 && x < x1 + 12 && z > z0 - 12 && z < z1 + 12);
function spot(rMin, rMax) {
  for (let t = 0; t < 50; t++) { const a = Math.random() * 6.283, r = rnd(rMin, rMax), x = Math.cos(a) * r, z = Math.sin(a) * r; if (clear(x, z)) return [x, z]; }
  return null;
}

export function buildWorld(scene, heightAt) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const place = (mesh, i, x, y, z, sc, yaw = Math.random() * 6.28, sy = sc) => { q.setFromAxisAngle(up, yaw); mesh.setMatrixAt(i, m4.compose(p.set(x, y, z), q, s.set(sc, sy, sc))); };

  // ---- trees: pines (stacked cones) and round broadleaf (lumpy icosahedron), in loose clusters
  const N = 900;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 2.2, 5).translate(0, 1.1, 0), flat(0x6b4a33), N * 2);
  const pineGeo = (() => { // three stacked cones, merged
    const parts = [[2.2, 3.2, 2.0], [1.7, 2.8, 3.6], [1.1, 2.3, 5.0]].map(([r, hgt, y]) => jitter(new THREE.ConeGeometry(r, hgt, 6).translate(0, y, 0).toNonIndexed(), 0.12));
    const pos = parts.flatMap((g) => [...g.attributes.position.array]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  })();
  const pine = new THREE.InstancedMesh(pineGeo, flat(0xffffff), N);
  const roundGeo = jitter(new THREE.IcosahedronGeometry(2.3, 0).translate(0, 3.6, 0).toNonIndexed(), 0.35);
  const round = new THREE.InstancedMesh(roundGeo, flat(0xffffff), N);
  let nt = 0, np = 0, nr = 0;
  for (let c = 0; c < 70; c++) {
    const at = spot(260, 900);
    if (!at) continue;
    const [cx, cz] = at, n = 6 + (Math.random() * 14 | 0), isPine = Math.random() < 0.6;
    for (let k = 0; k < n; k++) {
      const x = cx + rnd(-28, 28), z = cz + rnd(-28, 28);
      if (!clear(x, z)) continue;
      const sc = rnd(0.8, 1.6);
      if (isPine && np < N) { place(pine, np, x, 0, z, sc); pine.setColorAt(np++, col.setHSL(rnd(0.3, 0.38), 0.45, rnd(0.2, 0.3))); }
      else if (nr < N) { place(round, nr, x, 0, z, sc); round.setColorAt(nr++, col.setHSL(rnd(0.2, 0.3), 0.5, rnd(0.3, 0.4))); }
      else continue;
      if (nt < N * 2) place(trunk, nt++, x, 0, z, sc);
    }
  }
  pine.count = np; round.count = nr; trunk.count = nt;

  // ---- rocks
  const rock = new THREE.InstancedMesh(jitter(new THREE.DodecahedronGeometry(1, 0).toNonIndexed(), 0.22), flat(0xffffff), 260);
  let nk = 0;
  for (let i = 0; i < 260; i++) {
    const at = spot(230, 950); if (!at) continue;
    const sc = rnd(0.5, 3.2);
    place(rock, nk, at[0], sc * 0.35, at[1], sc, Math.random() * 6.28, sc * rnd(0.5, 0.9));
    rock.setColorAt(nk++, col.setHSL(0.08, rnd(0.03, 0.1), rnd(0.38, 0.55)));
  }
  rock.count = nk;

  // ---- mountains: a ring of big jagged peaks, colour mixed toward the haze with distance (no fog)
  const mtnGeo = jitter(new THREE.ConeGeometry(1, 1, 7, 3).translate(0, 0.5, 0).toNonIndexed(), 0.07);
  const mtn = new THREE.InstancedMesh(mtnGeo, flat(0xffffff, { fog: false }), 60);
  const haze = new THREE.Color(0xaeb8c2);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 6.283 + rnd(-0.04, 0.04), r = rnd(1250, 1650), w = rnd(160, 380);
    q.setFromAxisAngle(up, Math.random() * 6.28);
    mtn.setMatrixAt(i, m4.compose(p.set(Math.cos(a) * r, -20, Math.sin(a) * r), q, s.set(w, rnd(180, 420), w)));
    mtn.setColorAt(i, col.setHSL(rnd(0.55, 0.62), 0.12, rnd(0.34, 0.42)).lerp(haze, 0.55 * (r - 1100) / 600 + 0.2));
  }

  // ---- clouds: clumps of flat white blobs
  const cloudGeo = jitter(new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), 0.15);
  const cloud = new THREE.InstancedMesh(cloudGeo, flat(0xffffff, { fog: false, roughness: 1, emissive: new THREE.Color(0x8890a0), emissiveIntensity: 0.25 }), 220);
  let nc = 0;
  for (let c = 0; c < 26; c++) {
    const a = Math.random() * 6.283, r = rnd(350, 1100), cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = rnd(170, 300);
    for (let k = 0; k < 8 && nc < 220; k++) {
      const sc = rnd(14, 34);
      q.setFromAxisAngle(up, Math.random() * 6.28);
      cloud.setMatrixAt(nc++, m4.compose(p.set(cx + rnd(-40, 40), cy + rnd(-6, 8), cz + rnd(-22, 22)), q, s.set(sc * 1.6, sc * 0.7, sc)));
    }
  }
  cloud.count = nc;

  for (const m of [trunk, pine, round, rock]) { m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; }
  for (const m of [mtn, cloud]) m.frustumCulled = false;
  scene.add(trunk, pine, round, rock, mtn, cloud);
  return { setNight(on) { cloud.material.emissiveIntensity = on ? 0.02 : 0.25; } };
}
