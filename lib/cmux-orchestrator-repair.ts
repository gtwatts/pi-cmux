function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function severityRank(severity?: string | null) {
	if (severity === "critical") return 4;
	if (severity === "high") return 3;
	if (severity === "medium") return 2;
	return 1;
}

function priorityFromFinding(finding: any, action: string) {
	if (action === "suppress_completion") return "p0";
	if (["recreate_team", "verification_round"].includes(action) || finding?.severity === "critical") return "p1";
	if (["heal_team", "heal_agent", "rebalance_team", "redirect_milestone"].includes(action) || finding?.severity === "high") return "p2";
	return "p3";
}

function priorityRank(priority?: string | null) {
	if (priority === "p0") return 4;
	if (priority === "p1") return 3;
	if (priority === "p2") return 2;
	return 1;
}

const SAFE_AUTO_EXECUTE_ACTIONS = new Set([
	"request_heartbeat",
	"request_team_heartbeat",
	"retry_capture",
	"reingest_bridge",
	"heal_agent",
	"heal_team",
	"rebalance_team",
	"verification_round",
	"suppress_completion",
]);

export interface RepairAction {
	id: string;
	action: string;
	scope: "run" | "team" | "agent";
	priority: "p0" | "p1" | "p2" | "p3";
	safeAutoExecute: boolean;
	reason: string;
	findingIds: string[];
	evidence: string[];
	runId?: string | null;
	team?: string | null;
	alias?: string | null;
}

function actionId(action: string, scope: string, runId?: string | null, team?: string | null, alias?: string | null) {
	return `${action}:${scope}:${alias || team || runId || "global"}`;
}

export function deriveRepairPlan(findings: any[] = []) {
	const planById = new Map<string, RepairAction>();
	for (const finding of findings || []) {
		const actions = uniqueStrings(finding?.recommendedActions || []);
		for (const action of actions) {
			const id = actionId(action, finding.scope || "run", finding.runId, finding.team, finding.alias);
			const existing = planById.get(id);
			const nextPriority = priorityFromFinding(finding, action) as RepairAction["priority"];
			const safeAutoExecute = Boolean(finding?.safeAutoRepair) && SAFE_AUTO_EXECUTE_ACTIONS.has(action);
			if (!existing) {
				planById.set(id, {
					id,
					action,
					scope: (finding.scope || "run") as RepairAction["scope"],
					priority: nextPriority,
					safeAutoExecute,
					reason: String(finding?.summary || `${action} requested`).trim(),
					findingIds: uniqueStrings([finding?.id]),
					evidence: uniqueStrings(finding?.evidence || []).slice(0, 6),
					runId: finding?.runId || null,
					team: finding?.team || null,
					alias: finding?.alias || null,
				});
				continue;
			}
			const strongerPriority = priorityRank(nextPriority) > priorityRank(existing.priority) ? nextPriority : existing.priority;
			const strongerReason = severityRank(finding?.severity) >= 3 ? String(finding?.summary || existing.reason).trim() : existing.reason;
			planById.set(id, {
				...existing,
				priority: strongerPriority,
				safeAutoExecute: existing.safeAutoExecute || safeAutoExecute,
				reason: strongerReason,
				findingIds: uniqueStrings([...(existing.findingIds || []), finding?.id]),
				evidence: uniqueStrings([...(existing.evidence || []), ...(finding?.evidence || [])]).slice(0, 8),
				runId: existing.runId || finding?.runId || null,
				team: existing.team || finding?.team || null,
				alias: existing.alias || finding?.alias || null,
			});
		}
	}

	const actions = [...planById.values()].sort((left, right) => {
		const priorityDelta = priorityRank(right.priority) - priorityRank(left.priority);
		if (priorityDelta) return priorityDelta;
		return left.id.localeCompare(right.id);
	});
	const summary = {
		total: actions.length,
		safeAutoExecutable: actions.filter((item) => item.safeAutoExecute).length,
		manualOnly: actions.filter((item) => !item.safeAutoExecute).length,
		byPriority: {
			p0: actions.filter((item) => item.priority === "p0").length,
			p1: actions.filter((item) => item.priority === "p1").length,
			p2: actions.filter((item) => item.priority === "p2").length,
			p3: actions.filter((item) => item.priority === "p3").length,
		},
		byAction: Object.fromEntries(uniqueStrings(actions.map((item) => item.action)).map((action) => [action, actions.filter((item) => item.action === action).length])),
	};
	return { actions, summary };
}
