import { parseStructuredAgentReport, uniqueStrings } from "./cmux-orchestrator-analysis.ts";

export type OrchestratorStatus = "ready" | "working" | "blocked" | "done" | "stalled" | "waiting_review" | "paused" | "active" | "offline";

export interface CaptureDigestLike {
	alias: string;
	team?: string | null;
	role?: string | null;
	status?: string | null;
	blocked?: boolean;
	artifacts?: string[];
	urls?: string[];
	commands?: string[];
	completion?: boolean;
	confidence?: string | null;
	hash?: string | null;
	summary?: string | null;
	next?: string | null;
	needs?: string | null;
	deliverable?: string | null;
	report?: Record<string, string>;
	blockers?: string[];
	dependencies?: Array<Record<string, unknown>>;
}

export interface AgentRecordLike {
	lastCaptureHash?: string | null;
	lastProgressAt?: string | null;
	stallCount?: number;
}

export interface TeamRecordLike {
	team?: string;
	status?: string | null;
	artifactPaths?: string[];
	urls?: string[];
	commands?: string[];
	lastProgressAt?: string | null;
	lastRebalanceKey?: string | null;
}

export interface AppliedAgentDigest {
	digest: CaptureDigestLike;
	status: string;
	changed: boolean;
	progressed: boolean;
	stallCount: number;
	patch: Record<string, unknown>;
}

export interface CompletionGateSpecLike {
	acceptanceCriteria?: string[];
	verificationChecks?: string[];
}

export interface CompletionGateActorLike {
	alias: string;
	role?: string | null;
	team?: string | null;
	live?: boolean | null;
	bridgeStale?: boolean | null;
	browserSurface?: string | null;
	lastObservationSummary?: string | null;
	lastObservationStatus?: string | null;
}

export interface CompletionGateEvaluation {
	gatePresent: boolean;
	acceptanceSatisfied: boolean;
	verificationSatisfied: boolean;
	contradictorySignalsCleared: boolean;
	criticalCoverageSatisfied: boolean;
	canComplete: boolean;
	missingCriticalAliases: string[];
	staleCriticalAliases: string[];
	contradictorySignals: string[];
	unresolvedDependencies: string[];
	unmetAcceptanceCriteria: string[];
	unmetVerificationChecks: string[];
	blockingFindings?: string[];
	failedRepairs?: string[];
	verificationStatus?: string | null;
}

export function applyAgentDigest(current: AgentRecordLike, digest: CaptureDigestLike, now: string, stallThreshold = 2): AppliedAgentDigest {
	const baseStatus = String(digest.status || (digest.blocked ? "blocked" : "working"));
	const changed = !current.lastCaptureHash || current.lastCaptureHash !== digest.hash;
	const stallCount = !changed && baseStatus === "working" ? (current.stallCount || 0) + 1 : 0;
	const status = baseStatus === "working" && stallCount >= stallThreshold ? "stalled" : baseStatus;
	const progressed = changed || status === "done" || Boolean(digest.completion);
	return {
		digest: { ...digest, status },
		status,
		changed,
		progressed,
		stallCount,
		patch: {
			status,
			live: true,
			stallCount,
			lastHeartbeatAt: now,
			lastCaptureAt: now,
			lastProgressAt: progressed ? now : current.lastProgressAt || null,
			lastCaptureHash: digest.hash,
			lastSummary: digest.summary,
			lastArtifacts: digest.artifacts || [],
			lastUrls: digest.urls || [],
			lastCommands: digest.commands || [],
			lastBlockers: digest.blockers || [],
			completion: Boolean(digest.completion),
			confidence: digest.confidence || null,
		},
	};
}

export function buildTeamStatePatch(teamRecord: TeamRecordLike, appliedDigests: AppliedAgentDigest[], now: string) {
	const blockedCount = appliedDigests.filter((item) => item.status === "blocked" || item.digest.blocked).length;
	const stalledCount = appliedDigests.filter((item) => item.status === "stalled").length;
	const doneCount = appliedDigests.filter((item) => item.status === "done" || item.digest.completion).length;
	const liveCount = appliedDigests.length;
	const progressed = appliedDigests.some((item) => item.progressed);
	const artifactPaths = uniqueStrings([...(teamRecord.artifactPaths || []), ...appliedDigests.flatMap((item) => item.digest.artifacts || [])]).slice(0, 64);
	const urls = uniqueStrings([...(teamRecord.urls || []), ...appliedDigests.flatMap((item) => item.digest.urls || [])]).slice(0, 64);
	const commands = uniqueStrings([...(teamRecord.commands || []), ...appliedDigests.flatMap((item) => item.digest.commands || [])]).slice(0, 64);
	const allDone = liveCount > 0 && doneCount === liveCount;
	const status = blockedCount
		? "blocked"
		: teamRecord.status === "paused" && !progressed
			? "paused"
			: stalledCount
				? "stalled"
				: allDone
					? "waiting_review"
					: liveCount
						? "active"
						: "offline";
	return {
		status,
		blockerCount: blockedCount,
		stalledCount,
		completionCount: doneCount,
		artifactPaths,
		urls,
		commands,
		lastHeartbeatAt: now,
		lastProgressAt: progressed ? now : teamRecord.lastProgressAt || null,
	};
}

