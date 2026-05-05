function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function summarize(text?: string | null, max = 180) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (!value) return "";
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function slug(value: string, fallback = "outcome") {
	const normalized = String(value || fallback)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || fallback;
}

function sourceText(params: any) {
	return [params?.task, params?.goal, params?.message, params?.description].filter(Boolean).join("\n").trim();
}

function keywordSet(text: string) {
	return new Set(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function contains(text: string, pattern: RegExp) {
	return pattern.test(String(text || "").toLowerCase());
}

function extractOutcomePhrase(text: string) {
	const normalized = String(text || "").trim();
	const stripped = normalized
		.replace(/^(please\s+)?(help\s+me\s+)?/i, "")
		.replace(/^(create|build|implement|ship|fix|refactor|make|complete|design and build|investigate and resolve)\s+/i, "")
		.trim();
	return stripped || normalized;
}

function topKeywords(text: string, limit = 3) {
	const stop = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "your", "their", "then", "till", "until", "done", "correctly", "please", "build", "create", "implement", "make", "fix", "ship", "complete"]);
	return uniqueStrings(String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter((word) => word.length > 2 && !stop.has(word))).slice(0, limit);
}

export interface OutcomeIntentAssessment {
	shouldActivate: boolean;
	score: number;
	confidence: number;
	reasons: string[];
	suggestedMode: "solo" | "team" | "swarm";
	recommendedTeamCount: number;
	recommendedAgentCount: number;
	suggestedTeamBaseName: string;
	outcomePhrase: string;
}

export interface OutcomeExecutionContract {
	userIntent: string;
	outcome: string;
	deliverables: string[];
	constraints: string[];
	acceptanceCriteria: string[];
	verificationChecks: string[];
	riskFactors: string[];
	suggestedMode: "solo" | "team" | "swarm";
	recommendedTeamCount: number;
	recommendedAgentCount: number;
	suggestedTeamBaseName: string;
	activation: OutcomeIntentAssessment;
}

export interface OutcomeExecutionPlan {
	mode: "solo" | "team" | "swarm";
	topologyRationale: string;
	workstreams: Array<{ name: string; ownerRole?: string; completionCriteria?: string[] }>;
	roles: string[];
	milestones: string[];
	verificationPlan: string[];
	completionGate: {
		acceptanceCriteria: string[];
		verificationChecks: string[];
	};
}

