// Per-answer test of a claimed label + the lane verdict.
//
// Method in one line: every answer's number distribution is scored against the bank on its
// own (N=1 posterior); an answer is "off-label" when P(label | answer) < tau. Genuine answers
// are flagged with a small, measured rate eps; a channel is suspicious once the flagged count
// k reaches k*, the smallest count genuine noise reaches with probability <= 2% (binomial).
// A second count catches the softer signal: j = answers whose best match is not the label
// (p_label above tau, but some other model fits better). Genuine answers drift with their own
// measured rate; j >= j* is suspicious too. The 2% false-positive budget is split evenly
// between the two counts (k* and j* each at 1%), so a genuine channel trips either with <= 2%.
// A clean result reports the smallest dilution share caught with 95% probability.
//
// tau depends on the sample size n (few samples: a strict tau so a single flag is meaningful;
// many samples: a looser tau with k* = 2-3 catches more). Per-n tau / eps / k* and detection
// rates d come from lib/calibration.json (scripts/calibrate.mjs: held-out environments,
// ground-truth substitutions, in-bank and out-of-bank).

import fs from 'node:fs';
import { analyzeGlobalOutputs, parseNumbers } from './fingerprint-core.mjs';

export const FP_TARGET = 0.02;
/** Each of the two counts (off-label k, drifted j) gets half the false-positive budget. */
export const FP_EACH = FP_TARGET / 2;
export const POWER = 0.95;
export const MIN_VALID = 3;
export const MAX_SAMPLES = 41;
export const DEPTHS = { quick: 9, deep: 30 };

/** Human labels shared by the report and the pi overlay. */
export const VERDICTS = {
  CLEAN: { icon: '✅', zh: '未发现掺水', color: 'success' },
  SUSPECT: { icon: '🟠', zh: '发现可疑回答', color: 'warning' },
  MISMATCH: { icon: '❌', zh: '不是声称的模型', color: 'error' },
  INCONCLUSIVE: { icon: '⚪', zh: '无法判定', color: 'dim' },
  UNVERIFIED: { icon: '⚪', zh: '无法核实（库外模型）', color: 'dim' },
};

const CAL_FILE = new URL('./calibration.json', import.meta.url);
let calCache;
export function loadCalibration() {
  if (calCache) return calCache;
  calCache = fs.existsSync(CAL_FILE)
    ? JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'))
    // Conservative placeholder until calibrate.mjs has run against the current bank.
    : { placeholder: true, by_n: {}, fallback: { tau: 1e-3, eps: 0.01, detect: { in_bank: 0.8, oob: 0.5 } } };
  return calCache;
}

/**
 * Operating point for n answers of claimed label:
 * { tau, eps, k_star, drift_eps, j_star, detect, detectable_share }.
 */
export function operatingPoint(n, cal = loadCalibration(), labelId = null) {
  const keys = Object.keys(cal.by_n || {}).map(Number).sort((a, b) => a - b);
  const key = keys.filter(k => k <= n).pop() ?? keys[0];
  const op = key != null ? cal.by_n[key] : cal.fallback;
  const eps = op.eps_by_label?.[labelId] ?? op.eps;
  const driftEps = cal.drift?.eps_by_label?.[labelId] ?? cal.drift?.eps ?? 0.1;
  const exact = key === n;
  return {
    ...op, eps, drift_eps: driftEps,
    k_star: (exact && op.k_star_by_label?.[labelId]) || flagThreshold(n, eps),
    j_star: (exact && op.j_star_by_label?.[labelId]) || flagThreshold(n, driftEps),
  };
}

export const isValidAnswer = (a) =>
  parseNumbers(a.text || '').length >= Math.max(80, Math.ceil((a.expected_count || 0) * 0.55));

