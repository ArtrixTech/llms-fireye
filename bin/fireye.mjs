#!/usr/bin/env node
// llms-fireye — relay authenticity tester (fingerprint attribution for API relays).
// Tests ONE station; fans out per-model lanes in parallel with a concurrency cap.

import { loadBank, bankSummary, bankCovers } from '../lib/bank.mjs';
import { detectTransport, MASK } from '../lib/transport.mjs';
import { injectionProbe, harnessProbe, matchHarness } from '../lib/probes.mjs';
import { runLane, verdictOf } from '../lib/runner.mjs';
import { writeReport } from '../lib/report.mjs';
import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const base = arg('base') || process.env.FIREYE_BASE;
const key = arg('key') || process.env.FIREYE_KEY;
const models = String(arg('models', '')).split(',').map(s => s.trim()).filter(Boolean);
const rounds = Number(arg('rounds', 3));
const concurrency = Number(arg('concurrency', 2));
const delayMs = Number(arg('delay-ms', 0));
const effort = String(arg('effort', 'medium'));
const outDir = String(arg('out', 'reports'));
const maxRequests = Number(arg('max-requests', 300));
const timeoutMs = Number(arg('timeout-ms', 120000));
const bankPath = arg('bank') || undefined;
const yes = !!arg('yes');

if (!base || !key || !models.length) {
  console.error(`Usage: node bin/fireye.mjs --base https://relay.example --key sk-... --models claude-opus-5-5,gpt-5.6 \\
  [--rounds 3] [--concurrency 2] [--delay-ms 0] [--effort medium] [--format auto] [--timeout-ms 120000] \\
  [--max-requests 300] [--out reports] [--bank path] [--yes]`);
  process.exit(1);
}

console.log(`llms-fireye: ${base} key=${MASK(key)} models=[${models.join(', ')}] rounds=${rounds} concurrency=${concurrency}`);

const bank = await loadBank({ bankPath, log: console.error });
const bankInfo = bankSummary(bank);
console.error(`bank: ${bankInfo.models} models ${JSON.stringify(bankInfo.families)}`);

const estimate = models.length * (2 + rounds * 3);
if (estimate > maxRequests && !yes) {
  console.error(`estimated ${estimate} requests > max-requests ${maxRequests}. Use --yes to override.`);
  process.exit(1);
}

// Lanes: sequential within a lane (rounds), lanes in parallel, HTTP calls gated by a global semaphore.
function makeSemaphore(n) {
  let active = 0; const queue = [];
  const release = () => { active = Math.max(0, active - 1); const nx = queue.shift(); if (nx) { active++; nx(); } };
  return async (fn) => { if (active >= n) await new Promise(res => queue.push(res)); else active++; try { return await fn(); } finally { release(); } };
}
const semaphore = makeSemaphore(concurrency);

const lanes = await Promise.all(models.map(async (label) => {
  const log = (m) => console.log(`  [${label}] ${m}`);
  const det = await detectTransport({ base, key, model: label, effort, timeoutMs, log });
  if (det.fatal) {
    log(`transport fatal [${det.probe?.status}] ${(det.probe?.error || '').slice(0, 120)}`);
    return { label, ctx: { format: det.format, thinkingMode: det.thinkingMode }, probe: { status: det.probe?.status, input_tokens: det.probe?.input, error: det.probe?.error }, rounds: [], pooled: null, stats: { requests: 1, ok: 0, empty: 0, errors: 1, latencies: [], statuses: {} }, verdict: { verdict: 'INCONCLUSIVE', reason: `transport fatal: ${det.probe?.status}` } };
  }
  const ctx = { base, key, format: det.format, model: label, effort, thinkingMode: det.thinkingMode, timeoutMs, bank };

  const probe = await injectionProbe(ctx, label);
  log(`injection probe: ${probe.status} input=${probe.input_tokens}`);
  const harness = await harnessProbe(ctx, label);
  log(`harness probe: ${harness.status} input=${harness.input_tokens}`);
  const harness_hits = matchHarness(harness.self_report, harness.self_report);

  const lane = await runLane({ label, ctx: { ...ctx, maxTokens: 16384 }, rounds, delayMs, semaphore, log });
  lane.probe = probe;
  lane.harness = harness;
  lane.harness_hits = harness_hits;
  lane.ctx = { format: det.format, thinkingMode: det.thinkingMode };
  lane.verdict = verdictOf(lane, { bankCoversLabel: bankCovers(bank, label) });
  log(`verdict: ${lane.verdict.verdict} — ${lane.verdict.reason}`);
  return lane;
}));

// Lanes returned from runLane lack ctx/probe fields on the fatal path; normalize.
for (const lane of lanes) {
  lane.ctx ??= { format: 'anthropic', thinkingMode: '?' };
  lane.probe ??= null;
  lane.harness ??= null;
  lane.harness_hits ??= [];
  if (!lane.verdict) lane.verdict = verdictOf(lane, { bankCoversLabel: bankCovers(bank, lane.label) });
}

const dir = writeReport({ outDir, base, key, bankInfo, effort, concurrency, delayMs, lanes, meta: { notes: [] } });
console.log(`\nreport → ${dir}/report.md`);
for (const lane of lanes) {
  console.log(`${lane.label}: ${lane.verdict.verdict} — ${lane.verdict.reason}`);
}