export function summarizeDigestCollection(digests: CaptureDigestLike[]) {
	const items = digests || [];
	const blockedCount = items.filter((digest) => digest.status === "blocked" || digest.blocked).length;
	const stalledCount = items.filter((digest) => digest.status === "stalled").length;
	const completionCount = items.filter((digest) => digest.status === "done" || digest.completion).length;
	const allSettled = Boolean(items.length) && items.every((digest) => ["done", "ready"].includes(String(digest.status || "")) || Boolean(digest.completion));
	return {
		blockedCount,
		stalledCount,
		completionCount,
		allSettled,
		artifactPaths: uniqueStrings(items.flatMap((digest) => digest.artifacts || [])).slice(0, 128),
		urls: uniqueStrings(items.flatMap((digest) => digest.urls || [])).slice(0, 128),
		commands: uniqueStrings(items.flatMap((digest) => digest.commands || [])).slice(0, 128),
	};
}

export function synthesisIndicatesCompletion(text?: string | null) {
	const report = parseStructuredAgentReport(String(text || ""));
	const overallStatus = String(report.overall_status || report.status || "").toLowerCase();
	if (/(blocked|incomplete|partial|ongoing|working|active|remaining)/.test(overallStatus)) return false;
	if (/(complete|completed|done)/.test(overallStatus)) return true;
	const normalized = String(text || "").toLowerCase();
	if (/(overall status\s*:\s*(complete|completed|done)|work appears complete|no open blockers|remaining work\s*:\s*none|recommended next steps\s*:\s*none)/i.test(normalized)) return true;
	if (/(overall status\s*:\s*(blocked|incomplete|partial|ongoing)|open risks\/blockers\s*:\s*(.+)|remaining work\s*:\s*(?!none))/i.test(normalized)) return false;
	return false;
}

export function digestCollectionHasRemainingWork(digests: CaptureDigestLike[] = []) {
	return (digests || []).some((digest: any) => {
		const report = digest.report || {};
		const next = String(digest.next || report.next || "").toLowerCase();
		const needs = String(digest.needs || report.needs_from_peers || "").toLowerCase();
		const deliverable = String(digest.deliverable || report.deliverable || report.deliverables || report.handoff || report.result || "").toLowerCase();
		if (/(remaining|todo|follow-?up|continue|need to|pending|not done|in progress|working)/.test(next)) return true;
		if (needs && !/(none|n\/a|nope|nothing)/.test(needs)) return true;
		if (digest.blocked || (digest.blockers || []).length) return true;
		if (deliverable && /(draft|partial|initial|wip)/.test(deliverable)) return true;
		return false;
	});
}

export function deriveRunStatus(digests: CaptureDigestLike[], options: { synthesisText?: string | null; coordinatorText?: string | null } = {}) {
	const summary = summarizeDigestCollection(digests);
	const synthesisComplete = synthesisIndicatesCompletion(options.synthesisText);
	const coordinatorComplete = synthesisIndicatesCompletion(options.coordinatorText);
	const enoughCompletionSignals = summary.allSettled || (digests.length > 0 && summary.completionCount >= Math.ceil(digests.length * 0.75));
	const remainingWork = digestCollectionHasRemainingWork(digests);
	const completionConfirmed = (synthesisComplete || coordinatorComplete) && enoughCompletionSignals && !remainingWork;
	const readyForReview = summary.allSettled && !remainingWork;
	const status = summary.blockedCount
		? "blocked"
		: summary.stalledCount
			? "stalled"
			: completionConfirmed
				? "done"
				: readyForReview
					? "waiting_review"
					: "active";
	return {
		...summary,
		synthesisComplete,
		coordinatorComplete,
		remainingWork,
		status,
		completed: status === "done",
	};
}

