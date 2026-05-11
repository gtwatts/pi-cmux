// @ts-nocheck
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bridgeRoot, writeCmuxBridgeAuxEvent } from "./cmux-pi-bridge-shared.ts";
import { createOrchestratorStorage } from "./cmux-orchestrator-storage.ts";

const ORCHESTRATOR_STORAGE = createOrchestratorStorage({
	baseDir: join(homedir(), ".pi", "agent", ".cmux-orchestrator"),
	sessionsRoot: join(homedir(), ".pi", "agent", "sessions", "cmux-orchestrator"),
});

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

function cleanText(value: unknown, max = 400) {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function linesText(value: unknown, max = 6) {
	return String(value ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, max)
		.join("\n");
}

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function readJson(path: string, fallback: any = null) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return fallback;
	}
}

function readJsonlTail(path: string, limit = 120) {
	if (!existsSync(path)) return [] as any[];
	try {
		return readFileSync(path, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(2000, Number(limit || 120))))
			.map((line) => parseJson(line))
			.filter(Boolean);
	} catch {
		return [] as any[];
	}
}

function uniqueStrings(items: any[] = []) {
	return Array.from(new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function inferScope(ctx: any, params: Record<string, any> = {}) {
	const cwd = resolve(String(params.cwd || ctx?.cwd || process.cwd()));
	const projectLabel = cwd.split("/").filter(Boolean).pop() || "project";
	return {
		cwd,
		projectId: params.projectId || params.taskId || process.env.KB_TASK_ID || process.env.CMUX_KB_TASK_ID || projectLabel,
		projectLabel,
		taskId: params.taskId || process.env.KB_TASK_ID || process.env.CMUX_KB_TASK_ID || null,
		runId: params.runId || process.env.PI_CMUX_RUN_ID || process.env.CMUX_RUN_ID || null,
		teamId: params.teamId || process.env.PI_CMUX_TEAM_ID || process.env.CMUX_TEAM_ID || null,
		agentAlias: params.agentAlias || process.env.PI_CMUX_AGENT_ALIAS || process.env.CMUX_AGENT_ALIAS || null,
		workspaceId: params.workspaceId || process.env.CMUX_WORKSPACE_ID || null,
		surfaceId: params.surfaceId || process.env.CMUX_SURFACE_ID || null,
	};
}

function matchesScope(item: any, scope: any) {
	if (!item) return false;
	const taskId = item.taskId || item.task_id || item?.cmux?.kbTaskId || item?.identity?.task_id || null;
	const runId = item.runId || item.run_id || item?.cmux?.runId || item?.identity?.run_id || null;
	const teamId = item.teamId || item.team_id || item?.cmux?.teamId || item?.identity?.team_id || null;
	const agentAlias = item.agentAlias || item.agent_alias || item?.cmux?.agentAlias || item?.identity?.agent_alias || null;
	const workspaceId = item.workspaceId || item.workspace_id || item?.cmux?.workspaceId || item?.identity?.workspace_id || null;
	if (scope.runId && runId === scope.runId) return true;
	if (scope.taskId && taskId === scope.taskId) return true;
	if (scope.teamId && teamId === scope.teamId) return true;
	if (scope.agentAlias && agentAlias === scope.agentAlias) return true;
	if (scope.workspaceId && workspaceId === scope.workspaceId) return true;
	if (!scope.runId && !scope.taskId && !scope.teamId && !scope.agentAlias && !scope.workspaceId) {
		return String(item.cwd || item?.status?.cwd || "") === String(scope.cwd || "");
	}
	return false;
}

function eventAgeSummary(timestamp?: string | null) {
	if (!timestamp) return { ageMs: null, ageMinutes: null, stale: null };
	const ageMs = Date.now() - new Date(timestamp).getTime();
	if (!Number.isFinite(ageMs)) return { ageMs: null, ageMinutes: null, stale: null };
	return { ageMs, ageMinutes: Math.round(ageMs / 60_000), stale: ageMs > 15 * 60_000 };
}

function eventText(event: any) {
	const payload = event?.payload || {};
	return [
		event?.type,
		event?.event_type,
		payload.summary,
		payload.contentPreview,
		payload.promptPreview,
		payload.toolName,
		payload.command,
		payload.title,
		payload.note,
		payload.details,
		event?.agent_alias,
		event?.team_id,
		event?.run_id,
	].filter(Boolean).join(" \n ");
}

function readBridgeSessions(scope: any, limit = 40) {
	const index = readJson(join(bridgeRoot(), "index.json"), { sessions: [] });
	const sessions = Array.isArray(index?.sessions) ? index.sessions : [];
	return sessions
		.filter((item: any) => matchesScope(item, scope))
		.sort((a: any, b: any) => String(b.lastEventAt || "").localeCompare(String(a.lastEventAt || "")))
		.slice(0, limit)
		.map((item: any) => ({ ...item, bridgeAge: eventAgeSummary(item.lastEventAt) }));
}

function readBridgeEvents(scope: any, limit = 120) {
	const sessions = readBridgeSessions(scope, 30);
	const events = sessions.flatMap((session: any) => readJsonlTail(session.eventsPath, 120));
	return events
		.filter((event: any) => matchesScope(event, scope))
		.sort((a: any, b: any) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")) || Number(b.sequence || 0) - Number(a.sequence || 0))
		.slice(0, limit);
}

function appendLocalRunEvent(scope: any, event: any) {
	if (!scope.runId) return;
	try {
		ORCHESTRATOR_STORAGE.appendRunEvent(scope.runId, event);
	} catch {
		// ignore local storage errors
	}
}

function summarizeBridgeEvents(events: any[] = []) {
	const blockerCandidates = events.filter((event) => /(blocker|blocked|stalled|failed|error)/i.test(String(event?.type || "") + " " + eventText(event)));
	const decisionCandidates = events.filter((event) => /(decision|accepted|chosen|recommended)/i.test(String(event?.type || "") + " " + eventText(event)));
	const handoffCandidates = events.filter((event) => /(handoff|next step|continue later|pick up)/i.test(String(event?.type || "") + " " + eventText(event)));
	const approvalCandidates = events.filter((event) => /(approval|risky|danger|destructive|deploy|publish|auth-change)/i.test(String(event?.type || "") + " " + eventText(event)));
	const toolFailures = events.filter((event) => event?.type === "tool_result" && event?.payload?.isError);
	return {
		blockerCandidates,
		decisionCandidates,
		handoffCandidates,
		approvalCandidates,
		toolFailures,
		recentAliases: uniqueStrings(events.map((event) => event.agent_alias).filter(Boolean)).slice(0, 8),
	};
}

function readRunContext(scope: any) {
	const run = scope.runId ? readJson(ORCHESTRATOR_STORAGE.runRegistryFile(), { runs: {} })?.runs?.[scope.runId] || null : null;
	const agentsRegistry = readJson(ORCHESTRATOR_STORAGE.agentRegistryFile(), { agents: {} });
	const teamsRegistry = readJson(ORCHESTRATOR_STORAGE.teamRegistryFile(), { teams: {} });
	const agents = Object.values(agentsRegistry?.agents || {}).filter((agent: any) => !scope.runId || agent.runId === scope.runId);
	const teams = Object.values(teamsRegistry?.teams || {}).filter((team: any) => !scope.runId || team.runId === scope.runId);
	return { run, agents, teams };
}

function deriveLocalActions(scope: any, snapshot: any) {
	const actions: string[] = [];
	if (!snapshot.sessions.length) {
		actions.push("No matching CMUX bridge sessions found. Verify the target agent or team is still running.");
	}
	if (snapshot.staleSessions.length) {
		actions.push(`Inspect stale sessions: ${snapshot.staleSessions.map((item: any) => item.agentAlias || item.sessionId).join(", ")}.`);
	}
	if (snapshot.summary.blockerCandidates.length) {
		actions.push(`Review blocker signals from ${snapshot.summary.blockerCandidates[0]?.agent_alias || snapshot.summary.blockerCandidates[0]?.team_id || "the latest run activity"}.`);
	}
	if (snapshot.summary.toolFailures.length) {
		actions.push(`Inspect ${snapshot.summary.toolFailures.length} recent tool failure(s) before continuing automation.`);
	}
	if (snapshot.summary.approvalCandidates.length) {
		actions.push("Review recent risky/destructive activity hints before continuing.");
	}
	if (snapshot.run?.status === "blocked") {
		actions.push(`Run ${scope.runId} is marked blocked in orchestrator state. Resolve blockers before relaunching work.`);
	}
	if (snapshot.run?.status === "waiting_review") {
		actions.push(`Run ${scope.runId} is waiting for review. Inspect artifacts and synthesis before resuming.`);
	}
	if (snapshot.summary.handoffCandidates.length) {
		actions.push("Review the latest handoff candidate so the next operator resumes from the right point.");
	}
	if (!actions.length) {
		actions.push("No urgent local coordination issues detected. Continue the current CMUX execution path.");
	}
	return uniqueStrings(actions).slice(0, 8);
}

function buildLocalSnapshot(scope: any, limit = 8) {
	const sessions = readBridgeSessions(scope, 20);
	const events = readBridgeEvents(scope, 120);
	const { run, agents, teams } = readRunContext(scope);
	const summary = summarizeBridgeEvents(events);
	const staleSessions = sessions.filter((session: any) => session.bridgeAge?.stale);
	const snapshot = {
		scope,
		run,
		agents,
		teams,
		sessions,
		staleSessions,
		events: events.slice(0, Math.max(1, limit * 10)),
		summary,
		counts: {
			sessions: sessions.length,
			staleSessions: staleSessions.length,
			events: events.length,
			blockers: summary.blockerCandidates.length,
			decisions: summary.decisionCandidates.length,
			handoffs: summary.handoffCandidates.length,
			approvalHints: summary.approvalCandidates.length,
			toolFailures: summary.toolFailures.length,
			agents: agents.length,
			teams: teams.length,
		},
	};
	return { ...snapshot, actions: deriveLocalActions(scope, snapshot) };
}

function localPolicyCheck(taskText: string, options: { targetCount?: number; requestedBy?: string; externalTarget?: string } = {}) {
	const normalized = String(taskText || "").toLowerCase();
	const destructive = /(delete|remove|drop|destroy|wipe|clean|prune|rm -rf|shutdown|close|stop)/.test(normalized);
	const external = /(deploy|publish|release|api|curl|wget|fetch|post|upload|send|email|slack|notify|webhook)/.test(normalized);
	const auth = /(auth|login|password|secret|token|key|credential|certificate|ssl|tls)/.test(normalized);
	const multiFile = /(migrate|refactor|rename|move|multi|across|several|many files|batch)/.test(normalized);
	let riskLevel = "low";
	if (destructive || auth) riskLevel = "high";
	else if (external || multiFile || (options.targetCount || 0) >= 4) riskLevel = "medium";
	let actionType = "edit";
	if (destructive) actionType = "delete";
	else if (external) actionType = "external-api";
	else if (auth) actionType = "auth-change";
	return {
		riskLevel,
		actionType,
		targetCount: options.targetCount || 0,
		externalTarget: options.externalTarget || "",
		destructive,
		requestedBy: options.requestedBy || "orchestrator",
	};
}

export function syncSwarmPresence(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; projectLabel?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string; workspaceId?: string | null; surfaceId?: string | null },
	update: { status: string; note?: string },
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	appendLocalRunEvent(scope, { type: "presence_updated", alias: scope.agentAlias, team: scope.teamId, status: update.status, detail: cleanText(update.note, 220), source: "cmux-ops" });
	return writeCmuxBridgeAuxEvent(ctx, "orchestrator_presence_updated", {
		status: update.status,
		note: update.note || null,
		summary: `Presence updated for ${scope.agentAlias || "agent"}: ${update.status}`,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
		workspaceId: scope.workspaceId,
		surfaceId: scope.surfaceId,
	}).catch(() => null);
}

export function raiseSwarmBlocker(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; projectId?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string },
	payload: { title: string; details: string; severity?: string; ownerAlias?: string },
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	appendLocalRunEvent(scope, { type: "blocker_raised", alias: scope.agentAlias, team: scope.teamId, status: payload.severity || "medium", detail: `${payload.title} — ${cleanText(payload.details, 240)}`, source: "cmux-ops" });
	return writeCmuxBridgeAuxEvent(ctx, "orchestrator_blocker_raised", {
		title: payload.title,
		details: payload.details,
		severity: payload.severity || "medium",
		ownerAlias: payload.ownerAlias || scope.agentAlias || null,
		summary: payload.title,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
	}).catch(() => null);
}

export function recordSwarmDecision(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; runId?: string | null; teamId?: string | null; agentAlias?: string; workspaceId?: string | null; surfaceId?: string | null },
	payload: { summary: string; rationale?: string; status?: string },
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	appendLocalRunEvent(scope, { type: "decision_recorded", alias: scope.agentAlias, team: scope.teamId, status: payload.status || "accepted", detail: cleanText(`${payload.summary}${payload.rationale ? ` — ${payload.rationale}` : ""}`, 260), source: "cmux-ops" });
	return writeCmuxBridgeAuxEvent(ctx, "orchestrator_decision_recorded", {
		summary: payload.summary,
		rationale: payload.rationale || null,
		status: payload.status || "accepted",
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
		workspaceId: scope.workspaceId,
		surfaceId: scope.surfaceId,
	}).catch(() => null);
}

