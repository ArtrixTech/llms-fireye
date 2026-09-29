/**
 * llms-fireye pi extension — /fireye [rounds]
 *
 * Runs a fingerprint authenticity test against the currently selected model
 * (provider base URL + API key resolved from pi's model registry) and shows
 * progress plus the verdict in a single overlay window. Default: 1 round.
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
import { fileURLToPath } from "node:url";

const EXT_DIR = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXT_DIR, "..");
const BIN = path.join(REPO_ROOT, "bin", "fireye.mjs");
const REPORTS_DIR = process.env.FIREYE_PI_OUT ?? path.join(REPO_ROOT, "reports");
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_LINES = 500;

const VERDICT_RE = /^(.+): (PASS|LIKELY|FAMILY_MATCH|SUSPECT|FAIL|INCONCLUSIVE|LIMITED) — (.+)$/;
const REPORT_RE = /report → (.+\/report\.md)/;

type RunState = "running" | "done" | "error" | "aborted";

interface RunTarget {
	base: string; // normalized: no trailing slash, no trailing /vN
	modelId: string;
	provider: string;
	rounds: number;
	apiKey: string;
}

/** Strip ANSI escape sequences from child-process output before re-rendering. */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\(B/g, "");
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

			const parsed = Number.parseInt((args ?? "").trim(), 10);
			const rounds = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 20) : 1;

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

			// fireye appends /v1/messages or /v1/chat/completions itself.
			const base = rawBase.replace(/\/+$/, "").replace(/\/v\d+$/i, "");

			const target: RunTarget = {
				base,
				modelId: model.id,
				provider: model.provider,
				rounds,
				apiKey: auth.apiKey,
			};

			const summary = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => new FireyeOverlay(tui, theme, done, target),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
			);

			if (summary) {
				const level = /FAIL/.test(summary) ? "error" : /SUSPECT|FAMILY_MATCH|INCONCLUSIVE|LIMITED/.test(summary) ? "warning" : "info";
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
	private verdictLines: string[] = [];
	private reportPath: string | undefined;
	private reportLines: string[] | undefined;
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
		const { base, modelId, rounds, apiKey } = this.target;
		// Key travels via env so it never appears in the process argument list.
		const child = spawn(
			"node",
			[BIN, "--base", base, "--models", modelId, "--rounds", String(rounds), "--concurrency", "1", "--out", REPORTS_DIR],
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
				const vm = line.match(VERDICT_RE);
				if (vm) this.verdictLines.push(line);
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
				if (code === 0 && this.reportPath && fs.existsSync(this.reportPath)) {
					this.reportLines = fs.readFileSync(this.reportPath, "utf8").split("\n");
					this.state = "done";
				} else if (code === 0) {
					this.state = "done";
				} else {
					this.state = "error";
					this.errorMsg ??= `exit code ${code}`;
				}
			}
			if (this.reportPath && this.state === "aborted" && fs.existsSync(this.reportPath)) {
				this.reportLines ??= fs.readFileSync(this.reportPath, "utf8").split("\n");
			}
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
		const verdict = this.verdictLines.join(" | ");
		const icon = /\bFAIL\b/.test(verdict)
			? "❌"
			: /\bSUSPECT\b/.test(verdict)
				? "🟠"
				: /\bFAMILY_MATCH\b/.test(verdict)
					? "🟡"
					: /\bLIKELY\b/.test(verdict)
						? "🟢"
						: /\bPASS\b/.test(verdict)
							? "✅"
							: "⚪";
		const pathNote = this.reportPath ? ` — ${this.reportPath}` : "";
		if (this.state === "done" && verdict) this.done(`fireye ${icon} ${verdict}${pathNote}`);
		else if (this.state === "done") this.done(`fireye done${pathNote}`);
		else if (this.state === "aborted") this.done(`fireye aborted${pathNote}`);
		else this.done(undefined);
	}

	private contentLines(): string[] {
		if (this.reportLines) return this.reportLines;
		return this.logLines;
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

		// status line
		const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
		let status: string;
		if (this.state === "running") status = ` ${th.fg("warning", "● running")} ${elapsed}s · Esc 取消`;
		else if (this.state === "done") status = ` ${th.fg("success", "● done")} ${elapsed}s`;
		else if (this.state === "aborted") status = ` ${th.fg("warning", "● aborted")}`;
		else status = ` ${th.fg("error", "● error")} ${this.errorMsg ?? ""}`;
		lines.push(row(status));

		// verdict summary once available
		if (this.verdictLines.length > 0) {
			for (const v of this.verdictLines) lines.push(row(` ${th.bold(v)}`));
			if (this.reportPath) lines.push(row(` ${th.fg("dim", this.reportPath)}`));
			lines.push(row(""));
		}

		// content window: report after completion, live log tail while running
		const content = this.contentLines();
		const viewH = this.viewHeight() - (lines.length - 2); // subtract chrome already emitted
		let slice: string[];
		if (this.state === "running") {
			slice = content.slice(-Math.max(1, viewH));
		} else {
			const maxScroll = Math.max(0, content.length - viewH);
			this.scroll = Math.min(this.scroll, maxScroll);
			slice = content.slice(this.scroll, this.scroll + viewH);
		}
		for (const l of slice) lines.push(row(` ${th.fg("dim", l)}`));

		// footer hint
		const total = content.length;
		const hint =
			this.state === "running"
				? ` ${total} log lines · Esc 取消测试`
				: ` ↑↓/jk 滚动 · PgUp/PgDn 翻页 (${this.scroll + 1}-${Math.min(total, this.scroll + viewH)}/${total}) · Esc/q 关闭`;
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
