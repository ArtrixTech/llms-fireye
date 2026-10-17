#!/usr/bin/env node
// Offline reuse scan over the archived reports: lists every lane with near-identical
// candidate sets (within-lane replay evidence) and demos the cross-run collision check.
// Usage: node scripts/scan-reuse.mjs  (run from the repo root; reads reports/*/raw.json)
import fs from 'node:fs';
import path from 'node:path';
import { withinLaneReuse, reuseSuspect, crossRunReuse } from '../lib/reuse.mjs';

const loadRaw = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const ROOT = 'reports';
const dirs = fs.readdirSync(ROOT).filter(d => fs.existsSync(path.join(ROOT, d, 'raw.json'))).sort();

console.log('== 基线：全部存档车道 within-lane pairs（按站点分组统计）==');
const byHost = {};
for (const run of dirs) {
  const raw = loadRaw(path.join(ROOT, run, 'raw.json'));
  if (!raw) continue;
  const host = run.replace(/-\d{4}-\d{2}-\d{2}.*/, '');
  for (const lane of raw.lanes || []) {
    const items = lane.answers || lane.challenges || [];
    const answers = items.map((c, i) => ({ index: c.index ?? i, text: c.text || '', assessment: { valid: (c.text || '').length > 200 } }));
    if (answers.length < 3) continue;
    const r = withinLaneReuse(answers);
    byHost[host] = byHost[host] || { lanes: 0, withPairs: 0, suspect: 0, maxPairs: 0 };
    byHost[host].lanes++;
    if (r.pairs.length) { byHost[host].withPairs++; byHost[host].maxPairs = Math.max(byHost[host].maxPairs, r.pairs.length); }
    if (reuseSuspect(r)) byHost[host].suspect++;
  }
}
for (const [h, s] of Object.entries(byHost)) console.log(`${h}: ${s.lanes} 车道, ${s.withPairs} 条有 pair, ${s.suspect} 条达 SUSPECT 线, 单车道最多 ${s.maxPairs} 对`);

console.log('');
console.log('== 跨次碰撞（排除自身）==');
for (const name of ['api.huanling.icu-2026-10-17-03-47', 'api.huanling.icu-2026-10-16-08-13']) {
  const raw = loadRaw(path.join(ROOT, name, 'raw.json'));
  const host = name.replace(/-\d{4}-\d{2}-\d{2}.*/, '');
  const answers = raw.lanes[0].answers.map(c => ({ index: c.index, text: c.text, assessment: { valid: true } }));
  const cross = crossRunReuse(answers, { reportsDir: ROOT, host, excludeRun: name });
  const exact = cross.hits.filter(h => h.level === 'multiset');
  console.log(`${name}: 扫描 ${cross.scanned_runs} 次历史, 命中 ${cross.hits.length} 条（完全相同 ${exact.length} · 候选集 ${cross.hits.length - exact.length}）`);
  for (const h of cross.hits.slice(0, 4)) console.log(`  #${h.index + 1} [${h.level}] = ${h.run} 第 ${h.run_index + 1} 条`);
}