export function createSwarmHandoff(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; runId?: string | null; teamId?: string | null; agentAlias?: string; workspaceId?: string | null; surfaceId?: string | null },
	payload: { summary: string; nextAction: string; status?: string; toAgent?: string },
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	appendLocalRunEvent(scope, { type: "handoff_created", alias: scope.agentAlias, team: scope.teamId, status: payload.status || "open", detail: cleanText(`${payload.summary} Next: ${payload.nextAction}`, 260), source: "cmux-ops" });
	return writeCmuxBridgeAuxEvent(ctx, "orchestrator_handoff_created", {
		summary: payload.summary,
		nextAction: payload.nextAction,
		status: payload.status || "open",
		toAgent: payload.toAgent || null,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
		workspaceId: scope.workspaceId,
		surfaceId: scope.surfaceId,
	}).catch(() => null);
}

export async function getControlRoomSnapshot(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; projectId?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string; limit?: number },
	_limit?: number,
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	const snapshot = buildLocalSnapshot(scope, identity.limit || _limit || 8);
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_control_room_snapshot", {
		summary: autoSummaryFromSnapshot(snapshot),
		actionCount: snapshot.actions.length,
		sessionCount: snapshot.counts.sessions,
		staleSessionCount: snapshot.counts.staleSessions,
		blockerCount: snapshot.counts.blockers,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
	}).catch(() => null);
	return snapshot;
}

