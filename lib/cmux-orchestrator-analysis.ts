import { createHash } from "node:crypto";

export function summarize(text?: string | null, max = 120) {
	if (!text) return "";
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

export function uniqueStrings(values: any[] = []) {
	return Array.from(
		new Set(
			(values || [])
				.map((value) => String(value || "").trim())
				.filter(Boolean),
		),
	);
}

function looksLikeArtifactPath(value: string) {
	const item = String(value || "").trim();
	if (!item || item.includes("://")) return false;
	if (/^\/[A-Z0-9._-]+$/.test(item)) return false;
	if (/^\/\d[\d._-]*$/.test(item)) return false;
	if (/^\/[A-Za-z0-9._-]+$/.test(item) && !/\.[A-Za-z0-9]+$/.test(item)) return false;
	if (item.startsWith("/")) {
		if (/^\/(?:capture|surface|split|after|design|shift|status-bar)\b/i.test(item)) return false;
		const trustedAbsoluteRoot = /^\/(?:Users|tmp|var|private|home|etc|opt|Volumes|Applications|Library)\b/.test(item);
		const hasFileExtension = /\.[A-Za-z0-9]+$/.test(item);
		if (!trustedAbsoluteRoot && !hasFileExtension) return false;
	}
	return Boolean(
		/\.(?:ts|tsx|js|jsx|json|md|py|sh|css|html|yml|yaml|toml|sql)\b/i.test(item) ||
		/^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$/.test(item) ||
		/^\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$/.test(item),
	);
}

export function extractArtifactPaths(text: string, limit = 16) {
	const cleaned = stripPromptEchoText(String(text || ""));
	const matches = cleaned.match(/(?:\/[A-Za-z0-9._\/-]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9]+)?|\b[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|json|md|py|sh|css|html|yml|yaml|toml|sql)\b)/g) || [];
	return uniqueStrings(matches.filter((item) => looksLikeArtifactPath(item))).slice(0, limit);
}

export function extractUrls(text: string, limit = 16) {
	const matches = String(text || "").match(/https?:\/\/[^\s)\]]+/g) || [];
	return uniqueStrings(matches).slice(0, limit);
}

export function extractCommands(text: string, limit = 16) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const commands = lines
		.filter((line) => /^(?:\$\s+|pnpm\s+|npm\s+|bun\s+|yarn\s+|node\s+|python\s+|pytest\s+|vitest\s+|git\s+|cmux\s+|pi\s+)/i.test(line))
		.map((line) => line.replace(/^\$\s+/, ""));
	return uniqueStrings(commands).slice(0, limit);
}

export function stripPromptEchoText(text: string) {
	return String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return true;
			if (/^Steering:/i.test(trimmed)) return false;
			if (/^↳\s+Alt\+/i.test(trimmed)) return false;
			if (/^(alt\+enter|alt\+up|ctrl\+v|drop files to attach)/i.test(trimmed)) return false;
			if (/^Pi can explain its own features/i.test(trimmed)) return false;
			if (/^\[(Skills|Extensions|Themes)\]/.test(trimmed)) return false;
			if (/^If you are blocked,/i.test(trimmed)) return false;
			if (/^Reply tersely with /i.test(trimmed)) return false;
			if (/^Respond in concise terminal-friendly sections:/i.test(trimmed)) return false;
			if (/^Coordinate through the orchestrator\./i.test(trimmed)) return false;
			return true;
		})
		.join("\n");
}

export function hasStructuredAgentResponse(text?: string | null) {
	const normalized = stripPromptEchoText(String(text || ""));
	return /(ROLE READY:|^STATUS:|^OUTPUT:|^RISKS:|^NEXT:|^NEEDS FROM PEERS:|^FILES\/AREAS CHANGED:|^CONFIDENCE:|^COMMANDS RUN:|^URLS:|^DELIVERABLE:|^TEAM STATUS:|^KEY CHANGES:|^REQUESTS TO SWARM:|^NEXT TEAM ACTION:|^OVERALL STATUS:|^TEAM SUMMARIES:|^CHANGES\/AREAS TO REVIEW:|^NEXT ORCHESTRATOR ACTION:)/im.test(normalized);
}

