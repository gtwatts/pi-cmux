import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function uniqueStrings(values: any[] = [], limit = 128) {
	return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))).slice(0, limit);
}

function normalizeHistory(items: any, limit = 16) {
	return Array.isArray(items) ? items.filter(Boolean).slice(-limit) : [];
}

function normalizeDependencies(items: any, limit = 32) {
	return Array.isArray(items)
		? items.filter(Boolean).map((item) => ({ ...item })).slice(0, limit)
		: [];
}

function normalizeRecord(record: any = {}, kind: "run" | "agent" | "team") {
	const base = { ...record };
	if (kind === "run") {
		base.teamNames = uniqueStrings(base.teamNames || [], 64);
		base.artifactPaths = uniqueStrings(base.artifactPaths || [], 128);
		base.urls = uniqueStrings(base.urls || [], 128);
		base.commands = uniqueStrings(base.commands || [], 128);
		base.scorecardArtifacts = uniqueStrings(base.scorecardArtifacts || [], 32);
		base.failureArtifacts = uniqueStrings(base.failureArtifacts || [], 32);
		base.benchmarkArtifacts = uniqueStrings(base.benchmarkArtifacts || [], 32);
		base.planningArtifacts = uniqueStrings(base.planningArtifacts || [], 32);
		base.doctorFindings = normalizeHistory(base.doctorFindings, 24);
		base.repairActions = normalizeHistory(base.repairActions, 24);
		base.repairExecutionLog = normalizeHistory(base.repairExecutionLog, 24);
		base.verificationLog = normalizeHistory(base.verificationLog, 24);
		base.progressLog = normalizeHistory(base.progressLog, 64);
		base.observationLog = normalizeHistory(base.observationLog, 48);
		base.guidanceLog = normalizeHistory(base.guidanceLog, 48);
		base.communicationLog = normalizeHistory(base.communicationLog, 96);
		base.primaryInbox = normalizeHistory(base.primaryInbox, 96);
		base.lastAgentReports = normalizeHistory(base.lastAgentReports, 64);
		return base;
	}
	if (kind === "agent") {
		base.lastArtifacts = uniqueStrings(base.lastArtifacts || [], 64);
		base.lastUrls = uniqueStrings(base.lastUrls || [], 64);
		base.lastCommands = uniqueStrings(base.lastCommands || [], 64);
		base.lastBlockers = uniqueStrings(base.lastBlockers || [], 32);
		base.lastDependencies = normalizeDependencies(base.lastDependencies, 32);
		base.doctorFindings = normalizeHistory(base.doctorFindings, 16);
		base.repairActions = normalizeHistory(base.repairActions, 16);
		base.repairExecutionLog = normalizeHistory(base.repairExecutionLog, 16);
		base.verificationLog = normalizeHistory(base.verificationLog, 16);
		base.observationLog = normalizeHistory(base.observationLog, 24);
		base.guidanceLog = normalizeHistory(base.guidanceLog, 16);
		base.communicationLog = normalizeHistory(base.communicationLog, 48);
		return base;
	}
	base.members = Array.isArray(base.members) ? base.members : [];
	base.artifactPaths = uniqueStrings(base.artifactPaths || [], 128);
	base.urls = uniqueStrings(base.urls || [], 128);
	base.commands = uniqueStrings(base.commands || [], 128);
	base.lastDependencies = normalizeDependencies(base.lastDependencies, 32);
	base.doctorFindings = normalizeHistory(base.doctorFindings, 16);
	base.repairActions = normalizeHistory(base.repairActions, 16);
	base.repairExecutionLog = normalizeHistory(base.repairExecutionLog, 16);
	base.verificationLog = normalizeHistory(base.verificationLog, 16);
	base.leadHeartbeatLog = normalizeHistory(base.leadHeartbeatLog, 16);
	base.observationLog = normalizeHistory(base.observationLog, 24);
	base.guidanceLog = normalizeHistory(base.guidanceLog, 24);
	base.communicationLog = normalizeHistory(base.communicationLog, 64);
	base.primaryInbox = normalizeHistory(base.primaryInbox, 48);
	return base;
}

export function nowIso() {
	return new Date().toISOString();
}

export function safeFileSegment(value: string, fallback = "item") {
	const normalized = String(value || fallback)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || fallback;
}

export function atomicWriteJson(file: string, data: any) {
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
	renameSync(temp, file);
}

export function registryVersioned<T extends object>(key: string, emptyValue: T) {
	return { version: 2, [key]: emptyValue } as any;
}

