/**
 * pi-context — a `/context` command for pi.
 *
 * Shows what is consuming your context window, broken down by:
 *   - Tool schemas (grouped by the extension/package that registered them)
 *   - System prompt text (base prompt + guidelines + tool one-liners + pi docs)
 *   - Context files (AGENTS.md / CLAUDE.md)
 *   - Skills listing
 *   - Conversation (messages)
 *
 * The report renders in the transcript via a custom entry, so it is durable and
 * is NEVER sent to the LLM (it does not add to your context).
 *
 * Token counts use a fast local estimator. When pi has a measured context total
 * available (`ctx.getContextUsage()`), the per-section estimates are calibrated
 * so they reconcile to that real number.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// Characters-per-token divisors. Prose (natural language) tokenizes at roughly
// ~4 chars/token; JSON tool schemas are denser (punctuation + identifiers).
// Both are overridable via env for power users who want to hand-tune.
const CPT_PROSE = Number(process.env.PI_CONTEXT_CPT_PROSE) || 4.0;
const CPT_JSON = Number(process.env.PI_CONTEXT_CPT_JSON) || 3.4;

const ENTRY_TYPE = "context-report";

interface ToolStat {
	name: string;
	tokens: number;
}

interface GroupStat {
	label: string;
	source: string;
	tokens: number;
	count: number;
	tools: ToolStat[];
}

interface ContextReport {
	model: string;
	contextWindow: number;
	realTokens: number | null;
	calibrated: boolean;
	// Section totals (already calibrated when calibrated === true).
	toolsTotal: number;
	systemBase: number;
	contextFiles: number;
	skills: number;
	conversation: number;
	overhead: number; // system + tools (everything that isn't conversation)
	total: number; // grand total shown in the header
	groups: GroupStat[];
	generatedAt: number;
}

function estTokens(text: string, cpt: number): number {
	if (!text) return 0;
	return Math.ceil(text.length / cpt);
}

function friendlyLabel(source: string | undefined): string {
	if (!source || source === "builtin") return "pi core (built-in)";
	if (source === "sdk") return "sdk (host app)";
	let m = source.match(/^npm:(@?[^@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	m = source.match(/^git:.*?\/([^/@]+?)(?:@[^@]*)?$/);
	if (m) return m[1];
	return source;
}

function extractAll(text: string, re: RegExp): string {
	const matches = text.match(re);
	return matches ? matches.join("\n") : "";
}

function buildReport(pi: ExtensionAPI, ctx: any): ContextReport {
	const systemPrompt: string = ctx.getSystemPrompt?.() ?? "";
	const opts = ctx.getSystemPromptOptions?.() ?? {};

	const activeNames = new Set<string>(pi.getActiveTools?.() ?? []);
	const allTools: ToolInfo[] = (pi.getAllTools?.() ?? []).filter((t: ToolInfo) =>
		activeNames.size === 0 ? true : activeNames.has(t.name),
	);

	// --- Tool schemas, grouped by originating source ---
	const groupMap = new Map<string, GroupStat>();
	let toolsTotalRaw = 0;
	for (const t of allTools) {
		const schema = JSON.stringify({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		});
		const tok = estTokens(schema, CPT_JSON);
		toolsTotalRaw += tok;
		const source = t.sourceInfo?.source ?? "unknown";
		const label = friendlyLabel(source);
		let g = groupMap.get(label);
		if (!g) {
			g = { label, source, tokens: 0, count: 0, tools: [] };
			groupMap.set(label, g);
		}
		g.tokens += tok;
		g.count += 1;
		g.tools.push({ name: t.name, tokens: tok });
	}

	// --- System prompt text sections ---
	const contextFilesText = (opts.contextFiles ?? [])
		.map((f: { content: string }) => f.content ?? "")
		.join("\n");
	const contextFilesRaw = estTokens(contextFilesText, CPT_PROSE);

	const skillsBlock = extractAll(systemPrompt, /<available_skills>[\s\S]*?<\/available_skills>/g);
	const skillsRaw = estTokens(skillsBlock, CPT_PROSE);

	const systemTotalRaw = estTokens(systemPrompt, CPT_PROSE);
	// Base = everything in the system prompt string that isn't a context file or
	// the skills listing (base prompt + guidelines + tool one-liners + pi docs).
	const systemBaseRaw = Math.max(0, systemTotalRaw - contextFilesRaw - skillsRaw);

	// --- Conversation (messages) ---
	let conversationRaw = 0;
	try {
		const sm = ctx.sessionManager;
		const entries: any[] = sm?.buildContextEntries?.() ?? sm?.getBranch?.() ?? [];
		for (const e of entries) {
			const msg = e?.message ?? e;
			if (!msg) continue;
			const content = msg.content;
			if (typeof content === "string") conversationRaw += estTokens(content, CPT_PROSE);
			else if (content != null) conversationRaw += estTokens(JSON.stringify(content), CPT_PROSE);
		}
	} catch {
		/* best effort */
	}

	// --- Calibrate to pi's measured total when available ---
	const usage = ctx.getContextUsage?.();
	const realTokens: number | null = usage?.tokens ?? null;
	const contextWindow: number = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	const rawTotal =
		systemBaseRaw + contextFilesRaw + skillsRaw + toolsTotalRaw + conversationRaw;
	let scale = 1;
	let calibrated = false;
	if (realTokens && rawTotal > 0) {
		scale = realTokens / rawTotal;
		calibrated = true;
	}

	const s = (n: number) => Math.round(n * scale);

	const groups: GroupStat[] = [...groupMap.values()]
		.map((g) => ({
			...g,
			tokens: s(g.tokens),
			tools: g.tools.map((t) => ({ name: t.name, tokens: s(t.tokens) })).sort((a, b) => b.tokens - a.tokens),
		}))
		.sort((a, b) => b.tokens - a.tokens);

	const toolsTotal = s(toolsTotalRaw);
	const systemBase = s(systemBaseRaw);
	const contextFiles = s(contextFilesRaw);
	const skills = s(skillsRaw);
	const conversation = s(conversationRaw);
	const overhead = toolsTotal + systemBase + contextFiles + skills;
	const total = calibrated ? (realTokens as number) : overhead + conversation;

	return {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
		contextWindow,
		realTokens,
		calibrated,
		toolsTotal,
		systemBase,
		contextFiles,
		skills,
		conversation,
		overhead,
		total,
		groups,
		generatedAt: Date.now(),
	};
}