export function parseStructuredAgentReport(text: string) {
	const report: Record<string, string> = {};
	let currentKey: string | null = null;
	for (const rawLine of stripPromptEchoText(String(text || "")).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^([A-Z][A-Z /_-]+):\s*(.*)$/);
		if (match) {
			currentKey = match[1].toLowerCase().replace(/[ /-]+/g, "_");
			report[currentKey] = match[2] || "";
			continue;
		}
		if (currentKey) {
			report[currentKey] = report[currentKey] ? `${report[currentKey]} ${line}` : line;
		}
	}
	return report;
}

function structuredStatusValue(report: Record<string, string> = {}) {
	return String(report.status || report.team_status || report.overall_status || "").toLowerCase();
}

function splitStructuredFieldItems(value: string, limit = 8) {
	return uniqueStrings(
		String(value || "")
			.split(/\r?\n|[;•]+|\s+\|\s+/)
			.map((item) => item.trim())
			.filter(Boolean)
	).slice(0, limit);
}

function isNoneLikeText(value?: string | null) {
	return /^(?:none|no blockers|no blocker|n\/a|nothing|nil|clear)$/i.test(String(value || "").trim());
}

function structuredSummaryValue(report: Record<string, string> = {}) {
	return report.output || report.summary || report.result || report.key_changes || report.team_summaries || report.changes_areas_to_review || "";
}

function structuredNextValue(report: Record<string, string> = {}) {
	return report.next || report.next_team_action || report.next_orchestrator_action || "";
}

function structuredNeedsValue(report: Record<string, string> = {}) {
	return report.needs_from_peers || report.requests_to_swarm || report.requests || "";
}

export function inferAgentStatusFromText(text: string) {
	const cleaned = stripPromptEchoText(String(text || ""));
	const report = parseStructuredAgentReport(cleaned);
	const explicitStatus = structuredStatusValue(report);
	if (/(blocked|stuck|waiting)/.test(explicitStatus)) return "blocked";
	if (/(done|complete|completed|ready for coordinator|ready_for_coordinator)/.test(explicitStatus)) return "done";
	if (/(stalled)/.test(explicitStatus)) return "stalled";
	if (/(working|active|ready)/.test(explicitStatus)) return explicitStatus.includes("ready") ? "ready" : "working";
	const normalized = cleaned.toLowerCase();
	if (!normalized.trim()) return "working";
	if (/(status\s*:\s*blocked|team status\s*:\s*blocked|overall status\s*:\s*blocked|\bblocked\b|\bblocker\b|\bstuck\b|waiting on|unable to|cannot\b|can't\b|\berror\b|\bfailure\b)/i.test(normalized)) return "blocked";
	if (/(status\s*:\s*done|status\s*:\s*complete|team status\s*:\s*complete|overall status\s*:\s*complete|\bdone\b|\bcompleted\b|\bready for coordinator\b|standing by for coordinator|handoff complete)/i.test(normalized)) return "done";
	return "working";
}

export function semanticCaptureText(text: string) {
	const lines = stripPromptEchoText(String(text || ""))
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)/.test(line))
		.filter((line) => !/^[-─═│┃┆┄\s]+$/.test(line))
		.filter((line) => !/^(ny\/mia|↑\d|↓\d|\$\d|lsp\s+\w+|working\.\.\.)/i.test(line))
		.filter((line) => !/\b(?:est|edt|utc)\b/i.test(line));
	return lines.join("\n");
}

export function recentNonEmptyLines(text: string, maxLines = 6) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return (lines.length ? lines : ["No output captured."]).slice(-maxLines);
}

