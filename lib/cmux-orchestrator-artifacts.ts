import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson, safeFileSegment } from "./cmux-orchestrator-storage.ts";
import type { RunScorecardReport } from "./cmux-orchestrator-scorecard.ts";
import type { BenchmarkRunReport } from "./cmux-orchestrator-benchmark.ts";
import type { OutcomeExecutionContract, OutcomeExecutionPlan } from "./cmux-orchestrator-outcome-mode.ts";

function ensureDir(path: string) {
	mkdirSync(path, { recursive: true });
	return path;
}

function writeMarkdown(path: string, content: string) {
	ensureDir(dirname(path));
	writeFileSync(path, content, "utf-8");
}

export function writeRunEvaluationArtifacts(options: {
	baseDir: string;
	runId: string;
	scorecard: RunScorecardReport;
	scorecardMarkdown: string;
	failureMarkdown: string;
}) {
	const root = ensureDir(join(options.baseDir, "artifacts", "runs", safeFileSegment(options.runId, "run")));
	const scorecardJsonPath = join(root, "scorecard.json");
	const scorecardMarkdownPath = join(root, "scorecard.md");
	const failureMarkdownPath = join(root, "failure-report.md");
	const roundAnalysisJsonPath = join(root, "round-analysis.json");
	atomicWriteJson(scorecardJsonPath, options.scorecard);
	atomicWriteJson(roundAnalysisJsonPath, { runId: options.runId, rounds: options.scorecard.rounds, finalDecision: options.scorecard.finalDecision, failures: options.scorecard.failures });
	writeMarkdown(scorecardMarkdownPath, options.scorecardMarkdown);
	writeMarkdown(failureMarkdownPath, options.failureMarkdown);
	return {
		root,
		scorecardJsonPath,
		scorecardMarkdownPath,
		failureMarkdownPath,
		roundAnalysisJsonPath,
		artifactPaths: [scorecardJsonPath, scorecardMarkdownPath, failureMarkdownPath, roundAnalysisJsonPath],
	};
}

export function writeBenchmarkArtifacts(options: {
	baseDir: string;
	report: BenchmarkRunReport;
	benchmarkMarkdown: string;
}) {
	const scenarioName = options.report.scenario?.name || "benchmark";
	const root = ensureDir(join(options.baseDir, "artifacts", "benchmarks", safeFileSegment(scenarioName, "benchmark")));
	const benchmarkReportPath = join(root, "benchmark-report.md");
	const scorecardJsonPath = join(root, "scorecard.json");
	const roundAnalysisJsonPath = join(root, "round-analysis.json");
	writeMarkdown(benchmarkReportPath, options.benchmarkMarkdown);
	atomicWriteJson(scorecardJsonPath, { scenario: options.report.scenario, scorecard: options.report.scorecard, failures: options.report.failures, finalDecision: options.report.finalDecision, passed: options.report.passed });
	atomicWriteJson(roundAnalysisJsonPath, { scenario: options.report.scenario?.name || null, rounds: options.report.rounds, finalDecision: options.report.finalDecision });
	return {
		root,
		benchmarkReportPath,
		scorecardJsonPath,
		roundAnalysisJsonPath,
		artifactPaths: [benchmarkReportPath, scorecardJsonPath, roundAnalysisJsonPath],
	};
}

export function writeOutcomeExecutionArtifacts(options: {
	baseDir: string;
	scope: "runs" | "plans";
	id: string;
	contract: OutcomeExecutionContract;
	plan: OutcomeExecutionPlan;
	contractMarkdown: string;
	planMarkdown: string;
}) {
	const root = ensureDir(join(options.baseDir, "artifacts", options.scope, safeFileSegment(options.id, options.scope === "runs" ? "run" : "plan")));
	const contractJsonPath = join(root, "outcome-contract.json");
	const contractMarkdownPath = join(root, "outcome-contract.md");
	const executionPlanJsonPath = join(root, "execution-plan.json");
	const executionPlanMarkdownPath = join(root, "execution-plan.md");
	atomicWriteJson(contractJsonPath, options.contract);
	atomicWriteJson(executionPlanJsonPath, options.plan);
	writeMarkdown(contractMarkdownPath, options.contractMarkdown);
	writeMarkdown(executionPlanMarkdownPath, options.planMarkdown);
	return {
		root,
		contractJsonPath,
		contractMarkdownPath,
		executionPlanJsonPath,
		executionPlanMarkdownPath,
		artifactPaths: [contractJsonPath, contractMarkdownPath, executionPlanJsonPath, executionPlanMarkdownPath],
	};
}
