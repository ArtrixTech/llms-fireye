#!/usr/bin/env node
// llms-fireye — does this relay serve the model it claims, or a diluted mix?
// One station, one lane per claimed model label; every challenge fires in parallel under a
// global concurrency cap. See docs/METHODOLOGY.md.

import { loadBank, bankSummary, resolveLabel } from '../lib/bank.mjs';
import { detectTransport, MASK } from '../lib/transport.mjs';
import { runLane, makeSemaphore, DEPTHS, AUTO_LOOKS } from '../lib/runner.mjs';
import { VERDICTS, loadCalibration } from '../lib/attribution.mjs';
import { writeReport } from '../lib/report.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const base = arg('base') || process.env.FIREYE_BASE;
const key = arg('key') || process.env.FIREYE_KEY;
const models = String(arg('models', '')).split(',').map(s => s.trim()).filter(Boolean);
// --samples N fixes the size; otherwise --depth auto (default) | quick | deep.
const depth = arg('samples') ? 'fixed' : String(arg('depth', 'auto'));
const auto = depth === 'auto';
const samples = auto ? AUTO_LOOKS.at(-1) : Number(arg('samples', DEPTHS[depth] ?? NaN));
const tokenProbes = !arg('no-token-check');
const concurrency = Number(arg('concurrency', 8));
const effort = String(arg('effort', 'medium'));
const outDir = String(arg('out', 'reports'));
const maxRequests = Number(arg('max-requests', 300));
const timeoutMs = Number(arg('timeout-ms', 300000));
const bankPath = arg('bank') || undefined;
const yes = !!arg('yes');
const format = String(arg('format', 'auto'));
// --events: machine-readable progress lines ("@@fireye {json}") for the pi overlay.
const events = !!arg('events');

const usage = `Usage: node bin/fireye.mjs --base https://relay.example --key sk-... --models claude-opus-5-5,glm-5.3 \\
  [--depth auto|quick|deep] [--samples N] [--no-token-check] [--concurrency 8] [--format auto|anthropic|openai|openai-responses] \\
  [--effort medium] [--timeout-ms 300000] [--max-requests 300] [--out reports] [--bank path] [--events] [--yes]
  depth: auto=${AUTO_LOOKS.join('→')} answers (stops early when clear, default), quick=${DEPTHS.quick}, deep=${DEPTHS.deep}
  --samples N: fixed N answers (3-41). --no-token-check: skip the echo probes (one short request per answer)`;

if (!['auto', 'anthropic', 'openai', 'openai-responses'].includes(format)) { console.error(`invalid --format ${format}\n${usage}`); process.exit(1); }
if (!base || !key || !models.length || !(auto || DEPTHS[depth] || depth === 'fixed') || !(samples >= 3 && samples <= 41)) { console.error(usage); process.exit(1); }

const emit = (ev) => { if (events) console.log(`@@fireye ${JSON.stringify(ev)}`); };
const say = (s) => { if (!events) console.log(s); };

const bank = await loadBank({ bankPath, log: (m) => say(m) });
const cal = loadCalibration();
if (cal.placeholder) console.error('warning: lib/calibration.json missing — using conservative placeholder thresholds (run scripts/calibrate.mjs)');
else if (JSON.stringify(cal.bank_models) !== JSON.stringify(bank.models.map(m => m.id).sort())) console.error('warning: lib/calibration.json was made for a different bank model list — re-run scripts/calibrate.mjs');

const estimate = models.length * (samples * (tokenProbes ? 2 : 1) + 1);
if (estimate > maxRequests && !yes) { console.error(`estimated ${estimate} requests > --max-requests ${maxRequests}; add --yes`); process.exit(1); }

say(`fireye: ${base} key=${MASK(key)} · ${models.join(', ')} · ${auto ? `auto ${AUTO_LOOKS.join('→')}` : samples} answers each${tokenProbes ? ' + echo probes' : ''} · concurrency ${concurrency}`);
emit({ type: 'start', base, models, samples, auto, looks: auto ? AUTO_LOOKS : [samples], token_probes: tokenProbes, concurrency, bank_models: bank.models.length });

const semaphore = makeSemaphore(concurrency);

const lanes = await Promise.all(models.map(async (label) => {
  const labelModel = resolveLabel(bank, label);
  const log = (m) => say(`  [${label}] ${m}`);
  const det = await detectTransport({ base, key, model: label, effort, timeoutMs: 180000, format, log });
  const injection = typeof det.probe?.input === 'number' ? Math.max(0, det.probe.input - 10) : null;
  const transport = { format: det.format, thinking: det.thinkingMode, probe_input_tokens: det.probe?.input ?? null, injection_estimate: injection };
  emit({ type: 'lane', label, bank_id: labelModel?.id ?? null, transport, fatal: !!det.fatal, error: det.fatal ? `${det.probe?.status ?? ''} ${(det.probe?.error || '').slice(0, 160)}` : null });
  if (det.fatal) {
    const s = det.probe?.status;
    const reason = s === 'TIMEOUT' ? '站点 3 分钟内没有响应' : s === 'FETCH_ERROR' ? `连不上站点：${det.probe?.error ?? ''}`
      : s === 401 || s === 403 ? `鉴权失败（${s}）：key 无效或无权使用该模型` : s === 429 ? '被限流（429），稍后再试或降低并发'
      : `请求被拒（${s ?? '无响应'}）：${(det.probe?.error || '').slice(0, 120)}`;
    const lane = { label, bank_id: labelModel?.id ?? null, family: labelModel?.family ?? null, transport, answers: [], stats: { requests: 1, ok: 0, empty: 0, errors: 1, latencies: [], statuses: { [s ?? 'FAIL']: 1 } },
      result: { verdict: 'INCONCLUSIVE', n: 0, total: 0, headline: '无法判定', why: [reason] } };
    emit({ type: 'lane_done', label, result: lane.result });
    return lane;
  }
  if (!labelModel) log('label not in fingerprint bank: will report what it behaves like, not a verdict');
  const ctx = { base, key, format: det.format, model: label, effort, thinkingMode: det.thinkingMode, timeoutMs, bank, maxTokens: 16384 };
  const lane = await runLane({
    label, labelModel, ctx, samples, auto, tokenProbes, semaphore,
    onEvent: (ev) => {
      emit(ev);
      if (ev.type === 'look') { log(`look ${ev.n} answers: ${ev.verdict} k=${ev.k} j=${ev.j}${ev.next ? ` → extend to ${ev.next} (${ev.reason})` : ' → stop'}`); return; }
      if (ev.type === 'probe') { if (ev.count == null) log(`probe ${ev.index + 1}: unusable (${ev.why})`); return; }
      const a = ev.assessment;
      log(`${ev.done}/${ev.total} ${!ev.ok ? `no answer (${ev.status})` : !a.valid ? `too few numbers (${ev.parsed_numbers})` : `looks like ${a.like}${a.flagged ? '  ✗ off-label' : a.drifted ? '  ≈ drifted' : ''}`}`);
    },
  });
  lane.transport = transport;
  emit({ type: 'lane_done', label, result: lane.result });
  return lane;
}));

const dir = writeReport({ outDir, base, key, bank: bankSummary(bank), calibration: cal, samples, auto, concurrency, effort, lanes });
emit({ type: 'report', dir });
say(`\nreport → ${dir}/report.md`);
for (const lane of lanes) {
  const v = VERDICTS[lane.result.verdict];
  say(`${lane.label}: ${v.icon} ${lane.result.headline} — ${lane.result.why[0]}`);
}
