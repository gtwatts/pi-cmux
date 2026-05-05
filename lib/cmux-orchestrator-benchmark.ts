import { deriveRunStatus, digestCollectionHasRemainingWork, shouldAutoRebalance, type CaptureDigestLike } from "./cmux-orchestrator-decisions.ts";

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

function summarizeText(text?: string | null, max = 140) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function teamAliasMap(rounds: BenchmarkRoundInput[] = []) {
	const map = new Map<string, string>();
	for (const round of rounds || []) {
		for (const digest of round.digests || []) {
			if (digest.alias && digest.team && !map.has(digest.alias)) map.set(digest.alias, String(digest.team));
		}
	}
	return map;
}

function allAliases(rounds: BenchmarkRoundInput[] = []) {
	return uniqueStrings((rounds || []).flatMap((round) => (round.digests || []).map((digest) => digest.alias)));
}

function openDependencyKeys(digests: CaptureDigestLike[] = []) {
	return uniqueStrings(digests.flatMap((digest: any) => ((digest.dependencies || []) as any[])
		.filter((dependency: any) => String(dependency?.status || "open") !== "resolved")
		.map((dependency: any) => `${digest.alias}->${dependency.targetHint || dependency.target || dependency.text || dependency.kind || "dependency"}`)));
}

function misleadingDoneAliases(digests: CaptureDigestLike[] = []) {
	return uniqueStrings((digests || [])
		.filter((digest: any) => (digest.status === "done" || digest.completion) && (
			digestCollectionHasRemainingWork([digest])
			|| Boolean(digest.blocked)
			|| Boolean((digest.blockers || []).length)
			|| Boolean(((digest.dependencies || []) as any[]).some((dependency: any) => String(dependency?.status || "open") !== "resolved"))
		))
		.map((digest) => digest.alias));
}

function completeSignalPresent(text?: string | null) {
	return /(overall status\s*:\s*(complete|completed|done)|team status\s*:\s*complete|status\s*:\s*(complete|completed|done)|remaining work\s*:\s*none)/i.test(String(text || ""));
}

export interface BenchmarkRoundInput {
	round: number;
	digests: CaptureDigestLike[];
	coordinatorText?: string | null;
	synthesisText?: string | null;
	dispatchLatencyMs?: number | null;
	relayMessages?: number;
	heartbeatUseful?: boolean;
	bridge?: {
		staleAliases?: string[];
		deadAliases?: string[];
	};
}

export interface BenchmarkScenario {
	name: string;
	description: string;
	tags?: string[];
	rounds: BenchmarkRoundInput[];
	expectedFinalStatus: string;
	expectedCompleted?: boolean;
}