export async function getControlRoomNextActions(
	pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; projectId?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string; limit?: number },
	_limit?: number,
	_options?: { signal?: AbortSignal },
) {
	const snapshot = await getControlRoomSnapshot(pi, ctx, identity, _limit, _options);
	const actions = snapshot?.actions || [];
	const scope = inferScope(ctx, identity as any);
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_control_room_actions", {
		actions,
		summary: actions[0] || "No control-room actions.",
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
	}).catch(() => null);
	return actions;
}

export async function checkApprovalPolicy(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { cwd?: string; projectId?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string },
	riskSpec: { riskLevel: string; actionType: string; targetCount?: number; externalTarget?: string; destructive?: boolean; requestedBy?: string },
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	const levelRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
	const score = levelRank[String(riskSpec.riskLevel || "low").toLowerCase()] || 1;
	const shouldRequest = Boolean(score >= 3 || riskSpec.destructive || ["delete", "auth-change", "deploy", "external-api"].includes(String(riskSpec.actionType || "")));
	const reasons = [] as string[];
	if (score >= 3) reasons.push(`risk level is ${riskSpec.riskLevel}`);
	if (riskSpec.destructive) reasons.push("operation appears destructive");
	if (["delete", "auth-change", "deploy", "external-api"].includes(String(riskSpec.actionType || ""))) reasons.push(`action type ${riskSpec.actionType} is sensitive`);
	if ((riskSpec.targetCount || 0) >= 8) reasons.push(`target count ${riskSpec.targetCount} is large`);
	const policy = {
		shouldRequest,
		reasons,
		recommendedReviewer: shouldRequest ? "human-operator" : "none",
		action: shouldRequest ? "pause_for_review" : "continue",
	};
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_approval_policy_checked", {
		riskLevel: riskSpec.riskLevel,
		actionType: riskSpec.actionType,
		shouldRequest,
		reasons,
		summary: shouldRequest ? `Approval recommended for ${riskSpec.actionType}.` : `Approval not required for ${riskSpec.actionType}.`,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
	}).catch(() => null);
	return { policy };
}

