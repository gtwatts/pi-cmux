import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { inferProviderForModel } from "./cmux-orchestrator-models.ts";

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function defaultAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function defaultSettingsPath() {
	return join(defaultAgentDir(), "settings.json");
}

function readDefaultLaunchSelection() {
	const file = defaultSettingsPath();
	if (!existsSync(file)) return { provider: undefined, model: undefined };
	const settings = parseJson(readFileSync(file, "utf-8"));
	if (!settings || typeof settings !== "object") return { provider: undefined, model: undefined };
	return {
		provider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
		model: typeof settings.defaultModelId === "string"
			? settings.defaultModelId
			: typeof settings.defaultModel === "string"
				? settings.defaultModel
				: undefined,
	};
}

function normalizeProvider(value?: string) {
	const provider = String(value || "").trim();
	if (!provider) return undefined;
	if (/^(glm|zhipu|zhipuai)$/i.test(provider)) return "zai";
	return provider;
}

function normalizeModel(value?: string) {
	const model = String(value || "").trim();
	if (!model) return undefined;
	if (/^glm-/i.test(model)) return model.toLowerCase();
	return model;
}

function resolveLaunchSelection(options: { provider?: string; model?: string }) {
	const explicitProvider = normalizeProvider(options.provider);
	const explicitModel = normalizeModel(options.model);
	if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel };
	if (!explicitProvider && explicitModel && explicitModel.includes("/")) {
		return { provider: undefined, model: explicitModel };
	}
	const defaultsRaw = readDefaultLaunchSelection();
	const defaults = { provider: normalizeProvider(defaultsRaw.provider), model: normalizeModel(defaultsRaw.model) };
	const inferredProvider = explicitModel ? normalizeProvider(inferProviderForModel(explicitModel)) : undefined;
	const provider = explicitProvider || inferredProvider || defaults.provider;
	const model = explicitModel || defaults.model;
	if (!explicitProvider && explicitModel) {
		return { provider, model: explicitModel };
	}
	if (explicitProvider && !explicitModel) {
		return { provider: explicitProvider, model: defaults.provider === explicitProvider ? defaults.model : undefined };
	}
	return { provider, model };
}

export function shQ(value: string) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function shellJoin(args: string[]) {
	return args.map((arg) => shQ(arg)).join(" ");
}

function pushEnvVar(target: string[], key: string, value: string | null | undefined) {
	if (value === null || value === undefined || value === "") return;
	target.push(`${key}=${String(value)}`);
}

