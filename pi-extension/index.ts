/**
 * llms-fireye pi extension — /fireye [rounds]
 *
 * Runs a fingerprint authenticity test against the currently selected model
 * (provider base URL + API key resolved from pi's model registry) and shows
 * a plain-language, color-coded verdict in a single overlay window.
 * Default: 1 round. Tab toggles the full raw report.
 *
 * Only model names covered by the ModelTrace fingerprint bank are testable;
 * the handler checks coverage up front and lists the supported names.
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
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_LINES = 500;

const VERDICT_RE = /^(.+): (PASS|LIKELY|FAMILY_MATCH|SUSPECT|FAIL|INCONCLUSIVE|LIMITED) — (.+)$/;
const REPORT_RE = /report → (.+\/report\.md)/;

/** fireye's transport speaks exactly these API shapes. */
const API_TO_FORMAT: Record<string, string> = {
	"anthropic-messages": "anthropic",
	"openai-completions": "openai",
	"openai-responses": "openai-responses",
};

interface VerdictStyle {
	icon: string;
	label: string;
	color: "success" | "warning" | "error" | "dim";
}
const VERDICT_ZH: Record<string, VerdictStyle> = {
	PASS: { icon: "✅", label: "真身", color: "success" },
	LIKELY: { icon: "🟢", label: "大概率真身", color: "success" },
	FAMILY_MATCH: { icon: "🟡", label: "同家族换壳/降级", color: "warning" },
	SUSPECT: { icon: "🟠", label: "混池嫌疑", color: "warning" },
	FAIL: { icon: "❌", label: "假冒", color: "error" },
	INCONCLUSIVE: { icon: "⚪", label: "无法判定", color: "dim" },
	LIMITED: { icon: "⚪", label: "指纹库未覆盖", color: "dim" },
};

function verdictStyle(v: string | undefined): VerdictStyle {
	return VERDICT_ZH[v ?? ""] ?? { icon: "⚪", label: v ?? "未知", color: "dim" };
}

type RunState = "running" | "done" | "error" | "aborted";

interface RunTarget {
	base: string; // normalized: no trailing slash, no trailing /vN
	modelId: string;
	provider: string;
	rounds: number;
	format: string;
	apiKey: string;
}

interface BankModel {
	id: string;
	display_name?: string;
	family?: string;
}
interface Bank {
	models: BankModel[];
}

let bankPromise: Promise<Bank> | undefined;
/** Load the fingerprint bank via the repo's own loader (24h cache, auto-download). */
function getBank(): Promise<Bank> {
	bankPromise ??= import(pathToFileURL(path.join(REPO_ROOT, "lib", "bank.mjs")).href).then((m) => m.loadBank({}));
	return bankPromise;
}

/** Exact id/display_name match, then a normalized form (case + trailing date stamp). */
function findCoveredModel(bank: Bank, label: string): BankModel | undefined {
	const norm = (s: string) => s.toLowerCase().replace(/-\d{8}$/, "");
	const target = norm(label);
	return bank.models.find(
		(m) => m.id === label || m.display_name === label || norm(m.id) === target || norm(String(m.display_name ?? "")) === target,
	);
}

/** Strip ANSI escape sequences from child-process output before re-rendering. */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\(B/g, "");
}

interface Lane {
	label: string;
	family?: string;
	verdict?: { verdict: string; reason: string };
	pooled?: { used: number; prediction: string; family: string; p: number; top4?: Array<{ m: string; family: string; p: number; sim: number }> } | null;
	probe?: { input_tokens?: number; injection_estimate?: number; self_report?: string } | null;
	harness?: { self_report?: string } | null;
	stats?: { requests: number; ok: number; empty: number; errors: number; p50_ms?: number; p95_ms?: number };
	ctx?: { format: string; thinkingMode: string };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fireye", {
		description: "Fireye fingerprint test on the current model (default 1 round; /fireye 3 for 3 rounds)",
		getArgumentCompletions: (prefix: string) => {
			const items = ["1", "3", "5"].map((v) => ({ value: v, label: `${v} round${v === "1" ? "" : "s"}` }));
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
				ctx.ui.notify(
					`fireye: ${model.provider}/${model.id} 的 API 类型 "${model.api}" 暂不支持。可测: anthropic-messages / openai-completions / openai-responses`,
					"error",
				);
				return;
			}

			if (!fs.existsSync(BIN)) {
				ctx.ui.notify(`fireye: bin/fireye.mjs not found under ${REPO_ROOT}`, "error");
				return;
			}

			const parsed = Number.parseInt((args ?? "").trim(), 10);
			const rounds = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : 1;

