#!/usr/bin/env node
// Re-judge saved answers from past runs (reports/*/raw.json, v1 and v2 schema) with the current
// bank + calibration. Used as the in-the-wild false-positive check: channels that were
// independently known to be genuine must stay CLEAN.
// Usage: node scripts/replay-reports.mjs [reportsDir] [--answers]
import fs from 'node:fs';
import path from 'node:path';
import { loadBank, resolveLabel } from '../lib/bank.mjs';
import { assessAnswer, judge, VERDICTS, fmtCounts } from '../lib/attribution.mjs';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || 'reports';
const showAnswers = args.includes('--answers');
const bank = await loadBank({});

for (const run of fs.readdirSync(dir).sort()) {
  const f = path.join(dir, run, 'raw.json');
  if (!fs.existsSync(f)) continue;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const lane of raw.lanes || []) {
    const items = lane.answers || lane.challenges || [];
    if (!items.length) continue;
    const labelModel = resolveLabel(bank, lane.label);
    const answers = items.map(c => {
      const a = { text: c.text || '', expected_count: c.expected_count };
      a.assessment = a.text ? assessAnswer(a, labelModel, bank, items.length) : { valid: false };
      return a;
    });
    const r = judge(answers, labelModel, bank);
    const old = lane.verdict?.verdict ?? lane.result?.verdict ?? '-';
    console.log(`${run.padEnd(42)} ${lane.label.padEnd(26)} old ${old.padEnd(13)} new ${VERDICTS[r.verdict].icon} ${r.verdict.padEnd(12)} n=${r.n} k=${r.k ?? '-'}/${r.k_star ?? '-'} j=${r.j ?? '-'}/${r.j_star ?? '-'}  ${fmtCounts(r.like_counts)}`);
    if (showAnswers) answers.forEach((a, i) => a.assessment.valid && console.log(`      #${i + 1} like ${a.assessment.like} p_label=${a.assessment.p_label?.toExponential(2)}`));
  }
}
