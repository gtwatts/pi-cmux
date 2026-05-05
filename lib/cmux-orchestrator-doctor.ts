function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function summarize(text?: string | null, max = 180) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function findingId(kind: string, scope: string, target: string) {
	return `${kind}:${scope}:${String(target || "unknown")}`;
}

function unresolvedDependencies(items: any[] = []) {
	return (items || []).filter((dependency: any) => String(dependency?.status || "open") !== "resolved");
}

export interface DoctorFinding {
	id: string;
	kind: string;
	scope: "run" | "team" | "agent";
	severity: "low" | "medium" | "high" | "critical";
	confidence: number;
	summary: string;
	evidence: string[];
	recommendedActions: string[];
	safeAutoRepair: boolean;
	runId?: string | null;
	team?: string | null;
	alias?: string | null;
}

function makeFinding(input: Omit<DoctorFinding, "id"> & { target: string }) : DoctorFinding {
	return {
		id: findingId(input.kind, input.scope, input.target),
		kind: input.kind,
		scope: input.scope,
		severity: input.severity,
		confidence: input.confidence,
		summary: input.summary,
		evidence: uniqueStrings(input.evidence || []),
		recommendedActions: uniqueStrings(input.recommendedActions || []),
		safeAutoRepair: input.safeAutoRepair,
		runId: input.runId || null,
		team: input.team || null,
		alias: input.alias || null,
	};
}