// ---------- rendering ----------

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function bar(fraction: number, width = 12): string {
	const clamped = Math.max(0, Math.min(1, fraction || 0));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function humanTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Column layout (monospace character cells).
const LABEL_W = 28;
const COUNT_W = 3;
const TOK_W = 8;
const BAR_W = 12;
const PCT_W = 5;
const LINE_W = LABEL_W + COUNT_W + TOK_W + 2 + BAR_W + PCT_W;

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<ContextReport>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const r = entry.data;
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		if (!r) {
			box.addChild(new Text(theme.fg("error", "No context data."), 0, 0));
			return box;
		}

		const line = (t: string) => box.addChild(new Text(t, 0, 0));
		const spacer = () => box.addChild(new Text(" ", 0, 0));
		const denom = r.total || 1;

		// Bars scale to the largest single data row so the biggest one fills.
		let maxRow = 1;
		for (const g of r.groups) maxRow = Math.max(maxRow, g.tokens);
		maxRow = Math.max(maxRow, r.systemBase, r.contextFiles, r.skills, r.conversation);

		// Build each row as plain, width-exact text, then colorize whole segments
		// so ANSI codes never throw off column alignment.
		const dataRow = (
			label: string,
			tokens: number,
			opts: { indent?: number; count?: number; color?: string } = {},
		) => {
			const lbl = pad(" ".repeat(opts.indent ?? 0) + label, LABEL_W);
			const cnt = padLeft(opts.count != null ? String(opts.count) : "", COUNT_W);
			const tok = padLeft(fmt(tokens), TOK_W);
			const b = bar(tokens / maxRow, BAR_W);
			const p = padLeft(`${Math.round((tokens / denom) * 100)}%`, PCT_W);
			const head = `${lbl}${cnt}${tok}`;
			line(`${opts.color ? theme.fg(opts.color, head) : head} ${theme.fg("dim", b)} ${theme.fg("dim", p)}`);
		};

		const sectionHeader = (title: string, subtotal: number) => {
			const left = pad(title, LABEL_W + COUNT_W);
			line(theme.bold(theme.fg("accent", `${left}${padLeft(fmt(subtotal), TOK_W)}`)));
		};

		// ---- Header ----
		const winPct = r.contextWindow ? `${((r.total / r.contextWindow) * 100).toFixed(1)}%` : "?";
		line(
			`${theme.bold(theme.fg("accent", "/context"))}  ${theme.bold(fmt(r.total))} tokens  ` +
				`${theme.fg("dim", `· ${winPct} of ${humanTokens(r.contextWindow)}`)}`,
		);
		line(
			theme.fg(
				"dim",
				`${r.model}  ·  ${r.calibrated ? "calibrated to measured total" : "estimated (pre-response)"}`,
			),
		);
		spacer();

		// ---- Tool schemas ----
		sectionHeader("TOOL SCHEMAS", r.toolsTotal);
		for (const g of r.groups) {
			dataRow(g.label, g.tokens, { indent: 1, count: g.count, color: "accent" });
			if (expanded) for (const t of g.tools) dataRow(t.name, t.tokens, { indent: 3 });
		}
		spacer();

		// ---- System prompt & resources ----
		sectionHeader("SYSTEM PROMPT", r.systemBase + r.contextFiles + r.skills);
		dataRow("base + guidelines + docs", r.systemBase, { indent: 1 });
		dataRow("context files (AGENTS.md)", r.contextFiles, { indent: 1 });
		dataRow("skills listing", r.skills, { indent: 1 });
		spacer();

		// ---- Conversation ----
		sectionHeader("CONVERSATION", r.conversation);
		dataRow("messages", r.conversation, { indent: 1 });
		spacer();

		// ---- Total ----
		line(theme.fg("dim", "─".repeat(LINE_W)));
		const totLbl = pad("TOTAL", LABEL_W + COUNT_W);
		line(
			theme.bold(theme.fg("success", `${totLbl}${padLeft(fmt(r.total), TOK_W)}`)) +
				theme.fg("dim", `  ${winPct} of window`),
		);
		spacer();
		line(
			theme.fg(
				"dim",
				expanded
					? "Local estimate · per-tool detail shown · not sent to the LLM"
					: "Local estimate · expand for per-tool detail · not sent to the LLM",
			),
		);

		return box;
	});

	pi.registerCommand("context", {
		description: "Show what's using your context window (system prompt, tools, files, skills)",
		handler: async (_args, ctx) => {
			try {
				const report = buildReport(pi, ctx);
				if (process.env.PI_CONTEXT_DEBUG) {
					console.error("[pi-context] " + JSON.stringify(report, null, 2));
				}
				if (ctx.mode === "tui") {
					pi.appendEntry<ContextReport>(ENTRY_TYPE, report);
				} else {
					// Non-interactive fallback: compact one-liner.
					ctx.ui.notify(
						`context: ${fmt(report.total)} tokens · tools ${fmt(report.toolsTotal)} · ` +
							`system ${fmt(report.systemBase + report.contextFiles + report.skills)} · ` +
							`conversation ${fmt(report.conversation)}`,
						"info",
					);
				}
			} catch (err) {
				ctx.ui.notify(`/context failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