export function detectOutcomeIntent(params: any): OutcomeIntentAssessment {
	const text = sourceText(params);
	const normalized = text.toLowerCase();
	const reasons: string[] = [];
	let score = 0;

	if (contains(normalized, /\b(create|build|implement|ship|fix|refactor|make|complete|deliver|design and build|investigate and resolve)\b/)) {
		score += 5;
		reasons.push("contains strong outcome-oriented verb");
	}
	if (contains(normalized, /\b(feature|dashboard|workflow|extension|integration|system|service|app|page|module|tool|pipeline|report|migration|refactor|fix|implementation)\b/)) {
		score += 2;
		reasons.push("references a concrete deliverable or system outcome");
	}
	if (contains(normalized, /\b(review|verify|validate|test|browser|web|research|docs|ship|production|correctly)\b/)) {
		score += 2;
		reasons.push("implies verification or multi-workstream execution");
	}
	if (text.length > 140) {
		score += 1;
		reasons.push("request has enough complexity to merit orchestration consideration");
	}
	if (contains(normalized, /\b(across|multiple|complex|broad|parallel|long[- ]?run|until completion|done correctly)\b/)) {
		score += 2;
		reasons.push("explicitly implies broader or longer-running execution");
	}
	if (contains(normalized, /^(list|status|timeline|artifacts|doctor|report|benchmark|scorecard)\b|\b(explain|summarize|show|what is)\b/)) {
		score -= 4;
		reasons.push("contains informational or reporting language");
	}
	if (contains(normalized, /\b(don't spawn|do this yourself|solo only|no team)\b/)) {
		score -= 3;
		reasons.push("contains anti-orchestration instruction");
	}

	const mode: "solo" | "team" | "swarm" = contains(normalized, /\b(swarm|multi-team|across systems|complex|architecture|broad|large|parallel)\b/) || text.length > 320
		? "swarm"
		: contains(normalized, /\b(browser|web|review|verify|research|integration|feature|dashboard|workflow|correctly)\b/) || score >= 5
			? "team"
			: "solo";
	const recommendedTeamCount = mode === "swarm" ? 2 : 1;
	const recommendedAgentCount = mode === "solo" ? 1 : mode === "team" ? 3 : 6;
	const outcomePhrase = extractOutcomePhrase(text || params?.action || "outcome");
	const teamBase = slug(topKeywords(outcomePhrase).join("-") || outcomePhrase, "outcome");
	const shouldActivate = score >= 4 || mode !== "solo";
	return {
		shouldActivate,
		score,
		confidence: clamp(score / 10, 0, 1),
		reasons: uniqueStrings(reasons),
		suggestedMode: mode,
		recommendedTeamCount,
		recommendedAgentCount,
		suggestedTeamBaseName: teamBase,
		outcomePhrase,
	};
}

export function deriveOutcomeExecutionContract(params: any): OutcomeExecutionContract {
	const text = sourceText(params);
	const activation = detectOutcomeIntent(params);
	const normalized = text.toLowerCase();
	const outcome = summarize(extractOutcomePhrase(text || params?.action || "requested outcome"), 220);
	const deliverables = uniqueStrings([
		outcome,
		contains(normalized, /\b(code|implement|build|feature|fix|refactor|extension|module)\b/) ? "implemented code changes" : "",
		contains(normalized, /\b(review|verify|validate|test|qa)\b/) ? "verification evidence" : "",
		contains(normalized, /\b(docs|readme|writeup|notes|summary)\b/) ? "documentation or summary update" : "",
		contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "verified browser or UI state" : "",
	]);
	const constraints = uniqueStrings([
		params?.cwd ? `work within ${params.cwd}` : "",
		contains(normalized, /\b(done correctly|correctly)\b/) ? "must be completed correctly, not just approximately" : "",
		contains(normalized, /\b(until completion|until done|till completion|till done)\b/) ? "execution should continue until complete or truly blocked" : "",
		contains(normalized, /\b(no team|solo only|do this yourself)\b/) ? "prefer solo execution unless impossible" : "",
	]);
	const acceptanceCriteria = uniqueStrings([
		"the requested outcome materially exists",
		"the result matches the user request and inferred scope",
		"critical blockers or dependencies are resolved or explicitly surfaced",
		contains(normalized, /\b(code|implement|build|fix|refactor|extension|module)\b/) ? "implementation changes are integrated coherently" : "",
		contains(normalized, /\b(review|verify|validate|test|qa)\b/) ? "review or validation confirms the work is acceptable" : "",
		contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "important browser/UI state is verified, not assumed" : "",
		contains(normalized, /\b(docs|readme|writeup|notes|summary)\b/) ? "documentation or summary output is complete and usable" : "",
	]);
	const verificationChecks = uniqueStrings([
		"inspect resulting artifacts and compare them to the requested outcome",
		"ensure no contradictory completion signals remain",
		contains(normalized, /\b(code|implement|build|fix|refactor|extension|module)\b/) ? "run or review relevant code/test/verification commands when appropriate" : "",
		contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "verify page or browser state through observation rather than prose alone" : "",
		contains(normalized, /\b(review|verify|validate|test|qa)\b/) ? "obtain reviewer or verification confirmation before completion" : "",
	]);
	const riskFactors = uniqueStrings([
		activation.suggestedMode !== "solo" ? "multi-step execution may drift without supervision" : "",
		contains(normalized, /\b(browser|web|page|workflow|ui|form|auth|login)\b/) ? "browser or external state may become stale or flaky" : "",
		contains(normalized, /\b(review|verify|validate|test|qa)\b/) ? "false-complete risk is elevated if verification is skipped" : "",
		contains(normalized, /\b(research|investigate|unknown|explore)\b/) ? "requirements or evidence may evolve during execution" : "",
		contains(normalized, /\b(fix|bug|incident|debug|regression)\b/) ? "partial fixes may appear complete while regressions remain" : "",
	]);
	return {
		userIntent: summarize(text, 320),
		outcome,
		deliverables,
		constraints,
		acceptanceCriteria,
		verificationChecks,
		riskFactors,
		suggestedMode: activation.suggestedMode,
		recommendedTeamCount: activation.recommendedTeamCount,
		recommendedAgentCount: activation.recommendedAgentCount,
		suggestedTeamBaseName: activation.suggestedTeamBaseName,
		activation,
	};
}

export function deriveOutcomeExecutionPlan(contract: OutcomeExecutionContract, params: any = {}): OutcomeExecutionPlan {
	const normalized = `${contract.userIntent}\n${params?.task || ""}\n${params?.goal || ""}`.toLowerCase();
	const mode = contract.suggestedMode;
	const roles = uniqueStrings(mode === "solo"
		? ["primary-agent"]
		: mode === "team"
			? ["lead", contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "navigator" : "coder", contains(normalized, /\b(review|verify|validate|test|qa)\b/) ? "reviewer" : "reviewer"]
			: ["lead", "planner", contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "navigator" : "coder", "reviewer", contains(normalized, /\b(research|investigate|unknown|explore)\b/) ? "researcher" : "tester", "integrator"]);
	const workstreamNames = uniqueStrings([
		"frame and decompose the requested outcome",
		contains(normalized, /\b(code|implement|build|fix|refactor|extension|module|feature)\b/) ? "implement the core changes" : "produce the core deliverable",
		contains(normalized, /\b(browser|web|page|workflow|ui|form)\b/) ? "verify browser or UI state" : "",
		contains(normalized, /\b(research|investigate|unknown|explore)\b/) ? "research unresolved questions or dependencies" : "",
		contains(normalized, /\b(docs|readme|writeup|notes|summary)\b/) ? "prepare documentation or summary outputs" : "",
		"review and verification before completion",
	]);
	const workstreams = workstreamNames.map((name, index) => ({
		name,
		ownerRole: roles[Math.min(index, roles.length - 1)] || roles[0] || "lead",
		completionCriteria: index === 0 ? ["scope is decomposed and owned"] : index === workstreamNames.length - 1 ? ["verification evidence supports completion"] : ["workstream output is materially complete"],
	}));
	const milestones = uniqueStrings([
		"execution contract confirmed",
		mode === "solo" ? "solo execution underway" : "team topology launched",
		"core deliverable materially complete",
		"verification and review complete",
		"completion gate satisfied",
	]);
	const verificationPlan = uniqueStrings([
		...contract.verificationChecks,
		"compare synthesized status against observed evidence before marking done",
	]);
	return {
		mode,
		topologyRationale: mode === "solo"
			? "task appears bounded enough for one accountable executor"
			: mode === "team"
				? "task appears outcome-oriented and benefits from implementation plus review specialization"
				: "task appears broad or complex enough to justify multi-stream supervised execution",
		workstreams,
		roles,
		milestones,
		verificationPlan,
		completionGate: {
			acceptanceCriteria: contract.acceptanceCriteria,
			verificationChecks: verificationPlan,
		},
	};
}

export function renderOutcomeExecutionContract(contract: OutcomeExecutionContract) {
	return [
		"# outcome execution contract",
		"",
		`- outcome: ${contract.outcome}`,
		`- suggested mode: ${contract.suggestedMode}`,
		`- team base: ${contract.suggestedTeamBaseName}`,
		`- recommended teams: ${contract.recommendedTeamCount}`,
		`- recommended agents: ${contract.recommendedAgentCount}`,
		`- activation confidence: ${contract.activation.confidence}`,
		contract.activation.reasons.length ? "" : "",
		contract.activation.reasons.length ? "## Activation reasons" : "",
		...(contract.activation.reasons.length ? contract.activation.reasons.map((item) => `- ${item}`) : []),
		"",
		"## Deliverables",
		...contract.deliverables.map((item) => `- ${item}`),
		"",
		"## Acceptance criteria",
		...contract.acceptanceCriteria.map((item) => `- ${item}`),
		"",
		"## Verification checks",
		...contract.verificationChecks.map((item) => `- ${item}`),
	].filter(Boolean).join("\n");
}

export function renderOutcomeExecutionPlan(plan: OutcomeExecutionPlan) {
	return [
		"# outcome execution plan",
		"",
		`- mode: ${plan.mode}`,
		`- topology rationale: ${plan.topologyRationale}`,
		"",
		"## Roles",
		...plan.roles.map((role) => `- ${role}`),
		"",
		"## Workstreams",
		...plan.workstreams.flatMap((item) => [`- ${item.name}${item.ownerRole ? ` [${item.ownerRole}]` : ""}`, ...((item.completionCriteria || []).map((criterion) => `  - completion: ${criterion}`))]),
		"",
		"## Milestones",
		...plan.milestones.map((item) => `- ${item}`),
		"",
		"## Verification plan",
		...plan.verificationPlan.map((item) => `- ${item}`),
	].filter(Boolean).join("\n");
}
