export type ModelStrategy = "role_specialized" | "round_robin" | "homogeneous";

export type RoleModelMapEntry = { role: string; model?: string; provider?: string };

function normalizeRole(role?: string | null) {
	const raw = String(role || "agent")
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-")
		.replace(/-\d+$/, "");
	return canonicalRole(raw);
}

function canonicalRole(role: string) {
	const normalized = String(role || "agent").trim().toLowerCase();
	if (["design", "designer", "ui", "ux", "ui-designer", "ux-designer", "visual", "visual-designer", "frontend-design"].includes(normalized)) return "designer";
	if (["front-end", "frontend", "frontender", "react", "next", "nextjs", "tailwind", "css"].includes(normalized)) return "frontend";
	if (["lead", "team-lead", "orchestrator", "captain"].includes(normalized)) return "lead";
	if (["manager", "pm", "project-manager"].includes(normalized)) return "manager";
	if (["coord", "coordinator", "dispatcher"].includes(normalized)) return "coordinator";
	if (["dev", "developer", "engineer", "implementation", "implementer"].includes(normalized)) return "coder";
	if (["qa", "quality", "quality-assurance"].includes(normalized)) return "tester";
	if (["research", "online-research", "web-research", "researcher-online"].includes(normalized)) return "researcher";
	if (["architect", "architecture"].includes(normalized)) return "architect";
	if (["intelligence", "intel", "reasoner", "strategist", "strategy"].includes(normalized)) return "analyst";
	if (["browser", "web", "driver", "operator"].includes(normalized)) return "navigator";
	return normalized;
}