export interface BenchmarkRoundReport {
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

export interface BenchmarkScorecard {
	dispatchLatencyMs: number | null;
	relayNoiseRatio: number | null;
	heartbeatUsefulness: number | null;
	unblockSuccessRate: number | null;
	completionAccuracy: number;
	falseCompleteRate: number | null;
	overallScore: number;
}

export interface BenchmarkRunReport {
	scenario: BenchmarkScenario;
	rounds: BenchmarkRoundReport[];
	finalDecision: ReturnType<typeof deriveRunStatus>;
	failures: {
		missingAgentOutput: string[];
		staleBridgeSessions: string[];
		partialTeamDeath: string[];
		misleadingDoneReports: string[];
		dependencyDeadlocks: string[];
	};
	scorecard: BenchmarkScorecard;
	passed: boolean;
}

export function runBenchmarkScenario(scenario: BenchmarkScenario): BenchmarkRunReport {
	const aliasTeamMap = teamAliasMap(scenario.rounds);
	const knownAliases = allAliases(scenario.rounds);
	const previousDependencySnapshots = new Map<string, number>();
	const seenBlocked = new Set<string>();
	const resolvedBlocked = new Set<string>();
	const roundReports: BenchmarkRoundReport[] = [];
	let previousRoundAliases = knownAliases;

	for (const round of scenario.rounds) {
		const decision = deriveRunStatus(round.digests || [], {
			coordinatorText: round.coordinatorText || null,
			synthesisText: round.synthesisText || null,
		});
		const presentAliases = new Set((round.digests || []).map((digest) => digest.alias));
		const missingOutputAliases = uniqueStrings(previousRoundAliases.filter((alias) => !presentAliases.has(alias)));
		const staleBridgeAliases = uniqueStrings(round.bridge?.staleAliases || []);
		const deadAliases = uniqueStrings(round.bridge?.deadAliases || []);
		const partialTeamDeathTeams = uniqueStrings(deadAliases.map((alias) => aliasTeamMap.get(alias) || "unknown-team"));
		const blockedAliases = uniqueStrings((round.digests || []).filter((digest: any) => digest.status === "blocked" || digest.blocked).map((digest) => digest.alias));
		const stalledAliases = uniqueStrings((round.digests || []).filter((digest: any) => digest.status === "stalled").map((digest) => digest.alias));
		const openDependencies = openDependencyKeys(round.digests || []);
		const deadlockedDependencies = openDependencies.filter((key) => (previousDependencySnapshots.get(key) || 0) >= 1);
		for (const key of openDependencies) previousDependencySnapshots.set(key, (previousDependencySnapshots.get(key) || 0) + 1);
		for (const digest of round.digests || []) {
			if (digest.status === "blocked" || digest.blocked || digest.status === "stalled") seenBlocked.add(digest.alias);
			if ((digest.status === "working" || digest.status === "done" || digest.completion) && !digest.blocked && !(digest.blockers || []).length) resolvedBlocked.add(digest.alias);
		}
		const misleading = misleadingDoneAliases(round.digests || []);
		const teams = uniqueStrings((round.digests || []).map((digest) => digest.team).filter(Boolean));
		const rebalanceTeams = teams.filter((team) => shouldAutoRebalance({ team }, (round.digests || []).filter((digest) => digest.team === team), round.round).should);
		const falseCompletePrevented = Boolean((completeSignalPresent(round.coordinatorText) || completeSignalPresent(round.synthesisText)) && decision.status !== "done");
		roundReports.push({
			round: round.round,
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
			dispatchLatencyMs: typeof round.dispatchLatencyMs === "number" ? round.dispatchLatencyMs : null,
			relayMessages: Number(round.relayMessages || 0),
			heartbeatUseful: Boolean(round.heartbeatUseful || falseCompletePrevented || summarizeText(round.coordinatorText).length > 0),
		});
		previousRoundAliases = uniqueStrings([...previousRoundAliases, ...Array.from(presentAliases)]);
	}

	const finalDecision = roundReports[roundReports.length - 1]?.decision || deriveRunStatus([]);
	const falseCompleteSignals = roundReports.filter((round) => completeSignalPresent(scenario.rounds.find((item) => item.round === round.round)?.coordinatorText) || completeSignalPresent(scenario.rounds.find((item) => item.round === round.round)?.synthesisText)).length;
	const falseCompletesAccepted = roundReports.filter((round) => !round.falseCompletePrevented && (completeSignalPresent(scenario.rounds.find((item) => item.round === round.round)?.coordinatorText) || completeSignalPresent(scenario.rounds.find((item) => item.round === round.round)?.synthesisText)) && round.decision.status === "done" && scenario.expectedFinalStatus !== "done").length;
	const signalWork = roundReports.reduce((sum, round) => sum + round.blockedAliases.length + round.stalledAliases.length + round.rebalanceTeams.length + round.decision.completionCount, 0);
	const relayMessages = roundReports.reduce((sum, round) => sum + round.relayMessages, 0);
	const heartbeatUsefulCount = roundReports.filter((round) => round.heartbeatUseful).length;
	const observedBlocked = [...seenBlocked];
	const resolvedCount = observedBlocked.filter((alias) => resolvedBlocked.has(alias)).length;
	const dispatchLatencyMs = round(average(roundReports.map((round) => round.dispatchLatencyMs).filter((value): value is number => typeof value === "number")), 1);
	const relayNoiseRatio = relayMessages ? round(relayMessages / Math.max(signalWork, 1), 3) : 0;
	const heartbeatUsefulness = roundReports.length ? round(heartbeatUsefulCount / roundReports.length, 3) : null;
	const unblockSuccessRate = observedBlocked.length ? round(resolvedCount / observedBlocked.length, 3) : null;
	const completionAccuracy = finalDecision.status === scenario.expectedFinalStatus && Boolean(finalDecision.completed) === Boolean(scenario.expectedCompleted ?? (scenario.expectedFinalStatus === "done")) ? 1 : 0;
	const falseCompleteRate = falseCompleteSignals ? round(falseCompletesAccepted / falseCompleteSignals, 3) : 0;
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
	const failures = {
		missingAgentOutput: uniqueStrings(roundReports.flatMap((round) => round.missingOutputAliases)),
		staleBridgeSessions: uniqueStrings(roundReports.flatMap((round) => round.staleBridgeAliases)),
		partialTeamDeath: uniqueStrings(roundReports.flatMap((round) => round.partialTeamDeathTeams)),
		misleadingDoneReports: uniqueStrings(roundReports.flatMap((round) => round.misleadingDoneAliases)),
		dependencyDeadlocks: uniqueStrings(roundReports.flatMap((round) => round.deadlockedDependencies)),
	};
	return {
		scenario,
		rounds: roundReports,
		finalDecision,
		failures,
		scorecard: {
			dispatchLatencyMs,
			relayNoiseRatio,
			heartbeatUsefulness,
			unblockSuccessRate,
			completionAccuracy,
			falseCompleteRate,
			overallScore,
		},
		passed: completionAccuracy === 1 && (falseCompleteRate || 0) === 0,
	};
}

export function builtInBenchmarkScenarios(): BenchmarkScenario[] {
	return [
		{
			name: "solo-3-agent",
			description: "One team with three agents reaches completion cleanly.",
			tags: ["benchmark", "1-team", "3-agent"],
			expectedFinalStatus: "done",
			rounds: [
				{ round: 1, dispatchLatencyMs: 420, relayMessages: 3, heartbeatUseful: true, digests: [
					{ alias: "solo-lead", team: "solo", role: "lead", status: "working", summary: "Delegated review plan.", hash: "s1" },
					{ alias: "solo-coder", team: "solo", role: "coder", status: "working", summary: "Implementing fix in src/app.ts.", artifacts: ["src/app.ts"], hash: "s2" },
					{ alias: "solo-reviewer", team: "solo", role: "reviewer", status: "working", summary: "Reviewing changed files.", hash: "s3" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: implementation and review" },
				{ round: 2, dispatchLatencyMs: 380, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "solo-lead", team: "solo", role: "lead", status: "done", completion: true, summary: "Team ready for coordinator.", deliverable: "handoff note", hash: "s4" },
					{ alias: "solo-coder", team: "solo", role: "coder", status: "done", completion: true, summary: "Fix complete.", artifacts: ["src/app.ts"], commands: ["bun test"], hash: "s5" },
					{ alias: "solo-reviewer", team: "solo", role: "reviewer", status: "done", completion: true, summary: "Review complete.", hash: "s6" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "dual-team-6-agent",
			description: "Two teams with six agents coordinate across teams and finish cleanly.",
			tags: ["benchmark", "2-team", "6-agent"],
			expectedFinalStatus: "done",
			rounds: [
				{ round: 1, dispatchLatencyMs: 540, relayMessages: 6, heartbeatUseful: true, digests: [
					{ alias: "alpha-lead", team: "alpha", role: "lead", status: "working", summary: "Alpha delegating work.", hash: "a1" },
					{ alias: "alpha-coder", team: "alpha", role: "coder", status: "working", summary: "Editing src/a.ts.", artifacts: ["src/a.ts"], hash: "a2" },
					{ alias: "alpha-reviewer", team: "alpha", role: "reviewer", status: "working", summary: "Reviewing alpha output.", hash: "a3" },
					{ alias: "beta-lead", team: "beta", role: "lead", status: "working", summary: "Beta tracking docs work.", hash: "b1" },
					{ alias: "beta-coder", team: "beta", role: "coder", status: "working", summary: "Editing docs/b.md.", artifacts: ["docs/b.md"], hash: "b2" },
					{ alias: "beta-reviewer", team: "beta", role: "reviewer", status: "working", summary: "Reviewing beta output.", hash: "b3" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nTEAM SUMMARIES: both teams active" },
				{ round: 2, dispatchLatencyMs: 460, relayMessages: 4, heartbeatUseful: true, digests: [
					{ alias: "alpha-lead", team: "alpha", role: "lead", status: "done", completion: true, summary: "Alpha complete.", hash: "a4" },
					{ alias: "alpha-coder", team: "alpha", role: "coder", status: "done", completion: true, summary: "Alpha code complete.", artifacts: ["src/a.ts"], commands: ["bun test"], hash: "a5" },
					{ alias: "alpha-reviewer", team: "alpha", role: "reviewer", status: "done", completion: true, summary: "Alpha review done.", hash: "a6" },
					{ alias: "beta-lead", team: "beta", role: "lead", status: "done", completion: true, summary: "Beta complete.", hash: "b4" },
					{ alias: "beta-coder", team: "beta", role: "coder", status: "done", completion: true, summary: "Beta docs complete.", artifacts: ["docs/b.md"], hash: "b5" },
					{ alias: "beta-reviewer", team: "beta", role: "reviewer", status: "done", completion: true, summary: "Beta review done.", hash: "b6" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "blocker-injection",
			description: "A blocked agent is escalated and later unblocked.",
			tags: ["failure-injection", "blocker"],
			expectedFinalStatus: "done",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "block-lead", team: "block", role: "lead", status: "working", summary: "Tracking blocker.", hash: "bl1" },
					{ alias: "block-coder", team: "block", role: "coder", status: "blocked", blocked: true, summary: "Waiting on test fixture.", blockers: ["test fixture missing"], hash: "bl2" },
					{ alias: "block-reviewer", team: "block", role: "reviewer", status: "working", summary: "Preparing review." , hash: "bl3"},
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nBLOCKERS: fixture missing" },
				{ round: 2, relayMessages: 1, heartbeatUseful: true, digests: [
					{ alias: "block-lead", team: "block", role: "lead", status: "done", completion: true, summary: "Blocker resolved and team complete.", hash: "bl4" },
					{ alias: "block-coder", team: "block", role: "coder", status: "done", completion: true, summary: "Fixture restored and tests passing.", commands: ["bun test"], hash: "bl5" },
					{ alias: "block-reviewer", team: "block", role: "reviewer", status: "done", completion: true, summary: "Review complete.", hash: "bl6" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "cross-team-dependency",
			description: "A team depends on another team and clears that dependency before completion.",
			tags: ["failure-injection", "cross-team-dependency"],
			expectedFinalStatus: "done",
			rounds: [
				{ round: 1, relayMessages: 4, heartbeatUseful: true, digests: [
					{ alias: "app-lead", team: "app", role: "lead", status: "working", summary: "Need auth answer from infra.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "infra-lead", text: "Need auth contract confirmation" }], hash: "ct1" },
					{ alias: "app-coder", team: "app", role: "coder", status: "working", summary: "Waiting on auth contract before final patch.", needs: "infra auth confirmation", hash: "ct2" },
					{ alias: "app-reviewer", team: "app", role: "reviewer", status: "working", summary: "Reviewing current diff.", hash: "ct3" },
					{ alias: "infra-lead", team: "infra", role: "lead", status: "working", summary: "Investigating auth contract.", hash: "ct4" },
					{ alias: "infra-coder", team: "infra", role: "coder", status: "working", summary: "Checking auth layer.", hash: "ct5" },
					{ alias: "infra-reviewer", team: "infra", role: "reviewer", status: "working", summary: "Reviewing contract docs.", hash: "ct6" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: dependency clearing" },
				{ round: 2, relayMessages: 3, heartbeatUseful: true, digests: [
					{ alias: "app-lead", team: "app", role: "lead", status: "done", completion: true, summary: "App team complete after infra confirmation.", hash: "ct7" },
					{ alias: "app-coder", team: "app", role: "coder", status: "done", completion: true, summary: "Patched with confirmed auth contract.", hash: "ct8" },
					{ alias: "app-reviewer", team: "app", role: "reviewer", status: "done", completion: true, summary: "App review complete.", hash: "ct9" },
					{ alias: "infra-lead", team: "infra", role: "lead", status: "done", completion: true, summary: "Infra confirmation delivered.", hash: "ct10" },
					{ alias: "infra-coder", team: "infra", role: "coder", status: "done", completion: true, summary: "Infra checks complete.", hash: "ct11" },
					{ alias: "infra-reviewer", team: "infra", role: "reviewer", status: "done", completion: true, summary: "Infra review complete.", hash: "ct12" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "stalled-agent-recovery",
			description: "A stalled agent is rebalanced and the team recovers.",
			tags: ["failure-injection", "stall"],
			expectedFinalStatus: "done",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "stall-lead", team: "stall", role: "lead", status: "working", summary: "Monitoring stalled coder.", hash: "st1" },
					{ alias: "stall-coder", team: "stall", role: "coder", status: "stalled", summary: "No progress from previous round.", hash: "st2" },
					{ alias: "stall-reviewer", team: "stall", role: "reviewer", status: "working", summary: "Can absorb adjacent scope.", hash: "st3" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: rebalance active" },
				{ round: 2, relayMessages: 1, heartbeatUseful: true, digests: [
					{ alias: "stall-lead", team: "stall", role: "lead", status: "done", completion: true, summary: "Rebalance succeeded.", hash: "st4" },
					{ alias: "stall-coder", team: "stall", role: "coder", status: "working", summary: "Recovered and finished remaining patch.", hash: "st5" },
					{ alias: "stall-reviewer", team: "stall", role: "reviewer", status: "done", completion: true, summary: "Review complete.", hash: "st6" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "missing-agent-output",
			description: "One agent disappears from captured output for a round.",
			tags: ["failure-injection", "missing-output"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "miss-lead", team: "miss", role: "lead", status: "working", summary: "All agents started.", hash: "m1" },
					{ alias: "miss-coder", team: "miss", role: "coder", status: "working", summary: "Implementing patch.", hash: "m2" },
					{ alias: "miss-reviewer", team: "miss", role: "reviewer", status: "working", summary: "Reviewing current diff.", hash: "m3" },
				] },
				{ round: 2, relayMessages: 1, heartbeatUseful: true, digests: [
					{ alias: "miss-lead", team: "miss", role: "lead", status: "working", summary: "Missing reviewer output this round.", hash: "m4" },
					{ alias: "miss-coder", team: "miss", role: "coder", status: "working", summary: "Patch still in progress.", hash: "m5" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: reviewer output missing" },
			],
		},
		{
			name: "stale-bridge-session",
			description: "Bridge-linked browser state becomes stale and should be surfaced.",
			tags: ["failure-injection", "stale-bridge"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "bridge-lead", team: "bridge", role: "lead", status: "working", summary: "Monitoring browser task.", hash: "br1" },
					{ alias: "bridge-browser", team: "bridge", role: "browser", status: "working", summary: "Using browser surface.", hash: "br2" },
					{ alias: "bridge-reviewer", team: "bridge", role: "reviewer", status: "working", summary: "Awaiting browser extract.", hash: "br3" },
				], bridge: { staleAliases: ["bridge-browser"] }, coordinatorText: "OVERALL STATUS: INCOMPLETE\nBLOCKERS: stale browser bridge" },
			],
		},
		{
			name: "partial-team-death",
			description: "Part of a team dies and should be treated as degraded/not complete.",
			tags: ["failure-injection", "partial-team-death"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "dead-lead", team: "dead", role: "lead", status: "working", summary: "Team started.", hash: "pd1" },
					{ alias: "dead-coder", team: "dead", role: "coder", status: "working", summary: "Editing file.", hash: "pd2" },
					{ alias: "dead-reviewer", team: "dead", role: "reviewer", status: "working", summary: "Review started.", hash: "pd3" },
				], bridge: { deadAliases: ["dead-reviewer"] }, coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: one agent offline" },
			],
		},
		{
			name: "misleading-done-reports",
			description: "Agents claim done but still report remaining work/dependencies.",
			tags: ["failure-injection", "false-complete"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "fake-lead", team: "fake", role: "lead", status: "done", completion: true, summary: "Claims team complete.", next: "continue final verification", hash: "fd1" },
					{ alias: "fake-coder", team: "fake", role: "coder", status: "done", completion: true, summary: "Claims patch done.", needs: "planner review", hash: "fd2" },
					{ alias: "fake-reviewer", team: "fake", role: "reviewer", status: "done", completion: true, summary: "Claims review done.", blockers: ["awaiting signoff"], hash: "fd3" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "dependency-deadlock",
			description: "Dependencies stay open across rounds and should be detected as deadlock pressure.",
			tags: ["failure-injection", "deadlock"],
			expectedFinalStatus: "blocked",
			rounds: [
				{ round: 1, relayMessages: 3, heartbeatUseful: true, digests: [
					{ alias: "dl-a", team: "deadlock", role: "lead", status: "blocked", blocked: true, summary: "Waiting on peer acknowledgement.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "dl-b", text: "Need approval from B" }], hash: "dd1" },
					{ alias: "dl-b", team: "deadlock", role: "coder", status: "blocked", blocked: true, summary: "Waiting on peer acknowledgement.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "dl-a", text: "Need approval from A" }], hash: "dd2" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nBLOCKERS: circular dependency" },
				{ round: 2, relayMessages: 3, heartbeatUseful: true, digests: [
					{ alias: "dl-a", team: "deadlock", role: "lead", status: "blocked", blocked: true, summary: "Still waiting on B.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "dl-b", text: "Need approval from B" }], hash: "dd3" },
					{ alias: "dl-b", team: "deadlock", role: "coder", status: "blocked", blocked: true, summary: "Still waiting on A.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "dl-a", text: "Need approval from A" }], hash: "dd4" },
				], coordinatorText: "OVERALL STATUS: BLOCKED\nREMAINING WORK: resolve dependency deadlock" },
			],
		},
		{
			name: "verification-never-arrives",
			description: "A run appears settled but reviewer verification never arrives, so completion should stay held.",
			tags: ["failure-injection", "verification"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "ver-lead", team: "verify", role: "lead", status: "done", completion: true, summary: "Implementation complete.", next: "wait for reviewer verification", hash: "v1" },
					{ alias: "ver-coder", team: "verify", role: "coder", status: "done", completion: true, summary: "Tests run.", commands: ["bun test"], needs: "reviewer confirmation", hash: "v2" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
			],
		},
		{
			name: "oscillating-done-claims",
			description: "Different rounds alternate between done and not-done claims, testing false-complete resistance.",
			tags: ["failure-injection", "false-complete", "oscillation"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "osc-lead", team: "osc", role: "lead", status: "done", completion: true, summary: "Claims complete.", next: "final browser verification", hash: "o1" },
					{ alias: "osc-reviewer", team: "osc", role: "reviewer", status: "done", completion: true, summary: "Needs another browser pass.", blockers: ["unverified browser state"], hash: "o2" },
				], coordinatorText: "OVERALL STATUS: COMPLETE\nREMAINING WORK: none" },
				{ round: 2, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "osc-lead", team: "osc", role: "lead", status: "working", summary: "Not complete after all.", next: "fix regression", hash: "o3" },
					{ alias: "osc-reviewer", team: "osc", role: "reviewer", status: "working", summary: "Regression confirmed.", hash: "o4" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: fix regression" },
			],
		},
		{
			name: "partial-repair-success",
			description: "Some repair actions succeed while another blocker persists, so the run should remain active.",
			tags: ["failure-injection", "repair"],
			expectedFinalStatus: "active",
			rounds: [
				{ round: 1, relayMessages: 3, heartbeatUseful: true, digests: [
					{ alias: "rep-lead", team: "repair", role: "lead", status: "blocked", blocked: true, summary: "Waiting on missing reviewer and stale browser capture.", dependencies: [{ status: "open", blocked: true, requiresAck: true, targetHint: "rep-reviewer", text: "Need reviewer confirmation" }], hash: "r1" },
					{ alias: "rep-browser", team: "repair", role: "browser", status: "working", summary: "Fresh capture succeeded.", urls: ["https://example.com"], hash: "r2" },
				], bridge: { staleAliases: ["rep-browser"] }, coordinatorText: "OVERALL STATUS: INCOMPLETE\nBLOCKERS: reviewer confirmation missing" },
				{ round: 2, relayMessages: 2, heartbeatUseful: true, digests: [
					{ alias: "rep-lead", team: "repair", role: "lead", status: "working", summary: "Browser repaired, still missing reviewer confirmation.", next: "request verification", hash: "r3" },
					{ alias: "rep-browser", team: "repair", role: "browser", status: "done", completion: true, summary: "Browser extract refreshed.", urls: ["https://example.com"], hash: "r4" },
				], coordinatorText: "OVERALL STATUS: INCOMPLETE\nREMAINING WORK: reviewer confirmation" },
			],
		},
	];
}

export function getBenchmarkScenario(name: string) {
	return builtInBenchmarkScenarios().find((scenario) => scenario.name === name) || null;
}

export function runBenchmarkSuite(names?: string[]) {
	const selected = (names && names.length)
		? builtInBenchmarkScenarios().filter((scenario) => names.includes(scenario.name))
		: builtInBenchmarkScenarios();
	return selected.map(runBenchmarkScenario);
}

export function renderBenchmarkReport(report: BenchmarkRunReport) {
	return [
		`# cmux orchestrator benchmark ${report.scenario.name}`,
		"",
		`- description: ${report.scenario.description}`,
		`- expected final status: ${report.scenario.expectedFinalStatus}`,
		`- actual final status: ${report.finalDecision.status}`,
		`- passed: ${report.passed ? "yes" : "no"}`,
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
		"## Failure findings",
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
			`- rebalances: ${round.rebalanceTeams.join(", ") || "—"}`,
			`- missing output: ${round.missingOutputAliases.join(", ") || "—"}`,
			`- misleading done: ${round.misleadingDoneAliases.join(", ") || "—"}`,
			`- deadlocked dependencies: ${round.deadlockedDependencies.join(", ") || "—"}`,
			`- false-complete prevented: ${round.falseCompletePrevented ? "yes" : "no"}`,
			"",
		]),
	].join("\n");
}

export function renderBenchmarkSuiteSummary(reports: BenchmarkRunReport[]) {
	const avgScore = round(average(reports.map((report) => report.scorecard.overallScore)), 1);
	return [
		"# cmux orchestrator benchmark suite",
		"",
		`- scenarios: ${reports.length}`,
		`- passed: ${reports.filter((report) => report.passed).length}/${reports.length}`,
		`- average score: ${avgScore ?? "—"}`,
		"",
		"## Scenarios",
		...reports.map((report) => `- ${report.scenario.name}: status=${report.finalDecision.status} score=${report.scorecard.overallScore} passed=${report.passed ? "yes" : "no"}`),
	].join("\n");
}
