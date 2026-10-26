import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GENERIC, MATERIALS, suggestMaterials } from './materials.js';

const V = THREE.Vector3;
export const FLAG = { THIN: 1, THICK: 2, DRAFT: 4, UNDERCUT: 8 };

// All tunable rules of thumb (mm / degrees) live here.
export const RULES = {
  thickVsNominal: 1.5,      // thicker than 1.5 × nominal → sink / void risk
  coneDeg: 30,              // thickness probe cone angle
  undercutMinCos: 0.02,     // faces closer to vertical than this are tested in both directions
  regionMinArea: 0.1,       // mm², ignore tessellation noise
  validFrac: 0.9,           // fraction of a feature that must release in a side direction
  slideClearance: 2.5,      // slide stroke = depth + this
  slideSweepExtra: 5,       // extra distance swept to check the slide path
  slideMargin: 3,           // slide footprint margin around the feature
  anglePinDeg: 20, anglePinMaxStroke: 50, hydraulicStroke: 75,
  lifterClearance: 1.5,     // lifter lateral travel = depth + this
  lifterBackClear: 2,       // extra free space needed behind the undercut
  lifterHeadMin: 6,         // min lifter head width
  lifterWarnTravel: 10, lifterMaxTravel: 12,
  lifterWarnDeg: 12, lifterMaxDeg: 15,
  ejectExtra: 10,           // assumed ejection stroke = part height along pull + this
  textureDraftPer0025: 1.5, // extra draft per 0.025 mm texture depth
  halfCos: 0.1,             // feature mean normal·d beyond this → clearly core- or cavity-formed
  maxRegions: 60,
};

const tick = () => new Promise(r => setTimeout(r, 0));
const ray = new THREE.Ray();
function cast(model, origin, dir) {
  ray.origin.copy(origin); ray.direction.copy(dir);
  return model.bvh.raycastFirst(ray, THREE.DoubleSide);
}
const getC = (m, t, v) => v.set(m.cen[3 * t], m.cen[3 * t + 1], m.cen[3 * t + 2]);
const getN = (m, t, v) => v.set(m.nor[3 * t], m.nor[3 * t + 1], m.nor[3 * t + 2]);
function perpendicular(d) {
  const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
  const a = ax <= ay && ax <= az ? new V(1, 0, 0) : ay <= az ? new V(0, 1, 0) : new V(0, 0, 1);
  return a.cross(d).normalize();
}

