#!/usr/bin/env node
// Cross-challenge duplicate check for llms-fireye raw.json.
// Flags pairs of challenge outputs that look identical — a genuine model doing
// "first-reaction" integer picks should never repeat sequences; duplicates imply
// response caching, a deterministic fake stream, or memorized answers.
//
// Usage: node scripts/check-dup.mjs reports/<dir>/raw.json [--threshold 0.85]

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/check-dup.mjs <raw.json> [--threshold 0.85]');
  process.exit(1);
}
const thrIdx = process.argv.indexOf('--threshold');
const THRESHOLD = thrIdx !== -1 ? Number(process.argv[thrIdx + 1]) : 0.95;

let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`failed to read/parse ${file}: ${e.message}`);
  process.exit(1);
}
const lanes = raw.lanes || raw; // tolerate both shapes
const items = [];
for (const lane of Array.isArray(lanes) ? lanes : Object.values(lanes)) {
  for (const c of lane.challenges || []) {
    if (!c.text) continue;
    items.push({ label: lane.label, round: c.round, expected: c.expected_count, text: c.text });
  }
}
if (items.length < 2) { console.log('no challenge texts found'); process.exit(0); }

const numsOf = (t) => (t.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= 355);
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};
const positionalMatch = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let m = 0; for (let i = 0; i < n; i++) if (a[i] === b[i]) m++;
  return m / n;
};

const byLabel = {};
for (const it of items) (byLabel[it.label] ||= []).push(it);

let flags = 0;
for (const [label, list] of Object.entries(byLabel)) {
  console.log(`\n== ${label}: ${list.length} challenges ==`);
  let labelFlags = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const na = numsOf(a.text), nb = numsOf(b.text);
      const seqIdentical = a.text.trim() === b.text.trim() ||
        (na.length === nb.length && na.length > 100 && na.every((v, k) => v === nb[k]));
      const jac = jaccard(na, nb);
      const pos = positionalMatch(na, nb);
      if (seqIdentical || pos > 0.3 || jac > THRESHOLD) {
        flags++; labelFlags++;
        const severity = seqIdentical && a.expected !== b.expected ? 'CRITICAL'
          : seqIdentical ? 'HIGH' : 'MEDIUM';
        console.log(`  [${severity}] round ${a.round}(want ${a.expected}) vs round ${b.round}(want ${b.expected})` +
          ` seqIdentical=${seqIdentical} jaccard=${jac.toFixed(3)} posMatch=${pos.toFixed(3)}` +
          ` lenA=${na.length} lenB=${nb.length}`);
      }
    }
  }
  if (!labelFlags) console.log('  clean: no duplicate/near-duplicate pairs');
}
console.log(flags ? `\n${flags} suspicious pair(s) — inspect raw.json` : '\nALL CLEAN: no shortcut/caching signals');
