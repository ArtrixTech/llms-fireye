// Lane runner: one claimed model label → N fingerprint challenges fired in parallel (global
// semaphore), each answer scored as soon as it arrives, then the lane verdict.

import { generateChallenges } from './challenges.mjs';
import { rawCall } from './transport.mjs';
import { parseNumbers } from './fingerprint-core.mjs';
import { assessAnswer, judge, DEPTHS } from './attribution.mjs';

export { DEPTHS };

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

/**
 * label: relay model name; labelModel: bank entry (or null if not enrolled).
 * onEvent({ type: 'answer', index, done, total, ok, status, assessment, latency_ms }).
 */
export async function runLane({ label, labelModel, ctx, samples, semaphore, retries = 2, onEvent = () => {} }) {
  const stats = { requests: 0, ok: 0, empty: 0, errors: 0, latencies: [], statuses: {} };
  const challenges = generateChallenges(samples);
  let done = 0;
  const t0 = Date.now();

  const answers = await Promise.all(challenges.map(async (ch, index) => {
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
    answer.assessment = text ? assessAnswer(answer, labelModel, ctx.bank, samples) : { valid: false };
    done++;
    onEvent({ type: 'answer', label, index, done, total: samples, ok: !!text, status: answer.status, latency_ms: ms, parsed_numbers: answer.parsed_numbers, assessment: answer.assessment });
    return answer;
  }));

  stats.wall_ms = Date.now() - t0;
  stats.p50_ms = percentile(stats.latencies, 0.5);
  stats.p95_ms = percentile(stats.latencies, 0.95);
  const result = judge(answers, labelModel, ctx.bank);
  return { label, bank_id: labelModel?.id ?? null, family: labelModel?.family ?? null, answers, stats, result };
}
