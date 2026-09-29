# devlog

## feat(core): implement --format transport override

`(哈希后补)` | 2026-09-29

- **Changes**: `bin/fireye.mjs` 解析并校验 `--format auto|anthropic|openai`（usage 早有声明，实现缺失），传入 `detectTransport`；`lib/transport.mjs` 的 detectTransport 接受 format 覆盖，auto 时维持模型名正则。SKILL.md 补 `--format` 说明。
- **Reason**: pi 插件需要按 `model.api` 传确切格式；kimi-coding 这类 anthropic 端点 + 非 claude 命名的模型靠名字正则会选错端点。
- **User feedback**: "别忘了过滤fireye不支持的模型"
- **Process**: 源码确认 `--format` 此前只出现在 usage 字符串。验证：`--format bogus` 被拒；`--format anthropic` 强制后 k3-256k 报告显示 `anthropic/none`（自动猜测会给 openai）。
- **Result**: `--format anthropic|openai` 生效；auto 默认行为不变。
- **Notes**: 覆盖只影响格式选择，thinking 参数阶梯照旧。

## fix(pi): resolve real extension path and filter unsupported model APIs

`(哈希后补)` | 2026-09-29

- **Changes**: `pi-extension/index.ts` 的 EXT_DIR 改经 `fs.realpathSync` 跟随软链（pi 经 `~/.pi/agent/extensions/fireye` 软链加载时 `__dirname` 是软链路径，REPO_ROOT 错算成 extensions 目录，spawn 报 MODULE_NOT_FOUND）；handler 预检 bin/fireye.mjs 存在性；按 `model.api` 白名单过滤（anthropic-messages→anthropic、openai-completions→openai，其余 API 类型 notify 并跳过），格式经 `--format` 显式传给 CLI。README 补支持范围。
- **Reason**: 用户实测 /fireye 在 kimi-coding/k3-256k 上报 MODULE_NOT_FOUND；并要求过滤 fireye 不支持的模型。
- **User feedback**: 贴出 k3-256k 上 MODULE_NOT_FOUND 窗口文本；"别忘了过滤fireye不支持的模型"。
- **Process**: 经软链路径 jiti 导入复现（spawn 路径变成 `~/.pi/agent/extensions/bin/fireye.mjs`）；修复后同路径复测全链路通过；过滤逻辑以 mock ctx 直调 handler 验证（openai-responses 被拒并提示，openai-completions 放行到 auth 阶段）。
- **Result**: 软链安装可用；不支持的模型给出明确提示；kimi 类 anthropic 端点模型可测。
- **Notes**: realpathSync 对直接路径安装是恒等操作。

## feat(pi): add /fireye extension for current-model fingerprint test

`0489fc8` | 2026-09-29

- **Changes**: 新增 `pi-extension/index.ts`：`/fireye [rounds]` 命令（默认 1 轮）；从 pi model registry 的 `getApiKeyAndHeaders(model)` 解析当前模型的 baseUrl + apiKey，baseUrl 去尾 `/vN` 适配 fireye 的 `/v1/*` 拼接；key 经 `FIREYE_KEY` env 传给子进程；spawn `bin/fireye.mjs`（concurrency=1），单 overlay 窗口实时日志 → 判定行 → 完整 report.md 滚动查看；Esc 运行中取消/结束后关闭；报告默认落 `reports/`，`FIREYE_PI_OUT` 可改。README/Architecture/SKILL 补插件说明。
- **Reason**: 快速对 pi 当前选中模型验货，省去手动拼 base URL 与 key。
- **User feedback**: "写个简单插件，在pi，快速为当前选择的模型做fireye测试，默认测一轮，通过/fireye调用。用一个窗口给结果。插件放到现有fireye仓库"
- **Process**: jiti 加载冒烟（registerCommand 断言通过）；FireyeOverlay 端到端冒烟：127.0.0.1:9 死端口 → transport fatal → INCONCLUSIVE 报告生成、渲染框、滚动键、Esc 关闭摘要均符合预期。途中修复：stripAnsi 写入时混入原始 ESC 字节，改为 `\x1b` 转义；完成摘要图标由固定 ✅ 改为按 verdict 词映射（✅🟢🟡🟠❌⚪）。
- **Result**: `/fireye` 在 pi TUI 可用；1 轮 = 3 题 + 2 探针，秒级出判定。
- **Notes**: `ResolvedRequestAuth.baseUrl` 已含模型级覆盖；overlay 宽 90%、高上限 85%，高宽自适应终端。安装：`ln -s ~/GitHub/llms-fireye/pi-extension ~/.pi/agent/extensions/fireye`。

## feat(core): llms-fireye relay authenticity toolkit

`ff5df6f` | 2026-09-27

- **Changes**: 全量初始版本。lib/fingerprint-core.mjs + lib/challenges.mjs（vendor 自 ModelTrace，标出处）；lib/transport.mjs（双格式 + thinking 参数阶梯）；lib/probes.mjs（注入尺寸 + harness 脚本匹配）；lib/runner.mjs（并发信号量 lane、重试、轮次+合并归因、判定规则）；lib/report.mjs（report.md + raw.json，key 掩码）；bin/fireye.mjs（CLI，成本护栏）；SKILL.md / README / Architecture / docs/METHODOLOGY.md（完整方法论：侦查→token forensics→harness 指认→指纹→面板侦查→渠道规律）。
- **Reason**: 2026-09-27 对 某中转站 的 8 池实战方法论沉淀为可复用工具（用户需求：单站多 provider 并行鉴定，并发可调）。
- **User feedback**: "当前测试方法论帮我总结成一个可复用的未来测试其他中转站的skill……可以设置同时并行多少……发github repo（private）：llms-fireye"；后补充"除了官key。太贵了"（跨池测试阶段）。
- **Process**: 冒烟测试一次通过（某中转站 real endpoint，1 模型 1 轮：transport 自适应 adaptive、注入 7139 抓到、p=1.0、PASS）；OpenAI 分支以 rawCall 直测 200 通过。途中踩坑：write 工具对 `~` 路径的处理需核实落盘位置（本次实际落位正确）。
- **Result**: CLI 端到端可用；报告含判定总表/判定规则/轮次明细/可靠性统计。
- **Notes**: 指纹库 24h 缓存于 ~/.cache/llms-fireye/；上游 ModelTrace 若更新库，删缓存即刷新。adaptive thinking 是 5.x 世代接口特征，参数阶梯的 400 报错文本本身可作代际证据。
