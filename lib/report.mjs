// Report writer: verdict table (markdown) + raw JSON evidence.

import fs from 'node:fs';
import path from 'node:path';
import { MASK } from './transport.mjs';
import { matchHarness } from './probes.mjs';

const VERDICT_ICON = { PASS: '✅', LIKELY: '🟢', FAMILY_MATCH: '🟡', SUSPECT: '🟠', FAIL: '❌', INCONCLUSIVE: '⚪', LIMITED: '⚪' };

export function renderReport({ base, key, bankInfo, effort, concurrency, delayMs, lanes, meta }) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push(`# llms-fireye 指纹鉴定报告`);
  lines.push('');
  lines.push(`- **站点**: \`${base}\`  **key**: \`${MASK(key)}\``);
  lines.push(`- **时间**: ${now}  **effort**: ${effort}  **并发**: ${concurrency}  **间隔**: ${delayMs}ms`);
  lines.push(`- **指纹库**: ${bankInfo.models} 模型 ${JSON.stringify(bankInfo.families)}（来源 ModelTrace）`);
  if (meta?.notes?.length) lines.push(`- **备注**: ${meta.notes.join('; ')}`);
  lines.push('');
  lines.push('## 判定总表');
  lines.push('');
  lines.push('| 模型标签 | 格式/thinking | 注入估算 | 自报身份 | 合并归因 (9样本) | p | sim | 判定 | 依据 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const lane of lanes) {
    const inj = lane.probe?.injection_estimate ?? '?';
    const self = (lane.harness?.self_report || lane.probe?.self_report || '').replace(/\n+/g, ' ').slice(0, 60);
    const pooled = lane.pooled?.prediction ? `${lane.pooled.prediction} (${lane.pooled.used}/${lane.rounds.length * 3})` : '样本不足';
    const p = lane.pooled?.p ?? '-';
    const sim = lane.pooled?.top4?.[0]?.sim ?? '-';
    const v = lane.verdict;
    lines.push(`| ${lane.label} | ${lane.ctx.format}/${lane.ctx.thinkingMode} | ${inj} tok | ${self ? `"${self}"` : '-'} | ${pooled} | ${p} | ${sim} | ${VERDICT_ICON[v.verdict] || ''} **${v.verdict}** | ${v.reason} |`);
  }
  lines.push('');
  lines.push('## 判定规则');
  lines.push('');
  lines.push('- **PASS** 合并归因 top1 = 标签且 p≥0.95，各轮一致');
  lines.push('- **LIKELY** top1 = 标签但 p<0.95 或各轮有漂移');
  lines.push('- **FAMILY_MATCH** 同家族不同型号（降级/换壳嫌疑）');
  lines.push('- **SUSPECT** 同家族但各轮 top1 不稳定（混池嫌疑）');
  lines.push('- **FAIL** 跨家族（行为指纹与标签不同族，冒充）');
  lines.push('- **INCONCLUSIVE / LIMITED** 有效样本不足 / 标签不在指纹库');
  lines.push('');
  lines.push('## 每轮明细');
  for (const lane of lanes) {
    lines.push('');
    lines.push(`### ${lane.label}`);
    lines.push('');
    lines.push(`- 可靠性: ${lane.stats.ok} ok / ${lane.stats.empty} empty / ${lane.stats.errors} error，共 ${lane.stats.requests} 请求；p50=${lane.stats.p50_ms}ms p95=${lane.stats.p95_ms}ms；状态码 ${JSON.stringify(lane.stats.statuses)}`);
    lines.push(`- 探针: hi→${lane.probe?.input_tokens ?? '?'} tok；身份问询→${lane.harness?.input_tokens ?? '?'} tok`);
    if (lane.harness_hits?.length) lines.push(`- harness 线索: ${lane.harness_hits.map(h => h.name).join(', ')}`);
    for (const rd of lane.rounds) {
      lines.push(`  - round ${rd.round}: ${rd.failed ? `FAIL（有效 ${rd.valid_samples ?? rd.used ?? 0}/3${rd.statuses ? '，状态 ' + rd.statuses.join('/') : ''}）` : `${rd.prediction} p=${rd.p} | ${rd.top3.map(t => `${t.m}:${t.p}`).join(' · ')}`}`);
    }
  }
  lines.push('');
  lines.push('> 指纹仅对库内模型归因；库外模型任何结果都可能。自报身份由注入词决定，只作线索不作结论。');
  return lines.join('\n');
}

export function writeReport({ outDir, base, ...args }) {
  const host = base.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dir = path.join(outDir, `${host}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const md = renderReport({ base, ...args });
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify({
    base: args.meta?.base, key_masked: MASK(args.key), effort: args.effort,
    concurrency: args.concurrency, delayMs: args.delayMs, bank: args.bankInfo,
    lanes: args.lanes,
  }, null, 1));
  return dir;
}

export { matchHarness };