/* ---------- 1. Build one triangle soup + BVH from the occt meshes ---------- */
export function prepareModel(meshes) {
  let count = 0;
  for (const m of meshes) count += m.index ? m.index.array.length : m.attributes.position.array.length / 3;
  const P = new Float32Array(count * 3), N = new Float32Array(count * 3);
  let hasNormals = true, w = 0;
  for (const m of meshes) {
    const p = m.attributes.position.array, n = m.attributes.normal?.array;
    if (!n) hasNormals = false;
    const idx = m.index ? m.index.array : null, len = idx ? idx.length : p.length / 3;
    for (let i = 0; i < len; i++, w += 3) {
      const v = idx ? idx[i] : i;
      P[w] = p[3 * v]; P[w + 1] = p[3 * v + 1]; P[w + 2] = p[3 * v + 2];
      if (n) { N[w] = n[3 * v]; N[w + 1] = n[3 * v + 1]; N[w + 2] = n[3 * v + 2]; }
    }
  }
  const T = count / 3;

  // Make sure triangles wind outward (positive signed volume).
  let vol = 0;
  for (let i = 0; i < count * 3; i += 9) {
    vol += P[i] * (P[i + 4] * P[i + 8] - P[i + 5] * P[i + 7])
         - P[i + 1] * (P[i + 3] * P[i + 8] - P[i + 5] * P[i + 6])
         + P[i + 2] * (P[i + 3] * P[i + 7] - P[i + 4] * P[i + 6]);
  }
  if (vol < 0) {
    for (let i = 0; i < count * 3; i += 9) for (let k = 0; k < 3; k++) {
      [P[i + 3 + k], P[i + 6 + k]] = [P[i + 6 + k], P[i + 3 + k]];
      [N[i + 3 + k], N[i + 6 + k]] = [N[i + 6 + k], N[i + 3 + k]];
    }
    for (let i = 0; i < N.length; i++) N[i] = -N[i];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const ident = new Uint32Array(count); for (let i = 0; i < count; i++) ident[i] = i;
  geom.setIndex(new THREE.BufferAttribute(ident, 1));
  if (!hasNormals) geom.computeVertexNormals();
  const bvh = new MeshBVH(geom);           // may reorder the index; we read it afterwards
  const index = geom.index.array;

  const cen = new Float32Array(3 * T), nor = new Float32Array(3 * T), area = new Float32Array(T);
  const a = new V(), b = new V(), c = new V();
  for (let t = 0; t < T; t++) {
    a.fromArray(P, 3 * index[3 * t]); b.fromArray(P, 3 * index[3 * t + 1]); c.fromArray(P, 3 * index[3 * t + 2]);
    cen[3 * t] = (a.x + b.x + c.x) / 3; cen[3 * t + 1] = (a.y + b.y + c.y) / 3; cen[3 * t + 2] = (a.z + b.z + c.z) / 3;
    b.sub(a); c.sub(a); b.cross(c);
    const len = b.length();
    area[t] = len / 2;
    if (len > 0) { nor[3 * t] = b.x / len; nor[3 * t + 1] = b.y / len; nor[3 * t + 2] = b.z / len; }
  }
  geom.computeBoundingBox();
  const diag = geom.boundingBox.getSize(new V()).length();
  return { geom, bvh, T, index, P, cen, nor, area, box: geom.boundingBox, diag,
           eps: Math.max(1e-3, diag * 1e-5), bodies: meshes.length, th: null };
}

/* ---------- 2. Wall thickness: min of 5 inward rays (straight + 30° cone) ---------- */
async function measureThickness(model, progress) {
  const { T, eps } = model, th = new Float32Array(T).fill(NaN);
  const ca = Math.cos(RULES.coneDeg * Math.PI / 180), sa = Math.sin(RULES.coneDeg * Math.PI / 180);
  const n = new V(), c = new V(), u = new V(), v = new V(), o = new V(), dir = new V();
  const offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let t = 0; t < T; t++) {
    if (model.area[t] > 0) {
      getN(model, t, n); getC(model, t, c);
      u.set(Math.abs(n.x) > 0.9 ? 0 : 1, Math.abs(n.x) > 0.9 ? 1 : 0, 0).cross(n).normalize();
      v.crossVectors(n, u);
      o.copy(c).addScaledVector(n, -eps);
      let best = Infinity;
      for (const [i, j] of offs) {
        const straight = i === 0 && j === 0;
        if (straight) dir.copy(n).negate();
        else dir.copy(n).multiplyScalar(-ca).addScaledVector(u, i * sa).addScaledVector(v, j * sa);
        const hit = cast(model, o, dir);
        if (hit && hit.face.normal.dot(dir) > 0) {           // exiting the material = valid
          const d = hit.distance * (straight ? 1 : ca);
          if (d < best) best = d;
        }
      }
      if (best < Infinity) th[t] = best + eps;
    }
    if ((t & 2047) === 0) { progress(t / T); await tick(); }
  }
  return th;
}

function weightedPercentiles(vals, w, ps) {
  const idx = [];
  let total = 0;
  for (let i = 0; i < vals.length; i++) if (vals[i] === vals[i] && w[i] > 0) { idx.push(i); total += w[i]; }
  if (!idx.length) return ps.map(() => NaN);
  idx.sort((a, b) => vals[a] - vals[b]);
  return ps.map(p => { let acc = 0; for (const i of idx) { acc += w[i]; if (acc >= p * total) return vals[i]; } return vals[idx[idx.length - 1]]; });
}

