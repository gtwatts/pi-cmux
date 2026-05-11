import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeRoot } from "./cmux-pi-bridge-shared.ts";
import { deriveBridgeStateFromEvents, summarizeRunBridgeState, type BridgeDerivedAgentState } from "./cmux-orchestrator-storage.ts";

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function readJsonlTail(path: string, limit = 200) {
	try {
		const text = readFileSync(path, "utf-8");
		return text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(1000, Number(limit || 200))))
			.map((line) => parseJson(line))
			.filter(Boolean);
	} catch {
		return [] as any[];
	}
}

export interface BridgeDerivedRunState {
	browserLockCount?: number;
	browserRecoveryCount?: number;
	browserCheckpointCount?: number;
	patternAnalysisCount?: number;
	patternCacheHitCount?: number;
	latestBridgeEventType?: string | null;
	latestBridgeEventAt?: string | null;
	latestPatternTool?: string | null;
	latestPatternStatus?: string | null;
}

function countType(events: any[], type: string) {
	return events.filter((e) => e?.type === type || e?.event_type === type).length;
}

/**
 * Read bridge events for a run and derive agent/run browser + pattern state.
 *
 * @param runId  The run_id to filter by
 * @param opts   Options: bridgeRoot override, eventTailLimit
 * @returns      Map of agent_alias -> derived state, plus run-level aggregates
 */
export function ingestBridgeEventsIntoOrchestrator(
	runId: string,
	opts: { root?: string; eventTailLimit?: number } = {},
): {
	agents: Map<string, BridgeDerivedAgentState>;
	run: BridgeDerivedRunState;
	eventsRead: number;
	sessionsScanned: number;
} {
	const root = opts.root || bridgeRoot();
	const limit = opts.eventTailLimit ?? 500;
	const agents = new Map<string, BridgeDerivedAgentState>();
	const run: BridgeDerivedRunState = {
		browserLockCount: 0,
		browserRecoveryCount: 0,
		browserCheckpointCount: 0,
		patternAnalysisCount: 0,
		patternCacheHitCount: 0,
	};
	let eventsRead = 0;
	let sessionsScanned = 0;

	// Discover sessions that mention this runId from bridge index
	const indexPath = join(root, "index.json");
	let index: any = null;
	try {
		index = parseJson(readFileSync(indexPath, "utf-8"));
	} catch {
		return { agents, run, eventsRead: 0, sessionsScanned: 0 };
	}

	const sessions = (index?.sessions || []).filter((s: any) => s?.runId === runId || s?.run_id === runId);

	for (const session of sessions) {
		if (!session?.eventsPath) continue;
		sessionsScanned++;
		const events = readJsonlTail(session.eventsPath, limit);
		eventsRead += events.length;

		const alias = session?.agentAlias || session?.agent_alias || null;
		if (!alias) continue;

		const existingState = agents.get(alias) || {};
		const derived = deriveBridgeStateFromEvents(events);
		agents.set(alias, {
			...existingState,
			...derived,
			browserSurface: derived.browserSurface || session.surfaceId || session.surface_id || existingState.browserSurface || null,
			browserLockOwner: derived.browserLockOwner || existingState.browserLockOwner || null,
			browserLockTeam: derived.browserLockTeam || existingState.browserLockTeam || null,
		});

		// Run aggregates
		run.browserLockCount = (run.browserLockCount || 0) + countType(events, "browser_lock_acquired");
		run.browserRecoveryCount = (run.browserRecoveryCount || 0) + countType(events, "browser_recovery_started");
		run.browserCheckpointCount = (run.browserCheckpointCount || 0) + countType(events, "browser_checkpoint_saved");
		run.patternAnalysisCount = (run.patternAnalysisCount || 0) + countType(events, "pattern_analysis_started");
		run.patternCacheHitCount = (run.patternCacheHitCount || 0) + countType(events, "pattern_analysis_cache_hit");
	}

	const runSummary = summarizeRunBridgeState(Array.from(agents.values()));
	return { agents, run: { ...run, ...runSummary }, eventsRead, sessionsScanned };
}
