import { summarize } from "./cmux-orchestrator-analysis.ts";

function uniqueStrings(values: any[] = []) {
	return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function renderBulletSection(title: string, values: any[] = [], limit = 16) {
	const items = uniqueStrings(values);
	if (!items.length) return [] as string[];
	const capped = items.slice(0, Math.max(1, limit));
	return [
		"",
		`## ${title} (${items.length})`,
		...capped.map((item) => `- ${item}`),
		...(items.length > capped.length ? [`- +${items.length - capped.length} more`] : []),
	];
}

export function renderArtifactInventory(title: string, inventory: { artifactPaths?: string[]; urls?: string[]; commands?: string[] }) {
	const artifactPaths = uniqueStrings(inventory?.artifactPaths || []);
	const urls = uniqueStrings(inventory?.urls || []);
	const commands = uniqueStrings(inventory?.commands || []);
	return [
		`# ${title}`,
		"",
		`- artifact paths: ${artifactPaths.length}`,
		`- urls: ${urls.length}`,
		`- commands: ${commands.length}`,
		...(artifactPaths.length || urls.length || commands.length
			? []
			: ["", "- No artifacts, URLs, or commands recorded."]),
		...renderBulletSection("Artifact paths", artifactPaths, 48),
		...renderBulletSection("URLs", urls, 24),
		...renderBulletSection("Commands", commands, 24),
	].join("\n");
}

function eventSeverity(event: any) {
	const type = String(event?.type || "").toLowerCase();
	const status = String(event?.status || "").toLowerCase();
	const detail = String(event?.detail || "").toLowerCase();
	if ([type, status, detail].some((value) => /(fail|error|blocked|stalled|degraded|attention|escalat)/.test(value))) return "high";
	if ([type, status, detail].some((value) => /(rebalance|relay|heartbeat|dispatch|progress|review|waiting)/.test(value))) return "medium";
	if ([type, status, detail].some((value) => /(created|resolved|ready|complete|done|synthesis|shutdown|closed)/.test(value))) return "low";
	return "info";
}

function formatEventLine(event: any) {
	const severity = eventSeverity(event);
	const targetBits = [
		event?.team ? `team=${event.team}` : "",
		event?.alias ? `alias=${event.alias}` : "",
		event?.status ? `status=${event.status}` : "",
		event?.source ? `source=${event.source}` : "",
		event?.target ? `target=${event.target}` : "",
	].filter(Boolean).join(" ");
	return `- ${event?.timestamp || "?"} [${severity}] ${event?.type || "event"}${targetBits ? ` ${targetBits}` : ""}${event?.detail ? ` — ${summarize(event.detail, 180)}` : ""}`;
}

function formatDependencyLine(edge: any) {
	const source = edge?.fromAlias || edge?.fromTeam || "run";
	const target = edge?.target || edge?.targetHint || "external";
	const state = edge?.open === false ? "resolved" : edge?.blocked ? "blocked" : "open";
	return `- ${source} -> ${target} [${edge?.kind || "dependency"}/${state}]${edge?.targetType ? ` type=${edge.targetType}` : ""}${edge?.text ? ` — ${summarize(edge.text, 180)}` : ""}`;
}

export function renderRunSummary(runRecord: any) {
	const missionControl = runRecord.missionControl || {};
	const bridgeActivity = runRecord.bridgeActivity || {};
	const attentionItems = Array.isArray(missionControl.attentionItems) ? missionControl.attentionItems : [];
	const communicationQueue = Array.isArray(missionControl.communicationQueue) ? missionControl.communicationQueue : [];
	const primaryInbox = Array.isArray(missionControl.primaryInbox) ? missionControl.primaryInbox : (Array.isArray(runRecord.primaryInbox) ? runRecord.primaryInbox : []);
	const recentEvents = Array.isArray(missionControl.recentEvents) ? missionControl.recentEvents : [];
	const dependencyGraph = Array.isArray(missionControl.dependencyGraph) ? missionControl.dependencyGraph : [];
	const dependencySummary = missionControl.dependencySummary || {};
	return [
		`# cmux Pi run ${runRecord.runId}`,
		"",
		`- title: ${runRecord.title || "—"}`,
		`- status: ${runRecord.status || "unknown"}`,
		`- teams: ${(runRecord.teamNames || []).join(", ") || "—"}`,
		`- rounds: ${runRecord.roundsCompleted || 0}/${runRecord.roundsPlanned || 0}`,
		`- mode: ${runRecord.orchestrationMode || "custom"}`,
		runRecord.modelPreset ? `- modelPreset: ${runRecord.modelPreset}` : "",
		runRecord.outcomeIntent?.shouldActivate !== undefined ? `- outcome mode: ${runRecord.outcomeIntent.shouldActivate ? "activated" : "not-activated"}` : "",
		runRecord.executionContract?.suggestedMode ? `- suggested execution mode: ${runRecord.executionContract.suggestedMode}` : "",
		`- operatorWorkspace: ${runRecord.operatorWorkspace || "—"}`,
		`- operatorSurface: ${runRecord.operatorSurface || "—"}`,
		typeof missionControl.bridgeLinkedAgentCount === "number" ? `- bridge linked agents: ${missionControl.bridgeLinkedAgentCount}` : "",
		typeof missionControl.bridgeFreshAgentCount === "number" ? `- bridge fresh agents: ${missionControl.bridgeFreshAgentCount}` : "",
		typeof missionControl.bridgeStaleAgentCount === "number" ? `- bridge stale agents: ${missionControl.bridgeStaleAgentCount}` : "",
		bridgeActivity.latestBridgeEventType ? `- bridge activity: ${bridgeActivity.latestBridgeEventType} @ ${bridgeActivity.latestBridgeEventAt || "—"}` : "",
		bridgeActivity.latestPatternTool ? `- pattern activity: ${bridgeActivity.latestPatternTool}/${bridgeActivity.latestPatternStatus || "unknown"}` : "",
		bridgeActivity.browserLockOwners?.length ? `- browser lock owners: ${bridgeActivity.browserLockOwners.join(", ")}` : "",
		runRecord.lastMissionControlAt ? `- last mission control sync: ${runRecord.lastMissionControlAt}` : "",
		runRecord.lastProgressReportAt ? `- last progress report: ${runRecord.lastProgressReportAt}` : "",
		runRecord.lastObservedAt ? `- last observation: ${runRecord.lastObservedAt}` : "",
		typeof runRecord.observationCount === "number" ? `- observation count: ${runRecord.observationCount}` : "",
		runRecord.lastGuidanceAt ? `- last guidance: ${runRecord.lastGuidanceAt}` : "",
		runRecord.lastVerificationAt ? `- last verification: ${runRecord.lastVerificationAt}` : "",
		runRecord.lastVerificationStatus ? `- verification status: ${runRecord.lastVerificationStatus}` : "",
		typeof runRecord.completionGateSatisfied === "boolean" ? `- completion gate: ${runRecord.completionGateSatisfied ? "pass" : "hold"}` : "",
		runRecord.completionGateSummary ? `- completion gate summary: ${summarize(runRecord.completionGateSummary, 180)}` : "",
		runRecord.operatorFeedSummary ? `- operator feed: ${summarize(runRecord.operatorFeedSummary, 180)}` : "",
		missionControl.primaryConcern ? `- primary concern: ${summarize(missionControl.primaryConcern, 180)}` : "",
		dependencyGraph.length ? `- open dependencies: ${dependencySummary.open ?? dependencyGraph.filter((item: any) => item.open !== false).length}` : "",
		dependencyGraph.length ? `- blocked dependencies: ${dependencySummary.blocked ?? dependencyGraph.filter((item: any) => item.open !== false && item.blocked).length}` : "",
		`- createdAt: ${runRecord.createdAt || "—"}`,
		`- updatedAt: ${runRecord.updatedAt || "—"}`,
		`- completedAt: ${runRecord.completedAt || "—"}`,
		typeof runRecord.completionCount === "number" ? `- completionCount: ${runRecord.completionCount}` : "",
		(runRecord.lastMissionControlAt || runRecord.operatorFeedSummary || missionControl.primaryConcern || attentionItems.length || communicationQueue.length || dependencyGraph.length || recentEvents.length)
			? "## Mission control"
			: "",
		runRecord.operatorFeedSummary ? `- operator feed summary: ${summarize(runRecord.operatorFeedSummary, 220)}` : "",
		missionControl.primaryConcern ? `- primary concern: ${summarize(missionControl.primaryConcern, 220)}` : "",
		dependencyGraph.length ? `- open dependencies: ${dependencySummary.open ?? dependencyGraph.filter((item: any) => item.open !== false).length}` : "",
		dependencyGraph.length ? `- blocked dependencies: ${dependencySummary.blocked ?? dependencyGraph.filter((item: any) => item.open !== false && item.blocked).length}` : "",
		attentionItems.length ? "### Attention queue" : "",
		attentionItems.length ? attentionItems.slice(0, 8).map((item: string) => `- ${item}`).join("\n") : "",
		primaryInbox.length ? "### Primary inbox" : "",
		primaryInbox.length ? primaryInbox.slice(0, 10).map((item: any) => `- ${item.timestamp || "?"} [${item.kind || "report"}/${item.status || "active"}] ${item.team || item.alias || "run"}: ${summarize(item.summary || item.text || item.detail || "", 180)}`).join("\n") : "",
		communicationQueue.length ? "### Communication pathways" : "",
		communicationQueue.length ? communicationQueue.slice(0, 8).map((item: any) => `- [${item.kind || "signal"}] ${item.team || item.alias || "run"}: ${summarize(item.text || item.detail || "", 160)}`).join("\n") : "",
		dependencyGraph.length ? "### Dependency graph" : "",
		dependencyGraph.length ? dependencyGraph.slice(0, 10).map((edge: any) => formatDependencyLine(edge)).join("\n") : "",
		recentEvents.length ? "### Live activity feed" : "",
		recentEvents.length ? recentEvents.slice(0, 8).map((event: any) => formatEventLine(event)).join("\n") : "",
		runRecord.executionContract ? "## Outcome contract" : "",
		runRecord.executionContract?.outcome ? `- outcome: ${runRecord.executionContract.outcome}` : "",
		runRecord.executionContract?.deliverables?.length ? `- deliverables: ${runRecord.executionContract.deliverables.join(", ")}` : "",
		runRecord.executionContract?.acceptanceCriteria?.length ? `- acceptance criteria: ${runRecord.executionContract.acceptanceCriteria.length}` : "",
		runRecord.executionPlan?.workstreams?.length ? `- workstreams: ${runRecord.executionPlan.workstreams.length}` : "",
		...renderBulletSection("Planning artifacts", runRecord.planningArtifacts || [], 12),
		...renderBulletSection("Artifacts", runRecord.artifactPaths || [], 32),
		...renderBulletSection("URLs", runRecord.urls || [], 16),
		...renderBulletSection("Commands", runRecord.commands || [], 16),
		runRecord.lastProgressSummary ? "" : "",
		runRecord.lastProgressSummary ? "## Latest progress" : "",
		runRecord.lastProgressSummary ? runRecord.lastProgressSummary : "",
		runRecord.lastObservationSummary ? "" : "",
		runRecord.lastObservationSummary ? "## Latest observation" : "",
		runRecord.lastObservationSummary ? runRecord.lastObservationSummary : "",
		runRecord.lastGuidanceSummary ? `- latest guidance: ${runRecord.lastGuidanceSummary}` : "",
		Array.isArray(runRecord.guidanceLog) && runRecord.guidanceLog.length ? `- guidance log entries: ${runRecord.guidanceLog.length}` : "",
		runRecord.lastCoordinatorSummary ? "" : "",
		runRecord.lastCoordinatorSummary ? "## Latest coordinator heartbeat" : "",
		runRecord.lastCoordinatorSummary ? runRecord.lastCoordinatorSummary : "",
		runRecord.lastCoordinatorAction ? `- next orchestrator action: ${runRecord.lastCoordinatorAction}` : "",
		runRecord.lastCoordinatorRequests ? `- requests to swarm: ${runRecord.lastCoordinatorRequests}` : "",
		Array.isArray(runRecord.doctorFindings) && runRecord.doctorFindings.length ? "" : "",
		Array.isArray(runRecord.doctorFindings) && runRecord.doctorFindings.length ? "## Doctor findings" : "",
		Array.isArray(runRecord.doctorFindings) && runRecord.doctorFindings.length ? runRecord.doctorFindings.slice(0, 8).map((finding: any) => `- [${finding.severity || "info"}] ${finding.kind || "finding"} — ${summarize(finding.summary || "", 180)}`).join("\n") : "",
		runRecord.repairSummary || (Array.isArray(runRecord.repairActions) && runRecord.repairActions.length) ? "" : "",
		runRecord.repairSummary || (Array.isArray(runRecord.repairActions) && runRecord.repairActions.length) ? "## Repair plan" : "",
		runRecord.repairSummary ? `- repair summary: ${summarize(runRecord.repairSummary, 180)}` : "",
		Array.isArray(runRecord.repairActions) && runRecord.repairActions.length ? runRecord.repairActions.slice(0, 8).map((action: any) => `- [${action.priority || "p3"}] ${action.action || "repair"}${action.safeAutoExecute ? " auto" : " manual"} — ${summarize(action.reason || "", 180)}`).join("\n") : "",
		runRecord.lastRepairExecutionSummary || (Array.isArray(runRecord.repairExecutionLog) && runRecord.repairExecutionLog.length) ? "" : "",
		runRecord.lastRepairExecutionSummary || (Array.isArray(runRecord.repairExecutionLog) && runRecord.repairExecutionLog.length) ? "## Repair execution" : "",
		runRecord.lastRepairExecutionSummary ? `- last repair execution: ${summarize(runRecord.lastRepairExecutionSummary, 180)}` : "",
		runRecord.lastRepairEffectivenessSummary ? `- repair effectiveness: ${summarize(runRecord.lastRepairEffectivenessSummary, 180)}` : "",
		Array.isArray(runRecord.repairExecutionLog) && runRecord.repairExecutionLog.length ? runRecord.repairExecutionLog.slice(-6).map((entry: any) => `- ${entry.timestamp || "?"} [${entry.status || "unknown"}] ${entry.action || "repair"}${entry.safeAutoExecute ? " auto" : ""} — ${summarize(entry.note || entry.reason || "", 180)}`).join("\n") : "",
		runRecord.lastVerificationSummary || runRecord.verificationState?.status || (Array.isArray(runRecord.verificationLog) && runRecord.verificationLog.length) ? "" : "",
		runRecord.lastVerificationSummary || runRecord.verificationState?.status || (Array.isArray(runRecord.verificationLog) && runRecord.verificationLog.length) ? "## Verification" : "",
		runRecord.verificationState?.status ? `- status: ${runRecord.verificationState.status}` : "",
		runRecord.lastVerificationSummary ? `- summary: ${summarize(runRecord.lastVerificationSummary, 180)}` : "",
		runRecord.verificationState?.approvedAliases?.length ? `- approved: ${runRecord.verificationState.approvedAliases.join(", ")}` : "",
		runRecord.verificationState?.rejectedAliases?.length ? `- rejected: ${runRecord.verificationState.rejectedAliases.join(", ")}` : "",
		runRecord.verificationState?.inconclusiveAliases?.length ? `- inconclusive: ${runRecord.verificationState.inconclusiveAliases.join(", ")}` : "",
		runRecord.verificationState?.requestedAliases?.length ? `- requested: ${runRecord.verificationState.requestedAliases.join(", ")}` : "",
		runRecord.scorecardSummary ? "" : "",
		runRecord.scorecardSummary ? "## Evaluation" : "",
		runRecord.scorecardSummary ? `- score: ${runRecord.scorecardSummary.overallScore ?? "—"}` : "",
		runRecord.scorecardSummary ? `- completion accuracy: ${runRecord.scorecardSummary.completionAccuracy ?? "—"}` : "",
		runRecord.scorecardSummary ? `- false-complete rate: ${runRecord.scorecardSummary.falseCompleteRate ?? "—"}` : "",
		runRecord.scorecardSummary ? `- status alignment: ${runRecord.scorecardSummary.statusAlignment ? "yes" : "no"}` : "",
		...renderBulletSection("Scorecard artifacts", runRecord.scorecardArtifacts || [], 12),
		...renderBulletSection("Failure artifacts", runRecord.failureArtifacts || [], 12),
		Array.isArray(runRecord.lastTeamLeadSummaries) && runRecord.lastTeamLeadSummaries.length ? "" : "",
		Array.isArray(runRecord.lastTeamLeadSummaries) && runRecord.lastTeamLeadSummaries.length ? "## Latest team lead reports" : "",
		Array.isArray(runRecord.lastTeamLeadSummaries) && runRecord.lastTeamLeadSummaries.length ? runRecord.lastTeamLeadSummaries.map((item: string) => `- ${item}`).join("\n") : "",
		Array.isArray(runRecord.progressLog) && runRecord.progressLog.length ? "" : "",
		Array.isArray(runRecord.progressLog) && runRecord.progressLog.length ? "## Progress log" : "",
		Array.isArray(runRecord.progressLog) && runRecord.progressLog.length
			? runRecord.progressLog.slice(-8).map((item: any) => `- ${item.timestamp || "?"} round=${item.round || "?"} status=${item.status || "active"} — ${item.summary || ""}`).join("\n")
			: "",
		runRecord.synthesisSummary ? "" : "",
		runRecord.synthesisSummary ? "## Synthesis" : "",
		runRecord.synthesisSummary ? runRecord.synthesisSummary : "",
	].filter(Boolean).join("\n");
}

export function renderAgentStatus(record: any, live?: any) {
	const bridge = record.bridge || null;
	const lines = [
		`# cmux Pi agent ${record.alias}`,
		"",
		`- status: ${record.status || (live ? "ready" : "offline")}`,
		`- live: ${live ? "yes" : "no"}`,
		`- team: ${record.team || "—"}`,
		`- runId: ${record.runId || "—"}`,
		`- role: ${record.role || "—"}`,
		`- provider: ${record.provider || "—"}`,
		`- model: ${record.model || "—"}`,
		`- workspace: ${record.workspace || "—"}`,
		`- workspaceTitle: ${record.workspaceTitle || live?.workspaceTitle || "—"}`,
		`- surface: ${record.surface || "—"}`,
		`- surfaceTitle: ${record.surfaceTitle || live?.title || "—"}`,
		`- cwd: ${record.cwd || "—"}`,
		`- sessionPath: ${record.sessionPath || "—"}`,
		`- lastHeartbeatAt: ${record.lastHeartbeatAt || "—"}`,
		`- lastCaptureAt: ${record.lastCaptureAt || "—"}`,
		`- lastProgressAt: ${record.lastProgressAt || "—"}`,
		`- lastObservedAt: ${record.lastObservedAt || "—"}`,
		`- lastObservedRound: ${record.lastObservedRound || "—"}`,
		`- stallCount: ${record.stallCount || 0}`,
		`- bridge linked: ${bridge ? "yes" : "no"}`,
		bridge ? `- bridge lastEventType: ${bridge.lastEventType || "—"}` : "",
		bridge ? `- bridge lastEventAt: ${bridge.lastEventAt || "—"}` : "",
		bridge ? `- bridge stale: ${bridge.bridgeAge?.stale ? "yes" : "no"}` : "",
		bridge?.bridgeAge?.ageMinutes !== null && bridge?.bridgeAge?.ageMinutes !== undefined ? `- bridge ageMinutes: ${bridge.bridgeAge.ageMinutes}` : "",
		bridge?.cmux?.kbTaskId || bridge?.identity?.task_id ? `- bridge taskId: ${bridge?.cmux?.kbTaskId || bridge?.identity?.task_id}` : "",
		record.lastBridgeEventType ? `- ingested bridge event: ${record.lastBridgeEventType}` : "",
		record.lastBridgeEventAt ? `- ingested bridge event at: ${record.lastBridgeEventAt}` : "",
		record.browserSurface ? `- browser surface: ${record.browserSurface}` : "",
		record.browserLockOwner ? `- browser lock owner: ${record.browserLockOwner}` : "",
		record.browserLockTeam ? `- browser lock team: ${record.browserLockTeam}` : "",
		record.lastBrowserRecoveryStatus ? `- browser recovery: ${record.lastBrowserRecoveryStatus}${record.lastBrowserRecoveryStrategy ? ` (${record.lastBrowserRecoveryStrategy})` : ""}` : "",
		record.lastCheckpointKey ? `- browser checkpoint: ${record.lastCheckpointKey}${record.lastCheckpointCollection ? ` [${record.lastCheckpointCollection}]` : ""}` : "",
		record.lastPatternRunStatus ? `- pattern run: ${record.lastPatternRunStatus}` : "",
		record.lastPatternTool ? `- pattern tool: ${record.lastPatternTool}` : "",
		record.lastPatternSetupStatus ? `- pattern setup: ${record.lastPatternSetupStatus}` : "",
		record.lastGuidanceAt ? `- last guidance at: ${record.lastGuidanceAt}` : "",
		record.lastGuidanceKind ? `- last guidance kind: ${record.lastGuidanceKind}` : "",
		record.lastVerificationAt ? `- last verification at: ${record.lastVerificationAt}` : "",
		record.lastVerificationStatus ? `- last verification status: ${record.lastVerificationStatus}` : "",
		typeof record.observationCount === "number" ? `- observation count: ${record.observationCount}` : "",
		record.lastObservationSummary ? "" : "",
		record.lastObservationSummary ? "## Latest observation" : "",
		record.lastObservationSummary ? record.lastObservationSummary : "",
		record.lastGuidanceSummary ? `- latest guidance: ${record.lastGuidanceSummary}` : "",
		record.lastVerificationSummary ? `- latest verification: ${record.lastVerificationSummary}` : "",
		record.lastSummary ? "" : "",
		record.lastSummary ? "## Summary" : "",
		record.lastSummary ? record.lastSummary : "",
		...renderBulletSection("Blockers", record.lastBlockers || [], 12),
		...renderBulletSection("Artifacts", record.lastArtifacts || [], 24),
		...renderBulletSection("URLs", record.lastUrls || [], 16),
		...renderBulletSection("Commands", record.lastCommands || [], 16),
	].filter(Boolean);
	return lines.join("\n");
}

export function renderRunCollectionSummary(runRecords: any[]) {
	const runs = runRecords || [];
	if (!runs.length) return "# cmux Pi runs\n\n- No orchestration runs.";
	return [
		"# cmux Pi runs",
		"",
		...runs.map((run: any) => `- ${run.runId} [${run.status || "unknown"}] teams=${(run.teamNames || []).join(",") || "—"} rounds=${run.roundsCompleted || 0}/${run.roundsPlanned || 0} artifacts=${(run.artifactPaths || []).length} title=${summarize(run.title || run.task || "", 120)}`),
	].join("\n");
}

export function renderRunTimeline(runId: string, events: any[]) {
	const rows = events || [];
	return [
		`# cmux Pi run timeline ${runId}`,
		"",
		...(rows.length ? rows.map((event: any) => formatEventLine(event)) : ["- No events logged."]),
	].join("\n");
}

export function renderMissionControlSnapshot(snapshot: any) {
	if (!snapshot) return "# cmux mission control\n\n- No mission-control snapshot available.";
	const teams = snapshot.teams || [];
	const agents = snapshot.agents || [];
	const events = snapshot.recentEvents || [];
	const communications = snapshot.communicationQueue || [];
	const primaryInbox = snapshot.primaryInbox || [];
	const attention = snapshot.attentionItems || [];
	const dependencies = snapshot.dependencyGraph || [];
	const dependencySummary = snapshot.dependencySummary || {};
	const bridgeActivity = snapshot.bridgeActivity || {};
	return [
		`# cmux mission control${snapshot.runId ? ` ${snapshot.runId}` : ""}`,
		"",
		`- status: ${snapshot.status || "unknown"}`,
		`- task: ${snapshot.taskSummary || "—"}`,
		`- operatorWorkspace: ${snapshot.operatorWorkspace || "—"}`,
		`- operatorSurface: ${snapshot.operatorSurface || "—"}`,
		`- last mission control sync: ${snapshot.lastMissionControlAt || "—"}`,
		`- last progress report: ${snapshot.lastProgressReportAt || "—"}`,
		`- last observation: ${snapshot.lastObservationAt || "—"}`,
		typeof snapshot.observationCount === "number" ? `- observation count: ${snapshot.observationCount}` : "",
		snapshot.lastGuidanceAt ? `- last guidance: ${snapshot.lastGuidanceAt}` : "",
		`- last round: ${snapshot.lastRoundNumber || "—"}`,
		`- rounds completed: ${snapshot.roundsCompleted ?? "—"}`,
		`- coordinator completion: ${typeof snapshot.coordinatorCompletion === "boolean" ? String(snapshot.coordinatorCompletion) : "—"}`,
		`- synthesis completion: ${typeof snapshot.synthesisCompletion === "boolean" ? String(snapshot.synthesisCompletion) : "—"}`,
		snapshot.operatorFeedSummary ? `- operator feed: ${summarize(snapshot.operatorFeedSummary, 180)}` : "",
		snapshot.primaryConcern ? `- primary concern: ${summarize(snapshot.primaryConcern, 180)}` : "",
		`- teams: ${teams.length}`,
		`- agents: ${agents.length}`,
		`- live teams: ${snapshot.liveTeamCount ?? teams.filter((team: any) => team.live).length}`,
		`- live agents: ${snapshot.liveAgentCount ?? agents.filter((agent: any) => agent.live !== false).length}`,
		`- bridge linked agents: ${snapshot.bridgeLinkedAgentCount ?? 0}`,
		`- bridge fresh agents: ${snapshot.bridgeFreshAgentCount ?? 0}`,
		`- bridge stale agents: ${snapshot.bridgeStaleAgentCount ?? 0}`,
		bridgeActivity.latestBridgeEventType ? `- latest bridge activity: ${bridgeActivity.latestBridgeEventType} @ ${bridgeActivity.latestBridgeEventAt || "—"}` : "",
		bridgeActivity.latestPatternTool ? `- latest pattern activity: ${bridgeActivity.latestPatternTool}/${bridgeActivity.latestPatternStatus || "unknown"}` : "",
		`- blocked agents: ${snapshot.blockedAgentCount ?? 0}`,
		`- stalled agents: ${snapshot.stalledAgentCount ?? 0}`,
		`- waiting review teams: ${snapshot.waitingReviewTeamCount ?? 0}`,
		typeof snapshot.completionGateSatisfied === "boolean" ? `- completion gate: ${snapshot.completionGateSatisfied ? "pass" : "hold"}` : "",
		snapshot.completionGateSummary ? `- completion gate summary: ${summarize(snapshot.completionGateSummary, 180)}` : "",
		snapshot.verificationState?.status ? `- verification: ${snapshot.verificationState.status}` : "",
		snapshot.lastVerificationSummary ? `- verification summary: ${summarize(snapshot.lastVerificationSummary, 180)}` : "",
		typeof snapshot.findingSummary?.total === "number" ? `- findings: ${snapshot.findingSummary.total}` : "",
		typeof snapshot.repairSummary?.total === "number" ? `- repair actions: ${snapshot.repairSummary.total}` : "",
		typeof snapshot.repairExecutionSummary?.total === "number" ? `- repair executions: ${snapshot.repairExecutionSummary.total}` : "",
		snapshot.lastRepairEffectivenessSummary ? `- repair effectiveness: ${summarize(snapshot.lastRepairEffectivenessSummary, 180)}` : "",
		dependencies.length ? `- open dependencies: ${dependencySummary.open ?? dependencies.filter((item: any) => item.open !== false).length}` : "",
		dependencies.length ? `- blocked dependencies: ${dependencySummary.blocked ?? dependencies.filter((item: any) => item.open !== false && item.blocked).length}` : "",
		primaryInbox.length ? `- primary inbox reports: ${primaryInbox.length}` : "",
		communications.length ? `- communication signals: ${communications.length}` : "",
		attention.length ? `- attention items: ${attention.length}` : "",
		"",
		"## Mission control highlights",
		`- primary concern: ${snapshot.primaryConcern || attention[0] || "—"}`,
		`- operator feed: ${snapshot.operatorFeedSummary || "—"}`,
		`- latest observation: ${snapshot.lastObservationSummary || "—"}`,
		`- latest guidance: ${snapshot.lastGuidanceSummary || "—"}`,
		`- completion gate: ${typeof snapshot.completionGateSatisfied === "boolean" ? (snapshot.completionGateSatisfied ? "pass" : "hold") : "—"}`,
		`- verification: ${snapshot.verificationState?.status || "—"}`,
		`- latest feed event: ${events[0] ? `${events[0].type || "event"}${events[0].status ? ` (${events[0].status})` : ""}` : "—"}`,
		`- primary inbox: ${primaryInbox.length}`,
		`- communication pathways: ${communications.length}`,
		`- attention queue: ${attention.length}`,
		`- dependency edges: ${dependencies.length}`,
		"",
		"## Health rail",
		...(teams.length
			? teams.map((team: any) => `- ${team.team}: status=${team.status || "unknown"} live=${team.liveCount ?? 0}/${team.memberCount ?? 0} bridge=${team.bridgeFreshCount ?? 0} fresh/${team.bridgeStaleCount ?? 0} stale blockers=${team.blockerCount ?? 0} stalled=${team.stalledCount ?? 0}${team.lastLeadSummary ? ` — ${summarize(team.lastLeadSummary, 120)}` : ""}`)
			: ["- No teams tracked."]),
		attention.length ? "" : "",
		attention.length ? "## Attention queue" : "",
		attention.length ? attention.slice(0, 12).map((item: string) => `- ${item}`).join("\n") : "",
		snapshot.findings?.length ? "" : "",
		snapshot.findings?.length ? "## Doctor findings" : "",
		snapshot.findings?.length ? snapshot.findings.slice(0, 10).map((finding: any) => `- [${finding.severity || "info"}] ${finding.kind}${finding.team ? ` team=${finding.team}` : ""}${finding.alias ? ` alias=${finding.alias}` : ""} — ${summarize(finding.summary || "", 160)}`).join("\n") : "",
		snapshot.repairActions?.length ? "" : "",
		snapshot.repairActions?.length ? "## Repair plan" : "",
		snapshot.repairActions?.length ? snapshot.repairActions.slice(0, 10).map((item: any) => `- [${item.priority || "p3"}] ${item.action}${item.safeAutoExecute ? " auto" : " manual"} — ${summarize(item.reason || "", 160)}`).join("\n") : "",
		snapshot.repairExecution?.length ? "" : "",
		snapshot.repairExecution?.length ? "## Repair execution" : "",
		snapshot.repairExecution?.length ? snapshot.repairExecution.slice(-10).map((item: any) => `- [${item.status || "unknown"}] ${item.action || "repair"} — ${summarize(item.note || item.reason || "", 160)}`).join("\n") : "",
		snapshot.verificationState?.status && snapshot.verificationState.status !== "none" ? "" : "",
		snapshot.verificationState?.status && snapshot.verificationState.status !== "none" ? "## Verification" : "",
		snapshot.verificationState?.status && snapshot.verificationState.status !== "none" ? `- status: ${snapshot.verificationState.status}` : "",
		snapshot.verificationState?.summary ? `- summary: ${summarize(snapshot.verificationState.summary, 180)}` : "",
		snapshot.verificationState?.approvedAliases?.length ? `- approved: ${snapshot.verificationState.approvedAliases.join(", ")}` : "",
		snapshot.verificationState?.rejectedAliases?.length ? `- rejected: ${snapshot.verificationState.rejectedAliases.join(", ")}` : "",
		snapshot.verificationState?.inconclusiveAliases?.length ? `- inconclusive: ${snapshot.verificationState.inconclusiveAliases.join(", ")}` : "",
		snapshot.verificationState?.requestedAliases?.length ? `- requested: ${snapshot.verificationState.requestedAliases.join(", ")}` : "",
		communications.length ? "" : "",
		primaryInbox.length ? "## Primary inbox" : "",
		primaryInbox.length
			? primaryInbox.slice(0, 12).map((item: any) => `- ${item.timestamp || "?"} [${item.kind || "report"}/${item.status || "active"}] ${item.team || item.alias || "run"}: ${summarize(item.summary || item.text || item.detail || "", 180)}`).join("\n")
			: "",
		communications.length ? "" : "",
		communications.length ? "## Communication pathways" : "",
		communications.length
			? communications.slice(0, 12).map((item: any) => `- [${item.kind || "signal"}] ${item.team || item.alias || "run"}: ${summarize(item.text || item.detail || "", 160)}`).join("\n")
			: "",
		dependencies.length ? "" : "",
		dependencies.length ? "## Dependency graph" : "",
		dependencies.length ? dependencies.slice(0, 12).map((edge: any) => formatDependencyLine(edge)).join("\n") : "",
		events.length ? "" : "",
		events.length ? "## Live activity feed" : "",
		events.length ? events.slice(0, 16).map((event: any) => formatEventLine(event)).join("\n") : "",
	].filter(Boolean).join("\n");
}

export function renderOrchestratorDoctor(report: any) {
	return [
		"# cmux orchestrator doctor",
		"",
		`- runs: ${report.runCount}`,
		`- teams: ${report.teamCount}`,
		`- agents: ${report.agentCount}`,
		`- live surfaces: ${report.liveSurfaceCount}`,
		`- bridge sessions: ${report.bridgeSessionCount ?? 0}`,
		`- session: ${report.fingerprint?.sessionId || "unknown"}`,
		"",
		"## Findings",
		`- offline agents: ${report.offlineAgents.length}`,
		`- orphan agents: ${report.orphanAgents.length}`,
		`- agents without bridge: ${report.agentsWithoutBridge?.length || 0}`,
		`- agents with stale bridge: ${report.agentsWithStaleBridge?.length || 0}`,
		`- stale bridge sessions: ${report.staleBridgeSessions?.length || 0}`,
		`- offline teams: ${report.offlineTeams.length}`,
		`- degraded teams: ${report.degradedTeams.length}`,
		`- session mismatches: ${report.sessionMismatches.length}`,
		`- runs with missing teams: ${report.runsWithMissingTeams.length}`,
		`- structured findings: ${report.findings?.length || 0}`,
		report.findingSummary ? `- critical/high findings: ${(report.findingSummary.critical || 0) + (report.findingSummary.high || 0)}` : "",
		report.findings?.length ? "" : "",
		report.findings?.length ? "## Structured findings" : "",
		report.findings?.length ? report.findings.slice(0, 16).map((finding: any) => `- [${finding.severity}] ${finding.kind} ${finding.scope}${finding.runId ? ` run=${finding.runId}` : ""}${finding.team ? ` team=${finding.team}` : ""}${finding.alias ? ` alias=${finding.alias}` : ""} — ${summarize(finding.summary, 180)}`).join("\n") : "",
		report.repairSummary ? "" : "",
		report.repairSummary ? "## Repair plan" : "",
		report.repairSummary ? `- actions: ${report.repairSummary.total || 0}` : "",
		report.repairSummary ? `- safe auto-executable: ${report.repairSummary.safeAutoExecutable || 0}` : "",
		report.repairSummary ? `- manual only: ${report.repairSummary.manualOnly || 0}` : "",
		report.repairActions?.length ? report.repairActions.slice(0, 16).map((action: any) => `- [${action.priority || "p3"}] ${action.action}${action.safeAutoExecute ? " auto" : " manual"}${action.runId ? ` run=${action.runId}` : ""}${action.team ? ` team=${action.team}` : ""}${action.alias ? ` alias=${action.alias}` : ""} — ${summarize(action.reason || "", 180)}`).join("\n") : "",
		report.executionSummary ? "" : "",
		report.executionSummary ? "## Repair execution" : "",
		report.executionSummary ? `- executed: ${report.executionSummary.executed || 0}` : "",
		report.executionSummary ? `- failed: ${report.executionSummary.failed || 0}` : "",
		report.executionSummary ? `- skipped: ${report.executionSummary.skipped || 0}` : "",
		report.repairEffectiveness ? `- findings delta: ${report.repairEffectiveness.beforeFindings} -> ${report.repairEffectiveness.afterFindings}` : "",
		report.repairEffectiveness ? `- improved: ${report.repairEffectiveness.improved ? "yes" : "no"}` : "",
		report.executionResults?.length ? report.executionResults.slice(0, 16).map((item: any) => `- [${item.status || "unknown"}] ${item.action}${item.runId ? ` run=${item.runId}` : ""}${item.team ? ` team=${item.team}` : ""}${item.alias ? ` alias=${item.alias}` : ""} — ${summarize(item.note || "", 180)}`).join("\n") : "",
		report.offlineTeams.length ? "" : "",
		report.offlineTeams.length ? "## Offline teams" : "",
		report.offlineTeams.length ? report.offlineTeams.map((item: any) => `- ${item.team}: members=${item.members}`).join("\n") : "",
		report.agentsWithoutBridge?.length ? "" : "",
		report.agentsWithoutBridge?.length ? "## Agents without bridge" : "",
		report.agentsWithoutBridge?.length ? report.agentsWithoutBridge.map((item: any) => `- ${item.alias}${item.team ? ` team=${item.team}` : ""}`).join("\n") : "",
		report.agentsWithStaleBridge?.length ? "" : "",
		report.agentsWithStaleBridge?.length ? "## Agents with stale bridge" : "",
		report.agentsWithStaleBridge?.length ? report.agentsWithStaleBridge.map((item: any) => `- ${item.alias}${item.team ? ` team=${item.team}` : ""} lastEvent=${item.lastEventType || "—"} at=${item.lastEventAt || "—"}`).join("\n") : "",
		report.degradedTeams.length ? "" : "",
		report.degradedTeams.length ? "## Degraded teams" : "",
		report.degradedTeams.length ? report.degradedTeams.map((item: any) => `- ${item.team}: live=${item.liveCount}/${item.members}`).join("\n") : "",
		report.sessionMismatches.length ? "" : "",
		report.sessionMismatches.length ? "## Session mismatches" : "",
		report.sessionMismatches.length ? report.sessionMismatches.map((item: any) => `- ${item.team}`).join("\n") : "",
	].filter(Boolean).join("\n");
}
