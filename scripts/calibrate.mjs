#!/usr/bin/env node
// Calibrate the per-answer off-label test and measure false negatives with ground truth.
//
// Input: held-out banks from ModelTrace `research/fn_banks.py --lomo` (dir with fold{k}.json,
// fold{k}-test.jsonl, fold{k}-no-{model}.json). Every held-out answer is scored by a bank that
// never saw its prompt wrapper; for out-of-bank (OOB) cases the answering model is also removed
// from the bank.
//
// 1) per sample size n: pick tau minimising the dilution share detectable for OOB substitutes
//    (the case users fear most), tie-break on in-bank. eps(tau) = smoothed rate of genuine
//    answers with p_label < tau; d(tau) = rate for substituted answers, averaged over (S, L) pairs.
// 2) simulate relays (genuine / substitution / dilution at r; in-bank and OOB; open-weight
//    models posing as closed ones) through the real judge(). FN = CLEAN on a diluted relay.
//
// Usage: node scripts/calibrate.mjs /tmp/fn [--write] [--trials 20] [--sweep]
import fs from 'node:fs';
import path from 'node:path';
import { analyzeGlobalOutputs } from '../lib/fingerprint-core.mjs';
import { judge, binomTail, MAX_SAMPLES, FP_EACH } from '../lib/attribution.mjs';
import { DEPTHS } from '../lib/runner.mjs';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || '/tmp/fn';
const WRITE = args.includes('--write');
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TRIALS = opt('trials', 20);
const SIM_N = DEPTHS.quick;
const CLOSED = new Set(['gpt', 'claude']);

let seed = 20261012;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const score = (row, bank) => analyzeGlobalOutputs([row], bank).per_response[0];
const pc = (x) => `${(100 * x).toFixed(1)}%`.padStart(7);

