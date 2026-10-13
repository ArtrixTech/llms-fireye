# llms-fireye 🔥👀

中转站验货：你买的 `claude-opus-5-5`，真的是 claude-opus-5-5 吗？有没有掺便宜模型？

fireye 向站点并行发一批无语义的"选数字"题，把每条回答的数字分布（行为指纹）和指纹库逐条比对；同时让模型原样复述一段固定文字，核对每次报的输出 token 数是否一致（换了分词器不同的模型就会变）。告诉你：

- ✅ **未发现掺水**，以及按这个样本量能排除多大比例的掺水
- 🟠 **发现可疑回答**：哪几条不像，像谁
- ❌ **不是声称的模型**：实际像谁
- ⚪ 无法判定 / 无法核实（库外模型，只报告像谁）

指纹库含闭源 GPT / Claude 系列 18 个和开源 GLM、Kimi、DeepSeek 5 个（MiniMax、Mistral、Nemotron、Gemma、gpt-oss 等采集中），用开源模型冒充闭源模型也能识别。方法与准确度见 [docs/METHODOLOGY.md](docs/METHODOLOGY.md)。

## 快速开始

指纹核心与指纹库来自 ModelTrace fork 子模块（`vendor/modeltrace`，[ArtrixTech/ModelTrace](https://github.com/ArtrixTech/ModelTrace) 的 `fireye` 分支）：

```bash
git clone --recursive https://github.com/ArtrixTech/llms-fireye.git   # 已克隆: git submodule update --init
```

```bash
node bin/fireye.mjs --base https://relay.example.com --key sk-xxxx \
  --models claude-opus-5-5,glm-5.3            # 自动：先 9 条，结果不清楚再加测到 18 / 30
node bin/fireye.mjs ... --depth quick          # 快速：固定 9 条
node bin/fireye.mjs ... --depth deep           # 深度：固定 30 条，能抓更低比例的掺水
```

- 请求全部并行发出，`--concurrency`（默认 8）是全站并发上限；站点限流时调低
- `--format auto|anthropic|openai|openai-responses`：默认按模型名猜（claude 系走 `/v1/messages`，其余走 `/v1/chat/completions`）
- `--samples N` 自定义条数（3–41）；`--max-requests` 成本护栏，超了要 `--yes`
- 每条回答配一条复述请求（很短）；站点限流时可用 `--no-token-check` 关掉
- key 也可用环境变量 `FIREYE_KEY` / `FIREYE_BASE`

结果在 `reports/<host>-<时间>/report.md`（给人看，含每条回答像标签程度的条形图和与真模型的分布对比）和 `raw.json`（全部回答原文）。

## pi 插件（/fireye）

```bash
ln -s ~/GitHub/llms-fireye/pi-extension ~/.pi/agent/extensions/fireye
```

- `/fireye` 测当前选中的模型（自动 9→18→30 条），`/fireye quick` 9 条，`/fireye deep` 30 条，`/fireye 15` 自定义
- 每收到一条回答就显示它像谁；结束后一页说明结论、原因和逐条结果，Tab 看完整报告，Esc 取消/关闭
- base URL 与 key 从 pi 的 model registry 取，key 经环境变量传给子进程
- 支持 `anthropic-messages`、`openai-completions`、`openai-responses` 三种 API

## 维护指纹库

```bash
# 采集开源模型参考数据（Ollama Cloud；断点续采）
cd vendor/modeltrace && OLLAMA_API_KEY=... python3 research/collect_ollama.py --models glm-5.3,kimi-k3
python3 rebuild_unified_bank.py
# 重新标定判定阈值并跑准确度模拟
OMP_NUM_THREADS=1 python3 research/fn_banks.py --out /tmp/fn --lomo
cd ../.. && node scripts/calibrate.mjs /tmp/fn --write
node scripts/replay-reports.mjs              # 用新阈值重判历史报告（真渠道应保持 ✅）
# 复述测试：重建公开分词器计数表（需要 tiktoken / tokenizers，见脚本头部）
HF_HUB_CACHE=/tmp/tokcache /tmp/tokvenv/bin/python scripts/tokenizer-table.py --write
# 从可信渠道（官方 API）的一次运行记录某个模型的复述计数；不要用被测的站点
node scripts/learn-tokens.mjs reports/<目录> --write
```

## 文档

- [docs/METHODOLOGY.md](docs/METHODOLOGY.md) — 方法、判定规则、准确度、局限
- [docs/FORENSICS.md](docs/FORENSICS.md) — 判假之后的人工溯源（注入大小、外壳指认、面板侦查）
- [SKILL.md](SKILL.md) — agent 调用入口
- [Architecture.md](Architecture.md) — 组件地图

## 致谢与红线

指纹方法与闭源参考数据来自 [ModelTrace](https://github.com/xqy2006/ModelTrace)（xqy2006）。仅测试自己拥有 key 的站点；报告里的 key 一律掩码。
