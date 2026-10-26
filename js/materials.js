// Rule-of-thumb values for FLAGGING ONLY — confirm with the resin supplier's datasheet.
// wallMin/wallMax: nominal wall range (mm) · draft: min draft on polished surfaces (deg)
// maxLT: approx. max flow length / wall thickness · stripMm: approx. max undercut that can be
// stripped (bumped off) with a 30–45° lead-in, 0 = don't strip.
export const GENERIC = { name: 'Generic (no material given)', wallMin: 0.8, wallMax: 4.0, draft: 1.0, maxLT: 150, stripMm: 0 };

const m = (name, wallMin, wallMax, draft, maxLT, stripMm, shrink, note) =>
  ({ name, wallMin, wallMax, draft, maxLT, stripMm, shrink, note });

export const MATERIALS = {
  ABS:      m('ABS',       1.2, 3.5, 0.5, 175, 0.15, '0.4–0.7%', 'Easy to mold, low shrink.'),
  PC:       m('PC',        1.0, 4.0, 1.0, 125, 0,    '0.5–0.7%', 'Viscous, notch-sensitive; needs radii.'),
  PCABS:    m('PC/ABS',    1.2, 3.5, 1.0, 150, 0.15, '0.5–0.7%', 'Tougher than ABS, flows better than PC.'),
  PP:       m('PP',        0.8, 3.8, 0.5, 300, 0.5,  '1.0–2.5%', 'Living hinges, strippable undercuts; warps.'),
  HDPE:     m('HDPE',      0.8, 5.0, 1.0, 250, 0.5,  '1.5–3.0%', 'Very flexible; high shrink/warp.'),
  PA6:      m('PA6',       0.8, 3.0, 0.5, 200, 0.4,  '0.8–1.5%', 'Good snap fits; absorbs moisture.'),
  PA66:     m('PA66',      0.8, 3.0, 0.5, 200, 0.4,  '1.0–2.2%', 'Very fluid melt (flash risk).'),
  PA66GF30: m('PA66-GF30', 1.0, 3.5, 1.0, 125, 0,    '0.3–1.0% (anisotropic)', 'Stiff; warps across flow; no stripping.'),
  POM:      m('POM',       0.8, 3.0, 0.5, 200, 0.4,  '1.8–2.5%', 'Slippery, releases easily.'),
  PBT:      m('PBT',       0.8, 3.0, 0.5, 200, 0.15, '1.5–2.0%', 'Good for thin walls / connectors.'),
  PMMA:     m('PMMA',      0.8, 3.5, 1.0, 140, 0,    '0.2–0.8%', 'Clear, brittle; scratches on ejection.'),
  PS:       m('PS',        1.0, 4.0, 1.0, 250, 0,    '0.3–0.6%', 'Brittle; poor snap fits.'),
  TPE:      m('TPE / TPU', 0.5, 3.0, 1.0, 175, 1.0,  '0.5–2.0%', 'Rubbery; strips deep undercuts.'),
  PEI:      m('PEI',       0.8, 3.8, 1.0, 125, 0,    '0.5–0.7%', 'High temp, stiff; no stripping.'),
};

// Which materials help / hurt for each kind of detected issue.
const ISSUES = {
  thinFlow:      { label: 'thin walls / long flow', why: 'low melt viscosity fills thin, long flow paths',
                   suggest: ['PP','PA66','PBT','POM','PA6','ABS'], avoid: ['PC','PEI','PMMA','PA66GF30'] },
  thick:         { label: 'thick sections', why: 'low-shrink amorphous resin shows less sink',
                   suggest: ['PMMA','PC','ABS','PCABS'], avoid: ['POM','PA6','PA66','PP','PBT','HDPE'] },
  uneven:        { label: 'uneven walls / warp', why: 'low, uniform shrink resists warp',
                   suggest: ['ABS','PCABS','PC','PS'], avoid: ['PP','HDPE','POM','PA66GF30'] },
  smallUndercut: { label: 'shallow undercuts', why: 'ductile enough to strip off the core',
                   suggest: ['PP','HDPE','POM','PA6','PA66','TPE'], avoid: ['PC','PMMA','PS','PA66GF30','PEI'] },
  lowDraft:      { label: 'low draft', why: 'low friction, releases with little draft',
                   suggest: ['POM','PA6','PA66','PP','PBT'], avoid: ['PMMA','PC','TPE','PA66GF30'] },
};

export function suggestMaterials(s) {
  const active = [];
  if (s.thinFrac > 0.01 || s.nominal < 1.0 || s.lt > 150) active.push('thinFlow');
  if (s.thickFrac > 0.01 || s.nominal > 3.5) active.push('thick');
  if (s.p90 / s.p10 > 1.67) active.push('uneven');
  if (s.minUndercutDepth <= 1.0) active.push('smallUndercut');
  if (s.draftFrac > 0.02) active.push('lowDraft');

  const ranked = Object.entries(MATERIALS).map(([key, mat]) => {
    let score = 0; const pros = [], cons = [];
    if (s.nominal < mat.wallMin || s.nominal > mat.wallMax) {
      score -= 3; cons.push(`nominal wall ${s.nominal.toFixed(2)} mm is outside ${mat.wallMin}–${mat.wallMax} mm`);
    }
    if (s.lt > mat.maxLT) { score -= 2; cons.push(`flow length/thickness ≈${Math.round(s.lt)} exceeds ≈${mat.maxLT}`); }
    for (const k of active) {
      const r = ISSUES[k];
      if (r.suggest.includes(key)) { score += 2; pros.push(`${r.label}: ${r.why}`); }
      if (r.avoid.includes(key))   { score -= 2; cons.push(`not ideal for ${r.label}`); }
    }
    if (mat.stripMm > 0 && mat.stripMm >= s.minUndercutDepth) { score += 1; pros.push(`can strip ≈${mat.stripMm} mm undercuts`); }
    return { key, name: mat.name, score, pros, cons, note: mat.note };
  }).sort((a, b) => b.score - a.score);

  return { active: active.map(k => ISSUES[k].label), ranked };
}
