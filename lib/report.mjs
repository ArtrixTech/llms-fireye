// Report writer: a human-readable report.md + raw.json with every answer.

import fs from 'node:fs';
import path from 'node:path';
import { MASK } from './transport.mjs';
import { VERDICTS, FP_TARGET, POWER, AUTO_LOOKS, operatingPoint } from './attribution.mjs';
import { stripText, histogram, histogramLines, shapeNote } from './likeness.mjs';
import { hostOf } from './reuse.mjs';

const pct = (x) => (x == null ? '-' : x < 0.0001 ? '<0.01%' : `${(x * 100).toFixed(x < 0.01 ? 2 : 0)}%`);

/** "How much like the label": send-order strip + histogram against genuine answers. */
function likenessBlock(answers, cal, labelId) {
  const s = stripText(answers);
  const h = histogram(answers, cal, labelId);
  if (!h.n) return [];
  const L = ['像标签的程度（每条回答像标签的概率）：', '', '```'];
  L.push(`按发送顺序  ${s.bars}`);
  if (s.marks) L.push(`            ${s.marks}`);
  L.push('            █ ≥90%  ▆ 50–90%  ▄ 10–50%  ▂ 0.1–10%  ▁ <0.1%  ✗ 明显不像  ≈ 更像别的模型  · 无效', '');
  L.push(`${''.padEnd(8)}${'本次'.padEnd(26)}${h.ref ? `真模型参考（${h.ref.pooled ? '全库平均' : `${labelId} 的 ${h.ref.n} 条留出回答`}，按 ${h.n} 条折算）` : ''}`);
  L.push(...histogramLines(h));
  L.push('```');
  const note = shapeNote(h);
  if (note) L.push('', `形状：${note}`);
  L.push('');
  return L;
}