// ---- binomial helpers -------------------------------------------------------------------
const LOG_FACT = [0];
for (let i = 1; i <= 200; i++) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
const logChoose = (n, k) => LOG_FACT[n] - LOG_FACT[k] - LOG_FACT[n - k];
/** P(X >= k), X ~ Binom(n, q). */
export function binomTail(n, q, k) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i) + i * Math.log(q) + (n - i) * Math.log1p(-q));
  return Math.min(1, s);
}
/** Smallest flagged count that genuine noise (rate eps) reaches with probability <= FP_TARGET. */
export function flagThreshold(n, eps, fp = FP_EACH) {
  for (let k = 1; k <= n; k++) if (binomTail(n, eps, k) <= fp) return k;
  return n + 1;
}
/** Smallest dilution share caught with probability >= POWER given per-answer detection d. */
export function shareFor(n, eps, d, kStar = flagThreshold(n, eps)) {
  for (let r = 0.01; r <= 1.0001; r += 0.01) {
    if (binomTail(n, r * d + (1 - r) * eps, kStar) >= POWER) return Math.round(r * 100) / 100;
  }
  return null;
}
/** { in_bank, oob } dilution shares caught with 95% probability for this label at n answers. */
export function detectableShare(n, cal = loadCalibration(), labelId = null) {
  const op = operatingPoint(n, cal, labelId);
  if (op.share_by_label?.[labelId]) return op.share_by_label[labelId];
  if (op.detectable_share) return op.detectable_share;
  return { in_bank: shareFor(n, op.eps, op.detect.in_bank, op.k_star), oob: op.detect.oob != null ? shareFor(n, op.eps, op.detect.oob, op.k_star) : null };
}

// ---- per answer -------------------------------------------------------------------------
/**
 * Score one answer. labelModel is the bank entry for the claimed label (or null when the
 * label is not enrolled; then only "looks like" is reported). plannedN picks tau for the
 * live display; judge() re-applies tau for the number of answers actually obtained.
 */
export function assessAnswer(answer, labelModel, bank, plannedN = 9, cal = loadCalibration()) {
  if (!isValidAnswer(answer)) return { valid: false };
  const r = analyzeGlobalOutputs([answer], bank).per_response[0];
  const out = { valid: true, like: r.prediction, like_family: r.family, like_p: r.probability };
  if (labelModel) {
    out.p_label = r.probabilities[labelModel.id];
    out.p_label_family = r.family_probabilities[labelModel.family];
    out.flagged = out.p_label < operatingPoint(plannedN, cal).tau;
    out.drifted = r.prediction !== labelModel.id;
  }
  return out;
}

// ---- lane verdict -----------------------------------------------------------------------
const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
const topOf = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
const P = (x) => `${Math.round(x * 100)}%`;

/**
 * answers: [{ text, expected_count, assessment }]. Returns
 * { verdict: CLEAN|SUSPECT|MISMATCH|INCONCLUSIVE|UNVERIFIED, n, total, k, k_star, tau,
 *   like_counts, off_counts, pooled_like, detectable_share, headline, why[] }
 */
