import { parseStructuredAgentReport } from "./cmux-orchestrator-analysis.ts";

function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function summarize(text?: string | null, max = 180) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface VerificationResult {
	status: "approved" | "rejected" | "inconclusive" | "requested" | "none";
	summary: string;
	evidence: string[];
	decision?: string | null;
}

export function classifyVerificationResult(input: { text?: string | null; summary?: string | null; report?: Record<string, string>; role?: string | null; requested?: boolean } = {}): VerificationResult {
	const report = input.report || parseStructuredAgentReport(String(input.text || input.summary || ""));
	const pool = [
		String(report.verification_status || ""),
		String(report.approval_decision || ""),
		String(report.verified_deliverables || ""),
		String(report.open_risks || ""),
		String(report.next_step || ""),
		String(input.summary || ""),
		String(input.text || ""),
	].join("\n");
	const normalized = pool.toLowerCase();
	if (!normalized.trim()) {
		return input.requested
			? { status: "requested", summary: "verification requested", evidence: [], decision: null }
			: { status: "none", summary: "no verification signal", evidence: [], decision: null };
	}
	const rejection = /(approval decision\s*:\s*(reject|rejected)|verification status\s*:\s*(failed|rejected)|\b(reject|rejected|failed verification|not approved|cannot approve|do not approve)\b)/i.test(pool);
	const approval = /(approval decision\s*:\s*(approve|approved)|verification status\s*:\s*(approved|verified|passed|complete)|\b(approved|verified|verification complete|signoff|qa passed|test passed|validation complete)\b)/i.test(pool);
	const openRisksField = String(report.open_risks || "").trim();
	const remainingWorkField = String((report as any).remaining_work || "").trim();
	const openRisks = (openRisksField && !/^(none|n\/a|no open risks?)$/i.test(openRisksField))
		|| (remainingWorkField && !/^(none|n\/a)$/i.test(remainingWorkField))
		|| /\b(blocker|blocked|unverified|inconclusive|pending verification|needs verification)\b/i.test(pool);
	const evidence = uniqueStrings([
		report.verification_status ? `verification=${report.verification_status}` : "",
		report.approval_decision ? `decision=${report.approval_decision}` : "",
		report.verified_deliverables ? `deliverables=${summarize(report.verified_deliverables, 120)}` : "",
		report.open_risks ? `risks=${summarize(report.open_risks, 120)}` : "",
	]);
	if (rejection) {
		return { status: "rejected", summary: summarize(report.open_risks || report.approval_decision || report.verification_status || input.summary || "verification rejected", 180), evidence, decision: report.approval_decision || report.verification_status || null };
	}
	if (approval && !openRisks) {
		return { status: "approved", summary: summarize(report.verified_deliverables || report.approval_decision || report.verification_status || input.summary || "verification approved", 180), evidence, decision: report.approval_decision || report.verification_status || null };
	}
	if (input.requested) {
		return { status: "requested", summary: summarize(input.summary || report.next_step || "verification requested", 180), evidence, decision: report.approval_decision || report.verification_status || null };
	}
	return { status: "inconclusive", summary: summarize(report.open_risks || report.next_step || input.summary || "verification inconclusive", 180), evidence, decision: report.approval_decision || report.verification_status || null };
}

export function summarizeVerificationResults(items: Array<{ alias?: string; team?: string | null; result?: VerificationResult | null }> = []) {
	const approvedAliases = uniqueStrings(items.filter((item) => item.result?.status === "approved").map((item) => item.alias || ""));
	const rejectedAliases = uniqueStrings(items.filter((item) => item.result?.status === "rejected").map((item) => item.alias || ""));
	const inconclusiveAliases = uniqueStrings(items.filter((item) => item.result?.status === "inconclusive").map((item) => item.alias || ""));
	const requestedAliases = uniqueStrings(items.filter((item) => item.result?.status === "requested").map((item) => item.alias || ""));
	const status = rejectedAliases.length
		? "rejected"
		: inconclusiveAliases.length
			? "inconclusive"
			: approvedAliases.length
				? "approved"
				: requestedAliases.length
					? "requested"
					: "none";
	return {
		status,
		approvedAliases,
		rejectedAliases,
		inconclusiveAliases,
		requestedAliases,
		approvedCount: approvedAliases.length,
		rejectedCount: rejectedAliases.length,
		inconclusiveCount: inconclusiveAliases.length,
		requestedCount: requestedAliases.length,
		summary: summarize([
			approvedAliases.length ? `approved=${approvedAliases.join(",")}` : "",
			rejectedAliases.length ? `rejected=${rejectedAliases.join(",")}` : "",
			inconclusiveAliases.length ? `inconclusive=${inconclusiveAliases.join(",")}` : "",
			requestedAliases.length ? `requested=${requestedAliases.join(",")}` : "",
		].filter(Boolean).join(" | "), 220) || "no verification activity",
	};
}
