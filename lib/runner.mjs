// Lane runner: N rounds × 3 challenges per model label, with a global concurrency
// semaphore (some stations cap concurrent requests), retry on empty/5xx, latency stats.

import { generateChallenges } from './challenges.mjs';
import { rawCall } from './transport.mjs';
import { parseNumbers, analyzeGlobalOutputs } from './fingerprint-core.mjs';

export function familyOf(label) {
  if (/gpt|o[134](-|$)|chatgpt/i.test(label)) return 'gpt';
  if (/claude|opus|sonnet|haiku/i.test(label)) return 'claude';
  if (/gemini/i.test(label)) return 'gemini';
  if (/grok/i.test(label)) return 'grok';
  if (/deepseek/i.test(label)) return 'deepseek';
  return 'unknown';
}

export function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function makeSemaphore(n) {
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

export async function runLane({ label, ctx, rounds = 3, retries = 2, delayMs = 0, semaphore, log = () => {} }) {
  const lane = {
    label,
    family: familyOf(label),
    rounds: [],
    challenges: [],
    stats: { requests: 0, ok: 0, empty: 0, errors: 0, latencies: [], statuses: {} },
  };
  const t0 = Date.now();

  for (let round = 0; round < rounds; round++) {
    const challenges = generateChallenges(3);
    const roundValid = [];
    for (const ch of challenges) {
      let res = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (delayMs) await sleep(delayMs);
        const s0 = Date.now();
        res = await semaphore(() => rawCall({ ...ctx, prompt: ch.prompt, maxTokens: ctx.maxTokens || 16384 }));
        const ms = Date.now() - s0;
        lane.stats.requests++;
        lane.stats.latencies.push(ms);
        lane.stats.statuses[res.status] = (lane.stats.statuses[res.status] || 0) + 1;
        if (res.ok && res.text && res.text.length > 200) { lane.stats.ok++; break; }
        if (res.ok) { lane.stats.empty++; } else { lane.stats.errors++; }
        res = null;
        await sleep(2500);
      }
      const text = res?.text || '';
      const parsed = parseNumbers(text).length;
      lane.challenges.push({
        label, round: round + 1, expected_count: ch.expected_count,
        ok: !!text, chars: text.length, parsed_numbers: parsed,
        input_tokens: res?.input ?? null, output_tokens: res?.output ?? null,
        status: res?.status ?? 'FAIL', latency_ms: res ? lane.stats.latencies[lane.stats.latencies.length - 1] : null,
        text,
      });
      roundValid.push({ text, expected_count: ch.expected_count });
    }
    const validCount = roundValid.filter(v => parseNumbers(v.text).length >= Math.max(80, Math.ceil(v.expected_count * 0.55))).length;
    if (validCount >= 2) {
      try {
        const a = analyzeGlobalOutputs(roundValid, ctx.bank);
        lane.rounds.push({
          round: round + 1, used: a.used_outputs,
          prediction: a.prediction_name, p: +a.probability.toPrecision(6), family: a.family_prediction_name,
          top3: a.results.slice(0, 3).map(r => ({ m: r.display_name, p: +r.probability.toPrecision(4), sim: +r.profile_similarity.toFixed(4) })),
        });
        log(`${label} round ${round + 1}: ${a.prediction_name} p=${a.probability.toPrecision(4)} (${a.used_outputs}/3)`);
      } catch (e) {
        lane.rounds.push({ round: round + 1, failed: true, error: e.message });
        log(`${label} round ${round + 1}: analysis failed — ${e.message}`);
      }
    } else {
      lane.rounds.push({ round: round + 1, failed: true, valid_samples: validCount });
      log(`${label} round ${round + 1}: FAILED (valid samples ${validCount}/3)`);
    }
  }

  // Pooled analysis across all rounds of this lane.
  const all = lane.challenges.map(c => ({ text: c.text, expected_count: c.expected_count }));
  const validN = all.filter(v => parseNumbers(v.text).length >= Math.max(80, Math.ceil(v.expected_count * 0.55))).length;
  if (validN >= 3) {
    try {
      const a = analyzeGlobalOutputs(all, ctx.bank);
      lane.pooled = {
        used: a.used_outputs, prediction: a.prediction_name, family: a.family_prediction_name,
        p: +a.probability.toPrecision(6),
        top4: a.results.slice(0, 4).map(r => ({ m: r.display_name, family: r.family, p: +r.probability.toPrecision(4), sim: +r.profile_similarity.toFixed(4) })),
        p_same_family_top: a.results.find(r => r.family === lane.family)?.p ?? null,
      };
    } catch (e) { lane.pooled = { error: e.message }; }
  }
  lane.stats.wall_ms = Date.now() - t0;
  lane.stats.p50_ms = percentile(lane.stats.latencies, 0.5);
  lane.stats.p95_ms = percentile(lane.stats.latencies, 0.95);
  return lane;
}

export function verdictOf(lane, { bankCoversLabel }) {
  if (!bankCoversLabel) return { verdict: 'LIMITED', reason: 'label not in fingerprint bank; attribution only vs bank models' };
  if (!lane.pooled?.prediction) return { verdict: 'INCONCLUSIVE', reason: `valid samples ${lane.pooled?.used ?? 0} < 3` };
  const top = lane.pooled.top4[0];
  const labelFam = lane.family;
  const roundTops = lane.rounds.filter(r => r.prediction).map(r => r.prediction);
  const unstable = new Set(roundTops).size > 1;
  if (lane.pooled.prediction === lane.label) {
    if (unstable) return { verdict: 'LIKELY', reason: `pooled match but round tops vary: ${roundTops.join(', ')}` };
    if (lane.pooled.p >= 0.95) return { verdict: 'PASS', reason: `pooled p=${lane.pooled.p}` };
    return { verdict: 'LIKELY', reason: `pooled p=${lane.pooled.p}` };
  }
  if (top?.family === labelFam) {
    return unstable
      ? { verdict: 'SUSPECT', reason: `same family, unstable tops: ${roundTops.join(', ')}` }
      : { verdict: 'FAMILY_MATCH', reason: `same family, top=${top.m} p=${top.p} (可能是同门降级/换型号)` };
  }
  return { verdict: 'FAIL', reason: `family mismatch: label=${labelFam}, behavior=${top?.family} (${top?.m} p=${top?.p})` };
}