/* ---------- 3. Pull direction + per-triangle draft / undercut ---------- */
function isTrapped(model, t, d, nd, n, c, o) {
  getN(model, t, n); getC(model, t, c);
  const s = n.dot(d);
  o.copy(c).addScaledVector(n, model.eps);
  if (s > RULES.undercutMinCos) return !!cast(model, o, d);
  if (s < -RULES.undercutMinCos) return !!cast(model, o, nd);
  return !!cast(model, o, d) && !!cast(model, o, nd);       // vertical: blocked both ways?
}

function candidateDirections(model) {
  const dirs = [new V(1, 0, 0), new V(0, 1, 0), new V(0, 0, 1)];
  const bins = new Map(), n = new V();
  for (let t = 0; t < model.T; t++) {
    getN(model, t, n);
    const big = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? n.x : Math.abs(n.y) >= Math.abs(n.z) ? n.y : n.z;
    if (big < 0) n.negate();
    const key = `${Math.round(n.x * 8)},${Math.round(n.y * 8)},${Math.round(n.z * 8)}`;
    const b = bins.get(key) || { a: 0, v: new V() };
    b.a += model.area[t]; b.v.addScaledVector(n, model.area[t]); bins.set(key, b);
  }
  const cos10 = Math.cos(10 * Math.PI / 180);
  for (const b of [...bins.values()].sort((x, y) => y.a - x.a).slice(0, 6)) {
    const v = b.v.clone().normalize();
    if (dirs.every(d => Math.abs(d.dot(v)) < cos10)) dirs.push(v);
    if (dirs.length >= 6) break;
  }
  return dirs;
}