export function deriveDoctorFindings(report: any) {
	const findings: DoctorFinding[] = [];
	const agentRegistry = report?.agentRegistry?.agents || {};
	const teamRegistry = report?.teamRegistry?.teams || {};
	const runRegistry = report?.runRegistry?.runs || {};

	for (const item of report?.agentsWithStaleBridge || []) {
		findings.push(makeFinding({
			target: item.alias,
			kind: "stale_bridge",
			scope: "agent",
			severity: "high",
			confidence: 0.95,
			summary: `${item.alias} has a stale bridge session.`,
			evidence: [`lastEvent=${item.lastEventType || "unknown"}`, `lastEventAt=${item.lastEventAt || "unknown"}`],
			recommendedActions: ["request_heartbeat", "reingest_bridge", "heal_agent"],
			safeAutoRepair: true,
			team: item.team || null,
			alias: item.alias,
			runId: agentRegistry[item.alias]?.runId || null,
		}));
	}

	for (const item of report?.offlineAgents || []) {
		findings.push(makeFinding({
			target: item.alias,
			kind: "offline_agent",
			scope: "agent",
			severity: agentRegistry[item.alias]?.runId ? "high" : "medium",
			confidence: 0.95,
			summary: `${item.alias} is offline or no longer attached to a live surface.`,
			evidence: [`surface=${item.surface || "missing"}`, `team=${item.team || "none"}`],
			recommendedActions: ["retry_capture", "request_heartbeat", "heal_agent"],
			safeAutoRepair: true,
			team: item.team || null,
			alias: item.alias,
			runId: item.runId || agentRegistry[item.alias]?.runId || null,
		}));
	}

	for (const item of report?.orphanAgents || []) {
		findings.push(makeFinding({
			target: item.alias,
			kind: "orphan_agent",
			scope: "agent",
			severity: "medium",
			confidence: 0.9,
			summary: `${item.alias} references missing team ${item.team || "unknown"}.`,
			evidence: [`team=${item.team || "unknown"}`],
			recommendedActions: ["heal_agent", "reassign_team_metadata"],
			safeAutoRepair: false,
			team: item.team || null,
			alias: item.alias,
			runId: item.runId || agentRegistry[item.alias]?.runId || null,
		}));
	}

	for (const item of report?.agentsWithoutBridge || []) {
		findings.push(makeFinding({
			target: item.alias,
			kind: "missing_bridge_link",
			scope: "agent",
			severity: "medium",
			confidence: 0.8,
			summary: `${item.alias} has no visible bridge linkage.`,
			evidence: [`team=${item.team || "none"}`],
			recommendedActions: ["reingest_bridge", "request_heartbeat"],
			safeAutoRepair: true,
			team: item.team || null,
			alias: item.alias,
			runId: agentRegistry[item.alias]?.runId || null,
		}));
	}

	for (const item of report?.offlineTeams || []) {
		const teamRecord = teamRegistry[item.team] || {};
		findings.push(makeFinding({
			target: item.team,
			kind: "offline_team",
			scope: "team",
			severity: "critical",
			confidence: 0.98,
			summary: `Team ${item.team} is fully offline.`,
			evidence: [`members=${item.members}`],
			recommendedActions: ["heal_team", "recreate_team"],
			safeAutoRepair: true,
			team: item.team,
			runId: teamRecord.runId || null,
		}));
	}

	for (const item of report?.degradedTeams || []) {
		const teamRecord = teamRegistry[item.team] || {};
		findings.push(makeFinding({
			target: item.team,
			kind: "degraded_team",
			scope: "team",
			severity: "high",
			confidence: 0.95,
			summary: `Team ${item.team} is degraded with only ${item.liveCount}/${item.members} live members.`,
			evidence: [`live=${item.liveCount}/${item.members}`],
			recommendedActions: ["heal_team", "rebalance_team", "request_team_heartbeat"],
			safeAutoRepair: true,
			team: item.team,
			runId: teamRecord.runId || null,
		}));
	}

	for (const item of report?.sessionMismatches || []) {
		const teamRecord = teamRegistry[item.team] || {};
		findings.push(makeFinding({
			target: item.team,
			kind: "session_mismatch",
			scope: "team",
			severity: "medium",
			confidence: 0.85,
			summary: `Team ${item.team} is attached to a mismatched CMUX session.`,
			evidence: [`recorded=${item.recorded || "unknown"}`, `current=${item.current || "unknown"}`],
			recommendedActions: ["reconcile_team_session", "heal_team"],
			safeAutoRepair: false,
			team: item.team,
			runId: teamRecord.runId || null,
		}));
	}

	for (const item of report?.runsWithMissingTeams || []) {
		const run = item.run || runRegistry[item.runId] || {};
		findings.push(makeFinding({
			target: item.runId,
			kind: "run_missing_team",
			scope: "run",
			severity: "high",
			confidence: 0.95,
			summary: `Run ${item.runId} references one or more missing teams.`,
			evidence: [`teams=${(run.teamNames || []).join(", ") || "none"}`],
			recommendedActions: ["repair_run_topology", "heal_team"],
			safeAutoRepair: false,
			runId: item.runId,
		}));
	}

	for (const [runId, run] of Object.entries(runRegistry)) {
		const runRecord = run as any;
		if (runRecord.status === "done" && runRecord.completionGateSatisfied === false) {
			findings.push(makeFinding({
				target: runId,
				kind: "false_complete_suspicion",
				scope: "run",
				severity: "critical",
				confidence: 0.97,
				summary: `Run ${runId} is marked done while the completion gate is holding.`,
				evidence: [runRecord.completionGateSummary || "completion gate hold", `status=${runRecord.status || "unknown"}`],
				recommendedActions: ["suppress_completion", "verification_round", "request_team_heartbeat"],
				safeAutoRepair: true,
				runId,
			}));
		}
		if (Number(runRecord.lastRoundNumber || 0) > 0 && ["active", "blocked", "stalled", "waiting_review"].includes(String(runRecord.status || ""))) {
			const runTeamNames = runRecord.teamNames || [];
			const expectedAliases = uniqueStrings(runTeamNames.flatMap((teamName: string) => ((teamRegistry[teamName] || {}) as any).members || []).map((member: any) => member.alias));
			const missingAliases = uniqueStrings(expectedAliases.filter((alias: string) => Number(agentRegistry[alias]?.lastObservedRound || 0) < Number(runRecord.lastRoundNumber || 0)));
			if (missingAliases.length) {
				findings.push(makeFinding({
					target: runId,
					kind: "missing_output",
					scope: "run",
					severity: "high",
					confidence: 0.9,
					summary: `Run ${runId} has agents missing current-round output.`,
					evidence: missingAliases.map((alias: string) => `${alias}: lastObservedRound=${agentRegistry[alias]?.lastObservedRound || 0}`),
					recommendedActions: ["retry_capture", "request_heartbeat", "heal_agent", "rebalance_team"],
					safeAutoRepair: true,
					runId,
				}));
			}
		}
	}

	const seenDeadlocks = new Set<string>();
	for (const [teamName, teamRecord] of Object.entries(teamRegistry)) {
		const unresolved = unresolvedDependencies((teamRecord as any).lastDependencies || []);
		for (const dependency of unresolved) {
			const source = String(dependency.fromAlias || dependency.fromTeam || teamName);
			const target = String(dependency.targetHint || dependency.target || "").trim();
			if (!target) continue;
			const reciprocal = unresolved.find((item: any) => String(item.fromAlias || item.fromTeam || "") === target && String(item.targetHint || item.target || "") === source);
			if (!reciprocal) continue;
			const cycleKey = [source, target].sort().join("<->");
			if (seenDeadlocks.has(cycleKey)) continue;
			seenDeadlocks.add(cycleKey);
			findings.push(makeFinding({
				target: cycleKey,
				kind: "dependency_deadlock",
				scope: "team",
				severity: "high",
				confidence: 0.88,
				summary: `Dependency deadlock detected between ${source} and ${target}.`,
				evidence: [summarize(dependency.text || `${source} waiting on ${target}`), summarize(reciprocal.text || `${target} waiting on ${source}`)],
				recommendedActions: ["redirect_milestone", "request_team_heartbeat", "rebalance_team"],
				safeAutoRepair: false,
				team: teamName,
				runId: (teamRecord as any).runId || null,
			}));
		}
	}

	const summary = {
		total: findings.length,
		critical: findings.filter((item) => item.severity === "critical").length,
		high: findings.filter((item) => item.severity === "high").length,
		medium: findings.filter((item) => item.severity === "medium").length,
		low: findings.filter((item) => item.severity === "low").length,
		byKind: Object.fromEntries(uniqueStrings(findings.map((item) => item.kind)).map((kind) => [kind, findings.filter((item) => item.kind === kind).length])),
	};
	return { findings, summary };
}
