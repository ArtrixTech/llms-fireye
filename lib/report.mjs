// Report writer: a human-readable report.md + raw.json with every answer.

import fs from 'node:fs';
import path from 'node:path';
import { MASK } from './transport.mjs';
import { VERDICTS, FP_TARGET, POWER, operatingPoint } from './attribution.mjs';

const pct = (x) => (x == null ? '-' : x < 0.0001 ? '<0.01%' : `${(x * 100).toFixed(x < 0.01 ? 2 : 0)}%`);

export function renderReport({ base, key, bank, calibration, samples, lanes }) {
  const L = [];
  L.push('# fireye 验货报告', '');
  L.push(`站点 \`${base}\` · key \`${MASK(key)}\` · ${new Date().toISOString()} · 每个模型 ${samples} 条回答`, '');

  L.push('## 结论', '');
  L.push('| 模型 | 结论 | 说明 |', '|---|---|---|');
  for (const lane of lanes) {
    const v = VERDICTS[lane.result.verdict];
    L.push(`| ${lane.label} | ${v.icon} ${lane.result.headline} | ${lane.result.why[0]} |`);
  }
  L.push('');

  for (const lane of lanes) {
    const r = lane.result;
    const v = VERDICTS[r.verdict];
    L.push(`## ${lane.label} — ${v.icon} ${r.headline}`, '');
    for (const w of r.why) L.push(`- ${w}`);
    if (lane.label !== lane.bank_id && lane.bank_id) L.push(`- 按指纹库中的 \`${lane.bank_id}\` 核对`);
    L.push('');
    if (lane.answers.length) {
      L.push(`| # | 回答像谁 | 像${lane.bank_id ? '标签' : ''}的概率 | |`, '|---|---|---|---|');
      for (const a of lane.answers) {
        const s = a.assessment || {};
        const verdict = !a.text ? `无回答（${a.status}）` : !s.valid ? `数字太少（${a.parsed_numbers}/${a.expected_count}），不计入` : s.flagged ? '✗ 明显不像标签' : s.drifted ? '≈ 更像别的模型（单条不能排除标签）' : lane.bank_id ? '✓' : '';
        L.push(`| ${a.index + 1} | ${s.valid ? `${s.like}（${pct(s.like_p)}）` : '-'} | ${s.p_label != null ? pct(s.p_label) : '-'} | ${verdict} |`);
      }
      L.push('');
    }
    const st = lane.stats;
    const t = lane.transport || {};
    L.push(`其他：请求 ${st.requests} 次（成功 ${st.ok} · 空响应 ${st.empty} · 报错 ${st.errors}）· 单次耗时中位 ${st.p50_ms != null ? (st.p50_ms / 1000).toFixed(0) + 's' : '-'}`
      + ` · 协议 ${t.format ?? '-'}/${t.thinking ?? '-'}`
      + ` · 隐藏提示词约 ${t.injection_estimate ?? '?'} token（发 "hi" 计费 ${t.probe_input_tokens ?? '?'} token；≈0 为直连，几千为套了 agent 外壳，按输入计费）`, '');
  }

  L.push('## 怎么读', '');
  L.push(`- 每条回答是一道"随手写几百个 1–355 的整数"的题。不同模型写数字的偏好不同，这个分布就是指纹。每条回答单独和指纹库（${bank.models} 个模型）比对，看它像谁。`);
  L.push(`- 真模型偶尔也会有个别回答判偏（${samples} 条时实测每条约 ${pct(operatingPoint(samples, calibration).eps)}）。判偏条数超出这个正常波动（误报率 ≤${FP_TARGET * 100}%）才算可疑。`);
  L.push(`- "未发现掺水"不等于"一条都没掺"：样本有限，只能排除较高比例的掺水，报告里给出了这个比例（${POWER * 100}% 把握）。要排除更低比例，用 \`--depth deep\`。`);
  L.push('- 指纹库外的模型冒充时，会被判成库里最像的模型，可能漏判。库里已有主流闭源与开源模型，名单见 raw.json 的 bank。');
  L.push('- 站点若能识别出测试题并专门转给真模型，任何指纹测试都测不出来。');
  return L.join('\n');
}

export function writeReport({ outDir, base, key, ...args }) {
  const host = base.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dir = path.join(outDir, `${host}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport({ base, key, ...args }));
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify({
    schema: 'fireye-report-v2', base, key_masked: MASK(key), samples: args.samples, concurrency: args.concurrency,
    effort: args.effort, bank: args.bank, calibration: args.calibration, lanes: args.lanes,
  }, null, 1));
  return dir;
}