export interface BridgeDerivedAgentState {
	lastBridgeEventType?: string | null;
	lastBridgeEventAt?: string | null;
	browserSurface?: string | null;
	browserLockOwner?: string | null;
	browserLockTeam?: string | null;
	browserLockHeld?: boolean | null;
	browserLockLeaseSeconds?: number | null;
	lastBrowserEventType?: string | null;
	lastBrowserEventAt?: string | null;
	lastBrowserRecoveryStatus?: string | null;
	lastBrowserRecoveryStrategy?: string | null;
	lastCheckpointKey?: string | null;
	lastCheckpointCollection?: string | null;
	lastCheckpointAt?: string | null;
	lastPatternEventType?: string | null;
	lastPatternRunStatus?: string | null;
	lastPatternRunAt?: string | null;
	lastPatternTool?: string | null;
	lastPatternCacheHitAt?: string | null;
	lastPatternBenchmarkHistoryPath?: string | null;
	lastPatternSetupStatus?: string | null;
}

export function deriveBridgeStateFromEvents(events: any[] = []): BridgeDerivedAgentState {
	const state: BridgeDerivedAgentState = {};
	for (const event of events || []) {
		const type = String(event?.type || event?.event_type || "").trim();
		const payload = event?.payload || {};
		const timestamp = event?.timestamp || null;
		if (!type) continue;
		state.lastBridgeEventType = type;
		state.lastBridgeEventAt = timestamp;
		if (type === "before_agent_start") {
			(state as any).bridgeAgentLoopStatus = "prompt_received";
			(state as any).lastAgentPromptAt = timestamp;
		}
		if (type === "agent_start" || type === "turn_start") {
			(state as any).bridgeAgentLoopStatus = "working";
			(state as any).lastAgentWorkAt = timestamp;
		}
		if (type === "turn_end") {
			(state as any).bridgeAgentLoopStatus = "turn_finished";
			(state as any).lastAgentTurnEndAt = timestamp;
			if (payload?.assistantPreview) (state as any).lastAssistantPreview = String(payload.assistantPreview);
		}
		if (type === "agent_end") {
			(state as any).bridgeAgentLoopStatus = "idle";
			(state as any).lastAgentEndAt = timestamp;
			if (payload?.assistantSummary) (state as any).lastAssistantSummary = String(payload.assistantSummary);
			if (payload?.summary) (state as any).lastBridgeSummary = String(payload.summary);
		}
		if (payload?.summary) (state as any).lastBridgeSummary = String(payload.summary);
		if (type.startsWith("browser_")) {
			state.lastBrowserEventType = type;
			state.lastBrowserEventAt = timestamp;
			state.browserSurface = (payload.surface || event?.surface_id || state.browserSurface || null) as string | null;
			if (["browser_lock_acquired", "browser_lock_renewed", "browser_lock_handoff", "browser_lock_asserted"].includes(type) && payload.unlocked !== true) {
				state.browserLockOwner = (payload.newOwner || payload.owner || state.browserLockOwner || null) as string | null;
				state.browserLockTeam = (payload.team || state.browserLockTeam || null) as string | null;
				state.browserLockLeaseSeconds = Number(payload.leaseSeconds || state.browserLockLeaseSeconds || 0) || null;
				state.browserLockHeld = true;
			}
			if (type === "browser_lock_released") {
				state.browserLockHeld = false;
				state.browserLockOwner = null;
				state.browserLockTeam = null;
			}
			if (type.startsWith("browser_checkpoint_")) {
				state.lastCheckpointKey = (payload.key || payload.newKey || state.lastCheckpointKey || null) as string | null;
				state.lastCheckpointCollection = (payload.collection || payload.toCollection || state.lastCheckpointCollection || null) as string | null;
				state.lastCheckpointAt = timestamp;
			}
			if (type.startsWith("browser_recovery_")) {
				state.lastBrowserRecoveryStrategy = (payload.strategy || state.lastBrowserRecoveryStrategy || null) as string | null;
				state.lastBrowserRecoveryStatus = (payload.status || (type === "browser_recovery_failed" ? "failed" : type === "browser_recovery_completed" ? "completed" : "started")) as string;
				if (payload.checkpointKey) state.lastCheckpointKey = String(payload.checkpointKey);
			}
		}
		if (type.startsWith("pattern_")) {
			state.lastPatternEventType = type;
			state.lastPatternRunAt = timestamp;
			state.lastPatternTool = (payload.toolName || state.lastPatternTool || null) as string | null;
			if (type === "pattern_analysis_started") state.lastPatternRunStatus = "started";
			if (type === "pattern_analysis_completed") state.lastPatternRunStatus = "completed";
			if (type === "pattern_analysis_failed") state.lastPatternRunStatus = "failed";
			if (type === "pattern_analysis_cache_hit") {
				state.lastPatternRunStatus = "cache_hit";
				state.lastPatternCacheHitAt = timestamp;
			}
			if (type === "pattern_benchmark_recorded") state.lastPatternBenchmarkHistoryPath = (payload.benchmarkHistoryPath || state.lastPatternBenchmarkHistoryPath || null) as string | null;
			if (type === "pattern_setup_started") state.lastPatternSetupStatus = "started";
			if (type === "pattern_setup_completed") state.lastPatternSetupStatus = "completed";
			if (type === "pattern_setup_failed") state.lastPatternSetupStatus = "failed";
		}
	}
	return state;
}

