---
name: llms-fireye
description: >
  中转站/API relay 验货工具（火眼金睛）：对单一中转站的不同模型标签做并行指纹鉴定，
  判断挂名的 opus/gpt 是否真身（PASS / FAMILY_MATCH / SUSPECT / FAIL），顺带测出注入
  尺寸、harness 套壳（Kiro/Claude Code 等）与可靠性。当用户要求测试某个中转站、验证
  模型真假、鉴别套壳/降智、跑模型指纹（ModelTrace 方法论）、或新买了一个 API key 想
  验货时使用。需要用户提供 base URL 和 key。
version: 0.1.0
---

# llms-fireye — 中转站模型指纹鉴定

对**一个**中转站（base URL + key）做多模型并行指纹测试。原理：给模型打"无语义整数选择"挑战（3 题一轮，每题要求输出约 300 个 1-355 的整数），把数字分布与统一指纹库（ModelTrace）做贝叶斯归因，鉴定标签模型是否真身。附产：注入尺寸测量、harness 识别、可靠性统计。

## 快速用法

```bash
node <本 skill 目录>/bin/fireye.mjs \
  --base https://hkg.example-relay.ai \
  --key sk-xxxx \
  --models claude-opus-5-5,gpt-5.6 \
  --rounds 3 --concurrency 2
```

- `--concurrency`：全局并发上限。有并发限制的站用 1-2，无限流的站可以开到模型数（每条 lane 内部串行，lane 之间并行）
- `--rounds 3`：每模型 3 轮 × 3 题 = 9 个样本（默认，置信度足够）
- `--delay-ms`：站上有机型 RPM 限制时加间隔
- `--format auto`：传输格式。auto 按模型名猜（claude/opus/sonnet/haiku → anthropic，其余 → openai）；anthropic 端点 + 非 claude 命名的模型（如 kimi）用 `--format anthropic` 强制
- `--effort medium`：thinking 档位（anthropic adaptive / openai reasoning_effort 自动适配，400 时自动沿参数阶梯降级）
- `--max-requests 300`：成本护栏，超了要 `--yes`
- key 也可走环境变量 `FIREYE_KEY` / `FIREYE_BASE`

## pi 插件

在 pi 里装了 `pi-extension/` 扩展后，对当前选中模型直接 `/fireye`（默认 1 轮）或 `/fireye 3`，结果在 overlay 窗口展示。安装见 README「pi 插件」一节。

## 读报告

输出在 `reports/<host>-<时间戳>/report.md`（判定总表）+ `raw.json`（全量证据）。判定含义：

| 判定 | 含义 |
|---|---|
| ✅ PASS | 归因 top1 = 标签，p≥0.95，各轮稳定，真身 |
| 🟢 LIKELY | 是标签模型但置信度不足或有轮次漂移 |
| 🟡 FAMILY_MATCH | 同家族不同型号（同门降级/换壳） |
| 🟠 SUSPECT | 同家族但各轮 top1 乱跳（混池嫌疑） |
| ❌ FAIL | 跨家族冒充（如标 Claude 实际 GPT 行为） |
| ⚪ INCONCLUSIVE / LIMITED | 样本不足 / 标签不在指纹库 |

**铁律：模型自报身份只作线索，永不作结论**（身份由注入词决定，实测见过注入词写什么就自称什么）。指纹库外的标签出任何结果都可能，标 LIMITED。

## 深度方法论（需要人工侦查时）

标准指纹测试之上的人工加深步骤——注入词溯源、harness 指认、面板侦查、渠道规律分析——见 [docs/METHODOLOGY.md](docs/METHODOLOGY.md)。

## 证据卫生

- key 一律掩码（`sk-xxxx…abcd`），报告和 raw.json 里不落全 key
- 原始输出落盘不裁剪（`raw.json` 的 `challenges[].text`）
- 结论必须带 p 值和相似度，单轮结果不下判定