function hasVerificationRoleEvidence(digests: CaptureDigestLike[] = [], actors: CompletionGateActorLike[] = []) {
	const roleSignal = (digests || []).some((item: any) => /(review|reviewer|tester|verifier|qa|navigator|integrator)/i.test(String(item?.role || "")));
	const liveActorSignal = (actors || []).some((item: any) => item?.live !== false && /(review|reviewer|tester|verifier|qa|navigator|integrator)/i.test(String(item?.role || "")) && /(done|ready|approved|verified)/i.test(String(item?.lastObservationStatus || item?.lastObservationSummary || "")));
	const summarySignal = (digests || []).some((digest: any) => /(review complete|verified|validation complete|tested|qa complete|signoff|approved)/i.test(String(digest?.summary || "")));
	const commandSignal = (digests || []).some((digest: any) => Array.isArray(digest?.commands) && digest.commands.length > 0);
	return roleSignal || liveActorSignal || summarySignal || commandSignal;
}

function hasBrowserEvidence(digests: CaptureDigestLike[] = [], actors: CompletionGateActorLike[] = []) {
	const digestEvidence = (digests || []).some((digest: any) => /(browser|page|ui|workflow|form|verify page|verified page|captured page|navigated|checkpoint)/i.test(String(digest?.summary || "")) || (Array.isArray(digest?.urls) && digest.urls.length > 0));
	const actorEvidence = (actors || []).some((actor: any) => Boolean(actor?.browserSurface) && /(verified|observed|captured|navigated|ready|done|approved)/i.test(String(actor?.lastObservationStatus || actor?.lastObservationSummary || "")));
	return digestEvidence || actorEvidence;
}

function hasDocsEvidence(digests: CaptureDigestLike[] = []) {
	return (digests || []).some((digest: any) => Array.isArray(digest?.artifacts) && digest.artifacts.some((item: string) => /\.(md|txt|rst)$/i.test(String(item))))
		|| (digests || []).some((digest: any) => /(docs|readme|writeup|notes|summary)/i.test(String(digest?.summary || "")));
}

function criticalAliasSet(teamRecords: any[] = [], actors: CompletionGateActorLike[] = []) {
	const expected = uniqueStrings((teamRecords || []).flatMap((teamRecord: any) => (teamRecord?.members || []).map((member: any) => member.alias)));
	if (!expected.length) return new Set<string>();
	if (expected.length <= 2) return new Set(expected);
	const critical = uniqueStrings((teamRecords || []).flatMap((teamRecord: any) => (teamRecord?.members || [])
		.filter((member: any) => /(lead|review|reviewer|verifier|tester|navigator|integrator|manager|coordinator)/i.test(String(member?.role || member?.alias || "")))
		.map((member: any) => member.alias)));
	if (critical.length) return new Set(critical);
	return new Set(uniqueStrings((actors || [])
		.filter((actor: any) => /(lead|review|reviewer|verifier|tester|navigator|integrator|manager|coordinator)/i.test(String(actor?.role || actor?.alias || "")))
		.map((actor: any) => actor.alias)));
}

