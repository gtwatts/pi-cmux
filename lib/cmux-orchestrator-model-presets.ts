import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function readJsonFile(path: string) {
	if (!path || !existsSync(path)) return null;
	return parseJson(readFileSync(path, "utf-8"));
}

export function defaultModelPresetPaths(options: { cwd?: string | null; baseDir?: string | null; presetFile?: string | null } = {}) {
	const paths: string[] = [];
	if (options.baseDir) paths.push(join(options.baseDir, "model-presets.json"));
	if (options.cwd) paths.push(join(options.cwd, "cmux-orchestrator-model-presets.json"));
	if (options.presetFile) paths.push(options.presetFile);
	return Array.from(new Set(paths.filter(Boolean)));
}

export function loadModelPresetRegistry(options: { cwd?: string | null; baseDir?: string | null; presetFile?: string | null } = {}) {
	const paths = defaultModelPresetPaths(options);
	const loaded = [] as Array<{ path: string; data: any }>;
	for (const path of paths) {
		const data = readJsonFile(path);
		if (data && typeof data === "object") loaded.push({ path, data });
	}
	const presets: Record<string, any> = {};
	let defaultPreset = null as string | null;
	for (const entry of loaded) {
		if (entry.data?.defaultPreset) defaultPreset = String(entry.data.defaultPreset);
		if (entry.data?.presets && typeof entry.data.presets === "object") {
			for (const [name, preset] of Object.entries(entry.data.presets || {})) {
				presets[name] = { ...(presets[name] || {}), ...(preset as any), name, sourcePath: entry.path };
			}
		}
	}
	return {
		paths,
		loadedPaths: loaded.map((entry) => entry.path),
		defaultPreset,
		presets,
	};
}

export function resolveModelPreset(name: string | null | undefined, registry: { presets?: Record<string, any>; defaultPreset?: string | null }) {
	const selected = String(name || registry?.defaultPreset || "").trim();
	if (!selected) return null;
	return registry?.presets?.[selected] || null;
}