function choosePullDirection(model, sinDraft) {
  const stride = Math.max(1, Math.floor(model.T / 4000));
  const n = new V(), c = new V(), o = new V();
  let best = null, bestScore = Infinity;
  for (const d of candidateDirections(model)) {
    const nd = d.clone().negate();
    let under = 0, low = 0;
    for (let t = 0; t < model.T; t += stride) {
      const a = model.area[t]; if (!a) continue;
      if (isTrapped(model, t, d, nd, n, c, o)) under += a;
      if (Math.abs(n.dot(d)) < sinDraft) low += a;
    }
    const score = 10 * under + 3 * low;
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// Recessed geometry on each side, weighted by depth. The side with more pockets should be the
// core (moving half); the part shrinks onto it and stays with the ejectors.
// d = ejection direction: points from the core toward the cavity.
function sideVolumes(model, d) {
  let hmin = Infinity, hmax = -Infinity;
  for (let i = 0; i < model.P.length; i += 3) {
    const s = model.P[i] * d.x + model.P[i + 1] * d.y + model.P[i + 2] * d.z;
    if (s < hmin) hmin = s;
    if (s > hmax) hmax = s;
  }
  let core = 0, cav = 0;
  const n = new V(), c = new V();
  for (let t = 0; t < model.T; t++) {
    const a = model.area[t]; if (!a) continue;
    const s = getN(model, t, n).dot(d), h = getC(model, t, c).dot(d);
    if (s < 0) core += a * -s * (h - hmin);   // faces the core
    else cav += a * s * (hmax - h);           // faces the cavity
  }
  return { core, cav, hmin, hmax };
}

async function classify(model, d, sinDraft, th, mat, nominal, progress) {
  const flags = new Uint8Array(model.T), nd = d.clone().negate();
  const n = new V(), c = new V(), o = new V();
  const thickLimit = Math.min(mat.wallMax, RULES.thickVsNominal * nominal);
  for (let t = 0; t < model.T; t++) {
    if (model.area[t] > 0) {
      if (isTrapped(model, t, d, nd, n, c, o)) flags[t] |= FLAG.UNDERCUT;
      if (Math.abs(n.dot(d)) < sinDraft) flags[t] |= FLAG.DRAFT;
      const tt = th[t];
      if (tt === tt) { if (tt < mat.wallMin) flags[t] |= FLAG.THIN; else if (tt > thickLimit) flags[t] |= FLAG.THICK; }
    }
    if ((t & 4095) === 0) { progress(t / model.T); await tick(); }
  }
  return flags;
}

/* ---------- 4. Group undercut triangles into features ---------- */
function groupRegions(model, flags, bit) {
  const { T, index, P } = model, q = model.eps * 10;
  const parent = new Int32Array(T); for (let i = 0; i < T; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const seen = new Map();
  for (let t = 0; t < T; t++) {
    if (!(flags[t] & bit)) continue;
    for (let k = 0; k < 3; k++) {
      const v = 3 * index[3 * t + k];
      const key = `${Math.round(P[v] / q)},${Math.round(P[v + 1] / q)},${Math.round(P[v + 2] / q)}`;
      const other = seen.get(key);
      if (other === undefined) seen.set(key, t);
      else { const a = find(t), b = find(other); if (a !== b) parent[a] = b; }
    }
  }
  const groups = new Map();
  for (let t = 0; t < T; t++) if (flags[t] & bit) {
    const r = find(t); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t);
  }
  return [...groups.values()];
}

const extent = (verts, axis) => { let lo = Infinity, hi = -Infinity; for (const p of verts) { const s = p.dot(axis); if (s < lo) lo = s; if (s > hi) hi = s; } return [lo, hi]; };

// Sweep a grid over the tool footprint along m; return the fraction of rays that run into the part.
function sweepBlocked(model, verts, m, d, marginW, marginH, range) {
  const w = new V().crossVectors(d, m).normalize();
  const [, pm] = extent(verts, m);
  let [w0, w1] = extent(verts, w), [h0, h1] = extent(verts, d);
  w0 -= marginW; w1 += marginW; h0 -= marginH; h1 += marginH;
  const N = 7, o = new V();
  let blocked = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    o.copy(m).multiplyScalar(pm + 0.5)
      .addScaledVector(w, w0 + (w1 - w0) * i / (N - 1))
      .addScaledVector(d, h0 + (h1 - h0) * j / (N - 1));
    let travelled = 0;
    for (let k = 0; k < 4; k++) {
      const hit = cast(model, o, m);
      if (!hit || travelled + hit.distance > range) break;
      if (hit.face.normal.dot(m) < 0) { blocked++; break; }       // entering part material → collision
      travelled += hit.distance + model.eps;                      // started inside (draft) → skip out
      o.copy(hit.point).addScaledVector(m, model.eps);
    }
  }
  return blocked / (N * N);
}

/* ---------- 5. Strip / slide / lifter decision for one undercut feature ---------- */
function evaluateRegion(model, tris, d, mat, partHeight) {
  const { index, P, eps } = model;
  const n = new V(), c = new V(), o = new V();
  const verts = [], cen = new V(), mean = new V();
  let A = 0;
  for (const t of tris) {
    const a = model.area[t]; A += a;
    cen.addScaledVector(getC(model, t, c), a); mean.addScaledVector(getN(model, t, n), a);
    for (let k = 0; k < 3; k++) verts.push(new V().fromArray(P, 3 * index[3 * t + k]));
  }
  cen.divideScalar(A); mean.divideScalar(A);

  // Which mold half forms this feature: normal toward +d = cavity (fixed), toward −d = core (moving).
  const sd = mean.dot(d);
  const half = sd > RULES.halfCos ? 'cavity' : sd < -RULES.halfCos ? 'core' : 'wall';

  // Candidate side-action directions: 8 in the plane ⊥ pull + the feature's mean side normal.
  const e1 = perpendicular(d), e2 = new V().crossVectors(d, e1), dirs = [];
  for (let k = 0; k < 8; k++) dirs.push(e1.clone().multiplyScalar(Math.cos(k * Math.PI / 4)).addScaledVector(e2, Math.sin(k * Math.PI / 4)));
  const side = mean.clone().addScaledVector(d, -mean.dot(d));
  if (side.length() > 0.3) dirs.push(side.normalize());

  const evals = dirs.map(m => {
    const [lo, hi] = extent(verts, m), D = Math.max(hi - lo, 0.1);
    const need = D + RULES.lifterClearance + RULES.lifterBackClear;
    let valid = 0, inf = 0, lift = 0;
    for (const t of tris) {
      getN(model, t, n);
      if (n.dot(m) < -0.1) continue;                     // this face would be dragged by the tool
      const a = model.area[t]; valid += a;
      o.copy(getC(model, t, c)).addScaledVector(n, eps);
      const hit = cast(model, o, m);
      if (!hit) { inf += a; lift += a; } else if (hit.distance >= need) lift += a;
    }
    return { m, D, valid: valid / A, inf: inf / A, lift: lift / A };
  });

  // Radial depth (for ring-shaped bumps) vs. straight depth — use the smaller one.
  const pc = cen.clone().addScaledVector(d, -cen.dot(d));
  let rmin = Infinity, rmax = 0;
  for (const p of verts) { const r = p.clone().addScaledVector(d, -p.dot(d)).distanceTo(pc); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  const depth = Math.min(Math.min(...evals.map(e => e.D)), rmax - rmin);
  const base = { tris, area: A, centroid: cen, depth, half };

  if (mat.stripMm > 0 && depth <= mat.stripMm) return { ...base, status: 'strip' };

  let slideBlocked = false;
  for (const e of evals.filter(e => e.valid >= RULES.validFrac && e.inf >= RULES.validFrac).sort((a, b) => a.D - b.D)) {
    const stroke = e.D + RULES.slideClearance;
    if (sweepBlocked(model, verts, e.m, d, RULES.slideMargin, RULES.slideMargin, stroke + RULES.slideSweepExtra) <= 0.05)
      return { ...base, status: 'slide', dir: e.m, D: e.D, stroke };
    slideBlocked = true;
  }

  // Lifters are driven by the ejector plate, so they only work on the core (moving) half.
  const ejectStroke = partHeight + RULES.ejectExtra;
  let lifterProblem = half === 'cavity'
    ? 'it is formed by the cavity (fixed half), and lifters only work on the ejector half — try flipping the pull direction'
    : null;
  const lifterDirs = half === 'cavity' ? []
    : evals.filter(e => e.valid >= RULES.validFrac && e.lift >= RULES.validFrac).sort((a, b) => a.D - b.D);
  for (const e of lifterDirs) {
    const travel = e.D + RULES.lifterClearance;
    const angle = Math.atan(travel / ejectStroke) * 180 / Math.PI;
    if (travel > RULES.lifterMaxTravel) { lifterProblem = `lifter would need ${travel.toFixed(1)} mm lateral travel (max ≈${RULES.lifterMaxTravel} mm)`; continue; }
    if (angle > RULES.lifterMaxDeg) { lifterProblem = `lifter angle ${angle.toFixed(1)}° exceeds ${RULES.lifterMaxDeg}° for the available ejection stroke`; continue; }
    const w = new V().crossVectors(d, e.m).normalize(), [w0, w1] = extent(verts, w);
    const mw = Math.max(1, (RULES.lifterHeadMin - (w1 - w0)) / 2);
    if (sweepBlocked(model, verts, e.m, d, mw, 1, travel + RULES.lifterBackClear) > 0.05) { lifterProblem = 'part features (wall/boss/rib) block the lifter travel'; continue; }
    return { ...base, status: 'lifter', dir: e.m, D: e.D, travel, angle, ejectStroke };
  }

  const reasons = [];
  if (!evals.some(e => e.valid >= RULES.validFrac)) reasons.push('trapped in every side direction tested (ring, thread or internal groove?)');
  if (slideBlocked) reasons.push('a slide could release it, but other part features block the slide path');
  if (lifterProblem) reasons.push(lifterProblem);
  if (!reasons.length) reasons.push('no side direction has clear space for a slide or a lifter');
  return { ...base, status: 'fail', reasons };
}

/* ---------- 6. Orchestrator ---------- */
export async function analyze(model, opts, progress = () => {}) {
  const mat = (opts.materialKey && MATERIALS[opts.materialKey]) || GENERIC;
  const draftDeg = mat.draft + RULES.textureDraftPer0025 * (opts.textureDepth || 0) / 0.025;
  const sinDraft = Math.sin(draftDeg * Math.PI / 180);

  progress('Choosing pull direction', 0); await tick();
  const d = (opts.pull === 'auto' ? choosePullDirection(model, sinDraft)
          : { x: new V(1, 0, 0), y: new V(0, 1, 0), z: new V(0, 0, 1) }[opts.pull]).clone();
  const v0 = sideVolumes(model, d);
  if (v0.core < v0.cav) d.negate();   // put the recessed side on the core
  if (opts.flip) d.negate();          // user override (⇅ Flip button)
  const vols = sideVolumes(model, d);

  if (!model.th) model.th = await measureThickness(model, f => progress('Measuring wall thickness', f));
  const th = model.th;
  const [p10, nominal, p90] = weightedPercentiles(th, model.area, [0.1, 0.5, 0.9]);

  const flags = await classify(model, d, sinDraft, th, mat, nominal, f => progress('Checking draft & undercuts', f));

  const partHeight = vols.hmax - vols.hmin;

  const areaOf = tris => tris.reduce((s, t) => s + model.area[t], 0);
  let groups = groupRegions(model, flags, FLAG.UNDERCUT).map(g => ({ g, a: areaOf(g) }));
  for (const { g, a } of groups) if (a < RULES.regionMinArea) for (const t of g) flags[t] &= ~FLAG.UNDERCUT;
  groups = groups.filter(x => x.a >= RULES.regionMinArea).sort((x, y) => y.a - x.a);

  const regions = [];
  for (let i = 0; i < Math.min(groups.length, RULES.maxRegions); i++) {
    progress('Evaluating slides & lifters', i / groups.length); await tick();
    regions.push(evaluateRegion(model, groups[i].g, d, mat, partHeight));
  }

  // ---- Build the issue list ----
  const list = bit => { const a = []; for (let t = 0; t < model.T; t++) if (flags[t] & bit) a.push(t); return a; };
  const totalArea = areaOf([...Array(model.T).keys()]);
  const thin = list(FLAG.THIN), thick = list(FLAG.THICK), draft = list(FLAG.DRAFT);
  const issues = [];
  const mm2 = a => `${a.toFixed(0)} mm²`;

  if (thin.length) issues.push({ severity: 'error', title: 'Thin walls', tris: thin,
    detail: `${mm2(areaOf(thin))} thinner than ${mat.wallMin} mm (minimum for ${mat.name}). Risk of short shots — thicken, or use a higher-flow material.` });
  if (thick.length) issues.push({ severity: 'warn', title: 'Thick sections / sink risk', tris: thick,
    detail: `${mm2(areaOf(thick))} thicker than ${Math.min(mat.wallMax, RULES.thickVsNominal * nominal).toFixed(2)} mm (max wall or ${RULES.thickVsNominal}× nominal). Core out or thin the ribs (≤0.5–0.6× wall).` });
  if (draft.length) issues.push({ severity: 'warn', title: 'Insufficient draft', tris: draft,
    detail: `${mm2(areaOf(draft))} below ${draftDeg.toFixed(2)}° draft${opts.textureDepth ? ' (includes texture allowance)' : ''}. Add draft in the pull direction.` });
  if (nominal < mat.wallMin || nominal > mat.wallMax) issues.push({ severity: 'error', title: 'Nominal wall out of range', tris: [],
    detail: `Nominal wall ≈${nominal.toFixed(2)} mm vs. ${mat.wallMin}–${mat.wallMax} mm for ${mat.name}.` });
  const lt = (model.diag / 2) / nominal;
  if (lt > mat.maxLT) issues.push({ severity: 'warn', title: 'Long flow length', tris: [],
    detail: `Flow length/thickness ≈${Math.round(lt)} (centre gate assumed) vs. ≈${mat.maxLT} for ${mat.name}. Add gates or thicken walls.` });
  if (vols.core < vols.cav) issues.push({ severity: 'warn', title: 'Part may stay on the fixed half', tris: [],
    detail: 'More recessed geometry faces the cavity than the core, so the part may stick in the cavity instead of staying on the moving half with the ejectors. Try flipping the pull direction.' });

  regions.forEach((r, i) => {
    const k = `Undercut ${i + 1}`;
    const it = { tris: r.tris, arrow: r.dir ? { origin: r.centroid, dir: r.dir } : null };
    if (r.status === 'strip') Object.assign(it, { severity: 'warn', title: `${k}: strippable`,
      detail: `≈${r.depth.toFixed(2)} mm deep — can be stripped in ${mat.name} with a 30–45° lead-in and room for the part to flex.` });
    else if (r.status === 'slide') {
      const actuation = r.half === 'cavity'
        ? 'cavity-side (fixed half) slide — needs a hydraulic cylinder or delayed action (higher cost); flipping the pull direction may put it on the core side'
        : r.stroke <= RULES.anglePinMaxStroke ? `angle pin OK (≈${(r.stroke / Math.sin(RULES.anglePinDeg * Math.PI / 180)).toFixed(0)} mm engaged pin length at ${RULES.anglePinDeg}°)`
        : r.stroke <= RULES.hydraulicStroke ? 'long angle pin — consider a hydraulic cylinder' : 'hydraulic cylinder required';
      Object.assign(it, { severity: 'warn', title: `${k}: needs a slide`,
        detail: `Depth ≈${r.D.toFixed(1)} mm → slide stroke ≈${r.stroke.toFixed(1)} mm; ${actuation}. Slide path is clear of other features.` });
    } else if (r.status === 'lifter') {
      const warn = r.travel > RULES.lifterWarnTravel || r.angle > RULES.lifterWarnDeg ? ' ⚠ near practical limits — review with toolmaker.' : '';
      const halfNote = r.half === 'core' ? 'Formed by the core (ejector) half.'
        : 'Undercut is on a side wall — confirm it is formed by the core (ejector) half.';
      Object.assign(it, { severity: 'warn', title: `${k}: needs a lifter`,
        detail: `Lateral travel ≈${r.travel.toFixed(1)} mm at ≈${r.angle.toFixed(1)}° with ≈${r.ejectStroke.toFixed(0)} mm ejection stroke. Space behind the undercut is clear. ${halfNote}${warn}` });
    } else Object.assign(it, { severity: 'error', title: `${k}: not moldable as drawn`,
      detail: `${r.reasons.join('; ')}. Options: pass-through core/shut-off, split the feature, collapsible/unscrewing core, or a flexible material to strip it.` });
    issues.push(it);
  });
  if (groups.length > RULES.maxRegions) issues.push({ severity: 'warn', title: 'More undercuts', tris: [],
    detail: `${groups.length - RULES.maxRegions} smaller undercut features not evaluated.` });

  const stats = { nominal, p10, p90, lt,
    thinFrac: areaOf(thin) / totalArea, thickFrac: areaOf(thick) / totalArea, draftFrac: areaOf(draft) / totalArea,
    minUndercutDepth: regions.length ? Math.min(...regions.map(r => r.depth)) : Infinity };

  return { pull: d, flipped: !!opts.flip, material: mat, draftDeg, nominal, p10, p90, partHeight, lt, flags, issues,
           suggestions: suggestMaterials(stats), bodies: model.bodies, triangles: model.T };
}
