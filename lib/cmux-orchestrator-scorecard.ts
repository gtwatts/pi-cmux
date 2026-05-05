import { deriveRunStatus, type CaptureDigestLike } from "./cmux-orchestrator-decisions.ts";

function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function average(values: number[] = []) {
	if (!values.length) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number | null, digits = 2) {
	if (value === null || Number.isNaN(value)) return null;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function summarize(text?: string | null, max = 180) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isoMs(value?: string | null) {
	const stamp = String(value || "").trim();
	if (!stamp) return null;
	const parsed = Date.parse(stamp);
	return Number.isFinite(parsed) ? parsed : null;
}

function durationMs(start?: string | null, end?: string | null) {
	const a = isoMs(start);
	const b = isoMs(end);
	if (a === null || b === null) return null;
	return Math.max(0, b - a);
}

function openDependencies(dependencies: any[] = []) {
	return (dependencies || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved");
}

function dependencyKeys(digests: CaptureDigestLike[] = []) {
	return uniqueStrings((digests || []).flatMap((digest: any) => openDependencies(digest.dependencies || [])
		.map((dependency: any) => `${digest.alias}->${dependency.targetHint || dependency.target || dependency.text || dependency.kind || "dependency"}`)));
}

function misleadingDoneAliases(digests: CaptureDigestLike[] = []) {
	return uniqueStrings((digests || [])
		.filter((digest: any) => (digest.status === "done" || digest.completion) && (
			Boolean(digest.blocked)
			|| Boolean((digest.blockers || []).length)
			|| Boolean(openDependencies(digest.dependencies || []).length)
			|| /(remaining|todo|continue|pending|follow-?up|wait|review)/i.test(String(digest.next || ""))
			|| ((digest.needs || "") && !/^(none|n\/a|nothing)$/i.test(String(digest.needs || "").trim()))
		))
		.map((digest) => digest.alias));
}

function completeSignalText(entry: any) {
	if (entry?.coordinatorCompletionSignal) return "OVERALL STATUS: COMPLETE\nREMAINING WORK: none";
	if (entry?.coordinatorStatus) return `OVERALL STATUS: ${String(entry.coordinatorStatus).toUpperCase()}`;
	return entry?.coordinatorSummary || null;
}

function buildAgentDigestFromObservation(agentRecord: any, observation: any): CaptureDigestLike {
	return {
		alias: agentRecord.alias,
		team: agentRecord.team || null,
		role: agentRecord.role || null,
		status: observation?.status || null,
		summary: observation?.summary || agentRecord.lastObservationSummary || agentRecord.lastSummary || null,
		blocked: Boolean(observation?.blocked),
		blockers: Array.isArray(observation?.blockers) ? observation.blockers : [],
		artifacts: Array.isArray(observation?.artifacts) ? observation.artifacts : [],
		commands: Array.isArray(observation?.commands) ? observation.commands : [],
		urls: Array.isArray(observation?.urls) ? observation.urls : [],
		completion: Boolean(observation?.completion),
		deliverable: observation?.deliverable || null,
		next: observation?.next || null,
		needs: observation?.needs || null,
		dependencies: Array.isArray(observation?.dependencies) ? observation.dependencies : [],
	};
}

function expectedAliases(teamRecords: any[] = []) {
	return uniqueStrings((teamRecords || []).flatMap((teamRecord: any) => (teamRecord.members || []).map((member: any) => member.alias)));
}

function currentRoundObservations(agentRecords: any[] = [], round: number) {
	return (agentRecords || []).map((agentRecord: any) => ({
		agentRecord,
		observation: (Array.isArray(agentRecord.observationLog) ? agentRecord.observationLog : []).find((item: any) => Number(item?.round || 0) === round) || null,
	})).filter((item: any) => item.observation);
}

function liveRunDispatchLatency(runEvents: any[] = []) {
	const started = runEvents.find((event: any) => event?.type === "orchestration_started")?.timestamp || null;
	const firstDispatch = runEvents.find((event: any) => event?.type === "task_dispatched")?.timestamp || null;
	return durationMs(started, firstDispatch);
}

function roundProgressByRound(progressLog: any[] = []) {
	const map = new Map<number, any>();
	for (const item of progressLog || []) {
		if (!Number(item?.round || 0)) continue;
		map.set(Number(item.round), item);
	}
	return map;
}

function deriveHeartbeatUsefulness(entry: any, currentDecision: any, previousDecision: any) {
	if (entry?.coordinatorCompletionSignal && currentDecision.status !== "done") return true;
	if (entry?.coordinatorNextAction || entry?.coordinatorRequests) return true;
	if (entry?.coordinatorSummary && currentDecision.status !== previousDecision?.status) return true;
	if (entry?.coordinatorSummary && (currentDecision.blockedCount !== previousDecision?.blockedCount || currentDecision.stalledCount !== previousDecision?.stalledCount)) return true;
	return Boolean(entry?.coordinatorSummary);
}

export interface RunScorecardRoundReport {
	round: number;
	decision: ReturnType<typeof deriveRunStatus>;
	blockedAliases: string[];
	stalledAliases: string[];
	missingOutputAliases: string[];
	staleBridgeAliases: string[];
	partialTeamDeathTeams: string[];
	misleadingDoneAliases: string[];
	deadlockedDependencies: string[];
	rebalanceTeams: string[];
	falseCompletePrevented: boolean;
	dispatchLatencyMs: number | null;
	relayMessages: number;
	heartbeatUseful: boolean;
}

export interface RunScorecardReport {
	kind: "run";
	runId: string;
	title: string;
	runStatus: string;
	finalDecision: ReturnType<typeof deriveRunStatus>;
	statusAlignment: boolean;
	rounds: RunScorecardRoundReport[];
	scorecard: {
		dispatchLatencyMs: number | null;
		relayNoiseRatio: number | null;
		heartbeatUsefulness: number | null;
		unblockSuccessRate: number | null;
		completionAccuracy: number;
		falseCompleteRate: number | null;
		overallScore: number;
	};
	failures: {
		missingAgentOutput: string[];
		staleBridgeSessions: string[];
		partialTeamDeath: string[];
		misleadingDoneReports: string[];
		dependencyDeadlocks: string[];
	};
}

export function buildRunScorecardReport(input: {
	runRecord: any;
	teamRecords?: any[];
	agentRecords?: any[];
	runEvents?: any[];
}) : RunScorecardReport {
	const runRecord = input.runRecord || {};
	const teamRecords = input.teamRecords || [];
	const agentRecords = input.agentRecords || [];
	const runEvents = input.runEvents || [];
	const progressLog = Array.isArray(runRecord.progressLog) ? runRecord.progressLog : [];
	const progressByRound = roundProgressByRound(progressLog);
	const maxRound = Math.max(
		0,
		...(progressLog.map((item: any) => Number(item?.round || 0))),
		...(agentRecords.flatMap((agent: any) => (Array.isArray(agent.observationLog) ? agent.observationLog : []).map((item: any) => Number(item?.round || 0)))),
	);
	const expected = expectedAliases(teamRecords);
	const previousDependencySnapshots = new Map<string, number>();
	const seenBlocked = new Set<string>();
	const resolvedBlocked = new Set<string>();
	const roundReports: RunScorecardRoundReport[] = [];
	let previousDecision: any = null;
	const initialDispatchLatency = liveRunDispatchLatency(runEvents);

	for (let round = 1; round <= maxRound; round++) {
		const items = currentRoundObservations(agentRecords, round);
		const digests = items.map((item: any) => buildAgentDigestFromObservation(item.agentRecord, item.observation));
		const presentAliases = new Set(digests.map((digest) => digest.alias));
		const progressEntry = progressByRound.get(round) || {};
		const decision = deriveRunStatus(digests, {
			coordinatorText: completeSignalText(progressEntry),
			synthesisText: round === maxRound ? runRecord.synthesisSummary || null : null,
		});
		const missingOutputAliases = uniqueStrings([
			...expected.filter((alias) => !presentAliases.has(alias)),
			...items.filter((item: any) => /capture failed|no output captured/i.test(String(item.observation?.summary || ""))).map((item: any) => item.agentRecord.alias),
		]);
		const staleBridgeAliases = uniqueStrings(items.filter((item: any) => item.observation?.bridgeStale).map((item: any) => item.agentRecord.alias));
		const partialTeamDeathTeams = uniqueStrings(missingOutputAliases.map((alias) => {
			const agent = agentRecords.find((item: any) => item.alias === alias);
			return agent?.team || "unknown-team";
		}));
		const blockedAliases = uniqueStrings(digests.filter((digest: any) => digest.status === "blocked" || digest.blocked).map((digest) => digest.alias));
		const stalledAliases = uniqueStrings(digests.filter((digest: any) => digest.status === "stalled").map((digest) => digest.alias));
		const dependencySnapshot = dependencyKeys(digests);
		const deadlockedDependencies = dependencySnapshot.filter((key) => (previousDependencySnapshots.get(key) || 0) >= 1);
		for (const key of dependencySnapshot) previousDependencySnapshots.set(key, (previousDependencySnapshots.get(key) || 0) + 1);
		for (const digest of digests) {
			if (digest.status === "blocked" || digest.blocked || digest.status === "stalled") seenBlocked.add(digest.alias);
			if ((digest.status === "working" || digest.status === "done" || digest.completion) && !digest.blocked && !(digest.blockers || []).length) resolvedBlocked.add(digest.alias);
		}
		const misleading = misleadingDoneAliases(digests);
		const teams = uniqueStrings(digests.map((digest) => digest.team).filter(Boolean));
		const rebalanceTeams = uniqueStrings([
			...teams.filter((team) => Number(progressEntry?.rebalances || progressEntry?.rebalanceMessages || 0) > 0),
			...teams.filter((team) => {
				const teamDigests = digests.filter((digest) => digest.team === team);
				return teamDigests.some((digest: any) => digest.status === "blocked" || digest.status === "stalled" || openDependencies(digest.dependencies || []).length > 0);
			}),
		]);
		const falseCompletePrevented = Boolean(progressEntry?.coordinatorCompletionSignal && decision.status !== "done");
		roundReports.push({
			round,
			decision,
			blockedAliases,
			stalledAliases,
			missingOutputAliases,
			staleBridgeAliases,
			partialTeamDeathTeams,
			misleadingDoneAliases: misleading,
			deadlockedDependencies,
			rebalanceTeams,
			falseCompletePrevented,
			dispatchLatencyMs: round === 1 ? initialDispatchLatency : null,
			relayMessages: Number(progressEntry?.relayMessages || 0),
			heartbeatUseful: deriveHeartbeatUsefulness(progressEntry, decision, previousDecision),
		});
		previousDecision = decision;
	}

	const finalDecision = roundReports[roundReports.length - 1]?.decision || deriveRunStatus([], { synthesisText: runRecord.synthesisSummary || null });
	const observedBlocked = [...seenBlocked];
	const resolvedCount = observedBlocked.filter((alias) => resolvedBlocked.has(alias)).length;
	const dispatchLatencyMs = round(average(roundReports.map((item) => item.dispatchLatencyMs).filter((value): value is number => typeof value === "number")), 1);
	const relayMessages = roundReports.reduce((sum, item) => sum + item.relayMessages, 0);
	const signalWork = roundReports.reduce((sum, item) => sum + item.blockedAliases.length + item.stalledAliases.length + item.rebalanceTeams.length + item.decision.completionCount, 0);
	const relayNoiseRatio = relayMessages ? round(relayMessages / Math.max(signalWork, 1), 3) : 0;
	const heartbeatUsefulness = roundReports.length ? round(roundReports.filter((item) => item.heartbeatUseful).length / roundReports.length, 3) : null;
	const unblockSuccessRate = observedBlocked.length ? round(resolvedCount / observedBlocked.length, 3) : null;
	const falseCompleteSignals = progressLog.filter((item: any) => Boolean(item?.coordinatorCompletionSignal)).length;
	const falseCompleteRate = falseCompleteSignals
		? round(roundReports.filter((item) => !item.falseCompletePrevented && Boolean(progressByRound.get(item.round)?.coordinatorCompletionSignal) && item.decision.status === "done").length / falseCompleteSignals, 3)
		: 0;
	const statusAlignment = String(runRecord.status || "unknown") === String(finalDecision.status || "unknown")
		|| (String(runRecord.status || "") === "done" && Boolean(finalDecision.completed));
	const completionAccuracy = statusAlignment ? 1 : 0;
	const overallScore = Math.max(0, Math.min(100,
		Math.round(
			(completionAccuracy * 35)
			+ ((1 - Math.min(falseCompleteRate || 0, 1)) * 20)
			+ (((heartbeatUsefulness ?? 1)) * 10)
			+ (((unblockSuccessRate ?? 1)) * 15)
			+ ((relayNoiseRatio === null ? 1 : Math.max(0, 1 - Math.min(relayNoiseRatio, 1))) * 10)
			+ ((dispatchLatencyMs === null ? 1 : Math.max(0, 1 - Math.min(dispatchLatencyMs / 5000, 1))) * 10),
		),
	));
	return {
		kind: "run",
		runId: runRecord.runId,
		title: runRecord.title || runRecord.task || runRecord.goal || runRecord.runId || "run",
		runStatus: runRecord.status || "unknown",
		finalDecision,
		statusAlignment,
		rounds: roundReports,
		scorecard: {
			dispatchLatencyMs,
			relayNoiseRatio,
			heartbeatUsefulness,
			unblockSuccessRate,
			completionAccuracy,
			falseCompleteRate,
			overallScore,
		},
		failures: {
			missingAgentOutput: uniqueStrings(roundReports.flatMap((item) => item.missingOutputAliases)),
			staleBridgeSessions: uniqueStrings(roundReports.flatMap((item) => item.staleBridgeAliases)),
			partialTeamDeath: uniqueStrings(roundReports.flatMap((item) => item.partialTeamDeathTeams)),
			misleadingDoneReports: uniqueStrings(roundReports.flatMap((item) => item.misleadingDoneAliases)),
			dependencyDeadlocks: uniqueStrings(roundReports.flatMap((item) => item.deadlockedDependencies)),
		},
	};
}

export function renderRunScorecardReport(report: RunScorecardReport) {
	return [
		`# cmux orchestrator scorecard ${report.runId}`,
		"",
		`- title: ${report.title}`,
		`- run status: ${report.runStatus}`,
		`- evidence-derived status: ${report.finalDecision.status}`,
		`- status alignment: ${report.statusAlignment ? "yes" : "no"}`,
		`- overall score: ${report.scorecard.overallScore}`,
		"",
		"## Scorecard",
		`- dispatch latency ms: ${report.scorecard.dispatchLatencyMs ?? "—"}`,
		`- relay noise ratio: ${report.scorecard.relayNoiseRatio ?? "—"}`,
		`- heartbeat usefulness: ${report.scorecard.heartbeatUsefulness ?? "—"}`,
		`- unblock success rate: ${report.scorecard.unblockSuccessRate ?? "—"}`,
		`- completion accuracy: ${report.scorecard.completionAccuracy}`,
		`- false-complete rate: ${report.scorecard.falseCompleteRate ?? "—"}`,
		"",
		"## Failures",
		`- missing agent output: ${report.failures.missingAgentOutput.join(", ") || "—"}`,
		`- stale bridge sessions: ${report.failures.staleBridgeSessions.join(", ") || "—"}`,
		`- partial team death: ${report.failures.partialTeamDeath.join(", ") || "—"}`,
		`- misleading done reports: ${report.failures.misleadingDoneReports.join(", ") || "—"}`,
		`- dependency deadlocks: ${report.failures.dependencyDeadlocks.join(", ") || "—"}`,
		"",
		"## Rounds",
		...report.rounds.flatMap((round) => [
			`### Round ${round.round}`,
			`- status: ${round.decision.status}`,
			`- blockers: ${round.blockedAliases.join(", ") || "—"}`,
			`- stalled: ${round.stalledAliases.join(", ") || "—"}`,
			`- missing output: ${round.missingOutputAliases.join(", ") || "—"}`,
			`- stale bridge: ${round.staleBridgeAliases.join(", ") || "—"}`,
			`- misleading done: ${round.misleadingDoneAliases.join(", ") || "—"}`,
			`- deadlocked dependencies: ${round.deadlockedDependencies.join(", ") || "—"}`,
			`- false-complete prevented: ${round.falseCompletePrevented ? "yes" : "no"}`,
			"",
		]),
	].join("\n");
}

export function renderRunFailureReport(report: RunScorecardReport) {
	return [
		`# cmux orchestrator failure report ${report.runId}`,
		"",
		`- run status: ${report.runStatus}`,
		`- evidence-derived status: ${report.finalDecision.status}`,
		`- overall score: ${report.scorecard.overallScore}`,
		"",
		"## Failure classes",
		`- missing agent output: ${report.failures.missingAgentOutput.join(", ") || "—"}`,
		`- stale bridge sessions: ${report.failures.staleBridgeSessions.join(", ") || "—"}`,
		`- partial team death: ${report.failures.partialTeamDeath.join(", ") || "—"}`,
		`- misleading done reports: ${report.failures.misleadingDoneReports.join(", ") || "—"}`,
		`- dependency deadlocks: ${report.failures.dependencyDeadlocks.join(", ") || "—"}`,
		"",
		"## Findings",
		...(report.failures.missingAgentOutput.length ? report.failures.missingAgentOutput.map((alias) => `- missing-output agent: ${alias}`) : ["- No missing-output agents detected."]),
		...(report.failures.staleBridgeSessions.length ? report.failures.staleBridgeSessions.map((alias) => `- stale-bridge agent: ${alias}`) : []),
		...(report.failures.partialTeamDeath.length ? report.failures.partialTeamDeath.map((team) => `- partial-team-death suspicion: ${team}`) : []),
		...(report.failures.misleadingDoneReports.length ? report.failures.misleadingDoneReports.map((alias) => `- false-complete suspicion: ${alias}`) : []),
		...(report.failures.dependencyDeadlocks.length ? report.failures.dependencyDeadlocks.map((edge) => `- dependency-deadlock: ${edge}`) : []),
	].join("\n");
}