// ---- score every held-out answer once ------------------------------------------------------
const folds = fs.readdirSync(dir).filter(f => /^fold\d+\.json$/.test(f)).map(f => +f.match(/\d+/)[0]).sort();
const F = [];
for (const k of folds) {
  const bank = readJSON(`fold${k}.json`);
  const rows = fs.readFileSync(path.join(dir, `fold${k}-test.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  for (const r of rows) r.post = score(r, bank);
  const oob = {};
  for (const m of bank.models.map(x => x.id)) {
    const f = `fold${k}-no-${m}.json`;
    if (!fs.existsSync(path.join(dir, f))) continue;
    const b2 = readJSON(f);
    oob[m] = { bank: b2, rows: rows.filter(r => r.source === m).map(r => ({ ...r, post: score(r, b2) })) };
  }
  F.push({ k, bank, rows, oob });
  console.error(`fold ${k}: scored ${rows.length} answers, ${Object.keys(oob).length} OOB banks`);
}
const bankFull = F[0].bank;
const fam = Object.fromEntries(bankFull.models.map(m => [m.id, m.family]));
const models = bankFull.models.map(m => m.id);
const group = (S, L) => `${CLOSED.has(fam[S]) ? 'closed' : 'open'}→${CLOSED.has(fam[L]) ? 'closed' : 'open'} ${fam[S] === fam[L] ? 'same-family' : 'cross-family'}`;

// ---- per-answer p_label for genuine and substituted answers ---------------------------------
const genuineP = F.flatMap(f => f.rows.map(r => r.post.probabilities[r.source]));
const merged = {};
// ps: p_label per substituted answer; dr: whether its best match is not the label (drifted).
const addPair = (S, L, oob, rows) => { const key = `${oob ? '[OOB] ' : ''}${S} → ${L}`; const m = (merged[key] ||= { key, S, L, oob, same: fam[S] === fam[L], ps: [], dr: [] }); for (const r of rows) { m.ps.push(r.post.probabilities[L]); m.dr.push(r.post.prediction !== L); } };
for (const f of F) {
  for (const S of models) for (const L of models) if (S !== L) addPair(S, L, false, f.rows.filter(r => r.source === S));
  for (const [S, o] of Object.entries(f.oob)) for (const L of o.bank.models.map(m => m.id)) addPair(S, L, true, o.rows);
}
const pairList = Object.values(merged);
const hasOob = pairList.some(p => p.oob);

const TAUS = Array.from({ length: 40 }, (_, i) => 10 ** (-6 + i * 0.15)); // 1e-6 … ~0.7
const SHARE_NS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 35, 41];
const A = 20; // shrinkage weight of the pooled genuine flag rate in per-model eps
const genuineBy = {}, driftBy = {};
for (const f of F) for (const r of f.rows) {
  (genuineBy[r.source] ||= []).push(r.post.probabilities[r.source]);
  (driftBy[r.source] ||= []).push(r.post.prediction !== r.source);
}
// Genuine drift rate (best match is another model), per label, shrunk toward the pooled rate.
const driftAll = Object.values(driftBy).flat();
const driftPooled = (driftAll.filter(Boolean).length + 1) / (driftAll.length + 2);
const driftEps = Object.fromEntries(models.map(m => { const d = driftBy[m] || []; return [m, (d.filter(Boolean).length + A * driftPooled) / (d.length + A)]; }));
const meanD = (tau, sel) => { const ds = pairList.filter(sel).map(p => p.ps.filter(x => x < tau).length / p.ps.length); return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null; };

// Genuine flag rates differ by model (confusable neighbours flag more), so false positives and
// detection are binomial mixtures over models / (S, L) pairs, not a single averaged binomial.
function point(tau) {
  const pooled = (genuineP.filter(p => p < tau).length + 1) / (genuineP.length + 2);
  const epsBy = Object.fromEntries(models.map(m => { const ps = genuineBy[m] || []; return [m, (ps.filter(p => p < tau).length + A * pooled) / (ps.length + A)]; }));
  // Per answer: h = off-label (p_label < tau), s = drifted but not off-label.
  const pd = pairList.map(p => {
    const h = p.ps.filter(x => x < tau).length / p.ps.length;
    const s = p.ps.filter((x, i) => x >= tau && p.dr[i]).length / p.ps.length;
    return { L: p.L, S: p.S, oob: p.oob, same: p.same, openAsClosed: !CLOSED.has(fam[p.S]) && CLOSED.has(fam[p.L]), d: h, s, eps: epsBy[p.L], epsS: Math.max(0, driftEps[p.L] - epsBy[p.L]) };
  });
  return { tau, eps: pooled, epsBy, pd };
}
const kStarFor = (n, eps) => { for (let k = 1; k <= n; k++) if (binomTail(n, eps, k) <= FP_EACH) return k; return n + 1; };
// k* (off-label) and j* (drifted) per claimed label, each at half the 2% FP budget.
const kByLabel = (pt, n) => Object.fromEntries(models.map(m => [m, kStarFor(n, pt.epsBy[m])]));
const jByLabel = (n) => Object.fromEntries(models.map(m => [m, kStarFor(n, driftEps[m])]));
// Logs of factorials for the trinomial (off-label a, drifted-only b-a, clean n-b).
const LF = [0]; for (let i = 1; i <= 200; i++) LF[i] = LF[i - 1] + Math.log(i);
const lg = (x, c) => (c === 0 ? 0 : x <= 0 ? -Infinity : c * Math.log(x));
/** P(lane flagged) = P(k >= k* or j >= j*) with per-answer rates h (off-label) and s (drift only). */
function pFlag(n, h, s, kStar, jStar) {
  const z = Math.max(0, 1 - h - s);
  let miss = 0;
  for (let a = 0; a < Math.min(kStar, n + 1); a++) for (let b = a; b < Math.min(jStar, n + 1); b++) {
    miss += Math.exp(LF[n] - LF[a] - LF[b - a] - LF[n - b] + lg(h, a) + lg(s, b - a) + lg(z, n - b));
  }
  return Math.max(0, 1 - miss);
}
const fpAt = (pt, n, kBy, jBy) => models.reduce((s, m) => s + pFlag(n, pt.epsBy[m], Math.max(0, driftEps[m] - pt.epsBy[m]), kBy[m], jBy[m]), 0) / models.length;
const caught = (pt, n, kBy, r, sel, jBy = jByLabel(n)) => { const ps = pt.pd.filter(sel); return ps.reduce((s, p) => s + pFlag(n, r * p.d + (1 - r) * p.eps, r * p.s + (1 - r) * p.epsS, kBy[p.L], jBy[p.L]), 0) / ps.length; };
function shareAt(pt, n, k, sel) {
  if (caught(pt, n, k, 1, sel) < 0.95) return null;
  let lo = 0, hi = 1;
  for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (caught(pt, n, k, mid, sel) >= 0.95) hi = mid; else lo = mid; }
  return Math.ceil(hi * 100) / 100;
}
const SEL = { in_bank: p => !p.oob, oob: p => p.oob, open_as_closed: p => !p.oob && p.openAsClosed, oob_open_as_closed: p => p.oob && p.openAsClosed };
const points = TAUS.map(point);
console.error('tau grid scored');
const RS = [0.1, 0.25, 0.5, 1];

const byN = {};
let prev = null;
for (let n = 3; n <= MAX_SAMPLES; n++) {
  if (SHARE_NS.includes(n)) {
    let best = null;
    for (const pt of points) {
      const k = kByLabel(pt, n);
      // Objective: mean detection over dilution 25% and 50%, in-bank and out-of-bank alike.
      const sels = hasOob ? [SEL.in_bank, SEL.oob] : [SEL.in_bank];
      const score = sels.reduce((s, sel) => s + caught(pt, n, k, 0.25, sel) + caught(pt, n, k, 0.5, sel), 0) / (2 * sels.length);
      if (!best || score > best.score) best = { pt, k, score };
    }
    const { pt, k } = best;
    const detect = Object.fromEntries(Object.entries(SEL).map(([name, sel]) => [name, pt.pd.some(sel) ? pt.pd.filter(sel).reduce((s, p) => s + p.d, 0) / pt.pd.filter(sel).length : null]));
    detect.same_family = meanD(pt.tau, p => !p.oob && p.same);
    detect.oob_same_family = hasOob ? meanD(pt.tau, p => p.oob && p.same) : null;
    const caughtAt = Object.fromEntries(Object.entries(SEL).filter(([, sel]) => pt.pd.some(sel)).map(([name, sel]) => [name, RS.map(r => +caught(pt, n, k, r, sel).toFixed(4))]));
    const j = jByLabel(n);
    prev = { tau: pt.tau, eps: pt.eps, eps_by_label: Object.fromEntries(Object.entries(pt.epsBy).map(([m, e]) => [m, +e.toFixed(5)])), k_star_by_label: k, j_star_by_label: j,
      share_by_label: Object.fromEntries(models.map(L => [L, { in_bank: shareAt(pt, n, k, p => !p.oob && p.L === L), oob: hasOob ? shareAt(pt, n, k, p => p.oob && p.L === L) : null }])), fp: +fpAt(pt, n, k, j).toFixed(4), detect, caught_at_r: RS, caught: caughtAt,
      detectable_share: { in_bank: shareAt(pt, n, k, SEL.in_bank), oob: hasOob ? shareAt(pt, n, k, SEL.oob) : null } };
    byN[n] = prev;
  } else {
    // Between grid points: keep the previous tau and shares (conservative), recompute k* for this n.
    const pt = points.find(p => p.tau === prev.tau);
    const k = kByLabel(pt, n);
    const j = jByLabel(n);
    byN[n] = { ...prev, k_star_by_label: k, j_star_by_label: j, fp: +fpAt(pt, n, k, j).toFixed(4) };
  }
}
const cal = {
  bank_models: [...models].sort(),
  note: 'per sample size n; held-out prompt wrappers (fold banks). Re-run after every bank rebuild.',
  genuine_answers: genuineP.length,
  drift: { eps: +driftPooled.toFixed(5), eps_by_label: Object.fromEntries(models.map(m => [m, +driftEps[m].toFixed(5)])) },
  by_n: byN,
  created_at: new Date().toISOString(),
};
console.log(`genuine answers ${genuineP.length}, pairs in-bank ${pairList.filter(p => !p.oob).length}, OOB ${pairList.filter(p => p.oob).length}`);
console.log('\nn   tau      k*(min-max) FP     d_in  d_same d_oob d_oobS open→closed(in/oob) | share in/oob');
for (const n of [3, 6, 9, 12, 20, 30, 41]) {
  const o = byN[n], d = o.detect, f = (x) => (x == null ? '  -  ' : x.toFixed(2));
  const ks = Object.values(o.k_star_by_label);
  console.log(`${String(n).padEnd(3)} ${o.tau.toExponential(1)}  ${Math.min(...ks)}-${Math.max(...ks)}        ${pc(o.fp)} ${f(d.in_bank)}  ${f(d.same_family)}   ${f(d.oob)}  ${f(d.oob_same_family)}  ${f(d.open_as_closed)}/${f(d.oob_open_as_closed)}          | ${o.detectable_share.in_bank ?? '-'}/${o.detectable_share.oob ?? '-'}`);
}

// ---- relay simulation through judge() ----------------------------------------------------------
function simulate(f, L, S, r, n, oob) {
  const g = f.rows.filter(x => x.source === L).slice();
  const s = S ? (oob ? f.oob[S].rows : f.rows.filter(x => x.source === S)).slice() : [];
  const take = (p) => p.splice(Math.floor(rand() * p.length), 1)[0];
  const bank = oob ? f.oob[S].bank : f.bank;
  const answers = [];
  let subs = 0;
  for (let i = 0; i < n; i++) {
    const fromSub = S && s.length && rand() < r;
    const row = fromSub ? take(s) : take(g);
    if (!row) break;
    subs += !!fromSub;
    const p = row.post;
    answers.push({ text: row.text, expected_count: row.expected_count, assessment: { valid: true, like: p.prediction, like_family: p.family, like_p: p.probability, p_label: p.probabilities[L] } });
  }
  return { verdict: judge(answers, bank.models.find(m => m.id === L), bank, cal).verdict, subs };
}
const stats = {};
const add = (key, res) => { const s = stats[key] ||= { n: 0, cleanSub: 0, sub: 0 }; s.n++; s[res.verdict] = (s[res.verdict] || 0) + 1; if (res.subs) { s.sub++; s.cleanSub += res.verdict === 'CLEAN'; } };
const worst = {};
for (const f of F) {
  for (const L of models) {
    for (let t = 0; t < TRIALS; t++) add('genuine', simulate(f, L, null, 0, SIM_N, false));
    for (const S of models) {
      if (S === L) continue;
      for (const r of [1, 0.5, 0.25]) for (let t = 0; t < Math.ceil(TRIALS / 5); t++) {
        const res = simulate(f, L, S, r, SIM_N, false);
        add(`in-bank ${group(S, L)} r=${r}`, res);
        if (r === 1) { const w = worst[`${S} → ${L}`] ||= { n: 0, clean: 0 }; w.n++; w.clean += res.verdict === 'CLEAN'; }
      }
    }
  }
  for (const S of Object.keys(f.oob)) for (const L of f.oob[S].bank.models.map(m => m.id)) {
    for (const r of [1, 0.5]) for (let t = 0; t < Math.ceil(TRIALS / 5); t++) {
      const res = simulate(f, L, S, r, SIM_N, true);
      add(`OOB ${group(S, L)} r=${r}`, res);
      if (r === 1) { const w = worst[`[OOB] ${S} → ${L}`] ||= { n: 0, clean: 0 }; w.n++; w.clean += res.verdict === 'CLEAN'; }
    }
  }
}
console.log(`\nrelay simulation, n=${SIM_N} answers. FN = CLEAN on a diluted relay; "CLEAN|sub" = CLEAN although ≥1 substituted answer was drawn`);
console.log('scenario'.padEnd(44), 'trials', '  CLEAN', 'SUSPECT', 'MISMATCH', 'CLEAN|sub');
for (const [k, s] of Object.entries(stats).sort()) {
  console.log(k.padEnd(44), String(s.n).padStart(6), pc((s.CLEAN || 0) / s.n), pc((s.SUSPECT || 0) / s.n), pc((s.MISMATCH || 0) / s.n).padStart(8), s.sub ? pc(s.cleanSub / s.sub).padStart(9) : '        -');
}
console.log('\nP(caught) by mixture over (substitute, label) pairs, r = 10% / 25% / 50% / 100%:');
for (const n of [SIM_N, DEPTHS.deep]) {
  const o = byN[n];
  const line = (name) => (o.caught[name] ? `${name} ${o.caught[name].map(pc).join('')}` : '');
  const ks = Object.values(o.k_star_by_label);
  const js = Object.values(o.j_star_by_label);
  console.log(`  n=${n} k*=${Math.min(...ks)}-${Math.max(...ks)} j*=${Math.min(...js)}-${Math.max(...js)} genuine-FP ${pc(o.fp)} | ${['in_bank', 'oob', 'open_as_closed', 'oob_open_as_closed'].map(line).filter(Boolean).join(' | ')}`);
}
console.log('\nworst full substitutions at n=9 (share judged CLEAN):');
Object.entries(worst).filter(([, w]) => w.clean).sort((a, b) => b[1].clean / b[1].n - a[1].clean / a[1].n).slice(0, 20)
  .forEach(([k, w]) => console.log('  ', pc(w.clean / w.n), k));

if (WRITE) {
  fs.writeFileSync(new URL('../lib/calibration.json', import.meta.url), JSON.stringify(cal, null, 1) + '\n');
  console.log('\nwrote lib/calibration.json');
}