export async function recallSwarmMemory(
	_pi: ExtensionAPI,
	ctx: any,
	identity: { projectId?: string; taskId?: string | null; runId?: string | null; teamId?: string | null; agentAlias?: string; limit?: number },
	query: string,
	limit?: number,
	_options?: { signal?: AbortSignal },
) {
	const scope = inferScope(ctx, identity as any);
	const q = cleanText(query, 200).toLowerCase();
	const bridgeEvents = readBridgeEvents(scope, 240).filter((event: any) => !q || eventText(event).toLowerCase().includes(q));
	const runEvents = scope.runId ? ORCHESTRATOR_STORAGE.readRunEvents(scope.runId, 240).filter((event: any) => !q || JSON.stringify(event).toLowerCase().includes(q)) : [];
	const max = Math.max(1, identity.limit || limit || 6);
	const results = {
		findings: bridgeEvents.filter((event: any) => ["tool_result", "turn_end", "orchestrator_presence_updated"].includes(String(event.type || event.event_type || ""))).slice(0, max),
		decisions: bridgeEvents.filter((event: any) => /decision/.test(String(event.type || event.event_type || ""))).concat(runEvents.filter((event: any) => /decision/.test(String(event.type || "")))).slice(0, max),
		blockers: bridgeEvents.filter((event: any) => /blocker|blocked|failed|error/.test(String(event.type || event.event_type || "") + " " + eventText(event))).concat(runEvents.filter((event: any) => /blocker|blocked/.test(String(event.type || "") + " " + JSON.stringify(event)))).slice(0, max),
		handoffs: bridgeEvents.filter((event: any) => /handoff/.test(String(event.type || event.event_type || "") + " " + eventText(event))).concat(runEvents.filter((event: any) => /handoff/.test(String(event.type || "") + " " + JSON.stringify(event)))).slice(0, max),
	};
	const payload = {
		query,
		counts: {
			findings: results.findings.length,
			decisions: results.decisions.length,
			blockers: results.blockers.length,
			handoffs: results.handoffs.length,
		},
		results,
	};
	await writeCmuxBridgeAuxEvent(ctx, "orchestrator_memory_recalled", {
		query,
		counts: payload.counts,
		summary: `Local control-plane recall for query: ${cleanText(query, 120)}`,
	}, undefined, {
		taskId: scope.taskId,
		runId: scope.runId,
		teamId: scope.teamId,
		agentAlias: scope.agentAlias,
	}).catch(() => null);
	return { scope, recall: payload };
}

