/**
 * llms-fireye pi extension — /fireye [auto|quick|deep|N]
 *
 * Tests whether the currently selected model (provider base URL + API key from pi's model
 * registry) is what it claims, or a diluted mix. Every answer is scored as it arrives and shown
 * live; the result page says in plain words what was found and how much dilution the sample
 * size could have caught.
 *
 *   /fireye        auto: 9 answers, extended to 18 and 30 only while the result is unclear
 *   /fireye quick  9 answers, all in parallel
 *   /fireye deep   30 answers (catches lower dilution rates)
 *   /fireye 15     custom answer count (3–41)
 * Every answer comes with a short echo probe (token-count check).
 *
 * Install:
 *   ln -s ~/GitHub/llms-fireye/pi-extension ~/.pi/agent/extensions/fireye
 * or add "/path/to/llms-fireye/pi-extension/index.ts" to settings.json "extensions".
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// pi loads this file through the ~/.pi/agent/extensions/fireye symlink, so
// resolve the real path before deriving repo-relative locations.
const EXT_DIR_RAW = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = fs.realpathSync(EXT_DIR_RAW);
const REPO_ROOT = path.resolve(EXT_DIR, "..");
const BIN = path.join(REPO_ROOT, "bin", "fireye.mjs");
const REPORTS_DIR = process.env.FIREYE_PI_OUT ?? path.join(REPO_ROOT, "reports");
const DEPTHS: Record<string, number> = { quick: 9, deep: 30 };
const AUTO_LOOKS = [9, 18, 30];
const MAX_CONCURRENCY = 10;
/** One answer may take up to 5 min and is retried twice. */
const ANSWER_BUDGET_MS = 3 * 5 * 60 * 1000;
const EVENT_PREFIX = "@@fireye ";

/** fireye's transport speaks exactly these API shapes. */
const API_TO_FORMAT: Record<string, string> = {
	"anthropic-messages": "anthropic",
	"openai-completions": "openai",
	"openai-responses": "openai-responses",
};

type Color = "success" | "warning" | "error" | "dim" | "text" | "accent";
const VERDICTS: Record<string, { icon: string; zh: string; color: Color }> = {
	CLEAN: { icon: "✅", zh: "未发现掺水", color: "success" },
	SUSPECT: { icon: "🟠", zh: "发现可疑回答", color: "warning" },
	MISMATCH: { icon: "❌", zh: "不是声称的模型", color: "error" },
	INCONCLUSIVE: { icon: "⚪", zh: "无法判定", color: "dim" },
	UNVERIFIED: { icon: "⚪", zh: "无法核实（库外模型）", color: "dim" },
};
const verdictOf = (v: string | undefined) => VERDICTS[v ?? ""] ?? { icon: "⚪", zh: v ?? "未知", color: "dim" as Color };

type RunState = "running" | "done" | "error" | "aborted";

interface RunTarget {
	base: string; // normalized: no trailing slash, no trailing /vN
	modelId: string;
	provider: string;
	samples: number;
	depthName: string;
	auto: boolean;
	format: string;
	apiKey: string;
	bankId: string | null;
}

interface Assessment {
	valid: boolean;
	like?: string;
	like_p?: number;
	p_label?: number;
	flagged?: boolean;
	drifted?: boolean;
}
interface AnswerEvent {
	index: number;
	done: number;
	total: number;
	ok: boolean;
	status: string | number;
	parsed_numbers: number;
	latency_ms: number | null;
	assessment: Assessment;
}
interface ProbeEvent {
	index: number;
	count: number | null;
	why?: string;
}
interface LookEvent {
	n: number;
	next: number | null;
	reason: string | null;
}
interface TokenResult {
	status: string;
	m: number;
	deviants?: number;
	mode?: number;
}
interface LaneResult {
	verdict: string;
	headline: string;
	why: string[];
	n: number;
	total: number;
	k?: number;
	k_star?: number;
	j?: number;
	j_star?: number;
	detectable_share?: number | null;
	tokens?: TokenResult;
	looks?: LookEvent[];
}
interface LaneInfo {
	transport?: { format: string; thinking: string; injection_estimate: number | null; probe_input_tokens: number | null };
	fatal?: boolean;
	error?: string | null;
}