export function summarizeRunBridgeState(agentRecords: any[] = []) {
	const agents = agentRecords || [];
	const browserAgents = agents.filter((agent: any) => agent?.browserSurface);
	const latestBridgeAgent = [...agents].filter((agent: any) => agent?.lastBridgeEventAt).sort((a: any, b: any) => String(b?.lastBridgeEventAt || "").localeCompare(String(a?.lastBridgeEventAt || "")))[0] || null;
	const latestPatternAgent = [...agents].filter((agent: any) => agent?.lastPatternRunAt).sort((a: any, b: any) => String(b?.lastPatternRunAt || "").localeCompare(String(a?.lastPatternRunAt || "")))[0] || null;
	return {
		updatedAt: nowIso(),
		agentCount: agents.length,
		browserAgentCount: browserAgents.length,
		browserLockOwners: [...new Set(browserAgents.map((agent: any) => agent.browserLockOwner).filter(Boolean))],
		patternStatuses: [...new Set(agents.map((agent: any) => agent.lastPatternRunStatus).filter(Boolean))],
		patternTools: [...new Set(agents.map((agent: any) => agent.lastPatternTool).filter(Boolean))],
		latestBridgeEventType: latestBridgeAgent?.lastBridgeEventType || null,
		latestBridgeEventAt: latestBridgeAgent?.lastBridgeEventAt || null,
		latestBridgeSummary: latestBridgeAgent?.lastBridgeSummary || latestBridgeAgent?.lastAssistantSummary || null,
		latestPatternTool: latestPatternAgent?.lastPatternTool || null,
		latestPatternStatus: latestPatternAgent?.lastPatternRunStatus || null,
		latestPatternEventAt: latestPatternAgent?.lastPatternRunAt || null,
	};
}

export function applyBridgeStateToAgentRecord(record: any, bridgeState: BridgeDerivedAgentState): any {
	if (!record) return record;
	return {
		...record,
		...bridgeState,
		bridgeStateUpdatedAt: nowIso(),
	};
}

