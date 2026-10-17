---
name: llms-fireye
description: >
  中转站/API relay 验货：判断站点卖的模型（如 claude-opus-5-5、gpt-5.6、glm-5.3）是不是真的、
  有没有掺便宜模型或开源模型。当用户要测试中转站、验证模型真假、怀疑掺水/降智/换型号、
  或新买了 API key 想验货时使用。需要 base URL 和 key。
version: 0.3.0
---

# llms-fireye — 中转站验货

```bash
node <本 skill 目录>/bin/fireye.mjs --base https://relay.example --key sk-xxxx --models claude-opus-5-5,gpt-5.6-sol
```

- 默认自动加测：先 9 条，结果清楚就停，不清楚加测到 18 / 30 条；每条另配一条很短的复述请求（用量计数检查）
- `--depth quick`：固定 9 条；`--depth deep`：固定 30 条，用于排除低比例掺水
- `--no-token-check`：关掉复述请求（站点限流、或按请求次数计费时）
- `--concurrency N`：全站并发上限（默认 8），站点 429 时调低
- `--format anthropic|openai|openai-responses`：模型名不是 claude 却走 Anthropic 端点时要指定
- key 可走环境变量 `FIREYE_KEY`

## 读结果

`reports/<host>-<时间>/report.md`：

| 结论 | 含义 | 对用户怎么说 |
|---|---|---|
| ✅ 未发现掺水 | 回答都像声称的模型 | 附上报告里"掺水比例 ≥X% 时有 95% 把握发现"——不是"保证没掺" |
| 🟠 发现可疑回答 | 明显不像的条数（k），或更像别的模型的条数（j），超出真模型的正常波动；或复述测试的输出 token 数有 ≥2 次和其余不一致；或发现缓存回放（同车道 ≥2 对回答候选集几乎相同 / 与历史报告完全相同） | 说清几条、像谁；建议 deep 模式或换时段复测。只因用量计数判可疑时，说明这项检查还没有真实数据验证误报率。缓存回放时逐条指纹可能全像真模型，以复用证据为准 |
| ❌ 不是声称的模型 | 多数回答像别的模型 | 说出实际像谁 |
| ⚪ 无法判定 | 有效回答不足 3 条 | 多为限流、空响应、鉴权失败，看报告"其他"行 |
| ⚪ 无法核实 | 指纹库没有这个模型 | 只能说它像谁 |

模型自报身份不作证据。方法与准确度：[docs/METHODOLOGY.md](docs/METHODOLOGY.md)；判假后的人工溯源：[docs/FORENSICS.md](docs/FORENSICS.md)。

## 证据卫生

- key 一律掩码，raw.json 不含全 key；raw.json 保留全部回答原文
- 只测用户自己拥有 key 的站点