interface BankModel {
	id: string;
	display_name?: string;
}
let libPromise: Promise<{ bank: { models: BankModel[] }; resolveLabel: (b: unknown, l: string) => BankModel | null }> | undefined;
/** Load the bank through the repo's own loader so name matching matches the CLI exactly. */
function getLib() {
	libPromise ??= import(pathToFileURL(path.join(REPO_ROOT, "lib", "bank.mjs")).href).then(async (m) => ({
		bank: await m.loadBank({}),
		resolveLabel: m.resolveLabel,
	}));
	return libPromise;
}

interface HistRow { label: string; count: number; expected: number | null }
interface Hist { n: number; ref: { n: number; pooled: boolean } | null; rows: HistRow[] }
interface Likeness {
	stripText: (answers: unknown[]) => { bars: string; marks: string };
	histogram: (answers: unknown[], cal: unknown, labelId: string) => Hist;
	histogramLines: (h: Hist, width?: number) => string[];
	shapeNote: (h: Hist) => string | null;
	cal: unknown;
}
let likenessPromise: Promise<Likeness> | undefined;
/** Same views as report.md (lib/likeness.mjs) with the genuine reference from calibration.json. */
function getLikeness() {
	likenessPromise ??= Promise.all([
		import(pathToFileURL(path.join(REPO_ROOT, "lib", "likeness.mjs")).href),
		import(pathToFileURL(path.join(REPO_ROOT, "lib", "attribution.mjs")).href),
	]).then(([m, a]) => ({ ...(m as Omit<Likeness, "cal">), cal: a.loadCalibration() }));
	return likenessPromise;
}

/** Strip ANSI escape sequences from child-process output before re-rendering. */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\(B/g, "");
}

const pct = (x: number | undefined | null) => (x == null ? "-" : `${Math.round(x * 100)}%`);