export function evaluateCompletionGate(
	digests: CaptureDigestLike[] = [],
	options: {
		gate?: CompletionGateSpecLike | null;
		executionContract?: CompletionGateSpecLike | null;
		teamRecords?: any[];
		agentRecords?: CompletionGateActorLike[];
		doctorFindings?: any[];
		repairActions?: any[];
		repairExecutionLog?: any[];
		verificationState?: any;
	} = {},
): CompletionGateEvaluation {
	const gate = options.gate || options.executionContract || null;
	const gatePresent = Boolean(gate && ((gate.acceptanceCriteria && gate.acceptanceCriteria.length) || (gate.verificationChecks && gate.verificationChecks.length)));
	if (!gatePresent) {
		return {
			gatePresent: false,
			acceptanceSatisfied: true,
			verificationSatisfied: true,
			contradictorySignalsCleared: true,
			criticalCoverageSatisfied: true,
			canComplete: true,
			missingCriticalAliases: [],
			staleCriticalAliases: [],
			contradictorySignals: [],
			unresolvedDependencies: [],
			unmetAcceptanceCriteria: [],
			unmetVerificationChecks: [],
			blockingFindings: [],
			failedRepairs: [],
			verificationStatus: null,
		};
	}
	const actors = options.agentRecords || [];
	const doctorFindings = options.doctorFindings || [];
	const repairActions = options.repairActions || [];
	const repairExecutionLog = options.repairExecutionLog || [];
	const verificationState = options.verificationState || null;
	const expectedAliases = uniqueStrings((options.teamRecords || []).flatMap((teamRecord: any) => (teamRecord?.members || []).map((member: any) => member.alias)));
	const presentAliases = new Set((digests || []).map((digest) => digest.alias));
	const criticalAliases = criticalAliasSet(options.teamRecords || [], actors);
	const missingCriticalAliases = uniqueStrings((expectedAliases || []).filter((alias) => criticalAliases.has(alias) && !presentAliases.has(alias)));
	const staleCriticalAliases = uniqueStrings((actors || []).filter((actor: any) => criticalAliases.has(actor.alias) && (actor?.bridgeStale || actor?.live === false)).map((actor) => actor.alias));
	const unresolvedDependencies = uniqueStrings((digests || []).flatMap((digest: any) => (digest.dependencies || [])
		.filter((dependency: any) => String(dependency?.status || "open") !== "resolved")
		.map((dependency: any) => `${digest.alias}:${dependency.targetHint || dependency.target || dependency.text || dependency.kind || "dependency"}`)));
	const blockingFindings = uniqueStrings((doctorFindings || [])
		.filter((finding: any) => ["critical", "high"].includes(String(finding?.severity || "")) || ["false_complete_suspicion", "offline_team", "dependency_deadlock", "degraded_team", "missing_output", "stale_bridge", "run_missing_team"].includes(String(finding?.kind || "")))
		.map((finding: any) => `${finding.kind}:${finding.alias || finding.team || finding.runId || "scope"}`));
	const failedRepairs = uniqueStrings((repairExecutionLog || [])
		.filter((item: any) => /(failed|mixed)/i.test(String(item?.status || "")))
		.map((item: any) => `${item.action || "repair"}:${item.status || "failed"}`));
	const pendingRepairs = uniqueStrings((repairActions || [])
		.filter((item: any) => Boolean(item?.safeAutoExecute))
		.map((item: any) => `${item.action || "repair"}:${item.alias || item.team || item.runId || "scope"}`));
	const contradictorySignals = uniqueStrings([
		...(digestCollectionHasRemainingWork(digests) ? ["remaining-work-signals"] : []),
		...(digests.filter((digest: any) => digest.status === "blocked" || digest.blocked).map((digest) => `blocked:${digest.alias}`)),
		...(digests.filter((digest: any) => digest.status === "stalled").map((digest) => `stalled:${digest.alias}`)),
		...(unresolvedDependencies.length ? unresolvedDependencies.map((item) => `dependency:${item}`) : []),
		...(blockingFindings.length ? blockingFindings.map((item) => `finding:${item}`) : []),
		...(failedRepairs.length ? failedRepairs.map((item) => `repair_failed:${item}`) : []),
		...((verificationState?.status && !["approved", "none"].includes(String(verificationState.status))) ? [`verification:${verificationState.status}`] : []),
	]);
	const completionSignals = (digests || []).filter((digest: any) => digest.status === "done" || digest.completion).length;
	const deliverableEvidence = Boolean(completionSignals > 0 || (digests || []).some((digest: any) => (digest.deliverable || (digest.artifacts || []).length || (digest.commands || []).length || (digest.urls || []).length)));
	const verificationEvidence = hasVerificationRoleEvidence(digests, actors) || verificationState?.status === "approved";
	const browserEvidence = hasBrowserEvidence(digests, actors);
	const docsEvidence = hasDocsEvidence(digests);
	const unmetAcceptanceCriteria = uniqueStrings((gate.acceptanceCriteria || []).filter((criterion: string) => {
		const normalized = String(criterion || "").toLowerCase();
		if (/(blocker|dependenc)/.test(normalized)) return unresolvedDependencies.length > 0 || contradictorySignals.some((item) => item.startsWith("blocked:"));
		if (/(repair|resolve issue|health|stability|doctor)/.test(normalized)) return blockingFindings.length > 0 || failedRepairs.length > 0;
		if (/(browser|page|ui|workflow|form)/.test(normalized)) return !browserEvidence || staleCriticalAliases.length > 0;
		if (/(review|validate|verify|test|qa)/.test(normalized)) return !verificationEvidence;
		if (/(doc|readme|writeup|notes|summary)/.test(normalized)) return !docsEvidence;
		if (/(exist|complete|deliverable|result|outcome|implement|integrated)/.test(normalized)) return !deliverableEvidence;
		return contradictorySignals.length > 0;
	}));
	const unmetVerificationChecks = uniqueStrings((gate.verificationChecks || []).filter((check: string) => {
		const normalized = String(check || "").toLowerCase();
		if (/(browser|page|ui|workflow|form)/.test(normalized)) return !browserEvidence || staleCriticalAliases.length > 0;
		if (/(reviewer|review|verify|validation|tester|qa|signoff)/.test(normalized)) return !verificationEvidence || ["requested", "inconclusive", "rejected"].includes(String(verificationState?.status || ""));
		if (/(repair|resolve issue|health|doctor)/.test(normalized)) return blockingFindings.length > 0 || failedRepairs.length > 0;
		if (/(command|test|verification command|run or review)/.test(normalized)) return !(digests || []).some((digest: any) => Array.isArray(digest.commands) && digest.commands.length > 0);
		if (/(contradictory|no contradictory)/.test(normalized)) return contradictorySignals.length > 0;
		if (/(inspect|compare|artifact|output)/.test(normalized)) return !deliverableEvidence;
		return contradictorySignals.length > 0;
	}));
	const acceptanceSatisfied = unmetAcceptanceCriteria.length === 0;
	const verificationSatisfied = unmetVerificationChecks.length === 0;
	const contradictorySignalsCleared = contradictorySignals.length === 0;
	const criticalCoverageSatisfied = missingCriticalAliases.length === 0 && staleCriticalAliases.length === 0;
	return {
		gatePresent,
		acceptanceSatisfied,
		verificationSatisfied,
		contradictorySignalsCleared,
		criticalCoverageSatisfied,
		canComplete: acceptanceSatisfied && verificationSatisfied && contradictorySignalsCleared && criticalCoverageSatisfied,
		missingCriticalAliases,
		staleCriticalAliases,
		contradictorySignals,
		unresolvedDependencies,
		unmetAcceptanceCriteria,
		unmetVerificationChecks,
		blockingFindings,
		failedRepairs,
		verificationStatus: verificationState?.status || null,
	};
}