export function extractBridgeHintsFromText(text: string) {
	const normalized = cleanText(text, 1200).toLowerCase();
	const hints: any[] = [];
	if (!normalized) return hints;
	if (/(\bblocked\b|stuck|waiting on|cannot proceed|can't proceed|need approval|need human|permission denied|missing credential|requires approval)/.test(normalized)) {
		hints.push({ type: "orchestrator_hint_blocker_candidate", summary: "Possible blocker detected in agent output." });
	}
	if (/(\bdecision\b|decided to|we should|i chose|chosen approach|recommended path|final approach)/.test(normalized)) {
		hints.push({ type: "orchestrator_hint_decision_candidate", summary: "Possible decision candidate detected in agent output." });
	}
	if (/(handoff|next agent|next step for|continue later|pick up from here|for whoever continues)/.test(normalized)) {
		hints.push({ type: "orchestrator_hint_handoff_candidate", summary: "Possible handoff candidate detected in agent output." });
	}
	return hints;
}

export function extractApprovalCandidateFromToolEvent(toolName: string, input: any, contentPreview?: string) {
	const name = String(toolName || "").toLowerCase();
	const inputText = cleanText(typeof input === "string" ? input : JSON.stringify(input || {}), 1200).toLowerCase();
	const preview = cleanText(contentPreview || "", 400).toLowerCase();
	const riskyCommand = /(rm\s+-rf|git\s+push|npm\s+publish|pnpm\s+publish|vercel|netlify|kubectl|terraform\s+apply|stripe|billing|auth|secret|deploy|production)/.test(`${inputText} ${preview}`);
	if (name === "edit" && /(auth|billing|security|secret|token|credential|deploy|prod)/.test(inputText)) {
		return { type: "orchestrator_hint_approval_candidate", summary: "Edit appears to touch risky scope and may need approval.", riskLevel: "high" };
	}
	if ((name === "bash" || name === "user_bash") && riskyCommand) {
		return { type: "orchestrator_hint_approval_candidate", summary: "Shell activity appears risky and may need approval.", riskLevel: "high" };
	}
	if (name.includes("deploy") || name.includes("approval") || name.includes("publish")) {
		return { type: "orchestrator_hint_approval_candidate", summary: "Tool invocation suggests deploy/publish behavior and may need approval.", riskLevel: "high" };
	}
	return null;
}

export function buildAutoRiskSpecFromTask(
	taskText: string,
	options: { targetCount?: number; requestedBy?: string; externalTarget?: string } = {},
) {
	return localPolicyCheck(taskText, options);
}

export function autoSummaryFromSnapshot(snapshot: any) {
	if (!snapshot) return "No local control-plane data available.";
	if (typeof snapshot === "string") return snapshot;
	const parts = [] as string[];
	if (snapshot.run?.status) parts.push(`run=${snapshot.run.status}`);
	if (snapshot.counts?.sessions !== undefined) parts.push(`sessions=${snapshot.counts.sessions}`);
	if (snapshot.counts?.staleSessions) parts.push(`stale=${snapshot.counts.staleSessions}`);
	if (snapshot.counts?.blockers) parts.push(`blockers=${snapshot.counts.blockers}`);
	if (snapshot.counts?.toolFailures) parts.push(`toolFailures=${snapshot.counts.toolFailures}`);
	if (snapshot.actions?.length) parts.push(`next: ${snapshot.actions[0]}`);
	return parts.join(" ") || "Local control snapshot ready.";
}

export function candidateExcerpt(text: string) {
	return linesText(text, 4);
}