export function parseDepth(args: string | undefined): { samples: number; depthName: string; auto: boolean } {
	const a = (args ?? "").trim().toLowerCase();
	if (DEPTHS[a]) return { samples: DEPTHS[a], depthName: a === "deep" ? "深度" : "快速", auto: false };
	const n = Number.parseInt(a, 10);
	if (Number.isFinite(n) && n >= 3) return { samples: Math.min(n, 41), depthName: "自定义", auto: false };
	return { samples: AUTO_LOOKS[AUTO_LOOKS.length - 1], depthName: "自动", auto: true };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fireye", {
		description: "Fireye: is the current model genuine or diluted? (/fireye = auto 9→30 answers, quick = 9, deep = 30)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "auto", label: "auto — 先测 9 条，结果不清楚才加测到 18 / 30（默认）" },
				{ value: "quick", label: "quick — 9 条回答，几分钟" },
				{ value: "deep", label: "deep — 30 条回答，能抓更低比例的掺水" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("fireye: interactive TUI mode only", "error");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("fireye: no model selected", "error");
				return;
			}
			const format = API_TO_FORMAT[model.api as string];
			if (!format) {
				ctx.ui.notify(`fireye: ${model.provider}/${model.id} 的 API 类型 "${model.api}" 暂不支持。可测: anthropic-messages / openai-completions / openai-responses`, "error");
				return;
			}
			if (!fs.existsSync(BIN)) {
				ctx.ui.notify(`fireye: bin/fireye.mjs not found under ${REPO_ROOT}`, "error");
				return;
			}

			let bankId: string | null = null;
			try {
				const lib = await getLib();
				bankId = lib.resolveLabel(lib.bank, model.id)?.id ?? null;
			} catch (e) {
				ctx.ui.notify(`fireye: 指纹库加载失败: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(`fireye: auth failed for ${model.provider}: ${auth.error}`, "error");
				return;
			}
			if (!auth.apiKey) {
				ctx.ui.notify(`fireye: no API key for provider ${model.provider} (run /login)`, "error");
				return;
			}
			const rawBase = auth.baseUrl ?? model.baseUrl;
			if (!rawBase) {
				ctx.ui.notify(`fireye: no base URL for provider ${model.provider}`, "error");
				return;
			}
			// fireye appends /v1/messages, /v1/chat/completions, /v1/responses itself.
			const base = rawBase.replace(/\/+$/, "").replace(/\/v\d+$/i, "");

			const target: RunTarget = { base, modelId: model.id, provider: model.provider, format, apiKey: auth.apiKey, bankId, ...parseDepth(args) };
			const summary = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => new FireyeOverlay(tui, theme, done, target),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
			);
			if (summary) {
				const level = summary.includes("❌") ? "error" : /🟠|⚪/.test(summary) ? "warning" : "info";
				ctx.ui.notify(summary, level);
			}
		},
	});
}

export class FireyeOverlay implements Focusable {
	focused = false;

	private tui: { requestRender: () => void };
	private theme: Theme;
	private done: (value: string | undefined) => void;
	private target: RunTarget;

	private state: RunState = "running";
	private answers: AnswerEvent[] = [];
	private probes: ProbeEvent[] = [];
	private looks: LookEvent[] = [];
	/** Answers planned so far (auto mode grows this at each look). */
	private planned: number;
	private lane: LaneInfo = {};
	private result: LaneResult | undefined;
	private plainLog: string[] = [];
	private reportDir: string | undefined;
	private reportLines: string[] | undefined;
	private view: "summary" | "report" = "summary";
	private errorMsg: string | undefined;
	private finishedAt: number | undefined;
	private scroll = 0;
	/** Wrapped line count of the last render, for scroll bounds. */
	private lineCount = 0;
	private startedAt = Date.now();
	private child: ChildProcess | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private likeness: Likeness | undefined;

	constructor(tui: { requestRender: () => void }, theme: Theme, done: (value: string | undefined) => void, target: RunTarget) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.target = target;
		this.planned = target.auto ? AUTO_LOOKS[0] : target.samples;
		this.timer = setInterval(() => this.tui.requestRender(), 500);
		getLikeness().then((l) => { this.likeness = l; this.tui.requestRender(); }, () => {});
		this.start();
	}

	private onEvent(ev: Record<string, unknown>): void {
		switch (ev.type) {
			case "lane":
				this.lane = ev as LaneInfo;
				break;
			case "answer":
				this.answers.push(ev as unknown as AnswerEvent);
				break;
			case "probe":
				this.probes.push(ev as unknown as ProbeEvent);
				break;
			case "look": {
				const l = ev as unknown as LookEvent;
				this.looks.push(l);
				if (l.next) this.planned = l.next;
				break;
			}
			case "lane_done":
				this.result = ev.result as LaneResult;
				break;
			case "report":
				this.reportDir = String(ev.dir);
				break;
		}
	}

	private start(): void {
		const { base, modelId, samples, format, apiKey, auto } = this.target;
		const concurrency = Math.min(samples, MAX_CONCURRENCY);
		const size = auto ? ["--depth", "auto"] : ["--samples", String(samples)];
		// Key travels via env so it never appears in the process argument list.
		const child = spawn(
			"node",
			[BIN, "--base", base, "--models", modelId, ...size, "--concurrency", String(concurrency), "--format", format, "--out", REPORTS_DIR, "--events", "--yes"],
			{ cwd: REPO_ROOT, env: { ...process.env, FIREYE_KEY: apiKey } },
		);
		this.child = child;

		let buf = "";
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			const parts = buf.split("\n");
			buf = parts.pop() ?? "";
			for (const raw of parts) {
				const line = stripAnsi(raw).replace(/\s+$/, "");
				if (!line) continue;
				if (line.startsWith(EVENT_PREFIX)) {
					try {
						this.onEvent(JSON.parse(line.slice(EVENT_PREFIX.length)));
					} catch {
						// ignore a malformed event line
					}
				} else {
					this.plainLog.push(line);
					if (this.plainLog.length > 200) this.plainLog.shift();
				}
			}
			this.tui.requestRender();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		// Answers plus echo probes; auto runs up to three looks back to back.
		const budget = (Math.ceil((2 * samples) / concurrency) + (auto ? AUTO_LOOKS.length : 0)) * ANSWER_BUDGET_MS + 2 * 60 * 1000;
		const watchdog = setTimeout(() => {
			if (this.state === "running") {
				this.errorMsg = `超时（${Math.round(budget / 60000)} 分钟）`;
				child.kill("SIGINT");
			}
		}, budget);

		child.on("error", (err) => {
			clearTimeout(watchdog);
			this.state = "error";
			this.errorMsg = err.message;
			this.stopClock();
			this.tui.requestRender();
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			this.child = undefined;
			this.stopClock();
			if (this.state === "running") {
				if (code === 0) this.state = "done";
				else {
					this.state = "error";
					this.errorMsg ??= `exit code ${code}`;
				}
			}
			const md = this.reportDir && path.join(this.reportDir, "report.md");
			if (md && fs.existsSync(md)) this.reportLines = fs.readFileSync(md, "utf8").split("\n");
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			if (this.state === "running") {
				this.child?.kill("SIGINT");
				this.state = "aborted";
				this.stopClock();
				this.tui.requestRender();
				return;
			}
			this.finish();
			return;
		}
		if ((matchesKey(data, "tab") || data === "r") && this.state !== "running" && this.reportLines) {
			this.view = this.view === "summary" ? "report" : "summary";
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}
		const viewH = this.contentViewH();
		const maxScroll = Math.max(0, this.lineCount - viewH);
		if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down") || data === "j") this.scroll = Math.min(maxScroll, this.scroll + 1);
		else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - viewH);
		else if (matchesKey(data, "pageDown")) this.scroll = Math.min(maxScroll, this.scroll + viewH);
		else return;
		this.tui.requestRender();
	}

	private stopClock(): void {
		this.finishedAt ??= Date.now();
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private finish(): void {
		this.stopClock();
		const note = this.reportDir ? ` — ${this.reportDir}/report.md` : "";
		if (this.result) {
			const v = verdictOf(this.result.verdict);
			this.done(`fireye ${v.icon} ${this.result.headline} — ${this.target.modelId}：${this.result.why[0] ?? ""}${note}`);
		} else if (this.state === "aborted") this.done(`fireye 已取消${note}`);
		else if (this.state === "error") this.done(`fireye 出错：${this.errorMsg ?? ""}`);
		else this.done(undefined);
	}

	/** One line per answer, in arrival order. */
	private answerLine(a: AnswerEvent): { c: Color; t: string } {
		const n = `#${String(a.index + 1).padStart(2)}`;
		if (!a.ok) return { c: "dim", t: `${n}  没有回答（${a.status}，已重试）` };
		const s = a.assessment;
		if (!s.valid) return { c: "dim", t: `${n}  数字太少（${a.parsed_numbers} 个），不计入` };
		const secs = a.latency_ms != null ? `  ${Math.round(a.latency_ms / 1000)}s` : "";
		if (!this.target.bankId) return { c: "text", t: `${n}  像 ${s.like}（${pct(s.like_p)}）${secs}` };
		if (s.flagged) return { c: "error", t: `${n}  ✗ 明显不像标签，像 ${s.like}（${pct(s.like_p)}）${secs}` };
		if (s.like !== this.target.bankId) return { c: "warning", t: `${n}  ≈ 更像 ${s.like}（标签 ${pct(s.p_label)}，单条不能排除）${secs}` };
		return { c: "success", t: `${n}  ✓ 像标签（${pct(s.p_label)}）${secs}` };
	}

	private runningLines(): Array<{ c: Color; t: string }> {
		const t = this.target;
		const out: Array<{ c: Color; t: string }> = [];
		if (this.lane.fatal) out.push({ c: "error", t: `连接失败：${this.lane.error ?? ""}` });
		const got = this.answers.length;
		const valid = this.answers.filter((a) => a.assessment.valid);
		const off = valid.filter((a) => a.assessment.flagged).length;
		const drift = valid.filter((a) => a.assessment.like !== t.bankId).length - off;
		const bar = "█".repeat(Math.round((Math.min(got, this.planned) / this.planned) * 20)).padEnd(20, "░");
		out.push({ c: "text", t: `进度  ${bar}  已收到 ${got}/${this.planned} 条回答（并行发出${t.auto ? `，自动加测最多 ${t.samples} 条` : ""}）` });
		for (const l of this.looks) if (l.next) out.push({ c: "warning", t: `加测  ${l.n} 条时${l.reason}，加测到 ${l.next} 条` });
		const tok = this.probeSummary();
		if (tok) out.push(tok);
		if (t.bankId) out.push({ c: off || drift ? "warning" : "text", t: `目前  ${valid.length - off - drift} 条像 ${t.modelId}${drift ? `，${drift} 条更像别的模型` : ""}${off ? `，${off} 条明显不像` : ""}` });
		else out.push({ c: "warning", t: `注意  指纹库没有 ${t.modelId}，只能告诉你它像谁，不能下结论` });
		const strip = this.likenessLines(false);
		if (strip.length) out.push({ c: "dim", t: "" }, ...strip);
		out.push({ c: "dim", t: "" });
		for (const a of this.answers) out.push(this.answerLine(a));
		if (!got) out.push({ c: "dim", t: this.lane.transport ? "等待第一条回答…（每条通常 30–120 秒）" : "连接站点、确认协议…" });
		return out;
	}

	/** "How much like the label": send-order strip, plus the histogram once the run is over. */
	private likenessLines(withHistogram: boolean): Array<{ c: Color; t: string }> {
		const lk = this.likeness;
		const bankId = this.target.bankId;
		if (!lk || !bankId || !this.answers.length) return [];
		const out: Array<{ c: Color; t: string }> = [];
		const s = lk.stripText(this.answers);
		const odd = s.marks.length > 0;
		out.push({ c: odd ? "warning" : "success", t: `像标签  ${s.bars}` });
		if (odd) out.push({ c: "warning", t: `        ${s.marks}` });
		out.push({ c: "dim", t: "        按发送顺序 · █≥90% ▆50–90% ▄10–50% ▂0.1–10% ▁<0.1% · ✗明显不像 ≈更像别的模型" });
		if (!withHistogram) return out;
		const h = lk.histogram(this.answers, lk.cal, bankId);
		if (!h.n) return out;
		out.push({ c: "dim", t: "" });
		out.push({ c: "accent", t: `分布    ${" ".repeat(8)}本次${" ".repeat(24)}${h.ref ? "真模型参考（同样条数）" : ""}` });
		const lines = lk.histogramLines(h);
		lines.forEach((t, i) => {
			const r = h.rows[i];
			// Highlight bins where this run has clearly more answers than a genuine channel would.
			const over = r.expected != null && i > 0 && r.count >= Math.max(2, 2 * r.expected + 1);
			out.push({ c: over ? "warning" : "text", t: `        ${t}` });
		});
		const note = lk.shapeNote(h);
		if (note) out.push({ c: "warning", t: `形状    ${note}` });
		return out;
	}

	/** Running tally of the echo probes (token counts). */
	private probeSummary(): { c: Color; t: string } | undefined {
		if (!this.probes.length) return undefined;
		const hist = new Map<number, number>();
		for (const p of this.probes) if (p.count != null) hist.set(p.count, (hist.get(p.count) ?? 0) + 1);
		const usable = [...hist.values()].reduce((a, b) => a + b, 0);
		const parts = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`);
		// Counts within 2 tokens of the most common one are the same tokenizer (end-of-turn tokens).
		const top = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		const odd = top == null ? 0 : [...hist.entries()].filter(([c]) => c < top - 2 || c > top + 2).reduce((a, [, n]) => a + n, 0);
		return { c: odd ? "warning" : "dim", t: `复述  ${usable}/${this.probes.length} 次可用${parts.length ? `，输出 token 数 ${parts.join("，")}` : ""}${odd ? `（${odd} 次和多数不一样）` : ""}` };
	}

	/** Plain-language result page. */
	private summaryLines(): Array<{ c: Color; t: string }> {
		const r = this.result;
		if (!r) {
			const tail = this.plainLog.slice(-8).map((t) => ({ c: "dim" as Color, t }));
			return [{ c: "error", t: this.state === "aborted" ? "已取消" : `没有结果${this.errorMsg ? `：${this.errorMsg}` : ""}` }, ...tail];
		}
		const v = verdictOf(r.verdict);
		const out: Array<{ c: Color; t: string }> = [];
		out.push({ c: v.color, t: `${v.icon}  ${r.headline}` });
		out.push({ c: "dim", t: "" });
		for (const w of r.why) out.push({ c: "text", t: `·  ${w}` });
		if (this.target.bankId && this.target.bankId !== this.target.modelId) out.push({ c: "dim", t: `·  按指纹库中的 ${this.target.bankId} 核对` });
		if (r.looks?.length) out.push({ c: "dim", t: `·  自动加测：${r.looks.map((l) => `${l.n} 条${l.next ? `（${l.reason}，加测到 ${l.next}）` : "（停止）"}`).join(" → ")}` });
		const viz = this.likenessLines(true);
		if (viz.length) out.push({ c: "dim", t: "" }, ...viz);
		if (this.answers.length) {
			out.push({ c: "dim", t: "" });
			out.push({ c: "accent", t: "逐条" });
			for (const a of [...this.answers].sort((x, y) => x.index - y.index)) out.push(this.answerLine(a));
		}
		const tr = this.lane.transport;
		if (tr) {
			out.push({ c: "dim", t: "" });
			const inj = tr.injection_estimate;
			const injText = inj == null ? "未知" : inj < 50 ? `约 ${inj} token（基本是直连）` : `约 ${inj} token（站点在你的请求前加了提示词，按输入计费）`;
			out.push({ c: "dim", t: `隐藏提示词  ${injText}` });
		}
		const tok = this.probeSummary();
		if (tok) out.push({ c: tok.c, t: tok.t.replace(/^复述  /, "复述测试    ") });
		if (this.reportDir) out.push({ c: "dim", t: `报告        ${this.reportDir}/report.md` });
		return out;
	}

	private contentViewH(): number {
		const rows = process.stdout.rows || 24;
		// The overlay container hard-clips render output to maxHeight (85% of terminal rows):
		// content + 6 chrome lines (borders, title, status, blank, hint) + 2 spare.
		return Math.max(5, Math.floor(0.85 * rows) - 8);
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(40, width);
		const innerW = w - 2;
		const truncate = (s: string, max: number): string => {
			let out = "";
			let used = 0;
			for (const ch of s) {
				const cw = visibleWidth(ch);
				if (used + cw > max - 1) break;
				out += ch;
				used += cw;
			}
			return out;
		};
		const pad = (s: string): string => {
			const vis = visibleWidth(s);
			return vis > innerW ? truncate(s, innerW) : s + " ".repeat(innerW - vis);
		};
		const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		const t = this.target;
		const size = t.auto ? `${t.depthName} ${AUTO_LOOKS.join("→")} 条` : `${t.depthName} ${t.samples} 条`;
		lines.push(row(` 🔥 fireye · ${th.fg("accent", `${t.provider}/${t.modelId}`)} · ${size} · ${th.fg("dim", t.base)}`));

		const elapsed = Math.floor(((this.finishedAt ?? Date.now()) - this.startedAt) / 1000);
		const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
		let status: string;
		if (this.state === "running") status = ` ${th.fg("warning", "● 测试中")} ${clock} · Esc 取消`;
		else if (this.state === "done") {
			const v = this.result ? verdictOf(this.result.verdict) : undefined;
			const r = this.result;
			// Always show the drift count next to a clean verdict, so "未发现掺水" never hides it.
			const counts = r && r.j != null && r.n ? th.fg(r.j ? "warning" : "dim", ` · ${r.j}/${r.n} 条更像别的模型（可疑线 ${r.j_star}）`) : "";
			status = ` ${th.fg("success", "● 完成")} ${clock}${v ? ` · ${v.icon} ${th.fg(v.color as never, r!.headline)}${counts}` : ""}`;
		} else if (this.state === "aborted") status = ` ${th.fg("warning", "● 已取消")} ${clock}`;
		else status = ` ${th.fg("error", "● 出错")} ${this.errorMsg ?? ""}`;
		lines.push(row(status));
		lines.push(row(""));

		const viewH = this.contentViewH();
		const styled =
			this.state === "running"
				? this.runningLines()
				: this.view === "report" && this.reportLines
					? this.reportLines.map((t2) => ({ c: "dim" as Color, t: t2 }))
					: this.summaryLines();
		// Wrap long lines (CJK-aware widths) instead of clipping them.
		const wrapped: Array<{ c: Color; t: string }> = [];
		const maxW = innerW - 2;
		for (const l of styled) {
			let cur = "";
			let used = 0;
			for (const ch of l.t) {
				const cw = visibleWidth(ch);
				if (used + cw > maxW) {
					wrapped.push({ c: l.c, t: cur });
					cur = "   ";
					used = 3;
				}
				cur += ch;
				used += cw;
			}
			wrapped.push({ c: l.c, t: cur });
		}
		this.lineCount = wrapped.length;
		// While running, keep the newest answers visible; otherwise honour the scroll offset.
		const maxScroll = Math.max(0, wrapped.length - viewH);
		const start = this.state === "running" ? maxScroll : Math.min(this.scroll, maxScroll);
		this.scroll = start;
		for (const l of wrapped.slice(start, start + viewH)) lines.push(row(` ${th.fg(l.c as never, l.t)}`));

		const hint =
			this.state === "running"
				? " Esc 取消测试"
				: this.reportLines
					? ` Tab 切换${this.view === "summary" ? "完整报告" : "结果"} · ↑↓ 滚动 · Esc/q 关闭`
					: " ↑↓ 滚动 · Esc/q 关闭";
		lines.push(row(th.fg("dim", hint)));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.child) this.child.kill("SIGINT");
	}
}
