# devlog

## feat(core): llms-fireye relay authenticity toolkit

`(首提交，哈希后补)` | 2026-09-27

- **Changes**: 全量初始版本。lib/fingerprint-core.mjs + lib/challenges.mjs（vendor 自 ModelTrace，标出处）；lib/transport.mjs（双格式 + thinking 参数阶梯）；lib/probes.mjs（注入尺寸 + harness 脚本匹配）；lib/runner.mjs（并发信号量 lane、重试、轮次+合并归因、判定规则）；lib/report.mjs（report.md + raw.json，key 掩码）；bin/fireye.mjs（CLI，成本护栏）；SKILL.md / README / Architecture / docs/METHODOLOGY.md（完整方法论：侦查→token forensics→harness 指认→指纹→面板侦查→渠道规律）。
- **Reason**: 2026-09-27 对 某中转站 的 8 池实战方法论沉淀为可复用工具（用户需求：单站多 provider 并行鉴定，并发可调）。
- **User feedback**: "当前测试方法论帮我总结成一个可复用的未来测试其他中转站的skill……可以设置同时并行多少……发github repo（private）：llms-fireye"；后补充"除了官key。太贵了"（跨池测试阶段）。
- **Process**: 冒烟测试一次通过（某中转站 real endpoint，1 模型 1 轮：transport 自适应 adaptive、注入 7139 抓到、p=1.0、PASS）；OpenAI 分支以 rawCall 直测 200 通过。途中踩坑：write 工具对 `~` 路径的处理需核实落盘位置（本次实际落位正确）。
- **Result**: CLI 端到端可用；报告含判定总表/判定规则/轮次明细/可靠性统计。
- **Notes**: 指纹库 24h 缓存于 ~/.cache/llms-fireye/；上游 ModelTrace 若更新库，删缓存即刷新。adaptive thinking 是 5.x 世代接口特征，参数阶梯的 400 报错文本本身可作代际证据。
