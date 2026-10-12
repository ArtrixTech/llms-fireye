# Architecture

## Components

- **CLI `bin/fireye.mjs`**：参数（`--depth quick|deep` / `--samples`）、成本护栏、每个模型一条 lane、`--events` 输出机器可读进度（`@@fireye {json}`），最后写报告。
- **传输 `lib/transport.mjs`**：OpenAI chat / Responses / Anthropic 三种格式；thinking 参数阶梯自动探测（同时用这次 "hi" 的 input_tokens 估算隐藏提示词）；超时、鉴权、限流直接判为连接失败。
- **lane 运行 `lib/runner.mjs`**：一次生成 N 道题，全部经全局信号量并行发出；空响应 / 报错重试（429 退避更久）；每条回答一到就逐条比对并回调进度。
- **判定 `lib/attribution.mjs`**：方法主线所在。`assessAnswer` 给出单条回答像谁、像标签的概率、是否"明显不像"（flagged）、是否"更像别的模型"（drifted）；`judge` 对两个计数 k、j 各做一次二项检验（各 1% 误报预算），给出 CLEAN / SUSPECT / MISMATCH / INCONCLUSIVE / UNVERIFIED 和人话理由；`detectableShare` 算"能排除的掺水比例"。阈值来自 `lib/calibration.json`。
- **标定 `lib/calibration.json`**：τ、ε、各类替换的检出率 d，由 `scripts/calibrate.mjs` 生成，绑定指纹库的模型清单（不一致时 CLI 警告）。
- **指纹库 `lib/bank.mjs`**：读子模块 `vendor/modeltrace/data/unified_bank.json`，缺失时下载 fork 的 raw 文件（24h 缓存）；`resolveLabel` 把站点模型名（厂商前缀、`:tag`、日期后缀、大小写）对到库内 id。
- **指纹核心 / 出题 `lib/fingerprint-core.mjs`、`lib/challenges.mjs`**：re-export 子模块 `static/`；fork 额外给出每条回答的完整后验 `per_response[].probabilities`。
- **报告 `lib/report.mjs`**：report.md（结论表 + 每个模型的原因与逐条表 + 怎么读）和 raw.json（schema `fireye-report-v2`）。
- **pi 插件 `pi-extension/index.ts`**：`/fireye [quick|deep|N]`，spawn CLI（`--events`），实时逐条显示，结束后一页人话结论。
- **脚本**：`scripts/calibrate.mjs`（标定 + 有标准答案的漏判/误报模拟）、`scripts/replay-reports.mjs`（用当前阈值重判历史报告）。
- **fork 侧（`vendor/modeltrace`）**：`research/collect_ollama.py`（开源模型采集）、`rebuild_unified_bank.py`（闭源 + 开源合库）、`research/fn_banks.py`（分组留出与留一模型的模拟用库）。

## Key Relationships

- bin → transport（探测）→ runner（并行采样，逐条调 attribution.assessAnswer）→ attribution.judge → report。
- 判定只在 attribution 定义；report 与 pi 插件只渲染 `result.headline / why`，不自己推理。
- pi 插件只通过 CLI 子进程与事件流交互，key 经 `FIREYE_KEY` 环境变量传入。
