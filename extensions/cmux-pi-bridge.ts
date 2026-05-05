/**
 * CMUX PI Bridge — Links Pi agent sessions to cmux workspaces and surfaces, recording structured events, status snapshots, and routing metadata for bridge-aware orchestration.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extractApprovalCandidateFromToolEvent, extractBridgeHintsFromText, candidateExcerpt } from "../lib/cmux-ops-hooks.ts";
import { extractArtifactPaths, extractCommands, extractUrls, uniqueStrings as uniqueAnalysisStrings } from "../lib/cmux-orchestrator-analysis.ts";

function nowIso() {
	return new Date().toISOString();
}

function safeSegment(value: unknown, fallback = "item") {
	const text = String(value ?? fallback)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return text || fallback;
}

function shortText(value: unknown, max = 240) {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentPreview(content: any, max = 240) {
	if (!Array.isArray(content)) return shortText(content, max);
	const text = content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			if (item.type === "text") return item.text || "";
			if (item.type === "image") return "[image]";
			if (item.type === "toolCall") return `[tool:${item.name || "unknown"}]`;
			if (item.type === "thinking") return "[thinking]";
			return item.type ? `[${item.type}]` : "";
		})
		.filter(Boolean)
		.join(" ");
	return shortText(text, max);
}

function assistantSummary(messages: any[] = []) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const preview = contentPreview(message.content, 280);
		if (preview) return preview;
	}
	return "";
}

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function contextUsageSnapshot(ctx: any) {
	try {
		const usage = ctx.getContextUsage?.();
		if (!usage) return null;
		return {
			tokens: usage.tokens ?? null,
			contextWindow: usage.contextWindow ?? null,
			percent: usage.percent ?? null,
		};
	} catch {
		return null;
	}
}

function modelSnapshot(ctx: any) {
	const model = ctx.model;
	if (!model) return null;
	return {
		provider: model.provider ?? null,
		id: model.id ?? null,
		reasoning: Boolean(model.reasoning),
	};
}

function cmuxEnvSnapshot() {
	const env = process.env;
	return {
		workspaceId: env.CMUX_WORKSPACE_ID || null,
		surfaceId: env.CMUX_SURFACE_ID || null,
		tabId: env.CMUX_TAB_ID || null,
		panelId: env.CMUX_PANEL_ID || null,
		socketPath: env.CMUX_SOCKET_PATH || env.CMUX_SOCKET || null,
		port: env.CMUX_PORT || null,
		portEnd: env.CMUX_PORT_END || null,
		portRange: env.CMUX_PORT_RANGE || null,
		kbTaskId: env.KB_TASK_ID || env.CMUX_KB_TASK_ID || env.PI_TASK_ID || null,
		runId: env.PI_CMUX_RUN_ID || env.CMUX_RUN_ID || null,
		teamId: env.PI_CMUX_TEAM_ID || env.CMUX_TEAM_ID || null,
		agentId: env.PI_CMUX_AGENT_ID || env.CMUX_AGENT_ID || null,
		agentAlias: env.PI_CMUX_AGENT_ALIAS || env.CMUX_AGENT_ALIAS || null,
		role: env.PI_CMUX_ROLE || null,
		launcher: env.PI_CMUX_LAUNCHER || null,
		launchMode: env.PI_CMUX_LAUNCH_MODE || null,
		interfaceMode: env.PI_INTERFACE || env.PI_CMUX_INTERFACE || null,
	};
}

function bridgeRoot(input?: string) {
	return resolve(input || process.env.PI_CMUX_BRIDGE_DIR || join(homedir(), ".pi", "agent", ".cmux-pi"));
}

function bridgePaths(root: string, sessionId: string) {
	const sessionKey = safeSegment(sessionId, "session");
	const sessionDir = join(root, "sessions", sessionKey);
	return {
		root,
		sessionDir,
		eventsPath: join(sessionDir, "events.jsonl"),
		statusPath: join(sessionDir, "status.json"),
	};
}

async function ensureDir(path: string) {
	await fs.mkdir(path, { recursive: true });
}

async function readJson(path: string, fallback: any) {
	try {
		return JSON.parse(await fs.readFile(path, "utf-8"));
	} catch {
		return fallback;
	}
}

async function writeJson(path: string, value: unknown) {
	await ensureDir(resolve(path, ".."));
	await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function appendJsonl(path: string, value: unknown) {
	await ensureDir(resolve(path, ".."));
	await fs.appendFile(path, JSON.stringify(value) + "\n", "utf-8");
}

function compactBridgeValue(value: any, depth = 0): any {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return shortText(value, 1_200);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 3) {
		try {
			return shortText(JSON.stringify(value), 1_200);
		} catch {
			return "[complex value]";
		}
	}
	if (Array.isArray(value)) {
		const items = value.slice(0, 20).map((item) => compactBridgeValue(item, depth + 1));
		if (value.length > 20) items.push(`[+${value.length - 20} more items]`);
		return items;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).slice(0, 30).map(([key, item]) => [key, compactBridgeValue(item, depth + 1)]);
		const next = Object.fromEntries(entries);
		if (Object.keys(value).length > 30) next.__truncatedKeys = Object.keys(value).length - 30;
		return next;
	}
	return shortText(String(value), 1_200);
}

function bridgeArtifactSignals(payload: any = {}) {
	const text = [
		payload.summary,
		payload.promptPreview,
		payload.contentPreview,
		typeof payload.command === "string" ? payload.command : null,
		typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input || {}),
		typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details || {}),
	].filter(Boolean).join("\n");
	return {
		artifactPaths: uniqueAnalysisStrings(extractArtifactPaths(text, 24)).slice(0, 24),
		urls: uniqueAnalysisStrings(extractUrls(text, 16)).slice(0, 16),
		commands: uniqueAnalysisStrings(extractCommands(text, 16)).slice(0, 16),
	};
}

function mergeSignalLists(current: any, next: any, limit = 24) {
	return uniqueAnalysisStrings([...(current || []), ...(next || [])]).slice(0, limit);
}

function bridgeIndexPath(root: string) {
	return join(root, "index.json");
}

function bridgePolicyPath(root: string) {
	return join(root, "policy.json");
}

function optionalPositiveNumber(value: unknown) {
	const num = Number(value);
	return Number.isFinite(num) && num > 0 ? num : null;
}

function formatBytes(value: unknown) {
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0) return "—";
	if (num < 1024) return `${Math.round(num)} B`;
	if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
	if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
	return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function readBridgePolicy(root: string) {
	const current = await readJson(bridgePolicyPath(root), null);
	return {
		version: 2,
		autoPruneEnabled: current?.autoPruneEnabled !== false,
		maxAgeHours: Math.max(1, Number(current?.maxAgeHours || 72)),
		pruneEveryEvents: Math.max(10, Number(current?.pruneEveryEvents || 100)),
		maxSessions: optionalPositiveNumber(current?.maxSessions),
		maxTotalBytes: optionalPositiveNumber(current?.maxTotalBytes),
		maxSessionBytes: optionalPositiveNumber(current?.maxSessionBytes),
	};
}

async function writeBridgePolicy(root: string, patch: any = {}) {
	const current = await readBridgePolicy(root);
	const next = {
		...current,
		version: 2,
		autoPruneEnabled: typeof patch?.autoPruneEnabled === "boolean" ? patch.autoPruneEnabled : current.autoPruneEnabled,
		maxAgeHours: Math.max(1, Number(patch?.maxAgeHours ?? current.maxAgeHours ?? 72)),
		pruneEveryEvents: Math.max(10, Number(patch?.pruneEveryEvents ?? current.pruneEveryEvents ?? 100)),
		maxSessions: patch?.maxSessions === null ? null : optionalPositiveNumber(patch?.maxSessions ?? current.maxSessions),
		maxTotalBytes: patch?.maxTotalBytes === null ? null : optionalPositiveNumber(patch?.maxTotalBytes ?? current.maxTotalBytes),
		maxSessionBytes: patch?.maxSessionBytes === null ? null : optionalPositiveNumber(patch?.maxSessionBytes ?? current.maxSessionBytes),
	};
	await writeJson(bridgePolicyPath(root), next);
	return next;
}

function bridgeIndexEntry(status: any, paths: { eventsPath: string; statusPath: string }, extras: { sizeBytes?: number | null } = {}) {
	const age = eventAgeSummary(status?.lastEventAt);
	return {
		schemaVersion: 2,
		sessionId: status?.sessionId || null,
		cwd: status?.cwd || null,
		lastEventType: status?.lastEventType || null,
		lastEventAt: status?.lastEventAt || null,
		eventCount: status?.eventCount || 0,
		lastSummary: status?.lastSummary || null,
		workspaceId: status?.cmux?.workspaceId || status?.identity?.workspace_id || null,
		surfaceId: status?.cmux?.surfaceId || status?.identity?.surface_id || null,
		taskId: status?.cmux?.kbTaskId || status?.identity?.task_id || null,
		runId: status?.cmux?.runId || status?.identity?.run_id || null,
		teamId: status?.cmux?.teamId || status?.identity?.team_id || null,
		agentAlias: status?.cmux?.agentAlias || status?.identity?.agent_alias || null,
		role: status?.cmux?.role || null,
		launcher: status?.cmux?.launcher || null,
		launchMode: status?.cmux?.launchMode || null,
		interfaceMode: status?.cmux?.interfaceMode || status?.identity?.interface_mode || null,
		model: status?.model || null,
		artifactPaths: status?.artifactSignals?.artifactPaths || [],
		urls: status?.artifactSignals?.urls || [],
		commands: status?.artifactSignals?.commands || [],
		artifactCounts: {
			artifactPaths: (status?.artifactSignals?.artifactPaths || []).length,
			urls: (status?.artifactSignals?.urls || []).length,
			commands: (status?.artifactSignals?.commands || []).length,
		},
		stale: age.stale,
		ageMinutes: age.ageMinutes,
		sizeBytes: optionalPositiveNumber(extras.sizeBytes) || null,
		eventsPath: paths.eventsPath,
		statusPath: paths.statusPath,
		updatedAt: nowIso(),
	};
}

async function updateBridgeIndex(root: string, status: any, paths: { eventsPath: string; statusPath: string }) {
	const current = await readJson(bridgeIndexPath(root), { version: 2, updatedAt: null, sessions: [] });
	let sizeBytes: number | null = null;
	try {
		sizeBytes = await directorySizeBytes(resolve(paths.statusPath, ".."));
	} catch {
		sizeBytes = null;
	}
	const entry = bridgeIndexEntry(status, paths, { sizeBytes });
	const sessions = [entry, ...((current.sessions || []).filter((item: any) => item.sessionId !== entry.sessionId))].slice(0, 500);
	await writeJson(bridgeIndexPath(root), {
		version: 2,
		updatedAt: nowIso(),
		sessions,
	});
}

async function directorySizeBytes(path: string): Promise<number> {
	let stat: any;
	try {
		stat = await fs.stat(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return Number(stat.size || 0);
	let total = 0;
	const entries = await fs.readdir(path, { withFileTypes: true }).catch(() => [] as any[]);
	for (const entry of entries) {
		total += await directorySizeBytes(join(path, entry.name));
	}
	return total;
}

async function rebuildBridgeIndex(root: string) {
	const sessions = await listBridgeSessions(root, 1_000, true);
	await writeJson(bridgeIndexPath(root), {
		version: 2,
		updatedAt: nowIso(),
		sessions: sessions.map((entry: any) => bridgeIndexEntry(entry.status, entry.paths, { sizeBytes: entry.sizeBytes })).slice(0, 500),
	});
	return sessions;
}

async function doctorBridgeIndex(root: string) {
	const index = await readJson(bridgeIndexPath(root), { version: 2, updatedAt: null, sessions: [] });
	const sessions = await listBridgeSessions(root, 1_000, true);
	const indexed = Array.isArray(index?.sessions) ? index.sessions : [];
	const indexedById = new Map(indexed.filter((entry: any) => entry?.sessionId).map((entry: any) => [entry.sessionId, entry]));
	const liveById = new Map(sessions.filter((entry: any) => entry?.sessionId).map((entry: any) => [entry.sessionId, entry]));
	const missingFromIndex = sessions.filter((entry: any) => !indexedById.has(entry.sessionId)).map((entry: any) => entry.sessionId);
	const staleIndexEntries = indexed.filter((entry: any) => !liveById.has(entry.sessionId)).map((entry: any) => entry.sessionId);
	const mismatches = sessions.flatMap((entry: any) => {
		const indexedEntry = indexedById.get(entry.sessionId);
		if (!indexedEntry) return [];
		const issues = [] as string[];
		if (String(indexedEntry.lastEventAt || "") !== String(entry.status?.lastEventAt || "")) issues.push("lastEventAt");
		if (Number(indexedEntry.eventCount || 0) !== Number(entry.status?.eventCount || 0)) issues.push("eventCount");
		if (Number(indexedEntry.sizeBytes || 0) !== Number(entry.sizeBytes || 0)) issues.push("sizeBytes");
		return issues.length ? [{ sessionId: entry.sessionId, issues }] : [];
	});
	const indexAge = eventAgeSummary(index?.updatedAt || null);
	const coveragePct = sessions.length ? Math.round(((indexed.length || 0) / sessions.length) * 100) : (indexed.length ? 100 : 0);
	const ok = !missingFromIndex.length && !staleIndexEntries.length && !mismatches.length;
	return {
		root,
		ok,
		indexUpdatedAt: index?.updatedAt || null,
		indexAgeMinutes: indexAge.ageMinutes,
		indexedCount: indexed.length,
		liveSessionCount: sessions.length,
		coveragePct,
		missingFromIndex,
		staleIndexEntries,
		mismatches,
	};
}

function eventAgeSummary(timestamp?: string | null) {
	if (!timestamp) return { ageMs: null, ageMinutes: null, stale: null };
	const ageMs = Date.now() - new Date(timestamp).getTime();
	if (!Number.isFinite(ageMs)) return { ageMs: null, ageMinutes: null, stale: null };
	const ageMinutes = Math.round(ageMs / 60_000);
	return {
		ageMs,
		ageMinutes,
		stale: ageMs > 15 * 60_000,
	};
}

function summarizeBridgeWindow(events: any[] = []) {
	const typeCounts = new Map<string, number>();
	const recentTools = [] as string[];
	let toolCallCount = 0;
	let toolFailureCount = 0;
	let contractWarningCount = 0;
	let hintCount = 0;
	for (const event of events) {
		const type = String(event?.type || event?.event_type || "unknown");
		typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
		if (event?.event_contract_valid === false) contractWarningCount += 1;
		if (type.includes("hint_")) hintCount += 1;
		if (type === "tool_call") toolCallCount += 1;
		if (type === "tool_result" && event?.payload?.isError) toolFailureCount += 1;
		const toolName = String(event?.payload?.toolName || "").trim();
		if (toolName && !recentTools.includes(toolName)) recentTools.push(toolName);
	}
	return {
		eventCount: events.length,
		toolCallCount,
		toolFailureCount,
		contractWarningCount,
		hintCount,
		recentTools: recentTools.slice(0, 6),
		typeCounts: Array.from(typeCounts.entries())
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 8)
			.map(([type, count]) => ({ type, count })),
	};
}

function renderBridgeRouting(identity: ReturnType<typeof bridgeSessionIdentity>) {
	return `task=${identity.taskId || "—"} run=${identity.runId || "—"} team=${identity.teamId || "—"} agent=${identity.agentAlias || "—"}`;
}

async function listBridgeSessions(root: string, limit = 10, includeSize = false) {
	const sessionsDir = join(root, "sessions");
	let names: string[] = [];
	try {
		names = await fs.readdir(sessionsDir);
	} catch {
		return [] as any[];
	}
	const entries = await Promise.all(
		names.map(async (name) => {
			const paths = bridgePaths(root, name);
			const status = await readJson(paths.statusPath, null);
			if (!status) return null;
			const age = eventAgeSummary(status.lastEventAt);
			const sizeBytes = includeSize ? await directorySizeBytes(paths.sessionDir).catch(() => 0) : null;
			return {
				sessionId: status.sessionId || name,
				paths,
				status,
				age,
				sizeBytes,
			};
		}),
	);
	return entries
		.filter(Boolean)
		.sort((a: any, b: any) => String(b?.status?.lastEventAt || "").localeCompare(String(a?.status?.lastEventAt || "")))
		.slice(0, Math.max(1, Math.min(1000, Number(limit || 10))));
}

function bridgeSessionIdentity(status: any = {}) {
	return {
		taskId: status?.cmux?.kbTaskId || status?.identity?.task_id || null,
		runId: status?.cmux?.runId || status?.identity?.run_id || null,
		teamId: status?.cmux?.teamId || status?.identity?.team_id || null,
		agentAlias: status?.cmux?.agentAlias || status?.identity?.agent_alias || null,
		workspaceId: status?.cmux?.workspaceId || status?.identity?.workspace_id || null,
		surfaceId: status?.cmux?.surfaceId || status?.identity?.surface_id || null,
		launcher: status?.cmux?.launcher || null,
		interfaceMode: status?.cmux?.interfaceMode || status?.identity?.interface_mode || null,
		role: status?.cmux?.role || null,
	};
}

function matchesBridgeFilter(actual: unknown, expected: unknown) {
	if (expected === undefined || expected === null || expected === "") return true;
	return String(actual ?? "") === String(expected);
}

function hasBridgeSessionFilters(filters: any = {}) {
	return ["sessionId", "taskId", "runId", "teamId", "agentAlias", "workspaceId", "surfaceId", "launcher", "interfaceMode", "role"].some((key) => filters?.[key] !== undefined && filters?.[key] !== null && filters?.[key] !== "") || Boolean(filters?.staleOnly);
}

function matchesBridgeSessionFilters(entry: any, filters: any = {}) {
	const identity = bridgeSessionIdentity(entry?.status);
	if (!matchesBridgeFilter(entry?.sessionId, filters.sessionId)) return false;
	if (!matchesBridgeFilter(identity.taskId, filters.taskId)) return false;
	if (!matchesBridgeFilter(identity.runId, filters.runId)) return false;
	if (!matchesBridgeFilter(identity.teamId, filters.teamId)) return false;
	if (!matchesBridgeFilter(identity.agentAlias, filters.agentAlias)) return false;
	if (!matchesBridgeFilter(identity.workspaceId, filters.workspaceId)) return false;
	if (!matchesBridgeFilter(identity.surfaceId, filters.surfaceId)) return false;
	if (!matchesBridgeFilter(identity.launcher, filters.launcher)) return false;
	if (!matchesBridgeFilter(identity.interfaceMode, filters.interfaceMode)) return false;
	if (!matchesBridgeFilter(identity.role, filters.role)) return false;
	if (filters.staleOnly && !entry?.age?.stale) return false;
	return true;
}

async function readJsonlTail(path: string, limit = 20) {
	try {
		const text = await fs.readFile(path, "utf-8");
		return text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(5_000, Number(limit || 20))))
			.map((line) => parseJson(line) ?? { raw: line });
	} catch {
		return [] as any[];
	}
}

function matchesBridgeEventFilters(event: any, filters: any = {}) {
	if (!matchesBridgeFilter(event?.sessionId || event?.session_id, filters.sessionId)) return false;
	if (!matchesBridgeFilter(event?.type || event?.event_type, filters.type)) return false;
	if (!matchesBridgeFilter(event?.task_id, filters.taskId)) return false;
	if (!matchesBridgeFilter(event?.run_id, filters.runId)) return false;
	if (!matchesBridgeFilter(event?.team_id, filters.teamId)) return false;
	if (!matchesBridgeFilter(event?.agent_alias, filters.agentAlias)) return false;
	if (!matchesBridgeFilter(event?.workspace_id, filters.workspaceId)) return false;
	if (!matchesBridgeFilter(event?.surface_id, filters.surfaceId)) return false;
	if (!matchesBridgeFilter(event?.cmux?.launcher || event?.payload?.launcher, filters.launcher)) return false;
	if (!matchesBridgeFilter(event?.interface_mode || event?.cmux?.interfaceMode, filters.interfaceMode)) return false;
	return true;
}

async function listBridgeEvents(root: string, options: any = {}) {
	let sessions: any[] = [];
	if (options.sessionId) {
		const paths = bridgePaths(root, options.sessionId);
		const status = await readJson(paths.statusPath, null);
		if (status) sessions = [{ sessionId: status.sessionId || options.sessionId, paths, status, age: eventAgeSummary(status.lastEventAt), sizeBytes: null }];
	} else {
		const sessionScanLimit = Math.max(1, Math.min(1000, Number(options.sessionScanLimit || 250)));
		sessions = await listBridgeSessions(root, sessionScanLimit, false);
	}
	sessions = sessions.filter((entry: any) => matchesBridgeSessionFilters(entry, options));
	const perSessionLimit = Math.max(10, Math.min(500, Number(options.perSessionLimit || Math.max((options.limit || 20) * 3, 40))));
	const events = [] as any[];
	for (const session of sessions) {
		const items = await readJsonlTail(session.paths.eventsPath, perSessionLimit);
		for (const item of items) {
			const event = { ...item, sessionId: item?.sessionId || item?.session_id || session.sessionId };
			if (!matchesBridgeEventFilters(event, options)) continue;
			events.push(event);
		}
	}
	return events
		.sort((a: any, b: any) => String(b?.timestamp || "").localeCompare(String(a?.timestamp || "")) || Number(b?.sequence || 0) - Number(a?.sequence || 0))
		.slice(0, Math.max(1, Math.min(1000, Number(options.limit || 20))));
}

async function pruneBridgeSessions(root: string, options: { maxAgeHours?: number; maxSessions?: number | null; maxTotalBytes?: number | null; maxSessionBytes?: number | null; keepSessionIds?: string[]; dryRun?: boolean } = {}) {
	const sessions = await listBridgeSessions(root, 1_000, true);
	const thresholdMs = Math.max(1, Number(options.maxAgeHours || 72)) * 60 * 60 * 1000;
	const maxSessions = optionalPositiveNumber(options.maxSessions);
	const maxTotalBytes = optionalPositiveNumber(options.maxTotalBytes);
	const maxSessionBytes = optionalPositiveNumber(options.maxSessionBytes);
	const keep = new Set((options.keepSessionIds || []).filter(Boolean));
	const orderedOldestFirst = [...sessions].sort((a: any, b: any) => Number(a?.age?.ageMs || 0) - Number(b?.age?.ageMs || 0)).reverse();
	const reasonsBySession = new Map<string, Set<string>>();
	const byId = new Map<string, any>(sessions.map((entry: any) => [entry.sessionId, entry]));
	const retained = new Set(sessions.map((entry: any) => entry.sessionId));
	let retainedBytes = sessions.reduce((sum: number, entry: any) => sum + Number(entry.sizeBytes || 0), 0);
	const mark = (entry: any, reason: string) => {
		if (!entry?.sessionId || keep.has(entry.sessionId) || !retained.has(entry.sessionId)) return;
		retained.delete(entry.sessionId);
		retainedBytes -= Number(entry.sizeBytes || 0);
		const current = reasonsBySession.get(entry.sessionId) || new Set<string>();
		current.add(reason);
		reasonsBySession.set(entry.sessionId, current);
	};
	for (const entry of orderedOldestFirst) {
		if (Number(entry?.age?.ageMs || 0) >= thresholdMs) mark(entry, "age");
		if (maxSessionBytes && Number(entry?.sizeBytes || 0) > maxSessionBytes) mark(entry, "session-size-cap");
	}
	if (maxSessions) {
		for (const entry of orderedOldestFirst) {
			if (retained.size <= maxSessions) break;
			mark(entry, "count-cap");
		}
	}
	if (maxTotalBytes) {
		for (const entry of orderedOldestFirst) {
			if (retainedBytes <= maxTotalBytes) break;
			mark(entry, "size-cap");
		}
	}
	const candidates = Array.from(reasonsBySession.entries()).map(([sessionId, reasons]) => ({
		...(byId.get(sessionId) || { sessionId }),
		reasons: Array.from(reasons),
	}));
	if (!options.dryRun) {
		for (const entry of candidates) {
			await fs.rm(entry.paths.sessionDir, { recursive: true, force: true }).catch(() => null);
		}
		await rebuildBridgeIndex(root).catch(() => null);
	}
	return {
		thresholdHours: thresholdMs / 3_600_000,
		maxSessions,
		maxTotalBytes,
		maxSessionBytes,
		totalBytesBefore: sessions.reduce((sum: number, entry: any) => sum + Number(entry.sizeBytes || 0), 0),
		totalBytesAfter: retainedBytes,
		retainedSessionCount: retained.size,
		candidates,
		removedCount: options.dryRun ? 0 : candidates.length,
		removedSessionIds: options.dryRun ? [] : candidates.map((entry: any) => entry.sessionId),
		wouldRemoveCount: candidates.length,
	};
}

const hintEventDedupe = new Map<string, number>();
const HINT_EVENT_DEDUPE_WINDOW_MS = 3 * 60 * 1000;

function safeSessionId(ctx: any) {
	try {
		return ctx?.sessionManager?.getSessionId?.() || null;
	} catch {
		return null;
	}
}

function hintEventKey(ctx: any, type: string, payload: Record<string, unknown> = {}) {
	const sessionId = safeSessionId(ctx);
	if (!sessionId) return null;
	return [
		sessionId,
		type,
		String(payload.sourceEventType || ""),
		String(payload.toolName || ""),
		shortText(payload.summary, 180).toLowerCase(),
		shortText(payload.excerpt, 180).toLowerCase(),
	].join("|");
}

async function writeHintBridgeEvent(ctx: any, type: string, payload: Record<string, unknown> = {}, rootOverride?: string) {
	const now = Date.now();
	for (const [key, timestamp] of hintEventDedupe.entries()) {
		if (now - timestamp > HINT_EVENT_DEDUPE_WINDOW_MS) hintEventDedupe.delete(key);
	}
	const key = hintEventKey(ctx, type, payload);
	if (!key) return null;
	const lastSeen = hintEventDedupe.get(key) || 0;
	if (now - lastSeen < HINT_EVENT_DEDUPE_WINDOW_MS) return null;
	hintEventDedupe.set(key, now);
	return writeBridgeEvent(ctx, type, payload, rootOverride);
}

async function writeBridgeEvent(ctx: any, type: string, payload: Record<string, unknown> = {}, rootOverride?: string) {
	const sessionId = safeSessionId(ctx);
	if (!sessionId) return null;
	const root = bridgeRoot(rootOverride);
	const paths = bridgePaths(root, sessionId);
	const usage = contextUsageSnapshot(ctx);
	const cmux = cmuxEnvSnapshot();
	const model = modelSnapshot(ctx);
	const current = await readJson(paths.statusPath, {
		version: 2,
		schemaVersion: 2,
		sessionId,
		cwd: ctx.cwd,
		createdAt: nowIso(),
		eventCount: 0,
		lastSequence: 0,
		lastEventType: null,
		lastEventAt: null,
		lastSummary: null,
		model: null,
		contextUsage: null,
		cmux: null,
		artifactSignals: { artifactPaths: [], urls: [], commands: [] },
	});
	const sequence = Number(current.lastSequence || current.eventCount || 0) + 1;
	const sanitizedPayload = compactBridgeValue(payload);
	const artifactSignals = bridgeArtifactSignals(payload);
	const event = {
		version: 2,
		schemaVersion: 2,
		timestamp: nowIso(),
		sequence,
		type,
		event_type: type,
		sessionId,
		session_id: sessionId,
		cwd: ctx.cwd,
		task_id: cmux.kbTaskId,
		run_id: cmux.runId,
		team_id: cmux.teamId,
		agent_id: cmux.agentId,
		agent_alias: cmux.agentAlias,
		workspace_id: cmux.workspaceId,
		surface_id: cmux.surfaceId,
		interface_mode: cmux.interfaceMode || "terminal",
		model,
		contextUsage: usage,
		context_usage: usage,
		cmux,
		artifactSignals,
		payload: sanitizedPayload,
	};
	await appendJsonl(paths.eventsPath, event);
	current.updatedAt = nowIso();
	current.version = 2;
	current.schemaVersion = 2;
	current.session_id = sessionId;
	current.eventCount = Number(current.eventCount || 0) + 1;
	current.event_count = current.eventCount;
	current.lastSequence = sequence;
	current.last_sequence = sequence;
	current.lastEventType = type;
	current.last_event_type = type;
	current.lastEventAt = event.timestamp;
	current.last_event_at = event.timestamp;
	current.model = model;
	current.contextUsage = usage;
	current.context_usage = usage;
	current.cmux = cmux;
	current.identity = {
		task_id: cmux.kbTaskId,
		run_id: cmux.runId,
		team_id: cmux.teamId,
		agent_id: cmux.agentId,
		agent_alias: cmux.agentAlias,
		workspace_id: cmux.workspaceId,
		surface_id: cmux.surfaceId,
		interface_mode: cmux.interfaceMode || "terminal",
	};
	current.artifactSignals = {
		artifactPaths: mergeSignalLists(current.artifactSignals?.artifactPaths, artifactSignals.artifactPaths, 32),
		urls: mergeSignalLists(current.artifactSignals?.urls, artifactSignals.urls, 24),
		commands: mergeSignalLists(current.artifactSignals?.commands, artifactSignals.commands, 24),
	};
	if (typeof payload.summary === "string" && payload.summary.trim()) {
		current.lastSummary = payload.summary;
	}
	if (typeof payload.promptPreview === "string" && payload.promptPreview.trim()) {
		current.lastPromptPreview = payload.promptPreview;
	}
	current.lastPayload = sanitizedPayload;
	await writeJson(paths.statusPath, current);
	await updateBridgeIndex(root, current, paths).catch(() => null);
	const policy = await readBridgePolicy(root).catch(() => null);
	if (policy?.autoPruneEnabled && Number(current.eventCount || 0) % Number(policy.pruneEveryEvents || 100) === 0) {
		await pruneBridgeSessions(root, {
			maxAgeHours: policy.maxAgeHours,
			maxSessions: policy.maxSessions,
			maxTotalBytes: policy.maxTotalBytes,
			maxSessionBytes: policy.maxSessionBytes,
			dryRun: false,
			keepSessionIds: [sessionId],
		}).catch(() => null);
	}
	return { event, status: current, paths };
}

function ok(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await writeBridgeEvent(ctx, "session_start", {
			summary: "PI session started with CMUX bridge enabled.",
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await writeBridgeEvent(ctx, "session_shutdown", {
			summary: "PI session shut down with CMUX bridge enabled.",
		});
	});

	pi.on("before_agent_start", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "before_agent_start", {
			promptPreview: shortText(event.prompt, 280),
			imageCount: Array.isArray(event.images) ? event.images.length : 0,
			summary: shortText(event.prompt, 180) || "Agent start requested.",
		});
		return undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		await writeBridgeEvent(ctx, "agent_start", {
			summary: "Agent loop started.",
		});
	});

	pi.on("turn_start", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "turn_start", {
			turnIndex: event.turnIndex ?? null,
			timestampMs: event.timestamp ?? null,
			summary: `Turn ${event.turnIndex ?? "?"} started.`,
		});
	});

	pi.on("turn_end", async (event: any, ctx) => {
		const assistantPreview = contentPreview(event.message?.content, 280);
		await writeBridgeEvent(ctx, "turn_end", {
			turnIndex: event.turnIndex ?? null,
			toolCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
			summary: `Turn ${event.turnIndex ?? "?"} ended with ${Array.isArray(event.toolResults) ? event.toolResults.length : 0} tool result(s).`,
			assistantPreview,
		});
		const hints = extractBridgeHintsFromText(assistantPreview || "");
		for (const hint of hints) {
			await writeHintBridgeEvent(ctx, hint.type, {
				sourceEventType: "turn_end",
				turnIndex: event.turnIndex ?? null,
				summary: hint.summary,
				excerpt: candidateExcerpt(assistantPreview || ""),
			}).catch(() => null);
		}
	});

	pi.on("tool_call", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "tool_call", {
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			input: event.input ?? null,
			summary: `Tool call: ${event.toolName || "unknown"}`,
		});
		const approvalCandidate = extractApprovalCandidateFromToolEvent(event.toolName, event.input);
		if (approvalCandidate) {
			await writeHintBridgeEvent(ctx, approvalCandidate.type, {
				sourceEventType: "tool_call",
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? null,
				riskLevel: approvalCandidate.riskLevel || null,
				summary: approvalCandidate.summary,
				excerpt: candidateExcerpt(typeof event.input === "string" ? event.input : JSON.stringify(event.input || {})),
			}).catch(() => null);
		}
		return undefined;
	});

	pi.on("tool_result", async (event: any, ctx) => {
		const preview = contentPreview(event.content, 280);
		await writeBridgeEvent(ctx, "tool_result", {
			toolCallId: event.toolCallId ?? null,
			toolName: event.toolName ?? null,
			isError: Boolean(event.isError),
			contentPreview: preview,
			details: event.details ?? null,
			summary: `${event.toolName || "tool"} ${event.isError ? "failed" : "completed"}.`,
		});
		const resultHints = extractBridgeHintsFromText(preview || "");
		for (const hint of resultHints) {
			await writeHintBridgeEvent(ctx, hint.type, {
				sourceEventType: "tool_result",
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? null,
				summary: hint.summary,
				excerpt: candidateExcerpt(preview || ""),
			}).catch(() => null);
		}
		const approvalCandidate = extractApprovalCandidateFromToolEvent(event.toolName, null, preview);
		if (approvalCandidate) {
			await writeHintBridgeEvent(ctx, approvalCandidate.type, {
				sourceEventType: "tool_result",
				toolCallId: event.toolCallId ?? null,
				toolName: event.toolName ?? null,
				riskLevel: approvalCandidate.riskLevel || null,
				summary: approvalCandidate.summary,
				excerpt: candidateExcerpt(preview || ""),
			}).catch(() => null);
		}
		return undefined;
	});

	pi.on("model_select", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "model_select", {
			model: event.model ? { provider: event.model.provider ?? null, id: event.model.id ?? null } : null,
			previousModel: event.previousModel
				? { provider: event.previousModel.provider ?? null, id: event.previousModel.id ?? null }
				: null,
			source: event.source ?? null,
			summary: `Model selected: ${event.model?.provider || "unknown"}/${event.model?.id || "unknown"}`,
		});
	});

	pi.on("session_compact", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "session_compact", {
			fromExtension: Boolean(event.fromExtension),
			firstKeptEntryId: event.compactionEntry?.firstKeptEntryId ?? null,
			tokensBefore: event.compactionEntry?.tokensBefore ?? null,
			summary: shortText(event.compactionEntry?.summary, 180) || "Session compacted.",
		});
	});

	pi.on("user_bash", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "user_bash", {
			command: event.command ?? null,
			excludeFromContext: Boolean(event.excludeFromContext),
			cwd: event.cwd ?? null,
			summary: `User bash: ${shortText(event.command, 120)}`,
		});
		const approvalCandidate = extractApprovalCandidateFromToolEvent("user_bash", { command: event.command });
		if (approvalCandidate) {
			await writeHintBridgeEvent(ctx, approvalCandidate.type, {
				sourceEventType: "user_bash",
				summary: approvalCandidate.summary,
				riskLevel: approvalCandidate.riskLevel || null,
				excerpt: candidateExcerpt(event.command || ""),
			}).catch(() => null);
		}
		return undefined;
	});

	pi.on("agent_end", async (event: any, ctx) => {
		await writeBridgeEvent(ctx, "agent_end", {
			messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
			assistantSummary: assistantSummary(Array.isArray(event.messages) ? event.messages : []),
			summary: assistantSummary(Array.isArray(event.messages) ? event.messages : []) || "Agent loop ended.",
		});
	});

	pi.registerTool({
		name: "cmux_pi_bridge_status",
		label: "CMUX PI Bridge Status",
		description:
			"Show the current CMUX PI bridge paths, latest status snapshot, and local CMUX-aware session metadata written by the bridge extension.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
			sessionId: Type.Optional(Type.String({ description: "Optional explicit session id. Defaults to the current PI session id." })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const root = bridgeRoot(params.root);
			const sessionId = params.sessionId || ctx.sessionManager.getSessionId();
			const paths = bridgePaths(root, sessionId);
			const status = await readJson(paths.statusPath, null);
			const policy = await readBridgePolicy(root);
			const index = await readJson(bridgeIndexPath(root), null);
			const age = eventAgeSummary(status?.lastEventAt);
			const indexAge = eventAgeSummary(index?.updatedAt);
			const identity = bridgeSessionIdentity(status);
			const recentEvents = await readJsonlTail(paths.eventsPath, 40);
			const windowSummary = summarizeBridgeWindow(recentEvents);
			const text = [
				"# CMUX PI bridge status",
				"",
				`- root: ${root}`,
				`- sessionId: ${sessionId}`,
				`- eventsPath: ${paths.eventsPath}`,
				`- statusPath: ${paths.statusPath}`,
				`- statusPresent: ${status ? "yes" : "no"}`,
				status ? `- schemaVersion: ${status.schemaVersion || status.version || 1}` : null,
				status ? `- routing: ${renderBridgeRouting(identity)}` : null,
				status ? `- launcher: ${identity.launcher || "—"}` : null,
				status ? `- interfaceMode: ${identity.interfaceMode || "—"}` : null,
				status ? `- role: ${identity.role || "—"}` : null,
				status ? `- lastEventType: ${status.lastEventType || "—"}` : null,
				status ? `- lastEventAt: ${status.lastEventAt || "—"}` : null,
				status ? `- ageMinutes: ${age.ageMinutes ?? "—"}` : null,
				status ? `- stale: ${age.stale === null ? "—" : age.stale ? "yes" : "no"}` : null,
				status ? `- eventCount: ${status.eventCount || 0}` : null,
				status ? `- lastSummary: ${status.lastSummary || "—"}` : null,
				status?.lastEventContractValid === false ? `- lastEventContractWarning: ${status.lastEventContractWarning || "unknown event contract issue"}` : null,
				status?.cmux ? `- cmuxWorkspace: ${status.cmux.workspaceId || "—"}` : null,
				status?.cmux ? `- cmuxSurface: ${status.cmux.surfaceId || "—"}` : null,
				status?.model ? `- model: ${status.model.provider || "unknown"}/${status.model.id || "unknown"}` : null,
				status?.artifactSignals?.artifactPaths?.length ? `- artifactPaths: ${status.artifactSignals.artifactPaths.length}` : null,
				status?.artifactSignals?.urls?.length ? `- urls: ${status.artifactSignals.urls.length}` : null,
				status?.artifactSignals?.commands?.length ? `- commands: ${status.artifactSignals.commands.length}` : null,
				status?.artifactSignals?.artifactPaths?.length ? `- recentArtifactPaths: ${status.artifactSignals.artifactPaths.slice(0, 6).join(", ")}` : null,
				status?.artifactSignals?.urls?.length ? `- recentUrls: ${status.artifactSignals.urls.slice(0, 4).join(", ")}` : null,
				status?.artifactSignals?.commands?.length ? `- recentCommands: ${status.artifactSignals.commands.slice(0, 4).join(" | ")}` : null,
				`- recentWindowEvents: ${windowSummary.eventCount}`,
				`- recentToolCalls: ${windowSummary.toolCallCount}`,
				`- recentToolFailures: ${windowSummary.toolFailureCount}`,
				`- recentHints: ${windowSummary.hintCount}`,
				`- recentContractWarnings: ${windowSummary.contractWarningCount}`,
				windowSummary.recentTools.length ? `- recentTools: ${windowSummary.recentTools.join(", ")}` : null,
				windowSummary.typeCounts.length ? `- recentEventTypes: ${windowSummary.typeCounts.map((item) => `${item.type}=${item.count}`).join(", ")}` : null,
				`- policy.autoPruneEnabled: ${policy.autoPruneEnabled ? "yes" : "no"}`,
				`- policy.maxAgeHours: ${policy.maxAgeHours}`,
				`- policy.maxSessions: ${policy.maxSessions ?? "off"}`,
				`- policy.maxTotalBytes: ${policy.maxTotalBytes ? formatBytes(policy.maxTotalBytes) : "off"}`,
				`- policy.maxSessionBytes: ${policy.maxSessionBytes ? formatBytes(policy.maxSessionBytes) : "off"}`,
				`- index.updatedAt: ${index?.updatedAt || "—"}`,
				`- index.ageMinutes: ${indexAge.ageMinutes ?? "—"}`,
				`- index.sessions: ${Array.isArray(index?.sessions) ? index.sessions.length : 0}`,
			].filter(Boolean).join("\n");
			return ok(text, { root, sessionId, paths, status, age, identity, policy, index, indexAge, recentEvents, windowSummary });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_sessions",
		label: "CMUX PI Bridge Sessions",
		description: "List recent CMUX-aware PI bridge sessions with health, routing identity, and latest status summaries.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
			limit: Type.Optional(Type.Number({ description: "Maximum sessions to show. Default 10." })),
			sessionId: Type.Optional(Type.String({ description: "Optional exact session id filter." })),
			taskId: Type.Optional(Type.String({ description: "Optional KB task id filter." })),
			runId: Type.Optional(Type.String({ description: "Optional run id filter." })),
			teamId: Type.Optional(Type.String({ description: "Optional team id filter." })),
			agentAlias: Type.Optional(Type.String({ description: "Optional agent alias filter." })),
			workspaceId: Type.Optional(Type.String({ description: "Optional workspace id filter." })),
			surfaceId: Type.Optional(Type.String({ description: "Optional surface id filter." })),
			launcher: Type.Optional(Type.String({ description: "Optional launcher filter." })),
			interfaceMode: Type.Optional(Type.String({ description: "Optional interface-mode filter." })),
			role: Type.Optional(Type.String({ description: "Optional role filter." })),
			staleOnly: Type.Optional(Type.Boolean({ description: "Only return stale sessions." })),
		}),
		async execute(_toolCallId, params: any) {
			const root = bridgeRoot(params.root);
			const limit = params.limit || 10;
			const filters = {
				sessionId: params.sessionId,
				taskId: params.taskId,
				runId: params.runId,
				teamId: params.teamId,
				agentAlias: params.agentAlias,
				workspaceId: params.workspaceId,
				surfaceId: params.surfaceId,
				launcher: params.launcher,
				interfaceMode: params.interfaceMode,
				role: params.role,
				staleOnly: params.staleOnly,
			};
			const scanLimit = hasBridgeSessionFilters(filters) ? 1_000 : limit;
			const sessions = (await listBridgeSessions(root, scanLimit, true))
				.filter((entry: any) => matchesBridgeSessionFilters(entry, filters))
				.slice(0, Math.max(1, Math.min(1000, Number(limit || 10))));
			const sessionsWithWindow = await Promise.all(sessions.map(async (entry: any) => ({
				...entry,
				identity: bridgeSessionIdentity(entry.status),
				windowSummary: summarizeBridgeWindow(await readJsonlTail(entry.paths.eventsPath, 24)),
			})));
			const text = [
				"# CMUX PI bridge sessions",
				"",
				`- root: ${root}`,
				`- filters: ${JSON.stringify(filters)}`,
				`- sessions: ${sessionsWithWindow.length}`,
				...sessionsWithWindow.flatMap((entry: any) => [
					"",
					`## ${entry.sessionId}`,
					`- routing: ${renderBridgeRouting(entry.identity)}`,
					`- launcher: ${entry.identity.launcher || "—"}`,
					`- interfaceMode: ${entry.identity.interfaceMode || "—"}`,
					`- role: ${entry.identity.role || "—"}`,
					`- lastEventType: ${entry.status?.lastEventType || "—"}`,
					`- lastEventAt: ${entry.status?.lastEventAt || "—"}`,
					`- ageMinutes: ${entry.age?.ageMinutes ?? "—"}`,
					`- stale: ${entry.age?.stale ? "yes" : "no"}`,
					`- eventCount: ${entry.status?.eventCount || 0}`,
					`- summary: ${entry.status?.lastSummary || "—"}`,
					entry.status?.lastEventContractValid === false ? `- contractWarning: ${entry.status?.lastEventContractWarning || "unknown"}` : null,
					`- recentToolCalls: ${entry.windowSummary.toolCallCount}`,
					`- recentToolFailures: ${entry.windowSummary.toolFailureCount}`,
					entry.windowSummary.recentTools.length ? `- recentTools: ${entry.windowSummary.recentTools.join(", ")}` : null,
					entry.windowSummary.typeCounts.length ? `- recentEventTypes: ${entry.windowSummary.typeCounts.map((item: any) => `${item.type}=${item.count}`).join(", ")}` : null,
					entry.status?.artifactSignals?.artifactPaths?.length ? `- artifacts: ${entry.status.artifactSignals.artifactPaths.slice(0, 4).join(", ")}` : null,
					entry.status?.artifactSignals?.urls?.length ? `- urls: ${entry.status.artifactSignals.urls.slice(0, 3).join(", ")}` : null,
					entry.status?.artifactSignals?.commands?.length ? `- commands: ${entry.status.artifactSignals.commands.slice(0, 3).join(" | ")}` : null,
					`- workspace: ${entry.status?.cmux?.workspaceId || entry.status?.identity?.workspace_id || "—"}`,
					`- surface: ${entry.status?.cmux?.surfaceId || entry.status?.identity?.surface_id || "—"}`,
					`- model: ${entry.status?.model?.provider || "unknown"}/${entry.status?.model?.id || "unknown"}`,
					`- size: ${formatBytes(entry.sizeBytes)}`,
				]),
			].join("\n");
			return ok(text, { root, filters, sessions: sessionsWithWindow });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_events",
		label: "CMUX PI Bridge Events",
		description: "Show recent structured events from CMUX-aware PI bridge sessions for debugging and operator visibility.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
			sessionId: Type.Optional(Type.String({ description: "Optional explicit session id. Defaults to the current PI session id unless allSessions or other filters are set." })),
			allSessions: Type.Optional(Type.Boolean({ description: "Search across sessions instead of only the current session." })),
			limit: Type.Optional(Type.Number({ description: "How many recent events to show. Default 12." })),
			type: Type.Optional(Type.String({ description: "Optional event type filter such as tool_call or turn_end." })),
			taskId: Type.Optional(Type.String({ description: "Optional KB task id filter." })),
			runId: Type.Optional(Type.String({ description: "Optional run id filter." })),
			teamId: Type.Optional(Type.String({ description: "Optional team id filter." })),
			agentAlias: Type.Optional(Type.String({ description: "Optional agent alias filter." })),
			workspaceId: Type.Optional(Type.String({ description: "Optional workspace id filter." })),
			surfaceId: Type.Optional(Type.String({ description: "Optional surface id filter." })),
			launcher: Type.Optional(Type.String({ description: "Optional launcher filter." })),
			interfaceMode: Type.Optional(Type.String({ description: "Optional interface-mode filter." })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const root = bridgeRoot(params.root);
			const limit = params.limit || 12;
			const filters = {
				sessionId: params.sessionId,
				type: params.type,
				taskId: params.taskId,
				runId: params.runId,
				teamId: params.teamId,
				agentAlias: params.agentAlias,
				workspaceId: params.workspaceId,
				surfaceId: params.surfaceId,
				launcher: params.launcher,
				interfaceMode: params.interfaceMode,
			};
			const shouldSearchAcrossSessions = Boolean(params.allSessions || (hasBridgeSessionFilters(filters) && !params.sessionId));
			if (!shouldSearchAcrossSessions) filters.sessionId = filters.sessionId || ctx.sessionManager.getSessionId();
			const events = await listBridgeEvents(root, { ...filters, limit });
			const windowSummary = summarizeBridgeWindow(events);
			const text = [
				"# CMUX PI bridge events",
				"",
				`- root: ${root}`,
				`- allSessions: ${shouldSearchAcrossSessions ? "yes" : "no"}`,
				`- filters: ${JSON.stringify(filters)}`,
				`- returned: ${events.length}`,
				`- toolCalls: ${windowSummary.toolCallCount}`,
				`- toolFailures: ${windowSummary.toolFailureCount}`,
				`- contractWarnings: ${windowSummary.contractWarningCount}`,
				`- hints: ${windowSummary.hintCount}`,
				windowSummary.recentTools.length ? `- tools: ${windowSummary.recentTools.join(", ")}` : null,
				windowSummary.typeCounts.length ? `- eventTypes: ${windowSummary.typeCounts.map((item) => `${item.type}=${item.count}`).join(", ")}` : null,
				...events.flatMap((event: any) => [
					"",
					`## ${event.sequence || "?"} · ${event.type || event.event_type || "unknown"}`,
					`- at: ${event.timestamp || "—"}`,
					`- sessionId: ${event.sessionId || event.session_id || "—"}`,
					event.agent_alias ? `- agent: ${event.agent_alias}` : null,
					event.task_id ? `- taskId: ${event.task_id}` : null,
					event.run_id ? `- runId: ${event.run_id}` : null,
					event.team_id ? `- teamId: ${event.team_id}` : null,
					event.workspace_id ? `- workspace: ${event.workspace_id}` : null,
					event.surface_id ? `- surface: ${event.surface_id}` : null,
					event.payload?.summary ? `- summary: ${event.payload.summary}` : null,
					event.event_contract_valid === false && event.event_contract_warning ? `- contractWarning: ${event.event_contract_warning}` : null,
					event.payload?.toolName ? `- tool: ${event.payload.toolName}` : null,
					event.payload?.promptPreview ? `- prompt: ${event.payload.promptPreview}` : null,
				].filter(Boolean)),
			].join("\n");
			return ok(text, { root, filters, allSessions: shouldSearchAcrossSessions, events, windowSummary });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_prune",
		label: "CMUX PI Bridge Prune",
		description: "Prune old CMUX PI bridge session directories to keep long-running bridge storage tidy.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
			maxAgeHours: Type.Optional(Type.Number({ description: "Remove sessions older than this many hours. Defaults to bridge policy or 72." })),
			maxSessions: Type.Optional(Type.Number({ description: "Optional retained-session cap. Defaults to bridge policy when configured." })),
			maxTotalBytes: Type.Optional(Type.Number({ description: "Optional retained-size cap in bytes. Defaults to bridge policy when configured." })),
			maxSessionBytes: Type.Optional(Type.Number({ description: "Optional per-session size cap in bytes. Oversized sessions become prune candidates." })),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview removals without deleting anything. Default true." })),
			keepSessionIds: Type.Optional(Type.Array(Type.String(), { description: "Optional session ids to keep regardless of age." })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const root = bridgeRoot(params.root);
			const policy = await readBridgePolicy(root);
			const keepSessionIds = Array.from(new Set([ctx.sessionManager.getSessionId(), ...((params.keepSessionIds || []) as string[])]));
			const result = await pruneBridgeSessions(root, {
				maxAgeHours: params.maxAgeHours || policy.maxAgeHours || 72,
				maxSessions: params.maxSessions ?? policy.maxSessions,
				maxTotalBytes: params.maxTotalBytes ?? policy.maxTotalBytes,
				maxSessionBytes: params.maxSessionBytes ?? policy.maxSessionBytes,
				dryRun: params.dryRun !== false,
				keepSessionIds,
			});
			const text = [
				"# CMUX PI bridge prune",
				"",
				`- root: ${root}`,
				`- dryRun: ${params.dryRun !== false ? "yes" : "no"}`,
				`- maxAgeHours: ${result.thresholdHours}`,
				`- maxSessions: ${result.maxSessions ?? "off"}`,
				`- maxTotalBytes: ${result.maxTotalBytes ? formatBytes(result.maxTotalBytes) : "off"}`,
				`- maxSessionBytes: ${result.maxSessionBytes ? formatBytes(result.maxSessionBytes) : "off"}`,
				`- totalBytesBefore: ${formatBytes(result.totalBytesBefore)}`,
				`- totalBytesAfter: ${formatBytes(result.totalBytesAfter)}`,
				`- retainedSessions: ${result.retainedSessionCount}`,
				`- candidates: ${result.wouldRemoveCount}`,
				`- removed: ${result.removedCount}`,
				...result.candidates.slice(0, 20).flatMap((entry: any) => [
					"",
					`## ${entry.sessionId}`,
					`- lastEventAt: ${entry.status?.lastEventAt || "—"}`,
					`- ageMinutes: ${entry.age?.ageMinutes ?? "—"}`,
					`- size: ${formatBytes(entry.sizeBytes)}`,
					`- reasons: ${(entry.reasons || []).join(", ") || "—"}`,
					entry.artifactCounts?.artifactPaths ? `- artifactPaths: ${entry.artifactCounts.artifactPaths}` : null,
					entry.artifactCounts?.urls ? `- urls: ${entry.artifactCounts.urls}` : null,
					entry.artifactCounts?.commands ? `- commands: ${entry.artifactCounts.commands}` : null,
					`- summary: ${entry.status?.lastSummary || "—"}`,
				]),
			].join("\n");
			return ok(text, { root, policy, keepSessionIds, result });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_policy",
		label: "CMUX PI Bridge Policy",
		description: "Get or update automatic bridge retention policy for CMUX PI bridge storage.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
			action: Type.Optional(Type.String({ description: "get or set. Default get." })),
			autoPruneEnabled: Type.Optional(Type.Boolean({ description: "Whether automatic pruning is enabled." })),
			maxAgeHours: Type.Optional(Type.Number({ description: "Retention age threshold in hours." })),
			pruneEveryEvents: Type.Optional(Type.Number({ description: "Attempt automatic prune after this many events per session." })),
			maxSessions: Type.Optional(Type.Number({ description: "Optional retained-session cap." })),
			maxTotalBytes: Type.Optional(Type.Number({ description: "Optional retained-size cap in bytes." })),
			maxSessionBytes: Type.Optional(Type.Number({ description: "Optional per-session size cap in bytes." })),
			clearMaxSessions: Type.Optional(Type.Boolean({ description: "Clear the retained-session cap." })),
			clearMaxTotalBytes: Type.Optional(Type.Boolean({ description: "Clear the retained-size cap." })),
			clearMaxSessionBytes: Type.Optional(Type.Boolean({ description: "Clear the per-session size cap." })),
		}),
		async execute(_toolCallId, params: any) {
			const root = bridgeRoot(params.root);
			const action = String(params.action || "get").toLowerCase();
			const policy = action === "set"
				? await writeBridgePolicy(root, {
					autoPruneEnabled: params.autoPruneEnabled,
					maxAgeHours: params.maxAgeHours,
					pruneEveryEvents: params.pruneEveryEvents,
					maxSessions: params.clearMaxSessions ? null : params.maxSessions,
					maxTotalBytes: params.clearMaxTotalBytes ? null : params.maxTotalBytes,
					maxSessionBytes: params.clearMaxSessionBytes ? null : params.maxSessionBytes,
				})
				: await readBridgePolicy(root);
			return ok([
				"# CMUX PI bridge policy",
				"",
				`- root: ${root}`,
				`- autoPruneEnabled: ${policy.autoPruneEnabled ? "yes" : "no"}`,
				`- maxAgeHours: ${policy.maxAgeHours}`,
				`- pruneEveryEvents: ${policy.pruneEveryEvents}`,
				`- maxSessions: ${policy.maxSessions ?? "off"}`,
				`- maxTotalBytes: ${policy.maxTotalBytes ? formatBytes(policy.maxTotalBytes) : "off"}`,
				`- maxSessionBytes: ${policy.maxSessionBytes ? formatBytes(policy.maxSessionBytes) : "off"}`,
			].join("\n"), { root, action, policy });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_rebuild_index",
		label: "CMUX PI Bridge Rebuild Index",
		description: "Rebuild the CMUX PI bridge root index from live session status files.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
		}),
		async execute(_toolCallId, params: any) {
			const root = bridgeRoot(params.root);
			const sessions = await rebuildBridgeIndex(root);
			const doctor = await doctorBridgeIndex(root);
			return ok([
				"# CMUX PI bridge rebuild index",
				"",
				`- root: ${root}`,
				`- indexedSessions: ${sessions.length}`,
				`- doctor.ok: ${doctor.ok ? "yes" : "no"}`,
				`- coveragePct: ${doctor.coveragePct}`,
			].join("\n"), { root, sessions, doctor });
		},
	});

	pi.registerTool({
		name: "cmux_pi_bridge_doctor",
		label: "CMUX PI Bridge Doctor",
		description: "Audit bridge index freshness and drift between the root index and live bridge session status files.",
		parameters: Type.Object({
			root: Type.Optional(Type.String({ description: "Optional bridge root directory override." })),
		}),
		async execute(_toolCallId, params: any) {
			const root = bridgeRoot(params.root);
			const doctor = await doctorBridgeIndex(root);
			return ok([
				"# CMUX PI bridge doctor",
				"",
				`- root: ${root}`,
				`- ok: ${doctor.ok ? "yes" : "no"}`,
				`- indexUpdatedAt: ${doctor.indexUpdatedAt || "—"}`,
				`- indexAgeMinutes: ${doctor.indexAgeMinutes ?? "—"}`,
				`- indexedCount: ${doctor.indexedCount}`,
				`- liveSessionCount: ${doctor.liveSessionCount}`,
				`- coveragePct: ${doctor.coveragePct}`,
				`- missingFromIndex: ${doctor.missingFromIndex.length}`,
				`- staleIndexEntries: ${doctor.staleIndexEntries.length}`,
				`- mismatches: ${doctor.mismatches.length}`,
				...doctor.missingFromIndex.slice(0, 10).map((id: string) => `- missing session: ${id}`),
				...doctor.staleIndexEntries.slice(0, 10).map((id: string) => `- stale index entry: ${id}`),
				...doctor.mismatches.slice(0, 10).map((entry: any) => `- mismatch ${entry.sessionId}: ${entry.issues.join(", ")}`),
			].join("\n"), { root, doctor });
		},
	});
}