			let bank: Bank;
			try {
				bank = await getBank();
			} catch (e) {
				ctx.ui.notify(`fireye: 指纹库加载失败: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			if (!findCoveredModel(bank, model.id)) {
				const ids = bank.models.map((m) => m.id).join(", ");
				ctx.ui.notify(`fireye: 指纹库未覆盖 "${model.id}"，测了也只能给 LIMITED。支持的模型名: ${ids}`, "warning");
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

			const target: RunTarget = {
				base,
				modelId: model.id,
				provider: model.provider,
				rounds,
				format,
				apiKey: auth.apiKey,
			};

			const summary = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => new FireyeOverlay(tui, theme, done, target),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
			);

			if (summary) {
				const level = summary.includes("❌") ? "error" : /🟡|🟠|⚪/.test(summary) ? "warning" : "info";
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
	private logLines: string[] = [];
	private reportPath: string | undefined;
	private reportLines: string[] | undefined;
	private lane: Lane | undefined;
	private view: "summary" | "report" = "summary";
	private errorMsg: string | undefined;
	private scroll = 0;
	private startedAt = Date.now();
	private child: ChildProcess | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: { requestRender: () => void },
		theme: Theme,
		done: (value: string | undefined) => void,
		target: RunTarget,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.target = target;
		this.timer = setInterval(() => this.tui.requestRender(), 500);
		this.start();
	}

	private start(): void {
		const { base, modelId, rounds, format, apiKey } = this.target;
		// Key travels via env so it never appears in the process argument list.
		const child = spawn(
			"node",
			[BIN, "--base", base, "--models", modelId, "--rounds", String(rounds), "--concurrency", "1", "--format", format, "--out", REPORTS_DIR],
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
				this.logLines.push(line);
				if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
				const rm = line.match(REPORT_RE);
				if (rm) this.reportPath = rm[1];
			}
			this.tui.requestRender();
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		const watchdog = setTimeout(() => {
			if (this.state === "running") {
				this.errorMsg = "overall timeout (10 min)";
				child.kill("SIGINT");
			}
		}, OVERALL_TIMEOUT_MS);

		child.on("error", (err) => {
			clearTimeout(watchdog);
			this.state = "error";
			this.errorMsg = err.message;
			this.tui.requestRender();
		});

		child.on("close", (code) => {
			clearTimeout(watchdog);
			this.child = undefined;
			if (this.state === "running") {
				if (code === 0) this.state = "done";
				else {
					this.state = "error";
					this.errorMsg ??= `exit code ${code}`;
				}
			}
			if (this.reportPath && fs.existsSync(this.reportPath)) {
				this.reportLines = fs.readFileSync(this.reportPath, "utf8").split("\n");
				const rawPath = this.reportPath.replace(/report\.md$/, "raw.json");
				if (fs.existsSync(rawPath)) {
					try {
						const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
						this.lane = raw.lanes?.[0];
					} catch {
						// fall back to the raw report view
					}
				}
			}
			if (!this.lane) this.view = "report";
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			if (this.state === "running") {
				this.child?.kill("SIGINT");
				this.state = "aborted";
				this.tui.requestRender();
				return;
			}
			this.finish();
			return;
		}

		if ((matchesKey(data, "tab") || data === "r") && this.state !== "running") {
			if (this.lane || this.reportLines) {
				this.view = this.view === "summary" ? "report" : "summary";
				if (!this.lane) this.view = "report";
				this.scroll = 0;
				this.tui.requestRender();
			}
			return;
		}

		const content = this.contentLines();
		const viewH = this.viewHeight();
		const maxScroll = Math.max(0, content.length - viewH);
		if (matchesKey(data, "up") || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.scroll = Math.min(maxScroll, this.scroll + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.scroll = Math.max(0, this.scroll - viewH);
		} else if (matchesKey(data, "pageDown")) {
			this.scroll = Math.min(maxScroll, this.scroll + viewH);
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private finish(): void {
		if (this.timer) clearInterval(this.timer);
		const lane = this.lane;
		const pathNote = this.reportPath ? ` — ${this.reportPath}` : "";
		if (lane?.verdict) {
			const s = verdictStyle(lane.verdict.verdict);
			const p = lane.pooled?.p != null ? ` p=${lane.pooled.p}` : "";
			this.done(`fireye ${s.icon} ${s.label} — ${lane.label}${p}${pathNote}`);
			return;
		}
		if (this.state === "done") this.done(`fireye 完成${pathNote}`);
		else if (this.state === "aborted") this.done(`fireye 已取消${pathNote}`);
		else this.done(undefined);
	}

	/** Plain-language verdict lines for the default view. */
	private summaryLines(): Array<{ c: string; t: string }> {
		const lane = this.lane;
		if (!lane?.verdict) return [{ c: "dim", t: "（无结构化结果，按 Tab 看完整报告）" }];
		const s = verdictStyle(lane.verdict.verdict);
		const top = lane.pooled?.top4?.[0];
		const out: Array<{ c: string; t: string }> = [];

		let headline = `${s.icon}  ${s.label}`;
		if (lane.verdict.verdict === "FAIL" && top) headline += ` — 行为像 ${top.m}（${top.family} 家族）`;
		if (lane.verdict.verdict === "FAMILY_MATCH" && top) headline += ` — 更像 ${top.m}`;
		if (lane.verdict.verdict === "SUSPECT") headline += " — 各轮归因不一致";
		if (lane.verdict.verdict === "INCONCLUSIVE" && lane.verdict.reason.startsWith("transport fatal")) headline += " — 请求被拒或连接失败";
		out.push({ c: s.color, t: headline });
		out.push({ c: "dim", t: "" });

		if (lane.pooled?.prediction) {
			out.push({ c: "text", t: `归因 top1  ${lane.pooled.prediction}（${lane.pooled.family} 家族）` });
			out.push({ c: "text", t: `置信度    p=${lane.pooled.p} · 分布相似度 sim=${top?.sim ?? "-"} · 有效样本 ${lane.pooled.used}` });
		} else {
			out.push({ c: "text", t: `有效样本不足，无法归因（${lane.verdict.reason}）` });
		}

		const inj = lane.probe?.injection_estimate;
		if (inj != null) out.push({ c: "text", t: `注入估算  ${inj} tok（"hi" 实际 input ${lane.probe?.input_tokens ?? "?"} tok）` });
		const self = (lane.harness?.self_report || lane.probe?.self_report || "").replace(/\n+/g, " ").slice(0, 60);
		if (self) out.push({ c: "dim", t: `自报身份  "${self}"（注入词台词，仅线索）` });

		const st = lane.stats;
		if (st) {
			const p50 = st.p50_ms != null ? ` · p50 ${(st.p50_ms / 1000).toFixed(1)}s` : "";
			out.push({ c: "text", t: `可靠性    ${st.ok}/${st.requests} 成功 · ${st.empty} 空响应 · ${st.errors} 错误${p50}` });
		}
		if (lane.ctx) out.push({ c: "dim", t: `协议      ${lane.ctx.format}/${lane.ctx.thinkingMode}` });
		out.push({ c: "dim", t: `依据      ${lane.verdict.reason}` });
		if (this.reportPath) out.push({ c: "dim", t: `报告      ${this.reportPath}` });
		return out;
	}

	private contentLines(): string[] {
		if (this.state === "running") return this.logLines;
		if (this.view === "report" || !this.lane) return this.reportLines ?? this.logLines;
		return this.summaryLines().map((l) => l.t);
	}

	private viewHeight(): number {
		const rows = process.stdout.rows || 24;
		// chrome: border 2 + title 1 + status 1 + hint 1 + breathing room
		return Math.max(8, rows - 10);
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
		const title = ` 🔥 fireye · ${th.fg("accent", `${t.provider}/${t.modelId}`)} · rounds=${t.rounds} · ${th.fg("dim", t.base)}`;
		lines.push(row(title));

		const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
		let status: string;
		if (this.state === "running") status = ` ${th.fg("warning", "● 测试中")} ${elapsed}s · Esc 取消`;
		else if (this.state === "done") {
			const s = this.lane?.verdict ? verdictStyle(this.lane.verdict.verdict) : undefined;
			status = ` ${th.fg("success", "● 完成")} ${elapsed}s${s ? ` · ${s.icon} ${th.fg(s.color, s.label)}` : ""}`;
		} else if (this.state === "aborted") status = ` ${th.fg("warning", "● 已取消")}`;
		else status = ` ${th.fg("error", "● 出错")} ${this.errorMsg ?? ""}`;
		lines.push(row(status));
		lines.push(row(""));

		const viewH = this.viewHeight() - 2; // title + status + blank already emitted
		if (this.state === "running") {
			const slice = this.logLines.slice(-Math.max(1, viewH));
			for (const l of slice) lines.push(row(` ${th.fg("dim", l)}`));
		} else if (this.view === "summary" && this.lane) {
			for (const l of this.summaryLines()) {
				lines.push(row(` ${th.fg(l.c as never, l.t)}`));
			}
		} else {
			const content = this.reportLines ?? this.logLines;
			const maxScroll = Math.max(0, content.length - viewH);
			this.scroll = Math.min(this.scroll, maxScroll);
			for (const l of content.slice(this.scroll, this.scroll + viewH)) lines.push(row(` ${th.fg("dim", l)}`));
		}

		const hint =
			this.state === "running"
				? ` ${this.logLines.length} log lines · Esc 取消测试`
				: this.lane || this.reportLines
					? ` Tab 切换${this.view === "summary" ? "完整报告" : "摘要"} · ↑↓ 滚动 · Esc/q 关闭`
					: " Esc/q 关闭";
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
