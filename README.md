# llms-fireye 🔥👀

中转站/API relay 验货工具：对单一站点做多模型并行指纹鉴定（火眼金睛），识别挂名模型真假、注入尺寸、harness 套壳与可靠性。

- **原理**：无语义整数选择挑战 → 数字分布 → 与 ModelTrace 统一指纹库贝叶斯归因
- **判定**：PASS / LIKELY / FAMILY_MATCH / SUSPECT / FAIL / INCONCLUSIVE / LIMITED
- **副产**：注入 token 测量（谁在为 7k 隐藏提示词买单）、harness 指认（Kiro / Claude Code / claude.ai 脚本匹配）、空响应与 5xx 可靠性统计
- **并发**：全局信号量可调，适配有/无并发限制的站点；lane（模型）间并行、lane 内串行

## 快速开始

```bash
node bin/fireye.mjs \
  --base https://relay.example.com \
  --key sk-xxxx \
  --models claude-opus-5-5,gpt-5.6 \
  --rounds 3 --concurrency 2
```

结果：`reports/<host>-<时间>/report.md`（判定总表）+ `raw.json`（全量证据）。

## 为什么可信

- 每模型 9 样本（3 轮 × 3 题），每轮独立归因 + 合并归因，双指标（p 值 + 分布相似度）
- 实测战绩：真池 9 样本 p≈1.0；假池跨家族识别（标 Claude 实为 GPT 系行为，p=0.995）；Kiro 套壳溯源到公开泄露提示词逐字吻合
- 模型自报身份一律只作线索——身份是注入词的台词，行为才是本体

## 文档

- [SKILL.md](SKILL.md) — agent 调用入口（触发词、用法、判定读法）
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md) — 深度方法论（注入溯源、面板侦查、渠道规律）
- [Architecture.md](Architecture.md) — 组件地图

## 致谢

指纹方法论与统一指纹库来自 [ModelTrace](https://github.com/xqy2006/ModelTrace)（xqy2006），`lib/fingerprint-core.mjs` 与挑战提示词 vendor 自上游并标注出处。

## 红线

仅用于测试自己拥有 key 的站点。key 掩码后才能进报告。