export function blockerSignals(lines: string[]) {
	const blockers = (lines || []).filter((line) => /(status\s*:\s*blocked|\bblocker\b|\bblocked\b|\bstuck\b|waiting on|need .* from|cannot\b|can't\b|unable to|dependency|failing|failure|error)/i.test(line))
		.filter((line) => !/^if you are blocked/i.test(line))
		.filter((line) => !/^known blockers/i.test(line));
	return blockers.slice(0, 4);
}

export function looksLikeNoisyTerminalCapture(text?: string | null) {
	const raw = String(text || "").trim();
	if (!raw) return true;
	const semantic = semanticCaptureText(raw).trim();
	if (!semantic) return true;
	const meaningful = hasStructuredAgentResponse(semantic);
	const noiseSignals = [
		/NY\/MIA/i,
		/\bLSP\s+\w+/i,
		/\$\d+(?:\.\d+)?/,
		/[↑↓]\d/,
		/working\.\.\./i,
		/────────────────|════|│/,
	].filter((pattern) => pattern.test(raw)).length;
	if (meaningful && noiseSignals < 2) return false;
	return semantic.length < 48 || noiseSignals >= 2;
}

export function selectBestCaptureText(screenText?: string | null, sessionAssistantText?: string | null) {
	const screen = String(screenText || "").trim();
	const session = String(sessionAssistantText || "").trim();
	if (!session) return { text: screen, source: "screen" as const };
	if (!screen) return { text: session, source: "session" as const };
	const screenSemantic = semanticCaptureText(screen).trim();
	const sessionSemantic = semanticCaptureText(session).trim();
	const screenLooksStructured = hasStructuredAgentResponse(screenSemantic || screen);
	const sessionLooksStructured = hasStructuredAgentResponse(sessionSemantic || session);
	if (screenLooksStructured && !sessionLooksStructured) return { text: screen, source: "screen" as const };
	if (sessionLooksStructured && !screenLooksStructured) return { text: session, source: "session" as const };
	const preferSession = looksLikeNoisyTerminalCapture(screen) || (sessionLooksStructured && sessionSemantic.length >= Math.max(24, screenSemantic.length));
	return preferSession
		? { text: session, source: "session" as const }
		: { text: screen, source: "screen" as const };
}

function splitDependencyClauses(value: string) {
	return String(value || "")
		.split(/\r?\n|[;•]+|\s+\|\s+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function inferDependencyKind(text: string) {
	const normalized = String(text || "").toLowerCase();
	if (/(blocked by|waiting on|depends on|dependency)/.test(normalized)) return "blocked_by";
	if (/(review|approval|sign-?off)/.test(normalized)) return "review";
	if (/(handoff|handover|relay)/.test(normalized)) return "handoff";
	if (/(need .* from|needs .* from|need .* peer|needs .* peer)/.test(normalized)) return "needs_peer";
	return "dependency";
}

function inferDependencyTargetHint(text: string) {
	const patterns = [
		/blocked by\s+([a-z0-9._/-]+)/i,
		/waiting on\s+([a-z0-9._/-]+)/i,
		/depends on\s+([a-z0-9._/-]+)/i,
		/need(?:s)?\s+.+?\s+from\s+([a-z0-9._/-]+)/i,
		/handoff(?:ed)?\s+(?:to|from)\s+([a-z0-9._/-]+)/i,
		/review(?:ed)?\s+by\s+([a-z0-9._/-]+)/i,
	];
	for (const pattern of patterns) {
		const match = String(text || "").match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
}

export function extractDependencySignals(text: string, report: Record<string, string> = {}, limit = 8) {
	const candidates = uniqueStrings([
		...splitDependencyClauses(report.needs_from_peers || ""),
		...splitDependencyClauses(report.risks || ""),
		...splitDependencyClauses(report.blockers || ""),
		...blockerSignals(recentNonEmptyLines(text, 10)),
		...String(text || "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /(waiting on|need .* from|needs .* from|blocked by|depends on|dependency|handoff|review by|approval from)/i.test(line)),
	])
		.filter((line) => !/^if you are blocked/i.test(line))
		.filter((line) => !/^known blockers/i.test(line));
	return candidates.slice(0, limit).map((item) => {
		const normalized = String(item || "").toLowerCase();
		const status = /(resolved|unblocked|received|done|complete|closed)/.test(normalized) ? "resolved" : "open";
		const kind = inferDependencyKind(item);
		const targetHint = inferDependencyTargetHint(item);
		const blocked = /(blocked by|waiting on|depends on|dependency|need .* from|needs .* from)/.test(normalized);
		return {
			kind,
			text: summarize(item, 180),
			targetHint,
			status,
			blocked,
			requiresAck: blocked || kind === "review",
		};
	});
}

export function buildCaptureDigest(capture: any) {
	const recent = recentNonEmptyLines(capture.text, 6);
	const structured = hasStructuredAgentResponse(capture.text || recent.join("\n"));
	const report = parseStructuredAgentReport(capture.text || recent.join("\n"));
	const reportBlockers = splitStructuredFieldItems(report.blockers || "", 8).filter((item) => !isNoneLikeText(item));
	const blockers = uniqueStrings([...blockerSignals(recent), ...reportBlockers]).slice(0, 8);
	const semantic = semanticCaptureText(capture.text || "") || String(capture.text || "");
	const noisy = looksLikeNoisyTerminalCapture(capture.text || "");
	const meaningfulNonStructured = /(Error:|Command exited with code|No such file or directory|Unknown cmux Pi team|Traceback|Exception)/i.test(String(capture.text || ""));
	const inferredStatus = inferAgentStatusFromText(capture.text || recent.join("\n"));
	const status = !structured && noisy && !meaningfulNonStructured ? "working" : inferredStatus;
	const hash = createHash("sha1").update(semantic).digest("hex").slice(0, 12);
	const artifacts = uniqueStrings([
		...(extractArtifactPaths(capture.text || "", 16)),
		...(extractArtifactPaths(report.files_areas_changed || report.files || "", 16)),
		...(extractArtifactPaths(report.artifacts || "", 16)),
		...(extractArtifactPaths(report.changes_areas_to_review || report.key_changes || "", 16)),
	]);
	const urls = uniqueStrings([...(extractUrls(capture.text || "", 16)), ...(extractUrls(report.urls || "", 16))]);
	const commands = uniqueStrings([...(extractCommands(capture.text || "", 16)), ...(extractCommands(report.commands_run || report.commands || "", 16))]);
	const deliverable = report.deliverable || report.deliverables || report.handoff || report.result || null;
	const completion = status === "done" || Boolean(deliverable) || /(complete|completed|done)/.test(structuredStatusValue(report));
	const dependencies = extractDependencySignals(capture.text || recent.join("\n"), report, 8);
	return {
		team: capture.team || null,
		alias: capture.alias || capture.surface || "unknown-agent",
		role: capture.role || "agent",
		surface: capture.surface || null,
		report,
		confidence: report.confidence || null,
		next: structuredNextValue(report) || null,
		needs: structuredNeedsValue(report) || null,
		requestsToSwarm: report.requests_to_swarm || report.requests || null,
		nextOrchestratorAction: report.next_orchestrator_action || null,
		status,
		hash,
		artifacts,
		urls,
		commands,
		deliverable,
		completion,
		dependencies,
		summary: summarize((structuredSummaryValue(report) || (structured ? recent.join(" | ") : "Awaiting structured agent output.")), 240) || "No recent output captured.",
		recent,
		blocked: structured ? (blockers.length > 0 || status === "blocked") : (meaningfulNonStructured && status === "blocked"),
		blockers: structured ? blockers : reportBlockers,
	};
}