export function enforceCompletionGateDecision(baseDecision: any, gate: CompletionGateEvaluation) {
	if (!gate?.gatePresent) return { ...baseDecision, completionGate: gate || null, completionGateSatisfied: true };
	let status = String(baseDecision?.status || "active");
	if ((status === "done" || status === "waiting_review") && !gate.canComplete) {
		status = gate.contradictorySignalsCleared && gate.criticalCoverageSatisfied ? "waiting_review" : "active";
	}
	return {
		...baseDecision,
		status,
		completed: status === "done",
		remainingWork: Boolean(baseDecision?.remainingWork || !gate.canComplete),
		completionGate: gate,
		completionGateSatisfied: gate.canComplete,
	};
}

export function shouldAutoRebalance(teamRecord: TeamRecordLike, digests: CaptureDigestLike[], round: number) {
	const blockedAliases = uniqueStrings(digests.filter((digest) => digest.status === "blocked" || digest.blocked).map((digest) => digest.alias));
	const stalledAliases = uniqueStrings(digests.filter((digest) => digest.status === "stalled").map((digest) => digest.alias));
	const dependencyAliases = uniqueStrings(digests
		.filter((digest) => (digest.dependencies || []).some((dependency: any) => String(dependency?.status || "open") !== "resolved" && (dependency.blocked || dependency.requiresAck)))
		.map((digest) => digest.alias));
	const should = blockedAliases.length > 0 || stalledAliases.length > 0 || dependencyAliases.length > 0;
	const key = `b:${blockedAliases.join(",")}|s:${stalledAliases.join(",")}|d:${dependencyAliases.join(",")}`;
	if (!should) {
		return { should: false, repeated: false, key, reason: "healthy" };
	}
	if (teamRecord.lastRebalanceKey && teamRecord.lastRebalanceKey === key) {
		return { should: false, repeated: true, key, reason: "already rebalanced for same blockers/stalls/dependencies" };
	}
	return {
		should: true,
		repeated: false,
		key,
		reason: blockedAliases.length
			? `blocked=${blockedAliases.join(",")}`
			: stalledAliases.length
				? `stalled=${stalledAliases.join(",")}${round > 1 ? " repeated-round" : ""}`
				: `dependencies=${dependencyAliases.join(",")}`,
		blockedAliases,
		stalledAliases,
		dependencyAliases,
	};
}
