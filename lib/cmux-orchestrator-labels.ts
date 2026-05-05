import { summarize } from "./cmux-orchestrator-analysis.ts";

export function humanizeIdentifier(value?: string | null) {
	const normalized = String(value || "")
		.trim()
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ");
	if (!normalized) return "";
	return normalized.replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function trailingIndex(value?: string | null) {
	const match = String(value || "").match(/-(\d+)$/);
	return match?.[1] || null;
}

export function buildTeamWorkspaceTitle(team: string) {
	return `Team · ${humanizeIdentifier(team) || "Unnamed Team"}`;
}

export function buildTeamWorkspaceDescription(options: {
	goal?: string | null;
	runId?: string | null;
	memberCount?: number | null;
	layout?: string | null;
}) {
	const parts = [
		options.runId ? `run ${options.runId}` : "",
		typeof options.memberCount === "number" && options.memberCount > 0
			? `${options.memberCount} agent${options.memberCount === 1 ? "" : "s"}`
			: "",
		options.layout ? `layout: ${options.layout}` : "",
		options.goal ? `goal: ${summarize(options.goal, 96)}` : "",
	].filter(Boolean);
	return parts.join(" • ");
}

export function buildAgentDisplayLabel(role?: string | null, alias?: string | null, options: { lead?: boolean } = {}) {
	let base = humanizeIdentifier(role || alias || "Agent") || "Agent";
	const index = trailingIndex(alias);
	if (index && !new RegExp(`\\b${index}$`).test(base)) {
		base = `${base} ${index}`;
	}
	return options.lead ? `${base} · lead` : base;
}

export function buildStandaloneAgentWorkspaceTitle(alias: string) {
	return `Agent · ${humanizeIdentifier(alias) || "Unnamed Agent"}`;
}

export function buildSeparateAgentWorkspaceTitle(team: string, role?: string | null, alias?: string | null, options: { lead?: boolean } = {}) {
	return `${buildTeamWorkspaceTitle(team)} — ${buildAgentDisplayLabel(role, alias, options)}`;
}
