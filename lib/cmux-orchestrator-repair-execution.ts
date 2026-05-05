function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function priorityRank(priority?: string | null) {
	if (priority === "p0") return 4;
	if (priority === "p1") return 3;
	if (priority === "p2") return 2;
	return 1;
}

export const SAFE_REPAIR_EXECUTION_ALLOWLIST = new Set([
	"request_heartbeat",
	"request_team_heartbeat",
	"retry_capture",
	"reingest_bridge",
	"verification_round",
	"suppress_completion",
]);

export interface RepairExecutionPlanEntry {
	id: string;
	action: string;
	priority: string;
	scope: "run" | "team" | "agent";
	safeAutoExecute: boolean;
	reason?: string;
	runId?: string | null;
	team?: string | null;
	alias?: string | null;
}

export interface RepairExecutionResult {
	id: string;
	action: string;
	scope: "run" | "team" | "agent";
	status: "executed" | "failed" | "skipped";
	safeAutoExecute: boolean;
	runId?: string | null;
	team?: string | null;
	alias?: string | null;
	note?: string | null;
	output?: any;
}

function isActionAllowed(action: any) {
	return SAFE_REPAIR_EXECUTION_ALLOWLIST.has(String(action || "").trim());
}

export function buildRepairExecutionPlan(actions: RepairExecutionPlanEntry[] = [], options: { limit?: number } = {}) {
	const limit = Math.max(1, Math.min(32, Number(options.limit || 8)));
	const sorted = [...(actions || [])].sort((left: any, right: any) => {
		const priorityDelta = priorityRank(right?.priority) - priorityRank(left?.priority);
		if (priorityDelta) return priorityDelta;
		return String(left?.id || "").localeCompare(String(right?.id || ""));
	});
	const eligible = sorted.filter((item: any) => item?.safeAutoExecute && isActionAllowed(item?.action));
	const blocked = sorted.filter((item: any) => !eligible.includes(item));
	const selected = eligible.slice(0, limit);
	return {
		selected,
		deferred: eligible.slice(limit),
		blocked,
		summary: {
			total: sorted.length,
			eligible: eligible.length,
			selected: selected.length,
			deferred: Math.max(0, eligible.length - selected.length),
			blocked: blocked.length,
			selectedActions: uniqueStrings(selected.map((item: any) => item.action)),
		},
	};
}

export async function executeRepairExecutionPlan(
	entries: RepairExecutionPlanEntry[] = [],
	handlers: Record<string, (entry: RepairExecutionPlanEntry) => any | Promise<any>> = {},
) {
	const results: RepairExecutionResult[] = [];
	for (const entry of entries || []) {
		const handler = handlers[String(entry?.action || "")];
		if (!entry?.safeAutoExecute || !isActionAllowed(entry?.action)) {
			results.push({
				id: entry.id,
				action: entry.action,
				scope: entry.scope,
				status: "skipped",
				safeAutoExecute: Boolean(entry.safeAutoExecute),
				runId: entry.runId || null,
				team: entry.team || null,
				alias: entry.alias || null,
				note: "action not eligible for safe auto-execution",
			});
			continue;
		}
		if (!handler) {
			results.push({
				id: entry.id,
				action: entry.action,
				scope: entry.scope,
				status: "skipped",
				safeAutoExecute: true,
				runId: entry.runId || null,
				team: entry.team || null,
				alias: entry.alias || null,
				note: "no execution handler registered",
			});
			continue;
		}
		try {
			const output = await handler(entry);
			results.push({
				id: entry.id,
				action: entry.action,
				scope: entry.scope,
				status: "executed",
				safeAutoExecute: true,
				runId: entry.runId || null,
				team: entry.team || null,
				alias: entry.alias || null,
				note: output?.note || null,
				output,
			});
		} catch (error: any) {
			results.push({
				id: entry.id,
				action: entry.action,
				scope: entry.scope,
				status: "failed",
				safeAutoExecute: true,
				runId: entry.runId || null,
				team: entry.team || null,
				alias: entry.alias || null,
				note: error?.message || String(error),
			});
		}
	}
	return {
		results,
		summary: {
			total: results.length,
			executed: results.filter((item) => item.status === "executed").length,
			failed: results.filter((item) => item.status === "failed").length,
			skipped: results.filter((item) => item.status === "skipped").length,
			executedActions: uniqueStrings(results.filter((item) => item.status === "executed").map((item) => item.action)),
		},
	};
}