export function buildPiLaunchCommand(options: {
	alias: string;
	cwd?: string;
	prompt?: string;
	promptFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	tools?: string;
	noExtensions?: boolean;
	noSkills?: boolean;
	sessionPath?: string;
	extraArgs?: string[];
	muteAgentNotifications?: boolean;
	appendCmuxFlag?: boolean;
	cmuxEnabled?: boolean;
	interfaceMode?: string;
	taskId?: string;
	runId?: string;
	teamId?: string;
	agentId?: string;
	agentAlias?: string;
	role?: string;
	launcher?: string;
	launchMode?: string;
	env?: Record<string, string | null | undefined>;
}) {
	const cmdParts: string[] = [];
	if (options.cwd) {
		cmdParts.push(`cd ${shQ(options.cwd)}`);
	}

	const selection = resolveLaunchSelection({ provider: options.provider, model: options.model });
	const launchArgs = ["env"];
	if (options.muteAgentNotifications !== false) launchArgs.push("PI_NOTIFY_DISABLE=1");
	if (options.cmuxEnabled !== false) {
		launchArgs.push("PI_CMUX=1", "PI_CMUX_ENABLED=1");
	}
	pushEnvVar(launchArgs, "PI_INTERFACE", options.interfaceMode);
	pushEnvVar(launchArgs, "PI_CMUX_INTERFACE", options.interfaceMode);
	pushEnvVar(launchArgs, "KB_TASK_ID", options.taskId);
	pushEnvVar(launchArgs, "CMUX_KB_TASK_ID", options.taskId);
	pushEnvVar(launchArgs, "PI_TASK_ID", options.taskId);
	pushEnvVar(launchArgs, "PI_CMUX_RUN_ID", options.runId);
	pushEnvVar(launchArgs, "CMUX_RUN_ID", options.runId);
	pushEnvVar(launchArgs, "PI_CMUX_TEAM_ID", options.teamId);
	pushEnvVar(launchArgs, "CMUX_TEAM_ID", options.teamId);
	pushEnvVar(launchArgs, "PI_CMUX_AGENT_ID", options.agentId);
	pushEnvVar(launchArgs, "CMUX_AGENT_ID", options.agentId);
	pushEnvVar(launchArgs, "PI_CMUX_AGENT_ALIAS", options.agentAlias);
	pushEnvVar(launchArgs, "CMUX_AGENT_ALIAS", options.agentAlias);
	pushEnvVar(launchArgs, "PI_CMUX_ROLE", options.role);
	pushEnvVar(launchArgs, "PI_CMUX_LAUNCHER", options.launcher);
	pushEnvVar(launchArgs, "PI_CMUX_LAUNCH_MODE", options.launchMode);
	for (const [key, value] of Object.entries(options.env || {})) pushEnvVar(launchArgs, key, value);
	launchArgs.push("pi");
	if (options.appendCmuxFlag) launchArgs.push("--cmux");
	if (selection.provider) launchArgs.push("--provider", selection.provider);
	if (selection.model) launchArgs.push("--model", selection.model);
	if (options.thinking) launchArgs.push("--thinking", options.thinking);
	if (options.tools) launchArgs.push("--tools", options.tools);
	if (options.noExtensions) launchArgs.push("--no-extensions");
	if (options.noSkills) launchArgs.push("--no-skills");
	if (options.sessionPath) launchArgs.push("--session", options.sessionPath);
	if (Array.isArray(options.extraArgs)) launchArgs.push(...options.extraArgs.filter(Boolean));

	cmdParts.push(`echo ${shQ(`[cmux-orchestrator] launching ${options.alias}`)}`);
	const launchTokens = launchArgs.map((arg) => shQ(arg));
	if (options.promptFile) launchTokens.push(`"$(cat ${shQ(options.promptFile)})"`);
	else if (options.prompt) launchTokens.push(shQ(options.prompt));
	cmdParts.push(launchTokens.join(" "));
	return cmdParts.join(" && ");
}

export function normalizeTerminalMessage(message: string) {
	const lines = String(message || "")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim());
	const sections: string[] = [];
	let paragraph: string[] = [];
	for (const line of lines) {
		if (!line) {
			if (paragraph.length) {
				sections.push(paragraph.join(" | "));
				paragraph = [];
			}
			continue;
		}
		paragraph.push(line);
	}
	if (paragraph.length) sections.push(paragraph.join(" | "));
	return sections.join(" || ").trim();
}

export function splitTerminalDispatchPayload(message: string, maxLength = 6000) {
	const normalized = normalizeTerminalMessage(message);
	if (!normalized) return [""];
	if (normalized.length <= maxLength) return [normalized];

	const parts: string[] = [];
	let remaining = normalized;
	const minSplitPoint = Math.max(64, Math.floor(maxLength * 0.6));
	const separators = [" || ", " | ", " "];

	while (remaining.length > maxLength) {
		let splitAt = -1;
		for (const separator of separators) {
			const idx = remaining.lastIndexOf(separator, maxLength);
			if (idx >= minSplitPoint) {
				splitAt = idx + separator.length;
				break;
			}
		}
		if (splitAt === -1) splitAt = maxLength;
		parts.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) parts.push(remaining);
	return parts.filter(Boolean);
}

export function buildTerminalDispatchPayload(message: string, maxLength = 6000) {
	return splitTerminalDispatchPayload(message, maxLength).join(" ");
}