export function createOrchestratorStorage(options: { baseDir: string; sessionsRoot?: string }) {
	const baseDir = options.baseDir;
	const sessionsRoot = options.sessionsRoot || join(dirname(baseDir), "sessions", "cmux-orchestrator");

	function runRegistryFile() {
		return join(baseDir, "runs.json");
	}

	function agentRegistryFile() {
		return join(baseDir, "agents.json");
	}

	function teamRegistryFile() {
		return join(baseDir, "teams.json");
	}

	function runEventsDir() {
		return join(baseDir, "events");
	}

	function runEventsFile(runId: string) {
		return join(runEventsDir(), `${safeFileSegment(runId, "run")}.jsonl`);
	}

	function defaultSessionPath(alias: string, runId?: string | null) {
		const folder = join(sessionsRoot, safeFileSegment(runId || "adhoc"));
		mkdirSync(folder, { recursive: true });
		return join(folder, `${safeFileSegment(alias, "agent")}.jsonl`);
	}

	function readRunRegistry() {
		const file = runRegistryFile();
		if (!existsSync(file)) return registryVersioned("runs", {});
		const parsed = parseJson(readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object") return registryVersioned("runs", {});
		if (!parsed.runs || typeof parsed.runs !== "object") return registryVersioned("runs", {});
		return {
			version: parsed.version || 1,
			runs: Object.fromEntries(Object.entries(parsed.runs).map(([key, value]) => [key, normalizeRecord(value, "run")])),
		};
	}

	function writeRunRegistry(registry: any) {
		atomicWriteJson(runRegistryFile(), registry);
	}

	function upsertRunRecord(record: any) {
		const registry = readRunRegistry();
		registry.runs = registry.runs || {};
		registry.runs[record.runId] = normalizeRecord({
			...(registry.runs[record.runId] || {}),
			...record,
			updatedAt: nowIso(),
		}, "run");
		writeRunRegistry(registry);
		return registry.runs[record.runId];
	}

	function resolveRunRecord(runId: string) {
		const registry = readRunRegistry();
		const record = registry.runs?.[runId] || null;
		if (!record) throw new Error(`Unknown cmux Pi run: ${runId}`);
		return record;
	}

	function readAgentRegistry() {
		const file = agentRegistryFile();
		if (!existsSync(file)) return registryVersioned("agents", {});
		const parsed = parseJson(readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object") return registryVersioned("agents", {});
		if (!parsed.agents || typeof parsed.agents !== "object") return registryVersioned("agents", {});
		return {
			version: parsed.version || 1,
			agents: Object.fromEntries(Object.entries(parsed.agents).map(([key, value]) => [key, normalizeRecord(value, "agent")])),
		};
	}

	function writeAgentRegistry(registry: any) {
		atomicWriteJson(agentRegistryFile(), registry);
	}

	function upsertAgentRecord(record: any) {
		const registry = readAgentRegistry();
		registry.agents = registry.agents || {};
		registry.agents[record.alias] = normalizeRecord({
			...(registry.agents[record.alias] || {}),
			...record,
			updatedAt: nowIso(),
		}, "agent");
		writeAgentRegistry(registry);
		return registry.agents[record.alias];
	}

	function removeAgentRecord(alias: string) {
		const registry = readAgentRegistry();
		registry.agents = registry.agents || {};
		const existing = registry.agents[alias] || null;
		delete registry.agents[alias];
		writeAgentRegistry(registry);
		return existing;
	}

	function resolveAgentRecord(alias: string) {
		const registry = readAgentRegistry();
		const record = registry.agents?.[alias] || null;
		if (!record) throw new Error(`Unknown cmux Pi agent alias: ${alias}`);
		return record;
	}

	function readTeamRegistry() {
		const file = teamRegistryFile();
		if (!existsSync(file)) return registryVersioned("teams", {});
		const parsed = parseJson(readFileSync(file, "utf-8"));
		if (!parsed || typeof parsed !== "object") return registryVersioned("teams", {});
		if (!parsed.teams || typeof parsed.teams !== "object") return registryVersioned("teams", {});
		return {
			version: parsed.version || 1,
			teams: Object.fromEntries(Object.entries(parsed.teams).map(([key, value]) => [key, normalizeRecord(value, "team")])),
		};
	}

	function writeTeamRegistry(registry: any) {
		atomicWriteJson(teamRegistryFile(), registry);
	}

	function upsertTeamRecord(record: any) {
		const registry = readTeamRegistry();
		registry.teams = registry.teams || {};
		registry.teams[record.team] = normalizeRecord({
			...(registry.teams[record.team] || {}),
			...record,
			updatedAt: nowIso(),
		}, "team");
		writeTeamRegistry(registry);
		return registry.teams[record.team];
	}

	function removeTeamRecord(team: string) {
		const registry = readTeamRegistry();
		registry.teams = registry.teams || {};
		const existing = registry.teams[team] || null;
		delete registry.teams[team];
		writeTeamRegistry(registry);
		return existing;
	}

	function resolveTeamRecord(team: string) {
		const registry = readTeamRegistry();
		const record = registry.teams?.[team] || null;
		if (!record) throw new Error(`Unknown cmux Pi team: ${team}`);
		return record;
	}

	function appendRunEvent(runId: string, event: any) {
		if (!runId) return;
		mkdirSync(runEventsDir(), { recursive: true });
		appendFileSync(runEventsFile(runId), JSON.stringify({ timestamp: nowIso(), ...event }) + "\n", "utf-8");
	}

	function readRunEvents(runId: string, limit = 120) {
		const file = runEventsFile(runId);
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => parseJson(line))
			.filter(Boolean)
			.slice(-limit);
	}

	return {
		baseDir,
		sessionsRoot,
		runRegistryFile,
		agentRegistryFile,
		teamRegistryFile,
		runEventsDir,
		runEventsFile,
		defaultSessionPath,
		readRunRegistry,
		writeRunRegistry,
		upsertRunRecord,
		resolveRunRecord,
		readAgentRegistry,
		writeAgentRegistry,
		upsertAgentRecord,
		removeAgentRecord,
		resolveAgentRecord,
		readTeamRegistry,
		writeTeamRegistry,
		upsertTeamRecord,
		removeTeamRecord,
		resolveTeamRecord,
		appendRunEvent,
		readRunEvents,
	};
}
