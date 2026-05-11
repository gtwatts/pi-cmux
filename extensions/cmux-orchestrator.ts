/**
 * CMUX Orchestrator — Launch and coordinate multi-agent Pi teams inside cmux, with auto-assignment, progress capture, blocker escalation, and cross-team synthesis.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	summarize,
	uniqueStrings,
	buildCaptureDigest,
	selectBestCaptureText,
} from "../lib/cmux-orchestrator-analysis.ts";
import {
	renderRunSummary,
	renderAgentStatus,
	renderRunCollectionSummary,
	renderRunTimeline,
	renderMissionControlSnapshot,
	renderOrchestratorDoctor,
	renderArtifactInventory,
} from "../lib/cmux-orchestrator-render.ts";
import { selectReusableTeamCandidates } from "../lib/cmux-orchestrator-reuse.ts";
import {
	createOrchestratorStorage,
	nowIso as nowIsoLib,
	safeFileSegment as safeFileSegmentLib,
	atomicWriteJson as atomicWriteJsonLib,
	registryVersioned as registryVersionedLib,
	applyBridgeStateToAgentRecord,
	deriveBridgeStateFromEvents,
	summarizeRunBridgeState,
} from "../lib/cmux-orchestrator-storage.ts";
import {
	shQ,
	shellJoin,
	buildPiLaunchCommand,
	buildTerminalDispatchPayload,
	splitTerminalDispatchPayload,
} from "../lib/cmux-orchestrator-transport.ts";
import { assignModelsToMemberSpecs } from "../lib/cmux-orchestrator-models.ts";
import {
	applyModelPreset,
	loadModelPresetRegistry,
	recommendModelPreset,
	resolveModelPreset,
} from "../lib/cmux-orchestrator-model-presets.ts";
import {
	applyAgentDigest,
	buildTeamStatePatch,
	deriveRunStatus,
	enforceCompletionGateDecision,
	evaluateCompletionGate,
	shouldAutoRebalance,
} from "../lib/cmux-orchestrator-decisions.ts";
import {
	getBenchmarkScenario,
	renderBenchmarkReport,
	renderBenchmarkSuiteSummary,
	runBenchmarkSuite,
} from "../lib/cmux-orchestrator-benchmark.ts";
import {
	buildRunScorecardReport,
	renderRunFailureReport,
	renderRunScorecardReport,
} from "../lib/cmux-orchestrator-scorecard.ts";
import {
	detectOutcomeIntent,
	deriveOutcomeExecutionContract,
	deriveOutcomeExecutionPlan,
	renderOutcomeExecutionContract,
	renderOutcomeExecutionPlan,
} from "../lib/cmux-orchestrator-outcome-mode.ts";
import {
	writeBenchmarkArtifacts,
	writeOutcomeExecutionArtifacts,
	writeRunEvaluationArtifacts,
} from "../lib/cmux-orchestrator-artifacts.ts";
import {
	deriveDoctorFindings,
} from "../lib/cmux-orchestrator-doctor.ts";
import {
	deriveRepairPlan,
} from "../lib/cmux-orchestrator-repair.ts";
import {
	buildRepairExecutionPlan,
	executeRepairExecutionPlan,
} from "../lib/cmux-orchestrator-repair-execution.ts";
import {
	classifyVerificationResult,
	summarizeVerificationResults,
} from "../lib/cmux-orchestrator-verification.ts";
import {
	ingestBridgeEventsIntoOrchestrator,
} from "../lib/cmux-orchestrator-bridge-ingest.ts";
import {
	buildAgentDisplayLabel,
	buildSeparateAgentWorkspaceTitle,
	buildStandaloneAgentWorkspaceTitle,
	buildTeamWorkspaceDescription,
	buildTeamWorkspaceTitle,
} from "../lib/cmux-orchestrator-labels.ts";
import { detectBinary } from "../lib/extension-shared.ts";
import { writeCmuxBridgeAuxEvent } from "../lib/cmux-pi-bridge-shared.ts";
import {
	syncSwarmPresence,
	recordSwarmDecision,
	raiseSwarmBlocker,
	createSwarmHandoff,
	getControlRoomSnapshot,
	getControlRoomNextActions,
	checkApprovalPolicy,
	buildAutoRiskSpecFromTask,
	autoSummaryFromSnapshot,
} from "../lib/cmux-ops-hooks.ts";

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_TEAM_CAPTURE_LINES = 200;
const DEFAULT_SWARM_DELAY_MS = 2_500;
const DEFAULT_SWARM_ROUNDS = 2;
const DEFAULT_MAX_ORCHESTRATION_ROUNDS = 6;
const DEFAULT_SYNTHESIS_DELAY_MS = 2_000;
const MAX_AUTO_AGENT_COUNT = 8;
const TEAM_WORKSPACE_COLOR_PALETTE = ["Blue", "Teal", "Purple", "Amber", "Green", "Rose", "Indigo", "Orange", "Aqua", "Crimson"];
const CMUX_PI_BRIDGE_ROOT = process.env.PI_CMUX_BRIDGE_DIR || join(homedir(), ".pi", "agent", ".cmux-pi");
const storage = createOrchestratorStorage({
	baseDir: join(homedir(), ".pi", "agent", ".cmux-orchestrator"),
	sessionsRoot: join(homedir(), ".pi", "agent", "sessions", "cmux-orchestrator"),
});

const CMUX_PREAMBLE = `
# cmux Orchestrator Extension

cmux is a native macOS terminal for AI coding agents with a socket API, workspace and pane orchestration, browser surfaces, notifications, SSH-aware remote workspaces, and agent-team integrations.

## Core cmux hierarchy
- window -> workspace -> pane -> surface
- workspace: sidebar entry / tab-like unit
- pane: split region inside a workspace
- surface: terminal or browser tab inside a pane

## Agent guidance
- Use \`cmux_status\` first when you need to verify readiness, socket access, focused workspace, or configuration.
- Use \`cmux_workspace\` to list, inspect, create, select, rename, reorder, and close workspaces.
- Use \`cmux_surface\` to inspect panes and surfaces, split layouts, send text, read terminal screens, focus targets, rename tabs, and manage tab actions.
- Use \`cmux_browser\` for low-level cmux browser surfaces control: open pages, navigate, snapshot, click, fill, type, wait, inspect, evaluate JS, manage tabs, and save/load browser state.
- Prefer the higher-level browser intelligence tools for serious browser work: \`cmux_browser_observe\`, \`cmux_browser_act\`, \`cmux_browser_assert\`, \`cmux_browser_extract\`, \`cmux_browser_recover\`, \`cmux_browser_run_task\`, \`cmux_browser_lock\`, \`cmux_browser_memory\`, and \`cmux_browser_session\`.
- Do not use the standalone built-in \`browser\` tool for work that should stay inside a cmux browser surface. Use the cmux browser stack so shared surfaces, locks, checkpoints, and recovery all stay coherent.
- For browser tasks, prefer plan/act/verify loops, semantic targets over brittle selectors, structured extraction over freeform scraping, surface locks when multiple agents share one browser, site memory for repeated workflows, and checkpoints before risky transitions or agent handoffs.
- Use \`cmux_pi_agent\` to launch and control independent Pi terminals inside cmux.
- Use \`cmux_pi_team\` to create and orchestrate multi-agent Pi teams and multi-team swarms.
- Do not issue several \`cmux_pi_team action=create\` or workspace/surface creation calls in parallel. If multiple teams are needed, prefer one \`cmux_pi_team action=orchestrate\`/multi-team request, or create teams sequentially so cmux socket workspace mutations remain ordered.
- Use \`cmux_notify\` when a long-running task finishes or when the user should be alerted in cmux.
- Use \`cmux_rpc\` for advanced socket methods not covered by the higher-level tools.
- Use \`cmux_cli\` for full cmux CLI coverage such as SSH workspaces, claude-teams, omo/omx/omc, markdown viewer, themes, or other commands not wrapped above.

## Swarm orchestration policy
- When the user asks for a team or several teams, first review the job and decide how much parallelism is warranted.
- If the user explicitly specifies how many agents or teams to launch, honor that request unless it is impossible.
- If the user does not specify counts, choose a reasonable \`agentCount\` and optional \`teamCount\` based on task scope, uncertainty, implementation work, and review needs.
- Before creating a new swarm for a follow-up request, inspect existing teams with \`cmux_pi_team\`/\`cmux_pi_agent\` and prefer reusing live agents when they already cover the job. Do not spawn duplicate review teams unless the user explicitly wants more parallelism or the existing swarm is no longer usable.
- If the user says things like "keep going", "continue", "take your agents and get to work", or otherwise approves more progress after a status update, default to reusing the existing live team instead of spawning a fresh one.
- Prefer \`cmux_pi_team\` with \`orchestrate\` for multi-round work so the orchestrator can launch agents, check in on them, gather outputs, relay peer findings, persist primary-inbox reports, and keep the swarm synchronized.
- When creating multiple teams or several standalone agents, sequence creation through one tool call or one orchestrator action rather than firing multiple independent create calls in the same assistant turn.
- Treat the primary agent as an active orchestrator, not a fire-and-forget launcher: after every orchestration round, read the progress/mission-control output, track the primary inbox, decide whether agents are blocked/done/stale, and only then report to the user.
- Before telling the user that a swarm is complete, confirm the final decision from the persisted run record/mission-control snapshot, team lead reports, coordinator report, and final synthesis; if any primary-inbox report shows remaining work, say the run is still active or waiting review.
- Organize swarms so one cmux workspace represents one team by default, and each Pi terminal/surface inside that workspace represents one named agent. Never model one agent as one sidebar workspace unless the user explicitly asks for \`layout=separate_workspaces\`.
- Keep workspace titles team-oriented and tab titles agent-oriented so the swarm stays legible while it runs.
- When model choice matters, assign models deliberately by role and task. Reuse explicit user-requested providers/models when provided; never pair an explicit non-OpenAI model with the default OpenAI/OpenAI-Codex provider just because the provider was omitted. Infer the provider from clear model names such as DeepSeek, Kimi/K2.6, GLM/ZAI, Claude, Grok, or provider/model syntax.
- If the user gives per-role preferences, encode them with \`roleModelMap\` or per-member \`specs\` and preserve them exactly. Examples: design -> openai-codex/gpt-5.5, researcher -> kimi-coding/k2p6, intelligence/debugging -> deepseek/deepseek-v4-pro, browser/UI execution -> zai/glm-5.1, coding/busy work -> kimi-coding/k2p6.
- If the user does not specify models, inspect the task and choose a model preset or role map intentionally instead of using one model for every agent. Leadership/review needs high-reasoning models; browser/UI work needs strong web/UI execution; implementation/busy work can use fast coding models; research/intelligence can use deep reasoning models.
- If you launch a swarm, do not personally take over the substantive task work in parallel unless the user explicitly asks you to contribute as an individual worker too. Your primary job becomes orchestration: assign, gather, relay, rebalance, verify, summarize, and decide whether to retain or shut down the swarm.
- Keep agents in regular contact through the job: gather progress, relay blockers and insights between agents or teams, and continue coordination rounds until the work is accurate and complete.
- When a swarm run completes, resolve the team lifecycle explicitly. Default posture is: shut down/delete the spawned live team workspaces so only the primary/operator terminal remains. Only save or keep reusable team templates when the user explicitly asks.
- Use \`cmux_pi_team\` action \`retention\` after a completed run when the user answers the save-team question: pass \`teamRetentionDecision="save"\` to keep the reusable team template, or \`teamRetentionDecision="destroy"\` to discard it and ensure no live team/workspace remains.

## Important defaults
- Inside cmux terminals, \`CMUX_WORKSPACE_ID\` and \`CMUX_SURFACE_ID\` are usually auto-set and act as natural defaults.
- Prefer the structured cmux tools over ad-hoc shell invocations when the task is specifically about cmux orchestration.
- Prefer \`cmux_rpc\` or \`cmux_cli\` instead of guessing undocumented socket payloads.
`;

function ok(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function fail(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: `Error: ${text}` }],
		details: { error: true, ...details },
	};
}

function json(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string) {
	const seen = new Set<string>();
	const next: T[] = [];
	for (const item of items || []) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(item);
	}
	return next;
}

function emitToolUpdate(
	onUpdate: ((update: any) => void | Promise<void>) | undefined,
	text: string,
	details: Record<string, unknown> = {},
) {
	if (!onUpdate) return;
	return onUpdate({
		content: [{ type: "text", text }],
		details,
	});
}

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function safePostFinding(_pi: ExtensionAPI, ctx: any, finding: any) {
	try {
		if (finding?.runId) {
			appendRunEvent(finding.runId, {
				type: "orchestrator_finding",
				team: finding.teamId || null,
				alias: finding.agentAlias || null,
				status: finding.kind || "observation",
				detail: summarize(`${finding.title || "Finding"}: ${finding.body || ""}`, 260),
				source: "orchestrator",
			});
		}
		return writeCmuxBridgeAuxEvent(ctx, "orchestrator_finding", {
			kind: finding?.kind || "observation",
			title: finding?.title || null,
			body: finding?.body || null,
			tags: finding?.tags || [],
			summary: finding?.title || finding?.body || "Orchestrator finding",
		}, undefined, {
			runId: finding?.runId || null,
			teamId: finding?.teamId || null,
			agentAlias: finding?.agentAlias || null,
		}).catch(() => null);
	} catch {
		return null;
	}
}

function maybeReadSnippet(path: string, maxLines = 80) {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8").split(/\r?\n/).slice(0, maxLines).join("\n");
}

function resolveCmuxBinary() {
	return process.env.CMUX_BUNDLED_CLI_PATH || detectBinary("cmux");
}

function installHelp() {
	return [
		"cmux CLI was not found.",
		"Install cmux from https://cmux.com/docs/getting-started",
		"Homebrew:",
		"  brew tap manaflow-ai/cmux",
		"  brew install --cask cmux",
		"Optional external CLI symlink:",
		"  sudo ln -sf \"/Applications/cmux.app/Contents/Resources/bin/cmux\" /usr/local/bin/cmux",
	].join("\n");
}

function configPaths(projectCwd?: string) {
	const home = homedir();
	const cwd = projectCwd || process.cwd();
	return {
		home,
		projectCwd: cwd,
		ghosttyPrimary: join(home, ".config", "ghostty", "config"),
		ghosttyFallback: join(home, "Library", "Application Support", "com.mitchellh.ghostty", "config"),
		cmuxSettingsPrimary: join(home, ".config", "cmux", "settings.json"),
		cmuxSettingsFallback: join(home, "Library", "Application Support", "com.cmuxterm.app", "settings.json"),
		cmuxCommandsProject: join(cwd, "cmux.json"),
		cmuxCommandsGlobal: join(home, ".config", "cmux", "cmux.json"),
	};
}

function collectCmuxEnv() {
	return {
		CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH || null,
		CMUX_SOCKET: process.env.CMUX_SOCKET || null,
		CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID || null,
		CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID || null,
		CMUX_TAB_ID: process.env.CMUX_TAB_ID || null,
		CMUX_PANEL_ID: process.env.CMUX_PANEL_ID || null,
		CMUX_PORT: process.env.CMUX_PORT || null,
		CMUX_PORT_END: process.env.CMUX_PORT_END || null,
		CMUX_PORT_RANGE: process.env.CMUX_PORT_RANGE || null,
		CMUX_BUNDLED_CLI_PATH: process.env.CMUX_BUNDLED_CLI_PATH || null,
	};
}

function methodGroups(methods: string[] = []) {
	const groups = new Map<string, number>();
	for (const method of methods) {
		const root = method.includes(".") ? method.split(".")[0] : method;
		groups.set(root, (groups.get(root) || 0) + 1);
	}
	return Array.from(groups.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, count]) => ({ name, count }));
}

function addFlag(args: string[], flag: string, value: unknown) {
	if (value === undefined || value === null || value === "") return;
	args.push(flag, String(value));
}

function addBoolFlag(args: string[], flag: string, enabled?: boolean) {
	if (enabled) args.push(flag);
}

const CMUX_SOCKET_MUTATION_COMMANDS = new Set([
	"new-workspace",
	"new-split",
	"new-pane",
	"new-surface",
	"close-workspace",
	"close-surface",
	"select-workspace",
	"focus-pane",
	"focus-surface",
	"move-surface",
	"reorder-surface",
	"rename-tab",
	"tab-action",
	"workspace-action",
	"rename-workspace",
	"reorder-workspace",
	"move-workspace",
]);

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description ? { description: options.description } : {}),
		...(options?.default ? { default: options.default } : {}),
	});
}

let cmuxSocketMutationQueue: Promise<unknown> = Promise.resolve();

function shouldSerializeCmuxCommand(args: string[]) {
	const command = args.find((arg) => !String(arg || "").startsWith("-"));
	return command ? CMUX_SOCKET_MUTATION_COMMANDS.has(command) : false;
}

async function runSerializedCmuxSocketMutation<T>(operation: () => Promise<T>): Promise<T> {
	const previous = cmuxSocketMutationQueue.catch(() => undefined);
	let release!: (value?: unknown) => void;
	cmuxSocketMutationQueue = new Promise((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

function workspaceColorForSeed(seed: string, indexHint?: number | null) {
	if (typeof indexHint === "number" && Number.isFinite(indexHint) && indexHint >= 0) {
		return TEAM_WORKSPACE_COLOR_PALETTE[indexHint % TEAM_WORKSPACE_COLOR_PALETTE.length];
	}
	const hash = createHash("sha1").update(String(seed || "team")).digest("hex");
	const index = parseInt(hash.slice(0, 8), 16) % TEAM_WORKSPACE_COLOR_PALETTE.length;
	return TEAM_WORKSPACE_COLOR_PALETTE[index];
}

async function setWorkspaceColor(
	pi: ExtensionAPI,
	workspace: string | null | undefined,
	color: string | null | undefined,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	if (!workspace || !color) return null;
	return execCmux(pi, ["workspace-action", "--action", "set_color", "--workspace", workspace, "--color", color], {
		signal,
		timeout: Math.min(timeout, 10_000),
	}).catch(() => null);
}

async function stabilizeOperatorSidebar(
	pi: ExtensionAPI,
	operatorWorkspace: string | null | undefined,
	workspaceRefs: Array<string | null | undefined>,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	if (!operatorWorkspace) return;
	await execCmux(pi, ["reorder-workspace", "--workspace", operatorWorkspace, "--index", "0"], {
		signal,
		timeout: Math.min(timeout, 10_000),
	}).catch(() => null);
	let anchor = operatorWorkspace;
	for (const workspaceRef of uniqueStrings(workspaceRefs || [])) {
		if (!workspaceRef || workspaceRef === operatorWorkspace) continue;
		await execCmux(pi, ["reorder-workspace", "--workspace", workspaceRef, "--after", anchor], {
			signal,
			timeout: Math.min(timeout, 10_000),
		}).catch(() => null);
		anchor = workspaceRef;
	}
	await execCmux(pi, ["select-workspace", "--workspace", operatorWorkspace], {
		signal,
		timeout: Math.min(timeout, 10_000),
	}).catch(() => null);
}

async function execCmux(
	pi: ExtensionAPI,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeout?: number;
		socketPath?: string;
		password?: string;
	} = {},
) {
	const binary = resolveCmuxBinary();
	if (!binary) {
		throw new Error(installHelp());
	}

	const fullArgs: string[] = [];
	addFlag(fullArgs, "--socket", options.socketPath);
	addFlag(fullArgs, "--password", options.password);
	fullArgs.push(...args);

	const invoke = async () => {
		const result = await pi.exec(binary, fullArgs, {
			signal: options.signal,
			timeout: options.timeout ?? DEFAULT_TIMEOUT,
		});

		const stdout = result.stdout ?? "";
		const stderr = result.stderr ?? "";
		const code = result.code ?? 0;

		if (code !== 0) {
			throw new Error((stderr || stdout || `cmux exited with code ${code}`).trim());
		}

		return { binary, args: fullArgs, stdout, stderr, code };
	};

	// cmux 0.63.2 has shown a native race in V2 socket workspace creation when
	// several Pi tool calls create teams/workspaces at the same time. Keep all
	// local socket-mutating commands from this extension single-filed; read-only
	// commands still run concurrently.
	return shouldSerializeCmuxCommand(args) ? runSerializedCmuxSocketMutation(invoke) : invoke();
}

async function execCmuxJson(
	pi: ExtensionAPI,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeout?: number;
		socketPath?: string;
		password?: string;
	} = {},
) {
	const result = await execCmux(pi, args, options);
	const data = parseJson(result.stdout);
	if (data === null) {
		throw new Error(`Expected JSON from cmux, got:\n${result.stdout || result.stderr}`);
	}
	return { ...result, data };
}

async function execCmuxRpc(
	pi: ExtensionAPI,
	method: string,
	params: Record<string, unknown> = {},
	options: {
		signal?: AbortSignal;
		timeout?: number;
		socketPath?: string;
		password?: string;
	} = {},
) {
	return execCmuxJson(pi, ["rpc", method, JSON.stringify(params || {})], options);
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
	return nowIsoLib();
}

function orchestratorDir() {
	return storage.baseDir;
}

function safeFileSegment(value: string, fallback = "item") {
	return safeFileSegmentLib(value, fallback);
}

function readJsonFileSafe(path: string, fallback: any = null) {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}

let bridgeStatusCache: { timestamp: number; statuses: any[] } | null = null;
let bridgeDerivedStateCache = new Map<string, { stamp: string; derived: any }>();

function bridgeAgeSummary(timestamp?: string | null) {
	if (!timestamp) return { ageMinutes: null, stale: null };
	const ageMs = Date.now() - new Date(timestamp).getTime();
	if (!Number.isFinite(ageMs)) return { ageMinutes: null, stale: null };
	return {
		ageMinutes: Math.round(ageMs / 60_000),
		stale: ageMs > 15 * 60_000,
	};
}

function readJsonlFileTail(path: string, limit = 120) {
	if (!path || !existsSync(path)) return [] as any[];
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => parseJson(line))
		.filter(Boolean)
		.slice(-Math.max(1, Math.min(500, Number(limit || 120))));
}

function bridgeStatusForAgent(record: any, statuses?: any[]) {
	const haystack = statuses || listBridgeStatuses();
	return haystack.find((status: any) => {
		const identity = status?.identity || {};
		const cmux = status?.cmux || {};
		return Boolean(
			(record?.alias && (identity.agent_alias === record.alias || cmux.agentAlias === record.alias)) ||
			(record?.surface && (identity.surface_id === record.surface || cmux.surfaceId === record.surface)) ||
			(record?.workspace && (identity.workspace_id === record.workspace || cmux.workspaceId === record.workspace))
		);
	}) || null;
}

function ingestBridgeStateFromStatuses(statuses: any[] = []) {
	const agentRegistry = readAgentRegistry().agents || {};
	const touchedRunIds = new Set<string>();
	const nextByAlias = new Map<string, any>();
	for (const status of statuses || []) {
		const linkedAgents = Object.values(agentRegistry).filter((record: any) => bridgeStatusForAgent(record, [status]));
		if (!linkedAgents.length) continue;
		const sessionId = String(status?.sessionId || status?.session_id || "");
		const stamp = `${status?.lastEventAt || "—"}:${status?.lastEventType || "—"}`;
		let derived = bridgeDerivedStateCache.get(sessionId)?.stamp === stamp ? bridgeDerivedStateCache.get(sessionId)?.derived : null;
		if (!derived) {
			derived = deriveBridgeStateFromEvents(readJsonlFileTail(status?.paths?.eventsPath, 160));
			bridgeDerivedStateCache.set(sessionId, { stamp, derived });
		}
		for (const linkedAgent of linkedAgents as any[]) {
			const next = applyBridgeStateToAgentRecord(linkedAgent, derived || {});
			next.bridgeSessionId = sessionId || linkedAgent.bridgeSessionId || null;
			next.lastBridgeEventType = derived?.lastBridgeEventType || status?.lastEventType || linkedAgent.lastBridgeEventType || null;
			next.lastBridgeEventAt = derived?.lastBridgeEventAt || status?.lastEventAt || linkedAgent.lastBridgeEventAt || null;
			nextByAlias.set(linkedAgent.alias, next);
			if (linkedAgent.runId) touchedRunIds.add(linkedAgent.runId);
		}
	}
	for (const next of nextByAlias.values()) upsertAgentRecord(next);
	if (touchedRunIds.size) {
		const latestAgents = readAgentRegistry().agents || {};
		for (const runId of touchedRunIds) {
			const runAgents = Object.values(latestAgents).filter((record: any) => record?.runId === runId);
			try {
				const current = resolveRunRecord(runId);
				upsertRunRecord({ ...current, bridgeActivity: summarizeRunBridgeState(runAgents) });
			} catch {
				upsertRunRecord({ runId, bridgeActivity: summarizeRunBridgeState(runAgents) });
			}
		}
	}
}

function listBridgeStatuses(force = false) {
	if (!force && bridgeStatusCache && Date.now() - bridgeStatusCache.timestamp < 10_000) return bridgeStatusCache.statuses;
	const sessionsDir = join(CMUX_PI_BRIDGE_ROOT, "sessions");
	if (!existsSync(sessionsDir)) return [] as any[];
	const statuses = readdirSync(sessionsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const sessionDir = join(sessionsDir, entry.name);
			const statusPath = join(sessionDir, "status.json");
			const eventsPath = join(sessionDir, "events.jsonl");
			const status = readJsonFileSafe(statusPath, null);
			if (!status) return null;
			return {
				...status,
				paths: { sessionDir, statusPath, eventsPath },
				bridgeAge: bridgeAgeSummary(status?.lastEventAt),
			};
		})
		.filter(Boolean)
		.sort((a: any, b: any) => String(b?.lastEventAt || "").localeCompare(String(a?.lastEventAt || "")));
	bridgeStatusCache = { timestamp: Date.now(), statuses };
	ingestBridgeStateFromStatuses(statuses);
	return statuses;
}

function atomicWriteJson(file: string, data: any) {
	return atomicWriteJsonLib(file, data);
}

function registryVersioned<T extends object>(key: string, emptyValue: T) {
	return registryVersionedLib(key, emptyValue);
}

function generateRunId(prefix = "run") {
	return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function defaultSessionPath(alias: string, runId?: string | null) {
	return storage.defaultSessionPath(alias, runId);
}

function writeLaunchPromptFile(sessionPath: string, prompt?: string | null) {
	const text = String(prompt || "");
	if (!text.trim()) return null;
	const file = `${sessionPath}.prompt.txt`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text, "utf-8");
	return file;
}

function writeLaunchScriptFile(sessionPath: string, launchCommand: string) {
	const file = `${sessionPath}.launch.sh`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		launchCommand,
		"",
	].join("\n"), "utf-8");
	return file;
}

function parseSessionTail(sessionPath?: string | null, maxLines = 80) {
	if (!sessionPath || !existsSync(sessionPath)) return null;
	const raw = readFileSync(sessionPath, "utf-8");
	const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
	const messages: any[] = [];
	for (const line of lines) {
		const parsed = parseJson(line);
		if (parsed) messages.push(parsed);
	}
	const recentAssistant = [...messages].reverse().find((entry: any) => entry?.type === "message" && entry?.message?.role === "assistant");
	const text = recentAssistant?.message?.content
		?.filter((item: any) => item?.type === "text")
		?.map((item: any) => item.text)
		?.join("\n") || "";
	return {
		messages,
		lastAssistantText: text.trim() || null,
		lineCount: lines.length,
	};
}

function runRegistryFile() {
	return storage.runRegistryFile();
}

function readRunRegistry() {
	return storage.readRunRegistry();
}

function writeRunRegistry(registry: any) {
	return storage.writeRunRegistry(registry);
}

function upsertRunRecord(record: any) {
	return storage.upsertRunRecord(record);
}

function resolveRunRecord(runId: string) {
	return storage.resolveRunRecord(runId);
}

function runEventsDir() {
	return storage.runEventsDir();
}

function runEventsFile(runId: string) {
	return storage.runEventsFile(runId);
}

function appendRunEvent(runId: string, event: any) {
	return storage.appendRunEvent(runId, event);
}

function readRunEvents(runId: string, limit = 120) {
	return storage.readRunEvents(runId, limit);
}

function missionEventSeverity(event: any) {
	const type = String(event?.type || "").toLowerCase();
	const status = String(event?.status || "").toLowerCase();
	const detail = String(event?.detail || "").toLowerCase();
	if ([type, status, detail].some((value) => /(fail|error|blocked|stalled|degraded|attention|escalat)/.test(value))) return "high";
	if ([type, status, detail].some((value) => /(relay|rebalance|heartbeat|dispatch|progress|review|waiting)/.test(value))) return "medium";
	if ([type, status, detail].some((value) => /(created|resolved|ready|complete|done|synthesis|shutdown|closed)/.test(value))) return "low";
	return "info";
}

function normalizeDependencyHint(value: string | null | undefined) {
	return String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function resolveDependencyTargetHint(targetHint: string | null | undefined, agents: any[], teams: any[]) {
	const hint = normalizeDependencyHint(targetHint);
	if (!hint) return { target: "external", targetType: "external", matched: false };
	const aliasMatch = (agents || []).find((agent: any) => hint === normalizeDependencyHint(agent.alias) || hint.includes(normalizeDependencyHint(agent.alias)));
	if (aliasMatch) return { target: aliasMatch.alias, targetType: "alias", matched: true };
	const teamMatch = (teams || []).find((team: any) => hint === normalizeDependencyHint(team.team) || hint.includes(normalizeDependencyHint(team.team)));
	if (teamMatch) return { target: teamMatch.team, targetType: "team", matched: true };
	const roleMatch = uniqueStrings((agents || []).map((agent: any) => agent.role).filter(Boolean)).find((role: string) => hint === normalizeDependencyHint(role) || hint.includes(normalizeDependencyHint(role)));
	if (roleMatch) return { target: roleMatch, targetType: "role", matched: true };
	return { target: targetHint || "external", targetType: "external", matched: false };
}

function collectDependencyGraph(agents: any[], teams: any[]) {
	const edges = [] as any[];
	for (const agent of agents || []) {
		for (const dependency of Array.isArray(agent?.lastDependencies) ? agent.lastDependencies : []) {
			const resolved = resolveDependencyTargetHint(dependency?.targetHint || dependency?.target || null, agents, teams);
			edges.push({
				fromAlias: agent.alias,
				fromTeam: agent.team || null,
				fromRole: agent.role || null,
				kind: dependency?.kind || "dependency",
				text: dependency?.text || null,
				target: resolved.target,
				targetType: resolved.targetType,
				open: String(dependency?.status || "open") !== "resolved",
				blocked: dependency?.blocked === true || agent.status === "blocked",
				requiresAck: dependency?.requiresAck !== false,
			});
		}
	}
	const deduped = uniqueStrings(edges.map((edge: any) => json({
		fromAlias: edge.fromAlias,
		fromTeam: edge.fromTeam,
		kind: edge.kind,
		target: edge.target,
		targetType: edge.targetType,
		text: edge.text,
		open: edge.open,
		blocked: edge.blocked,
		requiresAck: edge.requiresAck,
	}))).map((item: string) => parseJson(item)).filter(Boolean);
	return deduped.slice(0, 32);
}

function uniqueById(items: any[] = []) {
	const seen = new Set<string>();
	const next = [] as any[];
	for (const item of items || []) {
		const key = String(item?.id || item?.key || item?.action || item?.summary || JSON.stringify(item));
		if (!key || seen.has(key)) continue;
		seen.add(key);
		next.push(item);
	}
	return next;
}

function missionFindingPriority(finding: any) {
	const kind = String(finding?.kind || "");
	if (kind === "false_complete_suspicion") return 100;
	if (kind === "offline_team") return 95;
	if (kind === "dependency_deadlock") return 92;
	if (kind === "degraded_team") return 88;
	if (kind === "missing_output") return 84;
	if (kind === "stale_bridge") return 80;
	return finding?.severity === "critical" ? 90 : finding?.severity === "high" ? 75 : finding?.severity === "medium" ? 55 : 30;
}

function aggregateMissionRepairActions(run: any, teams: any[], agents: any[]) {
	return uniqueById([
		...(run?.repairActions || []),
		...teams.flatMap((team: any) => team?.repairActions || []),
		...agents.flatMap((agent: any) => agent?.repairActions || []),
		]).slice(0, 32);
}

function aggregateMissionFindings(run: any, teams: any[], agents: any[]) {
	return uniqueById([
		...(run?.doctorFindings || []),
		...teams.flatMap((team: any) => team?.doctorFindings || []),
		...agents.flatMap((agent: any) => agent?.doctorFindings || []),
	]).sort((left: any, right: any) => missionFindingPriority(right) - missionFindingPriority(left)).slice(0, 32);
}

function aggregateMissionRepairExecution(run: any, teams: any[], agents: any[]) {
	return uniqueById([
		...(run?.repairExecutionLog || []),
		...teams.flatMap((team: any) => team?.repairExecutionLog || []),
		...agents.flatMap((agent: any) => agent?.repairExecutionLog || []),
	]).slice(-24);
}

function collectRunMissionControl(runId: string, teamRecords?: any[]) {
	const run = resolveRunRecord(runId);
	const resolvedTeams = (teamRecords && teamRecords.length
		? teamRecords
		: (run.teamNames || []).map((teamName: string) => {
			try {
				return resolveTeamRecord(teamName);
			} catch {
				return null;
			}
		}).filter(Boolean)) as any[];
	const bridgeStatuses = listBridgeStatuses();
	const agents = uniqueStrings(resolvedTeams.flatMap((teamRecord: any) => (teamRecord.members || []).map((member: any) => member.alias)))
		.map((alias: string) => {
			try {
				const record = resolveAgentRecord(alias);
				return { ...record, bridge: bridgeStatusForAgent(record, bridgeStatuses) };
			} catch {
				return null;
			}
		})
		.filter(Boolean) as any[];
	const verificationState = run.verificationState || null;
	const findings = aggregateMissionFindings(run, resolvedTeams, agents);
	const repairActions = aggregateMissionRepairActions(run, resolvedTeams, agents);
	const repairExecution = aggregateMissionRepairExecution(run, resolvedTeams, agents);
	const recentEvents = readRunEvents(runId, 60)
		.slice(-28)
		.reverse()
		.map((event: any) => ({ ...event, severity: missionEventSeverity(event) }));
	const blockedAgents = agents.filter((agent: any) => agent.status === "blocked");
	const stalledAgents = agents.filter((agent: any) => agent.status === "stalled" || Number(agent.stallCount || 0) > 0);
	const waitingReviewTeams = resolvedTeams.filter((teamRecord: any) => teamRecord.status === "waiting_review");
	const dependencyGraph = collectDependencyGraph(agents, resolvedTeams);
	const dependencySummary = {
		total: dependencyGraph.length,
		open: dependencyGraph.filter((edge: any) => edge.open !== false).length,
		blocked: dependencyGraph.filter((edge: any) => edge.open !== false && edge.blocked).length,
		internal: dependencyGraph.filter((edge: any) => ["alias", "team", "role"].includes(String(edge.targetType || ""))).length,
		external: dependencyGraph.filter((edge: any) => String(edge.targetType || "") === "external").length,
	};
	const primaryInbox = uniqueBy([
		...(Array.isArray(run.primaryInbox) ? run.primaryInbox : []),
		...resolvedTeams.flatMap((teamRecord: any) => Array.isArray(teamRecord.primaryInbox) ? teamRecord.primaryInbox : []),
	]
		.filter(Boolean), (item: any) => `${item?.timestamp || ""}|${item?.kind || ""}|${item?.team || ""}|${item?.alias || ""}|${item?.summary || ""}`)
		.sort((left: any, right: any) => String(right?.timestamp || "").localeCompare(String(left?.timestamp || "")))
		.slice(0, 24);
	const recentCommunicationLog = uniqueBy([
		...(Array.isArray(run.communicationLog) ? run.communicationLog : []),
		...resolvedTeams.flatMap((teamRecord: any) => Array.isArray(teamRecord.communicationLog) ? teamRecord.communicationLog : []),
		...agents.flatMap((agent: any) => Array.isArray(agent.communicationLog) ? agent.communicationLog : []),
	]
		.filter(Boolean), (item: any) => `${item?.timestamp || ""}|${item?.direction || ""}|${item?.kind || ""}|${item?.team || ""}|${item?.alias || ""}|${item?.summary || ""}`)
		.sort((left: any, right: any) => String(right?.timestamp || "").localeCompare(String(left?.timestamp || "")))
		.slice(0, 40);
	const teamViews = resolvedTeams.map((teamRecord: any) => {
		const teamAgents = agents.filter((agent: any) => agent.team === teamRecord.team);
		const bridgeLinkedCount = teamAgents.filter((agent: any) => agent.bridge).length;
		const bridgeStaleCount = teamAgents.filter((agent: any) => agent.bridge?.bridgeAge?.stale).length;
		return {
			team: teamRecord.team,
			status: teamRecord.status || "unknown",
			memberCount: (teamRecord.members || []).length,
			liveCount: (teamRecord.members || []).filter((member: any) => {
				try {
					return Boolean(resolveAgentRecord(member.alias)?.live);
				} catch {
					return false;
				}
			}).length,
			bridgeLinkedCount,
			bridgeFreshCount: bridgeLinkedCount - bridgeStaleCount,
			bridgeStaleCount,
			blockerCount: teamRecord.blockerCount || 0,
			stalledCount: teamRecord.stalledCount || 0,
			openDependencyCount: teamRecord.openDependencyCount || dependencyGraph.filter((edge: any) => edge.fromTeam === teamRecord.team && edge.open !== false).length,
			lastLeadSummary: teamRecord.lastLeadSummary || null,
			lastRequestsToSwarm: teamRecord.lastRequestsToSwarm || null,
			lastTeamAction: teamRecord.lastTeamAction || null,
			lastObservationAt: teamRecord.lastObservedAt || null,
			lastObservationSummary: teamRecord.lastObservationSummary || null,
			lastTaskDispatchedAt: teamRecord.lastTaskDispatchedAt || null,
			lastTaskSummary: teamRecord.lastTaskSummary || null,
			observationCount: teamRecord.observationCount || 0,
			lastGuidanceAt: teamRecord.lastGuidanceAt || null,
			lastGuidanceSummary: teamRecord.lastGuidanceSummary || null,
			live: teamRecord.status !== "offline",
		};
	});
	const communicationQueue = uniqueStrings([
		...resolvedTeams.flatMap((teamRecord: any) => [
			teamRecord.lastRequestsToSwarm ? json({ kind: "request_to_swarm", team: teamRecord.team, text: teamRecord.lastRequestsToSwarm }) : null,
			teamRecord.lastTeamAction ? json({ kind: "next_team_action", team: teamRecord.team, text: teamRecord.lastTeamAction }) : null,
		]),
		...primaryInbox.slice(0, 12).map((item: any) => json({
			kind: item.kind || "primary_inbox",
			team: item.team || null,
			alias: item.alias || null,
			text: item.summary || item.message || "inbound report",
			status: item.status || null,
			timestamp: item.timestamp || null,
		})),
	].filter(Boolean) as string[])
		.map((item: string) => parseJson(item))
		.filter(Boolean)
		.concat(
			dependencyGraph
				.filter((edge: any) => edge.open !== false)
				.slice(0, 12)
				.map((edge: any) => ({
					kind: "dependency",
					team: edge.fromTeam,
					alias: edge.fromAlias,
					target: edge.target,
					text: edge.text || `${edge.fromAlias} -> ${edge.target}`,
					blocked: edge.blocked,
				})),
		)
		.slice(0, 28);
	const prioritizedFindingItems = findings.map((finding: any) => `${finding.kind}: ${summarize(finding.summary || "", 140)}`);
	const gateHoldItem = run.completionGateSatisfied === false ? `completion gate hold: ${summarize(run.completionGateSummary || "verification required", 160)}` : null;
	const verificationItem = verificationState?.status && verificationState.status !== "approved" && verificationState.status !== "none"
		? `verification ${verificationState.status}: ${verificationState.summary || "verification still required"}`
		: null;
	const failedRepairItems = repairExecution
		.filter((item: any) => /(failed|mixed)/i.test(String(item?.status || "")))
		.map((item: any) => `repair ${item.status}: ${item.action || item.note || "repair action"}`);
	const attentionItems = uniqueStrings([
		...(gateHoldItem ? [gateHoldItem] : []),
		...(verificationItem ? [verificationItem] : []),
		...prioritizedFindingItems,
		...failedRepairItems,
		...blockedAgents.map((agent: any) => `${agent.alias} blocked${agent.lastBlockers?.length ? `: ${agent.lastBlockers.join(" | ")}` : ""}`),
		...stalledAgents.map((agent: any) => `${agent.alias} stalled${agent.lastSummary ? `: ${summarize(agent.lastSummary, 120)}` : ""}`),
		...agents.filter((agent: any) => agent.lastBrowserRecoveryStatus === "failed").map((agent: any) => `${agent.alias} browser recovery failed`),
		...agents.filter((agent: any) => agent.lastPatternRunStatus === "failed").map((agent: any) => `${agent.alias} pattern run failed${agent.lastPatternTool ? ` (${agent.lastPatternTool})` : ""}`),
		...resolvedTeams.filter((teamRecord: any) => teamRecord.status === "blocked").map((teamRecord: any) => `team ${teamRecord.team} blocked`),
		...dependencyGraph
			.filter((edge: any) => edge.open !== false && (edge.blocked || edge.requiresAck))
			.map((edge: any) => `${edge.fromAlias} waiting on ${edge.target}${edge.text ? `: ${summarize(edge.text, 120)}` : ""}`),
		...communicationQueue.map((item: any) => `${item.team || item.alias || "run"}: ${item.text}`),
	]).slice(0, 18);
	return {
		runId,
		status: run.status || "unknown",
		taskSummary: summarize(run.title || run.task || run.goal || "", 180),
		operatorWorkspace: run.operatorWorkspace || null,
		operatorSurface: run.operatorSurface || null,
		lastMissionControlAt: run.lastMissionControlAt || null,
		lastProgressReportAt: run.lastProgressReportAt || null,
		lastTaskDispatchedAt: run.lastTaskDispatchedAt || null,
		lastTaskSummary: run.lastTaskSummary || null,
		primaryCompletionNotifiedAt: run.primaryCompletionNotifiedAt || null,
		lastRoundNumber: run.lastRoundNumber ?? null,
		roundsCompleted: run.roundsCompleted ?? null,
		coordinatorCompletion: typeof run.coordinatorCompletion === "boolean" ? run.coordinatorCompletion : null,
		synthesisCompletion: typeof run.synthesisCompletion === "boolean" ? run.synthesisCompletion : null,
		synthesisSummary: run.synthesisSummary || null,
		operatorFeedSummary: run.operatorFeedSummary || null,
		lastObservationAt: run.lastObservedAt || null,
		lastObservationSummary: run.lastObservationSummary || null,
		observationCount: run.observationCount || 0,
		lastGuidanceAt: run.lastGuidanceAt || null,
		lastGuidanceSummary: run.lastGuidanceSummary || null,
		completionGateSatisfied: typeof run.completionGateSatisfied === "boolean" ? run.completionGateSatisfied : null,
		completionGateSummary: run.completionGateSummary || null,
		verificationState,
		lastVerificationAt: run.lastVerificationAt || null,
		lastVerificationSummary: run.lastVerificationSummary || null,
		lastVerificationStatus: run.lastVerificationStatus || null,
		findings,
		findingSummary: {
			total: findings.length,
			critical: findings.filter((item: any) => item.severity === "critical").length,
			high: findings.filter((item: any) => item.severity === "high").length,
		},
		repairActions,
		repairSummary: {
			total: repairActions.length,
			auto: repairActions.filter((item: any) => item.safeAutoExecute).length,
			manual: repairActions.filter((item: any) => !item.safeAutoExecute).length,
		},
		repairExecution,
		repairExecutionSummary: {
			total: repairExecution.length,
			executed: repairExecution.filter((item: any) => String(item.status || "").includes("executed")).length,
			failed: repairExecution.filter((item: any) => /(failed|mixed)/i.test(String(item.status || ""))).length,
			skipped: repairExecution.filter((item: any) => String(item.status || "") === "skipped").length,
		},
		repairEffectiveness: run.repairEffectiveness || null,
		lastRepairEffectivenessSummary: run.lastRepairEffectivenessSummary || null,
		primaryConcern: attentionItems[0] || run.operatorFeedSummary || null,
		liveTeamCount: teamViews.filter((team: any) => team.live).length,
		liveAgentCount: agents.filter((agent: any) => agent.live !== false).length,
		bridgeLinkedAgentCount: agents.filter((agent: any) => agent.bridge).length,
		bridgeFreshAgentCount: agents.filter((agent: any) => agent.bridge && !agent.bridge?.bridgeAge?.stale).length,
		bridgeStaleAgentCount: agents.filter((agent: any) => agent.bridge?.bridgeAge?.stale).length,
		bridgeActivity: run.bridgeActivity || summarizeRunBridgeState(agents),
		blockedAgentCount: blockedAgents.length,
		stalledAgentCount: stalledAgents.length,
		waitingReviewTeamCount: waitingReviewTeams.length,
		dependencyGraph,
		dependencySummary,
		teams: teamViews,
		agents: agents,
		attentionItems,
		primaryInbox,
		recentCommunicationLog,
		communicationQueue,
		recentEvents,
	};
}

function persistMissionControlSnapshot(runId: string, teamRecords?: any[]) {
	const snapshot = collectRunMissionControl(runId, teamRecords);
	upsertRunRecord({
		runId,
		missionControl: snapshot,
		lastMissionControlAt: nowIso(),
		operatorFeedSummary: snapshot.attentionItems?.[0] || snapshot.primaryInbox?.[0]?.summary || snapshot.teams?.[0]?.lastLeadSummary || null,
		lastPrimaryInboxAt: snapshot.primaryInbox?.[0]?.timestamp || undefined,
		lastPrimaryInboxSummary: snapshot.primaryInbox?.[0]?.summary || undefined,
	});
	return snapshot;
}

let primaryActivityCtx: any = null;
const primaryActivityTimers = new Map<string, any>();
const primaryActivityHashes = new Map<string, string>();
const primaryFinalizationCleanupInFlight = new Set<string>();

function rememberPrimaryActivityContext(ctx: any) {
	if (ctx?.hasUI && ctx?.ui?.setWidget) primaryActivityCtx = ctx;
}

function missionActivityCutoff(snapshot: any) {
	const timestamps = [snapshot?.lastTaskDispatchedAt, ...(snapshot?.teams || []).map((team: any) => team.lastTaskDispatchedAt)].filter(Boolean);
	return timestamps.sort().slice(-1)[0] || snapshot?.createdAt || null;
}

function timeAfter(value: string | null | undefined, cutoff: string | null | undefined) {
	if (!value) return false;
	if (!cutoff) return true;
	return new Date(value).getTime() >= new Date(cutoff).getTime();
}

function agentCompletionForActivity(agent: any, cutoff: string | null | undefined) {
	const status = String(agent?.status || "").toLowerCase();
	if (/launch_failed|failed|blocked/.test(status)) return { done: false, failed: true, label: status || "failed" };
	if (/(done|complete|completed)/.test(status) && timeAfter(agent?.updatedAt || agent?.lastObservedAt, cutoff)) return { done: true, failed: false, label: "done" };
	if (agent?.lastAgentEndAt && timeAfter(agent.lastAgentEndAt, cutoff)) return { done: true, failed: false, label: "done" };
	if (agent?.lastBridgeEventType === "agent_end" && timeAfter(agent?.lastBridgeEventAt, cutoff)) return { done: true, failed: false, label: "done" };
	if (agent?.bridgeAgentLoopStatus === "working" || agent?.lastBridgeEventType === "agent_start" || agent?.lastBridgeEventType === "turn_start") return { done: false, failed: false, label: "working" };
	if (agent?.lastBridgeEventType === "before_agent_start") return { done: false, failed: false, label: "started" };
	return { done: false, failed: false, label: status || agent?.bridgeAgentLoopStatus || "waiting" };
}

function missionActivityCompletion(snapshot: any) {
	const agents = snapshot?.agents || [];
	const cutoff = missionActivityCutoff(snapshot);
	const states = agents.map((agent: any) => ({ agent, ...agentCompletionForActivity(agent, cutoff) }));
	const done = states.filter((state: any) => state.done).length;
	const failed = states.filter((state: any) => state.failed).length;
	return {
		cutoff,
		done,
		failed,
		total: states.length,
		complete: states.length > 0 && failed === 0 && done === states.length,
		states,
	};
}

const ACTIVITY_WIDGET_WIDTH = 118;

function stripAnsiForWidth(value: string) {
	return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visualLength(value: string) {
	return stripAnsiForWidth(value).length;
}

function fitCell(value: unknown, width: number, align: "left" | "right" = "left") {
	let text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (visualLength(text) > width) text = `${text.slice(0, Math.max(0, width - 1))}…`;
	const pad = Math.max(0, width - visualLength(text));
	return align === "right" ? `${" ".repeat(pad)}${text}` : `${text}${" ".repeat(pad)}`;
}

function boxLine(left: string, fill: string, right: string, label = "", width = ACTIVITY_WIDGET_WIDTH) {
	const cleanLabel = label ? ` ${label} ` : "";
	const fillCount = Math.max(0, width - visualLength(left) - visualLength(right) - visualLength(cleanLabel));
	return `${left}${cleanLabel}${fill.repeat(fillCount)}${right}`;
}

function boxedText(text: string, width = ACTIVITY_WIDGET_WIDTH) {
	return `│ ${fitCell(text, width - 4)} │`;
}

function activitySpinner() {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	return frames[Math.floor(Date.now() / 250) % frames.length];
}

function activityStaticPulse() {
	return "◌";
}

function activityStatusToken(state: any) {
	const label = String(state?.label || "waiting").toLowerCase();
	if (state?.failed) return { icon: "◆", text: "BLOCKED", rail: "▓▓░░" };
	if (state?.done) return { icon: "✓", text: "DONE", rail: "▓▓▓▓" };
	if (label === "working" || label === "turn_finished") return { icon: "●", text: "WORKING", rail: "▓▓▓░" };
	if (label === "started" || label === "prompt_received") return { icon: "◐", text: "STARTED", rail: "▓▓░░" };
	return { icon: "◇", text: "WAITING", rail: "▓░░░" };
}

function activityProgressBar(done: number, total: number, width = 28) {
	const pct = total ? Math.round((done / total) * 100) : 0;
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return { pct, text: `${"█".repeat(filled)}${"░".repeat(width - filled)}` };
}

function roleLabel(role: string | null | undefined, alias: string | null | undefined) {
	const raw = String(role || alias || "agent").replace(/-/g, " ");
	return raw.replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderPrimaryActivityWidget(snapshot: any) {
	const completion = missionActivityCompletion(snapshot);
	const teams = snapshot?.teams || [];
	const agents = snapshot?.agents || [];
	const recentComms = snapshot?.recentCommunicationLog || [];
	const progress = activityProgressBar(completion.done, completion.total, 32);
	const activeCount = completion.states.filter((state: any) => !state.done && !state.failed).length;
	const runId = String(snapshot?.runId || "run");
	const task = summarize(snapshot?.taskSummary || snapshot?.lastTaskSummary || "CMUX team run", 92);
	const runStatus = String(snapshot?.status || "active").toUpperCase();
	const lastSignal = summarize(snapshot?.primaryConcern || snapshot?.operatorFeedSummary || "team telemetry online", 96);
	const spin = activityStaticPulse();
	const lines: string[] = [];
	const sep = "─".repeat(96);
	const rail = "  │";

	lines.push(`  ╭─ ${spin}  CMUX TEAM OPS  ·  ${runStatus}  ${sep.slice(0, 46)}`);
	lines.push(`${rail}  MISSION   ${task}`);
	lines.push(`${rail}  RUN       ${summarize(runId, 54)}    AGENTS ${completion.done}/${completion.total} done · ${activeCount} active · ${completion.failed} blocked`);
	lines.push(`${rail}  PROGRESS  ${progress.text}  ${fitCell(`${progress.pct}%`, 4, "right")}`);
	lines.push(`${rail}  SIGNAL    ${lastSignal}`);

	lines.push(`  ├─ TEAM TOPOLOGY ${sep.slice(0, 78)}`);
	if (teams.length) {
		for (const team of teams.slice(0, 4)) {
			const teamAgents = agents.filter((item: any) => item.team === team.team);
			const teamStates = completion.states.filter((item: any) => item.agent.team === team.team);
			const teamDone = teamStates.filter((item: any) => item.done).length;
			const teamProgress = activityProgressBar(teamDone, teamAgents.length || team.memberCount || 0, 16);
			const bridgeDots = `${"●".repeat(Math.min(8, Number(team.bridgeFreshCount || 0)))}${"○".repeat(Math.max(0, Math.min(8, Number(team.bridgeLinkedCount || 0)) - Number(team.bridgeFreshCount || 0)))}` || "○";
			lines.push(`${rail}  ◈ ${fitCell(team.team, 34)} ${fitCell(String(team.status || "active").toUpperCase(), 10)} ${teamProgress.text} ${fitCell(`${teamProgress.pct}%`, 4, "right")}  bridge ${fitCell(bridgeDots, 8)} ${team.bridgeFreshCount || 0}/${team.bridgeLinkedCount || 0}`);
		}
	} else {
		lines.push(`${rail}  ◇ waiting for team registry`);
	}

	lines.push(`  ├─ AGENT DECK ${sep.slice(0, 82)}`);
	for (const agent of agents.slice(0, 7)) {
		const state = completion.states.find((item: any) => item.agent.alias === agent.alias) || agentCompletionForActivity(agent, completion.cutoff);
		const token = activityStatusToken(state);
		const summary = summarize(agent.lastAssistantSummary || agent.lastBridgeSummary || agent.lastObservationSummary || agent.lastCommunicationSummary || agent.lastGuidanceSummary || "standing by", 72);
		const role = roleLabel(agent.role, agent.alias);
		lines.push(`${rail}  ${token.icon} ${fitCell(token.text, 8)}  ${fitCell(role, 32)} ${token.rail}  ${summarize(agent.alias, 46)}`);
		lines.push(`${rail}      signal  ${summary}`);
	}
	if (agents.length > 7) lines.push(`${rail}      + ${agents.length - 7} additional agent(s) active in team workspace`);
	if (!agents.length) lines.push(`${rail}  ◇ waiting for spawned agents to register`);

	lines.push(`  ├─ COMMUNICATION BUS ${sep.slice(0, 76)}`);
	if (recentComms.length) {
		for (const item of recentComms.slice(0, 4)) {
			const who = summarize(item.alias || item.team || "run", 38);
			const kind = String(item.kind || "report").replace(/_/g, " ").toUpperCase();
			const text = summarize(item.summary || item.message || item.detail || "", 70);
			lines.push(`${rail}  ↳ ${fitCell(who, 38)} ${fitCell(kind, 15)} ${text}`);
		}
	} else {
		lines.push(`${rail}  ↳ waiting for first inbound agent report`);
	}

	const footer = completion.complete
		? "✓ COMPLETE · final results delivered · team/workspace auto-delete now"
		: completion.failed
			? "◆ ATTENTION · blocked agents require primary review"
			: `${spin} LIVE · team workspace running · primary Pi will auto-close on completion`;
	lines.push(`  ├─ HANDOFF ${sep.slice(0, 86)}`);
	lines.push(`${rail}  ${footer}`);
	lines.push("  ╰─" + sep.slice(0, 96));
	return lines.map((line) => summarize(line, 122)).slice(0, 30);
}

function updatePrimaryActivityWidget(runId: string, teamRecords?: any[]) {
	if (!primaryActivityCtx?.hasUI || !primaryActivityCtx?.ui?.setWidget) return null;
	let snapshot: any = null;
	try {
		const run = resolveRunRecord(runId);
		if (run?.primaryActivityClosedAt || run?.primaryFinalizationCleanupAt || run?.shutdownAt) {
			stopPrimaryActivityForRun(runId);
			clearPrimaryActivityWidget();
			return null;
		}
		snapshot = persistMissionControlSnapshot(runId, teamRecords);
		const lines = renderPrimaryActivityWidget(snapshot);
		const hash = createHash("sha1").update(JSON.stringify({ runId, lines })).digest("hex");
		if (primaryActivityHashes.get(runId) !== hash) {
			primaryActivityHashes.set(runId, hash);
			primaryActivityCtx.ui.setWidget("cmux-orchestrator-activity", lines, { placement: "aboveEditor" });
		}
		const completion = missionActivityCompletion(snapshot);
		primaryActivityCtx.ui.setStatus("cmux-orchestrator", completion.complete ? `CMUX team done ${completion.done}/${completion.total}` : `CMUX team ${completion.done}/${completion.total}`);
	} catch {
		// UI updates must never break orchestration.
	}
	return snapshot;
}

function stopPrimaryActivityMonitor(runId: string) {
	const existing = primaryActivityTimers.get(runId);
	if (existing) clearInterval(existing);
	primaryActivityTimers.delete(runId);
	primaryActivityHashes.delete(runId);
}

function clearPrimaryActivityWidget() {
	try {
		// Pass the original placement while clearing so UI runtimes that key widgets by
		// both id and placement remove the visible activity module rather than leaving
		// a stale above-editor panel behind.
		primaryActivityCtx?.ui?.setWidget?.("cmux-orchestrator-activity", undefined, { placement: "aboveEditor" });
		primaryActivityCtx?.ui?.setStatus?.("cmux-orchestrator", undefined);
		primaryActivityCtx?.ui?.setWorkingMessage?.();
		primaryActivityHashes.clear();
	} catch {
		// ignore
	}
}

function notifyPrimaryWhenMissionComplete(pi: ExtensionAPI, runId: string, snapshot: any) {
	const completion = missionActivityCompletion(snapshot);
	if (!completion.complete) return false;
	const runStatus = String(snapshot?.status || "").toLowerCase();
	const finalResultsDelivered = runStatus === "done" || snapshot?.synthesisCompletion === true || Boolean(snapshot?.completedAt);
	// Agents can all finish their current turns while the orchestrator is still
	// doing coordination or final synthesis. Only notify/cleanup once the run has
	// actually delivered final results into the primary Pi state.
	if (!finalResultsDelivered) return false;
	try {
		const run = resolveRunRecord(runId);
		if (run.primaryCompletionNotifiedAt) return false;
		if (run.orchestrationInProgress) return false;
		if (!cleanupAllowedForRun(run)) return false;
		const notifiedAt = nowIso();
		upsertRunRecord({
			runId,
			status: run.status === "blocked" ? run.status : "waiting_primary_finalization",
			primaryCompletionNotifiedAt: notifiedAt,
			primaryCompletionSummary: `All ${completion.total} agent(s) reported completion after task dispatch.`,
		});
		appendRunEvent(runId, { type: "primary_completion_notified", status: "complete", detail: `agents=${completion.done}/${completion.total}` });
		primaryActivityCtx?.ui?.notify?.(`CMUX team ${runId} completed; final report queued.`, "info");
		pi.sendUserMessage([
			`CMUX_ORCHESTRATOR_AUTO_UPDATE: Team run ${runId} appears complete.`,
			`All ${completion.total} agent(s) have reported back after task dispatch.`,
			"Final results have been delivered to this primary Pi session. Synthesize the agents' findings from the queued report/mission-control state, identify errors/oversights/opportunities, and deliver the final report to the user. Do not ask the user to prompt again unless information is missing.",
			"CMUX Orchestrator is now shutting down/deleting the live team workspace(s) for this run and closing the CMUX TEAM OPS activity module in this primary Pi session.",
		].join("\n"), { deliverAs: "followUp" });
		setTimeout(() => {
			cleanupRunAfterPrimaryDelivery(pi, primaryActivityCtx, runId, {
				reason: "primary_delivery",
				timeout: 12_000,
				notify: true,
			}).catch(() => {
				closePrimaryActivityForIdleCompletion(runId, snapshot, "primary-delivery-cleanup-fallback");
			});
		}, 250);
		return true;
	} catch {
		return false;
	}
}

function startPrimaryActivityMonitor(pi: ExtensionAPI, runId: string, teamRecords?: any[], options: { intervalMs?: number; stopOnComplete?: boolean } = {}) {
	if (!runId) return;
	if (!primaryActivityCtx?.hasUI) return;
	if (primaryActivityTimers.has(runId)) return;
	updatePrimaryActivityWidget(runId, teamRecords);
	const timer = setInterval(() => {
		const snapshot = updatePrimaryActivityWidget(runId);
		if (!snapshot) return;
		const notified = notifyPrimaryWhenMissionComplete(pi, runId, snapshot);
		if (notified && options.stopOnComplete !== false) {
			stopPrimaryActivityMonitor(runId);
			return;
		}
		if (options.stopOnComplete !== false) {
			closePrimaryActivityForIdleCompletion(runId, snapshot, "monitor-all-agents-complete-idle");
		}
	}, options.intervalMs || 4_000);
	primaryActivityTimers.set(runId, timer);
}

function restorePrimaryActivityMonitors(pi: ExtensionAPI, ctx: any) {
	rememberPrimaryActivityContext(ctx);
	if (!ctx?.hasUI) return;
	const recentCutoffMs = Date.now() - 24 * 60 * 60 * 1000;
	const runs = Object.values(readRunRegistry().runs || {})
		.filter((run: any) => {
			const updatedMs = new Date(run?.updatedAt || run?.createdAt || 0).getTime();
			return run && Number.isFinite(updatedMs) && updatedMs >= recentCutoffMs && !run.primaryCompletionNotifiedAt && !run.primaryActivityClosedAt && !run.primaryFinalizationCleanupAt && !run.shutdownAt && ["active", "working", "blocked", "waiting_review", "launching"].includes(String(run.status || "active"));
		})
		.sort((a: any, b: any) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
		.slice(0, 2) as any[];
	if (runs[0]) startPrimaryActivityMonitor(pi, runs[0].runId, undefined, { stopOnComplete: true });
}

function cleanupAllowedForRun(run: any) {
	const requestedDecision = String(run?.requestedTeamRetentionDecision || run?.teamRetentionDecision || "").toLowerCase();
	return run?.requestedShutdownOnComplete !== false && requestedDecision !== "keep-live";
}

function pendingPrimaryFinalizationRun(run: any) {
	if (!run?.runId) return false;
	if (!cleanupAllowedForRun(run)) return false;
	if (!run.primaryCompletionNotifiedAt) return false;
	if (run.primaryFinalizedAt || run.primaryFinalizationCleanupAt) return false;
	const status = String(run.status || "").toLowerCase();
	if (["blocked", "failed", "cancelled", "canceled"].includes(status)) return false;
	const timestamp = new Date(run.primaryCompletionNotifiedAt || run.updatedAt || run.createdAt || 0).getTime();
	return Number.isFinite(timestamp) && timestamp >= Date.now() - 48 * 60 * 60 * 1000;
}

function runMatchesPrimaryOperator(run: any, operatorTarget: any) {
	// Finalization cleanup runs from the primary Pi session after the team has
	// already delivered results.  If cmux focus/env detection is unavailable (or
	// the operator clicked another workspace), do not strand completed teams: fall
	// back to cleaning runs that were not bound to another explicit primary target.
	if (!operatorTarget || (!operatorTarget.sessionId && !operatorTarget.surface && !operatorTarget.workspace)) {
		return !run.operatorSessionId && !run.operatorSurface && !run.operatorWorkspace;
	}
	if (run.operatorSessionId && operatorTarget.sessionId && run.operatorSessionId === operatorTarget.sessionId) return true;
	if (run.operatorSurface && operatorTarget.surface && run.operatorSurface === operatorTarget.surface) return true;
	if (run.operatorWorkspace && operatorTarget.workspace && run.operatorWorkspace === operatorTarget.workspace) return true;
	return !run.operatorSessionId && !run.operatorSurface && !run.operatorWorkspace;
}

function messageTextForRunReference(message: any) {
	const content = message?.content ?? message?.message?.content ?? message;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((item: any) => typeof item === "string" ? item : item?.text || item?.content || "").filter(Boolean).join("\n");
	}
	return "";
}

function agentEndEventReferencesRun(event: any, runId: string) {
	const messages = Array.isArray(event?.messages) ? event.messages.slice(-16) : [];
	if (!messages.length) return true;
	return messages.some((message: any) => {
		const text = messageTextForRunReference(message);
		return text.includes("CMUX_ORCHESTRATOR_AUTO_UPDATE") && text.includes(runId);
	});
}

function stopPrimaryActivityForRun(runId: string) {
	stopPrimaryActivityMonitor(runId);
	primaryActivityHashes.delete(runId);
}

function closePrimaryActivityForIdleCompletion(runId: string, snapshot: any, reason = "all-agents-complete-idle") {
	try {
		const completion = missionActivityCompletion(snapshot);
		if (!completion.complete) return false;
		const run = resolveRunRecord(runId);
		if (run?.orchestrationInProgress) return false;
		const status = String(run?.status || snapshot?.status || "").toLowerCase();
		if (["launching", "working"].includes(status)) return false;
		const closedAt = run?.primaryActivityClosedAt || nowIso();
		if (!run?.primaryActivityClosedAt) {
			upsertRunRecord({
				runId,
				primaryActivityClosedAt: closedAt,
				primaryActivityCloseReason: reason,
				primaryActivityCompletionSummary: `Closed TEAM OPS module after ${completion.done}/${completion.total} agent(s) reported completion and orchestration was idle.`,
			});
			appendRunEvent(runId, { type: "primary_activity_auto_closed", status: "done", detail: reason });
		}
		stopPrimaryActivityForRun(runId);
		clearPrimaryActivityWidget();
		return true;
	} catch {
		return false;
	}
}

async function cleanupRunAfterPrimaryDelivery(
	pi: ExtensionAPI,
	ctx: any,
	runId: string,
	options: { event?: any; reason?: string; operatorTarget?: any; timeout?: number; notify?: boolean } = {},
) {
	if (!runId || primaryFinalizationCleanupInFlight.has(runId)) return null;
	primaryFinalizationCleanupInFlight.add(runId);
	try {
		rememberPrimaryActivityContext(ctx);
		const run = resolveRunRecord(runId);
		if (run.primaryFinalizationCleanupAt) return null;
		const operatorTarget = options.operatorTarget || await resolveOperatorTarget(pi, undefined, options.timeout || 8_000).catch(() => null);
		const teamNames = uniqueStrings(run.teamNames || []);
		const latestTeamRecords = teamNames.map((teamName: string) => {
			try { return resolveTeamRecord(teamName); } catch { return null; }
		}).filter(Boolean);
		const shutdownResults: any[] = [];
		for (const teamRecord of latestTeamRecords) {
			try {
				await shutdownTeam(pi, teamRecord, {
					closeSurface: true,
					closeWorkspace: true,
					preserveWorkspaces: uniqueStrings([operatorTarget?.workspace || run.operatorWorkspace || null]),
					timeout: options.timeout || 12_000,
				}, ctx);
				shutdownResults.push({ team: teamRecord.team, shutdown: true });
			} catch (error: any) {
				shutdownResults.push({ team: teamRecord.team, shutdown: false, error: String(error?.message || error || "shutdown failed") });
			}
		}
		const pruned = await pruneOfflineTeams(pi, undefined, options.timeout || 12_000, { runId, teamNames }).catch(() => null);
		discardPendingTeamRetention({ runId, teamNames });
		const finalizedAt = nowIso();
		const shutdownCount = shutdownResults.filter((item) => item.shutdown).length;
		upsertRunRecord({
			runId,
			status: run.status === "blocked" ? run.status : "done",
			primaryFinalizedAt: run.primaryFinalizedAt || finalizedAt,
			primaryFinalizationCleanupAt: finalizedAt,
			primaryActivityClosedAt: finalizedAt,
			primaryFinalizationAgentEvent: options.event?.type || options.reason || "primary_delivery",
			primaryFinalizationSummary: `Final results reached the primary Pi; auto-deleted ${shutdownCount}/${latestTeamRecords.length} live team(s) and closed the TEAM OPS module.`,
			shutdownAt: run.shutdownAt || finalizedAt,
			shutdownOnComplete: true,
			teamRetentionDecision: "destroy-after-primary-delivery",
		});
		appendRunEvent(runId, {
			type: options.reason === "primary_final_response" ? "primary_finalized_cleanup" : "primary_delivery_cleanup",
			status: "done",
			detail: `teams=${teamNames.join(",") || "none"} shutdown=${shutdownCount}/${latestTeamRecords.length}`,
			source: options.reason === "primary_final_response" ? "primary-pi" : "orchestrator",
		});
		stopPrimaryActivityForRun(runId);
		clearPrimaryActivityWidget();
		if (options.notify !== false) {
			primaryActivityCtx?.ui?.notify?.(`CMUX Orchestrator cleaned up run ${runId} and closed the TEAM OPS module.`, "info");
		}
		return { runId, teamNames, shutdownResults, pruned };
	} finally {
		primaryFinalizationCleanupInFlight.delete(runId);
	}
}

async function cleanupPrimaryFinalizedRuns(pi: ExtensionAPI, ctx: any, event?: any) {
	rememberPrimaryActivityContext(ctx);
	const operatorTarget = await resolveOperatorTarget(pi, undefined, 8_000).catch(() => null);
	const runs = Object.values(readRunRegistry().runs || {})
		.filter((run: any) => pendingPrimaryFinalizationRun(run) && (runMatchesPrimaryOperator(run, operatorTarget) || String(run.status || "").toLowerCase() === "waiting_primary_finalization") && agentEndEventReferencesRun(event, run.runId))
		.sort((a: any, b: any) => String(a.primaryCompletionNotifiedAt || a.updatedAt || "").localeCompare(String(b.primaryCompletionNotifiedAt || b.updatedAt || "")))
		.slice(0, 4) as any[];
	const cleaned: any[] = [];
	for (const run of runs) {
		const result = await cleanupRunAfterPrimaryDelivery(pi, ctx, run.runId, {
			event,
			reason: "primary_final_response",
			operatorTarget,
			timeout: 12_000,
			notify: false,
		}).catch((error: any) => ({ runId: run.runId, error: String(error?.message || error || "cleanup failed") }));
		if (result) cleaned.push(result);
	}
	if (cleaned.length) {
		clearPrimaryActivityWidget();
		primaryActivityCtx?.ui?.notify?.(`CMUX Orchestrator cleaned up ${cleaned.length} finalized run(s) and closed the TEAM OPS module.`, "info");
	}
	return cleaned;
}

function appendHistoryEntry(items: any, entry: any, limit = 16) {
	return [...(Array.isArray(items) ? items : []), entry].filter(Boolean).slice(-limit);
}

function persistCommunicationSnapshot(options: {
	runId?: string | null;
	team?: string | null;
	alias?: string | null;
	aliases?: string[];
	direction: "outbound" | "inbound" | "internal";
	kind: string;
	message?: string | null;
	summary?: string | null;
	round?: number | null;
	status?: string | null;
	payload?: any;
	inbox?: boolean;
}) {
	const timestamp = nowIso();
	const aliases = uniqueStrings([...(options.alias ? [options.alias] : []), ...(options.aliases || [])]);
	const summary = summarize(options.summary || options.message || "communication event", 320);
	const entry = {
		timestamp,
		direction: options.direction,
		kind: options.kind,
		team: options.team || null,
		alias: options.alias || (aliases.length === 1 ? aliases[0] : null),
		aliases,
		round: options.round ?? null,
		status: options.status || null,
		summary,
		payload: options.payload || null,
	};
	const shouldInbox = options.inbox !== false && (options.direction === "inbound" || /heartbeat|report|synthesis|reply|capture|dependency|blocker/i.test(options.kind));
	if (options.runId) {
		try {
			const runRecord = resolveRunRecord(options.runId);
			const runPatch: any = {
				runId: options.runId,
				lastCommunicationAt: timestamp,
				lastCommunicationKind: options.kind,
				lastCommunicationSummary: summary,
				communicationLog: appendHistoryEntry(runRecord.communicationLog, entry, 96),
			};
			if (shouldInbox) {
				runPatch.lastPrimaryInboxAt = timestamp;
				runPatch.lastPrimaryInboxSummary = summary;
				runPatch.primaryInbox = appendHistoryEntry(runRecord.primaryInbox, entry, 96);
			}
			upsertRunRecord(runPatch);
			appendRunEvent(options.runId, {
				type: `communication_${options.kind}`,
				status: options.status || "active",
				team: options.team || null,
				alias: options.alias || null,
				detail: summary,
				source: options.direction === "inbound" ? "agent" : options.direction === "outbound" ? "orchestrator" : "system",
			});
		} catch {
			// ignore missing run state
		}
	}
	if (options.team) {
		try {
			const teamRecord = resolveTeamRecord(options.team);
			const teamPatch: any = {
				...teamRecord,
				lastCommunicationAt: timestamp,
				lastCommunicationKind: options.kind,
				lastCommunicationSummary: summary,
				communicationLog: appendHistoryEntry(teamRecord.communicationLog, entry, 64),
			};
			if (shouldInbox) {
				teamPatch.lastPrimaryInboxAt = timestamp;
				teamPatch.lastPrimaryInboxSummary = summary;
				teamPatch.primaryInbox = appendHistoryEntry(teamRecord.primaryInbox, entry, 48);
			}
			upsertTeamRecord(teamPatch);
		} catch {
			// ignore missing team state
		}
	}
	for (const alias of aliases) {
		try {
			const agentRecord = resolveAgentRecord(alias);
			upsertAgentRecord({
				...agentRecord,
				lastCommunicationAt: timestamp,
				lastCommunicationKind: options.kind,
				lastCommunicationSummary: summary,
				communicationLog: appendHistoryEntry(agentRecord.communicationLog, { ...entry, alias, aliases: [] }, 48),
			});
		} catch {
			// ignore missing agent state
		}
	}
	return entry;
}

function persistGuidanceSnapshot(options: {
	runId?: string | null;
	team?: string | null;
	aliases?: string[];
	kind: string;
	message: string;
	round?: number | null;
	status?: string | null;
}) {
	const timestamp = nowIso();
	const entry = {
		timestamp,
		kind: options.kind,
		round: options.round ?? null,
		status: options.status || null,
		summary: summarize(options.message, 240),
	};
	if (options.runId) {
		try {
			const runRecord = resolveRunRecord(options.runId);
			upsertRunRecord({
				runId: options.runId,
				lastGuidanceAt: timestamp,
				lastGuidanceKind: options.kind,
				lastGuidanceSummary: entry.summary,
				guidanceLog: appendHistoryEntry(runRecord.guidanceLog, { ...entry, team: options.team || null, aliases: options.aliases || [] }, 48),
			});
		} catch {
			// ignore missing run state
		}
	}
	if (options.team) {
		try {
			const teamRecord = resolveTeamRecord(options.team);
			upsertTeamRecord({
				...teamRecord,
				lastGuidanceAt: timestamp,
				lastGuidanceKind: options.kind,
				lastGuidanceSummary: entry.summary,
				guidanceLog: appendHistoryEntry(teamRecord.guidanceLog, { ...entry, aliases: options.aliases || [] }, 24),
			});
		} catch {
			// ignore missing team state
		}
	}
	for (const alias of options.aliases || []) {
		try {
			const agentRecord = resolveAgentRecord(alias);
			upsertAgentRecord({
				...agentRecord,
				lastGuidanceAt: timestamp,
				lastGuidanceKind: options.kind,
				lastGuidanceSummary: entry.summary,
				guidanceLog: appendHistoryEntry(agentRecord.guidanceLog, { ...entry, team: options.team || null }, 16),
			});
		} catch {
			// ignore missing agent state
		}
	}
	persistCommunicationSnapshot({
		runId: options.runId || null,
		team: options.team || null,
		aliases: options.aliases || [],
		direction: "outbound",
		kind: options.kind,
		message: options.message,
		round: options.round ?? null,
		status: options.status || null,
		inbox: false,
	});
}

function persistObservationSnapshots(options: {
	runId?: string | null;
	teamRecords: any[];
	digests: any[];
	round: number;
	coordinatorHeartbeat?: any;
	teamLeadHeartbeats?: any[];
	roundDecision?: any;
}) {
	const timestamp = nowIso();
	const digestByAlias = new Map((options.digests || []).map((digest: any) => [digest.alias, digest]));
	const bridgeStatuses = listBridgeStatuses();
	for (const digest of options.digests || []) {
		let observationSummary = summarize(digest.summary || digest.deliverable || digest.next || "No observation summary.", 240);
		try {
			const agentRecord = resolveAgentRecord(digest.alias);
			const bridge = bridgeStatusForAgent(agentRecord, bridgeStatuses);
			upsertAgentRecord({
				...agentRecord,
				lastObservedAt: timestamp,
				lastObservedRound: options.round,
				lastObservationStatus: digest.status || null,
				lastObservationSummary: observationSummary,
				observationCount: Number(agentRecord.observationCount || 0) + 1,
				observationLog: appendHistoryEntry(agentRecord.observationLog, {
					timestamp,
					round: options.round,
					alias: digest.alias || agentRecord.alias,
					team: digest.team || agentRecord.team || null,
					role: digest.role || agentRecord.role || null,
					status: digest.status || null,
					summary: observationSummary,
					blocked: Boolean(digest.blocked),
					blockers: digest.blockers || [],
					artifacts: digest.artifacts || [],
					commands: digest.commands || [],
					urls: digest.urls || [],
					completion: Boolean(digest.completion),
					deliverable: digest.deliverable || null,
					next: digest.next || null,
					needs: digest.needs || null,
					dependencies: Array.isArray(digest.dependencies) ? digest.dependencies.slice(0, 8) : [],
					dependencyCount: Array.isArray(digest.dependencies) ? digest.dependencies.filter((dependency: any) => String(dependency?.status || "open") !== "resolved").length : 0,
					bridgeStale: Boolean(bridge?.bridgeAge?.stale),
				}, 24),
			});
		} catch {
			// ignore missing agent state
		}
		if (options.runId) {
			persistCommunicationSnapshot({
				runId: options.runId,
				team: digest.team || null,
				alias: digest.alias || null,
				direction: "inbound",
				kind: "agent_report",
				summary: observationSummary,
				round: options.round,
				status: digest.status || null,
				payload: {
					role: digest.role || null,
					blocked: Boolean(digest.blocked),
					blockers: digest.blockers || [],
					artifacts: digest.artifacts || [],
					commands: digest.commands || [],
					urls: digest.urls || [],
					completion: Boolean(digest.completion),
					deliverable: digest.deliverable || null,
					next: digest.next || null,
					needs: digest.needs || null,
					dependencies: Array.isArray(digest.dependencies) ? digest.dependencies.slice(0, 8) : [],
				},
			});
		}
	}
	for (const teamRecord of options.teamRecords || []) {
		try {
			const latestTeamRecord = resolveTeamRecord(teamRecord.team);
			const teamDigests = (teamRecord.members || []).map((member: any) => digestByAlias.get(member.alias)).filter(Boolean);
			const teamHeartbeat = (options.teamLeadHeartbeats || []).find((item: any) => item.team === teamRecord.team);
			const blockedCount = teamDigests.filter((digest: any) => digest.status === "blocked" || digest.blocked).length;
			const stalledCount = teamDigests.filter((digest: any) => digest.status === "stalled").length;
			const observationSummary = summarize(
				teamHeartbeat?.digest?.summary
					|| latestTeamRecord.lastLeadSummary
					|| teamDigests.map((digest: any) => `${digest.alias}: ${digest.summary}`).join(" | ")
					|| `Observed ${teamRecord.team}`,
				260,
			);
			upsertTeamRecord({
				...latestTeamRecord,
				lastObservedAt: timestamp,
				lastObservedRound: options.round,
				lastObservationStatus: latestTeamRecord.status || null,
				lastObservationSummary: observationSummary,
				observationCount: Number(latestTeamRecord.observationCount || 0) + 1,
				observationLog: appendHistoryEntry(latestTeamRecord.observationLog, {
					timestamp,
					round: options.round,
					team: teamRecord.team,
					status: latestTeamRecord.status || null,
					summary: observationSummary,
					blockedCount,
					stalledCount,
					openDependencyCount: latestTeamRecord.openDependencyCount || 0,
					observedAliases: teamDigests.map((digest: any) => digest.alias),
				}, 24),
			});
		} catch {
			// ignore missing team state
		}
	}
	if (options.runId) {
		try {
			const runRecord = resolveRunRecord(options.runId);
			const observationSummary = summarize(
				options.coordinatorHeartbeat?.digest?.summary
					|| options.roundDecision?.status
					|| `Observed round ${options.round}`,
				260,
			);
			upsertRunRecord({
				runId: options.runId,
				lastObservedAt: timestamp,
				lastObservedRound: options.round,
				lastObservationStatus: options.roundDecision?.status || null,
				lastObservationSummary: observationSummary,
				observationCount: Number(runRecord.observationCount || 0) + 1,
				observationLog: appendHistoryEntry(runRecord.observationLog, {
					timestamp,
					round: options.round,
					status: options.roundDecision?.status || null,
					summary: observationSummary,
					blockedCount: options.roundDecision?.blockedCount || 0,
					stalledCount: options.roundDecision?.stalledCount || 0,
					completionCount: options.roundDecision?.completionCount || 0,
					observedAliases: (options.digests || []).map((digest: any) => digest.alias),
					openDependencyCount: uniqueStrings((options.digests || []).flatMap((digest: any) => (digest?.dependencies || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved").map((dependency: any) => `${digest.alias}:${dependency.targetHint || dependency.text || "dependency"}`))).length,
				}, 48),
			});
		} catch {
			// ignore missing run state
		}
	}
}

async function notifyOrchestratorEvent(
	pi: ExtensionAPI,
	title: string,
	options: { subtitle?: string; body?: string; workspace?: string | null; surface?: string | null; signal?: AbortSignal; timeout?: number } = {},
) {
	const args = ["notify", "--title", title] as string[];
	addFlag(args, "--subtitle", options.subtitle);
	addFlag(args, "--body", options.body);
	addFlag(args, "--workspace", options.workspace);
	addFlag(args, "--surface", options.surface);
	return execCmux(pi, args, { signal: options.signal, timeout: options.timeout }).catch(() => null);
}

async function buildCmuxSessionFingerprint(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const identify = (await execCmuxRpc(pi, "system.identify", {}, { signal, timeout })).data;
	const tree = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
	const treeHash = createHash("sha1").update(JSON.stringify(tree || {})).digest("hex").slice(0, 12);
	return {
		socketPath: identify?.socket_path || process.env.CMUX_SOCKET_PATH || process.env.CMUX_SOCKET || null,
		focusedWorkspace: identify?.focused?.workspace_ref || null,
		focusedSurface: identify?.focused?.surface_ref || null,
		treeHash,
		observedAt: nowIso(),
		sessionId: `${identify?.socket_path || "socket"}:${treeHash}`,
	};
}

function agentRegistryFile() {
	return storage.agentRegistryFile();
}

function readAgentRegistry() {
	return storage.readAgentRegistry();
}

function writeAgentRegistry(registry: any) {
	return storage.writeAgentRegistry(registry);
}

function upsertAgentRecord(record: any) {
	return storage.upsertAgentRecord(record);
}

function removeAgentRecord(alias: string) {
	return storage.removeAgentRecord(alias);
}

async function currentWorkspaceRef(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const data = (await execCmuxRpc(pi, "workspace.current", {}, { signal, timeout })).data;
	return data.workspace_ref || data.workspace?.ref || null;
}

async function resolveOperatorTarget(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const env = collectCmuxEnv();
	const fingerprint = await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	return {
		workspace: env.CMUX_WORKSPACE_ID || fingerprint?.focusedWorkspace || await currentWorkspaceRef(pi, signal, timeout).catch(() => null),
		surface: env.CMUX_SURFACE_ID || fingerprint?.focusedSurface || null,
		sessionId: fingerprint?.sessionId || null,
	};
}

async function listWorkspaces(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const data = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
	return data.workspaces || [];
}

function findNewWorkspace(before: any[], after: any[], preferredTitle?: string) {
	const beforeIds = new Set((before || []).map((workspace: any) => workspace.id));
	return (
		(after || []).find((workspace: any) => !beforeIds.has(workspace.id) && (!preferredTitle || workspace.title === preferredTitle)) ||
		(after || []).find((workspace: any) => !beforeIds.has(workspace.id)) ||
		(after || []).find((workspace: any) => preferredTitle && workspace.title === preferredTitle) ||
		null
	);
}

async function listWorkspaceSurfaces(
	pi: ExtensionAPI,
	workspace?: string,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const data = (
		await execCmuxRpc(
			pi,
			"surface.list",
			workspace ? { workspace_id: workspace } : {},
			{ signal, timeout },
		)
	).data;
	return data.surfaces || [];
}

function findNewSurface(before: any[], after: any[], preferredType = "terminal") {
	const beforeIds = new Set((before || []).map((surface: any) => surface.id));
	const created = (after || []).filter((surface: any) => !beforeIds.has(surface.id));
	return (
		created.find((surface: any) => surface.type === preferredType) ||
		created[0] ||
		(after || []).filter((surface: any) => surface.type === preferredType).slice().sort((a: any, b: any) => (b.index ?? 0) - (a.index ?? 0))[0] ||
		null
	);
}

async function waitForWorkspaceTerminalSurface(
	pi: ExtensionAPI,
	workspace: string,
	options: { before?: any[]; preferredType?: string; attempts?: number; intervalMs?: number; signal?: AbortSignal; timeout?: number; requireTty?: boolean } = {},
) {
	const attempts = options.attempts ?? 40;
	const intervalMs = options.intervalMs ?? 250;
	const preferredType = options.preferredType || "terminal";
	const requireTty = options.requireTty !== false && preferredType === "terminal";
	let candidate: any = null;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const after = await listWorkspaceSurfaces(pi, workspace, options.signal, options.timeout ?? DEFAULT_TIMEOUT).catch(() => []);
		const live = requireTty ? await liveSurfaceMap(pi, options.signal, options.timeout ?? DEFAULT_TIMEOUT).catch(() => new Map()) : null;
		const liveWorkspaceSurfaces = live
			? Array.from(live.values()).filter((entry: any) =>
				(entry.workspaceRef && entry.workspaceRef === workspace) ||
				(entry.workspaceId && entry.workspaceId === workspace),
			)
			: [];
		const surface = options.before
			? findNewSurface(options.before, after, preferredType) || (requireTty ? findNewSurface(options.before, liveWorkspaceSurfaces, preferredType) : null)
			: after.find((entry: any) => entry.focused && entry.type === preferredType) ||
				after.find((entry: any) => entry.selected_in_pane && entry.type === preferredType) ||
				(requireTty ? liveWorkspaceSurfaces.find((entry: any) => entry.focused && entry.type === preferredType) : null) ||
				(requireTty ? liveWorkspaceSurfaces.find((entry: any) => entry.selected_in_pane && entry.type === preferredType) : null) ||
				after.find((entry: any) => entry.type === preferredType) ||
				(requireTty ? liveWorkspaceSurfaces.find((entry: any) => entry.type === preferredType) : null) ||
				null;
		if (surface) {
			const liveSurface = live ? live.get(surface.ref) || live.get(surface.id) : null;
			const enriched = liveSurface ? { ...surface, ...liveSurface } : surface;
			candidate = enriched;
			if (!requireTty || enriched.tty) return enriched;
		}
		if (attempt === 2 || attempt === 6) {
			await execCmux(pi, ["select-workspace", "--workspace", workspace], {
				signal: options.signal,
				timeout: Math.min(options.timeout ?? DEFAULT_TIMEOUT, 5_000),
			}).catch(() => null);
		}
		if (attempt < attempts - 1) await sleep(intervalMs);
	}
	return candidate;
}

async function liveSurfaceMap(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const tree = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
	const map = new Map<string, any>();
	for (const window of tree.windows || []) {
		for (const workspace of window.workspaces || []) {
			for (const pane of workspace.panes || []) {
				for (const surface of pane.surfaces || []) {
					const enriched = {
						...surface,
						workspaceRef: workspace.ref,
						workspaceId: workspace.id,
						workspaceTitle: workspace.title,
						paneRef: pane.ref,
						windowRef: window.ref,
					};
					if (surface.ref) map.set(surface.ref, enriched);
					if (surface.id) map.set(surface.id, enriched);
				}
			}
		}
	}
	return map;
}

async function requireLiveSurface(
	pi: ExtensionAPI,
	target: { workspace?: string | null; surface?: string | null },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const live = await liveSurfaceMap(pi, signal, timeout);
	if (!target.surface) return { live, surface: null, workspace: target.workspace || null };
	const surface = live.get(target.surface);
	if (!surface) {
		const scope = target.workspace ? ` in ${target.workspace}` : "";
		throw new Error(`Surface ${target.surface}${scope} is not live. Re-list surfaces or prune stale agent/team records before retrying.`);
	}
	return {
		live,
		surface,
		workspace: target.workspace || surface.workspaceRef || null,
	};
}

function resolveAgentRecord(alias: string) {
	return storage.resolveAgentRecord(alias);
}

async function launchPiAgent(
	pi: ExtensionAPI,
	params: any,
	ctx: any,
	signal?: AbortSignal,
) {
	if (!params.alias) throw new Error("alias is required for launch");
	const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT;
	const target = params.target || "split";
	const cwd = params.cwd || ctx?.cwd;
	const prompt = params.prompt || params.message || undefined;
	const workspaceTitle = params.workspaceTitle || defaultAgentWorkspaceTitle({
		alias: params.alias,
		team: params.team,
		role: params.role,
		lead: Boolean(params.lead),
	});
	const workspaceDescription = params.workspaceDescription || defaultAgentWorkspaceDescription({
		goal: params.goal || params.task || null,
		runId: params.runId,
		team: params.team,
		role: params.role,
		layout: target === "new_workspace" ? "standalone" : params.layout,
	});
	const surfaceTitle = params.surfaceTitle || defaultAgentSurfaceTitle({
		alias: params.alias,
		role: params.role,
		lead: Boolean(params.lead),
	});
	const sessionPath = params.sessionPath || defaultSessionPath(params.alias, params.runId);
	const promptFile = writeLaunchPromptFile(sessionPath, prompt);
	const sessionFingerprint = params.cmuxSessionFingerprint || await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	const fullLaunchCommand = buildPiLaunchCommand({
		alias: params.alias,
		cwd,
		prompt: promptFile ? undefined : prompt,
		promptFile: promptFile || undefined,
		provider: params.provider,
		model: params.model,
		thinking: params.thinking,
		tools: params.tools,
		noExtensions: params.noExtensions,
		noSkills: params.noSkills,
		sessionPath,
		extraArgs: params.extraArgs,
		interfaceMode: params.interfaceMode || params.interface || "terminal",
		taskId: params.taskId || null,
		runId: params.runId || null,
		teamId: params.team || null,
		agentId: params.agentId || params.alias,
		agentAlias: params.alias,
		role: params.role || null,
		launcher: "cmux-orchestrator",
		launchMode: params.team ? "team" : "solo",
	});
	const launchScriptPath = writeLaunchScriptFile(sessionPath, fullLaunchCommand);
	const launchCommand = `bash ${shQ(launchScriptPath)}`;

	let workspaceRef = params.workspace || null;
	let resolvedWorkspaceTitle = workspaceTitle;
	let resolvedWorkspaceDescription = workspaceDescription;
	let surface: any = null;

	if (target === "new_workspace") {
		const beforeWorkspaces = await listWorkspaces(pi, signal, timeout).catch(() => []);
		await execCmux(
			pi,
			[
				"new-workspace",
				"--name",
				workspaceTitle,
				"--description",
				workspaceDescription,
				...(cwd ? ["--cwd", cwd] : []),
			],
			{ signal, timeout },
		);
		const afterWorkspaces = await listWorkspaces(pi, signal, timeout).catch(() => []);
		const createdWorkspace = findNewWorkspace(beforeWorkspaces, afterWorkspaces, workspaceTitle);
		workspaceRef = createdWorkspace?.ref || createdWorkspace?.workspace_ref || await currentWorkspaceRef(pi, signal, timeout);
		resolvedWorkspaceTitle = createdWorkspace?.title || workspaceTitle;
		resolvedWorkspaceDescription = createdWorkspace?.description || workspaceDescription;
		await execCmux(pi, ["select-workspace", "--workspace", workspaceRef], { signal, timeout: Math.min(timeout, 5_000) }).catch(() => null);
		surface = await waitForWorkspaceTerminalSurface(pi, workspaceRef, { signal, timeout, preferredType: "terminal", requireTty: true });
		if (!surface?.ref || !surface?.tty) throw new Error(`Created cmux workspace ${workspaceRef} did not expose a ready terminal surface`);
		await pasteTerminalMessage(
			pi,
			{ alias: params.alias, workspace: workspaceRef, surface: surface.ref },
			launchCommand,
			{ appendEnter: true, signal, timeout },
		);
	} else {
		workspaceRef = workspaceRef || (await currentWorkspaceRef(pi, signal, timeout));
		if (!workspaceRef) throw new Error("Could not resolve target workspace");
		const before = await listWorkspaceSurfaces(pi, workspaceRef, signal, timeout);

		if (target === "split") {
			await execCmux(
				pi,
				[
					"new-split",
					params.direction || "right",
					"--workspace",
					workspaceRef,
					...(params.surface ? ["--surface", params.surface] : []),
				],
				{ signal, timeout },
			);
		} else if (target === "pane") {
			const args = ["new-pane", "--type", "terminal", "--workspace", workspaceRef];
			if (params.direction) args.push("--direction", params.direction);
			await execCmux(pi, args, { signal, timeout });
		} else if (target === "surface") {
			const args = ["new-surface", "--type", "terminal", "--workspace", workspaceRef];
			if (params.pane) args.push("--pane", params.pane);
			await execCmux(pi, args, { signal, timeout });
		} else {
			throw new Error(`Unsupported launch target: ${target}`);
		}

		surface = await waitForWorkspaceTerminalSurface(pi, workspaceRef, {
			before,
			signal,
			timeout,
			preferredType: "terminal",
			requireTty: true,
		});
		if (!surface?.ref || !surface?.tty) throw new Error("Created cmux terminal surface could not be identified or did not become tty-ready");
		await pasteTerminalMessage(
			pi,
			{ alias: params.alias, workspace: workspaceRef, surface: surface.ref },
			launchCommand,
			{ appendEnter: true, signal, timeout },
		);
	}

	if (!workspaceRef || !surface) {
		throw new Error("Failed to resolve workspace or surface for launched agent");
	}

	if (workspaceRef && target !== "new_workspace") {
		const knownWorkspace = (await listWorkspaces(pi, signal, timeout).catch(() => [])).find((item: any) => item.ref === workspaceRef || item.workspace_ref === workspaceRef);
		resolvedWorkspaceTitle = knownWorkspace?.title || resolvedWorkspaceTitle;
		resolvedWorkspaceDescription = knownWorkspace?.description || resolvedWorkspaceDescription;
	}

	try {
		await execCmux(
			pi,
			["rename-tab", "--workspace", workspaceRef, "--surface", surface.ref, surfaceTitle],
			{ signal, timeout: Math.min(timeout, 10_000) },
		);
	} catch {
		// non-fatal
	}

	const record = upsertAgentRecord({
		alias: params.alias,
		role: params.role || null,
		team: params.team || null,
		runId: params.runId || null,
		kbTaskId: params.taskId || null,
		workspace: workspaceRef,
		workspaceTitle: resolvedWorkspaceTitle || null,
		workspaceDescription: resolvedWorkspaceDescription || null,
		surface: surface.ref,
		surfaceTitle: surfaceTitle,
		pane: surface.pane_ref || null,
		cwd: cwd || null,
		target,
		sessionPath,
		provider: params.provider || null,
		model: params.model || null,
		thinking: params.thinking || null,
		tools: params.tools || null,
		promptSummary: summarize(prompt, 180),
		promptFile: promptFile || null,
		launchScriptPath,
		status: "launching",
		live: true,
		lastHeartbeatAt: nowIso(),
		launchedAt: nowIso(),
		cmuxSessionId: sessionFingerprint?.sessionId || params.cmuxSessionId || null,
	});
	if (params.runId) {
		appendRunEvent(params.runId, {
			type: "agent_launched",
			team: params.team || null,
			alias: params.alias,
			status: "launching",
			detail: `workspace=${workspaceRef} title=${resolvedWorkspaceTitle || workspaceTitle} surface=${surface.ref} tab=${surfaceTitle}${promptFile ? " promptFile=yes" : ""} launchScript=yes`,
		});
	}
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_agent_launched", {
		alias: params.alias,
		team: params.team || null,
		workspace: workspaceRef,
		surface: surface.ref,
		role: params.role || null,
		summary: `Orchestrator launched agent ${params.alias}${params.team ? ` for team ${params.team}` : ""}.`,
	}, undefined, {
		taskId: params.taskId || null,
		runId: params.runId || null,
		teamId: params.team || null,
		agentId: params.agentId || params.alias,
		agentAlias: params.alias,
		workspaceId: workspaceRef,
		surfaceId: surface.ref,
		role: params.role || null,
		launcher: "cmux-orchestrator",
		launchMode: params.team ? "team" : "solo",
		interfaceMode: params.interfaceMode || params.interface || "terminal",
	}).catch(() => null);
	await syncSwarmPresence(pi, ctx, {
		cwd: params.cwd || ctx.cwd,
		projectLabel: params.projectLabel || undefined,
		taskId: params.taskId || null,
		runId: params.runId || null,
		teamId: params.team || null,
		agentAlias: params.alias,
		workspaceId: workspaceRef,
		surfaceId: surface.ref,
	}, {
		status: params.team ? "ready" : "active",
		note: `Orchestrator launched ${params.alias}${params.team ? ` for team ${params.team}` : ""}.`,
	}, { signal }).catch(() => null);

	return {
		record,
		workspaceRef,
		surfaceRef: surface.ref,
		surface,
		launchCommand,
		fullLaunchCommand,
		launchScriptPath,
	};
}

async function pasteTerminalMessage(
	pi: ExtensionAPI,
	target: { alias?: string | null; workspace?: string | null; surface: string },
	message: string | string[],
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const chunks = (Array.isArray(message) ? message : [message]).map((chunk) => String(chunk || "")).filter(Boolean);
	const bufferBase = `cmux-orchestrator-${safeFileSegment(target.alias || target.surface || "agent")}`;
	for (const [index, chunk] of chunks.entries()) {
		const bufferName = chunks.length === 1 ? bufferBase : `${bufferBase}-${index + 1}`;
		await execCmux(pi, ["set-buffer", "--name", bufferName, chunk], {
			signal: options.signal,
			timeout,
		});
		const pasteArgs = ["paste-buffer", "--name", bufferName] as string[];
		addFlag(pasteArgs, "--workspace", target.workspace);
		addFlag(pasteArgs, "--surface", target.surface);
		await execCmux(pi, pasteArgs, {
			signal: options.signal,
			timeout,
		});
	}
	if (options.appendEnter !== false) {
		const enterArgs = ["send-key"] as string[];
		addFlag(enterArgs, "--workspace", target.workspace);
		addFlag(enterArgs, "--surface", target.surface);
		enterArgs.push("enter");
		await execCmux(pi, enterArgs, {
			signal: options.signal,
			timeout,
		});
	}
	return { bufferName: bufferBase, chunkCount: Math.max(1, chunks.length) };
}

async function typeTerminalMessage(
	pi: ExtensionAPI,
	target: { workspace?: string | null; surface: string },
	chunks: string[],
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	for (const chunk of (chunks || []).filter(Boolean)) {
		await execCmux(pi, ["send", ...(target.workspace ? ["--workspace", target.workspace] : []), "--surface", target.surface, chunk], {
			signal: options.signal,
			timeout,
		});
	}
	if (options.appendEnter !== false) {
		const enterArgs = ["send-key"] as string[];
		addFlag(enterArgs, "--workspace", target.workspace);
		addFlag(enterArgs, "--surface", target.surface);
		enterArgs.push("enter");
		await execCmux(pi, enterArgs, {
			signal: options.signal,
			timeout,
		});
	}
	return { chunkCount: Math.max(1, (chunks || []).filter(Boolean).length) };
}

async function sendAgentMessage(
	pi: ExtensionAPI,
	target: { alias?: string; workspace?: string; surface?: string },
	message: string,
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	let workspace = target.workspace || null;
	let surface = target.surface || null;
	let alias = target.alias || null;
	if (alias) {
		const record = resolveAgentRecord(alias);
		workspace = workspace || record.workspace;
		surface = surface || record.surface;
	}
	if (!surface) throw new Error("surface is required to send a message");
	const rawMessage = String(message || "");
	const normalizedMessage = buildTerminalDispatchPayload(rawMessage);
	const dispatchChunks = splitTerminalDispatchPayload(rawMessage, 3500);
	const shouldUsePaste = normalizedMessage.length > 280 || dispatchChunks.length > 1;
	let transport: any = { mode: "send", chunkCount: dispatchChunks.length };
	if (shouldUsePaste) {
		try {
			transport = {
				mode: dispatchChunks.length > 1 ? "paste-buffer-chunked" : "paste-buffer",
				...(await pasteTerminalMessage(pi, { alias, workspace, surface }, dispatchChunks, {
					appendEnter: options.appendEnter !== false,
					signal: options.signal,
					timeout,
				})),
			};
			return { alias, workspace, surface, message: rawMessage, normalizedMessage, transport };
		} catch {
			transport = { mode: dispatchChunks.length > 1 ? "send-chunked-fallback" : "send-fallback", chunkCount: dispatchChunks.length };
		}
	}
	if (dispatchChunks.length > 1) {
		await typeTerminalMessage(pi, { workspace, surface }, dispatchChunks, {
			appendEnter: options.appendEnter !== false,
			signal: options.signal,
			timeout,
		});
		return { alias, workspace, surface, message: rawMessage, normalizedMessage, transport };
	}
	const payload = `${normalizedMessage}${options.appendEnter === false ? "" : "\n"}`;
	await execCmux(pi, ["send", ...(workspace ? ["--workspace", workspace] : []), "--surface", surface, payload], {
		signal: options.signal,
		timeout,
	});
	return { alias, workspace, surface, message: rawMessage, normalizedMessage, transport };
}

async function captureAgentScreen(
	pi: ExtensionAPI,
	target: { alias?: string; workspace?: string; surface?: string },
	options: { lines?: number; scrollback?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	let workspace = target.workspace || null;
	let surface = target.surface || null;
	let alias = target.alias || null;
	let record: any = null;
	if (alias) {
		record = resolveAgentRecord(alias);
		workspace = workspace || record.workspace;
		surface = surface || record.surface;
	}
	if (!surface) throw new Error("surface is required to capture a screen");
	try {
		const resolved = await requireLiveSurface(pi, { workspace, surface }, options.signal, timeout);
		workspace = resolved.workspace;
		surface = resolved.surface?.ref || surface;
		if (alias) {
			updateAgentStatus(alias, {
				workspace: workspace || record?.workspace || null,
				surface,
				pane: resolved.surface?.paneRef || record?.pane || null,
				live: true,
				lastHeartbeatAt: nowIso(),
			});
		}
	} catch (error) {
		if (alias) {
			updateAgentStatus(alias, {
				live: false,
				status: "offline",
				lastHeartbeatAt: nowIso(),
			});
		}
		throw error;
	}
	const args = ["read-screen"];
	addFlag(args, "--workspace", workspace);
	addFlag(args, "--surface", surface);
	if (options.scrollback !== false) args.push("--scrollback");
	addFlag(args, "--lines", options.lines ?? 200);
	const result = await execCmux(pi, args, { signal: options.signal, timeout });
	const screenText = result.stdout.trim();
	const sessionTail = record?.sessionPath ? parseSessionTail(record.sessionPath) : null;
	const selected = selectBestCaptureText(screenText, sessionTail?.lastAssistantText || null);
	return {
		alias,
		workspace,
		surface,
		text: selected.text || "",
		screenText,
		captureSource: selected.source,
		sessionPath: record?.sessionPath || null,
		sessionTail: sessionTail?.lastAssistantText || null,
	};
}

function teamRegistryFile() {
	return storage.teamRegistryFile();
}

function readTeamRegistry() {
	return storage.readTeamRegistry();
}

function writeTeamRegistry(registry: any) {
	return storage.writeTeamRegistry(registry);
}

function upsertTeamRecord(record: any) {
	return storage.upsertTeamRecord(record);
}

function removeTeamRecord(team: string) {
	return storage.removeTeamRecord(team);
}

function resolveTeamRecord(team: string) {
	return storage.resolveTeamRecord(team);
}

function summarizeSessionTail(record: any) {
	const tail = parseSessionTail(record?.sessionPath);
	if (!tail?.lastAssistantText) return null;
	return summarize(tail.lastAssistantText, 240);
}

function assistantTextSuggestsReadiness(text?: string | null) {
	const normalized = String(text || "");
	return /(ROLE READY:|STATUS:\s*(?:READY|ACTIVE|WORKING)|READY FOR ESCALATION)/i.test(normalized);
}

function bridgeSuggestsReadiness(status: any) {
	const eventType = String(status?.lastEventType || "").toLowerCase();
	const summary = String(status?.lastSummary || "");
	return ["agent_start", "turn_start", "turn_end", "tool_call", "tool_result"].includes(eventType) || assistantTextSuggestsReadiness(summary);
}

function bridgeStatusForAgentReadiness(record: any, statuses: any[] = []) {
	return (statuses || []).find((status: any) => {
		const identity = status?.identity || {};
		const cmux = status?.cmux || {};
		const aliasMatches = record?.alias && (identity.agent_alias === record.alias || cmux.agentAlias === record.alias);
		const surfaceMatches = record?.surface && (identity.surface_id === record.surface || cmux.surfaceId === record.surface);
		if (!aliasMatches && !surfaceMatches) return false;
		if (status?.bridgeAge?.stale) return false;
		if (record?.runId && (identity.run_id || cmux.runId) && identity.run_id !== record.runId && cmux.runId !== record.runId) return false;
		if (record?.team && (identity.team_id || cmux.teamId) && identity.team_id !== record.team && cmux.teamId !== record.team) return false;
		return true;
	}) || null;
}

async function waitForTeamAgentsReady(
	teamRecords: any[],
	options: { timeoutMs?: number; pollMs?: number } = {},
) {
	const timeoutMs = options.timeoutMs ?? 12_000;
	const pollMs = options.pollMs ?? 500;
	const members = (teamRecords || []).flatMap((teamRecord: any) => teamRecord.members || []);
	const total = members.length;
	const startedAt = Date.now();
	if (!total) return { readyAliases: [], total, completed: true, waitedMs: 0 };
	while (Date.now() - startedAt <= timeoutMs) {
		const bridgeStatuses = listBridgeStatuses(true);
		const readyAliases = members
			.filter((member: any) => {
				try {
					const record = resolveAgentRecord(member.alias);
					const tail = parseSessionTail(record?.sessionPath);
					const bridge = bridgeStatusForAgentReadiness(record, bridgeStatuses);
					return bridgeSuggestsReadiness(bridge) || assistantTextSuggestsReadiness(tail?.lastAssistantText || record?.lastSummary || null);
				} catch {
					return false;
				}
			})
			.map((member: any) => member.alias);
		if (readyAliases.length === total) {
			return { readyAliases, total, completed: true, waitedMs: Date.now() - startedAt };
		}
		await sleep(pollMs);
	}
	const bridgeStatuses = listBridgeStatuses(true);
	const readyAliases = members
		.filter((member: any) => {
			try {
				const record = resolveAgentRecord(member.alias);
				const tail = parseSessionTail(record?.sessionPath);
				const bridge = bridgeStatusForAgentReadiness(record, bridgeStatuses);
				return bridgeSuggestsReadiness(bridge) || assistantTextSuggestsReadiness(tail?.lastAssistantText || record?.lastSummary || null);
			} catch {
				return false;
			}
		})
		.map((member: any) => member.alias);
	return { readyAliases, total, completed: readyAliases.length === total, waitedMs: Date.now() - startedAt };
}

function updateAgentStatus(alias: string, patch: any) {
	const current = resolveAgentRecord(alias);
	return upsertAgentRecord({
		...current,
		...patch,
	});
}

async function pruneOfflineAgents(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const registry = readAgentRegistry();
	const removed: any[] = [];
	for (const [alias, record] of Object.entries(registry.agents || {})) {
		const liveSurface = (record as any)?.surface ? live.get((record as any).surface) : null;
		if (!liveSurface) {
			removed.push({ alias, record });
			delete registry.agents[alias];
		}
	}
	writeAgentRegistry(registry);
	return { removed, liveCount: live.size };
}

async function healAgentRecord(
	pi: ExtensionAPI,
	record: any,
	ctx: any,
	signal?: AbortSignal,
	options: { timeout?: number } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const liveSurface = record?.surface ? live.get(record.surface) : null;
	if (liveSurface) {
		const updated = upsertAgentRecord({ ...record, live: true, status: record.status || "ready", lastHeartbeatAt: nowIso() });
		return { healed: false, recreated: false, record: updated };
	}
	let teamRecord = null as any;
	if (record.team) {
		try {
			teamRecord = resolveTeamRecord(record.team);
		} catch {
			teamRecord = null;
		}
	}
	const mission = teamRecord?.goal || record.promptSummary || `Resume your prior role as ${record.role || record.alias}.`;
	const prompt = teamRecord
		? buildTeamBootstrapPrompt(teamRecord.team, record.role || record.alias, mission, { roster: buildTeamRoster(teamRecord) })
		: [`You are the cmux Pi agent ${record.alias}.`, `Resume work in role: ${record.role || record.alias}.`, mission, "Respond concisely with STATUS, OUTPUT, RISKS, NEXT, CONFIDENCE, COMMANDS RUN, URLS, and DELIVERABLE when relevant."].join("\n\n");
	const launchParams: any = {
		alias: record.alias,
		role: record.role,
		team: record.team,
		runId: record.runId,
		cwd: record.cwd || ctx?.cwd,
		provider: record.provider,
		model: record.model,
		thinking: record.thinking,
		tools: record.tools,
		sessionPath: record.sessionPath || defaultSessionPath(record.alias, record.runId),
		workspaceTitle: record.workspaceTitle || null,
		workspaceDescription: record.workspaceDescription || null,
		surfaceTitle: record.surfaceTitle || null,
		prompt,
		timeoutMs: timeout,
	};
	const liveWorkspaceRefs = new Set(Array.from(live.values()).map((item: any) => item.workspaceRef).filter(Boolean));
	if (teamRecord?.layout === "shared_workspace" && teamRecord.workspace && liveWorkspaceRefs.has(teamRecord.workspace)) {
		launchParams.target = "split";
		launchParams.workspace = teamRecord.workspace;
	} else if (record.workspace && liveWorkspaceRefs.has(record.workspace)) {
		launchParams.target = "split";
		launchParams.workspace = record.workspace;
	} else {
		launchParams.target = "new_workspace";
		launchParams.workspaceTitle = record.workspaceTitle || defaultAgentWorkspaceTitle({ alias: record.alias, team: record.team, role: record.role });
		launchParams.workspaceDescription = record.workspaceDescription || defaultAgentWorkspaceDescription({
			goal: mission,
			runId: record.runId,
			team: record.team,
			role: record.role,
			layout: teamRecord?.layout || null,
		});
	}
	const launched = await launchPiAgent(pi, launchParams, ctx, signal);
	if (teamRecord) {
		const members = (teamRecord.members || []).filter((member: any) => member.alias !== record.alias);
		members.push({
			alias: launched.record.alias,
			role: record.role,
			provider: launched.record.provider || record.provider || null,
			model: launched.record.model || record.model || null,
			workspace: launched.workspaceRef,
			workspaceTitle: launched.record.workspaceTitle || record.workspaceTitle || null,
			surface: launched.surfaceRef,
			surfaceTitle: launched.record.surfaceTitle || record.surfaceTitle || null,
			pane: launched.surface?.pane_ref || launched.record.pane || null,
			cwd: launched.record.cwd || record.cwd || null,
			sessionPath: launched.record.sessionPath || record.sessionPath || null,
			promptSummary: launched.record.promptSummary || record.promptSummary || null,
		});
		upsertTeamRecord({ ...teamRecord, members, memberCount: members.length, status: "active", lastHeartbeatAt: nowIso() });
	}
	appendRunEvent(record.runId, { type: "agent_healed", team: record.team || null, alias: record.alias, status: "ready" });
	safePostFinding(pi, ctx, {
		kind: "observation",
		title: `Agent ${record.alias} healed`,
		body: `Recreated ${record.alias} (${record.role || "agent"}) in workspace ${launched.workspaceRef}.`,
		tags: ["heal", "orchestrator"],
		runId: record.runId,
		teamId: record.team,
		agentAlias: record.alias,
	});
	return { healed: true, recreated: true, record: launched.record };
}

async function pruneOfflineTeams(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT, scope: { runId?: string; teamNames?: string[] } = {}) {
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const registry = readTeamRegistry();
	const removed: any[] = [];
	const reconciled: any[] = [];
	let scopedTeams = new Set(uniqueStrings(scope.teamNames || []));
	if (scope.runId) {
		try {
			for (const teamName of resolveRunRecord(scope.runId).teamNames || []) scopedTeams.add(teamName);
		} catch {
			// ignore missing run
		}
	}
	for (const [teamName, record] of Object.entries(registry.teams || {})) {
		if (scopedTeams.size && !scopedTeams.has(teamName)) continue;
		const teamRecord = record as any;
		const liveMembers = (teamRecord.members || []).filter((member: any) => member?.surface && live.get(member.surface));
		if (!liveMembers.length) {
			removed.push({ team: teamName, record: teamRecord });
			delete registry.teams[teamName];
			continue;
		}
		if (liveMembers.length !== (teamRecord.members || []).length) {
			registry.teams[teamName] = {
				...teamRecord,
				members: liveMembers,
				memberCount: liveMembers.length,
				updatedAt: nowIso(),
			};
			reconciled.push({ team: teamName, memberCount: liveMembers.length });
		}
	}
	writeTeamRegistry(registry);
	return { removed, reconciled, liveCount: live.size, scope: scopedTeams.size ? { teamNames: [...scopedTeams], runId: scope.runId || null } : null };
}

function positiveInteger(value: any) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function normalizeRoleName(role: string) {
	const normalized = String(role || "agent")
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-")
		.replace(/-\d+$/, "");
	if (["design", "designer", "ui", "ux", "ui-designer", "ux-designer", "visual", "visual-designer", "frontend-design"].includes(normalized)) return "designer";
	if (["front-end", "frontend", "frontender", "react", "next", "nextjs", "tailwind", "css"].includes(normalized)) return "frontend";
	if (["dev", "developer", "engineer", "implementation", "implementer"].includes(normalized)) return "coder";
	if (["qa", "quality", "quality-assurance"].includes(normalized)) return "tester";
	if (["research", "online-research", "web-research", "researcher-online"].includes(normalized)) return "researcher";
	if (["architect", "architecture"].includes(normalized)) return "architect";
	if (["intelligence", "intel", "reasoner", "strategist", "strategy"].includes(normalized)) return "analyst";
	if (["browser", "web", "driver", "operator"].includes(normalized)) return "navigator";
	return normalized;
}

function defaultAgentWorkspaceTitle(params: { alias: string; team?: string | null; role?: string | null; lead?: boolean }) {
	if (params.team) return buildSeparateAgentWorkspaceTitle(params.team, params.role || params.alias, params.alias, { lead: params.lead });
	return buildStandaloneAgentWorkspaceTitle(params.alias);
}

function defaultAgentWorkspaceDescription(params: {
	goal?: string | null;
	runId?: string | null;
	team?: string | null;
	role?: string | null;
	layout?: string | null;
}) {
	const base = buildTeamWorkspaceDescription({
		goal: params.goal,
		runId: params.runId,
		memberCount: 1,
		layout: params.layout || (params.team ? "separate_workspaces" : "standalone"),
	});
	return [params.team ? `team ${params.team}` : "standalone Pi agent", params.role ? `role: ${params.role}` : "", base].filter(Boolean).join(" • ");
}

function defaultAgentSurfaceTitle(params: { alias: string; role?: string | null; lead?: boolean }) {
	return buildAgentDisplayLabel(params.role || params.alias, params.alias, { lead: params.lead });
}

function defaultTeamWorkspaceTitle(team: string) {
	return buildTeamWorkspaceTitle(team);
}

function defaultTeamWorkspaceDescription(team: string, params: { goal?: string | null; runId?: string | null; memberCount?: number | null; layout?: string | null }) {
	const details = buildTeamWorkspaceDescription({
		goal: params.goal,
		runId: params.runId,
		memberCount: params.memberCount,
		layout: params.layout,
	});
	return [team ? `team ${team}` : "", details].filter(Boolean).join(" • ");
}

function inferTeamAgentCount(params: any) {
	if (Array.isArray(params.specs) && params.specs.length) return params.specs.length;
	const explicit = positiveInteger(params.agentCount);
	if (explicit) return explicit;
	if (Array.isArray(params.roles) && params.roles.length) return params.roles.length;

	const profile = taskTopologyProfile(`${params.task || ""}\n${params.goal || ""}`);
	let score = profile.minAgents;
	const text = `${params.task || ""}\n${params.goal || ""}`.toLowerCase();
	if (text.length > 180) score += 1;
	if (text.length > 420) score += 1;
	if (/(multi|complex|large|broad|swarm|parallel|across files|architecture)/.test(text)) score += 1;
	if (profile.needsCoordinator) score += 1;
	if (profile.needsManager) score += 1;
	return clamp(score, profile.minAgents, MAX_AUTO_AGENT_COUNT);
}

function isBrowserOrWebTask(text: string) {
	const normalized = String(text || "").toLowerCase();
	return /(browser|web|website|page|tab|dom|selector|login|sign in|auth|form|checkout|scrap|extract from page|extract page|navigate|click|fill|ui|surface|url)/.test(normalized);
}

function taskTopologyProfile(text: string) {
	const normalized = String(text || "").toLowerCase();
	const browser = isBrowserOrWebTask(normalized);
	const incident = /(incident|outage|hotfix|sev|failure|error|bug|debug|broken|regression)/.test(normalized);
	const research = /(research|investigate|compare|unknown|explore|options|survey)/.test(normalized);
	const implementation = /(implement|build|edit|code|refactor|feature|patch|migrate)/.test(normalized);
	const review = /(review|audit|validate|verify|test|qa|correctness|safety)/.test(normalized);
	const docs = /(docs|writeup|readme|notes|summary|documentation)/.test(normalized);
	const data = /(metric|analysis|data|benchmark|measure|dataset)/.test(normalized);
	if (browser) {
		return {
			kind: "browser",
			minAgents: 4,
			needsLead: true,
			needsCoordinator: true,
			needsManager: /multi-team|several teams|many teams/.test(normalized),
			baseRoles: /(ui|ux|design|frontend|react|tailwind|css)/.test(normalized)
				? ["lead", "designer", "navigator", "verifier", "extractor", "observer"]
				: ["lead", "navigator", "verifier", "extractor", "observer"],
		};
	}
	if (incident) {
		return {
			kind: "incident",
			minAgents: 4,
			needsLead: true,
			needsCoordinator: true,
			needsManager: true,
			baseRoles: ["manager", "lead", "debugger", "reviewer", "tester"],
		};
	}
	if (research && !implementation) {
		return {
			kind: "research",
			minAgents: 3,
			needsLead: true,
			needsCoordinator: false,
			needsManager: false,
			baseRoles: ["lead", "researcher", "analyst", "reviewer"],
		};
	}
	if (implementation && review) {
		return {
			kind: "implementation-review",
			minAgents: 4,
			needsLead: true,
			needsCoordinator: true,
			needsManager: false,
			baseRoles: ["lead", "coder", "reviewer", "tester", "integrator"],
		};
	}
	if (docs && !implementation) {
		return {
			kind: "docs",
			minAgents: 3,
			needsLead: true,
			needsCoordinator: false,
			needsManager: false,
			baseRoles: ["lead", "docs", "reviewer"],
		};
	}
	if (data) {
		return {
			kind: "analysis",
			minAgents: 3,
			needsLead: true,
			needsCoordinator: false,
			needsManager: false,
			baseRoles: ["lead", "analyst", "researcher", "reviewer"],
		};
	}
	return {
		kind: "general",
		minAgents: 3,
		needsLead: true,
		needsCoordinator: implementation || review,
		needsManager: false,
		baseRoles: ["lead", "coder", "reviewer", "planner"],
	};
}

function recommendedExtraRoles(text: string) {
	const normalized = String(text || "").toLowerCase();
	const extras: string[] = [];
	if (isBrowserOrWebTask(normalized)) extras.push("navigator", "observer", "verifier", "extractor");
	if (/(ui|ux|design|designer|frontend|front-end|react|tailwind|css|visual)/.test(normalized)) extras.push("designer", "frontend");
	if (/(research|investigate|compare|unknown|explore)/.test(normalized)) extras.push("researcher");
	if (/(test|qa|validate|verify|regression)/.test(normalized)) extras.push("tester");
	if (/(debug|incident|bug|failure|error|fix)/.test(normalized)) extras.push("debugger");
	if (/(integrat|merge|coordina|handoff|combine)/.test(normalized)) extras.push("integrator");
	if (/(doc|readme|writeup|notes|summary)/.test(normalized)) extras.push("docs");
	if (/(metric|analysis|data|measure|benchmark)/.test(normalized)) extras.push("analyst");
	return uniqueStrings([...extras, "researcher", "tester", "debugger", "integrator", "docs", "analyst"]);
}

function buildRolePlan(params: any) {
	const count = inferTeamAgentCount(params);
	const explicitRoles = uniqueStrings(Array.isArray(params.roles) ? params.roles : []);
	const explicitCount = positiveInteger(params.agentCount);
	const multiTeam = (positiveInteger(params.teamCount) || 1) > 1 || uniqueStrings(Array.isArray(params.teamNames) ? params.teamNames : []).length > 1;
	const profile = taskTopologyProfile(`${params.task || ""}\n${params.goal || ""}`);
	const wantsManager = params.includeManager === true || (params.includeManager !== false && (multiTeam || profile.needsManager || count >= 5));
	const wantsCoordinator = params.includeCoordinator === true || (params.includeCoordinator !== false && (multiTeam || profile.needsCoordinator || count >= 4));
	const wantsLead = params.includeLead === true || (params.includeLead !== false && !wantsManager && (profile.needsLead || count >= 3));
	const allowedLeadership = new Set<string>([
		...(wantsManager ? ["manager"] : []),
		...(wantsCoordinator ? ["coordinator"] : []),
		...(wantsLead ? ["lead"] : []),
	]);
	const filterLeadership = (roles: string[]) => roles.filter((role) => {
		const normalized = normalizeRoleName(role);
		if (!["manager", "coordinator", "lead"].includes(normalized)) return true;
		if (allowedLeadership.has(normalized)) return true;
		return false;
	});
	if (explicitRoles.length) {
		const roles = uniqueStrings([
			...filterLeadership(explicitRoles),
			...Array.from(allowedLeadership),
		]);
		while (roles.length < count) roles.push(`agent-${roles.length + 1}`);
		return roles.slice(0, count);
	}

	const taskText = `${params.task || ""}\n${params.goal || ""}`;
	const extras = filterLeadership(recommendedExtraRoles(taskText));
	let baseRoles = filterLeadership(profile.baseRoles || ["coder", "reviewer", "planner"]);
	if (explicitCount && explicitCount <= 2 && params.includeLead !== true && params.includeCoordinator !== true && params.includeManager !== true) {
		baseRoles = baseRoles.filter((role) => !["lead", "manager", "coordinator"].includes(normalizeRoleName(role)));
	}
	const roles = uniqueStrings([
		...Array.from(allowedLeadership),
		...baseRoles,
		...extras,
	]);
	while (roles.length < count) roles.push(`agent-${roles.length + 1}`);
	return roles.slice(0, count);
}

function buildMemberAlias(team: string, role: string, priorRoles: string[] = []) {
	const seen = priorRoles.filter((entry) => entry === role).length;
	return `${team}-${role}${seen ? `-${seen + 1}` : ""}`;
}

function roleInstruction(role: string) {
	const normalized = normalizeRoleName(role);
	if (normalized === "manager") {
		return [
			"You are the manager.",
			"Own team execution, monitor progress, triage blockers, and decide where more effort or coordination is needed.",
			"Do not micromanage every detail; instead keep the team aligned, unblock stuck agents, and produce concise executive summaries.",
			"Do not personally take over the core implementation or research scope unless the orchestrator explicitly reassigns you to do that.",
		].join(" ");
	}
	if (normalized === "coordinator") {
		return [
			"You are the coordinator.",
			"Track what each agent is doing, relay dependencies, note conflicts, and make sure findings move quickly across the swarm.",
			"Focus on communication, sequencing, handoffs, and immediate next actions when agents become blocked.",
			"Do not personally take over the core implementation or research scope unless the orchestrator explicitly reassigns you to do that.",
		].join(" ");
	}
	if (normalized === "lead") {
		return [
			"You are the team lead.",
			"Own the highest-signal execution slice while also maintaining awareness of team progress, blockers, and handoffs.",
			"You are the key reporting agent for this team and should be ready to answer orchestrator heartbeat requests with concise, accurate consolidated updates.",
		].join(" ");
	}
	if (normalized === "planner") {
		return [
			"You are the planner.",
			"Break the task into steps, identify risks, propose coordination, and avoid making code changes yourself unless explicitly asked.",
			"Prefer clear step lists, acceptance criteria, delegation advice, and notices about when the swarm should split or converge.",
		].join(" ");
	}
	if (normalized === "architect") {
		return [
			"You are the architect.",
			"Focus on system design, interfaces, dependencies, long-term maintainability, and whether the proposed execution plan fits the actual codebase and constraints.",
			"Prefer concise architectural tradeoffs, file/module boundaries, and acceptance criteria over broad generic advice.",
		].join(" ");
	}
	if (normalized === "coder") {
		return [
			"You are the coder.",
			"Focus on implementation details, concrete edits, commands, and exact technical execution.",
			"Assume other agents will inspect your work, so explain changes concisely and mention touched files or areas.",
		].join(" ");
	}
	if (normalized === "reviewer") {
		return [
			"You are the reviewer.",
			"Focus on validation, edge cases, correctness, safety, and missing tests or risks.",
			"Prefer critique, verification steps, and change-risk analysis over implementation.",
		].join(" ");
	}
	if (normalized === "researcher") {
		return [
			"You are the researcher.",
			"Gather facts, compare options, identify unknowns, and summarize findings clearly.",
		].join(" ");
	}
	if (normalized === "designer" || normalized === "design" || normalized === "frontend") {
		return [
			"You are the design/frontend specialist.",
			"Focus on product taste, UI architecture, layout, typography, interaction details, accessibility, responsive behavior, and implementation-ready design guidance.",
			"When code is involved, be concrete about files, components, tokens, CSS/Tailwind choices, and visual QA risks.",
		].join(" ");
	}
	if (normalized === "navigator") {
		return [
			"You are the browser navigator.",
			"Drive the cmux browser using semantic actions, move the workflow forward, avoid brittle selector guessing when higher-level browser intelligence tools can resolve the target, and do not switch to the standalone browser tool for cmux browser-surface work.",
		].join(" ");
	}
	if (normalized === "observer") {
		return [
			"You are the browser observer.",
			"Use structured page observations to understand current UI state, blockers, forms, modals, and likely next actions before others mutate the page.",
		].join(" ");
	}
	if (normalized === "verifier") {
		return [
			"You are the verifier.",
			"Focus on postconditions, assertions, safety, and whether each browser step actually succeeded.",
		].join(" ");
	}
	if (normalized === "extractor") {
		return [
			"You are the extractor.",
			"Turn browser state into structured data, concise findings, and reusable outputs for the rest of the team.",
		].join(" ");
	}
	if (normalized === "tester" || normalized === "qa") {
		return [
			"You are the tester.",
			"Focus on verification plans, regressions, reproducibility, and what still needs to be checked.",
		].join(" ");
	}
	if (normalized === "debugger") {
		return [
			"You are the debugger.",
			"Focus on root cause, failure modes, diagnostics, and the smallest confident fix path.",
		].join(" ");
	}
	if (normalized === "integrator") {
		return [
			"You are the integrator.",
			"Focus on dependencies between agents, combined changes, sequencing, and whether separate workstreams fit together cleanly.",
		].join(" ");
	}
	if (normalized === "docs") {
		return [
			"You are the docs specialist.",
			"Focus on user-visible behavior, notes, summaries, migration details, and crisp documentation updates.",
		].join(" ");
	}
	if (normalized === "analyst") {
		return [
			"You are the analyst.",
			"Focus on evidence, measurements, tradeoffs, and concise comparisons that help the rest of the swarm decide well.",
		].join(" ");
	}
	return `You are the ${normalized} agent. Stay in this role and provide concise, useful terminal responses.`;
}

function buildTeamRoster(teamRecord: any, memberLimit = 16) {
	return (teamRecord?.members || [])
		.slice(0, memberLimit)
		.map((member: any, index: number) => `- ${member.alias} (${member.role || "agent"})${index === 0 ? " [lead]" : ""}`)
		.join("\n");
}

function leadershipPriority(role: string) {
	const normalized = normalizeRoleName(role);
	if (normalized === "manager") return 1;
	if (normalized === "coordinator") return 2;
	if (normalized === "lead") return 3;
	if (normalized === "planner") return 4;
	if (normalized === "integrator") return 5;
	if (normalized === "reviewer") return 6;
	return 99;
}

function teamLeadMembers(teamRecord: any, limit = 2) {
	return [...(teamRecord?.members || [])]
		.sort((a: any, b: any) => leadershipPriority(a.role) - leadershipPriority(b.role))
		.slice(0, limit);
}

function primaryTeamLead(teamRecord: any) {
	return teamLeadMembers(teamRecord, 1)[0] || (teamRecord?.members || [])[0] || null;
}

function primarySwarmLead(teamRecords: any[]) {
	const leads = (teamRecords || [])
		.map((teamRecord: any) => primaryTeamLead(teamRecord))
		.filter(Boolean)
		.sort((a: any, b: any) => leadershipPriority(a.role) - leadershipPriority(b.role));
	return leads[0] || null;
}

function isLeadershipRole(role: string) {
	return leadershipPriority(role) < 99;
}

function browserTaskGuidanceText(text?: string) {
	if (!isBrowserOrWebTask(text || "")) return "";
	return [
		"Browser-work guidance:",
		"- Prefer cmux_browser_run_task when one higher-level tool can safely handle the browser objective end-to-end.",
		"- Prefer cmux_browser_observe to understand the page semantically before major actions.",
		"- Prefer cmux_browser_act over raw cmux_browser primitives when you can express the intent semantically.",
		"- Prefer cmux_browser_assert after important steps instead of assuming success.",
		"- Prefer cmux_browser_extract for structured links, forms, tables, cards, and explicit field extraction.",
		"- Prefer cmux_browser_recover when a browser step fails, the UI is blocked, or the page needs stabilization before continuing.",
		"- Use cmux_browser_lock when multiple agents share one browser surface so only one agent drives it at a time.",
		"- Use cmux_browser_memory to recall site-specific workflow knowledge and save reusable notes after success or handoff.",
		"- Use cmux_browser_session checkpoints before risky transitions, auth boundaries, destructive actions, or agent handoffs.",
		"- Do not use the standalone built-in browser tool for cmux browser-surface work unless the user explicitly asks for it and the work is not supposed to stay in cmux.",
		"- Use semantic targets and verification loops; avoid brittle selector guessing unless exact selectors are clearly best.",
	].join("\n");
}

function buildTeamBootstrapPrompt(team: string, role: string, mission?: string, options: { roster?: string } = {}) {
	return [
		`You are part of the cmux Pi team \"${team}\".`,
		roleInstruction(role),
		mission ? `Current overall mission: ${mission}` : "Wait for specific task assignments from the orchestrator.",
		options.roster ? `Current team roster:\n${options.roster}` : "",
		browserTaskGuidanceText(mission),
		isLeadershipRole(role)
			? "You are also a key reporting agent for this team. Keep enough awareness of team status to answer orchestrator heartbeat requests with concise consolidated progress, blockers, changed areas, deliverables, and remaining work."
			: "",
		"Coordinate through the orchestrator. Surface blockers, dependencies, touched files or areas, and any finding another agent should know immediately.",
		"If you are blocked, say so explicitly using BLOCKED or BLOCKER in STATUS and explain exactly what you need.",
		"When you respond, use concise sections such as STATUS, OUTPUT, RISKS, NEXT, NEEDS FROM PEERS, FILES/AREAS CHANGED, CONFIDENCE, COMMANDS RUN, URLS, and DELIVERABLE when relevant.",
		`Acknowledge readiness with: ROLE READY: ${role}`,
	].filter(Boolean).join("\n\n");
}

function buildTeamTaskPrompt(
	team: string,
	role: string,
	task: string,
	extraGuidance?: string,
	options: { roster?: string; round?: number; swarmSummary?: string; teamMemory?: string } = {},
) {
	const normalizedRole = normalizeRoleName(role);
	const coordinationOnly = normalizedRole === "manager" || normalizedRole === "coordinator";
	return [
		`Team: ${team}`,
		`Role: ${role}`,
		options.round ? `Coordination round: ${options.round}` : "",
		`Task: ${task}`,
		extraGuidance ? `Coordinator guidance: ${extraGuidance}` : "",
		options.swarmSummary ? `Shared swarm context:\n${options.swarmSummary}` : "",
		options.teamMemory ? `Latest team handoff memory:\n${options.teamMemory}` : "",
		options.roster && !options.round ? `Team roster:\n${options.roster}` : "",
		isBrowserOrWebTask(`${task}\n${extraGuidance || ""}`)
			? "Browser guidance: use the cmux browser stack, verify important actions, and use locks/checkpoints before risky transitions or handoffs."
			: "",
		coordinationOnly
			? "Coordination posture: do not claim primary implementation or research scope for yourself. Delegate, synchronize, unblock, verify, and summarize unless the orchestrator explicitly reassigns you."
			: "",
		isLeadershipRole(role)
			? "Lead posture: be ready to answer direct orchestrator heartbeat requests on behalf of this team with a concise consolidated status, blockers, changed files/areas, deliverables, remaining work, immediate next actions, and requests to swarm."
			: "",
		"Coordinate through the orchestrator. Share blockers, dependencies, changed files/areas, and any finding peers should know immediately.",
		"If blocked, write STATUS: BLOCKED and name the exact dependency or error.",
		isLeadershipRole(role)
			? "For leadership check-ins, prefer TEAM STATUS, KEY CHANGES, BLOCKERS, DELIVERABLES, REMAINING WORK, REQUESTS TO SWARM, and NEXT TEAM ACTION."
			: "",
		"Reply tersely with STATUS, OUTPUT, RISKS, NEXT, NEEDS FROM PEERS, FILES/AREAS CHANGED, CONFIDENCE, COMMANDS RUN, URLS, and DELIVERABLE when relevant.",
	].filter(Boolean).join("\n\n");
}

function dependencyRequestTargetScore(member: any, dependency: any, teamRecord: any) {
	const hint = String(dependency?.targetHint || "").toLowerCase();
	const text = String(dependency?.text || "").toLowerCase();
	const alias = String(member?.alias || "").toLowerCase();
	const role = String(member?.role || member?.alias || "").toLowerCase();
	const team = String(teamRecord?.team || "").toLowerCase();
	let score = 0;
	if (hint && hint === alias) score += 5;
	if (hint && alias.includes(hint)) score += 4;
	if (hint && role.includes(hint)) score += 3;
	if (text.includes(alias)) score += 3;
	if (text.includes(role)) score += 2;
	if (hint && hint === team) score += 2;
	if (dependency?.requiresAck) score += 1;
	return score;
}

function formatRelevantDependencyRequests(teamRecord: any, member: any, digests: any[], limit = 4) {
	const matches = (digests || [])
		.flatMap((digest: any) => ((digest?.dependencies || []) as any[]).map((dependency: any) => ({ digest, dependency, score: dependencyRequestTargetScore(member, dependency, teamRecord) })))
		.filter((item: any) => item.score > 0 && String(item.dependency?.status || "open") !== "resolved")
		.sort((a: any, b: any) => b.score - a.score || String(a.digest.alias || "").localeCompare(String(b.digest.alias || "")));
	if (!matches.length) return "";
	return uniqueStrings(matches.slice(0, limit).map((item: any) => `${item.digest.alias} [${item.dependency.kind || "dependency"}] ${item.dependency.targetHint || member.alias}: ${item.dependency.text || item.digest.summary || "dependency request"}`))
		.map((item: string) => `- ${item}`)
		.join("\n");
}

function buildRelayRoundPrompt(
	teamRecord: any,
	member: any,
	task: string,
	options: { round?: number; extraGuidance?: string; swarmSummary?: string; teamMemory?: string; directRequests?: string } = {},
) {
	const memberIsLead = isLeadershipRole(member.role || member.alias);
	return [
		`Team: ${teamRecord.team}`,
		`Role: ${member.role || member.alias}`,
		options.round ? `Coordination round: ${options.round}` : "",
		`Continue task: ${task}`,
		options.extraGuidance ? `Coordinator guidance: ${options.extraGuidance}` : "",
		options.teamMemory ? `Team memory:\n${options.teamMemory}` : "",
		options.directRequests ? `Direct requests relevant to you:\n${options.directRequests}` : "",
		options.swarmSummary ? `Round update inbox:\n${options.swarmSummary}` : "",
		memberIsLead
			? "Lead response contract: reply with TEAM STATUS, KEY CHANGES, BLOCKERS, DELIVERABLES, REMAINING WORK, REQUESTS TO SWARM, and NEXT TEAM ACTION."
			: "Contributor response contract: reply with STATUS, OUTPUT, RISKS, NEXT, NEEDS FROM PEERS, FILES/AREAS CHANGED, COMMANDS RUN, URLS, CONFIDENCE, and DELIVERABLE when relevant.",
		memberIsLead
			? "Lead posture: synthesize, delegate, and only escalate the most important dependencies or unblock requests."
			: "Contributor posture: focus on execution, surface exact blockers fast, and avoid re-summarizing the whole swarm unless it affects your work.",
	].filter(Boolean).join("\n\n");
}

function defaultTeamMemberSpecs(team: string, params: any) {
	const roles = buildRolePlan(params);
	const specs = roles.map((role: string, index: number) => ({
		alias: buildMemberAlias(team, role, roles.slice(0, index)),
		role,
	}));
	const roster = specs
		.map((spec: any, index: number) => `- ${spec.alias} (${spec.role || "agent"})${index === 0 ? " [lead]" : ""}`)
		.join("\n");
	return specs.map((spec: any) => ({
		...spec,
		prompt: buildTeamBootstrapPrompt(team, spec.role, params.goal || params.task, { roster }),
	}));
}

function resolveRequestedTeamNames(params: any) {
	const explicit = uniqueStrings(Array.isArray(params.teamNames) ? params.teamNames : []);
	if (explicit.length) return explicit;
	const teamCount = positiveInteger(params.teamCount) || 1;
	if (!params.team) return [];
	if (teamCount <= 1) return [params.team];
	return Array.from({ length: teamCount }, (_, index) => (index === 0 ? params.team : `${params.team}-${index + 1}`));
}

function materializeTeamParams(params: any, teamName: string, multiTeam = false) {
	const next = { ...params, team: teamName };
	if (multiTeam && !params.layout) next.layout = "shared_workspace";
	if (!params.workspaceTitle) next.workspaceTitle = defaultTeamWorkspaceTitle(teamName);
	if (multiTeam && Array.isArray(params.specs) && params.specs.length) {
		next.specs = params.specs.map((spec: any) => ({
			...spec,
			alias: String(spec.alias || "agent").startsWith(`${teamName}-`) ? spec.alias : `${teamName}-${spec.alias || "agent"}`,
		}));
	}
	return next;
}

function liveMembersForTeam(teamRecord: any, live?: Map<string, any>) {
	if (!live) return teamRecord?.members || [];
	return (teamRecord?.members || []).filter((member: any) => member?.surface && live.get(member.surface));
}

function teamPiEvidenceSummary(teamRecord: any) {
	const bridgeStatuses = listBridgeStatuses(true);
	const members = teamRecord?.members || [];
	const readyAliases = members.filter((member: any) => {
		try {
			const record = resolveAgentRecord(member.alias);
			const tail = parseSessionTail(record?.sessionPath);
			const bridge = bridgeStatusForAgentReadiness(record, bridgeStatuses);
			return bridgeSuggestsReadiness(bridge) || assistantTextSuggestsReadiness(tail?.lastAssistantText || record?.lastSummary || null);
		} catch {
			return false;
		}
	}).map((member: any) => member.alias);
	return { readyAliases, readyCount: readyAliases.length, total: members.length };
}

function reconcileTeamRecordWithLive(teamRecord: any, live?: Map<string, any>) {
	if (!teamRecord || !live) return teamRecord;
	const members = teamRecord.members || [];
	const liveMembers = liveMembersForTeam(teamRecord, live);
	if (liveMembers.length === members.length) return teamRecord;
	if (!liveMembers.length) return null;
	return upsertTeamRecord({
		...teamRecord,
		members: liveMembers,
		memberCount: liveMembers.length,
	});
}

function inferOrchestrationMode(params: any) {
	const text = `${params.task || ""}\n${params.goal || ""}`.toLowerCase();
	if (/deep|exhaustive/.test(text)) return "deep-review";
	if (/review|audit/.test(text)) return "review";
	if (/bug|incident|fix|debug/.test(text)) return "bug-hunt";
	if (/implement|build|edit|refactor/.test(text)) return "implementation";
	if (/research|explore|investigate/.test(text)) return "research";
	return "custom";
}

function prepareOutcomeExecution(params: any, ctx: any) {
	const hasOutcomeText = Boolean(params?.task || params?.goal || params?.message || params?.description);
	if (!hasOutcomeText) return { params, intent: null, contract: null, plan: null, activated: false };
	const intent = detectOutcomeIntent({ ...params, cwd: ctx?.cwd });
	const contract = deriveOutcomeExecutionContract({ ...params, cwd: ctx?.cwd });
	const plan = deriveOutcomeExecutionPlan(contract, { ...params, cwd: ctx?.cwd });
	const next = { ...params, outcomeIntent: intent, executionContract: contract, executionPlan: plan };
	const hasExplicitTeams = Boolean((Array.isArray(params.teamNames) && params.teamNames.length) || params.team);
	if (!hasExplicitTeams && intent.shouldActivate) next.team = contract.suggestedTeamBaseName;
	if (!params.teamCount && !hasExplicitTeams && intent.suggestedMode === "swarm") next.teamCount = contract.recommendedTeamCount;
	if (!params.agentCount && !Array.isArray(params.roles) && !Array.isArray(params.specs) && intent.shouldActivate) next.agentCount = contract.recommendedAgentCount;
	if (!params.goal && contract.outcome) next.goal = contract.outcome;
	return { params: next, intent, contract, plan, activated: intent.shouldActivate };
}

function persistOutcomeExecutionArtifacts(scope: "runs" | "plans", id: string, contract: any, plan: any) {
	if (!id || !contract || !plan) return null;
	return writeOutcomeExecutionArtifacts({
		baseDir: orchestratorDir(),
		scope,
		id,
		contract,
		plan,
		contractMarkdown: renderOutcomeExecutionContract(contract),
		planMarkdown: renderOutcomeExecutionPlan(plan),
	});
}

function resolveModelPresetParams(params: any, ctx: any) {
	const registry = loadModelPresetRegistry({
		cwd: ctx?.cwd,
		baseDir: orchestratorDir(),
		presetFile: params.modelPresetFile,
	});
	const explicitPresetName = String(params.modelPreset || "").trim();
	const hasExplicitModelConfig = Boolean(
		params.provider ||
			params.model ||
			(Array.isArray(params.models) && params.models.length) ||
			(Array.isArray(params.roleModelMap) && params.roleModelMap.length),
	);
	const recommendation = !explicitPresetName || explicitPresetName === "auto"
		? recommendModelPreset(params, registry)
		: null;
	const selectedPresetName = explicitPresetName && explicitPresetName !== "auto"
		? explicitPresetName
		: recommendation?.name || null;
	const preset = resolveModelPreset(selectedPresetName, registry);
	const next = hasExplicitModelConfig && !explicitPresetName
		? { ...params, appliedModelPreset: null }
		: applyModelPreset({ ...params, modelPreset: selectedPresetName || params.modelPreset }, preset);
	return {
		params: next,
		registry,
		preset,
		recommendation,
		presetName: next.appliedModelPreset || null,
		presetSource: explicitPresetName && explicitPresetName !== "auto" ? "explicit" : recommendation?.source || (preset ? "default" : "none"),
	};
}

function shouldShutdownTeamsAfterOrchestration(options: {
	shutdownOnComplete?: boolean;
	runCompleted?: boolean;
	createdTeamNames?: string[];
	teamNames?: string[];
}) {
	if (!options.runCompleted) return false;
	if (options.shutdownOnComplete === false) return false;
	if (options.shutdownOnComplete === true) return true;
	const requested = uniqueStrings(options.teamNames || []);
	const created = new Set(uniqueStrings(options.createdTeamNames || []));
	return requested.length > 0 && requested.every((teamName) => created.has(teamName));
}

function teamTemplateRegistryFile() {
	return join(orchestratorDir(), "team-templates.json");
}

function readTeamTemplateRegistry() {
	const registry = readJsonFileSafe(teamTemplateRegistryFile(), null);
	return registry && typeof registry === "object"
		? { version: 1, templates: {}, pending: {}, ...registry }
		: { version: 1, templates: {}, pending: {} };
}

function writeTeamTemplateRegistry(registry: any) {
	atomicWriteJson(teamTemplateRegistryFile(), {
		version: 1,
		templates: registry?.templates || {},
		pending: registry?.pending || {},
		updatedAt: nowIso(),
	});
}

function teamTemplateId(teamName: string, runId?: string | null) {
	return `${safeFileSegment(teamName || "team")}-${safeFileSegment(runId || "manual")}`;
}

function buildReusableTeamTemplate(teamRecord: any, runRecord?: any, status = "pending") {
	const members = (teamRecord?.members || []).map((member: any) => ({
		alias: member.alias,
		role: member.role || member.alias || "agent",
		provider: member.provider || teamRecord?.provider || null,
		model: member.model || teamRecord?.model || null,
		thinking: member.thinking || null,
		tools: member.tools || null,
		cwd: member.cwd || null,
		surfaceTitle: member.surfaceTitle || null,
		promptSummary: member.promptSummary || null,
	}));
	return {
		templateId: teamTemplateId(teamRecord?.team, teamRecord?.runId || runRecord?.runId),
		team: teamRecord?.team || null,
		runId: teamRecord?.runId || runRecord?.runId || null,
		status,
		goal: teamRecord?.goal || runRecord?.goal || runRecord?.task || null,
		layout: teamRecord?.layout || "shared_workspace",
		workspaceTitle: teamRecord?.workspaceTitle || null,
		workspaceDescription: teamRecord?.workspaceDescription || null,
		modelPreset: teamRecord?.modelPreset || runRecord?.modelPreset || null,
		provider: teamRecord?.provider || null,
		model: teamRecord?.model || null,
		modelStrategy: teamRecord?.modelStrategy || null,
		memberCount: members.length,
		members,
		specs: members.map((member: any) => ({
			alias: member.alias,
			role: member.role,
			provider: member.provider || undefined,
			model: member.model || undefined,
			thinking: member.thinking || undefined,
			tools: member.tools || undefined,
			cwd: member.cwd || undefined,
			surfaceTitle: member.surfaceTitle || undefined,
		})),
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
}

function storePendingTeamRetention(runId: string, teamRecords: any[], runRecord?: any) {
	const registry = readTeamTemplateRegistry();
	const pendingId = safeFileSegment(runId || `pending-${Date.now()}`);
	const templates = (teamRecords || []).map((teamRecord: any) => buildReusableTeamTemplate(teamRecord, runRecord, "pending"));
	registry.pending[pendingId] = {
		pendingId,
		runId,
		teamNames: uniqueStrings(templates.map((template: any) => template.team).filter(Boolean)),
		createdAt: nowIso(),
		updatedAt: nowIso(),
		question: "Save this team setup as a reusable template for future relaunch?",
		templates,
	};
	writeTeamTemplateRegistry(registry);
	return registry.pending[pendingId];
}

function promotePendingTeamRetention(params: { runId?: string | null; teamNames?: string[]; pendingId?: string | null }) {
	const registry = readTeamTemplateRegistry();
	const requestedTeams = new Set(uniqueStrings(params.teamNames || []));
	const promoted: any[] = [];
	for (const [pendingId, pending] of Object.entries(registry.pending || {})) {
		const record = pending as any;
		const runMatch = params.runId && record.runId === params.runId;
		const teamMatch = requestedTeams.size && (record.teamNames || []).some((teamName: string) => requestedTeams.has(teamName));
		const idMatch = params.pendingId && pendingId === params.pendingId;
		if (!runMatch && !teamMatch && !idMatch) continue;
		for (const template of record.templates || []) {
			const saved = { ...template, status: "saved", savedAt: nowIso(), updatedAt: nowIso() };
			registry.templates[saved.templateId] = saved;
			promoted.push(saved);
		}
		delete registry.pending[pendingId];
	}
	writeTeamTemplateRegistry(registry);
	return promoted;
}

function discardPendingTeamRetention(params: { runId?: string | null; teamNames?: string[]; pendingId?: string | null }) {
	const registry = readTeamTemplateRegistry();
	const requestedTeams = new Set(uniqueStrings(params.teamNames || []));
	const discarded: any[] = [];
	for (const [pendingId, pending] of Object.entries(registry.pending || {})) {
		const record = pending as any;
		const runMatch = params.runId && record.runId === params.runId;
		const teamMatch = requestedTeams.size && (record.teamNames || []).some((teamName: string) => requestedTeams.has(teamName));
		const idMatch = params.pendingId && pendingId === params.pendingId;
		if (!runMatch && !teamMatch && !idMatch) continue;
		discarded.push(record);
		delete registry.pending[pendingId];
	}
	writeTeamTemplateRegistry(registry);
	return discarded;
}

function resolveTeamTemplate(templateId?: string | null) {
	if (!templateId) return null;
	const registry = readTeamTemplateRegistry();
	return registry.templates?.[templateId] || null;
}

function applyTeamTemplateParams(params: any) {
	const template = resolveTeamTemplate(params?.teamTemplateId);
	if (!template) return params;
	return {
		team: params.team || template.team,
		goal: params.goal || template.goal,
		layout: params.layout || template.layout,
		workspaceTitle: params.workspaceTitle || template.workspaceTitle,
		workspaceDescription: params.workspaceDescription || template.workspaceDescription,
		modelPreset: params.modelPreset || template.modelPreset,
		provider: params.provider || template.provider,
		model: params.model || template.model,
		modelStrategy: params.modelStrategy || template.modelStrategy,
		agentCount: params.agentCount || template.memberCount,
		specs: params.specs || template.specs,
		...params,
		appliedTeamTemplateId: template.templateId,
	};
}

function resolveCompletedTeamLifecycle(params: any, options: { runCompleted?: boolean; createdTeamNames?: string[]; teamNames?: string[] }) {
	if (!options.runCompleted) return { action: "none", shouldShutdown: false, shouldAsk: false, shouldSave: false, shouldDestroy: false, reason: "run-not-complete" };
	const explicit = String(params.teamRetentionDecision || "").trim().toLowerCase();
	const saveBool = typeof params.saveTeamForFutureUse === "boolean" ? params.saveTeamForFutureUse : null;
	let action = explicit || "";
	if (!action && saveBool === true) action = "save";
	if (!action && saveBool === false) action = "destroy";
	if (!action && params.shutdownOnComplete === true) action = "destroy";
	if (!action && params.shutdownOnComplete === false) action = "keep-live";
	if (!action) action = "destroy";
	if (action === "auto") action = shouldShutdownTeamsAfterOrchestration({
		shutdownOnComplete: params.shutdownOnComplete,
		runCompleted: options.runCompleted,
		createdTeamNames: options.createdTeamNames,
		teamNames: options.teamNames,
	}) ? "destroy" : "ask";
	if (!["ask", "save", "destroy", "keep-live", "none"].includes(action)) action = "ask";
	return {
		action,
		shouldShutdown: ["ask", "save", "destroy"].includes(action),
		shouldAsk: action === "ask",
		shouldSave: action === "save",
		shouldDestroy: action === "destroy",
		reason: explicit ? "explicit" : saveBool !== null ? "saveTeamForFutureUse" : params.shutdownOnComplete !== undefined ? "shutdownOnComplete" : "default-destroy-after-complete",
	};
}

function renderTeamRetentionPrompt(lifecycle: any, pendingRetention: any, savedTemplates: any[], discardedTemplates: any[]) {
	if (!lifecycle || lifecycle.action === "none") return [] as string[];
	const lines = ["## Team retention"];
	lines.push(`- lifecycle action: ${lifecycle.action}`);
	lines.push(`- live team/workspace cleanup: ${lifecycle.shouldShutdown ? "completed or attempted" : "not requested"}`);
	if (pendingRetention) {
		lines.push(`- pending retention id: ${pendingRetention.pendingId}`);
		lines.push(`- pending templates: ${(pendingRetention.templates || []).map((template: any) => template.templateId).join(", ") || "—"}`);
		lines.push("- question: Save this team setup for future use?");
		lines.push(`- yes: call cmux_pi_team action=retention runId=${pendingRetention.runId} teamRetentionDecision=save`);
		lines.push(`- no: call cmux_pi_team action=retention runId=${pendingRetention.runId} teamRetentionDecision=destroy`);
	}
	if (savedTemplates?.length) lines.push(`- saved templates: ${savedTemplates.map((template: any) => template.templateId).join(", ")}`);
	if (discardedTemplates?.length) lines.push(`- discarded pending templates: ${discardedTemplates.map((item: any) => item.pendingId || item.runId || "pending").join(", ")}`);
	return lines;
}

async function resolveTeamNamesForAction(
	pi: ExtensionAPI,
	params: any,
	ctx: any,
	signal?: AbortSignal,
	options: { allowImplicitReuse?: boolean; timeout?: number } = {},
) {
	const explicit = resolveRequestedTeamNames(params);
	if (explicit.length) return { teamNames: explicit, source: "explicit", reused: false, candidates: [] as any[] };
	if (params.runId) {
		try {
			const run = resolveRunRecord(params.runId);
			const runTeams = uniqueStrings(run.teamNames || []);
			if (runTeams.length) return { teamNames: runTeams, source: "run", reused: true, candidates: [] as any[] };
		} catch {
			// ignore
		}
	}
	if (!options.allowImplicitReuse || params.reuseExisting === false) {
		return { teamNames: [], source: "none", reused: false, candidates: [] as any[] };
	}
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const focusedWorkspace = await currentWorkspaceRef(pi, signal, timeout).catch(() => null);
	const registry = readTeamRegistry();
	const requestedCount = positiveInteger(params.teamCount) || 1;
	const teamRecords = Object.values(registry.teams || {}).map((record: any) => ({
		...record,
		liveCount: liveMembersForTeam(record, live).length,
	}));
	const candidates = selectReusableTeamCandidates(teamRecords, {
		taskText: `${params.task || ""}\n${params.goal || ""}`,
		cwd: ctx?.cwd,
		focusedWorkspace,
		limit: requestedCount,
	});
	const teamNames = candidates.map((item: any) => item.team);
	return { teamNames, source: teamNames.length ? "heuristic" : "none", reused: teamNames.length > 0, candidates };
}

async function createPiTeams(
	pi: ExtensionAPI,
	params: any,
	ctx: any,
	signal?: AbortSignal,
) {
	const teamNames = resolveRequestedTeamNames(params);
	if (!teamNames.length) throw new Error("team is required");
	const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT;
	const runId = params.runId || generateRunId("swarm");
	const sessionFingerprint = params.cmuxSessionFingerprint || await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	const created = [];
	for (const teamName of teamNames) {
		created.push(await createPiTeam(pi, materializeTeamParams({ ...params, runId, cmuxSessionFingerprint: sessionFingerprint }, teamName, teamNames.length > 1), ctx, signal));
	}
	const initialRunRecord = upsertRunRecord({
		runId,
		title: params.goal || params.task || params.executionContract?.outcome || teamNames.join(", "),
		task: params.task || null,
		goal: params.goal || null,
		teamNames,
		modelPreset: params.appliedModelPreset || params.modelPreset || null,
		status: "active",
		orchestrationMode: inferOrchestrationMode(params),
		roundsPlanned: positiveInteger(params.rounds) || DEFAULT_SWARM_ROUNDS,
		roundsCompleted: 0,
		operatorWorkspace: params.operatorTarget?.workspace || null,
		operatorSurface: params.operatorTarget?.surface || null,
		operatorSessionId: params.operatorTarget?.sessionId || null,
		cmuxSessionId: sessionFingerprint?.sessionId || null,
		outcomeIntent: params.outcomeIntent || null,
		executionContract: params.executionContract || null,
		executionPlan: params.executionPlan || null,
		completionGate: params.executionPlan?.completionGate || null,
		createdAt: nowIso(),
	});
	const planningArtifacts = params.executionContract && params.executionPlan
		? persistOutcomeExecutionArtifacts("runs", runId, params.executionContract, params.executionPlan)
		: null;
	if (planningArtifacts) {
		upsertRunRecord({
			runId,
			artifactPaths: uniqueStrings([...(initialRunRecord.artifactPaths || []), ...planningArtifacts.artifactPaths]),
			planningArtifacts: planningArtifacts.artifactPaths,
		});
	}
	appendRunEvent(runId, { type: "run_created", detail: params.goal || params.task || teamNames.join(", "), source: "orchestrator" });
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_run_created", {
		runId,
		teamNames,
		goal: params.goal || null,
		task: params.task || null,
		summary: `Orchestrator created run ${runId} for ${teamNames.join(", ") || "swarm"}.`,
	}, undefined, {
		runId,
		teamId: teamNames.length === 1 ? teamNames[0] : null,
		launcher: "cmux-orchestrator",
		launchMode: inferOrchestrationMode(params),
		interfaceMode: "terminal",
	}).catch(() => null);
	await recordSwarmDecision(pi, ctx, {
		cwd: ctx.cwd,
		runId,
		teamId: teamNames.length === 1 ? teamNames[0] : null,
		agentAlias: teamNames[0] ? `${teamNames[0]}-lead` : "orchestrator",
	}, {
		summary: `Orchestrator created run ${runId}.`,
		rationale: summarize([params.goal, params.task].filter(Boolean).join(" • "), 240) || `Teams: ${teamNames.join(", ")}`,
		status: "accepted",
	}, { signal }).catch(() => null);
	const createdTeamRecords = created.map((item: any) => item?.teamRecord).filter(Boolean);
	persistMissionControlSnapshot(runId, createdTeamRecords);
	rememberPrimaryActivityContext(ctx);
	startPrimaryActivityMonitor(pi, runId, createdTeamRecords, { stopOnComplete: true });
	await stabilizeOperatorSidebar(pi, params.operatorTarget?.workspace, created.map((item: any) => item?.teamRecord?.workspace), signal, timeout);
	return created;
}

function planPiTeams(params: any, ctx: any) {
	const teamNames = resolveRequestedTeamNames(params);
	if (!teamNames.length) throw new Error("team is required");
	const runId = params.runId || generateRunId("swarm-plan");
	return teamNames.map((teamName: string) => {
		const effective = materializeTeamParams({ ...params, runId }, teamName, teamNames.length > 1);
		const team = effective.team;
		const layout = effective.layout || "shared_workspace";
		const cwd = effective.cwd || ctx?.cwd;
		const customSpecs = Array.isArray(effective.specs) && effective.specs.length ? effective.specs : null;
		const memberSpecs = assignModelsToMemberSpecs(customSpecs || defaultTeamMemberSpecs(team, effective), {
			provider: effective.provider,
			model: effective.model,
			models: Array.isArray(effective.models) ? effective.models : [],
			roleModelMap: Array.isArray(effective.roleModelMap) ? effective.roleModelMap : [],
			modelStrategy: effective.modelStrategy,
			taskText: `${effective.goal || ""}\n${effective.task || ""}`,
		});
		const roster = memberSpecs
			.map((spec: any, index: number) => `- ${spec.alias} (${spec.role || spec.alias || "agent"})${index === 0 ? " [lead]" : ""}`)
			.join("\n");
		const teamWorkspaceTitle = effective.workspaceTitle || defaultTeamWorkspaceTitle(team);
		const teamWorkspaceDescription = effective.workspaceDescription || defaultTeamWorkspaceDescription(team, {
			goal: effective.goal || effective.task || null,
			runId,
			memberCount: memberSpecs.length,
			layout,
		});
		const teamWorkspaceColor = effective.workspaceColor || workspaceColorForSeed(team);
		let sharedWorkspacePlaceholder = effective.workspace || `workspace:${safeFileSegment(team)}`;
		const members = memberSpecs.map((spec: any, index: number) => {
			const role = spec.role || spec.alias || `agent-${index + 1}`;
			const lead = index === 0;
			const surfaceTitle = spec.surfaceTitle || defaultAgentSurfaceTitle({ alias: spec.alias, role, lead });
			const launchParams: any = {
				...effective,
				...spec,
				alias: spec.alias,
				role,
				lead,
				team,
				runId,
				cwd: spec.cwd || cwd,
				provider: spec.provider || effective.provider,
				model: spec.model || effective.model,
				thinking: spec.thinking || effective.thinking,
				tools: spec.tools || effective.tools,
				sessionPath: spec.sessionPath || effective.sessionPath || defaultSessionPath(spec.alias, runId),
				extraArgs: spec.extraArgs || effective.extraArgs,
				surfaceTitle,
				prompt: spec.prompt || buildTeamBootstrapPrompt(team, role, effective.goal || effective.task, { roster }),
			};
			if (layout === "shared_workspace") {
				if (index === 0 && !effective.workspace) {
					launchParams.target = "new_workspace";
					launchParams.workspaceTitle = spec.workspaceTitle || teamWorkspaceTitle;
					launchParams.workspaceDescription = spec.workspaceDescription || teamWorkspaceDescription;
				} else {
					// In shared_workspace layout, every non-first member must stay inside the team workspace.
					// Ignore per-member workspace overrides here; use layout=separate_workspaces for one-workspace-per-agent behavior.
					launchParams.target = spec.target && spec.target !== "new_workspace" ? spec.target : "split";
					launchParams.workspace = sharedWorkspacePlaceholder;
					launchParams.workspaceTitle = teamWorkspaceTitle;
					launchParams.workspaceDescription = spec.workspaceDescription || teamWorkspaceDescription;
					launchParams.direction = spec.direction || effective.direction || (index % 2 === 1 ? "right" : "down");
				}
			} else {
				launchParams.target = spec.target || "new_workspace";
				launchParams.workspaceTitle = spec.workspaceTitle || defaultAgentWorkspaceTitle({ alias: spec.alias, team, role, lead });
				launchParams.workspaceDescription = spec.workspaceDescription || defaultAgentWorkspaceDescription({
					goal: effective.goal || effective.task || null,
					runId,
					team,
					role,
					layout,
				});
			}
			const launchCommand = buildPiLaunchCommand({
				alias: launchParams.alias,
				cwd: launchParams.cwd,
				prompt: launchParams.prompt,
				provider: launchParams.provider,
				model: launchParams.model,
				thinking: launchParams.thinking,
				tools: launchParams.tools,
				noExtensions: launchParams.noExtensions,
				noSkills: launchParams.noSkills,
				sessionPath: launchParams.sessionPath,
				extraArgs: launchParams.extraArgs,
				interfaceMode: launchParams.interfaceMode || launchParams.interface || "terminal",
				taskId: launchParams.taskId || null,
				runId,
				teamId: team,
				agentId: launchParams.agentId || launchParams.alias,
				agentAlias: launchParams.alias,
				role: launchParams.role || null,
				launcher: "cmux-orchestrator",
				launchMode: "team",
			});
			return {
				alias: launchParams.alias,
				role,
				lead,
				provider: launchParams.provider || null,
				model: launchParams.model || null,
				cwd: launchParams.cwd || null,
				target: launchParams.target,
				workspace: launchParams.workspace || null,
				workspaceTitle: launchParams.workspaceTitle || null,
				workspaceDescription: launchParams.workspaceDescription || null,
				direction: launchParams.direction || null,
				surfaceTitle,
				sessionPath: launchParams.sessionPath || null,
				promptSummary: summarize(launchParams.prompt, 120),
				launchCommand,
			};
		});
		return {
			team,
			runId,
			layout,
			goal: effective.goal || effective.task || null,
			workspaceTitle: layout === "shared_workspace" ? teamWorkspaceTitle : null,
			workspaceDescription: layout === "shared_workspace" ? teamWorkspaceDescription : null,
			workspaceColor: teamWorkspaceColor,
			memberCount: members.length,
			requestedAgentCount: inferTeamAgentCount(effective),
			members,
		};
	});
}

function renderTeamPlanSummary(teamPlans: any[]) {
	return [
		`# cmux team launch plan`,
		"",
		...teamPlans.flatMap((plan: any) => [
			`## ${plan.team}`,
			`- runId: ${plan.runId}`,
			`- layout: ${plan.layout}`,
			`- goal: ${plan.goal || "—"}`,
			plan.workspaceTitle ? `- workspaceTitle: ${plan.workspaceTitle}` : null,
			plan.workspaceColor ? `- workspaceColor: ${plan.workspaceColor}` : null,
			`- members: ${plan.memberCount}`,
			...plan.members.map((member: any) => `- ${member.alias} (${member.role || "agent"}) target=${member.target} workspace=${member.workspaceTitle || member.workspace || "—"} model=${member.provider || "—"}/${member.model || "—"}`),
			"",
		]).filter(Boolean),
	].join("\n");
}

async function resolveOrCreatePiTeams(
	pi: ExtensionAPI,
	params: any,
	ctx: any,
	signal?: AbortSignal,
) {
	const teamNames = resolveRequestedTeamNames(params);
	if (!teamNames.length) throw new Error("team is required");
	const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT;
	const runId = params.runId || generateRunId("swarm");
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => null);
	const sessionFingerprint = params.cmuxSessionFingerprint || await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	const records = [];
	for (const teamName of teamNames) {
		let existing = null;
		try {
			existing = resolveTeamRecord(teamName);
		} catch {
			// create below if allowed
		}
		if (existing) {
			const priorLaunchFailed = String(existing.status || "") === "launch_failed" || (existing.members || []).some((member: any) => {
				try {
					return String(resolveAgentRecord(member.alias)?.status || "") === "launch_failed";
				} catch {
					return false;
				}
			});
			const liveMemberCount = liveMembersForTeam(existing, live || undefined).length;
			const piEvidence = liveMemberCount ? teamPiEvidenceSummary(existing) : { readyCount: 0, total: 0, readyAliases: [] };
			const liveButNotPiReady = liveMemberCount > 0 && piEvidence.total > 0 && piEvidence.readyCount < piEvidence.total;
			if ((priorLaunchFailed || liveButNotPiReady) && params.createIfMissing !== false) {
				existing = null;
				removeTeamRecord(teamName);
				appendRunEvent(runId, {
					type: priorLaunchFailed ? "team_recreate_after_launch_failure" : "team_recreate_after_incomplete_pi_readiness",
					team: teamName,
					status: "active",
					detail: `live=${liveMemberCount} piReady=${piEvidence.readyCount}/${piEvidence.total}`,
					source: "orchestrator",
				});
			} else if (existing.cmuxSessionId && sessionFingerprint?.sessionId && existing.cmuxSessionId !== sessionFingerprint.sessionId) {
				existing = null;
				removeTeamRecord(teamName);
			} else {
				const reconciled = reconcileTeamRecordWithLive(existing, live || undefined);
				if (reconciled) {
					const next = upsertTeamRecord({ ...reconciled, runId, cmuxSessionId: sessionFingerprint?.sessionId || reconciled.cmuxSessionId || null });
					records.push(next);
					continue;
				}
				if (params.createIfMissing === false) {
					throw new Error(`Team ${teamName} has no live members`);
				}
				removeTeamRecord(teamName);
			}
		}
		if (params.createIfMissing === false) throw new Error(`Team ${teamName} does not exist`);
		records.push((await createPiTeam(pi, materializeTeamParams({ ...params, runId, cmuxSessionFingerprint: sessionFingerprint }, teamName, teamNames.length > 1), ctx, signal)).teamRecord);
	}
	upsertRunRecord({
		runId,
		title: params.goal || params.task || teamNames.join(", "),
		task: params.task || null,
		goal: params.goal || null,
		teamNames,
		modelPreset: params.appliedModelPreset || params.modelPreset || null,
		status: "active",
		orchestrationMode: inferOrchestrationMode(params),
		roundsPlanned: positiveInteger(params.rounds) || DEFAULT_SWARM_ROUNDS,
		roundsCompleted: 0,
		operatorWorkspace: params.operatorTarget?.workspace || null,
		operatorSurface: params.operatorTarget?.surface || null,
		operatorSessionId: params.operatorTarget?.sessionId || null,
		cmuxSessionId: sessionFingerprint?.sessionId || null,
		createdAt: nowIso(),
	});
	appendRunEvent(runId, { type: "run_resolved", detail: `teams=${teamNames.join(",")}`, source: "orchestrator" });
	persistMissionControlSnapshot(runId, records);
	return records;
}

async function createPiTeam(
	pi: ExtensionAPI,
	params: any,
	ctx: any,
	signal?: AbortSignal,
) {
	const team = params.team;
	if (!team) throw new Error("team is required");
	const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT;
	const layout = params.layout || "shared_workspace";
	const cwd = params.cwd || ctx?.cwd;
	const runId = params.runId || generateRunId("swarm");
	const sessionFingerprint = params.cmuxSessionFingerprint || await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	const customSpecs = Array.isArray(params.specs) && params.specs.length ? params.specs : null;
	const memberSpecs = assignModelsToMemberSpecs(customSpecs || defaultTeamMemberSpecs(team, params), {
		provider: params.provider,
		model: params.model,
		models: Array.isArray(params.models) ? params.models : [],
		roleModelMap: Array.isArray(params.roleModelMap) ? params.roleModelMap : [],
		modelStrategy: params.modelStrategy,
		taskText: `${params.goal || ""}\n${params.task || ""}`,
	});
	const roster = memberSpecs
		.map((spec: any, index: number) => `- ${spec.alias} (${spec.role || spec.alias || "agent"})${index === 0 ? " [lead]" : ""}`)
		.join("\n");
	const teamWorkspaceTitle = params.workspaceTitle || defaultTeamWorkspaceTitle(team);
	const teamWorkspaceDescription = params.workspaceDescription || defaultTeamWorkspaceDescription(team, {
		goal: params.goal || params.task || null,
		runId,
		memberCount: memberSpecs.length,
		layout,
	});
	const launchedMembers: any[] = [];
	let sharedWorkspace = params.workspace || null;
	const teamWorkspaceColor = params.workspaceColor || workspaceColorForSeed(team);

	for (let i = 0; i < memberSpecs.length; i++) {
		const spec = memberSpecs[i];
		const role = spec.role || spec.alias || `agent-${i + 1}`;
		const lead = i === 0;
		const surfaceTitle = spec.surfaceTitle || defaultAgentSurfaceTitle({
			alias: spec.alias,
			role,
			lead,
		});
		const launchParams: any = {
			...params,
			...spec,
			alias: spec.alias,
			role,
			lead,
			team,
			runId,
			cmuxSessionFingerprint: sessionFingerprint,
			cwd: spec.cwd || cwd,
			provider: spec.provider || params.provider,
			model: spec.model || params.model,
			thinking: spec.thinking || params.thinking,
			tools: spec.tools || params.tools,
			sessionPath: spec.sessionPath || params.sessionPath || defaultSessionPath(spec.alias, runId),
			extraArgs: spec.extraArgs || params.extraArgs,
			surfaceTitle,
			prompt:
				spec.prompt || buildTeamBootstrapPrompt(team, role, params.goal || params.task, { roster }),
		};

		if (layout === "shared_workspace") {
			if (i === 0 && !sharedWorkspace) {
				launchParams.target = "new_workspace";
				launchParams.workspaceTitle = spec.workspaceTitle || teamWorkspaceTitle;
				launchParams.workspaceDescription = spec.workspaceDescription || teamWorkspaceDescription;
			} else {
				// In shared_workspace layout, every non-first member must stay inside the team workspace.
				// Ignore per-member workspace overrides here; use layout=separate_workspaces for one-workspace-per-agent behavior.
				launchParams.target = spec.target && spec.target !== "new_workspace" ? spec.target : "split";
				launchParams.workspace = sharedWorkspace;
				launchParams.workspaceTitle = teamWorkspaceTitle;
				launchParams.workspaceDescription = spec.workspaceDescription || teamWorkspaceDescription;
				launchParams.direction = spec.direction || params.direction || (i % 2 === 1 ? "right" : "down");
			}
		} else {
			launchParams.target = spec.target || "new_workspace";
			launchParams.workspaceTitle = spec.workspaceTitle || defaultAgentWorkspaceTitle({ alias: spec.alias, team, role, lead });
			launchParams.workspaceDescription = spec.workspaceDescription || defaultAgentWorkspaceDescription({
				goal: params.goal || params.task || null,
				runId,
				team,
				role,
				layout,
			});
		}

		const launched = await launchPiAgent(pi, launchParams, ctx, signal);
		if (layout === "shared_workspace" && !sharedWorkspace) {
			sharedWorkspace = launched.workspaceRef;
			await setWorkspaceColor(pi, sharedWorkspace, teamWorkspaceColor, signal, timeout);
		} else if (layout !== "shared_workspace") {
			await setWorkspaceColor(pi, launched.workspaceRef, teamWorkspaceColor, signal, timeout);
		}
		launchedMembers.push({
			alias: launched.record.alias,
			role,
			provider: launched.record.provider || spec.provider || params.provider || null,
			model: launched.record.model || spec.model || params.model || null,
			workspace: launched.workspaceRef,
			workspaceTitle: launched.record.workspaceTitle || null,
			surface: launched.surfaceRef,
			surfaceTitle: launched.record.surfaceTitle || surfaceTitle,
			pane: launched.surface?.pane_ref || launched.record.pane || null,
			cwd: launched.record.cwd || cwd || null,
			sessionPath: launched.record.sessionPath || null,
			promptSummary: launched.record.promptSummary || null,
		});
	}

	const memberWorkspaceRefs = uniqueStrings(launchedMembers.map((member: any) => member.workspace || null));
	if (layout === "shared_workspace" && memberWorkspaceRefs.length > 1) {
		appendRunEvent(runId, {
			type: "shared_workspace_topology_violation",
			team,
			status: "warning",
			detail: `expected one workspace for team, found ${memberWorkspaceRefs.join(",")}`,
			source: "orchestrator",
		});
	}

	const teamRecord = upsertTeamRecord({
		team,
		runId,
		layout,
		workspace: layout === "shared_workspace" ? sharedWorkspace : null,
		workspaceTitle: layout === "shared_workspace" ? (launchedMembers[0]?.workspaceTitle || teamWorkspaceTitle) : null,
		workspaceDescription: layout === "shared_workspace" ? teamWorkspaceDescription : null,
		workspaceColor: teamWorkspaceColor,
		goal: params.goal || params.task || null,
		modelPreset: params.appliedModelPreset || params.modelPreset || null,
		provider: params.provider || null,
		model: params.model || null,
		modelPool: Array.isArray(params.models) ? params.models : [],
		modelStrategy: params.modelStrategy || null,
		roleModelMap: Array.isArray(params.roleModelMap) ? params.roleModelMap : [],
		status: "active",
		memberCount: launchedMembers.length,
		requestedAgentCount: inferTeamAgentCount(params),
		members: launchedMembers,
		cmuxSessionId: sessionFingerprint?.sessionId || null,
		lastHeartbeatAt: nowIso(),
		createdAt: nowIso(),
	});
	appendRunEvent(runId, { type: "team_created", team, detail: `members=${launchedMembers.length} workspaceTitle=${teamRecord.workspaceTitle || teamWorkspaceTitle}` });
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_team_created", {
		team,
		runId,
		memberCount: launchedMembers.length,
		workspace: teamRecord.workspace || null,
		summary: `Orchestrator created team ${team} with ${launchedMembers.length} member(s).`,
	}, undefined, {
		runId,
		teamId: team,
		workspaceId: teamRecord.workspace || null,
		launcher: "cmux-orchestrator",
		launchMode: "team",
		interfaceMode: "terminal",
	}).catch(() => null);
	await recordSwarmDecision(pi, ctx, {
		cwd: params.cwd || ctx.cwd,
		runId,
		teamId: team,
		agentAlias: launchedMembers[0]?.alias || `${team}-lead`,
		workspaceId: teamRecord.workspace || null,
		surfaceId: launchedMembers[0]?.surface || null,
	}, {
		summary: `Created team ${team} with ${launchedMembers.length} member(s).`,
		rationale: summarize(params.goal || params.task || team, 220),
		status: "accepted",
	}, { signal }).catch(() => null);

	return { teamRecord, launchedMembers };
}

async function dispatchTeamTask(
	pi: ExtensionAPI,
	teamRecord: any,
	task: string,
	options: { extraGuidance?: string; appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const roster = buildTeamRoster(teamRecord);
	const members = teamRecord.members || [];
	const latestTeamRecord = resolveTeamRecord(teamRecord.team);
	const teamMemory = [
		latestTeamRecord?.lastLeadSummary ? `Lead summary: ${latestTeamRecord.lastLeadSummary}` : "",
		latestTeamRecord?.lastRequestsToSwarm ? `Requests to swarm: ${latestTeamRecord.lastRequestsToSwarm}` : "",
		latestTeamRecord?.lastTeamAction ? `Next team action: ${latestTeamRecord.lastTeamAction}` : "",
	].filter(Boolean).join("\n");
	const sendSpecs = members.map((member: any) => ({
		member,
		message: buildTeamTaskPrompt(teamRecord.team, member.role || member.alias, task, options.extraGuidance, {
			roster,
			teamMemory,
		}),
	}));
	for (const spec of sendSpecs) {
		persistGuidanceSnapshot({
			runId: teamRecord.runId,
			team: teamRecord.team,
			aliases: [spec.member.alias],
			kind: "task_dispatch",
			message: spec.message,
			status: "active",
		});
	}
	const dispatchedAt = nowIso();
	const results = await Promise.allSettled(
		sendSpecs.map((spec: any) => sendAgentMessage(
			pi,
			{ alias: spec.member.alias, workspace: spec.member.workspace, surface: spec.member.surface },
			spec.message,
			{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
		)),
	);
	upsertTeamRecord({ ...teamRecord, status: "active", lastHeartbeatAt: dispatchedAt, lastTaskDispatchedAt: dispatchedAt, lastTaskSummary: summarize(task, 240) });
	if (teamRecord.runId) {
		upsertRunRecord({ runId: teamRecord.runId, status: "active", lastTaskDispatchedAt: dispatchedAt, lastTaskSummary: summarize(task, 240) });
	}
	appendRunEvent(teamRecord.runId, { type: "task_dispatched", team: teamRecord.team, detail: summarize(task, 240) });
	return results.map((result, index) => result.status === "fulfilled"
		? result.value
		: {
			alias: members[index]?.alias || null,
			error: true,
			message: String((result as PromiseRejectedResult).reason?.message || (result as PromiseRejectedResult).reason || "send failed"),
		});
}

async function sendTeamControlMessage(
	pi: ExtensionAPI,
	teamRecord: any,
	message: string,
	options: { scope?: "leads" | "all"; appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const targets = options.scope === "all"
		? (teamRecord.members || [])
		: teamLeadMembers(teamRecord, 2);
	const results = await Promise.allSettled(
		targets.map((member: any) =>
			sendAgentMessage(
				pi,
				{ alias: member.alias, workspace: member.workspace, surface: member.surface },
				message,
				{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
			),
		),
	);
	return results.map((result, index) => result.status === "fulfilled"
		? result.value
		: {
			alias: targets[index]?.alias || null,
			error: true,
			message: String((result as PromiseRejectedResult).reason?.message || (result as PromiseRejectedResult).reason || "send failed"),
		});
}

async function gatherTeamCaptures(
	pi: ExtensionAPI,
	teamRecord: any,
	options: { lines?: number; scrollback?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const members = teamRecord.members || [];
	const results = await Promise.allSettled(
		members.map((member: any) =>
			captureAgentScreen(
				pi,
				{ alias: member.alias, workspace: member.workspace, surface: member.surface },
				{
					lines: options.lines ?? DEFAULT_TEAM_CAPTURE_LINES,
					scrollback: options.scrollback !== false,
					signal: options.signal,
					timeout: options.timeout,
				},
			),
		),
	);
	return results.map((result, index) => {
		const member = members[index];
		if (result.status === "fulfilled") {
			return {
				team: teamRecord.team,
				role: member.role || member.alias,
				...result.value,
			};
		}
		return {
			team: teamRecord.team,
			alias: member?.alias || `unknown-${index + 1}`,
			role: member?.role || member?.alias || "agent",
			workspace: member?.workspace || null,
			surface: member?.surface || null,
			text: `STATUS: BLOCKED\nOUTPUT: Capture failed.\nRISKS: ${String((result as PromiseRejectedResult).reason?.message || (result as PromiseRejectedResult).reason || "unknown capture failure")}`,
			captureSource: "error",
			sessionPath: member?.sessionPath || null,
			sessionTail: null,
		};
		});
}

function recentNonEmptyLines(text: string, maxLines = 6) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return (lines.length ? lines : ["No output captured."]).slice(-maxLines);
}

function blockerSignals(lines: string[]) {
	const blockers = (lines || []).filter((line) => /(status\s*:\s*blocked|\bblocker\b|\bblocked\b|\bstuck\b|waiting on|need .* from|cannot\b|can't\b|unable to|dependency|failing|failure|error)/i.test(line));
	return blockers.slice(0, 4);
}

function updateAgentAndTeamStateFromDigests(teamRecords: any[], digests: any[]) {
	const digestByAlias = new Map((digests || []).map((digest: any) => [digest.alias, digest]));
	for (const teamRecord of teamRecords || []) {
		const applied = [] as any[];
		const stamp = nowIso();
		for (const member of teamRecord.members || []) {
			const digest = digestByAlias.get(member.alias);
			if (!digest) continue;
			const current = resolveAgentRecord(member.alias);
			const appliedDigest = applyAgentDigest(current, digest, stamp);
			digest.status = appliedDigest.status;
			upsertAgentRecord({
				...current,
				...appliedDigest.patch,
				lastDependencies: Array.isArray(digest.dependencies) ? digest.dependencies : [],
			});
			applied.push(appliedDigest);
		}
		const patch = buildTeamStatePatch(teamRecord, applied, stamp);
		const teamDependencies = (applied || []).flatMap((item: any) => ((item?.digest?.dependencies || []) as any[]).map((dependency: any) => ({
			...dependency,
			fromAlias: item.digest?.alias || null,
			fromRole: item.digest?.role || null,
			fromTeam: item.digest?.team || teamRecord.team || null,
		})));
		upsertTeamRecord({
			...teamRecord,
			...patch,
			lastDependencies: teamDependencies.slice(0, 24),
			openDependencyCount: teamDependencies.filter((dependency: any) => String(dependency?.status || "open") !== "resolved").length,
		});
	}
}

function formatCaptureDigests(digests: any[], limit = 10) {
	const items = (digests || []).slice(0, limit);
	if (!items.length) return "- No fresh updates captured yet.";
	return items
		.map((digest: any) => `- [${digest.team || "team"}] ${digest.alias} (${digest.role || "agent"})${digest.blocked ? " [BLOCKED]" : digest.status === "stalled" ? " [STALLED]" : ""}${digest.confidence ? ` [${String(digest.confidence).toUpperCase()}]` : ""}: ${digest.summary}`)
		.join("\n");
}

function blockedDigests(digests: any[]) {
	return uniqueBy((digests || []).filter((digest: any) => {
		const openDependencies = (digest?.dependencies || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved");
		return digest.blocked || digest.status === "stalled" || openDependencies.some((dependency: any) => dependency.blocked || dependency.requiresAck);
	}), (digest: any) => digest.alias || digest.surface || JSON.stringify(digest));
}

function formatBlockedDigests(digests: any[], limit = 8) {
	const items = blockedDigests(digests).slice(0, limit);
	if (!items.length) return "- No blockers detected.";
	return items
		.map((digest: any) => {
			const dependencyLines = uniqueStrings((digest?.dependencies || [])
				.filter((dependency: any) => String(dependency?.status || "open") !== "resolved" && (dependency.blocked || dependency.requiresAck))
				.map((dependency: any) => dependency.text || dependency.targetHint || dependency.kind || "dependency"));
			const blockerText = uniqueStrings([...(digest.blockers || []), ...dependencyLines]).join(" | ") || digest.summary;
			return `- [${digest.team || "team"}] ${digest.alias} (${digest.role || "agent"})${digest.status === "stalled" ? " [STALLED]" : ""}: ${blockerText}`;
		})
		.join("\n");
}

function formatDependencyDigests(digests: any[], limit = 10) {
	const entries = uniqueStrings((digests || []).flatMap((digest: any) => ((digest?.dependencies || []) as any[])
		.filter((dependency: any) => String(dependency?.status || "open") !== "resolved")
		.map((dependency: any) => `${digest.alias} [${dependency.kind || "dependency"}] ${dependency.targetHint || "external"}: ${dependency.text || digest.needs || digest.summary || "dependency pending"}`)));
	if (!entries.length) return "- No open dependencies reported.";
	return entries.slice(0, limit).map((item: string) => `- ${item}`).join("\n");
}

function buildRoundProgressText(options: {
	runId?: string;
	round: number;
	totalPlannedRounds: number;
	totalAllowedRounds: number;
	digests: any[];
	roundDecision: any;
	teamLeadHeartbeats?: any[];
	coordinatorHeartbeat?: any;
	rebalances?: any[];
	escalations?: any[];
	relays?: any[];
}) {
	const blocked = blockedDigests(options.digests || []);
	return [
		`## Swarm progress${options.runId ? ` — ${options.runId}` : ""}`,
		`- round: ${options.round}/${options.totalPlannedRounds}${options.totalAllowedRounds > options.totalPlannedRounds ? ` (max ${options.totalAllowedRounds})` : ""}`,
		`- status: ${options.roundDecision?.status || "active"}`,
		`- completion signals: ${options.roundDecision?.completionCount || 0}/${(options.digests || []).length || 0}`,
		`- blockers: ${options.roundDecision?.blockedCount || 0}`,
		`- stalled: ${options.roundDecision?.stalledCount || 0}`,
		`- open dependencies: ${uniqueStrings((options.digests || []).flatMap((digest: any) => (digest?.dependencies || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved").map((dependency: any) => `${digest.alias}:${dependency.targetHint || dependency.text || "dependency"}`))).length}`,
		`- remaining work detected: ${options.roundDecision?.remainingWork ? "yes" : "no"}`,
		`- relay messages: ${options.relays?.length || 0}`,
		`- escalations: ${options.escalations?.length || 0}`,
		`- rebalances: ${options.rebalances?.reduce((sum: number, item: any) => sum + (item.sent?.length || 0), 0) || 0}`,
		"",
		options.teamLeadHeartbeats?.length ? "### Team lead reports" : "",
		options.teamLeadHeartbeats?.length ? formatTeamLeadHeartbeats(options.teamLeadHeartbeats, 12) : "",
		options.teamLeadHeartbeats?.length ? "" : "",
		options.coordinatorHeartbeat?.capture?.text ? "### Coordinator heartbeat" : "",
		options.coordinatorHeartbeat?.capture?.text || "",
		options.coordinatorHeartbeat?.capture?.text ? "" : "",
		"### Agent updates",
		formatCaptureDigests(options.digests || [], 24),
		"",
		"### Blockers",
		blocked.length ? formatBlockedDigests(blocked, 12) : "- No blockers detected.",
		"",
		"### Files / areas changed",
		formatDigestFieldList(options.digests || [], "artifacts", 16),
		"",
		"### Commands run",
		formatDigestFieldList(options.digests || [], "commands", 16),
		"",
		"### Deliverables",
		formatDigestFieldList(options.digests || [], "deliverable", 12),
		"",
		"### Dependencies / handoffs",
		formatDependencyDigests(options.digests || [], 12),
		"",
		"### Requests to swarm",
		formatDigestFieldList(options.digests || [], "requestsToSwarm", 12),
		"",
		"### Next orchestrator actions",
		formatDigestFieldList(options.digests || [], "nextOrchestratorAction", 8),
	].filter(Boolean).join("\n");
}

function persistRunProgressSnapshot(runId: string | undefined, entry: any, teamRecords?: any[]) {
	if (!runId) return null;
	const runRecord = resolveRunRecord(runId);
	const progressLog = [...(Array.isArray(runRecord.progressLog) ? runRecord.progressLog : []), entry].slice(-12);
	upsertRunRecord({
		runId,
		lastProgressReportAt: entry.timestamp,
		lastProgressSummary: entry.summary,
		lastRoundNumber: entry.round,
		lastCoordinatorSummary: entry.coordinatorSummary || runRecord.lastCoordinatorSummary || null,
		lastTeamLeadSummaries: Array.isArray(entry.teamLeadSummaries) && entry.teamLeadSummaries.length ? entry.teamLeadSummaries : runRecord.lastTeamLeadSummaries || [],
		completionGateSatisfied: entry.completionGateSatisfied ?? runRecord.completionGateSatisfied ?? null,
		completionGateSummary: entry.completionGateSummary || runRecord.completionGateSummary || null,
		progressLog,
	});
	appendRunEvent(runId, {
		type: "round_progress",
		status: entry.status,
		detail: entry.summary,
		source: "orchestrator",
	});
	persistMissionControlSnapshot(runId, teamRecords);
	return progressLog;
}

function buildMissionControlProgressText(runId: string | undefined, teamRecords: any[], heading: string, extras: string[] = []) {
	if (!runId) return [heading, ...extras].filter(Boolean).join("\n");
	const snapshot = persistMissionControlSnapshot(runId, teamRecords);
	return [heading, "", renderMissionControlSnapshot(snapshot), ...(extras.length ? ["", ...extras] : [])].filter(Boolean).join("\n");
}

function resolveRunContextRecords(runId: string) {
	const runRecord = resolveRunRecord(runId);
	const teamRecords = (runRecord.teamNames || []).map((teamName: string) => {
		try {
			return resolveTeamRecord(teamName);
		} catch {
			return null;
		}
	}).filter(Boolean) as any[];
	const aliases = uniqueStrings(teamRecords.flatMap((teamRecord: any) => (teamRecord.members || []).map((member: any) => member.alias)));
	const agentRecords = aliases.map((alias: string) => {
		try {
			return resolveAgentRecord(alias);
		} catch {
			return null;
		}
	}).filter(Boolean) as any[];
	const runEvents = readRunEvents(runId, 240);
	return { runRecord, teamRecords, agentRecords, runEvents };
}

function evaluateRunCompletionGate(runId: string, digests: any[]) {
	const { runRecord, teamRecords, agentRecords } = resolveRunContextRecords(runId);
	const bridgeStatuses = listBridgeStatuses();
	const gateAgentRecords = agentRecords.map((agentRecord: any) => {
		const bridge = bridgeStatusForAgent(agentRecord, bridgeStatuses);
		return {
			alias: agentRecord.alias,
			role: agentRecord.role || null,
			team: agentRecord.team || null,
			live: agentRecord.live !== false,
			bridgeStale: Boolean(bridge?.bridgeAge?.stale),
			browserSurface: agentRecord.browserSurface || null,
			lastObservationSummary: agentRecord.lastObservationSummary || null,
			lastObservationStatus: agentRecord.lastObservationStatus || null,
		};
	});
	const evaluation = evaluateCompletionGate(digests, {
		gate: runRecord.completionGate || runRecord.executionPlan?.completionGate || null,
		executionContract: runRecord.executionContract || null,
		teamRecords,
		agentRecords: gateAgentRecords,
		doctorFindings: runRecord.doctorFindings || [],
		repairActions: runRecord.repairActions || [],
		repairExecutionLog: runRecord.repairExecutionLog || [],
		verificationState: runRecord.verificationState || null,
	});
	return { runRecord, teamRecords, agentRecords, evaluation };
}

function summarizeCompletionGate(evaluation: any) {
	if (!evaluation?.gatePresent) return "no completion gate";
	if (evaluation.canComplete) return "completion gate satisfied";
	const reasons = uniqueStrings([
		...(evaluation.unmetAcceptanceCriteria || []).map((item: string) => `acceptance=${item}`),
		...(evaluation.unmetVerificationChecks || []).map((item: string) => `verification=${item}`),
		...(evaluation.missingCriticalAliases || []).map((item: string) => `missing=${item}`),
		...(evaluation.staleCriticalAliases || []).map((item: string) => `stale=${item}`),
		...(evaluation.blockingFindings || []).map((item: string) => `finding=${item}`),
		...(evaluation.failedRepairs || []).map((item: string) => `repair=${item}`),
		...(evaluation.verificationStatus && !["approved", "none"].includes(String(evaluation.verificationStatus)) ? [`verification-status=${evaluation.verificationStatus}`] : []),
		...(evaluation.contradictorySignals || []).slice(0, 4),
	]);
	return reasons.join(" | ") || "completion gate not satisfied";
}

function persistDoctorFindings(report: any) {
	const findings = Array.isArray(report?.findings) ? report.findings : [];
	const repairActions = Array.isArray(report?.repairActions) ? report.repairActions : [];
	const byRunFindings = new Map<string, any[]>();
	const byTeamFindings = new Map<string, any[]>();
	const byAliasFindings = new Map<string, any[]>();
	const byRunRepairs = new Map<string, any[]>();
	const byTeamRepairs = new Map<string, any[]>();
	const byAliasRepairs = new Map<string, any[]>();
	for (const finding of findings) {
		if (finding?.runId) byRunFindings.set(finding.runId, [...(byRunFindings.get(finding.runId) || []), finding]);
		if (finding?.team) byTeamFindings.set(finding.team, [...(byTeamFindings.get(finding.team) || []), finding]);
		if (finding?.alias) byAliasFindings.set(finding.alias, [...(byAliasFindings.get(finding.alias) || []), finding]);
	}
	for (const action of repairActions) {
		if (action?.runId) byRunRepairs.set(action.runId, [...(byRunRepairs.get(action.runId) || []), action]);
		if (action?.team) byTeamRepairs.set(action.team, [...(byTeamRepairs.get(action.team) || []), action]);
		if (action?.alias) byAliasRepairs.set(action.alias, [...(byAliasRepairs.get(action.alias) || []), action]);
	}
	const runIds = uniqueStrings([...byRunFindings.keys(), ...byRunRepairs.keys()]);
	for (const runId of runIds) {
		try {
			const runFindings = byRunFindings.get(runId) || [];
			const runRepairs = byRunRepairs.get(runId) || [];
			upsertRunRecord({
				runId,
				doctorFindings: runFindings,
				repairActions: runRepairs,
				lastDoctorAt: nowIso(),
				lastRepairPlanAt: runRepairs.length ? nowIso() : undefined,
				doctorSummary: summarize(runFindings.map((finding: any) => finding.summary).join(" | "), 320),
				repairSummary: runRepairs.length ? summarize(runRepairs.map((action: any) => `${action.action}${action.safeAutoExecute ? " auto" : " manual"}`).join(" | "), 320) : undefined,
			});
			appendRunEvent(runId, {
				type: "doctor_findings_refreshed",
				status: runFindings.some((finding: any) => finding.severity === "critical") ? "attention" : runFindings.length ? "active" : "clear",
				detail: `findings=${runFindings.length} repairs=${runRepairs.length}`,
				source: "doctor",
			});
		} catch {
			// ignore missing run
		}
	}
	const teamNames = uniqueStrings([...byTeamFindings.keys(), ...byTeamRepairs.keys()]);
	for (const team of teamNames) {
		try {
			const teamRecord = resolveTeamRecord(team);
			const teamFindings = byTeamFindings.get(team) || [];
			const teamRepairs = byTeamRepairs.get(team) || [];
			upsertTeamRecord({
				...teamRecord,
				doctorFindings: teamFindings,
				repairActions: teamRepairs,
				lastDoctorAt: nowIso(),
				lastRepairPlanAt: teamRepairs.length ? nowIso() : undefined,
				doctorSummary: summarize(teamFindings.map((finding: any) => finding.summary).join(" | "), 220),
				repairSummary: teamRepairs.length ? summarize(teamRepairs.map((action: any) => `${action.action}${action.safeAutoExecute ? " auto" : " manual"}`).join(" | "), 220) : undefined,
			});
		} catch {
			// ignore missing team
		}
	}
	const aliases = uniqueStrings([...byAliasFindings.keys(), ...byAliasRepairs.keys()]);
	for (const alias of aliases) {
		try {
			const agentRecord = resolveAgentRecord(alias);
			const agentFindings = byAliasFindings.get(alias) || [];
			const agentRepairs = byAliasRepairs.get(alias) || [];
			upsertAgentRecord({
				...agentRecord,
				doctorFindings: agentFindings,
				repairActions: agentRepairs,
				lastDoctorAt: nowIso(),
				lastRepairPlanAt: agentRepairs.length ? nowIso() : undefined,
				doctorSummary: summarize(agentFindings.map((finding: any) => finding.summary).join(" | "), 220),
				repairSummary: agentRepairs.length ? summarize(agentRepairs.map((action: any) => `${action.action}${action.safeAutoExecute ? " auto" : " manual"}`).join(" | "), 220) : undefined,
			});
		} catch {
			// ignore missing agent
		}
	}
	return { findings, repairActions };
}

function repairTargetsForRun(runId: string) {
	try {
		const { runRecord, teamRecords, agentRecords } = resolveRunContextRecords(runId);
		return {
			runRecord,
			teamRecords,
			agentRecords,
			teamNames: uniqueStrings(teamRecords.map((teamRecord: any) => teamRecord.team)),
			aliases: uniqueStrings(agentRecords.map((agentRecord: any) => agentRecord.alias)),
		};
	} catch {
		return { runRecord: null, teamRecords: [], agentRecords: [], teamNames: [], aliases: [] };
	}
}

function filterDoctorFindingsForScope(findings: any[] = [], scope: { runId?: string; teamNames?: string[] } = {}) {
	const teamNames = new Set(uniqueStrings(scope.teamNames || []));
	if (!scope.runId && !teamNames.size) return findings;
	let runAliases = new Set<string>();
	let runTeams = new Set<string>();
	if (scope.runId) {
		const targets = repairTargetsForRun(scope.runId);
		runAliases = new Set(targets.aliases || []);
		runTeams = new Set(targets.teamNames || []);
	}
	return (findings || []).filter((finding: any) => {
		if (scope.runId && finding?.runId === scope.runId) return true;
		if (scope.runId && finding?.team && runTeams.has(finding.team)) return true;
		if (scope.runId && finding?.alias && runAliases.has(finding.alias)) return true;
		if (finding?.team && teamNames.has(finding.team)) return true;
		return false;
	});
}

function filterRepairActionsForScope(actions: any[] = [], scope: { runId?: string; teamNames?: string[] } = {}) {
	const teamNames = new Set(uniqueStrings(scope.teamNames || []));
	if (!scope.runId && !teamNames.size) return actions;
	let runAliases = new Set<string>();
	let runTeams = new Set<string>();
	if (scope.runId) {
		const targets = repairTargetsForRun(scope.runId);
		runAliases = new Set(targets.aliases || []);
		runTeams = new Set(targets.teamNames || []);
	}
	return (actions || []).filter((action: any) => {
		if (scope.runId && action?.runId === scope.runId) return true;
		if (scope.runId && action?.team && runTeams.has(action.team)) return true;
		if (scope.runId && action?.alias && runAliases.has(action.alias)) return true;
		if (action?.team && teamNames.has(action.team)) return true;
		return false;
	});
}

function scopeDoctorReport(report: any, scope: { runId?: string; teamNames?: string[] } = {}) {
	const explicitTeams = uniqueStrings(scope.teamNames || []);
	if (!scope.runId && !explicitTeams.length) return report;
	const targets = scope.runId ? repairTargetsForRun(scope.runId) : { teamNames: explicitTeams, aliases: [] };
	const teamSet = new Set(uniqueStrings([...explicitTeams, ...(targets.teamNames || [])]));
	const aliasSet = new Set(uniqueStrings(targets.aliases || []));
	if (!aliasSet.size && teamSet.size) {
		for (const teamName of teamSet) {
			try {
				for (const member of resolveTeamRecord(teamName).members || []) aliasSet.add(member.alias);
			} catch {
				// ignore missing team
			}
		}
	}
	const teamMatches = (item: any) => !teamSet.size || (item?.team && teamSet.has(item.team));
	const aliasMatches = (item: any) => !aliasSet.size || (item?.alias && aliasSet.has(item.alias));
	const agentMatches = (item: any) => {
		if (scope.runId && item?.runId === scope.runId) return true;
		if (item?.team && teamSet.has(item.team)) return true;
		if (item?.alias && aliasSet.has(item.alias)) return true;
		return false;
	};
	const scopedFindings = filterDoctorFindingsForScope(report.findings || [], scope);
	const scopedRepairs = filterRepairActionsForScope(report.repairActions || [], scope);
	const scopedOfflineAgents = (report.offlineAgents || []).filter(agentMatches);
	const scopedOrphanAgents = (report.orphanAgents || []).filter(agentMatches);
	const scopedAgentsWithoutBridge = (report.agentsWithoutBridge || []).filter((item: any) => agentMatches(item) || aliasMatches(item));
	const scopedAgentsWithStaleBridge = (report.agentsWithStaleBridge || []).filter((item: any) => agentMatches(item) || aliasMatches(item));
	const scopedOfflineTeams = (report.offlineTeams || []).filter(teamMatches);
	const scopedDegradedTeams = (report.degradedTeams || []).filter(teamMatches);
	const scopedSessionMismatches = (report.sessionMismatches || []).filter(teamMatches);
	const scopedRunsWithMissingTeams = (report.runsWithMissingTeams || []).filter((item: any) => !scope.runId || item.runId === scope.runId);
	return {
		...report,
		scope: { runId: scope.runId || null, teamNames: [...teamSet], aliases: [...aliasSet] },
		globalCountSummary: {
			runs: report.runCount,
			teams: report.teamCount,
			agents: report.agentCount,
			findings: report.findings?.length || 0,
			repairActions: report.repairActions?.length || 0,
		},
		offlineAgents: scopedOfflineAgents,
		orphanAgents: scopedOrphanAgents,
		agentsWithoutBridge: scopedAgentsWithoutBridge,
		agentsWithStaleBridge: scopedAgentsWithStaleBridge,
		offlineTeams: scopedOfflineTeams,
		degradedTeams: scopedDegradedTeams,
		sessionMismatches: scopedSessionMismatches,
		runsWithMissingTeams: scopedRunsWithMissingTeams,
		findings: scopedFindings,
		findingSummary: {
			total: scopedFindings.length,
			critical: scopedFindings.filter((item: any) => item.severity === "critical").length,
			high: scopedFindings.filter((item: any) => item.severity === "high").length,
			medium: scopedFindings.filter((item: any) => item.severity === "medium").length,
			low: scopedFindings.filter((item: any) => item.severity === "low").length,
		},
		repairActions: scopedRepairs,
		repairSummary: {
			total: scopedRepairs.length,
			safeAutoExecutable: scopedRepairs.filter((item: any) => item.safeAutoExecute).length,
			manualOnly: scopedRepairs.filter((item: any) => !item.safeAutoExecute).length,
		},
		agentCount: aliasSet.size || scopedOfflineAgents.length + scopedAgentsWithoutBridge.length + scopedAgentsWithStaleBridge.length,
		teamCount: teamSet.size || scopedOfflineTeams.length + scopedDegradedTeams.length,
		runCount: scope.runId ? 1 : (report.runCount || 0),
	};
}

function persistRepairDigestObservation(alias: string, digest: any, note?: string | null) {
	try {
		const agentRecord = resolveAgentRecord(alias);
		const timestamp = nowIso();
		upsertAgentRecord({
			...agentRecord,
			lastObservedAt: timestamp,
			lastObservationStatus: digest?.status || agentRecord.lastObservationStatus || null,
			lastObservationSummary: summarize([digest?.summary, note].filter(Boolean).join(" | "), 220) || agentRecord.lastObservationSummary || null,
			observationCount: Number(agentRecord.observationCount || 0) + 1,
			observationLog: appendHistoryEntry(agentRecord.observationLog, {
				timestamp,
				alias,
				team: agentRecord.team || null,
				status: digest?.status || null,
				summary: summarize([digest?.summary, note].filter(Boolean).join(" | "), 220),
				blockers: digest?.blockers || [],
				artifacts: digest?.artifacts || [],
				commands: digest?.commands || [],
				urls: digest?.urls || [],
				completion: Boolean(digest?.completion),
			}, 24),
		});
	} catch {
		// ignore missing agent state
	}
}

function persistRepairExecutionResults(results: any[] = []) {
	const byRun = new Map<string, any[]>();
	const byTeam = new Map<string, any[]>();
	const byAlias = new Map<string, any[]>();
	for (const result of results || []) {
		if (result?.runId) byRun.set(result.runId, [...(byRun.get(result.runId) || []), result]);
		if (result?.team) byTeam.set(result.team, [...(byTeam.get(result.team) || []), result]);
		if (result?.alias) byAlias.set(result.alias, [...(byAlias.get(result.alias) || []), result]);
	}
	for (const [runId, runResults] of byRun.entries()) {
		try {
			const runRecord = resolveRunRecord(runId);
			upsertRunRecord({
				runId,
				lastRepairExecutionAt: nowIso(),
				lastRepairExecutionSummary: summarize(runResults.map((item: any) => `${item.action}:${item.status}`).join(" | "), 320),
				repairExecutionLog: appendHistoryEntry(runRecord.repairExecutionLog, {
					timestamp: nowIso(),
					status: runResults.some((item: any) => item.status === "failed") ? "mixed" : runResults.every((item: any) => item.status === "executed") ? "executed" : "partial",
					action: uniqueStrings(runResults.map((item: any) => item.action)).join(", "),
					note: summarize(runResults.map((item: any) => `${item.action}:${item.status}${item.note ? `(${item.note})` : ""}`).join(" | "), 320),
					safeAutoExecute: true,
				}, 24),
			});
			for (const item of runResults) {
				appendRunEvent(runId, {
					type: item.status === "executed" ? "repair_action_executed" : item.status === "failed" ? "repair_action_failed" : "repair_action_skipped",
					status: item.status,
					team: item.team || null,
					alias: item.alias || null,
					detail: `${item.action}${item.note ? ` | ${item.note}` : ""}`,
					source: "repair_executor",
				});
			}
		} catch {
			// ignore missing run
		}
	}
	for (const [team, teamResults] of byTeam.entries()) {
		try {
			const teamRecord = resolveTeamRecord(team);
			upsertTeamRecord({
				...teamRecord,
				lastRepairExecutionAt: nowIso(),
				lastRepairExecutionSummary: summarize(teamResults.map((item: any) => `${item.action}:${item.status}`).join(" | "), 220),
				repairExecutionLog: appendHistoryEntry(teamRecord.repairExecutionLog, {
					timestamp: nowIso(),
					status: teamResults.some((item: any) => item.status === "failed") ? "mixed" : teamResults.every((item: any) => item.status === "executed") ? "executed" : "partial",
					action: uniqueStrings(teamResults.map((item: any) => item.action)).join(", "),
					note: summarize(teamResults.map((item: any) => `${item.action}:${item.status}${item.note ? `(${item.note})` : ""}`).join(" | "), 220),
					safeAutoExecute: true,
				}, 16),
			});
		} catch {
			// ignore missing team
		}
	}
	for (const [alias, agentResults] of byAlias.entries()) {
		try {
			const agentRecord = resolveAgentRecord(alias);
			upsertAgentRecord({
				...agentRecord,
				lastRepairExecutionAt: nowIso(),
				lastRepairExecutionSummary: summarize(agentResults.map((item: any) => `${item.action}:${item.status}`).join(" | "), 220),
				repairExecutionLog: appendHistoryEntry(agentRecord.repairExecutionLog, {
					timestamp: nowIso(),
					status: agentResults.some((item: any) => item.status === "failed") ? "mixed" : agentResults.every((item: any) => item.status === "executed") ? "executed" : "partial",
					action: uniqueStrings(agentResults.map((item: any) => item.action)).join(", "),
					note: summarize(agentResults.map((item: any) => `${item.action}:${item.status}${item.note ? `(${item.note})` : ""}`).join(" | "), 220),
					safeAutoExecute: true,
				}, 16),
			});
		} catch {
			// ignore missing agent
		}
	}
	return results;
}

function persistVerificationResults(items: any[] = []) {
	const timestamp = nowIso();
	const summary = summarizeVerificationResults(items.map((item: any) => ({ alias: item.alias, team: item.team || null, result: item.result })));
	const byRun = new Map<string, any[]>();
	const byTeam = new Map<string, any[]>();
	for (const item of items || []) {
		if (item?.runId) byRun.set(item.runId, [...(byRun.get(item.runId) || []), item]);
		if (item?.team) byTeam.set(item.team, [...(byTeam.get(item.team) || []), item]);
		if (item?.alias) {
			try {
				const agentRecord = resolveAgentRecord(item.alias);
				upsertAgentRecord({
					...agentRecord,
					lastVerificationAt: timestamp,
					lastVerificationStatus: item.result?.status || null,
					lastVerificationSummary: item.result?.summary || null,
					verificationLog: appendHistoryEntry(agentRecord.verificationLog, {
						timestamp,
						status: item.result?.status || null,
						summary: item.result?.summary || null,
						decision: item.result?.decision || null,
						evidence: item.result?.evidence || [],
					}, 16),
				});
			} catch {
				// ignore missing agent
			}
		}
	}
	for (const [team, teamItems] of byTeam.entries()) {
		try {
			const teamRecord = resolveTeamRecord(team);
			const teamSummary = summarizeVerificationResults(teamItems.map((item: any) => ({ alias: item.alias, team, result: item.result })));
			upsertTeamRecord({
				...teamRecord,
				lastVerificationAt: timestamp,
				verificationState: teamSummary,
				lastVerificationStatus: teamSummary.status,
				lastVerificationSummary: teamSummary.summary,
				verificationLog: appendHistoryEntry(teamRecord.verificationLog, {
					timestamp,
					status: teamSummary.status,
					summary: teamSummary.summary,
					approvedAliases: teamSummary.approvedAliases,
					rejectedAliases: teamSummary.rejectedAliases,
					inconclusiveAliases: teamSummary.inconclusiveAliases,
					requestedAliases: teamSummary.requestedAliases,
				}, 16),
			});
		} catch {
			// ignore missing team
		}
	}
	for (const [runId, runItems] of byRun.entries()) {
		try {
			const runRecord = resolveRunRecord(runId);
			const runSummary = summarizeVerificationResults(runItems.map((item: any) => ({ alias: item.alias, team: item.team || null, result: item.result })));
			upsertRunRecord({
				runId,
				lastVerificationAt: timestamp,
				verificationState: runSummary,
				lastVerificationStatus: runSummary.status,
				lastVerificationSummary: runSummary.summary,
				verificationLog: appendHistoryEntry(runRecord.verificationLog, {
					timestamp,
					status: runSummary.status,
					summary: runSummary.summary,
					approvedAliases: runSummary.approvedAliases,
					rejectedAliases: runSummary.rejectedAliases,
					inconclusiveAliases: runSummary.inconclusiveAliases,
					requestedAliases: runSummary.requestedAliases,
				}, 24),
			});
			appendRunEvent(runId, {
				type: runSummary.status === "approved" ? "verification_approved" : runSummary.status === "rejected" ? "verification_rejected" : runSummary.status === "requested" ? "verification_requested" : "verification_inconclusive",
				status: runSummary.status,
				detail: runSummary.summary,
				source: "repair_executor",
			});
		} catch {
			// ignore missing run
		}
	}
	return summary;
}

async function executeSafeRepairActions(
	pi: ExtensionAPI,
	report: any,
	options: { runId?: string; teamNames?: string[]; limit?: number; signal?: AbortSignal; timeout?: number } = {},
) {
	const scope = { runId: options.runId, teamNames: options.teamNames || [] };
	const scopedActions = filterRepairActionsForScope(report?.repairActions || [], scope);
	const beforeFindings = filterDoctorFindingsForScope(report?.findings || [], scope);
	const plan = buildRepairExecutionPlan(scopedActions, { limit: options.limit || 8 });
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const execution = await executeRepairExecutionPlan(plan.selected, {
		suppress_completion: async (entry: any) => {
			const runId = entry.runId || null;
			if (!runId) throw new Error("runId required");
			const runRecord = resolveRunRecord(runId);
			upsertRunRecord({
				runId,
				status: runRecord.status === "blocked" ? "blocked" : "active",
				completedAt: null,
				completionGateSatisfied: false,
				completionSuppressedAt: nowIso(),
				completionSuppressedReason: entry.reason || "repair executor suppressed completion",
			});
			return { note: `completion hold applied to ${runId}` };
		},
		reingest_bridge: async (entry: any) => {
			const runId = entry.runId || (entry.alias ? resolveAgentRecord(entry.alias)?.runId : null) || (entry.team ? resolveTeamRecord(entry.team)?.runId : null);
			if (!runId) throw new Error("runId required for bridge reingest");
			const { agents: bridgeAgents, run } = ingestBridgeEventsIntoOrchestrator(runId);
			for (const [alias, bridgeState] of bridgeAgents.entries()) {
				try {
					const current = resolveAgentRecord(alias);
					upsertAgentRecord(applyBridgeStateToAgentRecord(current, bridgeState));
				} catch {
					// ignore missing agent
				}
			}
			upsertRunRecord({ runId, bridgeActivity: run, lastBridgeIngestAt: nowIso() });
			return { note: `reingested bridge for ${runId}`, agents: bridgeAgents.size };
		},
		retry_capture: async (entry: any) => {
			const alias = entry.alias || (entry.team ? primaryTeamLead(resolveTeamRecord(entry.team))?.alias : null);
			if (!alias) throw new Error("alias required for retry_capture");
			const capture = await captureAgentScreen(pi, { alias }, { lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout });
			const digest = buildCaptureDigest(capture);
			persistRepairDigestObservation(alias, digest, "repair retry capture");
			return { note: `captured ${alias}`, status: digest.status };
		},
		request_heartbeat: async (entry: any) => {
			const alias = entry.alias || (entry.team ? primaryTeamLead(resolveTeamRecord(entry.team))?.alias : null);
			if (!alias) throw new Error("alias required for request_heartbeat");
			const record = resolveAgentRecord(alias);
			const message = [
				"Repair heartbeat request from cmux orchestrator.",
				"Reply briefly with these exact sections: STATUS, SUMMARY, BLOCKERS, NEXT, NEEDS FROM PEERS.",
				"Do not claim completion unless your assigned work is truly complete and verified.",
			].join("\n\n");
			persistGuidanceSnapshot({ runId: record.runId, team: record.team || null, aliases: [alias], kind: "repair_request_heartbeat", message, status: "active" });
			await sendAgentMessage(pi, { alias }, message, { appendEnter: true, signal: options.signal, timeout });
			await sleep(900);
			const capture = await captureAgentScreen(pi, { alias }, { lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout }).catch(() => null);
			if (capture) {
				const digest = buildCaptureDigest(capture);
				persistRepairDigestObservation(alias, digest, "repair heartbeat response");
			}
			return { note: `heartbeat requested from ${alias}` };
		},
		request_team_heartbeat: async (entry: any) => {
			if (!entry.team) throw new Error("team required for request_team_heartbeat");
			const teamRecord = resolveTeamRecord(entry.team);
			const lead = primaryTeamLead(teamRecord);
			if (!lead?.alias) throw new Error("team lead unavailable");
			const message = [
				"Repair team heartbeat request from cmux orchestrator.",
				`Team: ${entry.team}`,
				"Reply with these exact sections: TEAM STATUS, KEY CHANGES, BLOCKERS, REMAINING WORK, REQUESTS TO SWARM, NEXT TEAM ACTION.",
				"Do not mark TEAM STATUS complete unless the team is genuinely done and verified.",
			].join("\n\n");
			persistGuidanceSnapshot({ runId: teamRecord.runId || null, team: entry.team, aliases: [lead.alias], kind: "repair_request_team_heartbeat", message, status: "active" });
			await sendAgentMessage(pi, { alias: lead.alias }, message, { appendEnter: true, signal: options.signal, timeout });
			await sleep(1000);
			const capture = await captureAgentScreen(pi, { alias: lead.alias }, { lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout }).catch(() => null);
			if (capture) {
				const digest = buildCaptureDigest({ ...capture, team: entry.team, role: lead.role || "lead" });
				persistRepairDigestObservation(lead.alias, digest, "repair team heartbeat response");
			}
			return { note: `team heartbeat requested from ${lead.alias}` };
		},
		verification_round: async (entry: any) => {
			const targets = [] as string[];
			if (entry.alias) {
				targets.push(entry.alias);
			} else if (entry.team) {
				const teamRecord = resolveTeamRecord(entry.team);
				const prioritized = (teamRecord.members || [])
					.filter((member: any) => /(review|reviewer|verifier|tester|qa|navigator|integrator|lead)/i.test(String(member.role || member.alias || "")))
					.map((member: any) => member.alias);
				targets.push(...(prioritized.length ? prioritized : (teamRecord.members || []).map((member: any) => member.alias)).slice(0, 3));
			} else if (entry.runId) {
				const { agentRecords } = resolveRunContextRecords(entry.runId);
				const prioritized = (agentRecords || [])
					.filter((agent: any) => /(review|reviewer|verifier|tester|qa|navigator|integrator|lead)/i.test(String(agent.role || agent.alias || "")))
					.map((agent: any) => agent.alias);
				targets.push(...(prioritized.length ? prioritized : (agentRecords || []).map((agent: any) => agent.alias)).slice(0, 3));
			}
			const aliases = uniqueStrings(targets).slice(0, 3);
			if (!aliases.length) throw new Error("no verification targets available");
			const verificationItems = [] as any[];
			for (const alias of aliases) {
				const record = resolveAgentRecord(alias);
				const message = [
					"Verification round requested by the cmux orchestrator repair executor.",
					"Reply with these exact sections: VERIFICATION STATUS, VERIFIED DELIVERABLES, OPEN RISKS, APPROVAL DECISION, NEXT STEP.",
					"Only approve if evidence supports completion. If evidence is missing, say so explicitly.",
				].join("\n\n");
				persistGuidanceSnapshot({ runId: record.runId || entry.runId || null, team: record.team || entry.team || null, aliases: [alias], kind: "repair_verification_round", message, status: "active" });
				await sendAgentMessage(pi, { alias }, message, { appendEnter: true, signal: options.signal, timeout });
				await sleep(900);
				const capture = await captureAgentScreen(pi, { alias }, { lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout }).catch(() => null);
				const digest = capture ? buildCaptureDigest(capture) : null;
				const result = classifyVerificationResult({ text: capture?.text || "", summary: digest?.summary || "", report: digest?.report || {}, role: record.role || null, requested: !capture });
				verificationItems.push({ alias, team: record.team || entry.team || null, runId: record.runId || entry.runId || null, capture, digest, result });
				if (digest) persistRepairDigestObservation(alias, digest, `verification ${result.status}`);
			}
			const verificationSummary = persistVerificationResults(verificationItems);
			return { note: `verification round requested from ${aliases.join(", ")}`, verificationSummary, verificationItems: verificationItems.map((item: any) => ({ alias: item.alias, team: item.team, runId: item.runId, result: item.result })) };
		},
	});
	persistRepairExecutionResults(execution.results);
	let repairEffectiveness = null as any;
	try {
		const refreshed = await collectOrchestratorDoctor(pi, options.signal, timeout);
		persistDoctorFindings(refreshed);
		const afterFindings = filterDoctorFindingsForScope(refreshed?.findings || [], scope);
		repairEffectiveness = {
			beforeFindings: beforeFindings.length,
			afterFindings: afterFindings.length,
			delta: afterFindings.length - beforeFindings.length,
			improved: afterFindings.length < beforeFindings.length,
		};
		if (options.runId) {
			upsertRunRecord({
				runId: options.runId,
				lastRepairEffectivenessAt: nowIso(),
				lastRepairEffectivenessSummary: `findings ${beforeFindings.length} -> ${afterFindings.length}`,
				repairEffectiveness,
			});
		}
	} catch {
		// ignore effectiveness measurement failures
	}
	return {
		planSummary: plan.summary,
		executionResults: execution.results,
		executionSummary: execution.summary,
		repairEffectiveness,
	};
}

function persistRunEvaluationArtifacts(runId: string) {
	const { runRecord, teamRecords, agentRecords, runEvents } = resolveRunContextRecords(runId);
	const scorecardReport = buildRunScorecardReport({ runRecord, teamRecords, agentRecords, runEvents });
	const scorecardMarkdown = renderRunScorecardReport(scorecardReport);
	const failureMarkdown = renderRunFailureReport(scorecardReport);
	const written = writeRunEvaluationArtifacts({
		baseDir: orchestratorDir(),
		runId,
		scorecard: scorecardReport,
		scorecardMarkdown,
		failureMarkdown,
	});
	const nextArtifactPaths = uniqueStrings([...(runRecord.artifactPaths || []), ...written.artifactPaths]);
	const updatedRun = upsertRunRecord({
		runId,
		artifactPaths: nextArtifactPaths,
		scorecardArtifacts: uniqueStrings([...(runRecord.scorecardArtifacts || []), written.scorecardJsonPath, written.scorecardMarkdownPath]),
		failureArtifacts: uniqueStrings([...(runRecord.failureArtifacts || []), written.failureMarkdownPath, written.roundAnalysisJsonPath]),
		scorecardSummary: {
			overallScore: scorecardReport.scorecard.overallScore,
			completionAccuracy: scorecardReport.scorecard.completionAccuracy,
			falseCompleteRate: scorecardReport.scorecard.falseCompleteRate,
			statusAlignment: scorecardReport.statusAlignment,
			evidenceStatus: scorecardReport.finalDecision.status,
			generatedAt: nowIso(),
		},
		failureSummary: {
			missingAgentOutput: scorecardReport.failures.missingAgentOutput.length,
			staleBridgeSessions: scorecardReport.failures.staleBridgeSessions.length,
			partialTeamDeath: scorecardReport.failures.partialTeamDeath.length,
			misleadingDoneReports: scorecardReport.failures.misleadingDoneReports.length,
			dependencyDeadlocks: scorecardReport.failures.dependencyDeadlocks.length,
			generatedAt: nowIso(),
		},
	});
	appendRunEvent(runId, {
		type: "run_scorecard_generated",
		status: updatedRun.status || scorecardReport.finalDecision.status,
		detail: `score=${scorecardReport.scorecard.overallScore} alignment=${scorecardReport.statusAlignment ? "yes" : "no"}`,
		source: "orchestrator",
	});
	return { runRecord: updatedRun, teamRecords, agentRecords, runEvents, scorecardReport, scorecardMarkdown, failureMarkdown, written };
}

function formatDigestFieldList(digests: any[], field: string, limit = 10) {
	const values = uniqueStrings((digests || []).flatMap((digest: any) => {
		const value = digest?.[field];
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	}));
	if (!values.length) return "- None reported.";
	return values.slice(0, limit).map((value: string) => `- ${value}`).join("\n");
}

function formatTeamLeadHeartbeats(heartbeats: any[], limit = 10) {
	const items = (heartbeats || []).filter((item: any) => item?.digest).slice(0, limit);
	if (!items.length) return "- No team lead reports captured yet.";
	return items
		.map((item: any) => `- [${item.team}] ${item.target?.alias || item.digest.alias} (${item.target?.role || item.digest.role || "lead"}): ${item.digest.summary || "No summary."}`)
		.join("\n");
}

async function requestTeamLeadHeartbeats(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	digests: any[],
	options: { round?: number; appendEnter?: boolean; delayMs?: number; signal?: AbortSignal; timeout?: number } = {},
) {
	const results = [] as any[];
	for (const teamRecord of teamRecords || []) {
		const target = primaryTeamLead(teamRecord);
		if (!target) continue;
		const teamDigests = (digests || []).filter((digest: any) => digest.team === teamRecord.team);
		const otherDigests = (digests || []).filter((digest: any) => digest.team !== teamRecord.team);
		const message = [
			`Team lead heartbeat request for round ${options.round}.`,
			`Team: ${teamRecord.team}`,
			`Task: ${task}`,
			"You are reporting back to the orchestrator as the key agent for this team.",
			"Reply with these exact sections: TEAM STATUS, KEY CHANGES, BLOCKERS, DELIVERABLES, REMAINING WORK, REQUESTS TO SWARM, NEXT TEAM ACTION.",
			"Only mark TEAM STATUS as COMPLETE when your team's assigned work is truly complete and REMAINING WORK is none.",
			"Your team's current updates:",
			formatCaptureDigests(teamDigests, 12),
			"Relevant other-team context:",
			otherDigests.length ? formatCaptureDigests(otherDigests, 8) : "- No other-team updates.",
			"Known blockers:",
			formatBlockedDigests([...teamDigests, ...otherDigests], 10),
		].join("\n\n");
		persistGuidanceSnapshot({
			runId: teamRecord.runId,
			team: teamRecord.team,
			aliases: [target.alias],
			kind: "team_lead_heartbeat_request",
			message,
			round: options.round,
			status: "active",
		});
		const sent = await sendAgentMessage(
			pi,
			{ alias: target.alias, workspace: target.workspace, surface: target.surface },
			message,
			{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
		);
		await sleep(options.delayMs ?? 1200);
		const capture = await captureAgentScreen(
			pi,
			{ alias: target.alias, workspace: target.workspace, surface: target.surface },
			{ lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout: options.timeout },
		);
		const digest = buildCaptureDigest({ ...capture, team: teamRecord.team, role: target.role || "lead" });
		const currentTeam = resolveTeamRecord(teamRecord.team);
		const requestsToSwarm = digest.report?.requests_to_swarm || digest.report?.requests || null;
		const nextTeamAction = digest.report?.next_team_action || digest.report?.next || null;
		const handoffMemory = [
			digest.summary ? `Summary: ${digest.summary}` : "",
			requestsToSwarm ? `Requests to swarm: ${requestsToSwarm}` : "",
			nextTeamAction ? `Next team action: ${nextTeamAction}` : "",
		].filter(Boolean).join("\n");
		const heartbeatLog = [...(Array.isArray(currentTeam.leadHeartbeatLog) ? currentTeam.leadHeartbeatLog : []), {
			timestamp: nowIso(),
			round: options.round,
			alias: target.alias,
			summary: digest.summary,
			status: digest.status,
			requestsToSwarm,
			nextTeamAction,
			blockers: digest.blockers || [],
		}].slice(-10);
		upsertTeamRecord({
			...currentTeam,
			lastLeadHeartbeatAt: nowIso(),
			lastLeadAlias: target.alias,
			lastLeadSummary: digest.summary,
			lastLeadStatus: digest.status,
			lastRequestsToSwarm: requestsToSwarm,
			lastTeamAction: nextTeamAction,
			lastHandoffSummary: handoffMemory || currentTeam.lastHandoffSummary || null,
			leadHeartbeatLog: heartbeatLog,
		});
		appendRunEvent(currentTeam.runId || teamRecord.runId, {
			type: "team_lead_heartbeat",
			team: teamRecord.team,
			alias: target.alias,
			status: digest.status,
			detail: [digest.summary, requestsToSwarm ? `requests=${requestsToSwarm}` : "", nextTeamAction ? `next=${nextTeamAction}` : ""].filter(Boolean).join(" | "),
			source: "team_lead",
		});
		persistCommunicationSnapshot({
			runId: currentTeam.runId || teamRecord.runId || null,
			team: teamRecord.team,
			alias: target.alias,
			direction: "inbound",
			kind: "team_lead_report",
			summary: [digest.summary, requestsToSwarm ? `requests=${requestsToSwarm}` : "", nextTeamAction ? `next=${nextTeamAction}` : ""].filter(Boolean).join(" | "),
			round: options.round,
			status: digest.status,
			payload: { requestsToSwarm, nextTeamAction, blockers: digest.blockers || [], deliverable: digest.deliverable || null },
		});
		results.push({ team: teamRecord.team, target, sent, capture, digest });
	}
	return results;
}

async function requestRoundCoordinatorHeartbeat(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	digests: any[],
	options: { round?: number; leadHeartbeats?: any[]; appendEnter?: boolean; delayMs?: number; signal?: AbortSignal; timeout?: number } = {},
) {
	const target = primarySwarmLead(teamRecords);
	if (!target) return null;
	const message = [
		`Coordinator heartbeat request for round ${options.round}.`,
		`Task: ${task}`,
		"You are the swarm lead reporting back to the primary orchestrator terminal.",
		"Write a concise progress report with these exact sections: OVERALL STATUS, TEAM SUMMARIES, BLOCKERS, CHANGES/AREAS TO REVIEW, COMMANDS RUN, DELIVERABLES, REMAINING WORK, NEXT ORCHESTRATOR ACTION.",
		"Only set OVERALL STATUS to COMPLETE when the swarm is truly done and REMAINING WORK is none.",
		options.leadHeartbeats?.length ? "Per-team lead reports:" : "",
		options.leadHeartbeats?.length ? formatTeamLeadHeartbeats(options.leadHeartbeats, 12) : "",
		"Current swarm digests:",
		formatCaptureDigests(digests, 24),
		"Known blockers:",
		formatBlockedDigests(digests, 12),
	].filter(Boolean).join("\n\n");
	persistGuidanceSnapshot({
		runId: target.runId || teamRecords[0]?.runId || null,
		team: target.team || null,
		aliases: [target.alias],
		kind: "coordinator_heartbeat_request",
		message,
		round: options.round,
		status: "active",
	});
	const sent = await sendAgentMessage(
		pi,
		{ alias: target.alias, workspace: target.workspace, surface: target.surface },
		message,
		{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
	);
	await sleep(options.delayMs ?? 1500);
	const capture = await captureAgentScreen(
		pi,
		{ alias: target.alias, workspace: target.workspace, surface: target.surface },
		{ lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout: options.timeout },
	);
	const digest = buildCaptureDigest({ ...capture, team: target.team || null, role: target.role || "lead" });
	try {
		const leadRecord = resolveAgentRecord(target.alias);
		const runId = leadRecord.runId || target.runId;
		appendRunEvent(runId, {
			type: "coordinator_heartbeat",
			team: target.team || null,
			alias: target.alias,
			status: digest.status,
			detail: digest.summary,
			source: "swarm_lead",
		});
		if (runId) {
			upsertRunRecord({
				runId,
				lastCoordinatorSummary: digest.summary,
				lastCoordinatorAction: digest.nextOrchestratorAction || digest.next || null,
				lastCoordinatorRequests: digest.requestsToSwarm || digest.needs || null,
				lastCoordinatorHeartbeatAt: nowIso(),
			});
			persistCommunicationSnapshot({
				runId,
				team: target.team || null,
				alias: target.alias,
				direction: "inbound",
				kind: "coordinator_report",
				summary: digest.summary,
				round: options.round,
				status: digest.status,
				payload: {
					nextOrchestratorAction: digest.nextOrchestratorAction || digest.next || null,
					requestsToSwarm: digest.requestsToSwarm || digest.needs || null,
					blockers: digest.blockers || [],
					deliverable: digest.deliverable || null,
				},
			});
		}
	} catch {
		// ignore missing registry state
	}
	return { target, sent, capture, digest };
}

async function gatherSwarmCaptures(
	pi: ExtensionAPI,
	teamRecords: any[],
	options: { lines?: number; scrollback?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const grouped = await Promise.all((teamRecords || []).map((teamRecord) => gatherTeamCaptures(pi, teamRecord, options)));
	return grouped.flat();
}

async function relaySwarmRound(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	captures: any[],
	options: { round?: number; extraGuidance?: string; teamLeadHeartbeats?: any[]; appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const digests = (captures || []).map(buildCaptureDigest);
	const sendSpecs = (teamRecords || []).flatMap((teamRecord: any) => {
		const roster = buildTeamRoster(teamRecord);
		return (teamRecord.members || []).map((member: any) => {
			const sameTeam = digests.filter((digest: any) => digest.team === teamRecord.team && digest.alias !== member.alias);
			const otherTeams = digests.filter((digest: any) => digest.team !== teamRecord.team);
			const blockers = blockedDigests([...sameTeam, ...otherTeams]);
			const leadReports = (options.teamLeadHeartbeats || []).filter((item: any) => item.team !== teamRecord.team);
			const latestTeamRecord = resolveTeamRecord(teamRecord.team);
			const memberIsLead = isLeadershipRole(member.role || member.alias);
			const directRequests = formatRelevantDependencyRequests(teamRecord, member, otherTeams, 4);
			const teamMemory = [
				latestTeamRecord?.lastLeadSummary ? `Lead summary: ${latestTeamRecord.lastLeadSummary}` : "",
				latestTeamRecord?.lastRequestsToSwarm ? `Requests to swarm: ${latestTeamRecord.lastRequestsToSwarm}` : "",
				latestTeamRecord?.lastTeamAction ? `Next team action: ${latestTeamRecord.lastTeamAction}` : "",
			].filter(Boolean).join("\n");
			const swarmSummary = [
				sameTeam.length ? `Updates from your team:\n${formatCaptureDigests(sameTeam, 6)}` : "",
				memberIsLead && leadReports.length ? `Team lead reports from other teams:\n${formatTeamLeadHeartbeats(leadReports, 8)}` : "",
				memberIsLead && otherTeams.length ? `Detailed updates from other teams:\n${formatCaptureDigests(otherTeams, 6)}` : "",
				!memberIsLead && blockers.length ? `Cross-team blockers you should stay aware of:\n${formatBlockedDigests(blockers, 4)}` : "",
				memberIsLead
					? "Leadership note: absorb cross-team context, resolve dependencies, and relay only the essential next actions to your team."
					: "Leadership note: your team lead is receiving broader cross-team context; focus on your assigned work and surface blockers immediately.",
			].filter(Boolean).join("\n\n");
			return {
				member: { ...member, team: teamRecord.team, runId: teamRecord.runId || null },
				message: buildRelayRoundPrompt(teamRecord, member, task, {
					round: options.round,
					extraGuidance: options.extraGuidance,
					swarmSummary: swarmSummary || "No peer updates were captured this round. Continue and report only material changes.",
					teamMemory,
					directRequests,
				}),
			};
		});
	});
	for (const spec of sendSpecs) {
		persistGuidanceSnapshot({
			runId: teamRecords.find((teamRecord: any) => teamRecord.team === spec.member.team)?.runId || null,
			team: spec.member.team || null,
			aliases: [spec.member.alias],
			kind: "round_relay",
			message: spec.message,
			round: options.round || null,
			status: "active",
		});
	}
	const results = await Promise.allSettled(
		sendSpecs.map((spec: any) =>
			sendAgentMessage(
				pi,
				{ alias: spec.member.alias, workspace: spec.member.workspace, surface: spec.member.surface },
				spec.message,
				{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
			),
		),
	);
	const sent = results.map((result, index) => result.status === "fulfilled"
		? result.value
		: {
			alias: sendSpecs[index]?.member?.alias || null,
			error: true,
			message: String((result as PromiseRejectedResult).reason?.message || (result as PromiseRejectedResult).reason || "relay failed"),
		});
	return { sent, digests };
}

async function escalateBlockedAgents(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	digests: any[],
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const blocked = blockedDigests(digests);
	if (!blocked.length) return { blocked, sent: [] };
	const sendSpecs: any[] = [];
	for (const teamRecord of teamRecords || []) {
		const teamBlocked = blocked.filter((digest: any) => digest.team === teamRecord.team);
		if (!teamBlocked.length) continue;
		for (const lead of teamLeadMembers(teamRecord, 2)) {
			sendSpecs.push({
				lead,
				message: [
					`Escalation for team ${teamRecord.team}.`,
					`Task: ${task}`,
					"The following agents appear blocked or are signaling dependencies:",
					formatBlockedDigests(teamBlocked, 6),
					"Please coordinate an unblock plan immediately. Reply with the most important next actions, re-delegations, and any cross-team requests.",
				].join("\n\n"),
			});
		}
	}
	const swarmLead = primarySwarmLead(teamRecords);
	if (swarmLead && (teamRecords || []).length > 1) {
		sendSpecs.push({
			lead: swarmLead,
			message: [
				"Cross-team escalation summary.",
				`Task: ${task}`,
				"Blocked agents detected across the swarm:",
				formatBlockedDigests(blocked, 12),
				"Please decide whether to rebalance work between teams or issue a swarm-wide unblock instruction.",
			].join("\n\n"),
		});
	}
	for (const spec of sendSpecs) {
		persistGuidanceSnapshot({
			runId: spec.lead.runId || teamRecords.find((teamRecord: any) => teamRecord.team === spec.lead.team)?.runId || null,
			team: spec.lead.team || null,
			aliases: [spec.lead.alias],
			kind: "blocker_escalation",
			message: spec.message,
			status: blocked.length ? "blocked" : "active",
		});
	}
	const results = await Promise.allSettled(
		sendSpecs.map((spec) => sendAgentMessage(
			pi,
			{ alias: spec.lead.alias, workspace: spec.lead.workspace, surface: spec.lead.surface },
			spec.message,
			{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
		)),
	);
	const sent = results.map((result, index) => result.status === "fulfilled"
		? result.value
		: {
			alias: sendSpecs[index]?.lead?.alias || null,
			error: true,
			message: String((result as PromiseRejectedResult).reason?.message || (result as PromiseRejectedResult).reason || "escalation failed"),
		});
	return { blocked, sent };
}

async function requestFinalSwarmSynthesis(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	captures: any[],
	options: { synthesisAlias?: string; appendEnter?: boolean; delayMs?: number; signal?: AbortSignal; timeout?: number } = {},
) {
	const digests = (captures || []).map(buildCaptureDigest);
	const target = options.synthesisAlias
		? resolveAgentRecord(options.synthesisAlias)
		: primarySwarmLead(teamRecords);
	if (!target) return null;
	const latestTeamLeadSummaries = (teamRecords || []).map((teamRecord: any) => {
		try {
			const current = resolveTeamRecord(teamRecord.team);
			return current.lastLeadSummary ? `[${teamRecord.team}] ${current.lastLeadSummary}` : null;
		} catch {
			return teamRecord.lastLeadSummary ? `[${teamRecord.team}] ${teamRecord.lastLeadSummary}` : null;
		}
	}).filter((item): item is string => Boolean(item));
	const message = [
		"Produce the final swarm synthesis report.",
		`Task: ${task}`,
		"Use every captured agent update, team lead report, open dependency, and blocker below to write one concise lead report for the primary orchestrator/user.",
		"Include these sections: OVERALL STATUS, TEAM SUMMARIES, KEY FINDINGS, CHANGES/AREAS TO REVIEW, OPEN RISKS/BLOCKERS, REMAINING WORK, and RECOMMENDED NEXT STEPS.",
		"Set OVERALL STATUS explicitly to COMPLETE, INCOMPLETE, or BLOCKED. Only say COMPLETE when the work is actually complete, all teams have reported, REMAINING WORK is none, and no significant blockers remain.",
		latestTeamLeadSummaries.length ? "Latest team lead reports:" : "",
		latestTeamLeadSummaries.length ? latestTeamLeadSummaries.map((item: string) => `- ${item}`).join("\n") : "",
		"Swarm updates:",
		formatCaptureDigests(digests, 24),
		"Known blockers:",
		formatBlockedDigests(digests, 12),
		"Open dependencies:",
		formatDependencyDigests(digests, 12),
	].filter(Boolean).join("\n\n");
	persistCommunicationSnapshot({
		runId: target.runId || teamRecords[0]?.runId || null,
		team: target.team || null,
		alias: target.alias,
		direction: "outbound",
		kind: "final_synthesis_request",
		message,
		status: "active",
		inbox: false,
	});
	const sent = await sendAgentMessage(
		pi,
		{ alias: target.alias, workspace: target.workspace, surface: target.surface },
		message,
		{ appendEnter: options.appendEnter !== false, signal: options.signal, timeout: options.timeout },
	);
	await sleep(options.delayMs ?? DEFAULT_SYNTHESIS_DELAY_MS);
	const capture = await captureAgentScreen(
		pi,
		{ alias: target.alias, workspace: target.workspace, surface: target.surface },
		{ lines: DEFAULT_TEAM_CAPTURE_LINES, scrollback: true, signal: options.signal, timeout: options.timeout },
	);
	const synthesisDigest = buildCaptureDigest({ ...capture, team: target.team || null, role: target.role || "lead" });
	persistCommunicationSnapshot({
		runId: target.runId || teamRecords[0]?.runId || null,
		team: target.team || null,
		alias: target.alias,
		direction: "inbound",
		kind: "final_synthesis_report",
		message: capture.text,
		summary: synthesisDigest.summary,
		status: synthesisDigest.status,
		payload: {
			overallStatus: synthesisDigest.report?.overall_status || synthesisDigest.report?.status || null,
			nextOrchestratorAction: synthesisDigest.nextOrchestratorAction || synthesisDigest.next || null,
			blockers: synthesisDigest.blockers || [],
			deliverable: synthesisDigest.deliverable || null,
		},
	});
	return { target, sent, capture, digests, digest: synthesisDigest };
}

async function requestOperatorReportSnapshot(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	options: { mode?: string; appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const captures = await gatherSwarmCaptures(pi, teamRecords, {
		lines: DEFAULT_TEAM_CAPTURE_LINES,
		scrollback: true,
		signal: options.signal,
		timeout: options.timeout,
	});
	const digests = captures.map(buildCaptureDigest);
	const teamLeadHeartbeats = await requestTeamLeadHeartbeats(pi, teamRecords, task, digests, {
		round: 0,
		appendEnter: options.appendEnter !== false,
		delayMs: 1000,
		signal: options.signal,
		timeout: options.timeout,
	});
	const coordinatorHeartbeat = await requestRoundCoordinatorHeartbeat(pi, teamRecords, task, digests, {
		round: 0,
		leadHeartbeats: teamLeadHeartbeats,
		appendEnter: options.appendEnter !== false,
		delayMs: 1400,
		signal: options.signal,
		timeout: options.timeout,
	});
	const decision = deriveRunStatus(digests, { coordinatorText: coordinatorHeartbeat?.capture?.text || null });
	const mode = String(options.mode || "progress").toLowerCase();
	if (mode === "blockers") {
		return {
			captures,
			digests,
			teamLeadHeartbeats,
			coordinatorHeartbeat,
			decision,
			text: [
				"## Blocker report",
				formatBlockedDigests(digests, 24),
				"",
				"## Team lead reports",
				formatTeamLeadHeartbeats(teamLeadHeartbeats, 12),
			].join("\n"),
		};
	}
	if (mode === "synthesis") {
		const synthesis = await requestFinalSwarmSynthesis(pi, teamRecords, task, captures, {
			appendEnter: options.appendEnter !== false,
			delayMs: DEFAULT_SYNTHESIS_DELAY_MS,
			signal: options.signal,
			timeout: options.timeout,
		});
		return {
			captures,
			digests,
			teamLeadHeartbeats,
			coordinatorHeartbeat,
			decision,
			synthesis,
			text: [
				"## Synthesis report",
				synthesis?.capture?.text || "No synthesis captured.",
			].join("\n"),
		};
	}
	return {
		captures,
		digests,
		teamLeadHeartbeats,
		coordinatorHeartbeat,
		decision,
		text: buildRoundProgressText({
			round: 0,
			totalPlannedRounds: 0,
			totalAllowedRounds: 0,
			digests,
			roundDecision: decision,
			teamLeadHeartbeats,
			coordinatorHeartbeat,
			rebalances: [],
			escalations: [],
			relays: [],
		}),
	};
}

async function pauseTeamExecution(
	pi: ExtensionAPI,
	teamRecords: any[],
	message: string,
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number } = {},
) {
	const sent = [] as any[];
	for (const teamRecord of teamRecords || []) {
		sent.push(...(await sendTeamControlMessage(pi, teamRecord, message, {
			scope: "all",
			appendEnter: options.appendEnter !== false,
			signal: options.signal,
			timeout: options.timeout,
		})));
		upsertTeamRecord({ ...teamRecord, status: "paused", lastHeartbeatAt: nowIso() });
		appendRunEvent(teamRecord.runId, { type: "team_paused", team: teamRecord.team, detail: summarize(message, 180) });
	}
	return sent;
}

async function orchestrateTeamSwarm(
	pi: ExtensionAPI,
	teamRecords: any[],
	task: string,
	options: {
		runId?: string;
		operatorTarget?: { workspace?: string | null; surface?: string | null; sessionId?: string | null } | null;
		extraGuidance?: string;
		appendEnter?: boolean;
		delayMs?: number;
		checkInIntervalMs?: number;
		lines?: number;
		scrollback?: boolean;
		rounds?: number;
		continueUntilComplete?: boolean;
		maxRounds?: number;
		shareFindings?: boolean;
		escalateBlockers?: boolean;
		finalSynthesis?: boolean;
		synthesisAlias?: string;
		synthesisDelayMs?: number;
		onProgress?: (payload: { stage: string; text: string; details?: Record<string, unknown> }) => void | Promise<void>;
		signal?: AbortSignal;
		timeout?: number;
	} = {},
) {
	const sent: any[] = [];
	const plannedRounds = clamp(positiveInteger(options.rounds) || DEFAULT_SWARM_ROUNDS, 1, 8);
	const totalAllowedRounds = clamp(
		Math.max(plannedRounds, positiveInteger(options.maxRounds) || (options.continueUntilComplete === false ? plannedRounds : DEFAULT_MAX_ORCHESTRATION_ROUNDS)),
		plannedRounds,
		12,
	);
	if (options.runId) {
		upsertRunRecord({
			runId: options.runId,
			teamNames: (teamRecords || []).map((teamRecord: any) => teamRecord.team),
			task,
			status: "active",
			orchestrationInProgress: true,
			roundsPlanned: plannedRounds,
			roundsAllowed: totalAllowedRounds,
			roundsCompleted: 0,
		});
		appendRunEvent(options.runId, { type: "orchestration_started", detail: task });
	}
	await options.onProgress?.({
		stage: "start",
		text: buildMissionControlProgressText(options.runId, teamRecords, `# Swarm orchestration started${options.runId ? ` (${options.runId})` : ""}`, [
			`- planned rounds: ${plannedRounds}`,
			`- max rounds: ${totalAllowedRounds}`,
			`- operator workspace: ${options.operatorTarget?.workspace || "—"}`,
			`- task: ${summarize(task, 240)}`,
		]),
		details: { runId: options.runId, plannedRounds, totalAllowedRounds, operatorTarget: options.operatorTarget },
	});
	const readiness = await waitForTeamAgentsReady(teamRecords, {
		timeoutMs: Math.min(options.timeout ?? DEFAULT_TIMEOUT, 12_000),
		pollMs: 500,
	});
	if (options.runId) {
		appendRunEvent(options.runId, {
			type: "agents_ready_check",
			status: readiness.completed ? "ready" : "partial",
			detail: `ready=${readiness.readyAliases.length}/${readiness.total} waitedMs=${readiness.waitedMs}`,
		});
	}
	await options.onProgress?.({
		stage: "readiness",
		text: buildMissionControlProgressText(options.runId, teamRecords, "## Agent readiness", [
			`- ready: ${readiness.readyAliases.length}/${readiness.total}`,
			`- waited ms: ${readiness.waitedMs}`,
			`- status: ${readiness.completed ? "ready" : "partial"}`,
		]),
		details: { readiness },
	});
	if (!readiness.completed) {
		const ready = new Set(readiness.readyAliases || []);
		const unreadyAliases = uniqueStrings((teamRecords || []).flatMap((teamRecord: any) => (teamRecord.members || [])
			.map((member: any) => member.alias)
			.filter((alias: string) => !ready.has(alias))));
		for (const alias of unreadyAliases) {
			try {
				const current = resolveAgentRecord(alias);
				upsertAgentRecord({
					...current,
					status: "launch_failed",
					live: true,
					lastHeartbeatAt: nowIso(),
					lastSummary: "Pi did not become ready before dispatch; task instructions were not sent to this shell.",
				});
			} catch {
				// ignore missing agent state
			}
		}
		for (const teamRecord of teamRecords || []) {
			try {
				const currentTeam = resolveTeamRecord(teamRecord.team);
				upsertTeamRecord({
					...currentTeam,
					status: "launch_failed",
					lastHeartbeatAt: nowIso(),
					lastObservationStatus: "launch_failed",
					lastObservationSummary: `Pi launch readiness failed for ${unreadyAliases.filter((alias: string) => (currentTeam.members || []).some((member: any) => member.alias === alias)).join(", ") || "one or more agents"}; dispatch withheld.`,
				});
			} catch {
				// ignore missing team state
			}
		}
		if (options.runId) {
			upsertRunRecord({
				runId: options.runId,
				status: "blocked",
				lastHeartbeatAt: nowIso(),
				lastProgressSummary: `Agent launch readiness failed: ${unreadyAliases.join(", ") || "unknown agents"}. Task dispatch was withheld to avoid sending prompts into a raw shell.`,
			});
			appendRunEvent(options.runId, {
				type: "agent_readiness_failed",
				status: "blocked",
				detail: `unready=${unreadyAliases.join(",") || "unknown"}`,
				source: "orchestrator",
			});
			persistMissionControlSnapshot(options.runId, teamRecords);
		}
		throw new Error(`CMUX Pi launch readiness failed for ${unreadyAliases.join(", ") || "one or more agents"}; task dispatch was withheld so instructions are not typed into zsh. Relaunch or repair the team after checking the launch command/provider/session path.`);
	}
	for (const alias of readiness.readyAliases || []) {
		try {
			const current = resolveAgentRecord(alias);
			upsertAgentRecord({ ...current, status: "ready", live: true, lastHeartbeatAt: nowIso() });
		} catch {
			// ignore missing agent state
		}
	}
	for (const teamRecord of teamRecords || []) {
		appendRunEvent(options.runId || teamRecord.runId, { type: "task_dispatched", team: teamRecord.team, detail: summarize(task, 240) });
		sent.push(
			...(await dispatchTeamTask(pi, teamRecord, task, {
				extraGuidance: options.extraGuidance,
				appendEnter: options.appendEnter !== false,
				signal: options.signal,
				timeout: options.timeout,
			})),
		);
	}

	await options.onProgress?.({
		stage: "dispatch",
		text: buildMissionControlProgressText(options.runId, teamRecords, "## Task dispatch", sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 140)}`)),
		details: { sent },
	});
	const roundResults: any[] = [];
	let latestCaptures: any[] = [];

	for (let round = 1; round <= totalAllowedRounds; round++) {
		const waitMs = round === 1
			? options.delayMs ?? DEFAULT_SWARM_DELAY_MS
			: options.checkInIntervalMs ?? options.delayMs ?? DEFAULT_SWARM_DELAY_MS;
		await sleep(waitMs);
		latestCaptures = await gatherSwarmCaptures(pi, teamRecords, {
			lines: options.lines ?? DEFAULT_TEAM_CAPTURE_LINES,
			scrollback: options.scrollback !== false,
			signal: options.signal,
			timeout: options.timeout,
		});
		const digests = latestCaptures.map(buildCaptureDigest);
		updateAgentAndTeamStateFromDigests(teamRecords, digests);
		// Ingest bridge browser/pattern events into orchestrator agent records
		for (const teamRecord of teamRecords || []) {
			const runId = teamRecord.runId || options.runId;
			if (!runId) continue;
			const { agents: bridgeAgents } = ingestBridgeEventsIntoOrchestrator(runId);
			for (const member of teamRecord.members || []) {
				const bridgeState = bridgeAgents.get(member.alias);
				if (bridgeState) {
					const current = resolveAgentRecord(member.alias);
					upsertAgentRecord(applyBridgeStateToAgentRecord(current, bridgeState));
				}
			}
		}
		let relays: any[] = [];
		let escalations: any[] = [];
		let rebalances: any[] = [];
		let blocked: any[] = blockedDigests(digests);
		if (options.escalateBlockers !== false && blocked.length) {
			const escalationResult = await escalateBlockedAgents(pi, teamRecords, task, digests, {
				appendEnter: options.appendEnter !== false,
				signal: options.signal,
				timeout: options.timeout,
			});
			escalations = escalationResult.sent;
			if (options.runId && escalationResult.sent?.length) {
				appendRunEvent(options.runId, {
					type: "blocker_escalation",
					status: blocked.length ? "blocked" : "active",
					detail: `round=${round} blocked=${blocked.map((item: any) => item.alias).join(",")}`,
					source: "orchestrator",
				});
			}
		}
		for (const teamRecord of teamRecords || []) {
			const teamDigests = digests.filter((digest: any) => digest.team === teamRecord.team);
			const rebalanceResult = await rebalanceTeamWithDigests(pi, teamRecord, task, teamDigests, {
				appendEnter: options.appendEnter !== false,
				signal: options.signal,
				timeout: options.timeout,
				force: false,
				source: "auto",
				round,
			});
			if (!rebalanceResult.skipped) {
				rebalances.push(rebalanceResult);
				if (options.runId) {
					appendRunEvent(options.runId, {
						type: "team_rebalanced",
						team: teamRecord.team,
						status: rebalanceResult.blocked?.length ? "blocked" : "active",
						detail: `round=${round} sent=${rebalanceResult.sent?.length || 0} blocked=${(rebalanceResult.blocked || []).map((item: any) => item.alias).join(",") || "none"}`,
						source: "orchestrator",
					});
				}
			}
		}
		const teamLeadHeartbeats = await requestTeamLeadHeartbeats(pi, teamRecords, task, digests, {
			round,
			appendEnter: options.appendEnter !== false,
			delayMs: Math.min(options.checkInIntervalMs ?? options.delayMs ?? DEFAULT_SWARM_DELAY_MS, 1200),
			signal: options.signal,
			timeout: options.timeout,
		});
		if (options.shareFindings !== false && round < totalAllowedRounds) {
			const relayResult = await relaySwarmRound(pi, teamRecords, task, latestCaptures, {
				round: round + 1,
				extraGuidance: options.extraGuidance,
				teamLeadHeartbeats,
				appendEnter: options.appendEnter !== false,
				signal: options.signal,
				timeout: options.timeout,
			});
			relays = relayResult.sent;
			if (options.runId && relayResult.sent?.length) {
				appendRunEvent(options.runId, {
					type: "cross_team_relay",
					status: "active",
					detail: `round=${round} messages=${relayResult.sent.length}`,
					source: "orchestrator",
				});
			}
		}
		const coordinatorHeartbeat = await requestRoundCoordinatorHeartbeat(pi, teamRecords, task, digests, {
			round,
			leadHeartbeats: teamLeadHeartbeats,
			appendEnter: options.appendEnter !== false,
			delayMs: Math.min(options.checkInIntervalMs ?? options.delayMs ?? DEFAULT_SWARM_DELAY_MS, 1800),
			signal: options.signal,
			timeout: options.timeout,
		});
		const baseRoundDecision = deriveRunStatus(digests, {
			coordinatorText: coordinatorHeartbeat?.capture?.text || null,
		});
		const roundGate = options.runId ? evaluateRunCompletionGate(options.runId, digests).evaluation : null;
		const roundDecision = roundGate ? enforceCompletionGateDecision(baseRoundDecision, roundGate) : baseRoundDecision;
		persistObservationSnapshots({
			runId: options.runId || teamRecords[0]?.runId || null,
			teamRecords,
			digests,
			round,
			coordinatorHeartbeat,
			teamLeadHeartbeats,
			roundDecision,
		});
		roundResults.push({ round, captures: latestCaptures, digests, blocked, relays, escalations, rebalances, teamLeadHeartbeats, coordinatorHeartbeat, roundDecision });
		const roundProgressText = buildRoundProgressText({
			runId: options.runId,
			round,
			totalPlannedRounds: plannedRounds,
			totalAllowedRounds,
			digests,
			roundDecision,
			teamLeadHeartbeats,
			coordinatorHeartbeat,
			rebalances,
			escalations,
			relays,
		});
		if (options.runId) {
			upsertRunRecord({
				runId: options.runId,
				status: roundDecision.status,
				roundsCompleted: round,
				artifactPaths: roundDecision.artifactPaths,
				urls: roundDecision.urls,
				commands: roundDecision.commands,
				completionCount: roundDecision.completionCount,
				completionGateSatisfied: roundDecision.completionGateSatisfied ?? null,
				completionGateSummary: roundDecision.completionGate ? summarizeCompletionGate(roundDecision.completionGate) : null,
				completionGateDetails: roundDecision.completionGate || null,
				lastHeartbeatAt: nowIso(),
			});
			appendRunEvent(options.runId, {
				type: "round_completed",
				status: roundDecision.status,
				detail: `round=${round} blockers=${roundDecision.blockedCount} stalled=${roundDecision.stalledCount} complete=${roundDecision.completionCount}${roundDecision.completionGate ? ` gate=${roundDecision.completionGateSatisfied ? "pass" : "hold"}` : ""}`,
			});
			persistRunProgressSnapshot(options.runId, {
				timestamp: nowIso(),
				round,
				status: roundDecision.status,
				summary: summarize(roundProgressText, 800),
				completionGateSatisfied: roundDecision.completionGateSatisfied ?? null,
				completionGateSummary: roundDecision.completionGate ? summarizeCompletionGate(roundDecision.completionGate) : null,
				coordinatorSummary: coordinatorHeartbeat?.digest?.summary || null,
				coordinatorStatus: coordinatorHeartbeat?.digest?.status || null,
				coordinatorCompletionSignal: Boolean(coordinatorHeartbeat?.digest?.status === "done" || /complete|completed|done/i.test(String(coordinatorHeartbeat?.capture?.text || ""))),
				coordinatorRequests: coordinatorHeartbeat?.digest?.requestsToSwarm || coordinatorHeartbeat?.digest?.needs || null,
				coordinatorNextAction: coordinatorHeartbeat?.digest?.nextOrchestratorAction || coordinatorHeartbeat?.digest?.next || null,
				teamLeadSummaries: teamLeadHeartbeats.map((item: any) => `[${item.team}] ${item.digest?.summary || item.capture?.text || "No summary."}`),
				blockedCount: roundDecision.blockedCount,
				stalledCount: roundDecision.stalledCount,
				completionCount: roundDecision.completionCount,
				relayMessages: relays.length,
				escalations: escalations.length,
				rebalances: rebalances.reduce((sum: number, item: any) => sum + (item.sent?.length || 0), 0),
				openDependencyCount: uniqueStrings((digests || []).flatMap((digest: any) => (digest?.dependencies || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved").map((dependency: any) => `${digest.alias}:${dependency.targetHint || dependency.text || "dependency"}`))).length,
				observedAliases: digests.map((digest: any) => digest.alias),
			}, teamRecords);
			if (roundDecision.blockedCount || roundDecision.stalledCount) {
				await notifyOrchestratorEvent(pi, "cmux swarm needs attention", {
					subtitle: `run ${options.runId}`,
					body: `round ${round}: blockers=${roundDecision.blockedCount} stalled=${roundDecision.stalledCount} rebalances=${rebalances.length}`,
					workspace: options.operatorTarget?.workspace || teamRecords[0]?.workspace || null,
					surface: options.operatorTarget?.surface || null,
					signal: options.signal,
					timeout: options.timeout,
				});
			}
		}
		await options.onProgress?.({
			stage: "round",
			text: buildMissionControlProgressText(options.runId, teamRecords, `## Round ${round} mission control`, [roundProgressText]),
			details: { round, roundDecision, digests, rebalances, escalations, relays },
		});
		const reachedMinimumRounds = round >= plannedRounds;
		const shouldStop = reachedMinimumRounds && (options.continueUntilComplete === false ? true : roundDecision.completed);
		if (shouldStop) break;
	}

	const synthesis = options.finalSynthesis === false
		? null
		: await requestFinalSwarmSynthesis(pi, teamRecords, task, latestCaptures, {
			synthesisAlias: options.synthesisAlias,
			appendEnter: options.appendEnter !== false,
			delayMs: options.synthesisDelayMs ?? DEFAULT_SYNTHESIS_DELAY_MS,
			signal: options.signal,
			timeout: options.timeout,
		});
	if (!synthesis && roundResults.length >= totalAllowedRounds && !(roundResults[roundResults.length - 1]?.roundDecision?.completed)) {
		await options.onProgress?.({
			stage: "limit_reached",
			text: [
				"## Orchestration limit reached",
				`- rounds completed: ${roundResults.length}/${totalAllowedRounds}`,
				`- latest status: ${roundResults[roundResults.length - 1]?.roundDecision?.status || "active"}`,
				"- work is not yet marked complete; review the latest progress and either continue the swarm or increase maxRounds.",
			].join("\n"),
			details: { roundsCompleted: roundResults.length, totalAllowedRounds },
		});
	}

	let finalDecision: any = null;
	if (options.runId) {
		const allDigests = roundResults.flatMap((round: any) => round.digests || []);
		const latestRoundDigests = roundResults[roundResults.length - 1]?.digests || [];
		const latestCoordinatorText = roundResults[roundResults.length - 1]?.coordinatorHeartbeat?.capture?.text || null;
		const synthesisText = synthesis?.capture?.text || null;
		const baseFinalDecision = deriveRunStatus(latestRoundDigests, { synthesisText, coordinatorText: latestCoordinatorText });
		const finalGate = evaluateRunCompletionGate(options.runId, latestRoundDigests).evaluation;
		finalDecision = enforceCompletionGateDecision(baseFinalDecision, finalGate);
		const aggregateDecision = deriveRunStatus(allDigests);
		upsertRunRecord({
			runId: options.runId,
			status: finalDecision.status,
			roundsCompleted: roundResults.length,
			artifactPaths: aggregateDecision.artifactPaths,
			urls: aggregateDecision.urls,
			commands: aggregateDecision.commands,
			completionCount: finalDecision.completionCount,
			completedAt: finalDecision.completed ? nowIso() : null,
			lastCoordinatorSummary: roundResults[roundResults.length - 1]?.coordinatorHeartbeat?.digest?.summary || null,
			lastTeamLeadSummaries: (roundResults[roundResults.length - 1]?.teamLeadHeartbeats || []).map((item: any) => `[${item.team}] ${item.digest?.summary || item.capture?.text || "No summary."}`),
			coordinatorCompletion: finalDecision.coordinatorComplete,
			synthesisAlias: synthesis?.target?.alias || null,
			synthesisSummary: synthesisText ? summarize(synthesisText, 800) : null,
			synthesisCompletion: finalDecision.synthesisComplete,
			completionGateSatisfied: finalDecision.completionGateSatisfied ?? null,
			completionGateSummary: finalDecision.completionGate ? summarizeCompletionGate(finalDecision.completionGate) : null,
			completionGateDetails: finalDecision.completionGate || null,
		});
		appendRunEvent(options.runId, {
			type: synthesis ? "synthesis_completed" : "orchestration_updated",
			status: finalDecision.status,
			detail: synthesis?.target?.alias
				? `lead=${synthesis.target.alias} completion=${finalDecision.synthesisComplete ? "yes" : "no"}${finalDecision.completionGate ? ` gate=${finalDecision.completionGateSatisfied ? "pass" : "hold"}` : ""}`
				: `rounds=${roundResults.length}`,
			source: "orchestrator",
		});
		persistMissionControlSnapshot(options.runId, teamRecords);
		persistRunEvaluationArtifacts(options.runId);
		if (synthesis) {
			await notifyOrchestratorEvent(pi, finalDecision.completed ? "cmux swarm synthesis ready" : "cmux swarm synthesis captured", {
				subtitle: `run ${options.runId}`,
				body: finalDecision.completed
					? (synthesis?.target?.alias ? `lead ${synthesis.target.alias}` : "final synthesis captured")
					: `status=${finalDecision.status} completion=${finalDecision.synthesisComplete ? "signaled" : "not signaled"}`,
				workspace: options.operatorTarget?.workspace || teamRecords[0]?.workspace || null,
				surface: options.operatorTarget?.surface || null,
				signal: options.signal,
				timeout: options.timeout,
			});
		}
	}
	if (synthesis || finalDecision) {
		await options.onProgress?.({
			stage: "final",
			text: buildMissionControlProgressText(options.runId, teamRecords, "## Final orchestration status", [
				`- status: ${finalDecision?.status || roundResults[roundResults.length - 1]?.roundDecision?.status || "active"}`,
				`- rounds completed: ${roundResults.length}`,
				synthesis?.target?.alias ? `- synthesis lead: ${synthesis.target.alias}` : "- synthesis lead: —",
				synthesis?.capture?.text ? "### Synthesis" : "",
				synthesis?.capture?.text ? synthesis.capture.text : "",
			].filter(Boolean)),
			details: { finalDecision, synthesis },
		});
	}

	return { sent, rounds: roundResults, captures: latestCaptures, synthesis, finalDecision, plannedRounds, totalAllowedRounds };
}

function renderTeamSummary(teamRecord: any, live?: Map<string, any>) {
	const bridgeStatuses = listBridgeStatuses();
	const members = teamRecord.members || [];
	const bridgeMatches = members.map((member: any) => ({ member, bridge: bridgeStatusForAgent(member, bridgeStatuses) }));
	const linkedBridgeCount = bridgeMatches.filter((item: any) => item.bridge).length;
	const staleBridgeCount = bridgeMatches.filter((item: any) => item.bridge?.bridgeAge?.stale).length;
	const freshBridgeCount = linkedBridgeCount - staleBridgeCount;
	const lines = [
		`# cmux Pi team ${teamRecord.team}`,
		"",
		`- layout: ${teamRecord.layout || "unknown"}`,
		`- workspace: ${teamRecord.workspace || "—"}`,
		`- workspaceTitle: ${teamRecord.workspaceTitle || "—"}`,
		`- workspaceDescription: ${teamRecord.workspaceDescription || "—"}`,
		`- goal: ${teamRecord.goal || "—"}`,
		`- modelPreset: ${teamRecord.modelPreset || "—"}`,
		`- provider: ${teamRecord.provider || "—"}`,
		`- model: ${teamRecord.model || "—"}`,
		`- modelStrategy: ${teamRecord.modelStrategy || "—"}`,
		`- members: ${teamRecord.memberCount || members.length}`,
		`- bridge linked: ${linkedBridgeCount}/${members.length || 0}`,
		`- bridge fresh: ${freshBridgeCount}`,
		`- bridge stale: ${staleBridgeCount}`,
		`- lastObservedAt: ${teamRecord.lastObservedAt || "—"}`,
		`- lastObservedRound: ${teamRecord.lastObservedRound || "—"}`,
		typeof teamRecord.observationCount === "number" ? `- observation count: ${teamRecord.observationCount}` : "",
		teamRecord.lastObservationSummary ? `- latest observation: ${teamRecord.lastObservationSummary}` : "",
		teamRecord.lastGuidanceAt ? `- last guidance at: ${teamRecord.lastGuidanceAt}` : "",
		teamRecord.lastGuidanceSummary ? `- latest guidance: ${teamRecord.lastGuidanceSummary}` : "",
		"",
		"## Members",
	];
	for (const item of bridgeMatches) {
		const member = item.member;
		const bridge = item.bridge;
		const liveSurface = live && member.surface ? live.get(member.surface) : null;
		const isLive = live ? Boolean(liveSurface) : undefined;
		const workspaceTitle = member.workspaceTitle || liveSurface?.workspaceTitle || teamRecord.workspaceTitle || "?";
		const browserLock = member.browserLockOwner ? ` lock=${member.browserLockOwner}` : "";
		const checkpoint = member.lastCheckpointKey ? ` checkpoint=${member.lastCheckpointKey}` : "";
		const pattern = member.lastPatternRunStatus ? ` pattern=${member.lastPatternRunStatus}` : "";
		lines.push(
			`- ${member.alias} (${member.role || "agent"})${member.surfaceTitle ? ` title=\"${member.surfaceTitle}\"` : ""}${member.model ? ` model=${member.model}` : ""}${member.provider ? ` provider=${member.provider}` : ""}${isLive === undefined ? "" : isLive ? " [live]" : " [offline]"} workspace=${member.workspace || "?"} workspaceTitle="${workspaceTitle}" surface=${member.surface || "?"}${bridge?.lastEventType ? ` bridge=${bridge.lastEventType}/${bridge.bridgeAge?.stale ? "stale" : "fresh"}` : ""}${browserLock}${checkpoint}${pattern}`,
		);
	}
	return lines.join("\n");
}

function renderTeamCollectionSummary(teamRecords: any[], live?: Map<string, any>) {
	if (!teamRecords || !teamRecords.length) return "# cmux Pi swarm\n\n- No teams.";
	if (teamRecords.length === 1) return renderTeamSummary(teamRecords[0], live);
	const totalMembers = teamRecords.reduce((sum: number, teamRecord: any) => sum + ((teamRecord.members || []).length || 0), 0);
	const lines = [
		"# cmux Pi swarm",
		"",
		`- teams: ${teamRecords.length}`,
		`- members: ${totalMembers}`,
		"",
		"## Team snapshots",
	];
	for (const teamRecord of teamRecords) {
		lines.push("", renderTeamSummary(teamRecord, live));
	}
	return lines.join("\n");
}

function renderCaptureSection(captures: any[]) {
	const lines = ["## Captures"];
	for (const capture of captures || []) {
		lines.push(
			"",
			`### ${capture.alias || capture.surface} [${capture.team || "team"}]`,
			"```text",
			capture.text,
			"```",
		);
	}
	return lines.join("\n");
}

async function collectOrchestratorDoctor(pi: ExtensionAPI, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const fingerprint = await buildCmuxSessionFingerprint(pi, signal, timeout).catch(() => null);
	const agentRegistry = readAgentRegistry();
	const teamRegistry = readTeamRegistry();
	const runRegistry = readRunRegistry();
	const bridgeStatuses = listBridgeStatuses();
	const offlineAgents = Object.entries(agentRegistry.agents || {})
		.filter(([, record]: any) => !record?.surface || !live.get(record.surface))
		.map(([alias, record]: any) => ({ alias, team: record?.team || null, surface: record?.surface || null, runId: record?.runId || null }));
	const orphanAgents = Object.entries(agentRegistry.agents || {})
		.filter(([, record]: any) => record?.team && !teamRegistry.teams?.[record.team])
		.map(([alias, record]: any) => ({ alias, team: record?.team || null, runId: record?.runId || null }));
	const agentsWithoutBridge = Object.entries(agentRegistry.agents || {})
		.filter(([, record]: any) => !bridgeStatusForAgent(record, bridgeStatuses))
		.map(([alias, record]: any) => ({ alias, team: record?.team || null }));
	const agentsWithStaleBridge = Object.entries(agentRegistry.agents || {})
		.map(([alias, record]: any) => ({ alias, record, bridge: bridgeStatusForAgent(record, bridgeStatuses) }))
		.filter((item: any) => item.bridge?.bridgeAge?.stale)
		.map((item: any) => ({ alias: item.alias, team: item.record?.team || null, lastEventAt: item.bridge?.lastEventAt || null, lastEventType: item.bridge?.lastEventType || null }));
	const offlineTeams = [] as any[];
	const degradedTeams = [] as any[];
	const sessionMismatches = [] as any[];
	for (const [teamName, teamRecord] of Object.entries(teamRegistry.teams || {})) {
		const members = (teamRecord as any).members || [];
		const liveCount = members.filter((member: any) => member?.surface && live.get(member.surface)).length;
		if (!liveCount) offlineTeams.push({ team: teamName, members: members.length });
		else if (liveCount !== members.length) degradedTeams.push({ team: teamName, liveCount, members: members.length });
		if ((teamRecord as any).cmuxSessionId && fingerprint?.sessionId && (teamRecord as any).cmuxSessionId !== fingerprint.sessionId) {
			sessionMismatches.push({ team: teamName, recorded: (teamRecord as any).cmuxSessionId, current: fingerprint.sessionId });
		}
	}
	const runsWithMissingTeams = Object.entries(runRegistry.runs || {})
		.filter(([, run]: any) => (run.teamNames || []).some((teamName: string) => !teamRegistry.teams?.[teamName]))
		.map(([runId, run]: any) => ({ runId, run }));
	const baseReport = {
		fingerprint,
		bridgeSessionCount: bridgeStatuses.length,
		staleBridgeSessions: bridgeStatuses.filter((status: any) => status?.bridgeAge?.stale),
		offlineAgents,
		orphanAgents,
		agentsWithoutBridge,
		agentsWithStaleBridge,
		offlineTeams,
		degradedTeams,
		sessionMismatches,
		runsWithMissingTeams,
		agentCount: Object.keys(agentRegistry.agents || {}).length,
		teamCount: Object.keys(teamRegistry.teams || {}).length,
		runCount: Object.keys(runRegistry.runs || {}).length,
		liveSurfaceCount: live.size,
		agentRegistry,
		teamRegistry,
		runRegistry,
	};
	const derived = deriveDoctorFindings(baseReport);
	const repair = deriveRepairPlan(derived.findings);
	return {
		...baseReport,
		findings: derived.findings,
		findingSummary: derived.summary,
		repairActions: repair.actions,
		repairSummary: repair.summary,
	};
}

function teamSpecsFromRecord(teamRecord: any) {
	return (teamRecord.members || []).map((member: any) => ({
		alias: member.alias,
		role: member.role,
		provider: member.provider,
		model: member.model,
		cwd: member.cwd,
		sessionPath: member.sessionPath,
		workspaceTitle: member.workspaceTitle,
		surfaceTitle: member.surfaceTitle,
	}));
}

async function healTeamRecord(
	pi: ExtensionAPI,
	teamRecord: any,
	ctx: any,
	signal?: AbortSignal,
	options: { timeout?: number; recreateDeadTeam?: boolean } = {},
) {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
	const liveMembers = (teamRecord.members || []).filter((member: any) => member?.surface && live.get(member.surface));
	if (liveMembers.length === (teamRecord.members || []).length) {
		return { healed: [], recreated: false, teamRecord };
	}
	if (!liveMembers.length) {
		if (options.recreateDeadTeam === false) {
			return { healed: [], recreated: false, teamRecord: null };
		}
		removeTeamRecord(teamRecord.team);
		const recreated = await createPiTeam(
			pi,
			{
				team: teamRecord.team,
				modelPreset: teamRecord.modelPreset,
				runId: teamRecord.runId || generateRunId("swarm"),
				goal: teamRecord.goal,
				layout: teamRecord.layout,
				workspace: teamRecord.layout === "shared_workspace" ? undefined : teamRecord.workspace,
				workspaceTitle: teamRecord.workspaceTitle || defaultTeamWorkspaceTitle(teamRecord.team),
				workspaceDescription: teamRecord.workspaceDescription || defaultTeamWorkspaceDescription(teamRecord.team, {
					goal: teamRecord.goal,
					runId: teamRecord.runId,
					memberCount: (teamRecord.members || []).length,
					layout: teamRecord.layout,
				}),
				cwd: (teamRecord.members || [])[0]?.cwd,
				timeoutMs: timeout,
				specs: teamSpecsFromRecord(teamRecord),
			},
			ctx,
			signal,
		);
		appendRunEvent(teamRecord.runId, { type: "team_recreated", team: teamRecord.team, detail: `members=${(recreated.launchedMembers || []).length}` });
		return { healed: recreated.launchedMembers || [], recreated: true, teamRecord: recreated.teamRecord };
	}

	const roster = buildTeamRoster(teamRecord);
	const healed: any[] = [];
	let sharedWorkspace = teamRecord.workspace || liveMembers[0]?.workspace || null;
	for (const member of teamRecord.members || []) {
		if (member?.surface && live.get(member.surface)) continue;
		const launchParams: any = {
			alias: member.alias,
			role: member.role,
			team: teamRecord.team,
			runId: teamRecord.runId || generateRunId("swarm"),
			provider: member.provider || teamRecord.provider || null,
			model: member.model || teamRecord.model || null,
			cwd: member.cwd || (liveMembers[0]?.cwd ?? ctx?.cwd),
			sessionPath: member.sessionPath || defaultSessionPath(member.alias, teamRecord.runId),
			workspaceTitle: member.workspaceTitle || teamRecord.workspaceTitle || null,
			workspaceDescription: teamRecord.workspaceDescription || null,
			surfaceTitle: member.surfaceTitle || null,
			prompt: buildTeamBootstrapPrompt(teamRecord.team, member.role || member.alias, teamRecord.goal, { roster }),
			timeoutMs: timeout,
		};
		if (teamRecord.layout === "shared_workspace") {
			launchParams.target = "split";
			launchParams.workspace = sharedWorkspace;
		} else {
			launchParams.target = "new_workspace";
			launchParams.workspaceTitle = member.workspaceTitle || defaultAgentWorkspaceTitle({
				alias: member.alias,
				team: teamRecord.team,
				role: member.role,
			});
			launchParams.workspaceDescription = teamRecord.workspaceDescription || defaultAgentWorkspaceDescription({
				goal: teamRecord.goal,
				runId: teamRecord.runId,
				team: teamRecord.team,
				role: member.role,
				layout: teamRecord.layout,
			});
		}
		const launched = await launchPiAgent(pi, launchParams, ctx, signal);
		if (teamRecord.layout === "shared_workspace" && !sharedWorkspace) sharedWorkspace = launched.workspaceRef;
		healed.push({
			alias: launched.record.alias,
			role: member.role,
			provider: launched.record.provider || member.provider || teamRecord.provider || null,
			model: launched.record.model || member.model || teamRecord.model || null,
			workspace: launched.workspaceRef,
			workspaceTitle: launched.record.workspaceTitle || member.workspaceTitle || null,
			surface: launched.surfaceRef,
			surfaceTitle: launched.record.surfaceTitle || member.surfaceTitle || null,
			pane: launched.surface?.pane_ref || launched.record.pane || null,
			cwd: launched.record.cwd || member.cwd || null,
			sessionPath: launched.record.sessionPath || member.sessionPath || null,
			promptSummary: launched.record.promptSummary || null,
		});
	}
	const nextMembers = [...liveMembers, ...healed];
	const next = upsertTeamRecord({
		...teamRecord,
		workspace: teamRecord.layout === "shared_workspace" ? sharedWorkspace : teamRecord.workspace,
		workspaceTitle: teamRecord.workspaceTitle || (teamRecord.layout === "shared_workspace" ? nextMembers[0]?.workspaceTitle || defaultTeamWorkspaceTitle(teamRecord.team) : null),
		members: nextMembers,
		memberCount: nextMembers.length,
		status: nextMembers.length ? "active" : "offline",
		lastHeartbeatAt: nowIso(),
	});
	if (healed.length) appendRunEvent(teamRecord.runId, { type: "team_healed", team: teamRecord.team, detail: healed.map((item: any) => item.alias).join(", ") });
	return { healed, recreated: false, teamRecord: next };
}

async function rebalanceTeamWithDigests(
	pi: ExtensionAPI,
	teamRecord: any,
	task: string,
	digests: any[],
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number; force?: boolean; source?: string; round?: number } = {},
) {
	const latestTeamRecord = resolveTeamRecord(teamRecord.team);
	const blocked = (digests || []).filter((digest: any) => digest.status === "blocked" || digest.status === "stalled");
	if (!blocked.length) return { team: latestTeamRecord.team, digests, sent: [], blocked: [], skipped: true, reason: "healthy" };
	const rebalanceDecision = shouldAutoRebalance(latestTeamRecord, digests, options.round || 1);
	if (!options.force && !rebalanceDecision.should) {
		return { team: latestTeamRecord.team, digests, sent: [], blocked, skipped: true, reason: rebalanceDecision.reason };
	}
	const healthy = (digests || []).filter((digest: any) => !blocked.some((item: any) => item.alias === digest.alias));
	const leads = teamLeadMembers(latestTeamRecord, 2);
	const sent: any[] = [];
	for (const lead of leads) {
		const msg = [
			`Rebalance request for team ${latestTeamRecord.team}.`,
			`Task: ${task || latestTeamRecord.goal || "Continue the run"}`,
			"The following agents appear blocked or stalled:",
			formatBlockedDigests(blocked, 8),
			healthy.length ? `Healthy agents available:\n${formatCaptureDigests(healthy, 8)}` : "No healthy agents detected.",
			"Please redistribute work, absorb blocked scope where appropriate, and reply with STATUS, OUTPUT, RISKS, NEXT, NEEDS FROM PEERS, FILES/AREAS CHANGED, CONFIDENCE, and DELIVERABLE when relevant.",
		].join("\n\n");
		persistGuidanceSnapshot({
			runId: latestTeamRecord.runId,
			team: latestTeamRecord.team,
			aliases: [lead.alias],
			kind: "team_rebalance",
			message: msg,
			round: options.round || null,
			status: blocked.length ? "blocked" : "active",
		});
		sent.push(await sendAgentMessage(pi, { alias: lead.alias, workspace: lead.workspace, surface: lead.surface }, msg, {
			appendEnter: options.appendEnter !== false,
			signal: options.signal,
			timeout: options.timeout,
		}));
	}
	for (const digest of healthy.slice(0, 2)) {
		const member = (latestTeamRecord.members || []).find((item: any) => item.alias === digest.alias);
		if (!member) continue;
		const msg = [
			`Team rebalance request for ${latestTeamRecord.team}.`,
			`Task: ${task || latestTeamRecord.goal || "Continue the run"}`,
			"Some peers are blocked or stalled:",
			formatBlockedDigests(blocked, 6),
			"If you have spare capacity, absorb adjacent scope, report what you took over, and include any new DELIVERABLE or FILES/AREAS CHANGED.",
		].join("\n\n");
		persistGuidanceSnapshot({
			runId: latestTeamRecord.runId,
			team: latestTeamRecord.team,
			aliases: [member.alias],
			kind: "team_rebalance_support",
			message: msg,
			round: options.round || null,
			status: blocked.length ? "blocked" : "active",
		});
		sent.push(await sendAgentMessage(pi, { alias: member.alias, workspace: member.workspace, surface: member.surface }, msg, {
			appendEnter: options.appendEnter !== false,
			signal: options.signal,
			timeout: options.timeout,
		}));
	}
	upsertTeamRecord({
		...latestTeamRecord,
		lastRebalanceAt: nowIso(),
		lastRebalanceKey: rebalanceDecision.key,
	});
	appendRunEvent(latestTeamRecord.runId, {
		type: "team_rebalanced",
		team: latestTeamRecord.team,
		detail: `${options.source || "manual"}:${rebalanceDecision.reason}`,
	});
	return { team: latestTeamRecord.team, digests, sent, blocked, skipped: false, reason: rebalanceDecision.reason };
}

async function rebalanceTeam(
	pi: ExtensionAPI,
	teamRecord: any,
	task: string,
	options: { appendEnter?: boolean; signal?: AbortSignal; timeout?: number; force?: boolean; source?: string; round?: number } = {},
) {
	const captures = await gatherTeamCaptures(pi, teamRecord, {
		lines: DEFAULT_TEAM_CAPTURE_LINES,
		scrollback: true,
		signal: options.signal,
		timeout: options.timeout,
	});
	const digests = captures.map(buildCaptureDigest);
	return rebalanceTeamWithDigests(pi, teamRecord, task, digests, options);
}

async function shutdownTeam(
	pi: ExtensionAPI,
	teamRecord: any,
	options: { closeSurface?: boolean; closeWorkspace?: boolean; preserveWorkspaces?: string[]; signal?: AbortSignal; timeout?: number } = {},
	ctx?: any,
) {
	const workspaceRefs = uniqueStrings(
		teamRecord.layout === "shared_workspace"
			? [teamRecord.workspace || null]
			: (teamRecord.members || []).map((member: any) => member.workspace || null),
	);
	for (const member of teamRecord.members || []) {
		const interruptArgs = ["send-key"];
		addFlag(interruptArgs, "--workspace", member.workspace);
		addFlag(interruptArgs, "--surface", member.surface);
		interruptArgs.push("ctrl+c");
		await execCmux(pi, interruptArgs, {
			signal: options.signal,
			timeout: Math.min(options.timeout ?? DEFAULT_TIMEOUT, 10_000),
		}).catch(() => null);
		if (options.closeSurface !== false) {
			const closeArgs = ["close-surface"];
			addFlag(closeArgs, "--workspace", member.workspace);
			addFlag(closeArgs, "--surface", member.surface);
			await execCmux(pi, closeArgs, {
				signal: options.signal,
				timeout: options.timeout ?? DEFAULT_TIMEOUT,
			}).catch(() => null);
		}
		if (member.alias) removeAgentRecord(member.alias);
		appendRunEvent(teamRecord.runId, { type: "agent_shutdown", team: teamRecord.team, alias: member.alias, status: "offline" });
		if (ctx) {
			syncSwarmPresence(pi, ctx, {
				runId: teamRecord.runId || null,
				teamId: teamRecord.team || null,
				agentAlias: member.alias || null,
				workspaceId: member.workspace || null,
				surfaceId: member.surface || null,
			}, { status: "offline", note: `Team ${teamRecord.team} member ${member.alias || "unknown"} shut down.` }).catch(() => null);
		}
	}
	if (options.closeWorkspace !== false) {
		const preserve = new Set(uniqueStrings(options.preserveWorkspaces || []));
		for (const workspaceRef of workspaceRefs) {
			if (!workspaceRef) continue;
			if (preserve.has(workspaceRef)) {
				appendRunEvent(teamRecord.runId, { type: "workspace_preserved", team: teamRecord.team, detail: workspaceRef });
				continue;
			}
			await execCmux(pi, ["close-workspace", "--workspace", workspaceRef], {
				signal: options.signal,
				timeout: options.timeout ?? DEFAULT_TIMEOUT,
			}).catch(() => null);
			appendRunEvent(teamRecord.runId, { type: "workspace_closed", team: teamRecord.team, detail: workspaceRef });
		}
	}
	appendRunEvent(teamRecord.runId, { type: "team_shutdown", team: teamRecord.team, status: "offline" });
	if (ctx) {
		syncSwarmPresence(pi, ctx, {
			runId: teamRecord.runId || null,
			teamId: teamRecord.team || null,
			agentAlias: `${teamRecord.team || "team"}-lead`,
			workspaceId: teamRecord.workspace || null,
		}, { status: "offline", note: `Team ${teamRecord.team} shut down.` }).catch(() => null);
	}
	removeTeamRecord(teamRecord.team);
}

async function collectStatus(
	pi: ExtensionAPI,
	signal?: AbortSignal,
	options: {
		includeCapabilities?: boolean;
		includeTree?: boolean;
		includeConfig?: boolean;
		timeoutMs?: number;
		projectCwd?: string;
	} = {},
) {
	const binary = resolveCmuxBinary();
	if (!binary) {
		return {
			installed: false,
			binary: null,
			message: installHelp(),
		};
	}

	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
	const env = collectCmuxEnv();
	const paths = configPaths(options.projectCwd);

	const version = await execCmux(pi, ["version"], { signal, timeout });
	const capabilities = await execCmuxJson(pi, ["capabilities", "--json"], {
		signal,
		timeout,
	});

	let identify = null;
	let currentWorkspace = null;
	let tree = null;

	try {
		identify = (await execCmuxRpc(pi, "system.identify", {}, { signal, timeout })).data;
	} catch {
		// ignore
	}

	try {
		currentWorkspace = (await execCmuxRpc(pi, "workspace.current", {}, { signal, timeout })).data;
	} catch {
		// ignore
	}

	if (options.includeTree) {
		try {
			tree = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
		} catch {
			// ignore
		}
	}

	const config = {
		ghosttyPrimary: {
			path: paths.ghosttyPrimary,
			exists: existsSync(paths.ghosttyPrimary),
			snippet: options.includeConfig ? maybeReadSnippet(paths.ghosttyPrimary, 40) : null,
		},
		ghosttyFallback: {
			path: paths.ghosttyFallback,
			exists: existsSync(paths.ghosttyFallback),
			snippet: options.includeConfig ? maybeReadSnippet(paths.ghosttyFallback, 40) : null,
		},
		cmuxSettingsPrimary: {
			path: paths.cmuxSettingsPrimary,
			exists: existsSync(paths.cmuxSettingsPrimary),
			snippet: options.includeConfig ? maybeReadSnippet(paths.cmuxSettingsPrimary, 60) : null,
		},
		cmuxSettingsFallback: {
			path: paths.cmuxSettingsFallback,
			exists: existsSync(paths.cmuxSettingsFallback),
			snippet: options.includeConfig ? maybeReadSnippet(paths.cmuxSettingsFallback, 60) : null,
		},
		cmuxCommandsProject: {
			path: paths.cmuxCommandsProject,
			exists: existsSync(paths.cmuxCommandsProject),
			snippet: options.includeConfig ? maybeReadSnippet(paths.cmuxCommandsProject, 80) : null,
		},
		cmuxCommandsGlobal: {
			path: paths.cmuxCommandsGlobal,
			exists: existsSync(paths.cmuxCommandsGlobal),
			snippet: options.includeConfig ? maybeReadSnippet(paths.cmuxCommandsGlobal, 80) : null,
		},
	};

	return {
		installed: true,
		binary,
		version: version.stdout.trim(),
		capabilities: options.includeCapabilities !== false ? capabilities.data : undefined,
		identify,
		currentWorkspace,
		tree,
		env,
		config,
	};
}

function renderStatus(status: any) {
	if (!status.installed) {
		return `# cmux status\n\n${status.message}`;
	}

	const methods = status.capabilities?.methods || [];
	const groups = methodGroups(methods);
	const focused = status.identify?.focused || null;
	const workspace = status.currentWorkspace?.workspace || null;
	const configRows = Object.entries(status.config || {})
		.map(([key, value]: any) => `- ${key}: ${value.exists ? "present" : "missing"} (${value.path})`)
		.join("\n");

	const lines = [
		"# cmux status",
		"",
		`- installed: yes`,
		`- binary: ${status.binary}`,
		`- version: ${status.version}`,
		`- socket path: ${status.capabilities?.socket_path || status.env.CMUX_SOCKET_PATH || status.env.CMUX_SOCKET || "unknown"}`,
		`- access mode: ${status.capabilities?.access_mode || "unknown"}`,
		`- inside cmux terminal: ${status.env.CMUX_WORKSPACE_ID || status.env.CMUX_SURFACE_ID ? "yes" : "no"}`,
		"",
		"## Environment",
		`- workspace id: ${status.env.CMUX_WORKSPACE_ID || "unset"}`,
		`- surface id: ${status.env.CMUX_SURFACE_ID || "unset"}`,
		`- tab id: ${status.env.CMUX_TAB_ID || "unset"}`,
		`- panel id: ${status.env.CMUX_PANEL_ID || "unset"}`,
		"",
		"## Focused target",
		`- window: ${focused?.window_ref || "unknown"}`,
		`- workspace: ${focused?.workspace_ref || "unknown"}`,
		`- pane: ${focused?.pane_ref || "unknown"}`,
		`- surface: ${focused?.surface_ref || "unknown"}`,
		`- surface type: ${focused?.surface_type || "unknown"}`,
		"",
		"## Current workspace",
		`- ref: ${workspace?.ref || "unknown"}`,
		`- title: ${workspace?.title || "unknown"}`,
		`- cwd: ${workspace?.current_directory || "unknown"}`,
		`- description: ${workspace?.description || "—"}`,
		"",
		"## Capability groups",
		...groups.map((group: any) => `- ${group.name}: ${group.count}`),
		"",
		"## Config files",
		configRows || "- none detected",
	];

	if (status.tree) {
		lines.push("", "## Tree", "```json", json(status.tree), "```");
	}

	return lines.join("\n");
}

function renderWorkspaceResult(action: string, payload: any) {
	if (action === "list") {
		const workspaces = payload.workspaces || [];
		return [
			"# cmux workspaces",
			"",
			...workspaces.map(
				(ws: any) =>
					`- ${ws.ref} ${ws.selected ? "[selected]" : ""} \`${ws.title}\`${ws.description ? ` — ${ws.description}` : ""}${ws.current_directory ? ` (cwd: ${ws.current_directory})` : ""}`,
			),
		].join("\n");
	}

	if (action === "current") {
		return [
			"# current cmux workspace",
			"",
			`- ref: ${payload.workspace?.ref || payload.workspace_ref || "unknown"}`,
			`- title: ${payload.workspace?.title || "unknown"}`,
			`- cwd: ${payload.workspace?.current_directory || "unknown"}`,
			`- description: ${payload.workspace?.description || "—"}`,
			"",
			"```json",
			json(payload),
			"```",
		].join("\n");
	}

	if (action === "tree") {
		return ["# cmux tree", "", "```json", json(payload), "```"].join("\n");
	}

	return [
		`# cmux workspace ${action}`,
		"",
		"```json",
		json(payload),
		"```",
	].join("\n");
}

function renderSurfaceResult(action: string, payload: any) {
	if (action === "list") {
		const surfaces = payload.surfaces || [];
		return [
			"# cmux surfaces",
			"",
			...surfaces.map(
				(s: any) =>
					`- ${s.ref} [${s.type}] ${s.focused ? "[focused]" : s.selected_in_pane ? "[selected]" : ""} \`${s.title || "untitled"}\` pane=${s.pane_ref || "unknown"}`,
			),
		].join("\n");
	}

	if (action === "panes") {
		const panes = payload.panes || [];
		return [
			"# cmux panes",
			"",
			...panes.map(
				(p: any) =>
					`- ${p.ref} ${p.focused ? "[focused]" : ""} surfaces=${p.surface_count} selected=${p.selected_surface_ref || "unknown"}`,
			),
		].join("\n");
	}

	return [
		`# cmux surface ${action}`,
		"",
		payload.text ? payload.text : "```json\n" + json(payload) + "\n```",
	].join("\n");
}

function renderBrowserResult(action: string, payload: any) {
	return [
		`# cmux browser ${action}`,
		"",
		typeof payload === "string" ? payload : "```json\n" + json(payload) + "\n```",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		rememberPrimaryActivityContext(ctx);
		clearPrimaryActivityWidget();
		// Recover from the common failure mode where the previous primary session
		// received final team results but shut down before the agent_end hook could
		// close team workspaces and remove the activity module.
		setTimeout(() => {
			cleanupPrimaryFinalizedRuns(pi, ctx, { type: "session_start" }).catch(() => null);
		}, 500);
	});

	pi.on("session_shutdown", async () => {
		for (const timer of primaryActivityTimers.values()) clearInterval(timer);
		primaryActivityTimers.clear();
		clearPrimaryActivityWidget();
	});

	pi.on("agent_end", async (event: any, ctx) => {
		await cleanupPrimaryFinalizedRuns(pi, ctx, event).catch(() => null);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		rememberPrimaryActivityContext(ctx);
		return {
			systemPrompt: `${event.systemPrompt}\n${CMUX_PREAMBLE}`,
		};
	});

	pi.registerTool({
		name: "cmux_status",
		label: "cmux Status",
		description:
			"Check whether cmux is installed and reachable, inspect socket capabilities, detect the current focused workspace and surface, and summarize local cmux config files.",
		promptSnippet:
			"Use when the user wants cmux integration, setup verification, or a snapshot of the current cmux environment.",
		parameters: Type.Object({
			includeCapabilities: Type.Optional(
				Type.Boolean({ description: "Include cmux capability metadata and socket method list." }),
			),
			includeTree: Type.Optional(
				Type.Boolean({ description: "Include the full workspace/pane/surface tree." }),
			),
			includeConfig: Type.Optional(
				Type.Boolean({ description: "Include snippets from cmux and Ghostty config files when available." }),
			),
			timeoutMs: Type.Optional(
				Type.Integer({ description: "Command timeout in milliseconds." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const status = await collectStatus(pi, signal, {
					...(params as any),
					projectCwd: ctx?.cwd,
				});
				return ok(renderStatus(status), status);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_status" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_workspace",
		label: "cmux Workspace",
		description:
			"List, inspect, create, select, rename, reorder, move, annotate, or close cmux workspaces.",
		promptSnippet:
			"Use for cmux sidebar/workspace orchestration: create workspaces, switch context, reorder them, or inspect the current tree.",
		parameters: Type.Object({
			action: StringEnum(
				[
					"list",
					"current",
					"tree",
					"new",
					"select",
					"rename",
					"close",
					"reorder",
					"move_to_window",
					"action",
				] as const,
				{ description: "Workspace action to perform." },
			),
			workspace: Type.Optional(
				Type.String({ description: "Workspace identifier, ref, or index such as workspace:1." }),
			),
			window: Type.Optional(
				Type.String({ description: "Window identifier, ref, or index for move/reorder actions." }),
			),
			title: Type.Optional(Type.String({ description: "Workspace title for create or rename actions." })),
			description: Type.Optional(
				Type.String({ description: "Workspace description for create or workspace-action flows." }),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for a new workspace." })),
			command: Type.Optional(
				Type.String({ description: "Shell command to run in a newly created workspace." }),
			),
			workspaceAction: Type.Optional(
				Type.String({ description: "Value for workspace-action --action, such as color or description related actions." }),
			),
			color: Type.Optional(Type.String({ description: "Color name or #hex for workspace-action." })),
			index: Type.Optional(Type.Integer({ description: "Reorder target index." })),
			before: Type.Optional(Type.String({ description: "Place before another workspace ref or index." })),
			after: Type.Optional(Type.String({ description: "Place after another workspace ref or index." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				let payload: any = null;

				switch (p.action) {
					case "list":
						payload = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
						break;
					case "current":
						payload = (await execCmuxRpc(pi, "workspace.current", {}, { signal, timeout })).data;
						break;
					case "tree":
						payload = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
						break;
					case "new": {
						const args = ["new-workspace"];
						addFlag(args, "--name", p.title);
						addFlag(args, "--description", p.description);
						addFlag(args, "--cwd", p.cwd);
						addFlag(args, "--command", p.command);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
						break;
					}
					case "select": {
						if (!p.workspace) throw new Error("workspace is required for select");
						await execCmux(pi, ["select-workspace", "--workspace", p.workspace], {
							signal,
							timeout,
						});
						payload = (await execCmuxRpc(pi, "workspace.current", {}, { signal, timeout })).data;
						break;
					}
					case "rename": {
						if (!p.title) throw new Error("title is required for rename");
						const args = ["rename-workspace"];
						addFlag(args, "--workspace", p.workspace);
						args.push(p.title);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "workspace.current", {}, { signal, timeout })).data;
						break;
					}
					case "close": {
						if (!p.workspace) throw new Error("workspace is required for close");
						await execCmux(pi, ["close-workspace", "--workspace", p.workspace], {
							signal,
							timeout,
						});
						payload = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
						break;
					}
					case "reorder": {
						if (!p.workspace) throw new Error("workspace is required for reorder");
						const args = ["reorder-workspace", "--workspace", p.workspace];
						if (p.index !== undefined) addFlag(args, "--index", p.index);
						else if (p.before) addFlag(args, "--before", p.before);
						else if (p.after) addFlag(args, "--after", p.after);
						else throw new Error("reorder requires index, before, or after");
						addFlag(args, "--window", p.window);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
						break;
					}
					case "move_to_window": {
						if (!p.workspace || !p.window) {
							throw new Error("workspace and window are required for move_to_window");
						}
						await execCmux(
							pi,
							["move-workspace-to-window", "--workspace", p.workspace, "--window", p.window],
							{ signal, timeout },
						);
						payload = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
						break;
					}
					case "action": {
						if (!p.workspaceAction) {
							throw new Error("workspaceAction is required when action=action");
						}
						const args = ["workspace-action", "--action", p.workspaceAction];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--title", p.title);
						addFlag(args, "--color", p.color);
						addFlag(args, "--description", p.description);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "workspace.list", {}, { signal, timeout })).data;
						break;
					}
					default:
						throw new Error(`Unsupported workspace action: ${p.action}`);
				}

				return ok(renderWorkspaceResult(p.action, payload), {
					action: p.action,
					payload,
				});
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_workspace",
					action: p.action,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_surface",
		label: "cmux Surface",
		description:
			"Inspect panes and surfaces, read terminal text, send input, split layouts, focus targets, rename tabs, and manage tab or surface operations in cmux.",
		promptSnippet:
			"Use for pane and surface orchestration inside a cmux workspace, especially terminal I/O and layout changes.",
		parameters: Type.Object({
			action: StringEnum(
				[
					"list",
					"panes",
					"read",
					"send",
					"send_key",
					"new_split",
					"new_pane",
					"new_surface",
					"focus_pane",
					"focus_surface",
					"close_surface",
					"move_surface",
					"reorder_surface",
					"rename_tab",
					"tab_action",
					"health",
					"flash",
				] as const,
				{ description: "Surface or pane action to perform." },
			),
			workspace: Type.Optional(Type.String({ description: "Workspace ref, id, or index." })),
			pane: Type.Optional(Type.String({ description: "Pane ref, id, or index." })),
			surface: Type.Optional(Type.String({ description: "Surface ref, id, or index." })),
			tab: Type.Optional(Type.String({ description: "Tab ref, id, or index for tab actions." })),
			targetPane: Type.Optional(Type.String({ description: "Target pane for move operations." })),
			window: Type.Optional(Type.String({ description: "Window ref, id, or index for move operations." })),
			direction: Type.Optional(
				StringEnum(["left", "right", "up", "down"] as const, { description: "Split direction." }),
			),
			type: Type.Optional(
				StringEnum(["terminal", "browser"] as const, { description: "Surface or pane content type." }),
			),
			url: Type.Optional(Type.String({ description: "URL for browser surface creation or tab actions." })),
			title: Type.Optional(Type.String({ description: "Tab title or rename target." })),
			text: Type.Optional(Type.String({ description: "Text to send to a terminal surface." })),
			key: Type.Optional(Type.String({ description: "Special key name to send." })),
			lines: Type.Optional(Type.Integer({ description: "Number of lines to read from the screen." })),
			scrollback: Type.Optional(Type.Boolean({ description: "Read terminal scrollback when action=read." })),
			index: Type.Optional(Type.Integer({ description: "Target index for reordering." })),
			before: Type.Optional(Type.String({ description: "Place surface before another surface ref or index." })),
			after: Type.Optional(Type.String({ description: "Place surface after another surface ref or index." })),
			focus: Type.Optional(Type.Boolean({ description: "Whether move-surface should focus the moved surface." })),
			tabAction: Type.Optional(Type.String({ description: "Value for tab-action --action." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				let payload: any = null;

				switch (p.action) {
					case "list":
						payload = (
							await execCmuxRpc(
								pi,
								"surface.list",
								p.workspace ? { workspace_id: p.workspace } : {},
								{ signal, timeout },
							)
						).data;
						break;
					case "panes":
						payload = (
							await execCmuxRpc(
								pi,
								"pane.list",
								p.workspace ? { workspace_id: p.workspace } : {},
								{ signal, timeout },
							)
						).data;
						break;
					case "read": {
						const resolved = p.surface
							? await requireLiveSurface(pi, { workspace: p.workspace || null, surface: p.surface }, signal, timeout)
							: { workspace: p.workspace || null, surface: null };
						const args = ["read-screen"];
						addFlag(args, "--workspace", resolved.workspace);
						addFlag(args, "--surface", resolved.surface?.ref || p.surface);
						addBoolFlag(args, "--scrollback", p.scrollback);
						addFlag(args, "--lines", p.lines);
						const result = await execCmux(pi, args, { signal, timeout });
						payload = { text: result.stdout.trim() };
						break;
					}
					case "send": {
						if (typeof p.text !== "string") throw new Error("text is required for send");
						const args = ["send"];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--surface", p.surface);
						args.push(p.text);
						await execCmux(pi, args, { signal, timeout });
						payload = { sent: p.text, workspace: p.workspace || null, surface: p.surface || null };
						break;
					}
					case "send_key": {
						if (!p.key) throw new Error("key is required for send_key");
						const args = ["send-key"];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--surface", p.surface);
						args.push(p.key);
						await execCmux(pi, args, { signal, timeout });
						payload = { key: p.key, workspace: p.workspace || null, surface: p.surface || null };
						break;
					}
					case "new_split": {
						if (!p.direction) throw new Error("direction is required for new_split");
						const args = ["new-split", p.direction];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--surface", p.surface);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
						break;
					}
					case "new_pane": {
						const args = ["new-pane"];
						addFlag(args, "--type", p.type);
						addFlag(args, "--direction", p.direction);
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--url", p.url);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
						break;
					}
					case "new_surface": {
						const args = ["new-surface"];
						addFlag(args, "--type", p.type);
						addFlag(args, "--pane", p.pane);
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--url", p.url);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "surface.list", {}, { signal, timeout })).data;
						break;
					}
					case "focus_pane": {
						if (!p.pane) throw new Error("pane is required for focus_pane");
						const args = ["focus-pane", "--pane", p.pane];
						addFlag(args, "--workspace", p.workspace);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "pane.list", {}, { signal, timeout })).data;
						break;
					}
					case "focus_surface": {
						if (!p.surface) throw new Error("surface is required for focus_surface");
						payload = (
							await execCmuxRpc(
								pi,
								"surface.focus",
								{
									surface_id: p.surface,
									...(p.workspace ? { workspace_id: p.workspace } : {}),
								},
								{ signal, timeout },
							)
						).data;
						break;
					}
					case "close_surface": {
						const args = ["close-surface"];
						addFlag(args, "--surface", p.surface);
						addFlag(args, "--workspace", p.workspace);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "surface.list", {}, { signal, timeout })).data;
						break;
					}
					case "move_surface": {
						if (!p.surface) throw new Error("surface is required for move_surface");
						const args = ["move-surface", "--surface", p.surface];
						addFlag(args, "--pane", p.targetPane || p.pane);
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--window", p.window);
						addFlag(args, "--before", p.before);
						addFlag(args, "--after", p.after);
						if (p.index !== undefined) addFlag(args, "--index", p.index);
						if (p.focus !== undefined) addFlag(args, "--focus", p.focus ? "true" : "false");
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "system.tree", {}, { signal, timeout })).data;
						break;
					}
					case "reorder_surface": {
						if (!p.surface) throw new Error("surface is required for reorder_surface");
						const args = ["reorder-surface", "--surface", p.surface];
						if (p.index !== undefined) addFlag(args, "--index", p.index);
						else if (p.before) addFlag(args, "--before", p.before);
						else if (p.after) addFlag(args, "--after", p.after);
						else throw new Error("reorder_surface requires index, before, or after");
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "surface.list", {}, { signal, timeout })).data;
						break;
					}
					case "rename_tab": {
						if (!p.title) throw new Error("title is required for rename_tab");
						const args = ["rename-tab"];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--tab", p.tab);
						addFlag(args, "--surface", p.surface);
						args.push(p.title);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "surface.list", {}, { signal, timeout })).data;
						break;
					}
					case "tab_action": {
						if (!p.tabAction) throw new Error("tabAction is required for tab_action");
						const args = ["tab-action", "--action", p.tabAction];
						addFlag(args, "--tab", p.tab);
						addFlag(args, "--surface", p.surface);
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--title", p.title);
						addFlag(args, "--url", p.url);
						await execCmux(pi, args, { signal, timeout });
						payload = (await execCmuxRpc(pi, "surface.list", {}, { signal, timeout })).data;
						break;
					}
					case "health": {
						const args = ["surface-health"];
						addFlag(args, "--workspace", p.workspace);
						const result = await execCmux(pi, args, { signal, timeout });
						payload = { text: result.stdout.trim() };
						break;
					}
					case "flash": {
						const args = ["trigger-flash"];
						addFlag(args, "--workspace", p.workspace);
						addFlag(args, "--surface", p.surface);
						await execCmux(pi, args, { signal, timeout });
						payload = { flashed: true, workspace: p.workspace || null, surface: p.surface || null };
						break;
					}
					default:
						throw new Error(`Unsupported surface action: ${p.action}`);
				}

				return ok(renderSurfaceResult(p.action, payload), {
					action: p.action,
					payload,
				});
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_surface",
					action: p.action,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser",
		label: "cmux Browser",
		description:
			"Control cmux browser surfaces for navigation, DOM interaction, waiting, snapshots, screenshots, JavaScript evaluation, tab management, and state persistence.",
		promptSnippet:
			"Use when the user wants browser work to happen inside a cmux browser surface instead of the standalone browser tool.",
		parameters: Type.Object({
			action: StringEnum(
				[
					"identify",
					"open",
					"open_split",
					"navigate",
					"back",
					"forward",
					"reload",
					"url",
					"snapshot",
					"click",
					"dblclick",
					"hover",
					"focus",
					"check",
					"uncheck",
					"scroll_into_view",
					"type",
					"fill",
					"press",
					"keydown",
					"keyup",
					"select",
					"scroll",
					"get",
					"is",
					"find",
					"highlight",
					"eval",
					"wait",
					"screenshot",
					"tab_list",
					"tab_new",
					"tab_switch",
					"tab_close",
					"state_save",
					"state_load",
					"addinitscript",
					"addscript",
					"addstyle",
				] as const,
				{ description: "Browser action to perform against a cmux browser surface." },
			),
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			url: Type.Optional(Type.String({ description: "URL for open or navigate actions." })),
			selector: Type.Optional(Type.String({ description: "CSS selector for DOM-targeted actions." })),
			text: Type.Optional(Type.String({ description: "Text for type, fill, find, or wait actions." })),
			key: Type.Optional(Type.String({ description: "Keyboard key for press/keydown/keyup." })),
			value: Type.Optional(Type.String({ description: "Selection value for select action." })),
			property: Type.Optional(
				StringEnum(
					["url", "title", "text", "html", "value", "attr", "count", "box", "styles"] as const,
					{ description: "Property kind for browser get." },
				),
			),
			attribute: Type.Optional(Type.String({ description: "Attribute name for get attr." })),
			statePath: Type.Optional(Type.String({ description: "Path for browser state save/load." })),
			outPath: Type.Optional(Type.String({ description: "Path for screenshot output." })),
			js: Type.Optional(Type.String({ description: "JavaScript snippet for eval/addscript/addinitscript." })),
			css: Type.Optional(Type.String({ description: "CSS text for addstyle." })),
			interactive: Type.Optional(Type.Boolean({ description: "Use interactive snapshot mode." })),
			cursor: Type.Optional(Type.Boolean({ description: "Include cursor in snapshot." })),
			compact: Type.Optional(Type.Boolean({ description: "Use compact snapshot mode." })),
			maxDepth: Type.Optional(Type.Integer({ description: "Max depth for browser snapshot." })),
			snapshotAfter: Type.Optional(Type.Boolean({ description: "Capture a snapshot after action execution." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Wait or command timeout in milliseconds." })),
			loadState: Type.Optional(
				StringEnum(["interactive", "complete"] as const, { description: "Target load state for wait." }),
			),
			urlContains: Type.Optional(Type.String({ description: "Substring to wait for in the page URL." })),
			waitFunction: Type.Optional(Type.String({ description: "JavaScript function body/expression for browser wait --function." })),
			dx: Type.Optional(Type.Integer({ description: "Horizontal scroll delta." })),
			dy: Type.Optional(Type.Integer({ description: "Vertical scroll delta." })),
			findKind: Type.Optional(
				StringEnum(
					["role", "text", "label", "placeholder", "alt", "title", "testid", "first", "last", "nth"] as const,
					{ description: "Finder mode for browser find." },
				),
			),
			index: Type.Optional(Type.Integer({ description: "Index for tab_switch or find nth." })),
			checkState: Type.Optional(
				StringEnum(["visible", "enabled", "checked"] as const, { description: "Predicate for browser is." }),
			),
			jsonOutput: Type.Optional(Type.Boolean({ description: "Request JSON screenshot output when supported." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			const args = ["browser"] as string[];
			addFlag(args, "--surface", p.surface);

			try {
				let result: any = null;
				switch (p.action) {
					case "identify":
						args.push("identify");
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "open":
						args.push("open");
						if (p.url) args.push(p.url);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "open_split":
						args.push("open-split");
						if (p.url) args.push(p.url);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "navigate":
						if (!p.url) throw new Error("url is required for navigate");
						args.push("navigate", p.url);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "back":
					case "forward":
					case "reload":
						args.push(p.action);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "url":
						args.push("url");
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "snapshot":
						args.push("snapshot");
						if (p.interactive) args.push("-i");
						addBoolFlag(args, "--cursor", p.cursor);
						addBoolFlag(args, "--compact", p.compact);
						addFlag(args, "--max-depth", p.maxDepth);
						addFlag(args, "--selector", p.selector);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "click":
					case "dblclick":
					case "hover":
					case "focus":
					case "check":
					case "uncheck": {
						if (!p.selector) throw new Error(`selector is required for ${p.action}`);
						args.push(p.action, p.selector);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "scroll_into_view": {
						if (!p.selector) throw new Error("selector is required for scroll_into_view");
						args.push("scroll-into-view", p.selector);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "type":
					case "fill": {
						if (!p.selector) throw new Error(`selector is required for ${p.action}`);
						args.push(p.action, p.selector);
						if (typeof p.text === "string") args.push(p.text);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "press":
					case "keydown":
					case "keyup": {
						if (!p.key) throw new Error(`key is required for ${p.action}`);
						args.push(p.action, p.key);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "select": {
						if (!p.selector || typeof p.value !== "string") {
							throw new Error("selector and value are required for select");
						}
						args.push("select", p.selector, p.value);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "scroll":
						args.push("scroll");
						addFlag(args, "--selector", p.selector);
						addFlag(args, "--dx", p.dx);
						addFlag(args, "--dy", p.dy);
						addBoolFlag(args, "--snapshot-after", p.snapshotAfter);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "get": {
						if (!p.property) throw new Error("property is required for get");
						args.push("get", p.property);
						if (["text", "html", "value", "count", "box", "styles"].includes(p.property)) {
							if (!p.selector) throw new Error(`selector is required for browser get ${p.property}`);
							args.push(p.selector);
						} else if (p.property === "attr") {
							if (!p.selector || !p.attribute) {
								throw new Error("selector and attribute are required for browser get attr");
							}
							args.push(p.selector, p.attribute);
						}
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "is": {
						if (!p.checkState || !p.selector) {
							throw new Error("checkState and selector are required for is");
						}
						args.push("is", p.checkState, p.selector);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "find": {
						if (!p.findKind) throw new Error("findKind is required for find");
						args.push("find", p.findKind);
						if (["role", "text", "label", "placeholder", "alt", "title", "testid"].includes(p.findKind)) {
							if (typeof p.text !== "string") throw new Error(`text is required for browser find ${p.findKind}`);
							args.push(p.text);
						} else if (p.findKind === "nth") {
							if (typeof p.index !== "number") throw new Error("index is required for browser find nth");
							args.push(String(p.index));
						}
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "highlight": {
						if (!p.selector) throw new Error("selector is required for highlight");
						args.push("highlight", p.selector);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "eval": {
						if (!p.js) throw new Error("js is required for eval");
						args.push("eval", p.js);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "wait":
						args.push("wait");
						addFlag(args, "--selector", p.selector);
						addFlag(args, "--text", p.text);
						addFlag(args, "--url-contains", p.urlContains);
						addFlag(args, "--load-state", p.loadState);
						addFlag(args, "--function", p.waitFunction);
						addFlag(args, "--timeout-ms", timeout);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "screenshot":
						args.push("screenshot");
						addFlag(args, "--out", p.outPath);
						addBoolFlag(args, "--json", p.jsonOutput);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "tab_list":
						args.push("tab", "list");
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "tab_new":
						args.push("tab", "new");
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "tab_switch":
						if (typeof p.index !== "number") throw new Error("index is required for tab_switch");
						args.push("tab", "switch", String(p.index));
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "tab_close":
						args.push("tab", "close");
						if (typeof p.index === "number") args.push(String(p.index));
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					case "state_save":
					case "state_load": {
						if (!p.statePath) throw new Error("statePath is required for state save/load");
						args.push("state", p.action === "state_save" ? "save" : "load", p.statePath);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "addinitscript":
					case "addscript": {
						if (!p.js) throw new Error(`js is required for ${p.action}`);
						args.push(p.action, p.js);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					case "addstyle": {
						if (!p.css) throw new Error("css is required for addstyle");
						args.push("addstyle", p.css);
						result = (await execCmux(pi, args, { signal, timeout })).stdout.trim();
						break;
					}
					default:
						throw new Error(`Unsupported browser action: ${p.action}`);
				}

				const parsed = parseJson(result);
				return ok(renderBrowserResult(p.action, parsed ?? result), {
					action: p.action,
					result: parsed ?? result,
				});
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_browser",
					action: p.action,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_pi_agent",
		label: "cmux Pi Agent",
		description:
			"Launch independent Pi terminals inside cmux, keep an alias registry, send prompts to running Pi instances, broadcast work to multiple agents, capture their terminal output, focus them, interrupt them, or close them.",
		promptSnippet:
			"Use when the user wants cmux to spin up multiple independent Pi agents and orchestrate communication between them.",
		parameters: Type.Object({
			action: StringEnum(
				[
					"list",
					"status",
					"launch",
					"launch_many",
					"message",
					"ask",
					"broadcast",
					"capture",
					"capture_many",
					"tail",
					"focus",
					"interrupt",
					"close",
					"remove",
					"heal",
					"resume",
					"prune",
				] as const,
				{ description: "Pi-agent orchestration action." },
			),
			alias: Type.Optional(Type.String({ description: "Primary agent alias for launch, message, ask, capture, focus, interrupt, close, or remove." })),
			aliases: Type.Optional(Type.Array(Type.String(), { description: "Multiple agent aliases for broadcast or capture_many." })),
			message: Type.Optional(Type.String({ description: "Prompt or message to send to a running Pi instance." })),
			prompt: Type.Optional(Type.String({ description: "Initial bootstrap prompt for a newly launched Pi agent." })),
			workspace: Type.Optional(Type.String({ description: "Target workspace ref, id, or index." })),
			workspaceTitle: Type.Optional(Type.String({ description: "Workspace title when launching into a new workspace." })),
			target: Type.Optional(
				StringEnum(["new_workspace", "split", "pane", "surface"] as const, {
					description: "Where to launch the Pi instance. Default: split.",
				}),
			),
			direction: Type.Optional(
				StringEnum(["left", "right", "up", "down"] as const, {
					description: "Split direction for split or pane launch targets.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory to use before launching Pi." })),
			provider: Type.Optional(Type.String({ description: "Optional Pi provider override." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model override." })),
			thinking: Type.Optional(Type.String({ description: "Optional Pi thinking level override." })),
			tools: Type.Optional(Type.String({ description: "Optional Pi tool allowlist, e.g. read,bash,edit,write." })),
			noExtensions: Type.Optional(Type.Boolean({ description: "Launch Pi with --no-extensions." })),
			noSkills: Type.Optional(Type.Boolean({ description: "Launch Pi with --no-skills." })),
			sessionPath: Type.Optional(Type.String({ description: "Optional fixed Pi session path for the launched instance." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional raw arguments to append to the Pi command." })),
			pane: Type.Optional(Type.String({ description: "Optional target pane for target=surface launches." })),
			surface: Type.Optional(Type.String({ description: "Optional surface ref for split anchoring or direct message/capture addressing." })),
			appendEnter: Type.Optional(Type.Boolean({ description: "Append Enter after sending a message. Default true." })),
			lines: Type.Optional(Type.Integer({ description: "Number of lines to capture from a Pi terminal." })),
			scrollback: Type.Optional(Type.Boolean({ description: "Include scrollback when capturing. Default true." })),
			delayMs: Type.Optional(Type.Integer({ description: "Delay before capture for ask or broadcast workflows." })),
			closeSurface: Type.Optional(Type.Boolean({ description: "When action=close, close the cmux surface after optional interrupt." })),
			specs: Type.Optional(
				Type.Array(
					Type.Object({
						alias: Type.String({ description: "Agent alias." }),
						prompt: Type.Optional(Type.String({ description: "Initial prompt for this agent." })),
						cwd: Type.Optional(Type.String({ description: "Working directory for this agent." })),
						workspace: Type.Optional(Type.String({ description: "Target workspace for this agent." })),
						workspaceTitle: Type.Optional(Type.String({ description: "Workspace title when target=new_workspace." })),
						target: Type.Optional(StringEnum(["new_workspace", "split", "pane", "surface"] as const)),
						direction: Type.Optional(StringEnum(["left", "right", "up", "down"] as const)),
						provider: Type.Optional(Type.String()),
						model: Type.Optional(Type.String()),
						thinking: Type.Optional(Type.String()),
						tools: Type.Optional(Type.String()),
						sessionPath: Type.Optional(Type.String()),
						extraArgs: Type.Optional(Type.Array(Type.String())),
					}),
					{ description: "Multiple launch specs for action=launch_many." },
				),
			),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				switch (p.action) {
					case "list": {
						const registry = readAgentRegistry();
						const live = await liveSurfaceMap(pi, signal, timeout);
						const aliases = Object.keys(registry.agents || {}).sort();
						const lines = ["# cmux Pi agents", ""];
						const bridgeStatuses = listBridgeStatuses();
						for (const alias of aliases) {
							const record = registry.agents[alias];
							const surface = record?.surface ? live.get(record.surface) : null;
							const tailSummary = summarizeSessionTail(record);
							const bridge = bridgeStatusForAgent(record, bridgeStatuses);
							lines.push(
								`- ${alias} ${surface ? "[live]" : "[offline]"} status=${record.status || (surface ? "ready" : "offline")} team=${record.team || "—"} role=${record.role || "—"} workspace=${record.workspace || "?"}${record.workspaceTitle ? ` workspaceTitle=\"${record.workspaceTitle}\"` : ""} surface=${record.surface || "?"}${record.surfaceTitle ? ` surfaceTitle=\"${record.surfaceTitle}\"` : ""} cwd=${record.cwd || "?"}${record.model ? ` model=${record.model}` : ""}${bridge?.lastEventType ? ` bridge=${bridge.lastEventType}/${bridge.bridgeAge?.stale ? "stale" : "fresh"}` : ""}${tailSummary ? ` summary=\"${tailSummary}\"` : record.promptSummary ? ` prompt=\"${record.promptSummary}\"` : ""}`,
							);
						}
						if (!aliases.length) lines.push("- No registered Pi agents.");
						return ok(lines.join("\n"), { registry, liveCount: live.size });
					}
					case "status": {
						if (!p.alias) throw new Error("alias is required for status");
						const record = resolveAgentRecord(p.alias);
						const live = await liveSurfaceMap(pi, signal, timeout).catch(() => new Map());
						const liveSurface = record?.surface ? live.get(record.surface) : null;
						const bridge = bridgeStatusForAgent(record);
						return ok(renderAgentStatus({ ...record, bridge }, liveSurface), { record, bridge, live: Boolean(liveSurface) });
					}
					case "launch": {
						const launched = await launchPiAgent(pi, p, ctx, signal);
						return ok(
							[
								`# launched cmux Pi agent ${launched.record.alias}`,
								"",
								`- workspace: ${launched.workspaceRef}`,
								`- surface: ${launched.surfaceRef}`,
								`- cwd: ${launched.record.cwd || "current"}`,
								`- target: ${launched.record.target}`,
								"",
								"```sh",
								launched.launchCommand,
								"```",
							].join("\n"),
							launched,
						);
					}
					case "launch_many": {
						if (!Array.isArray(p.specs) || !p.specs.length) {
							throw new Error("specs is required for launch_many");
						}
						const launched = [] as any[];
						for (const spec of p.specs) {
							launched.push(
								await launchPiAgent(
									pi,
									{
										...p,
										...spec,
									},
									ctx,
									signal,
								),
							);
						}
						return ok(
							[
								"# launched cmux Pi agents",
								"",
								...launched.map((item) => `- ${item.record.alias}: workspace=${item.workspaceRef} surface=${item.surfaceRef}`),
							].join("\n"),
							{ launched },
						);
					}
					case "message": {
						if (!p.message) throw new Error("message is required for action=message");
						const sent = await sendAgentMessage(
							pi,
							{ alias: p.alias, workspace: p.workspace, surface: p.surface },
							p.message,
							{ appendEnter: p.appendEnter !== false, signal, timeout },
						);
						return ok(
							[
								"# message sent to cmux Pi agent",
								"",
								`- alias: ${sent.alias || "—"}`,
								`- workspace: ${sent.workspace || "—"}`,
								`- surface: ${sent.surface}`,
								`- message: ${summarize(sent.message, 240)}`,
							].join("\n"),
							sent,
						);
					}
					case "ask": {
						if (!p.message) throw new Error("message is required for action=ask");
						const sent = await sendAgentMessage(
							pi,
							{ alias: p.alias, workspace: p.workspace, surface: p.surface },
							p.message,
							{ appendEnter: p.appendEnter !== false, signal, timeout },
						);
						await sleep(p.delayMs ?? 1500);
						const capture = await captureAgentScreen(
							pi,
							{ alias: p.alias || undefined, workspace: sent.workspace || undefined, surface: sent.surface },
							{ lines: p.lines ?? 200, scrollback: p.scrollback !== false, signal, timeout },
						);
						return ok(
							[
								`# ask result for ${capture.alias || capture.surface}`,
								"",
								"## Screen",
								"```text",
								capture.text,
								"```",
							].join("\n"),
							{ sent, capture },
						);
					}
					case "broadcast": {
						if (!p.message) throw new Error("message is required for action=broadcast");
						if (!Array.isArray(p.aliases) || !p.aliases.length) {
							throw new Error("aliases is required for action=broadcast");
						}
						const sent = [] as any[];
						for (const alias of p.aliases) {
							sent.push(
								await sendAgentMessage(pi, { alias }, p.message, {
									appendEnter: p.appendEnter !== false,
									signal,
									timeout,
								}),
							);
						}
						const lines = ["# broadcast sent", "", ...sent.map((item) => `- ${item.alias || item.surface}: ${item.surface}`)];
						if (p.delayMs) {
							await sleep(p.delayMs);
							const captures = [] as any[];
							for (const item of sent) {
								captures.push(
									await captureAgentScreen(pi, { alias: item.alias, workspace: item.workspace, surface: item.surface }, {
										lines: p.lines ?? 120,
										scrollback: p.scrollback !== false,
										signal,
										timeout,
									}),
								);
							}
							lines.push("", "## Captures");
							for (const capture of captures) {
								lines.push("", `### ${capture.alias || capture.surface}`, "```text", capture.text, "```");
							}
							return ok(lines.join("\n"), { sent, captures });
						}
						return ok(lines.join("\n"), { sent });
					}
					case "capture": {
						const capture = await captureAgentScreen(
							pi,
							{ alias: p.alias, workspace: p.workspace, surface: p.surface },
							{ lines: p.lines ?? 200, scrollback: p.scrollback !== false, signal, timeout },
						);
						return ok(
							[
								`# capture ${capture.alias || capture.surface}`,
								"",
								"```text",
								capture.text,
								"```",
							].join("\n"),
							capture,
						);
					}
					case "capture_many": {
						if (!Array.isArray(p.aliases) || !p.aliases.length) {
							throw new Error("aliases is required for action=capture_many");
						}
						const captures = [] as any[];
						for (const alias of p.aliases) {
							captures.push(
								await captureAgentScreen(pi, { alias }, {
									lines: p.lines ?? 200,
									scrollback: p.scrollback !== false,
									signal,
									timeout,
								}),
							);
						}
						const lines = ["# captures", ""];
						for (const capture of captures) {
							lines.push(`## ${capture.alias || capture.surface}`, "```text", capture.text, "```", "");
						}
						return ok(lines.join("\n"), { captures });
					}
					case "tail": {
						if (!p.alias) throw new Error("alias is required for tail");
						const record = resolveAgentRecord(p.alias);
						const tail = parseSessionTail(record.sessionPath, p.lines ?? 80);
						return ok([
							`# tail ${p.alias}`,
							"",
							"```text",
							tail?.lastAssistantText || "No assistant session output found.",
							"```",
						].join("\n"), { record, tail });
					}
					case "focus": {
						const record = p.alias ? resolveAgentRecord(p.alias) : { workspace: p.workspace, surface: p.surface };
						if (!record.surface) throw new Error("surface is required for focus");
						await execCmuxRpc(
							pi,
							"surface.focus",
							{
								surface_id: record.surface,
								...(record.workspace ? { workspace_id: record.workspace } : {}),
							},
							{ signal, timeout },
						);
						return ok(`# focused ${p.alias || record.surface}`, { focused: true, target: record });
					}
					case "interrupt": {
						const record = p.alias ? resolveAgentRecord(p.alias) : { workspace: p.workspace, surface: p.surface };
						if (!record.surface) throw new Error("surface is required for interrupt");
						const args = ["send-key"];
						addFlag(args, "--workspace", record.workspace);
						addFlag(args, "--surface", record.surface);
						args.push("ctrl+c");
						await execCmux(pi, args, { signal, timeout });
						return ok(`# interrupted ${p.alias || record.surface} with Ctrl+C`, { interrupted: true, target: record });
					}
					case "close": {
						const record = p.alias ? resolveAgentRecord(p.alias) : { workspace: p.workspace, surface: p.surface };
						if (!record.surface) throw new Error("surface is required for close");
						const interruptArgs = ["send-key"];
						addFlag(interruptArgs, "--workspace", record.workspace);
						addFlag(interruptArgs, "--surface", record.surface);
						interruptArgs.push("ctrl+c");
						await execCmux(pi, interruptArgs, { signal, timeout: Math.min(timeout, 10_000) }).catch(() => null);
						if (p.closeSurface !== false) {
							const closeArgs = ["close-surface"];
							addFlag(closeArgs, "--workspace", record.workspace);
							addFlag(closeArgs, "--surface", record.surface);
							await execCmux(pi, closeArgs, { signal, timeout });
						}
						if (p.alias) removeAgentRecord(p.alias);
						return ok(`# closed ${p.alias || record.surface}`, { closed: true, target: record });
					}
					case "remove": {
						if (!p.alias) throw new Error("alias is required for remove");
						const removed = removeAgentRecord(p.alias);
						return ok(`# removed registry entry ${p.alias}`, { removed });
					}
					case "heal":
					case "resume": {
						if (!p.alias) throw new Error("alias is required for heal/resume");
						const record = resolveAgentRecord(p.alias);
						const healed = await healAgentRecord(pi, record, ctx, signal, { timeout });
						return ok(renderAgentStatus(healed.record, true), { healed });
					}
					case "prune": {
						const pruned = await pruneOfflineAgents(pi, signal, timeout);
						return ok(
							[
								"# pruned offline cmux Pi agents",
								"",
								...((pruned.removed || []).length ? pruned.removed.map((item: any) => `- ${item.alias}`) : ["- No offline agents removed."]),
							].join("\n"),
							pruned,
						);
					}
					default:
						throw new Error(`Unsupported cmux_pi_agent action: ${p.action}`);
				}
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_pi_agent",
					action: p.action,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_pi_team",
		label: "cmux Pi Team",
		description:
			"Create and orchestrate Pi teams or multi-team swarms inside cmux, auto-size the agent roster when needed, assign providers/models by role or task, relay updates between agents, gather outputs, inspect status, and shut teams down.",
		promptSnippet:
			"Use for higher-level swarm orchestration: keep one workspace per team by default, one Pi terminal per agent, honor requested agent or team counts, assign models deliberately when requested, coordinate rather than doing the same task work yourself, and shut down one-off teams when the run is complete unless they should be reused.",
		parameters: Type.Object({
			action: StringEnum(
				[
					"list",
					"presets",
					"status",
					"plan",
					"benchmark",
					"scorecard",
					"failure_report",
					"create",
					"task",
					"gather",
					"capture",
					"orchestrate",
					"resume",
					"continue",
					"report",
					"macro",
					"steer",
					"pause",
					"heal",
					"rebalance",
					"prune",
					"runs",
					"mission_control",
					"run_status",
					"timeline",
					"artifacts",
					"doctor",
					"repair",
					"shutdown",
					"retention",
					"remove",
				] as const,
				{ description: "Team orchestration action." },
			),
			team: Type.Optional(Type.String({ description: "Primary team name or base name for multi-team swarms." })),
			teamNames: Type.Optional(Type.Array(Type.String(), { description: "Explicit team names when operating on multiple teams at once." })),
			runId: Type.Optional(Type.String({ description: "Run identifier for orchestration history and resume flows." })),
			pendingId: Type.Optional(Type.String({ description: "Pending team-retention id for action=retention." })),
			teamCount: Type.Optional(Type.Integer({ description: "How many teams to form. Uses team as the base name and appends -2, -3, and so on when needed." })),
			teamTemplateId: Type.Optional(Type.String({ description: "Reusable saved team template id to relaunch. Use cmux_pi_team action=retention teamRetentionDecision=list to discover templates." })),
			agentCount: Type.Optional(Type.Integer({ description: "Requested number of agents per team when specs or roles are not provided. If omitted, the orchestrator auto-sizes from task complexity." })),
			includeManager: Type.Optional(Type.Boolean({ description: "Include a manager role in auto-generated teams. Defaults to automatic behavior based on swarm size." })),
			includeCoordinator: Type.Optional(Type.Boolean({ description: "Include a coordinator role in auto-generated teams. Defaults to automatic behavior based on swarm size." })),
			includeLead: Type.Optional(Type.Boolean({ description: "Include an explicit lead role for each team. Default: auto for teams with 3+ agents when no manager is present." })),
			goal: Type.Optional(Type.String({ description: "Overall mission used when creating a team." })),
			task: Type.Optional(Type.String({ description: "Task to dispatch to all team members." })),
			extraGuidance: Type.Optional(Type.String({ description: "Additional coordinator guidance to include with team task dispatch and follow-up rounds." })),
			message: Type.Optional(Type.String({ description: "Operator control message for steer/pause/report-style actions." })),
			operatorMacro: Type.Optional(StringEnum(["blocker-report", "synthesis-now", "pause-and-summarize", "redirect-milestone"] as const, { description: "High-level operator macro for common command-and-control actions." })),
			milestone: Type.Optional(Type.String({ description: "Milestone text used by the redirect-milestone macro." })),
			reportMode: Type.Optional(StringEnum(["progress", "blockers", "synthesis"] as const, { description: "For report: whether to request a progress snapshot, blocker-only report, or synthesis now." })),
			steerScope: Type.Optional(StringEnum(["leads", "all"] as const, { description: "For steer: send the operator message to team leads only or all agents. Default leads." })),
			roles: Type.Optional(Type.Array(Type.String(), { description: "Default roles to create when specs are not provided. If agentCount is larger, extra generic agents are added automatically." })),
			layout: Type.Optional(
				StringEnum(["shared_workspace", "separate_workspaces"] as const, {
					description: "Whether team members share one cmux workspace or get separate workspaces.",
				}),
			),
			workspace: Type.Optional(Type.String({ description: "Existing workspace ref/id/index to use for shared_workspace layouts." })),
			workspaceTitle: Type.Optional(Type.String({ description: "Workspace title when creating a new shared workspace." })),
			direction: Type.Optional(
				StringEnum(["left", "right", "up", "down"] as const, {
					description: "Preferred split direction for shared workspace launches.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for launched team members." })),
			modelPreset: Type.Optional(Type.String({ description: "Named model-routing preset loaded from project or user preset config, for example personal-default. Use auto or omit it to let the orchestrator infer the best preset from the user's request." })),
			modelPresetFile: Type.Optional(Type.String({ description: "Optional explicit JSON file path for model presets. Supports publishable/shared preset packs." })),
			provider: Type.Optional(Type.String({ description: "Optional provider override for launched Pi instances." })),
			model: Type.Optional(Type.String({ description: "Optional default model override for launched Pi instances." })),
			models: Type.Optional(Type.Array(Type.String(), { description: "Ordered model pool for automatic role/task-based assignment. By default: first=primary/strongest, second=balanced, third=economy/fallback." })),
			modelStrategy: Type.Optional(StringEnum(["role_specialized", "round_robin", "homogeneous"] as const, { description: "How to assign models from the model pool when specs do not explicitly set a model." })),
			roleModelMap: Type.Optional(Type.Array(Type.Object({
				role: Type.String({ description: "Role name such as planner, coder, reviewer, manager, researcher, or * for default." }),
				model: Type.Optional(Type.String({ description: "Optional model to use for this role. If omitted, the provider default may be used." })),
				provider: Type.Optional(Type.String({ description: "Optional provider override for this role's model." })),
			}))),
			thinking: Type.Optional(Type.String({ description: "Optional thinking level override for launched Pi instances." })),
			tools: Type.Optional(Type.String({ description: "Optional Pi tool allowlist." })),
			sessionPath: Type.Optional(Type.String({ description: "Optional fixed session path for launched Pi instances." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional raw Pi CLI arguments for launched members." })),
			delayMs: Type.Optional(Type.Integer({ description: "Delay before the first capture round during orchestrate. Default 2500." })),
			checkInIntervalMs: Type.Optional(Type.Integer({ description: "Delay between later coordination rounds. Defaults to delayMs." })),
			rounds: Type.Optional(Type.Integer({ description: "Minimum capture-and-coordinate rounds to run during orchestrate before considering completion. Default 2." })),
			continueUntilComplete: Type.Optional(Type.Boolean({ description: "After the minimum rounds, keep coordinating until the swarm appears complete or maxRounds is reached. Default true." })),
			maxRounds: Type.Optional(Type.Integer({ description: "Maximum total orchestration rounds when continueUntilComplete is enabled. Default 6." })),
			shareFindings: Type.Optional(Type.Boolean({ description: "Relay captured findings back to agents between rounds. Default true." })),
			escalateBlockers: Type.Optional(Type.Boolean({ description: "When blockers are detected in agent captures, send escalation prompts to team leads and swarm leads. Default true." })),
			finalSynthesis: Type.Optional(Type.Boolean({ description: "Have a lead agent produce a final cross-team synthesis report at the end of orchestration. Default true." })),
			synthesisAlias: Type.Optional(Type.String({ description: "Specific agent alias to use for the final synthesis report instead of the default swarm lead." })),
			synthesisDelayMs: Type.Optional(Type.Integer({ description: "Delay before capturing the final synthesis report. Default 2000." })),
			lines: Type.Optional(Type.Integer({ description: "Lines to gather from each member terminal." })),
			scrollback: Type.Optional(Type.Boolean({ description: "Include scrollback when gathering captures. Default true." })),
			reuseExisting: Type.Optional(Type.Boolean({ description: "Prefer reusing existing live teams when no explicit team/teamNames are provided. Default true for non-destructive follow-up actions." })),
			appendEnter: Type.Optional(Type.Boolean({ description: "Append Enter after sending team task messages. Default true." })),
			createIfMissing: Type.Optional(Type.Boolean({ description: "For orchestrate, create missing teams automatically. Default true." })),
			executeSafeRepairs: Type.Optional(Type.Boolean({ description: "For doctor/repair flows, execute the bounded safe-repair allowlist instead of only reporting it." })),
			repairActionLimit: Type.Optional(Type.Integer({ description: "Maximum number of safe repair actions to execute in one repair pass. Default 8." })),
			shutdownOnComplete: Type.Optional(Type.Boolean({ description: "Legacy lifecycle override. true destroys live teams after completion; false keeps them live. Prefer teamRetentionDecision for completed-run lifecycle." })),
			teamRetentionDecision: Type.Optional(StringEnum(["ask", "save", "destroy", "keep-live", "auto", "list"] as const, { description: "Completed-run team lifecycle. Default destroy shuts down/discards spawned live team workspaces; ask closes live team workspaces and asks whether to save the reusable template; save archives template then shuts down; keep-live leaves the team running; list shows saved/pending templates." })),
			saveTeamForFutureUse: Type.Optional(Type.Boolean({ description: "Convenience lifecycle flag: true saves a reusable team template after completion, false destroys/discards after completion." })),
			closeSurface: Type.Optional(Type.Boolean({ description: "For shutdown, close cmux surfaces after interrupting them. Default true." })),
			closeWorkspaceOnShutdown: Type.Optional(Type.Boolean({ description: "When shutting down a team, also close its workspace(s). Default true." })),
			specs: Type.Optional(
				Type.Array(
					Type.Object({
						alias: Type.String({ description: "Unique alias for this member." }),
						role: Type.Optional(Type.String({ description: "Member role such as planner/coder/reviewer." })),
						prompt: Type.Optional(Type.String({ description: "Custom bootstrap prompt for this member." })),
						cwd: Type.Optional(Type.String()),
						provider: Type.Optional(Type.String()),
						model: Type.Optional(Type.String()),
						thinking: Type.Optional(Type.String()),
						tools: Type.Optional(Type.String()),
						sessionPath: Type.Optional(Type.String()),
						extraArgs: Type.Optional(Type.Array(Type.String())),
						target: Type.Optional(StringEnum(["new_workspace", "split", "pane", "surface"] as const)),
						workspace: Type.Optional(Type.String()),
						workspaceTitle: Type.Optional(Type.String()),
						direction: Type.Optional(StringEnum(["left", "right", "up", "down"] as const)),
					}),
					{ description: "Optional explicit team-member launch specs." },
				),
			),
			benchmarkScenario: Type.Optional(Type.String({ description: "Built-in orchestration benchmark scenario name, for example solo-3-agent or dependency-deadlock." })),
			benchmarkScenarios: Type.Optional(Type.Array(Type.String(), { description: "Optional list of built-in benchmark scenario names. Defaults to the full benchmark suite for benchmark/scorecard/failure_report actions." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawParams = params as any;
			const p = applyTeamTemplateParams(rawParams);
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				switch (p.action) {
					case "list": {
						const registry = readTeamRegistry();
						const live = await liveSurfaceMap(pi, signal, timeout);
						const teams = Object.keys(registry.teams || {}).sort();
						const lines = ["# cmux Pi teams", ""];
						for (const teamName of teams) {
							const teamRecord = registry.teams[teamName];
							const liveCount = (teamRecord.members || []).filter((member: any) => live.get(member.surface)).length;
							lines.push(`- ${teamName}: status=${teamRecord.status || "unknown"} run=${teamRecord.runId || "—"} members=${(teamRecord.members || []).length} live=${liveCount} layout=${teamRecord.layout || "unknown"}${teamRecord.workspaceTitle ? ` workspaceTitle=\"${teamRecord.workspaceTitle}\"` : ""}`);
						}
						if (!teams.length) lines.push("- No registered Pi teams.");
						return ok(lines.join("\n"), { registry });
					}
					case "presets": {
						const presetRegistry = loadModelPresetRegistry({ cwd: ctx?.cwd, baseDir: orchestratorDir(), presetFile: p.modelPresetFile });
						const presetNames = Object.keys(presetRegistry.presets || {}).sort();
						const recommendation = p.task || p.goal || p.description ? recommendModelPreset(p, presetRegistry) : null;
						const lines = ["# cmux Pi model presets", "", `- defaultPreset: ${presetRegistry.defaultPreset || "—"}`, `- loadedFrom: ${(presetRegistry.loadedPaths || []).join(", ") || "none"}`];
						if (recommendation?.name) {
							lines.push("", "## Recommendation", `- suggestedPreset: ${recommendation.name}`, `- source: ${recommendation.source}`, ...(recommendation.reasons?.length ? [`- why: ${recommendation.reasons.join(", ")}`] : []));
						}
						if (!presetNames.length) lines.push("", "- No model presets found.", "- Add ~/.pi/agent/.cmux-orchestrator/model-presets.json or ./cmux-orchestrator-model-presets.json");
						else {
							lines.push("", "## Presets");
							for (const presetName of presetNames) {
								const preset = presetRegistry.presets[presetName];
								lines.push(`- ${presetName}${presetRegistry.defaultPreset === presetName ? " [default]" : ""}: ${preset.description || "no description"}`);
								lines.push(`  provider=${preset.provider || "—"} model=${preset.model || "—"} strategy=${preset.modelStrategy || "—"} roles=${Array.isArray(preset.roleModelMap) ? preset.roleModelMap.length : 0}`);
							}
						}
						return ok(lines.join("\n"), { presetRegistry, recommendation });
					}
					case "status": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for status");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						// Enrich agent records with bridge-derived browser/pattern state
						for (const teamRecord of teamRecords) {
							const runId = teamRecord.runId;
							if (!runId) continue;
							const { agents: bridgeAgents } = ingestBridgeEventsIntoOrchestrator(runId);
							for (const member of teamRecord.members || []) {
								const bridgeState = bridgeAgents.get(member.alias);
								if (bridgeState) {
									const current = resolveAgentRecord(member.alias);
									upsertAgentRecord(applyBridgeStateToAgentRecord(current, bridgeState));
								}
							}
						}
						const live = await liveSurfaceMap(pi, signal, timeout);
						return ok(renderTeamCollectionSummary(teamRecords, live), { teams: teamRecords, teamResolution });
					}
					case "plan": {
						const prepared = prepareOutcomeExecution(p, ctx);
						const presetResolution = resolveModelPresetParams(prepared.params, ctx);
						const teamPlans = planPiTeams(presetResolution.params, ctx);
						const planId = presetResolution.params.runId || generateRunId("swarm-plan");
						const planningArtifacts = prepared.contract && prepared.plan
							? persistOutcomeExecutionArtifacts("plans", planId, prepared.contract, prepared.plan)
							: null;
						return ok([
							renderTeamPlanSummary(teamPlans),
							prepared.contract ? "" : "",
							prepared.contract ? renderOutcomeExecutionContract(prepared.contract) : "",
							prepared.plan ? "" : "",
							prepared.plan ? renderOutcomeExecutionPlan(prepared.plan) : "",
							planningArtifacts ? "" : "",
							planningArtifacts ? `- planning artifacts: ${planningArtifacts.artifactPaths.join(", ")}` : "",
							"",
							"## Routing",
							`- model preset: ${presetResolution.params.appliedModelPreset || presetResolution.params.modelPreset || "—"}`,
							`- preset source: ${presetResolution.presetSource || "none"}`,
							...(prepared.intent ? [`- outcome mode: ${prepared.intent.shouldActivate ? "activated" : "not-activated"}`, `- suggested execution mode: ${prepared.intent.suggestedMode}`] : []),
							...(presetResolution.recommendation?.reasons?.length ? [`- why: ${presetResolution.recommendation.reasons.join(", ")}`] : []),
						].filter(Boolean).join("\n"), { teamPlans, presetResolution, prepared, planningArtifacts, planId });
					}
					case "benchmark": {
						const names = p.benchmarkScenarios?.length ? p.benchmarkScenarios : p.benchmarkScenario ? [p.benchmarkScenario] : undefined;
						if (p.benchmarkScenario && !getBenchmarkScenario(p.benchmarkScenario)) throw new Error(`Unknown benchmarkScenario: ${p.benchmarkScenario}`);
						const reports = runBenchmarkSuite(names);
						const written = reports.map((report: any) => ({
							report,
							artifacts: writeBenchmarkArtifacts({
								baseDir: orchestratorDir(),
								report,
								benchmarkMarkdown: renderBenchmarkReport(report),
							}),
						}));
						return ok([
							renderBenchmarkSuiteSummary(reports),
							"",
							...written.flatMap((item: any) => [renderBenchmarkReport(item.report), "", `- artifacts: ${item.artifacts.artifactPaths.join(", ")}`, ""]),
						].filter(Boolean).join("\n"), { reports, written, scenarios: reports.map((report: any) => report.scenario.name) });
					}
					case "scorecard": {
						if (p.runId) {
							const evaluation = persistRunEvaluationArtifacts(p.runId);
							return ok([
								renderRunScorecardReport(evaluation.scorecardReport),
								"",
								`- artifacts: ${evaluation.written.artifactPaths.join(", ")}`,
							].join("\n"), { ...evaluation, runId: p.runId });
						}
						const names = p.benchmarkScenarios?.length ? p.benchmarkScenarios : p.benchmarkScenario ? [p.benchmarkScenario] : undefined;
						if (p.benchmarkScenario && !getBenchmarkScenario(p.benchmarkScenario)) throw new Error(`Unknown benchmarkScenario: ${p.benchmarkScenario}`);
						const reports = runBenchmarkSuite(names);
						const lines = [
							"# cmux orchestrator scorecard",
							"",
							...reports.map((report: any) => `- ${report.scenario.name}: score=${report.scorecard.overallScore} dispatchMs=${report.scorecard.dispatchLatencyMs ?? "—"} relayNoise=${report.scorecard.relayNoiseRatio ?? "—"} heartbeat=${report.scorecard.heartbeatUsefulness ?? "—"} unblock=${report.scorecard.unblockSuccessRate ?? "—"} completionAccuracy=${report.scorecard.completionAccuracy} falseComplete=${report.scorecard.falseCompleteRate ?? "—"}`),
						];
						return ok(lines.join("\n"), { reports, scenarios: reports.map((report: any) => report.scenario.name) });
					}
					case "failure_report": {
						if (p.runId) {
							const evaluation = persistRunEvaluationArtifacts(p.runId);
							return ok([
								renderRunFailureReport(evaluation.scorecardReport),
								"",
								`- artifacts: ${evaluation.written.artifactPaths.join(", ")}`,
							].join("\n"), { ...evaluation, runId: p.runId });
						}
						const names = p.benchmarkScenarios?.length ? p.benchmarkScenarios : p.benchmarkScenario ? [p.benchmarkScenario] : undefined;
						if (p.benchmarkScenario && !getBenchmarkScenario(p.benchmarkScenario)) throw new Error(`Unknown benchmarkScenario: ${p.benchmarkScenario}`);
						const reports = runBenchmarkSuite(names);
						const lines = [
							"# cmux orchestrator failure report",
							"",
							...reports.flatMap((report: any) => [
								`## ${report.scenario.name}`,
								`- missing agent output: ${report.failures.missingAgentOutput.join(", ") || "—"}`,
								`- stale bridge sessions: ${report.failures.staleBridgeSessions.join(", ") || "—"}`,
								`- partial team death: ${report.failures.partialTeamDeath.join(", ") || "—"}`,
								`- misleading done reports: ${report.failures.misleadingDoneReports.join(", ") || "—"}`,
								`- dependency deadlocks: ${report.failures.dependencyDeadlocks.join(", ") || "—"}`,
								"",
							]),
						];
						return ok(lines.join("\n"), { reports, scenarios: reports.map((report: any) => report.scenario.name) });
					}
					case "create": {
						rememberPrimaryActivityContext(ctx);
						const prepared = prepareOutcomeExecution(p, ctx);
						const presetResolution = resolveModelPresetParams(prepared.params, ctx);
						const operatorTarget = await resolveOperatorTarget(pi, signal, timeout).catch(() => null);
						const created = await createPiTeams(pi, { ...presetResolution.params, operatorTarget }, ctx, signal);
						const teamRecords = created.map((item: any) => item.teamRecord);
						const runId = teamRecords.find((teamRecord: any) => teamRecord?.runId)?.runId;
						if (runId) startPrimaryActivityMonitor(pi, runId, teamRecords, { stopOnComplete: true });
						return ok([
							renderTeamCollectionSummary(teamRecords),
							"",
							"## Routing",
							`- model preset: ${presetResolution.params.appliedModelPreset || presetResolution.params.modelPreset || "—"}`,
							`- preset source: ${presetResolution.presetSource || "none"}`,
							...(presetResolution.recommendation?.reasons?.length ? [`- why: ${presetResolution.recommendation.reasons.join(", ")}`] : []),
						].join("\n"), { created, teams: teamRecords, presetResolution });
					}
					case "task": {
						rememberPrimaryActivityContext(ctx);
						if (!p.task) throw new Error("task is required for task");
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for task");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const sent: any[] = [];
						for (const teamRecord of teamRecords) {
							sent.push(
								...(await dispatchTeamTask(pi, teamRecord, p.task, {
									extraGuidance: p.extraGuidance,
									appendEnter: p.appendEnter !== false,
									signal,
									timeout,
								})),
							);
						}
						const runIds = uniqueStrings(teamRecords.map((teamRecord: any) => teamRecord.runId).filter(Boolean));
						for (const runId of runIds) startPrimaryActivityMonitor(pi, runId, teamRecords.filter((teamRecord: any) => teamRecord.runId === runId), { stopOnComplete: true });
						return ok(
							[
								`# dispatched swarm task ${teamNames.join(", ")}`,
								"",
								...(teamResolution.reused ? [`- team reuse: ${teamNames.join(", ")} (${teamResolution.source})`, ""] : []),
								...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 120)}`),
							].join("\n"),
							{ sent, teams: teamRecords, teamResolution },
						);
					}
					case "gather": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for gather");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const captures = await gatherSwarmCaptures(pi, teamRecords, {
							lines: p.lines ?? DEFAULT_TEAM_CAPTURE_LINES,
							scrollback: p.scrollback !== false,
							signal,
							timeout,
						});
						return ok(
							[renderTeamCollectionSummary(teamRecords), "", renderCaptureSection(captures)].join("\n"),
							{ teams: teamRecords, captures, teamResolution },
						);
					}
					case "capture": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for capture");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const captures = await gatherSwarmCaptures(pi, teamRecords, {
							lines: p.lines ?? DEFAULT_TEAM_CAPTURE_LINES,
							scrollback: p.scrollback !== false,
							signal,
							timeout,
						});
						const digests = captures.map(buildCaptureDigest);
						updateAgentAndTeamStateFromDigests(teamRecords, digests);
						const captureRunId = p.runId || teamRecords.find((teamRecord: any) => teamRecord.runId)?.runId || null;
						let captureRound = 0;
						if (captureRunId) {
							try {
								captureRound = Number(resolveRunRecord(captureRunId)?.lastRoundNumber || 0) || 0;
							} catch {
								captureRound = 0;
							}
						}
						persistObservationSnapshots({
							runId: captureRunId,
							teamRecords,
							digests,
							round: captureRound,
							roundDecision: deriveRunStatus(digests),
						});
						if (captureRunId) persistMissionControlSnapshot(captureRunId, teamRecords);
						const report = digests.map((digest: any) => ({
							alias: digest.alias,
							role: digest.role,
							team: digest.team,
							status: digest.status,
							summary: digest.summary,
							blockers: digest.blockers || [],
							artifacts: digest.artifacts || [],
							commands: digest.commands || [],
							urls: digest.urls || [],
							deliverable: digest.deliverable || null,
							dependencies: digest.dependencies || [],
							completion: digest.completion,
							confidence: digest.confidence || null,
							next: digest.next || null,
							needs: digest.needs || null,
						}));
						const lines = ["# Team capture report", ""];
						for (const digest of report) {
							lines.push(
								`## ${digest.alias} (${digest.role}) [${digest.status}]`,
								digest.summary,
								...(digest.blockers.length ? [`- blockers: ${digest.blockers.join(" | ")}`] : []),
								...(digest.artifacts.length ? [`- artifacts: ${digest.artifacts.join(", ")}`] : []),
								...(digest.commands.length ? [`- commands: ${digest.commands.join(", ")}`] : []),
								...(digest.urls.length ? [`- urls: ${digest.urls.join(", ")}`] : []),
								...(digest.deliverable ? [`- deliverable: ${digest.deliverable}`] : []),
								...(digest.dependencies.length ? [`- dependencies: ${digest.dependencies.length} open`] : []),
								...(digest.completion ? [`- completion: yes`] : []),
								"",
							);
						}
						return ok(lines.join("\n"), { teams: teamRecords, report, digests, captures, teamResolution });
					}
					case "orchestrate": {
						rememberPrimaryActivityContext(ctx);
						if (!p.task) throw new Error("task is required for orchestrate");
						const prepared = prepareOutcomeExecution(p, ctx);
						const presetResolution = resolveModelPresetParams(prepared.params, ctx);
						const effective = presetResolution.params;
						const runId = effective.runId || generateRunId("swarm");
						const teamResolution = await resolveTeamNamesForAction(pi, effective, ctx, signal, { allowImplicitReuse: true, timeout });
						const requestedTeamNames = teamResolution.teamNames;
						if (!requestedTeamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for orchestrate");
						const existingTeamNames = requestedTeamNames.filter((teamName: string) => {
							try {
								resolveTeamRecord(teamName);
								return true;
							} catch {
								return false;
							}
						});
						const operatorTarget = await resolveOperatorTarget(pi, signal, timeout).catch(() => null);
						upsertRunRecord({
							runId,
							requestedShutdownOnComplete: effective.shutdownOnComplete,
							requestedTeamRetentionDecision: effective.teamRetentionDecision || null,
						});
						const teamRecords = await resolveOrCreatePiTeams(pi, { ...effective, teamNames: requestedTeamNames, runId, operatorTarget }, ctx, signal);
						startPrimaryActivityMonitor(pi, runId, teamRecords, { stopOnComplete: true });
						await stabilizeOperatorSidebar(pi, operatorTarget?.workspace, teamRecords.map((item: any) => item?.workspace), signal, timeout);
						const controlRoom = await getControlRoomSnapshot(pi, ctx, {
							cwd: ctx.cwd,
							runId,
							teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
						}, 8, { signal }).catch(() => null);
						const controlActions = await getControlRoomNextActions(pi, ctx, {
							cwd: ctx.cwd,
							runId,
							teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
						}, 8, { signal }).catch(() => null);
						const policyCheck = await checkApprovalPolicy(pi, ctx, {
							cwd: ctx.cwd,
							runId,
							teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
						}, buildAutoRiskSpecFromTask(`${effective.goal || ""}\n${p.task || ""}`, {
							targetCount: Array.isArray(effective.specs) ? effective.specs.length : inferTeamAgentCount(effective),
							requestedBy: requestedTeamNames[0] ? `${requestedTeamNames[0]}-lead` : "orchestrator",
						}), { signal }).catch(() => null);
						if (controlRoom) {
							await emitToolUpdate(onUpdate, `Control room snapshot: ${autoSummaryFromSnapshot(controlRoom)}`, { stage: "control_room", runId });
						}
						if (policyCheck?.policy?.shouldRequest) {
							await emitToolUpdate(onUpdate, `Approval policy check: ${policyCheck.policy.reasons?.[0] || "approval may be required for this orchestration."}`, { stage: "approval_policy", runId, policyCheck: policyCheck.policy });
						}
						const orchestration = await orchestrateTeamSwarm(pi, teamRecords, p.task, {
							operatorTarget,
							runId,
							extraGuidance: p.extraGuidance,
							appendEnter: effective.appendEnter !== false,
							delayMs: effective.delayMs ?? DEFAULT_SWARM_DELAY_MS,
							checkInIntervalMs: effective.checkInIntervalMs,
							lines: effective.lines ?? DEFAULT_TEAM_CAPTURE_LINES,
							scrollback: effective.scrollback !== false,
							rounds: effective.rounds ?? DEFAULT_SWARM_ROUNDS,
							continueUntilComplete: effective.continueUntilComplete !== false,
							maxRounds: effective.maxRounds ?? DEFAULT_MAX_ORCHESTRATION_ROUNDS,
							shareFindings: effective.shareFindings !== false,
							escalateBlockers: effective.escalateBlockers !== false,
							finalSynthesis: effective.finalSynthesis !== false,
							synthesisAlias: effective.synthesisAlias,
							synthesisDelayMs: effective.synthesisDelayMs ?? DEFAULT_SYNTHESIS_DELAY_MS,
							onProgress: async (payload: any) => {
								updatePrimaryActivityWidget(runId);
								await emitToolUpdate(onUpdate, payload.text, {
									stage: payload.stage,
									runId,
									...(payload.details || {}),
								});
							},
							signal,
							timeout,
						});
						let runRecord = resolveRunRecord(runId);
						const blockedCandidates = orchestration.rounds.flatMap((round: any) => round.blocked || []);
						const finalResultsDelivered = Boolean(
							runRecord?.status === "done" ||
							runRecord?.completedAt ||
							runRecord?.synthesisCompletion === true ||
							(orchestration.synthesis && runRecord?.completionGateSatisfied !== false && String(runRecord?.status || "") !== "blocked" && !blockedCandidates.length)
						);
						if (finalResultsDelivered && runRecord?.status !== "done") {
							upsertRunRecord({
								runId,
								status: "done",
								completedAt: runRecord?.completedAt || nowIso(),
								completionInferredFrom: runRecord?.synthesisCompletion === true ? "synthesis-complete" : "final-synthesis-delivered",
							});
							runRecord = resolveRunRecord(runId);
							appendRunEvent(runId, { type: "run_completion_inferred", status: "done", detail: "final synthesis delivered to primary Pi" });
						}
						const createdTeamNames = requestedTeamNames.filter((teamName: string) => !existingTeamNames.includes(teamName));
						const lifecycle = resolveCompletedTeamLifecycle(effective, {
							runCompleted: finalResultsDelivered,
							createdTeamNames,
							teamNames: requestedTeamNames,
						});
						const shutdownResults: any[] = [];
						let pendingRetention: any = null;
						let savedTemplates: any[] = [];
						let discardedTemplates: any[] = [];
						const latestTeamRecordsForLifecycle = requestedTeamNames.map((teamName: string) => {
							try { return resolveTeamRecord(teamName); } catch { return null; }
						}).filter(Boolean);
						if (lifecycle.shouldAsk) {
							pendingRetention = storePendingTeamRetention(runId, latestTeamRecordsForLifecycle, runRecord);
							appendRunEvent(runId, { type: "team_retention_question", status: "pending", detail: pendingRetention.pendingId });
						} else if (lifecycle.shouldSave) {
							const pending = storePendingTeamRetention(runId, latestTeamRecordsForLifecycle, runRecord);
							savedTemplates = promotePendingTeamRetention({ runId, pendingId: pending.pendingId });
							appendRunEvent(runId, { type: "team_retention_saved", status: "saved", detail: savedTemplates.map((template: any) => template.templateId).join(",") });
						} else if (lifecycle.shouldDestroy) {
							discardedTemplates = discardPendingTeamRetention({ runId, teamNames: requestedTeamNames });
							appendRunEvent(runId, { type: "team_retention_destroyed", status: "destroyed", detail: requestedTeamNames.join(",") });
						}
						const shouldShutdown = lifecycle.shouldShutdown;
						if (shouldShutdown) {
							for (const teamName of requestedTeamNames) {
								try {
									const latestTeamRecord = resolveTeamRecord(teamName);
									await shutdownTeam(pi, latestTeamRecord, {
										closeSurface: effective.closeSurface !== false,
										closeWorkspace: effective.closeWorkspaceOnShutdown !== false,
										preserveWorkspaces: uniqueStrings([operatorTarget?.workspace || null]),
										signal,
										timeout,
									}, ctx);
									shutdownResults.push({ team: teamName, shutdown: true, workspaceClosed: effective.closeWorkspaceOnShutdown !== false, preservedWorkspace: operatorTarget?.workspace || null });
								} catch (error: any) {
									shutdownResults.push({ team: teamName, shutdown: false, error: String(error?.message || error || "shutdown failed") });
								}
							}
							await pruneOfflineTeams(pi, signal, timeout, { runId, teamNames: requestedTeamNames }).catch(() => null);
							upsertRunRecord({
								runId,
								shutdownAt: nowIso(),
								shutdownOnComplete: true,
								teamRetentionDecision: lifecycle.action,
								teamRetentionPendingId: pendingRetention?.pendingId || null,
								savedTeamTemplateIds: savedTemplates.map((template: any) => template.templateId),
							});
							runRecord = resolveRunRecord(runId);
							appendRunEvent(runId, { type: "run_shutdown_on_complete", detail: requestedTeamNames.join(",") });
							// The final synthesis/tool result has reached the primary Pi and the live
							// team workspaces have been closed. Do not leave the activity module
							// pinned in the primary session waiting for a later hook.
							const activityClosedAt = nowIso();
							upsertRunRecord({ runId, primaryActivityClosedAt: activityClosedAt });
							stopPrimaryActivityForRun(runId);
							clearPrimaryActivityWidget();
						}
						upsertRunRecord({ runId, orchestrationInProgress: false });
						if (!shouldShutdown) {
							const finalActivitySnapshot = persistMissionControlSnapshot(runId, latestTeamRecordsForLifecycle.length ? latestTeamRecordsForLifecycle : teamRecords);
							closePrimaryActivityForIdleCompletion(runId, finalActivitySnapshot, finalResultsDelivered ? "orchestration-complete-no-shutdown" : "orchestration-idle-agents-complete");
						}
						runRecord = resolveRunRecord(runId);
						if (blockedCandidates.length) {
							await raiseSwarmBlocker(pi, ctx, {
								cwd: ctx.cwd,
								runId,
								teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
								agentAlias: orchestration.synthesis?.target?.alias || `${requestedTeamNames[0] || "orchestrator"}-lead`,
							}, {
								title: `Swarm run ${runId} reported ${blockedCandidates.length} blocker candidate(s).`,
								details: summarize(blockedCandidates.map((item: any) => item?.summary || item?.text || item?.alias || "blocked").join(" \n"), 320),
								severity: blockedCandidates.length > 1 ? "high" : "medium",
								ownerAlias: orchestration.synthesis?.target?.alias || requestedTeamNames[0] || "orchestrator",
							}, { signal }).catch(() => null);
						}
						if (runRecord?.status === "done") {
							await recordSwarmDecision(pi, ctx, {
								cwd: ctx.cwd,
								runId,
								teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
								agentAlias: orchestration.synthesis?.target?.alias || `${requestedTeamNames[0] || "orchestrator"}-lead`,
							}, {
								summary: `Swarm run ${runId} completed after ${orchestration.rounds.length} round(s).`,
								rationale: summarize(orchestration.synthesis?.capture?.text || orchestration.rounds.flatMap((round: any) => round.blocked || []).map((item: any) => item?.summary || item?.text || "").join(" \n"), 280),
								status: "accepted",
							}, { signal }).catch(() => null);
						} else {
							await createSwarmHandoff(pi, ctx, {
								cwd: ctx.cwd,
								runId,
								teamId: requestedTeamNames.length === 1 ? requestedTeamNames[0] : null,
								agentAlias: orchestration.synthesis?.target?.alias || `${requestedTeamNames[0] || "orchestrator"}-lead`,
							}, {
								summary: `Swarm run ${runId} paused or retained for follow-up.`,
								nextAction: controlActions?.[0] || "Inspect the latest synthesis, blockers, and pending approvals before resuming.",
								toAgent: "next-operator",
								status: "open",
							}, { signal }).catch(() => null);
						}
						const report = [
							renderTeamCollectionSummary(teamRecords),
							"",
							"## Routing",
							`- model preset: ${effective.appliedModelPreset || effective.modelPreset || "—"}`,
							`- preset source: ${presetResolution.presetSource || "none"}`,
							...(presetResolution.recommendation?.reasons?.length ? [`- why: ${presetResolution.recommendation.reasons.join(", ")}`] : []),
							"",
							"## Pre-flight control room",
							...(controlRoom ? [
								`- summary: ${autoSummaryFromSnapshot(controlRoom)}`,
								...(controlActions?.length ? controlActions.map((item: string) => `- next: ${item}`) : []),
							] : ["- unavailable"]),
							"",
							"## Approval policy",
							...(policyCheck?.policy ? [
								`- should request approval: ${policyCheck.policy.shouldRequest ? "yes" : "no"}`,
								`- action: ${policyCheck.policy.action || "continue"}`,
								...(policyCheck.policy.reasons?.length ? policyCheck.policy.reasons.map((item: string) => `- reason: ${item}`) : []),
							] : ["- unavailable"]),
							"",
							"## Dispatch",
							...orchestration.sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 120)}`),
							"",
							"## Coordination rounds",
							...orchestration.rounds.flatMap((round: any) => [
								"",
								`### Round ${round.round}`,
								formatCaptureDigests(round.digests, 24),
								round.blocked?.length ? `- blockers detected: ${round.blocked.length}` : "- blockers detected: 0",
								round.rebalances?.length ? `- rebalance actions sent: ${round.rebalances.reduce((sum: number, item: any) => sum + (item.sent?.length || 0), 0)}` : "- rebalance actions sent: 0",
								round.escalations?.length ? `- escalation messages sent: ${round.escalations.length}` : "- escalation messages sent: 0",
								round.relays?.length ? `- relay messages sent: ${round.relays.length}` : "- relay messages sent: 0",
							]),
							"",
							"## Blockers",
							formatBlockedDigests(orchestration.rounds.flatMap((round: any) => round.blocked || []), 24),
							orchestration.synthesis ? "" : "",
							orchestration.synthesis ? "## Final synthesis" : "",
							orchestration.synthesis ? `- lead agent: ${orchestration.synthesis.target?.alias || orchestration.synthesis.capture?.alias || "unknown"}` : "",
							orchestration.synthesis ? "```text" : "",
							orchestration.synthesis ? orchestration.synthesis.capture?.text || "" : "",
							orchestration.synthesis ? "```" : "",
							"",
							"## Lifecycle",
							`- run status: ${runRecord?.status || "unknown"}`,
							`- rounds completed: ${orchestration.rounds.length}/${orchestration.plannedRounds}${orchestration.totalAllowedRounds > orchestration.plannedRounds ? ` (max ${orchestration.totalAllowedRounds})` : ""}`,
							`- team lifecycle: ${lifecycle.action} (${lifecycle.reason})`,
							`- shutdown/close team workspaces: ${shouldShutdown ? "yes" : "no"}`,
							...(shutdownResults.length
								? shutdownResults.map((item: any) => `- ${item.team}: ${item.shutdown ? `shutdown${item.workspaceClosed ? " + workspace closed" : ""}${item.preservedWorkspace ? ` (preserved primary workspace ${item.preservedWorkspace})` : ""}` : `shutdown failed (${item.error})`}`)
								: []),
							...renderTeamRetentionPrompt(lifecycle, pendingRetention, savedTemplates, discardedTemplates),
							"",
							renderCaptureSection(orchestration.captures),
						].filter(Boolean);
						return ok(report.join("\n"), { teams: teamRecords, run: runRecord, shutdownResults, shouldShutdown, teamLifecycle: lifecycle, pendingRetention, savedTemplates, discardedTemplates, teamResolution, presetResolution, ...orchestration });
					}
					case "report": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for report");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const taskText = p.task || teamRecords.map((teamRecord: any) => `${teamRecord.team}: ${teamRecord.goal || "active work"}`).join("\n");
						const snapshot = await requestOperatorReportSnapshot(pi, teamRecords, taskText, {
							mode: p.reportMode || "progress",
							appendEnter: p.appendEnter !== false,
							signal,
							timeout,
						});
						return ok([renderTeamCollectionSummary(teamRecords), "", snapshot.text].join("\n"), { teams: teamRecords, teamResolution, ...snapshot });
					}
					case "macro": {
						if (!p.operatorMacro) throw new Error("operatorMacro is required for macro");
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for macro");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const taskText = p.task || teamRecords.map((teamRecord: any) => `${teamRecord.team}: ${teamRecord.goal || "active work"}`).join("\n");
						if (p.operatorMacro === "blocker-report") {
							const snapshot = await requestOperatorReportSnapshot(pi, teamRecords, taskText, { mode: "blockers", appendEnter: p.appendEnter !== false, signal, timeout });
							return ok([renderTeamCollectionSummary(teamRecords), "", "## Macro: blocker-report", snapshot.text].join("\n"), { teams: teamRecords, teamResolution, macro: p.operatorMacro, ...snapshot });
						}
						if (p.operatorMacro === "synthesis-now") {
							const snapshot = await requestOperatorReportSnapshot(pi, teamRecords, taskText, { mode: "synthesis", appendEnter: p.appendEnter !== false, signal, timeout });
							return ok([renderTeamCollectionSummary(teamRecords), "", "## Macro: synthesis-now", snapshot.text].join("\n"), { teams: teamRecords, teamResolution, macro: p.operatorMacro, ...snapshot });
						}
						if (p.operatorMacro === "pause-and-summarize") {
							const pauseMessage = p.message || "Pause active execution now. Stop making further changes, summarize your exact current state, include blockers and touched files, and then wait for further direction from the orchestrator.";
							const sent = await pauseTeamExecution(pi, teamRecords, pauseMessage, { appendEnter: p.appendEnter !== false, signal, timeout });
							const snapshot = await requestOperatorReportSnapshot(pi, teamRecords, taskText, { mode: "progress", appendEnter: p.appendEnter !== false, signal, timeout });
							return ok([renderTeamCollectionSummary(teamRecords), "", "## Macro: pause-and-summarize", ...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 140)}`), "", snapshot.text].join("\n"), { teams: teamRecords, teamResolution, macro: p.operatorMacro, sent, ...snapshot });
						}
						if (p.operatorMacro === "redirect-milestone") {
							const milestone = p.milestone || p.message || p.task;
							if (!milestone) throw new Error("milestone, message, or task is required for redirect-milestone");
							const steerMessage = `Redirect current execution to this milestone: ${milestone}. Stop low-value parallel work, align on the smallest shippable path, report blockers immediately, and respond with exact next actions.`;
							const sent: any[] = [];
							for (const teamRecord of teamRecords) {
								sent.push(...(await sendTeamControlMessage(pi, teamRecord, steerMessage, { scope: "leads", appendEnter: p.appendEnter !== false, signal, timeout })));
								appendRunEvent(teamRecord.runId, { type: "operator_macro_redirect_milestone", team: teamRecord.team, detail: summarize(milestone, 240) });
							}
							return ok([renderTeamCollectionSummary(teamRecords), "", "## Macro: redirect-milestone", ...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 140)}`)].join("\n"), { teams: teamRecords, teamResolution, macro: p.operatorMacro, sent, milestone });
						}
						throw new Error(`Unsupported operatorMacro: ${p.operatorMacro}`);
					}
					case "steer": {
						if (!p.message && !p.task) throw new Error("message or task is required for steer");
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for steer");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const steerMessage = p.message || p.task;
						const sent: any[] = [];
						for (const teamRecord of teamRecords) {
							sent.push(...(await sendTeamControlMessage(pi, teamRecord, steerMessage, {
								scope: p.steerScope === "all" ? "all" : "leads",
								appendEnter: p.appendEnter !== false,
								signal,
								timeout,
							})));
							appendRunEvent(teamRecord.runId, { type: "operator_steer", team: teamRecord.team, detail: summarize(steerMessage, 240) });
						}
						return ok([renderTeamCollectionSummary(teamRecords), "", "## Operator steering", ...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 140)}`)].join("\n"), { teams: teamRecords, sent, teamResolution });
					}
					case "pause": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for pause");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const pauseMessage = p.message || "Pause active execution now. Stop making further changes, summarize your exact current state, include blockers and touched files, and then wait for further direction from the orchestrator.";
						const sent = await pauseTeamExecution(pi, teamRecords, pauseMessage, {
							appendEnter: p.appendEnter !== false,
							signal,
							timeout,
						});
						return ok([renderTeamCollectionSummary(teamRecords), "", "## Pause dispatch", ...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 140)}`)].join("\n"), { teams: teamRecords, sent, teamResolution });
					}
					case "resume":
					case "continue": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error(`team, teamNames, runId, or a reusable live team is required for ${p.action}`);
						const healed: any[] = [];
						const teamRecords: any[] = [];
						for (const teamName of teamNames) {
							const existing = resolveTeamRecord(teamName);
							const result = await healTeamRecord(pi, existing, ctx, signal, { timeout, recreateDeadTeam: true });
							if (result.healed?.length) healed.push({ team: teamName, healed: result.healed.map((item: any) => item.alias) });
							if (result.teamRecord) teamRecords.push(result.teamRecord);
						}
						const continueTask = p.action === "continue"
							? (p.task || "Continue from your current state. Reuse prior findings, avoid redoing finished work, absorb adjacent scope if peers are stalled, and respond with STATUS, OUTPUT, RISKS, NEXT, NEEDS FROM PEERS, FILES/AREAS CHANGED, CONFIDENCE, COMMANDS RUN, URLS, and DELIVERABLE when relevant.")
							: p.task;
						if (continueTask) {
							const sent: any[] = [];
							for (const teamRecord of teamRecords) {
								sent.push(...(await dispatchTeamTask(pi, teamRecord, continueTask, {
									extraGuidance: p.extraGuidance,
									appendEnter: p.appendEnter !== false,
									signal,
									timeout,
								})));
							}
							return ok([renderTeamCollectionSummary(teamRecords), "", `## ${p.action === "continue" ? "Continue" : "Resume"} dispatch`, ...(teamResolution.reused ? [`- team reuse: ${teamNames.join(", ")} (${teamResolution.source})`, ""] : []), ...sent.map((item: any) => `- ${item.alias || item.surface}: ${summarize(item.message, 120)}`)].join("\n"), { teams: teamRecords, healed, sent, task: continueTask, teamResolution });
						}
						return ok([renderTeamCollectionSummary(teamRecords), "", "## Healing", ...(healed.length ? healed.map((item: any) => `- ${item.team}: ${item.healed.join(", ")}`) : ["- No members needed recreation."])].join("\n"), { teams: teamRecords, healed, teamResolution });
					}
					case "heal": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for heal");
						const healed: any[] = [];
						const teamRecords: any[] = [];
						for (const teamName of teamNames) {
							const existing = resolveTeamRecord(teamName);
							const result = await healTeamRecord(pi, existing, ctx, signal, { timeout, recreateDeadTeam: true });
							healed.push({ team: teamName, recreated: result.recreated, healed: (result.healed || []).map((item: any) => item.alias) });
							if (result.teamRecord) teamRecords.push(result.teamRecord);
						}
						return ok([renderTeamCollectionSummary(teamRecords), "", "## Healing", ...healed.map((item: any) => `- ${item.team}: ${item.recreated ? "recreated" : item.healed.length ? item.healed.join(", ") : "no changes"}`)].join("\n"), { teams: teamRecords, healed, teamResolution });
					}
					case "rebalance": {
						const teamResolution = await resolveTeamNamesForAction(pi, p, ctx, signal, { allowImplicitReuse: true, timeout });
						const teamNames = teamResolution.teamNames;
						if (!teamNames.length) throw new Error("team, teamNames, runId, or a reusable live team is required for rebalance");
						const results = [] as any[];
						for (const teamName of teamNames) {
							const teamRecord = resolveTeamRecord(teamName);
							results.push(await rebalanceTeam(pi, teamRecord, p.task || teamRecord.goal || "Continue current work", {
								appendEnter: p.appendEnter !== false,
								signal,
								timeout,
								force: true,
								source: "manual",
							}));
						}
						return ok([
							"# cmux Pi team rebalance",
							"",
							...results.flatMap((result: any) => [
								`## ${result.team}`,
								result.blocked?.length ? `- blocked/stalled: ${result.blocked.map((item: any) => item.alias).join(", ")}` : "- no rebalance needed",
								result.sent?.length ? `- messages sent: ${result.sent.length}` : "- messages sent: 0",
								"",
							]),
						].join("\n"), { results, teamResolution });
					}
					case "prune": {
						const scopedTeamNames = resolveRequestedTeamNames(p);
						const pruned = await pruneOfflineTeams(pi, signal, timeout, { runId: p.runId, teamNames: scopedTeamNames });
						return ok(["# pruned offline cmux Pi teams", "", pruned.scope ? `- scope: ${pruned.scope.runId || pruned.scope.teamNames.join(", ")}` : "- scope: all teams", ...((pruned.removed || []).length ? pruned.removed.map((item: any) => `- removed ${item.team}`) : ["- No offline teams removed."]), ...((pruned.reconciled || []).length ? pruned.reconciled.map((item: any) => `- reconciled ${item.team}: members=${item.memberCount}`) : [])].join("\n"), pruned);
					}
					case "runs": {
						const runs = Object.values(readRunRegistry().runs || {}).sort((a: any, b: any) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
						return ok(renderRunCollectionSummary(runs), { runs });
					}
					case "mission_control": {
						if (!p.runId) throw new Error("runId is required for mission_control");
						const run = resolveRunRecord(p.runId);
						const teamRecords = (run.teamNames || []).map((teamName: string) => {
							try {
								return resolveTeamRecord(teamName);
							} catch {
								return null;
							}
						}).filter(Boolean);
						const snapshot = persistMissionControlSnapshot(p.runId, teamRecords as any[]);
						return ok(renderMissionControlSnapshot(snapshot), { run, snapshot, teams: teamRecords });
					}
					case "run_status": {
						if (!p.runId) throw new Error("runId is required for run_status");
						const run = resolveRunRecord(p.runId);
						const teamRecords = (run.teamNames || []).map((teamName: string) => {
							try {
								return resolveTeamRecord(teamName);
							} catch {
								return null;
							}
						}).filter(Boolean);
						const snapshot = persistMissionControlSnapshot(p.runId, teamRecords as any[]);
						return ok([renderRunSummary(resolveRunRecord(p.runId)), "", renderMissionControlSnapshot(snapshot)].join("\n"), { run: resolveRunRecord(p.runId), snapshot, teams: teamRecords });
					}
					case "timeline": {
						if (!p.runId) throw new Error("runId is required for timeline");
						const events = readRunEvents(p.runId, 200);
						return ok(renderRunTimeline(p.runId, events), { runId: p.runId, events });
					}
					case "artifacts": {
						if (p.runId) {
							const run = resolveRunRecord(p.runId);
							const artifactPaths = uniqueStrings(run.artifactPaths || []);
							const urls = uniqueStrings(run.urls || []);
							const commands = uniqueStrings(run.commands || []);
							return ok(renderArtifactInventory(`cmux Pi artifacts ${p.runId}`, { artifactPaths, urls, commands }), {
								runId: p.runId,
								artifacts: artifactPaths,
								urls,
								commands,
							});
						}
						const teamNames = resolveRequestedTeamNames(p);
						if (!teamNames.length) throw new Error("runId, team, or teamNames is required for artifacts");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const artifactPaths = uniqueStrings(teamRecords.flatMap((teamRecord: any) => teamRecord.artifactPaths || []));
						const urls = uniqueStrings(teamRecords.flatMap((teamRecord: any) => teamRecord.urls || []));
						const commands = uniqueStrings(teamRecords.flatMap((teamRecord: any) => teamRecord.commands || []));
						return ok(renderArtifactInventory(`cmux Pi artifacts ${teamNames.join(", ")}`, { artifactPaths, urls, commands }), {
							teams: teamNames,
							artifacts: artifactPaths,
							urls,
							commands,
						});
					}
					case "doctor": {
						const scopedTeamNames = resolveRequestedTeamNames(p);
						const report = await collectOrchestratorDoctor(pi, signal, timeout);
						persistDoctorFindings(report);
						const visibleReport = scopeDoctorReport(report, { runId: p.runId, teamNames: scopedTeamNames });
						if (p.executeSafeRepairs && (p.runId || scopedTeamNames.length)) {
							const executed = await executeSafeRepairActions(pi, report, {
								runId: p.runId,
								teamNames: scopedTeamNames,
								limit: p.repairActionLimit,
								signal,
								timeout,
							});
							const nextReport = scopeDoctorReport({ ...report, ...executed }, { runId: p.runId, teamNames: scopedTeamNames });
							return ok(renderOrchestratorDoctor(nextReport), nextReport);
						}
						return ok(renderOrchestratorDoctor(visibleReport), visibleReport);
					}
					case "repair": {
						const scopedTeamNames = resolveRequestedTeamNames(p);
						if (!p.runId && !scopedTeamNames.length) throw new Error("runId, team, or teamNames is required for repair");
						const report = await collectOrchestratorDoctor(pi, signal, timeout);
						persistDoctorFindings(report);
						const executed = await executeSafeRepairActions(pi, report, {
							runId: p.runId,
							teamNames: scopedTeamNames,
							limit: p.repairActionLimit,
							signal,
							timeout,
						});
						const nextReport = { ...report, ...executed };
						return ok(renderOrchestratorDoctor(nextReport), nextReport);
					}
					case "retention": {
						const decision = String(p.teamRetentionDecision || "list").trim().toLowerCase();
						const teamNames = uniqueStrings(resolveRequestedTeamNames(p));
						if (decision === "list" || !["save", "destroy"].includes(decision)) {
							const registry = readTeamTemplateRegistry();
							const saved = Object.values(registry.templates || {}) as any[];
							const pending = Object.values(registry.pending || {}) as any[];
							const lines = [
								"# cmux team retention",
								"",
								"## Saved templates",
								...(saved.length ? saved.map((template: any) => `- ${template.templateId}: team=${template.team} members=${template.memberCount || 0} goal=${summarize(template.goal || "", 120)}`) : ["- none"]),
								"",
								"## Pending retention questions",
								...(pending.length ? pending.map((item: any) => `- ${item.pendingId}: run=${item.runId || "—"} teams=${(item.teamNames || []).join(", ") || "—"}`) : ["- none"]),
							];
							return ok(lines.join("\n"), { saved, pending, registry });
						}
						if (decision === "save") {
							const promoted = promotePendingTeamRetention({ runId: p.runId || null, teamNames, pendingId: p.pendingId || null });
							if (p.runId) appendRunEvent(p.runId, { type: "team_retention_saved_by_user", status: "saved", detail: promoted.map((template: any) => template.templateId).join(",") });
							return ok(["# saved cmux team template(s)", "", ...(promoted.length ? promoted.map((template: any) => `- ${template.templateId}: team=${template.team} members=${template.memberCount || 0}`) : ["- No matching pending retention record found."])].join("\n"), { promoted });
						}
						const discarded = discardPendingTeamRetention({ runId: p.runId || null, teamNames, pendingId: p.pendingId || null });
						for (const teamName of teamNames) {
							try {
								const teamRecord = resolveTeamRecord(teamName);
								await shutdownTeam(pi, teamRecord, { closeSurface: p.closeSurface !== false, closeWorkspace: p.closeWorkspaceOnShutdown !== false, signal, timeout }, ctx);
							} catch {
								removeTeamRecord(teamName);
							}
						}
						if (p.runId) appendRunEvent(p.runId, { type: "team_retention_destroyed_by_user", status: "destroyed", detail: teamNames.join(",") });
						return ok(["# destroyed cmux team retention", "", ...(discarded.length ? discarded.map((item: any) => `- discarded pending ${item.pendingId || item.runId}`) : ["- No matching pending retention record found."]), ...(teamNames.length ? teamNames.map((teamName: string) => `- ensured team ${teamName} is shut down/removed`) : [])].join("\n"), { discarded, teams: teamNames });
					}
					case "shutdown": {
						const teamNames = resolveRequestedTeamNames(p);
						if (!teamNames.length) throw new Error("team or teamNames is required for shutdown");
						const teamRecords = teamNames.map((teamName: string) => resolveTeamRecord(teamName));
						const runIds = uniqueStrings([p.runId, ...teamRecords.map((teamRecord: any) => teamRecord.runId)].filter(Boolean));
						for (const teamRecord of teamRecords) {
							await shutdownTeam(pi, teamRecord, {
								closeSurface: p.closeSurface !== false,
								closeWorkspace: p.closeWorkspaceOnShutdown !== false,
								signal,
								timeout,
							}, ctx);
						}
						for (const id of runIds) {
							upsertRunRecord({ runId: id, shutdownAt: nowIso(), primaryActivityClosedAt: nowIso(), shutdownOnComplete: true });
							stopPrimaryActivityForRun(id);
						}
						clearPrimaryActivityWidget();
						return ok(`# shutdown cmux Pi teams ${teamNames.join(", ")}`, { shutdown: true, teams: teamNames, runIds });
					}
					case "remove": {
						const teamNames = resolveRequestedTeamNames(p);
						if (!teamNames.length) throw new Error("team or teamNames is required for remove");
						const removed = teamNames.map((teamName: string) => {
							const existing = (() => {
								try { return resolveTeamRecord(teamName); } catch { return null; }
							})();
							const removedTeam = removeTeamRecord(teamName);
							const removedAgents = (existing?.members || []).map((member: any) => ({ alias: member.alias, removed: removeAgentRecord(member.alias) }));
							return { team: teamName, removed: removedTeam, removedAgents };
						});
						return ok(`# removed team registry entries ${teamNames.join(", ")}`, { removed });
					}
					default:
						throw new Error(`Unsupported cmux_pi_team action: ${p.action}`);
				}
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_pi_team",
					action: p.action,
					team: p.team,
					teamNames: p.teamNames,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_notify",
		label: "cmux Notify",
		description:
			"Send a desktop/sidebar notification into cmux for the current workspace or a targeted workspace or surface.",
		parameters: Type.Object({
			title: Type.String({ description: "Notification title." }),
			subtitle: Type.Optional(Type.String({ description: "Optional notification subtitle." })),
			body: Type.Optional(Type.String({ description: "Optional notification body." })),
			workspace: Type.Optional(Type.String({ description: "Target workspace ref, id, or index." })),
			surface: Type.Optional(Type.String({ description: "Target surface ref, id, or index." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const args = ["notify", "--title", p.title];
				addFlag(args, "--subtitle", p.subtitle);
				addFlag(args, "--body", p.body);
				addFlag(args, "--workspace", p.workspace);
				addFlag(args, "--surface", p.surface);
				await execCmux(pi, args, { signal, timeout });
				return ok(
					[
						"# cmux notification sent",
						"",
						`- title: ${p.title}`,
						`- subtitle: ${p.subtitle || "—"}`,
						`- body: ${p.body || "—"}`,
						`- workspace: ${p.workspace || "current"}`,
						`- surface: ${p.surface || "current"}`,
					].join("\n"),
					{ sent: true, ...p },
				);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_notify" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_rpc",
		label: "cmux RPC",
		description:
			"Call any cmux socket RPC method directly with structured JSON params. Use for advanced methods not covered by the higher-level cmux tools.",
		promptSnippet:
			"Use for advanced cmux methods such as remote status, browser network features, or future socket methods not wrapped by the extension.",
		parameters: Type.Object({
			method: Type.String({ description: "cmux socket method, for example workspace.list or browser.snapshot." }),
			params: Type.Optional(
				Type.Object({}, { additionalProperties: true, description: "JSON params object for the RPC call." }),
			),
			socketPath: Type.Optional(Type.String({ description: "Optional socket path override." })),
			password: Type.Optional(Type.String({ description: "Optional cmux socket password override." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const result = await execCmuxRpc(pi, p.method, p.params || {}, {
					signal,
					timeout,
					socketPath: p.socketPath,
					password: p.password,
				});
				return ok([`# cmux rpc ${p.method}`, "", "```json", json(result.data), "```"].join("\n"), {
					method: p.method,
					params: p.params || {},
					result: result.data,
				});
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_rpc",
					method: p.method,
				});
			}
		},
	});

	pi.registerTool({
		name: "cmux_cli",
		label: "cmux CLI",
		description:
			"Run an arbitrary cmux CLI command with structured arguments. Use this for full cmux coverage such as ssh, claude-teams, omo/omx/omc, themes, markdown, codex hook setup, and other commands not explicitly wrapped by this extension.",
		promptSnippet:
			"Prefer the higher-level cmux tools first. Use cmux_cli when you need a specific cmux command that is not otherwise exposed.",
		parameters: Type.Object({
			command: Type.Array(Type.String(), {
				description: "cmux command tokens without the cmux binary itself, for example ['ssh','user@remote','--name','dev server'].",
				minItems: 1,
			}),
			socketPath: Type.Optional(Type.String({ description: "Optional socket path override." })),
			password: Type.Optional(Type.String({ description: "Optional cmux socket password override." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const result = await execCmux(pi, p.command, {
					signal,
					timeout,
					socketPath: p.socketPath,
					password: p.password,
				});
				const parsed = parseJson(result.stdout.trim());
				const text = result.stdout.trim() || result.stderr.trim() || "cmux command completed.";
				return ok(
					[
						"# cmux cli",
						"",
						`- command: cmux ${p.command.join(" ")}`,
						"",
						parsed ? `\`\`\`json\n${json(parsed)}\n\`\`\`` : text,
					].join("\n"),
					{
						command: p.command,
						stdout: result.stdout,
						stderr: result.stderr,
						parsed: parsed || null,
					},
				);
			} catch (error: any) {
				return fail(error.message || String(error), {
					tool: "cmux_cli",
					command: p.command,
				});
			}
		},
	});

	pi.registerCommand("cmux-doctor", {
		description: "Check whether cmux is installed, reachable, and ready for orchestration.",
		handler: async (_args, ctx) => {
			try {
				const status = await collectStatus(pi, undefined, {
					includeCapabilities: true,
					includeTree: false,
					includeConfig: false,
					projectCwd: ctx?.cwd,
				});
				if (!status.installed) {
					ctx.ui.notify("cmux not detected. See tool output for installation instructions.", "error");
					return;
				}

				const workspace = status.currentWorkspace?.workspace?.title || status.identify?.focused?.workspace_ref || "unknown";
				const surface = status.identify?.focused?.surface_ref || "unknown";
				const doctor = await collectOrchestratorDoctor(pi, undefined, DEFAULT_TIMEOUT).catch(() => null);
				const issues = doctor ? doctor.offlineTeams.length + doctor.degradedTeams.length + doctor.sessionMismatches.length + doctor.runsWithMissingTeams.length : 0;
				ctx.ui.notify(`cmux ready: ${status.version} | workspace=${workspace} | surface=${surface}${doctor ? ` | orchestrator issues=${issues}` : ""}`, issues ? "error" : "info");
			} catch (error: any) {
				ctx.ui.notify(`cmux doctor failed: ${error.message || String(error)}`, "error");
			}
		},
	});
}
