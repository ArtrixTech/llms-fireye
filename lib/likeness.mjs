// "How much like the label": text visualisations of per-answer p_label, shared by report.md
// and the pi overlay. Descriptive only; the verdict still comes from attribution.mjs.
//
// Two views answer questions the k / j counts cannot:
//  - strip (send order): are the odd answers bunched in time (routing that switches with load or
//    time) or scattered (a steady mix)?
//  - histogram against genuine held-out answers: is the whole distribution shifted down (every
//    answer a bit off, e.g. another version / quantised weights / heavy system prompt) or is it
//    bimodal (most answers genuine plus a separate cluster that is not)?

export const BINS = [
  { lo: 0.9, label: '≥90%', glyph: '█' },
  { lo: 0.5, label: '50–90%', glyph: '▆' },
  { lo: 0.1, label: '10–50%', glyph: '▄' },
  { lo: 0.001, label: '0.1–10%', glyph: '▂' },
  { lo: 0, label: '<0.1%', glyph: '▁' },
];
export const binOf = (p) => BINS.findIndex(b => p >= b.lo);

/** Per-answer cell in send order: glyph height = p_label; kind = ok | drift | off | none. */
export function stripCells(answers) {
  return [...answers].sort((a, b) => a.index - b.index).map(a => {
    const s = a.assessment || {};
    if (!s.valid || s.p_label == null) return { glyph: '·', kind: 'none', index: a.index };
    const kind = s.flagged ? 'off' : s.drifted ? 'drift' : 'ok';
    return { glyph: kind === 'off' ? '✗' : BINS[binOf(s.p_label)].glyph, kind, index: a.index, p: s.p_label, like: s.like };
  });
}

/** Two text rows: heights, then a marker row (≈ drifted, ✗ off-label) so plain text keeps the class. */
export function stripText(answers) {
  const cells = stripCells(answers);
  return { bars: cells.map(c => c.glyph).join(''), marks: cells.map(c => (c.kind === 'drift' ? '≈' : c.kind === 'off' ? '✗' : ' ')).join('').replace(/\s+$/, '') };
}

/** Genuine reference shares per bin for a label (falls back to the pooled distribution). */
export function referenceShares(cal, labelId) {
  const ref = cal?.likeness;
  if (!ref) return null;
  const by = labelId && ref.by_label?.[labelId];
  return by && by.n >= 30 ? { share: by.share, n: by.n, pooled: false } : { share: ref.share, n: ref.n, pooled: true };
}

/** Histogram rows: observed count per bin vs the count a genuine channel would give. */
export function histogram(answers, cal, labelId) {
  const ps = answers.map(a => a.assessment).filter(s => s?.valid && s.p_label != null).map(s => s.p_label);
  const counts = BINS.map(() => 0);
  for (const p of ps) counts[binOf(p)]++;
  const ref = referenceShares(cal, labelId);
  return {
    n: ps.length, ref,
    rows: BINS.map((b, i) => ({ label: b.label, count: counts[i], expected: ref ? ref.share[i] * ps.length : null })),
  };
}

const bar = (x, scale, width) => {
  const cells = (x / scale) * width;
  const full = Math.floor(cells);
  const frac = cells - full;
  const part = frac >= 0.75 ? '▊' : frac >= 0.5 ? '▌' : frac >= 0.25 ? '▎' : '';
  return '█'.repeat(full) + part;
};

/** Histogram as aligned text lines (report code block / TUI). */
export function histogramLines(h, width = 24) {
  if (!h.n) return [];
  const scale = Math.max(1, ...h.rows.map(r => Math.max(r.count, r.expected ?? 0)));
  const L = [];
  for (const r of h.rows) {
    const obs = `${bar(r.count, scale, width)} ${r.count}`;
    const exp = r.expected == null ? '' : `${bar(r.expected, scale, width)} ${r.expected < 0.1 && r.expected > 0 ? '<0.1' : r.expected.toFixed(1)}`;
    L.push(`${r.label.padEnd(8)}${padW(obs, width + 4)}${exp}`);
  }
  return L;
}

// CJK-safe padding is not needed here (bars and digits are single-width), but block glyphs are.
const padW = (s, w) => s + ' '.repeat(Math.max(1, w - [...s].length));

/**
 * One-line reading of the shape, only when it is clear. Not a test: the verdict does not use it.
 * Measured by scripts/calibrate.mjs at n=30: never on genuine runs, ~25% of runs diluted at 25%.
 * ("Matches genuine" and "shifted overall" notes were tried and dropped: the first also fired on
 * 10-17% of 25%-diluted runs, the second fired more on genuine runs than on substitutions.)
 */
export function shapeNote(h) {
  if (!h.ref || h.n < 9) return null;
  const top = h.rows[0].count / h.n, topRef = h.ref.share[0];
  const low = (h.rows[3].count + h.rows[4].count) / h.n, lowRef = h.ref.share[3] + h.ref.share[4];
  if (low >= Math.max(0.1, 3 * lowRef) && top >= 0.8 * topRef) return '分布是两团：多数回答和真模型一样，另有一小团明显偏低（掺了别的模型时常见这种形状）';
  return null;
}
