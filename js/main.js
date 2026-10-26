import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MATERIALS } from './materials.js';
import { prepareModel, analyze } from './analysis.js';

const OCCT_DIST = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';
const GREY = [0.62, 0.62, 0.62], RED = [0.85, 0.1, 0.1];
const $ = id => document.getElementById(id);

/* ---- viewer ---- */
const viewer = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewer.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xf2f3f5);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.5, 1, 1); camera.add(sun); camera.add(sun.target); sun.target.position.set(0, 0, -1);
scene.add(camera);
const helpers = new THREE.Group(); scene.add(helpers);

function resize() {
  const w = viewer.clientWidth, h = viewer.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewer);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

/* ---- UI ---- */
$('material').innerHTML = '<option value="">— Not specified —</option>' +
  Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}">${m.name}</option>`).join('');
const setStatus = (msg, err = false) => { $('status').textContent = msg; $('status').className = err ? 'error' : ''; };

let occtPromise = null, model = null, mesh = null, report = null, activeIssue = null;
let flipped = false, busy = false;
const setFlip = v => { flipped = v; $('flip').classList.toggle('on', v); };
const setButtons = enabled => { $('run').disabled = !enabled; $('flip').disabled = !enabled; };
const getOcct = () => (occtPromise ??= window.occtimportjs({ locateFile: f => OCCT_DIST + f }));

$('file').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file || busy) return;
  try {
    setStatus('Loading STEP engine (first time only)…');
    const occt = await getOcct();
    setStatus(`Reading ${file.name}…`);
    const buf = new Uint8Array(await file.arrayBuffer());
    const res = occt.ReadStepFile(buf, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio',
                                         linearDeflection: 0.003, angularDeflection: 0.5 });
    if (!res.success || !res.meshes.length) throw new Error('Could not read this STEP file.');
    showModel(prepareModel(res.meshes));
    setFlip(false);
    setButtons(true);
    await runAnalysis();
  } catch (err) { console.error(err); setStatus('Error: ' + err.message, true); }
});
$('run').addEventListener('click', runAnalysis);
$('flip').addEventListener('click', () => { if (busy || !model) return; setFlip(!flipped); runAnalysis(); });
$('pull').addEventListener('change', () => { setFlip(false); if (model) runAnalysis(); });

function showModel(m) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  helpers.clear();
  model = m;
  mesh = new THREE.Mesh(m.geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }));
  scene.add(mesh);
  paint([]);
  const center = m.box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(m.diag * 1.4));
  camera.near = m.diag / 1000; camera.far = m.diag * 100; camera.updateProjectionMatrix();
}

function paint(tris) {
  const col = model.geom.attributes.color.array, idx = model.index;
  for (let i = 0; i < col.length; i += 3) col.set(GREY, i);
  for (const t of tris) for (let k = 0; k < 3; k++) col.set(RED, 3 * idx[3 * t + k]);
  model.geom.attributes.color.needsUpdate = true;
}

function arrow(origin, dir, color, len) {
  helpers.add(new THREE.ArrowHelper(dir.clone().normalize(), origin, len, color, len * 0.25, len * 0.12));
}

function highlight(issue) {
  activeIssue = issue;
  helpers.clear();
  const c = model.box.getCenter(new THREE.Vector3());
  arrow(c.clone().addScaledVector(report.pull, report.partHeight / 2), report.pull, 0x2266dd, model.diag * 0.3);
  if (issue) {
    paint(issue.tris);
    if (issue.arrow) arrow(issue.arrow.origin, issue.arrow.dir, 0x22aa44, model.diag * 0.15);
  } else {
    const all = new Set(); report.issues.forEach(i => i.tris.forEach(t => all.add(t)));
    paint([...all]);
  }
  document.querySelectorAll('ul.issues li').forEach(li => li.classList.toggle('active', report.issues[li.dataset.i] === issue));
}

async function runAnalysis() {
  if (!model || busy) return;
  busy = true; setButtons(false);
  const t0 = performance.now();
  try {
    report = await analyze(model, {
      materialKey: $('material').value || null,
      textureDepth: parseFloat($('texture').value) || 0,
      pull: $('pull').value,
      flip: flipped,
    }, (label, f) => setStatus(`${label}… ${Math.round(f * 100)}%`));
    renderReport(report);
    highlight(null);
    setStatus(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${report.triangles.toLocaleString()} triangles`);
  } catch (err) { console.error(err); setStatus('Analysis error: ' + err.message, true); }
  busy = false; setButtons(true);
}

const fmtVec = v => {
  for (const [a, n] of [['x', 'X'], ['y', 'Y'], ['z', 'Z']]) if (Math.abs(v[a]) > 0.999) return (v[a] > 0 ? '+' : '−') + n;
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
};

function renderReport(r) {
  const s = r.suggestions, sel = $('material').value;
  const selRow = sel ? s.ranked.find(x => x.key === sel) : null;
  $('results').innerHTML = `
    <h2>Summary</h2>
    <table>
      <tr><td>Material rules</td><td>${r.material.name}</td></tr>
      <tr><td>Pull direction</td><td>${fmtVec(r.pull)}${r.flipped ? ' (flipped)' : ''}</td></tr>
      <tr><td colspan="2" class="small">Blue arrow = ejection direction. It points from the core (moving half, ejectors, lifters) toward the cavity (fixed half).</td></tr>
      <tr><td>Nominal wall</td><td>${r.nominal.toFixed(2)} mm (10–90%: ${r.p10.toFixed(2)}–${r.p90.toFixed(2)})</td></tr>
      <tr><td>Required draft</td><td>${r.draftDeg.toFixed(2)}°</td></tr>
      <tr><td>Flow length / t</td><td>≈${Math.round(r.lt)} (centre gate)</td></tr>
      ${r.bodies > 1 ? `<tr><td colspan="2">⚠ ${r.bodies} bodies found — analysed together.</td></tr>` : ''}
    </table>
    <h2>Issues (${r.issues.length}) <button id="showAll">Show all</button></h2>
    ${r.issues.length ? '' : '<p>No moldability issues detected. 🎉</p>'}
    <ul class="issues">${r.issues.map((i, n) => `
      <li data-i="${n}" class="${i.severity}"><b>${i.title}</b><br><span class="small">${i.detail}</span></li>`).join('')}
    </ul>
    <h2>Material suggestions</h2>
    ${s.active.length ? `<p class="small">Based on: ${s.active.join(', ')}.</p>` : '<p class="small">No material-driven issues — general-purpose choices shown.</p>'}
    <ol>${s.ranked.slice(0, 3).map(x => `<li><b>${x.name}</b> — ${x.note}
      ${x.pros.length ? `<div class="small">✔ ${x.pros.join('<br>✔ ')}</div>` : ''}
      ${x.cons.length ? `<div class="small">✖ ${x.cons.join('<br>✖ ')}</div>` : ''}</li>`).join('')}</ol>
    ${selRow && selRow.cons.length ? `<p class="small"><b>Your choice (${selRow.name}):</b> ${selRow.cons.join('; ')}.</p>` : ''}
    <p class="small">Rule-of-thumb screening only — confirm with your toolmaker and resin datasheet.</p>`;
  $('showAll').onclick = () => highlight(null);
  document.querySelectorAll('ul.issues li').forEach(li => li.onclick = () => {
    const issue = r.issues[li.dataset.i];
    highlight(activeIssue === issue ? null : issue);
  });
}
