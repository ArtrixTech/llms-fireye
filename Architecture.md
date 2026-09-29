# Architecture

## Components

- **CLI 入口 `bin/fireye.mjs`**：参数解析、成本估算、lane 编排（每模型一条 lane，lane 内串行、lane 间并行）、最终汇总打印。
- **指纹核心 `lib/fingerprint-core.mjs`**：数字分布解析 + 统一指纹库贝叶斯归因（vendor 自 ModelTrace，见文件头出处）。
- **挑战生成 `lib/challenges.mjs`**：无语义整数选择挑战（3 题/轮，292-332 个数），移植自 ModelTrace，Node webcrypto。
- **传输层 `lib/transport.mjs`**：OpenAI 兼容 / Anthropic 原生双格式；thinking 参数阶梯（adaptive → enabled → none / effort → none）自动探测；统一响应形状；key 掩码工具。
- **探针 `lib/probes.mjs`**：注入尺寸测量（"hi" 的 input_tokens）、harness 识别（自报话术匹配已知套壳脚本表）。
- **lane 运行器 `lib/runner.mjs`**：轮次编排、空响应/5xx 重试、全局并发信号量、延迟分位数、每轮 + 合并归因、判定规则（PASS/LIKELY/FAMILY_MATCH/SUSPECT/FAIL/INCONCLUSIVE/LIMITED）。
- **指纹库加载 `lib/bank.mjs`**：从 ModelTrace GitHub Pages 下载 unified_bank.json，24h 本地缓存（~/.cache/llms-fireye/）。
- **报告 `lib/report.mjs`**：report.md（判定总表 + 判定规则 + 每轮明细）与 raw.json（全量证据，key 掩码）。
- **pi 插件 `pi-extension/index.ts`**：pi 扩展，`/fireye [rounds]` 命令（默认 1 轮）；从 model registry 解析当前模型的 base URL + key，spawn `bin/fireye.mjs`，单 overlay 窗口展示进度与判定。
- **方法论 `docs/METHODOLOGY.md`**：指纹测试之外的人工侦查手册（注入词溯源、面板侦查、渠道规律）。

## Key Relationships

- `bin/fireye.mjs` 调 transport（探测参数阶梯）→ probes（两个廉价探针）→ runner（指纹 lane）→ report（落盘）。
- `pi-extension/index.ts` 以子进程方式复用 `bin/fireye.mjs`，key 经 `FIREYE_KEY` env 传入。
- runner 是唯一消费 fingerprint-core 与 challenges 的组件；bank 经 ctx 注入 runner。
- 判定规则在 runner（verdictOf）定义，report 只渲染；harness 识别在 probes（matchHarness）定义，仅作报告线索。