function normalizeText(value: unknown) {
	return String(value || " ")
		.toLowerCase()
		.replace(/[^a-z0-9+.#/-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenize(value: unknown) {
	return normalizeText(value)
		.split(" ")
		.map((token) => token.trim())
		.filter(Boolean);
}

function unique(items: string[] = []) {
	return Array.from(new Set(items.filter(Boolean)));
}

function detectRequestIntents(params: any) {
	const text = normalizeText([
		params?.task,
		params?.goal,
		params?.description,
		params?.extraGuidance,
		(params?.roles || []).join(" "),
		(params?.specs || []).map((spec: any) => `${spec?.role || ""} ${spec?.alias || ""} ${spec?.prompt || ""}`).join(" "),
	].join(" "));
	const intents = new Set<string>();
	const pushIf = (intent: string, terms: string[]) => {
		if (terms.some((term) => text.includes(term))) intents.add(intent);
	};
	pushIf("frontend", ["frontend", "ui", "ux", "design system", "tailwind", "css", "html", "react", "next.js", "nextjs", "component", "responsive", "landing page"]);
	pushIf("browser", ["browser", "playwright", "website", "web app", "navigation", "click", "form", "dom", "screenshot"]);
	pushIf("coding", ["implement", "code", "coding", "refactor", "fix", "bug", "test", "typescript", "javascript", "python", "api", "backend", "integration"]);
	pushIf("strategic", ["plan", "strategy", "review", "audit", "architecture", "design review", "approach", "spec", "triage", "debug"]);
	pushIf("research", ["research", "investigate", "compare", "analyze", "analysis", "explore", "survey"]);
	pushIf("media", ["video", "audio", "transcribe", "transcription", "youtube", "whisper", "ffmpeg", "yt-dlp"]);
	pushIf("data", ["sql", "query", "dashboard", "analytics", "dataset", "csv", "table", "reporting"]);
	return {
		text,
		tokens: unique(tokenize(text)),
		roles: unique((params?.roles || []).map((role: any) => normalizeText(role)).filter(Boolean).concat((params?.specs || []).map((spec: any) => normalizeText(spec?.role || spec?.alias)).filter(Boolean))),
		intents: Array.from(intents),
	};
}

function scorePresetAgainstRequest(preset: any, request: { text: string; tokens: string[]; roles: string[]; intents: string[] }) {
	const reasons: string[] = [];
	let score = Number(preset?.priority || 0);
	const match = preset?.match || {};
	const presetIntents = unique([...(preset?.intents || []), ...(match?.intents || [])].map((value) => normalizeText(value)).filter(Boolean));
	const keywordsAny = unique((match?.keywordsAny || preset?.keywords || []).map((value: any) => normalizeText(value)).filter(Boolean));
	const keywordsAll = unique((match?.keywordsAll || []).map((value: any) => normalizeText(value)).filter(Boolean));
	const antiKeywords = unique((match?.antiKeywords || []).map((value: any) => normalizeText(value)).filter(Boolean));
	const presetRoles = unique([...(preset?.roles || []), ...(match?.roles || [])].map((value) => normalizeText(value)).filter(Boolean));

	for (const intent of presetIntents) {
		if (request.intents.includes(intent)) {
			score += 4;
			reasons.push(`intent:${intent}`);
		}
	}
	for (const keyword of keywordsAny) {
		if (request.text.includes(keyword)) {
			score += keyword.includes(" ") ? 3 : 2;
			reasons.push(`keyword:${keyword}`);
		}
	}
	if (keywordsAll.length && keywordsAll.every((keyword) => request.text.includes(keyword))) {
		score += 4;
		reasons.push(`all:${keywordsAll.join("+")}`);
	}
	for (const antiKeyword of antiKeywords) {
		if (request.text.includes(antiKeyword)) {
			score -= antiKeyword.includes(" ") ? 4 : 2;
			reasons.push(`avoid:${antiKeyword}`);
		}
	}
	for (const role of presetRoles) {
		if (request.roles.includes(role)) {
			score += 3;
			reasons.push(`role:${role}`);
		}
	}
	return { score, reasons };
}

export function recommendModelPreset(params: any, registry: { presets?: Record<string, any>; defaultPreset?: string | null }) {
	const request = detectRequestIntents(params);
	const candidates = Object.entries(registry?.presets || {}).map(([name, preset]) => {
		const scored = scorePresetAgainstRequest(preset, request);
		return {
			name,
			preset,
			...scored,
		};
	});
	candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const best = candidates[0] || null;
	const fallbackName = registry?.defaultPreset || null;
	if (best && best.score > 0) {
		return {
			name: best.name,
			preset: best.preset,
			source: "inferred",
			reasons: best.reasons,
			request,
			candidates,
		};
	}
	const fallbackPreset = fallbackName ? registry?.presets?.[fallbackName] || null : null;
	return {
		name: fallbackName,
		preset: fallbackPreset,
		source: fallbackPreset ? "default" : "none",
		reasons: fallbackPreset ? ["defaultPreset"] : [],
		request,
		candidates,
	};
}

export function applyModelPreset(params: any, preset: any) {
	if (!preset) return { ...params, appliedModelPreset: null };
	return {
		...params,
		provider: params.provider ?? preset.provider,
		model: params.model ?? preset.model,
		models: Array.isArray(params.models) && params.models.length ? params.models : Array.isArray(preset.models) ? preset.models : params.models,
		modelStrategy: params.modelStrategy ?? preset.modelStrategy,
		roleModelMap: Array.isArray(params.roleModelMap) && params.roleModelMap.length ? params.roleModelMap : Array.isArray(preset.roleModelMap) ? preset.roleModelMap : params.roleModelMap,
		thinking: params.thinking ?? preset.thinking,
		appliedModelPreset: preset.name || null,
	};
}
