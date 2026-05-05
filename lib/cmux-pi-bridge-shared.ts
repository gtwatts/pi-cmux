import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extractArtifactPaths, extractCommands, extractUrls, uniqueStrings as uniqueAnalysisStrings } from "./cmux-orchestrator-analysis.ts";

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
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
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
		if (Object.keys(value).length > 30) (next as any).__truncatedKeys = Object.keys(value).length - 30;
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

export function bridgeRoot(input?: string) {
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

function contextUsageSnapshot(ctx: any) {
	try {
		const usage = ctx?.getContextUsage?.();
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
	const model = ctx?.model;
	if (!model) return null;
	return {
		provider: model.provider ?? null,
		id: model.id ?? null,
		reasoning: Boolean(model.reasoning),
	};
}

function cmuxEnvSnapshot(overrides: any = {}) {
	const env = process.env;
	return {
		workspaceId: overrides.workspaceId ?? env.CMUX_WORKSPACE_ID ?? null,
		surfaceId: overrides.surfaceId ?? env.CMUX_SURFACE_ID ?? null,
		tabId: env.CMUX_TAB_ID || null,
		panelId: env.CMUX_PANEL_ID || null,
		socketPath: env.CMUX_SOCKET_PATH || env.CMUX_SOCKET || null,
		port: env.CMUX_PORT || null,
		portEnd: env.CMUX_PORT_END || null,
		portRange: env.CMUX_PORT_RANGE || null,
		kbTaskId: overrides.taskId ?? overrides.kbTaskId ?? env.KB_TASK_ID ?? env.CMUX_KB_TASK_ID ?? env.PI_TASK_ID ?? null,
		runId: overrides.runId ?? env.PI_CMUX_RUN_ID ?? env.CMUX_RUN_ID ?? null,
		teamId: overrides.teamId ?? env.PI_CMUX_TEAM_ID ?? env.CMUX_TEAM_ID ?? null,
		agentId: overrides.agentId ?? env.PI_CMUX_AGENT_ID ?? env.CMUX_AGENT_ID ?? null,
		agentAlias: overrides.agentAlias ?? env.PI_CMUX_AGENT_ALIAS ?? env.CMUX_AGENT_ALIAS ?? null,
		role: overrides.role ?? env.PI_CMUX_ROLE ?? null,
		launcher: overrides.launcher ?? env.PI_CMUX_LAUNCHER ?? null,
		launchMode: overrides.launchMode ?? env.PI_CMUX_LAUNCH_MODE ?? null,
		interfaceMode: overrides.interfaceMode ?? env.PI_INTERFACE ?? env.PI_CMUX_INTERFACE ?? null,
	};
}

async function updateBridgeIndex(root: string, current: any, paths: { eventsPath: string; statusPath: string }) {
	const indexPath = join(root, "index.json");
	const existing = await readJson(indexPath, { version: 2, updatedAt: null, sessions: [] });
	const entry = {
		schemaVersion: 2,
		sessionId: current?.sessionId || null,
		cwd: current?.cwd || null,
		lastEventType: current?.lastEventType || null,
		lastEventAt: current?.lastEventAt || null,
		eventCount: current?.eventCount || 0,
		lastSummary: current?.lastSummary || null,
		workspaceId: current?.cmux?.workspaceId || current?.identity?.workspace_id || null,
		surfaceId: current?.cmux?.surfaceId || current?.identity?.surface_id || null,
		taskId: current?.cmux?.kbTaskId || current?.identity?.task_id || null,
		runId: current?.cmux?.runId || current?.identity?.run_id || null,
		teamId: current?.cmux?.teamId || current?.identity?.team_id || null,
		agentAlias: current?.cmux?.agentAlias || current?.identity?.agent_alias || null,
		role: current?.cmux?.role || null,
		launcher: current?.cmux?.launcher || null,
		launchMode: current?.cmux?.launchMode || null,
		interfaceMode: current?.cmux?.interfaceMode || current?.identity?.interface_mode || null,
		model: current?.model || null,
		artifactPaths: current?.artifactSignals?.artifactPaths || [],
		urls: current?.artifactSignals?.urls || [],
		commands: current?.artifactSignals?.commands || [],
		artifactCounts: {
			artifactPaths: (current?.artifactSignals?.artifactPaths || []).length,
			urls: (current?.artifactSignals?.urls || []).length,
			commands: (current?.artifactSignals?.commands || []).length,
		},
		eventsPath: paths.eventsPath,
		statusPath: paths.statusPath,
		updatedAt: nowIso(),
	};
	const sessions = [entry, ...((existing.sessions || []).filter((item: any) => item.sessionId !== entry.sessionId))].slice(0, 500);
	await writeJson(indexPath, { version: 2, updatedAt: nowIso(), sessions });
}

// ---------------------------------------------------------------------------
// Schema Registry
// ---------------------------------------------------------------------------

export const BRIDGE_EVENT_TYPES = [
	// Core lifecycle (cmux-pi-bridge.ts)
	"session_start",
	"before_agent_start",
	"agent_start",
	"turn_start",
	"turn_end",
	"tool_call",
	"tool_result",
	"model_select",
	"session_compact",
	"user_bash",
	"agent_end",
	// Browser intelligence (cmux-browser-intelligence.ts)
	"browser_lock_acquired",
	"browser_lock_released",
	"browser_lock_asserted",
	"browser_lock_swept",
	"browser_lock_renewed",
	"browser_lock_handoff",
	"browser_doctor_ran",
	"browser_bootstrap_completed",
	"browser_surface_focused",
	"browser_workflow_learned",
	"browser_recovery_started",
	"browser_recovery_completed",
	"browser_recovery_failed",
	"browser_checkpoint_saved",
	"browser_checkpoint_restored",
	"browser_checkpoint_renamed",
	"browser_checkpoint_moved",
	"browser_checkpoint_deleted",
	// Pattern recognition (pattern-recognition-algorithms.ts)
	"pattern_analysis_started",
	"pattern_analysis_failed",
	"pattern_analysis_completed",
	"pattern_analysis_cache_hit",
	"pattern_benchmark_recorded",
	// KB / orchestrator launch events (P0.3)
	"kb_task_launch_routed",
	"kb_task_solo_launched",
	"kb_task_team_launched",
	"kb_task_continued",
	"kb_task_agent_adopted",
	"kb_task_team_adopted",
	"orchestrator_run_created",
	"orchestrator_agent_launched",
	"orchestrator_team_created",
	"orchestrator_task_dispatched",
	"orchestrator_orchestration_started",
	"orchestrator_team_shutdown",
	// Local CMUX coordination / control-plane events
	"orchestrator_presence_updated",
	"orchestrator_decision_recorded",
	"orchestrator_blocker_raised",
	"orchestrator_handoff_created",
	"orchestrator_memory_recalled",
	"orchestrator_control_room_snapshot",
	"orchestrator_control_room_actions",
	"orchestrator_approval_policy_checked",
	"orchestrator_hint_blocker_candidate",
	"orchestrator_hint_decision_candidate",
	"orchestrator_hint_handoff_candidate",
	"orchestrator_hint_approval_candidate",
	"orchestrator_notify",
	"orchestrator_round_summary",
	// Pattern setup events (P1.1)
	"pattern_setup_started",
	"pattern_setup_stage",
	"pattern_setup_completed",
	"pattern_setup_failed",
	// Spacetime coordination events
	"spacetime_swarm_memory_posted",
	"spacetime_swarm_memory_presence_updated",
	"spacetime_swarm_memory_decision_recorded",
	"spacetime_swarm_memory_blocker_raised",
	"spacetime_swarm_memory_handoff_created",
	"spacetime_approval_requested",
	"spacetime_auto_memory_recalled",
	"orchestrator_spacetime_notify",
] as const;

export type BridgeEventType = (typeof BRIDGE_EVENT_TYPES)[number];

const warnedUnknownTypes = new Set<string>();

export function isKnownBridgeEvent(type: string): type is BridgeEventType {
	return (BRIDGE_EVENT_TYPES as readonly string[]).includes(type);
}

export function validateBridgeEvent(type: string, _payload?: Record<string, unknown>): { valid: boolean; warning?: string } {
	if (isKnownBridgeEvent(type)) return { valid: true };
	return { valid: false, warning: `Unknown bridge event type "${type}". Register it in BRIDGE_EVENT_TYPES.` };
}

export async function writeCmuxBridgeAuxEvent(ctx: any, type: string, payload: Record<string, unknown> = {}, rootOverride?: string, identityOverride: Record<string, unknown> = {}) {
	// Non-blocking warning for unknown types (once per session)
	if (!isKnownBridgeEvent(type)) {
		const sessionId = ctx?.sessionManager?.getSessionId?.() || "unknown";
		const key = `${sessionId}:${type}`;
		if (!warnedUnknownTypes.has(key)) {
			warnedUnknownTypes.add(key);
			console.warn(`[cmux-pi-bridge-shared] Unknown bridge event type "${type}". Consider registering it in BRIDGE_EVENT_TYPES.`);
		}
	}

	const sessionId = ctx?.sessionManager?.getSessionId?.();
	if (!sessionId) return null;
	const root = bridgeRoot(rootOverride);
	const paths = bridgePaths(root, sessionId);
	const usage = contextUsageSnapshot(ctx);
	const cmux = cmuxEnvSnapshot(identityOverride || {});
	const model = modelSnapshot(ctx);
	const current = await readJson(paths.statusPath, {
		version: 1,
		sessionId,
		cwd: ctx?.cwd || process.cwd(),
		createdAt: nowIso(),
		eventCount: 0,
		lastSequence: 0,
		lastEventType: null,
		lastEventAt: null,
		lastSummary: null,
		model: null,
		contextUsage: null,
		cmux: null,
	});
	const sequence = Number(current.lastSequence || current.eventCount || 0) + 1;
	const sanitizedPayload = compactBridgeValue(payload);
	const artifactSignals = bridgeArtifactSignals(payload);
	const validation = validateBridgeEvent(type, payload);
	const event = {
		version: 2,
		schemaVersion: 2,
		timestamp: nowIso(),
		sequence,
		type,
		event_type: type,
		event_contract_valid: validation.valid,
		event_contract_warning: validation.warning || null,
		sessionId,
		session_id: sessionId,
		cwd: ctx?.cwd || process.cwd(),
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
	current.eventCount = Number(current.eventCount || 0) + 1;
	current.lastSequence = sequence;
	current.lastEventType = type;
	current.lastEventContractValid = validation.valid;
	current.lastEventContractWarning = validation.warning || null;
	current.lastEventAt = event.timestamp;
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
		launcher: cmux.launcher || null,
		launch_mode: cmux.launchMode || null,
		role: cmux.role || null,
	};
	current.artifactSignals = {
		artifactPaths: mergeSignalLists(current.artifactSignals?.artifactPaths, artifactSignals.artifactPaths, 32),
		urls: mergeSignalLists(current.artifactSignals?.urls, artifactSignals.urls, 24),
		commands: mergeSignalLists(current.artifactSignals?.commands, artifactSignals.commands, 24),
	};
	if (typeof payload.summary === "string" && payload.summary.trim()) current.lastSummary = payload.summary;
	if (typeof payload.promptPreview === "string" && payload.promptPreview.trim()) current.lastPromptPreview = payload.promptPreview;
	current.lastPayload = sanitizedPayload;
	await writeJson(paths.statusPath, current);
	await updateBridgeIndex(root, current, paths).catch(() => null);
	return { event, status: current, paths };
}
