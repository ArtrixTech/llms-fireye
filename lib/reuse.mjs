// Reuse detection — two checks over *relations between answers*, catching a relay that
// replays a cached pool of genuine answers. The per-answer fingerprint stays genuine (the
// pool content once came out of the real model), so replay is invisible to the N=1 scoring;
// it shows up only when answers are compared with each other and with past reports.
//
// Check 1 (within-lane): every challenge asks for ~292–332 of the integers 1..355, so each
// answer misses a few dozen values. Two independently generated answers disagree on ~71
// missing values (median over genuine lanes on file; p95 ≈ 164). A replay reshuffles order
// and line breaks but keeps the pool's candidate set, so the missing sets nearly coincide.
// A lone pair below DIFF_LIMIT does occur in genuine lanes (observed once across the archived
// genuine lanes), so the suspect line is MIN_PAIRS pairs; one exact multiset match (same
// numbers, same repetition counts) is stronger still and suffices alone.
//
// Check 2 (cross-run): the pool outlives one test. Every answer's multiset and missing set
// are hashed and compared against the station's older reports (reports/<host>-*/raw.json);
// a hit also timestamps the pool's first appearance. The current run is not on disk yet when
// this runs during a live test (writeReport happens after the lanes); callers that re-judge
// saved reports must pass excludeRun so a report does not match itself.

import fs from 'node:fs';
import path from 'node:path';
import { parseNumbers, VALUE_MIN, VALUE_MAX } from './fingerprint-core.mjs';

export const DIFF_LIMIT = 20;
export const MIN_PAIRS = 2;
const MIN_NUMBERS = 80; // same ballpark as isValidAnswer; shorter texts carry too little set signal

/** Host directory prefix, shared by writeReport and the cross-run scan. */
export function hostOf(base) {
  return base.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
}

/** Signatures of one answer's number list: which values are missing, and the full multiset. */
export function signature(text) {
  const numbers = parseNumbers(text || '');
  if (numbers.length < MIN_NUMBERS) return null;
  const present = new Set(numbers);
  const missing = [];
  for (let v = VALUE_MIN; v <= VALUE_MAX; v++) if (!present.has(v)) missing.push(v);
  const counts = new Map();
  for (const n of numbers) counts.set(n, (counts.get(n) || 0) + 1);
  const multisetKey = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => (c > 1 ? `${v}x${c}` : `${v}`)).join(',');
  return { missingSet: new Set(missing), missingKey: missing.join(','), multisetKey };
}

function symDiffSize(a, b) {
  let d = 0;
  for (const v of a) if (!b.has(v)) d++;
  for (const v of b) if (!a.has(v)) d++;
  return d;
}

/**
 * Pairwise comparison of the valid answers of one lane.
 * answers: [{ index?, text, assessment? }] — entries without a valid assessment are skipped.
 * Returns { checked, pairs: [{ a, b, diff, exact }], exact_pairs, involved: [answer indices] }.
 */
export function withinLaneReuse(answers) {
  const items = [];
  answers.forEach((a, i) => {
    if (a.assessment && !a.assessment.valid) return;
    const s = signature(a.text);
    if (s) items.push({ index: a.index ?? i, ...s });
  });
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const diff = symDiffSize(items[i].missingSet, items[j].missingSet);
      if (diff < DIFF_LIMIT) pairs.push({ a: items[i].index, b: items[j].index, diff, exact: items[i].multisetKey === items[j].multisetKey });
    }
  }
  return {
    checked: items.length,
    pairs,
    exact_pairs: pairs.filter(p => p.exact).length,
    involved: [...new Set(pairs.flatMap(p => [p.a, p.b]))].sort((x, y) => x - y),
  };
}

/** True when the within-lane result crosses the suspicious line. */
export const reuseSuspect = (r) => r.pairs.length >= MIN_PAIRS || r.exact_pairs >= 1;

/**
 * Compare one lane's answers against every older report of the same station.
 * answers: lane answers (valid ones only are checked). Returns { scanned_runs, hits } where
 * hits = [{ index, level: 'multiset' | 'missing', run, label, run_index }] — 'multiset' is a
 * byte-level content replay (same numbers, same counts); 'missing' is the same candidate set
 * with a reshuffle. excludeRun skips one report directory (the run being re-judged).
 * null when there is no history to scan.
 */
export function crossRunReuse(answers, { reportsDir, host, maxRuns = 200, excludeRun = null } = {}) {
  if (!reportsDir || !host || !fs.existsSync(reportsDir)) return null;
  const dirs = fs.readdirSync(reportsDir)
    .filter(d => d.startsWith(`${host}-`) && d !== excludeRun && fs.existsSync(path.join(reportsDir, d, 'raw.json')))
    .sort()
    .slice(-maxRuns);
  if (!dirs.length) return null;
  const multisets = new Map();
  const missingSets = new Map();
  for (const run of dirs) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(reportsDir, run, 'raw.json'), 'utf8')); } catch { continue; }
    for (const lane of raw.lanes || []) {
      for (const c of lane.answers || lane.challenges || []) {
        const s = signature(c.text);
        if (!s) continue;
        const rec = { run, label: lane.label, run_index: c.index };
        if (!multisets.has(s.multisetKey)) multisets.set(s.multisetKey, rec);
        if (!missingSets.has(s.missingKey)) missingSets.set(s.missingKey, rec);
      }
    }
  }
  const hits = [];
  for (const a of answers) {
    if (a.assessment && !a.assessment.valid) continue;
    const s = signature(a.text);
    if (!s) continue;
    const m = multisets.get(s.multisetKey);
    if (m) hits.push({ index: a.index, level: 'multiset', ...m });
    else {
      const q = missingSets.get(s.missingKey);
      if (q) hits.push({ index: a.index, level: 'missing', ...q });
    }
  }
  return { scanned_runs: dirs.length, hits };
}