export function renderReport({ base, key, bank, calibration, samples, auto, lanes }) {
  const L = [];
  L.push('# fireye 验货报告', '');
  L.push(`站点 \`${base}\` · key \`${MASK(key)}\` · ${new Date().toISOString()} · 每个模型 ${auto ? `自动加测（${AUTO_LOOKS.join(' → ')} 条，结果清楚就停）` : `${samples} 条回答`}`, '');

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
    if (r.looks?.length) L.push(`- 自动加测：${r.looks.map(x => `${x.n} 条（${x.next ? `${x.reason}，加测到 ${x.next}` : '停止'}）`).join(' → ')}`);
    if (r.reuse?.pairs?.length) {
      L.push(`- 复用检查明细：${r.reuse.pairs.length} 对回答的候选数字集几乎相同（缺失数字对称差 <20，真模型通常差约 71）`
        + (r.reuse.exact_pairs ? `，其中 ${r.reuse.exact_pairs} 对连重复次数都完全相同` : '')
        + `，涉及 ${r.reuse.involved.length} 条：${r.reuse.involved.map(i => `#${i + 1}`).join('、')}`);
    }
    if (r.cross_run?.hits?.length) {
      const exact = r.cross_run.hits.filter(h => h.level === 'multiset');
      L.push(`- 跨次复用明细：${r.cross_run.hits.length} 条回答在更早的报告里出现过（完全相同 ${exact.length} 条 · 候选集相同 ${r.cross_run.hits.length - exact.length} 条）`);
      for (const h of r.cross_run.hits.slice(0, 5)) L.push(`  - #${h.index + 1} = ${h.run} 的 ${h.label} 第 ${h.run_index + 1} 条（${h.level === 'multiset' ? '完全相同' : '候选集相同'}）`);
    }
    L.push('');
    if (lane.answers.length && lane.bank_id) L.push(...likenessBlock(lane.answers, calibration, lane.bank_id));
    if (lane.answers.length) {
      L.push(`| # | 回答像谁 | 像${lane.bank_id ? '标签' : ''}的概率 | |`, '|---|---|---|---|');
      for (const a of lane.answers) {
        const s = a.assessment || {};
        const verdict = !a.text ? `无回答（${a.status}）` : !s.valid ? `数字太少（${a.parsed_numbers}/${a.expected_count}），不计入` : s.flagged ? '✗ 明显不像标签' : s.drifted ? '≈ 更像别的模型（单条不能排除标签）' : lane.bank_id ? '✓' : '';
        L.push(`| ${a.index + 1} | ${s.valid ? `${s.like}（${pct(s.like_p)}）` : '-'} | ${s.p_label != null ? pct(s.p_label) : '-'} | ${verdict} |`);
      }
      L.push('');
    }
    const probes = lane.probes || [];
    if (probes.length) {
      const hist = {};
      const bad = {};
      for (const p of probes) if (p.count != null) hist[p.count] = (hist[p.count] || 0) + 1; else bad[p.why] = (bad[p.why] || 0) + 1;
      const WHY = { error: '报错', not_verbatim: '没有原样复述', no_usage: '没返回用量', thinking: '带思考且无法分离思考 token' };
      L.push(`复述测试（用量计数）：${probes.length} 次，可用 ${probes.length - Object.values(bad).reduce((a, b) => a + b, 0)} 次`
        + (Object.keys(hist).length ? `；输出 token 数 ${Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join('，')}` : '')
        + (Object.keys(bad).length ? `；不可用：${Object.entries(bad).map(([w, n]) => `${WHY[w] ?? w} ${n}`).join('，')}` : ''), '');
    }
    const st = lane.stats;
    const t = lane.transport || {};
    L.push(`其他：答题请求 ${st.requests} 次（成功 ${st.ok} · 空响应 ${st.empty} · 报错 ${st.errors}）${st.probe_requests ? ` + 复述 ${st.probe_requests} 次` : ''}· 单次耗时中位 ${st.p50_ms != null ? (st.p50_ms / 1000).toFixed(0) + 's' : '-'}`
      + ` · 协议 ${t.format ?? '-'}/${t.thinking ?? '-'}`
      + ` · 隐藏提示词约 ${t.injection_estimate ?? '?'} token（发 "hi" 计费 ${t.probe_input_tokens ?? '?'} token；≈0 为直连，几千为套了 agent 外壳，按输入计费）`, '');
  }

  L.push('## 怎么读', '');
  L.push(`- 每条回答是一道"随手写几百个 1–355 的整数"的题。不同模型写数字的偏好不同，这个分布就是指纹。每条回答单独和指纹库（${bank.models} 个模型）比对，看它像谁。`);
  L.push(`- 真模型偶尔也会有个别回答判偏（${samples} 条时实测每条约 ${pct(operatingPoint(samples, calibration).eps)}）。判偏条数超出这个正常波动（误报率 ≤${FP_TARGET * 100}%）才算可疑。`);
  L.push(`- "未发现掺水"不等于"一条都没掺"：样本有限，只能排除较高比例的掺水，报告里给出了这个比例（${POWER * 100}% 把握）。要排除更低比例，用 \`--depth deep\` 或更多样本。`);
  L.push(`- 像标签的程度：条形按发送顺序排，看可疑回答是扎堆（某段时间、某一批并发换了后端）还是零散混在里面。直方图对比"真模型会给出的分布"，真模型多数回答在 ≥90% 一档；出现一小团明显偏低的回答是掺水的典型形状。这部分只用来观察，结论只看上面的计数。`);
  L.push('- 复述测试：让模型原样复述一段固定文字，看站点报的输出 token 数。同一个模型每次都一样；换成分词器不同的模型（别家模型、多数开源模型）数字就会变。中转站自己估算用量时这项无效，同一家族的模型互换也测不出。');
  L.push('- 复用检查：站点把真回答缓存成池、换着顺序回放时，逐条指纹测不出来（池内容本身像真模型）。真模型两条独立回答"缺哪些数字"差异很大（中位约 71 个数）；同一次测试里出现两对以上缺数几乎相同的回答，或某条回答与该站更早的报告完全相同，即判为缓存回放。');
  L.push('- 指纹库外的模型冒充时，会被判成库里最像的模型，可能漏判。库里已有主流闭源与开源模型，名单见 raw.json 的 bank。');
  L.push('- 站点若能识别出测试题并专门转给真模型，任何指纹测试都测不出来。');
  return L.join('\n');
}

export function writeReport({ outDir, base, key, ...args }) {
  const host = hostOf(base);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dir = path.join(outDir, `${host}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.md'), renderReport({ base, key, ...args }));
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify({
    schema: 'fireye-report-v3', base, key_masked: MASK(key), samples: args.samples, auto: !!args.auto, concurrency: args.concurrency,
    effort: args.effort, bank: args.bank, calibration: args.calibration, lanes: args.lanes,
  }, null, 1));
  return dir;
}
