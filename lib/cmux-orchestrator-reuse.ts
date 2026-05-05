export function searchTokens(text?: string | null) {
	return Array.from(
		new Set(
			String(text || "")
				.toLowerCase()
				.split(/[^a-z0-9]+/g)
				.map((item) => item.trim())
				.filter((item) => item.length >= 3)
				.filter((item) => !new Set([
					"the",
					"and",
					"for",
					"with",
					"that",
					"this",
					"from",
					"into",
					"your",
					"team",
					"agent",
					"agents",
					"work",
					"take",
					"great",
					"looks",
					"continue",
					"current",
					"project",
				]).has(item)),
		),
	);
}

function cwdScore(teamCwds: string[], cwd?: string | null) {
	const current = String(cwd || "").trim();
	if (!current) return 0;
	for (const item of teamCwds) {
		const candidate = String(item || "").trim();
		if (!candidate) continue;
		if (candidate === current) return 10;
		if (candidate.startsWith(current) || current.startsWith(candidate)) return 6;
	}
	return 0;
}

export function selectReusableTeamCandidates(
	teamRecords: any[],
	options: { taskText?: string | null; cwd?: string | null; focusedWorkspace?: string | null; limit?: number } = {},
) {
	const desiredTokens = new Set(searchTokens(options.taskText));
	const limit = Math.max(1, options.limit || 1);
	const candidates = (teamRecords || [])
		.map((teamRecord: any) => {
			const teamText = [
				teamRecord.team,
				teamRecord.goal,
				...(teamRecord.members || []).flatMap((member: any) => [member.alias, member.role, member.cwd]),
			].filter(Boolean).join("\n");
			const teamTokens = new Set(searchTokens(teamText));
			let overlap = 0;
			for (const token of desiredTokens) {
				if (teamTokens.has(token)) overlap += 1;
			}
			let score = 0;
			if (options.focusedWorkspace && teamRecord.workspace === options.focusedWorkspace) score += 12;
			score += cwdScore((teamRecord.members || []).map((member: any) => member.cwd).filter(Boolean), options.cwd);
			score += Math.min(8, overlap * 2);
			if (teamRecord.liveCount > 0) score += 5;
			if (teamRecord.status === "active") score += 4;
			else if (teamRecord.status === "blocked" || teamRecord.status === "stalled") score += 2;
			else if (teamRecord.status === "done") score += 1;
			return {
				team: teamRecord.team,
				teamRecord,
				score,
				overlap,
				updatedAt: teamRecord.updatedAt || teamRecord.lastHeartbeatAt || teamRecord.createdAt || "",
			};
		})
		.filter((item) => item.teamRecord?.liveCount > 0)
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.team).localeCompare(String(b.team)));
	return candidates.slice(0, limit);
}