export function judge(answers, labelModel, bank, cal = loadCalibration()) {
  const valid = answers.filter(a => a.assessment?.valid);
  const n = valid.length;
  const likeCounts = tally(valid.map(a => a.assessment.like));
  const base = { n, total: answers.length, like_counts: likeCounts };
  if (n < MIN_VALID) {
    return { ...base, verdict: 'INCONCLUSIVE', headline: '无法判定', why: [`有效回答只有 ${n}/${answers.length} 条（至少要 ${MIN_VALID} 条），多为空响应、报错或数字太少`] };
  }
  const pooledLike = analyzeGlobalOutputs(valid, bank).prediction;
  if (!labelModel) {
    return {
      ...base, verdict: 'UNVERIFIED', pooled_like: pooledLike, headline: '无法核实（指纹库没有这个模型）',
      why: [`整体行为最像 ${pooledLike}`, `逐条: ${fmtCounts(likeCounts)}`],
    };
  }
  const op = operatingPoint(n, cal, labelModel.id);
  // Re-apply tau for the answers we actually got (some may have failed).
  for (const a of valid) a.assessment.flagged = a.assessment.p_label < op.tau;
  const flagged = valid.filter(a => a.assessment.flagged);
  const k = flagged.length;
  const kStar = op.k_star;
  const offCounts = tally(flagged.map(a => a.assessment.like));
  // Drifted: best match is another model (includes every off-label answer).
  for (const a of valid) a.assessment.drifted = a.assessment.like !== labelModel.id;
  const drifted = valid.filter(a => a.assessment.drifted);
  const j = drifted.length;
  const jStar = op.j_star;
  const driftCounts = tally(drifted.map(a => a.assessment.like));
  const share = detectableShare(n, cal, labelModel.id);
  const res = { ...base, k, k_star: kStar, j, j_star: jStar, tau: op.tau, off_counts: offCounts, drift_counts: driftCounts, pooled_like: pooledLike, detectable_share: share };
  // "Usual" drift for a genuine channel of this size: the 95th percentile of Binom(n, drift_eps).
  let usual = 0;
  while (usual < n && binomTail(n, op.drift_eps, usual + 1) > 0.05) usual++;
  const usualText = `真 ${labelModel.id} ${n} 条里通常最多 ${usual} 条更像别的模型`;
  const hard = k >= kStar, soft = j >= jStar;
  if ((hard || soft) && j > n / 2) {
    return { ...res, verdict: 'MISMATCH', headline: `不是 ${labelModel.id}`,
      why: [`${j}/${n} 条回答更像别的模型，大多像 ${topOf(driftCounts)}`, `逐条: ${fmtCounts(likeCounts)}`] };
  }
  if (hard) {
    return { ...res, verdict: 'SUSPECT', headline: '发现可疑回答（疑似掺水）',
      why: [`${k}/${n} 条回答明显不像 ${labelModel.id}：${fmtCounts(offCounts)}`,
        `真模型偶尔也会有个别回答判偏，但真模型出现 ≥${kStar} 条明显判偏的概率不到 ${FP_EACH * 100}%`,
        ...(j > k ? [`另有 ${j - k} 条更像别的模型（${usualText}）`] : []),
        '建议用 deep 模式或换个时段复测确认'] };
  }
  if (soft) {
    return { ...res, verdict: 'SUSPECT', headline: '发现可疑回答（偏离太多）',
      why: [`${j}/${n} 条回答更像别的模型：${fmtCounts(driftCounts)}`,
        `单条都不能排除 ${labelModel.id}，但${usualText}；出现 ≥${jStar} 条的概率不到 ${FP_EACH * 100}%`,
        '建议用 deep 模式或换个时段复测确认'] };
  }
  if (pooledLike !== labelModel.id) {
    return { ...res, verdict: 'SUSPECT', headline: `整体更像 ${pooledLike}`,
      why: [`单条看都不能排除 ${labelModel.id}，但合起来更像 ${pooledLike}`, `逐条: ${fmtCounts(likeCounts)}`] };
  }
  const why = [j ? `${n} 条有效回答中 ${n - j} 条像 ${labelModel.id}，${j} 条更像别的模型（${fmtCounts(driftCounts)}）` : `${n} 条有效回答都像 ${labelModel.id}`];
  if (j) why.push(`${usualText}，${j} 条${j > usual ? '偏多但还没到可疑线（≥' + jStar + ' 条）' : '在正常范围内'}${k ? `；其中 ${k} 条明显不像（可疑线 ≥${kStar} 条）` : ''}`);
  if (share.in_bank == null) why.push('样本太少，给不出可排除的掺水比例');
  else {
    why.push(`按这个样本量，有 ${POWER * 100}% 把握发现：掺入指纹库内模型 ≥${P(share.in_bank)}`
      + (share.oob != null ? `；掺入库外模型约 ≥${P(share.oob)}` : '；掺入库外模型时这个样本量还不够给出 95% 把握')
      + (n < DEPTHS.deep ? '。更低比例需要更多样本（deep 模式）' : ''));
  }
  return { ...res, verdict: 'CLEAN', headline: '未发现掺水', why };
}

export function fmtCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m}×${c}`).join('，');
}