function uniqueStrings(values: any[] = []) {
	return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

export function inferProviderForModel(model?: string | null) {
	const value = String(model || "").trim();
	if (!value) return undefined;
	const lowered = value.toLowerCase();
	const providerPrefix = lowered.match(/^([a-z0-9_.-]+)\//)?.[1];
	if (providerPrefix) {
		if (/^(kimi|moonshot|kimi-coding)$/.test(providerPrefix)) return "kimi-coding";
		if (/^(zai|glm|zhipu|zhipuai)$/.test(providerPrefix)) return "zai";
		if (/^(deepseek)$/.test(providerPrefix)) return "deepseek";
		if (/^(anthropic|claude)$/.test(providerPrefix)) return "anthropic";
		if (/^(xai|grok)$/.test(providerPrefix)) return "xai";
		if (/^(openai-codex|codex)$/.test(providerPrefix)) return "openai-codex";
		if (/^(openai)$/.test(providerPrefix)) return "openai";
		return providerPrefix;
	}
	if (/^(deepseek|ds-|r1|v3|v4)/.test(lowered) || lowered.includes("deepseek")) return "deepseek";
	if (/^(k2p6|kimi|moonshot)/.test(lowered) || lowered.includes("k2.6") || lowered.includes("k2p6")) return "kimi-coding";
	if (/^(glm|zai)/.test(lowered)) return "zai";
	if (/^(claude|sonnet|opus|haiku)/.test(lowered)) return "anthropic";
	if (/^(grok|xai)/.test(lowered)) return "xai";
	if (/^(gpt|o\d|codex)/.test(lowered) || lowered.includes("gpt-")) return undefined;
	return undefined;
}

function providerFor(model: string | null | undefined, explicitProvider: string | null | undefined, fallbackProvider: string | null | undefined) {
	return String(explicitProvider || "").trim() || inferProviderForModel(model) || String(fallbackProvider || "").trim() || undefined;
}

function modelTierForRole(role?: string | null, taskText?: string | null) {
	const normalized = normalizeRole(role);
	const text = String(taskText || "").toLowerCase();
	const researchHeavy = /(research|investigate|compare|explore|unknown)/.test(text);
	const browserHeavy = /(browser|web|website|page|navigate|extract)/.test(text);

	if (["lead", "planner", "reviewer", "debugger", "integrator", "analyst", "architect", "designer", "frontend"].includes(normalized)) return 0;
	if (["manager", "coordinator"].includes(normalized)) return 1;
	if (researchHeavy && ["researcher", "analyst"].includes(normalized)) return 0;
	if (browserHeavy && ["navigator", "verifier", "observer", "extractor"].includes(normalized)) return 0;
	if (["researcher", "navigator", "verifier", "observer", "extractor", "tester", "qa", "docs"].includes(normalized)) return 1;
	if (/^agent(?:-|$)/.test(normalized)) return 2;
	return 1;
}

function modelRoleAffinity(provider: string | undefined, model: string, role?: string | null, taskText?: string | null) {
	const normalized = normalizeRole(role);
	const text = String(taskText || "").toLowerCase();
	const p = String(provider || inferProviderForModel(model) || "").toLowerCase();
	const m = String(model || "").toLowerCase();
	let score = 0;
	if (["lead", "manager", "coordinator", "planner", "reviewer", "architect"].includes(normalized)) {
		if (p === "openai-codex" || (p === "openai" && m.includes("gpt-5"))) score += 5;
		if (p === "deepseek" || m.includes("deepseek")) score += 3;
	}
	if (["designer", "frontend"].includes(normalized)) {
		if (p === "openai-codex" || p === "openai") score += 4;
		if (p === "zai" || m.startsWith("glm")) score += 4;
		if (p === "anthropic") score += 3;
	}
	if (["coder", "integrator", "tester", "docs"].includes(normalized)) {
		if (p === "kimi-coding" || m.includes("kimi") || m.includes("k2")) score += 5;
		if (p === "openai-codex") score += 4;
	}
	if (["researcher", "analyst", "debugger"].includes(normalized) || /(research|intelligence|analysis|debug|root cause)/.test(text)) {
		if (p === "deepseek" || m.includes("deepseek")) score += 5;
		if (p === "kimi-coding" && normalized === "researcher") score += 3;
		if (p === "openai-codex") score += 3;
	}
	if (["navigator", "observer", "extractor", "verifier"].includes(normalized) || /(browser|web|website|dom|extract|navigate)/.test(text)) {
		if (p === "zai" || m.startsWith("glm")) score += 5;
		if (p === "openai-codex") score += 3;
	}
	return score;
}

function selectModelFromPool(modelPool: string[], index: number, strategy: ModelStrategy, role?: string | null, taskText?: string | null) {
	if (!modelPool.length) return null;
	if (strategy === "homogeneous") return modelPool[0];
	if (strategy === "round_robin") return modelPool[index % modelPool.length];
	const scored = modelPool.map((model, poolIndex) => ({
		model,
		poolIndex,
		score: modelRoleAffinity(inferProviderForModel(model), model, role, taskText),
	}));
	scored.sort((a, b) => b.score - a.score || a.poolIndex - b.poolIndex);
	if (scored[0]?.score > 0) return scored[0].model;
	const tier = modelTierForRole(role, taskText);
	return modelPool[Math.min(tier, modelPool.length - 1)] || modelPool[0];
}

function roleMapLookup(entries: any[] = [], role?: string | null) {
	const normalized = normalizeRole(role);
	const exact = (entries || []).find((entry: any) => normalizeRole(entry?.role) === normalized);
	if (exact) return exact;
	return (entries || []).find((entry: any) => ["*", "default", "any"].includes(String(entry?.role || "").trim().toLowerCase())) || null;
}

export function assignModelsToMemberSpecs(
	specs: any[],
	options: {
		provider?: string | null;
		model?: string | null;
		models?: string[];
		roleModelMap?: RoleModelMapEntry[];
		modelStrategy?: ModelStrategy;
		taskText?: string | null;
	},
) {
	const strategy: ModelStrategy = (options.modelStrategy as ModelStrategy) || "role_specialized";
	const modelPool = uniqueStrings(options.models || []);
	const roleModelMap = Array.isArray(options.roleModelMap) ? options.roleModelMap : [];
	const fallbackModel = String(options.model || "").trim() || null;
	const fallbackProvider = String(options.provider || "").trim() || null;

	return (specs || []).map((spec: any, index: number) => {
		if (spec?.model || spec?.provider) {
			return {
				...spec,
				provider: providerFor(spec.model, spec.provider, fallbackProvider),
			};
		}

		const mapped = roleMapLookup(roleModelMap, spec?.role || spec?.alias);
		if (mapped?.model || mapped?.provider) {
			const selectedModel = mapped.model || fallbackModel || undefined;
			return {
				...spec,
				model: selectedModel,
				provider: providerFor(selectedModel, mapped.provider, fallbackProvider),
			};
		}

		if (!modelPool.length) {
			return {
				...spec,
				model: fallbackModel || undefined,
				provider: providerFor(fallbackModel, null, fallbackProvider),
			};
		}

		const selectedModel = selectModelFromPool(modelPool, index, strategy, spec?.role || spec?.alias, options.taskText) || fallbackModel || undefined;

		return {
			...spec,
			model: selectedModel,
			provider: providerFor(selectedModel, null, fallbackProvider),
		};
	});
}
