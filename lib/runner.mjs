// Lane runner: one claimed model label → N fingerprint challenges (plus one echo probe per
// challenge for the token-count check) fired in parallel under a global semaphore. Each answer
// is scored as soon as it arrives. In auto mode the lane runs in looks (9 → 18 → 30 answers)
// and stops as soon as the result is clear.

import { generateChallenges } from './challenges.mjs';
import { rawCall } from './transport.mjs';
import { parseNumbers } from './fingerprint-core.mjs';
import { assessAnswer, judge, DEPTHS, AUTO_LOOKS } from './attribution.mjs';
import { loadTokenTable, probeRecord, tokenCheck } from './tokens.mjs';
import { crossRunReuse } from './reuse.mjs';

export { DEPTHS, AUTO_LOOKS };

export function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export function makeSemaphore(n) {
  let active = 0;
  const queue = [];
  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  return async (fn) => {
    if (active >= n) await new Promise(res => queue.push(res));
    else active++;
    try { return await fn(); } finally { release(); }
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/**
 * After an auto look: extend while the result is still open. Stop when it is already
 * suspicious, or when every answer looks like the label and every token count agrees.
 * Returns the reason to extend, or null to stop.
 */
export function extendReason(result) {
  if (result.verdict === 'INCONCLUSIVE') return '有效回答不够';
  if (result.verdict !== 'CLEAN') return null;
  const t = result.tokens;
  if (result.j > 0) return `${result.j} 条更像别的模型`;
  if (t?.status === 'ok' && t.deviants > 0) return `${t.deviants} 次用量计数不一致`;
  if (result.reuse?.pairs.length) return `${result.reuse.pairs.length} 对回答候选集几乎相同`;
  return null;
}

/**
 * label: relay model name; labelModel: bank entry (or null if not enrolled).
 * samples: answers for a fixed-size run; auto: run the AUTO_LOOKS schedule instead.
 * tokenProbes: also send one echo probe per answer (token-count check).
 * history: { dir, host } — scan older reports of the same station for replays of this lane's
 *   answers (cross-run reuse check); skipped when omitted.
 * onEvent({ type: 'answer' | 'probe' | 'look', ... }).
 */
export async function runLane({ label, labelModel, ctx, samples, auto = false, tokenProbes = true, semaphore, retries = 2, history = null, onEvent = () => {} }) {
  const stats = { requests: 0, ok: 0, empty: 0, errors: 0, latencies: [], statuses: {}, probe_requests: 0 };
  const looks = auto ? AUTO_LOOKS : [samples];
  const challenges = generateChallenges(looks.at(-1));
  const table = tokenProbes ? loadTokenTable() : null;
  const plannedN = looks.at(-1);
  let done = 0;
  let target = looks[0];
  const t0 = Date.now();

  const answerOne = async (index) => {
    const ch = challenges[index];
    let res = null;
    let ms = null;
    let lastStatus = 'FAIL';
    for (let attempt = 0; attempt <= retries; attempt++) {
      const s0 = Date.now();
      res = await semaphore(() => rawCall({ ...ctx, prompt: ch.prompt, maxTokens: ctx.maxTokens || 16384 }));
      ms = Date.now() - s0;
      stats.requests++;
      stats.latencies.push(ms);
      stats.statuses[res.status] = (stats.statuses[res.status] || 0) + 1;
      if (res.ok && res.text && res.text.length > 200) { stats.ok++; break; }
      if (res.ok) stats.empty++; else stats.errors++;
      const status = res.status;
      lastStatus = status;
      res = null;
      // 429 / 5xx: back off harder so a rate-limited station recovers.
      if (attempt < retries) await sleep(status === 429 ? 10000 : 2500 * (attempt + 1));
    }
    const text = res?.text || '';
    const answer = {
      index, expected_count: ch.expected_count, text,
      status: res?.status ?? lastStatus, latency_ms: ms,
      parsed_numbers: parseNumbers(text).length,
      input_tokens: res?.input ?? null, output_tokens: res?.output ?? null,
    };
    answer.assessment = text ? assessAnswer(answer, labelModel, ctx.bank, plannedN) : { valid: false };
    done++;
    onEvent({ type: 'answer', label, index, done, total: target, ok: !!text, status: answer.status, latency_ms: ms, parsed_numbers: answer.parsed_numbers, assessment: answer.assessment });
    return answer;
  };

  // Echo probe: short, thinking explicitly off ('off'; falls back to omitting the parameter for
  // the rest of the lane when the relay rejects it); one retry on transport errors only.
  let probeMode = ctx.format === 'openai-responses' ? 'none' : 'off';
  const probeOne = async (index) => {
    let res = null;
    for (let tries = 0; tries < 2;) {
      let mode;
      res = await semaphore(() => { mode = probeMode; return rawCall({ ...ctx, prompt: table.prompt, maxTokens: 400, thinkingMode: mode }); });
      stats.probe_requests++;
      if (!res.ok && res.status === 400 && mode === 'off') { probeMode = 'none'; continue; }
      tries++;
      if (res.ok || [400, 401, 403, 404].includes(res.status) || tries >= 2) break;
      await sleep(res.status === 429 ? 10000 : 2500);
    }
    const rec = { index, ...probeRecord(res, table) };
    onEvent({ type: 'probe', label, index, ...rec });
    return rec;
  };

  const answers = [];
  const probes = [];
  const lookLog = [];
  let result;
  let from = 0;
  for (let li = 0; li < looks.length; li++) {
    target = looks[li];
    const batch = range(from, target);
    const [a, p] = await Promise.all([Promise.all(batch.map(answerOne)), table ? Promise.all(batch.map(probeOne)) : []]);
    answers.push(...a);
    probes.push(...p);
    from = target;
    const tokens = table ? tokenCheck(probes, labelModel?.id, table) : undefined;
    result = judge(answers, labelModel, ctx.bank, undefined, { look: auto ? li : undefined, tokens });
    if (!auto) break;
    const last = li === looks.length - 1;
    const reason = last || !labelModel ? null : extendReason(result);
    const entry = { n: answers.length, valid: result.n, k: result.k ?? null, j: result.j ?? null, verdict: result.verdict, next: reason ? looks[li + 1] : null, reason };
    lookLog.push(entry);
    onEvent({ type: 'look', label, look: li, ...entry });
    if (!reason) break;
  }
  if (auto) result.looks = lookLog;

  if (history && answers.length) {
    const cross = crossRunReuse(answers, { reportsDir: history.dir, host: history.host });
    if (cross && cross.hits.length) {
      result.cross_run = cross;
      const exact = cross.hits.filter(h => h.level === 'multiset');
      const line = `跨次复用：${cross.hits.length} 条回答在更早的报告里出现过（完全相同 ${exact.length} 条 · 候选集相同 ${cross.hits.length - exact.length} 条，扫描了 ${cross.scanned_runs} 次历史报告）`;
      if (exact.length && ['CLEAN', 'INCONCLUSIVE', 'UNVERIFIED'].includes(result.verdict)) {
        result = { ...result, verdict: 'SUSPECT', headline: '发现可疑回答（缓存回放）',
          why: [line, '和历史报告完全相同的多重集只能解释为缓存回放：站点在复用过去的回答', ...result.why.map(w => `答题指纹：${w}`), '建议换个时段复测，并留意耗时、排版是否突然变化'] };
      } else {
        result.why.push(line);
      }
    }
  }

  stats.wall_ms = Date.now() - t0;
  stats.p50_ms = percentile(stats.latencies, 0.5);
  stats.p95_ms = percentile(stats.latencies, 0.95);
  return { label, bank_id: labelModel?.id ?? null, family: labelModel?.family ?? null, mode: auto ? 'auto' : 'fixed', answers, probes, stats, result };
}
