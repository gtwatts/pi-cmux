/**
 * CMUX Design — Huashu-inspired design workflow tools for cmux/Pi.
 *
 * This extension does not vendor Huashu Design. It detects a local clone and
 * turns its repo knowledge into cmux-aware briefs, scaffolds, verification, and
 * export commands.
 */
// @ts-nocheck
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const PREAMBLE = `
# CMUX Design Extension

Use these tools when a user wants Claude-Design-like visual output inside the Pi/cmux tool line: high-fidelity HTML prototypes, visual variations, tweakable demos, slide decks, motion design, infographics, or design reviews.

## Operating model
- Start from design context. Look for brand guides, screenshots, existing UI, token files, code components, and references before inventing visuals.
- If facts matter for a current product/brand/version, verify first; do not rely on memory.
- If a branded task lacks assets, ask for or gather logo, product imagery/UI screenshots, colors, fonts, and guidelines; freeze findings into brand-spec.md.
- Prefer three differentiated directions or variations when the brief is vague. Use tweaks for parameterized choices: theme, accent, type scale, density, layout, and content modes.
- Treat HTML as the production medium for visual artifacts, but do not make every deliverable feel like a website. Slides should feel like slides; motion should feel cinematic; app prototypes should feel like apps.
- Verify with a rendered browser view before delivery. In cmux, prefer cmux browser surfaces for visual inspection, snapshots, checkpoints, and handoffs.
- Use cmux_pi_team for larger design jobs: strategist/researcher, visual designer, implementation/prototype builder, and reviewer/exporter are good role splits.
- For production web UI or tokenized app implementation, combine this extension with Frontend Design Studio and CSS audit tools.

## Huashu Design lessons distilled
- The repo demonstrates a skill-based alternative to GUI-only design tools: single prompt -> HTML prototype/deck/animation/exportable artifact.
- Its moat is process: fact verification, core asset protocol, junior-designer passes, design-direction fallback, variations, tweaks, and Playwright verification.
- Its tradeoff versus GUI design tools: fewer direct canvas comments/click-to-edit affordances, but much lower quota friction and better agent/workspace automation.

## Open Design lessons distilled
- Use explicit modes (prototype, deck, template, design-system) so workflows, exports, and acceptance criteria match the medium.
- Treat skills as file packages with metadata, side files, examples, preview type, inputs, outputs, and tweak parameters.
- Resolve DESIGN.md as authoritative context and keep it reviewable in git.
- Prefer deterministic direction cards with real palettes/font stacks over model-freestyle aesthetics.
- Persist artifacts with metadata, history, tweaks, and browser-preview checkpoints so design work can be resumed and reviewed.
`;

function ok(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true, ...details } };
}

function json(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function ensureParentDir(path: string) {
	mkdirSync(dirname(path), { recursive: true });
}

function safeSlug(value: string) {
	return String(value || "cmux-design")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "cmux-design";
}

function mask(text: string, max = 320) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function defaultRepoCandidates() {
	const home = homedir();
	return [
		process.env.HUASHU_DESIGN_ROOT,
		join(process.cwd(), "research", "cmux-design", "huashu-design"),
		join(home, ".pi", "agent", "research", "cmux-design", "huashu-design"),
		join(home, ".pi", "agent", "skills", "huashu-design"),
		join(home, ".claude", "skills", "huashu-design"),
		join(home, ".codex", "skills", "huashu-design"),
	].filter(Boolean) as string[];
}

function resolveRepoRoot(repoPath?: string) {
	const candidates = repoPath ? [repoPath] : defaultRepoCandidates();
	for (const candidate of candidates) {
		const absolute = resolve(String(candidate).replace(/^~/, homedir()));
		if (existsSync(join(absolute, "SKILL.md")) && existsSync(join(absolute, "references"))) return absolute;
	}
	return null;
}

function mustRepoRoot(repoPath?: string) {
	const root = resolveRepoRoot(repoPath);
	if (!root) {
		throw new Error("Huashu Design repo not found. Clone it, for example: git clone https://github.com/alchaincyf/huashu-design.git research/cmux-design/huashu-design, or set HUASHU_DESIGN_ROOT.");
	}
	return root;
}

function defaultOpenDesignCandidates() {
	const home = homedir();
	return [
		process.env.OPEN_DESIGN_ROOT,
		join(process.cwd(), "research", "cmux-design", "open-design"),
		join(home, ".pi", "agent", "research", "cmux-design", "open-design"),
		join(home, "open-design"),
	].filter(Boolean) as string[];
}

function resolveOpenDesignRoot(repoPath?: string) {
	const candidates = repoPath ? [repoPath] : defaultOpenDesignCandidates();
	for (const candidate of candidates) {
		const absolute = resolve(String(candidate).replace(/^~/, homedir()));
		if (existsSync(join(absolute, "package.json")) && existsSync(join(absolute, "design-systems")) && existsSync(join(absolute, "skills"))) return absolute;
	}
	return null;
}

function mustOpenDesignRoot(repoPath?: string) {
	const root = resolveOpenDesignRoot(repoPath);
	if (!root) {
		throw new Error("Open Design repo not found. Clone it, for example: git clone https://github.com/nexu-io/open-design.git research/cmux-design/open-design, or set OPEN_DESIGN_ROOT.");
	}
	return root;
}

function listFilesSafe(dir: string, predicate = (_name: string) => true) {
	try {
		return readdirSync(dir).filter(predicate).sort();
	} catch {
		return [];
	}
}

function commandVersion(cmd: string, args: string[] = ["--version"]) {
	const attempts = cmd === "ffmpeg" && args.length === 1 && args[0] === "--version"
		? [["-version"], ["--version"]]
		: [args];
	for (const attemptArgs of attempts) {
		try {
			const out = execFileSync(cmd, attemptArgs, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
			return mask(out.split("\n")[0], 160) || "installed";
		} catch {}
	}
	return null;
}

function commandPath(cmd: string) {
	try {
		return execFileSync("/bin/sh", ["-lc", `command -v ${cmd}`], { encoding: "utf-8", timeout: 5_000 }).trim() || null;
	} catch {
		return null;
	}
}

function pythonModuleStatus(moduleName: string) {
	try {
		execFileSync("python3", ["-c", `import ${moduleName}`], { encoding: "utf-8", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function nodeModuleStatus(moduleName: string) {
	try {
		execFileSync("/bin/sh", ["-lc", `NODE_PATH=$(npm root -g 2>/dev/null) node -e "require.resolve('${moduleName}')"`], { encoding: "utf-8", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function readText(path: string, maxChars = 8000) {
	const text = readFileSync(path, "utf-8");
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`;
}

function referenceSummaries(root: string) {
	const refDir = join(root, "references");
	return listFilesSafe(refDir, (name) => name.endsWith(".md")).map((file) => {
		const fullPath = join(refDir, file);
		const text = readFileSync(fullPath, "utf-8");
		const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || file.replace(/\.md$/, "");
		const firstParagraph = text
			.split(/\n\s*\n/)
			.map((part) => part.replace(/^#.+$/gm, "").trim())
			.find((part) => part && !part.startsWith("---")) || "";
		return { file, title, summary: mask(firstParagraph, 260), path: fullPath };
	});
}

function searchReferences(root: string, query?: string, limit = 8) {
	const refs = referenceSummaries(root);
	if (!query) return refs.slice(0, limit);
	const q = query.toLowerCase();
	return refs
		.map((ref) => {
			let score = 0;
			const hay = `${ref.file} ${ref.title} ${ref.summary}`.toLowerCase();
			for (const token of q.split(/\s+/).filter(Boolean)) if (hay.includes(token)) score += 2;
			try {
				const content = readFileSync(ref.path, "utf-8").toLowerCase();
				for (const token of q.split(/\s+/).filter(Boolean)) if (content.includes(token)) score += 1;
			} catch {}
			return { ...ref, score };
		})
		.filter((ref) => ref.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

function repoStats(root: string) {
	return {
		root,
		references: listFilesSafe(join(root, "references"), (name) => name.endsWith(".md")).length,
		assets: listFilesSafe(join(root, "assets")).length,
		scripts: listFilesSafe(join(root, "scripts")).length,
		demos: listFilesSafe(join(root, "demos"), (name) => /\.html$/.test(name)).length,
		hasSkill: existsSync(join(root, "SKILL.md")),
		hasReadmeEn: existsSync(join(root, "README.en.md")),
	};
}

function countFiles(root: string, parts: string[], predicate: (name: string) => boolean, depth = 2) {
	const base = join(root, ...parts);
	if (!existsSync(base)) return 0;
	try {
		const script = `find ${JSON.stringify(base)} -maxdepth ${Number(depth)} -type f | awk '{print}'`;
		const out = execFileSync("/bin/sh", ["-lc", script], { encoding: "utf-8", timeout: 8_000 });
		return out.split("\n").filter((line) => line && predicate(basename(line))).length;
	} catch {
		return 0;
	}
}

function openDesignStats(root: string) {
	let packageName = "unknown";
	try { packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).name || packageName; } catch {}
	return {
		root,
		packageName,
		designSystems: countFiles(root, ["design-systems"], (name) => name === "DESIGN.md", 2),
		skills: countFiles(root, ["skills"], (name) => name === "SKILL.md", 2),
		frames: listFilesSafe(join(root, "assets", "frames"), (name) => name.endsWith(".html")).length,
		promptTemplateImages: countFiles(root, ["assets", "prompt-templates"], (name) => /\.(png|jpe?g|webp|gif|mp4)$/i.test(name), 4),
		docs: listFilesSafe(join(root, "docs"), (name) => name.endsWith(".md")).length,
		hasDirections: existsSync(join(root, "apps", "daemon", "src", "prompts", "directions.ts")),
		hasDiscoveryPrompt: existsSync(join(root, "apps", "daemon", "src", "prompts", "discovery.ts")),
	};
}

function listOpenDesignSkillSummaries(root: string, limit = 20) {
	const skillsDir = join(root, "skills");
	return listFilesSafe(skillsDir).slice(0, Math.max(1, Math.min(200, limit))).map((name) => {
		const skillPath = join(skillsDir, name, "SKILL.md");
		let description = "";
		let mode = "prototype";
		try {
			const raw = readFileSync(skillPath, "utf-8");
			description = raw.match(/description:\s*["']?([^\n"']+)/)?.[1]?.trim() || mask(raw.replace(/^---[\s\S]*?---/, ""), 160);
			mode = raw.match(/mode:\s*([a-z-]+)/)?.[1]?.trim() || (/(deck|slide|ppt)/i.test(raw) ? "deck" : /template/i.test(raw) ? "template" : /design[- ]system|DESIGN\.md/i.test(raw) ? "design-system" : "prototype");
		} catch {}
		return { name, mode, description: mask(description, 180) };
	});
}

function listOpenDesignSystemSummaries(root: string, limit = 20) {
	const dir = join(root, "design-systems");
	return listFilesSafe(dir).slice(0, Math.max(1, Math.min(200, limit))).map((name) => {
		const designPath = join(dir, name, "DESIGN.md");
		let title = name;
		let summary = "";
		try {
			const raw = readFileSync(designPath, "utf-8");
			title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || name;
			summary = mask(raw.split(/\n\s*\n/).find((part) => part.trim() && !part.startsWith("#")) || "", 180);
		} catch {}
		return { name, title, summary };
	});
}

function renderStatus(root: string | null, validate: boolean) {
	const lines = ["# CMUX Design status", ""];
	if (root) {
		const stats = repoStats(root);
		lines.push("## Huashu Design repo", `- root: ${root}`, `- references: ${stats.references}`, `- assets: ${stats.assets}`, `- scripts: ${stats.scripts}`, `- demos: ${stats.demos}`, `- SKILL.md: ${stats.hasSkill ? "yes" : "no"}`);
	} else {
		lines.push("## Huashu Design repo", "- status: not found", "- clone: `git clone https://github.com/alchaincyf/huashu-design.git research/cmux-design/huashu-design`", "- or set: `HUASHU_DESIGN_ROOT=/path/to/huashu-design`");
	}
	const odRoot = resolveOpenDesignRoot();
	if (odRoot) {
		const od = openDesignStats(odRoot);
		lines.push("", "## Open Design repo", `- root: ${od.root}`, `- design systems: ${od.designSystems}`, `- skills: ${od.skills}`, `- frames: ${od.frames}`, `- prompt-template media: ${od.promptTemplateImages}`, `- docs: ${od.docs}`, `- direction library: ${od.hasDirections ? "yes" : "no"}`, `- discovery prompt: ${od.hasDiscoveryPrompt ? "yes" : "no"}`);
	} else {
		lines.push("", "## Open Design repo", "- status: not found", "- clone: `git clone https://github.com/nexu-io/open-design.git research/cmux-design/open-design`", "- or set: `OPEN_DESIGN_ROOT=/path/to/open-design`");
	}
	lines.push("", "## Local toolchain", `- node: ${commandVersion("node") || "missing"}`, `- npm: ${commandVersion("npm") || "missing"}`, `- python3: ${commandVersion("python3") || "missing"}`, `- ffmpeg: ${commandVersion("ffmpeg") || "missing"}`, `- yt-dlp: ${commandVersion("yt-dlp") || "missing"}`, `- cmux: ${commandPath("cmux") || "missing"}`);
	if (validate) {
		lines.push("", "## Validation probes", `- node module playwright: ${nodeModuleStatus("playwright") ? "available" : "missing"}`, `- node module pdf-lib: ${nodeModuleStatus("pdf-lib") ? "available" : "missing"}`, `- node module pptxgenjs: ${nodeModuleStatus("pptxgenjs") ? "available" : "missing"}`, `- node module sharp: ${nodeModuleStatus("sharp") ? "available" : "missing"}`, `- python module playwright: ${pythonModuleStatus("playwright") ? "available" : "missing"}`);
	}
	return lines.join("\n");
}

function deliverableLabel(kind?: string) {
	const map: Record<string, string> = {
		prototype: "high-fidelity HTML prototype",
		web: "web/page visual prototype",
		slides: "HTML slide deck",
		motion: "HTML motion design / video source",
		infographic: "print-grade infographic / data visualization",
		"design-system": "design system extraction and artifact pack",
		review: "expert design review",
	};
	return map[kind || "prototype"] || kind || "design artifact";
}

type DirectionSpec = {
	id: string;
	label: string;
	mood: string;
	references: string[];
	displayFont: string;
	bodyFont: string;
	monoFont?: string;
	palette: { bg: string; surface: string; fg: string; muted: string; border: string; accent: string };
	posture: string[];
};

const CMUX_DESIGN_DIRECTIONS: DirectionSpec[] = [
	{
		id: "editorial-monocle",
		label: "Editorial — Monocle / FT magazine",
		mood: "Print-magazine confidence: generous whitespace, serif headlines, off-white paper, ink, and one warm accent.",
		references: ["Monocle", "Financial Times Weekend", "NYT Magazine", "It's Nice That"],
		displayFont: "'Iowan Old Style', 'Charter', Georgia, serif",
		bodyFont: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
		palette: { bg: "oklch(97% 0.012 80)", surface: "oklch(99% 0.005 80)", fg: "oklch(20% 0.02 60)", muted: "oklch(48% 0.015 60)", border: "oklch(89% 0.012 80)", accent: "oklch(58% 0.16 35)" },
		posture: ["serif display + sans body", "no shadows; borders and whitespace do the work", "one decisive image or pull quote", "accent used at most twice per screen"],
	},
	{
		id: "modern-minimal",
		label: "Modern minimal — Linear / Vercel",
		mood: "Quiet, precise, software-native. Near greyscale, hairline borders, saturated accent, content-led layouts.",
		references: ["Linear", "Vercel", "Notion", "Stripe docs"],
		displayFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif",
		bodyFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
		palette: { bg: "oklch(99% 0.002 240)", surface: "oklch(100% 0 0)", fg: "oklch(18% 0.012 250)", muted: "oklch(54% 0.012 250)", border: "oklch(92% 0.005 250)", accent: "oklch(58% 0.18 255)" },
		posture: ["tight display tracking", "hairline borders only", "tabular numerics", "one accent for links and primary CTA"],
	},
	{
		id: "warm-soft",
		label: "Warm soft — Stripe pre-2020 / Headspace",
		mood: "Cream backgrounds, soft accents, gentle radii; friendly without becoming cute.",
		references: ["Stripe pre-2020", "Headspace", "Substack", "Mercury"],
		displayFont: "'Tiempos Headline', 'Newsreader', 'Iowan Old Style', Georgia, serif",
		bodyFont: "'Söhne', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
		palette: { bg: "oklch(97% 0.018 70)", surface: "oklch(99% 0.008 70)", fg: "oklch(22% 0.02 50)", muted: "oklch(50% 0.018 50)", border: "oklch(90% 0.014 70)", accent: "oklch(64% 0.13 28)" },
		posture: ["serif display + soft sans body", "12–16px radii", "soft inner glow over drop shadows", "real screenshots/photos over icons"],
	},
	{
		id: "tech-utility",
		label: "Tech utility — Datadog / GitHub",
		mood: "Data-dense, grid-aware, operator-friendly. Information density over decoration.",
		references: ["Datadog", "GitHub", "Cloudflare dashboard", "Sentry"],
		displayFont: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif",
		bodyFont: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif",
		monoFont: "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace",
		palette: { bg: "oklch(98% 0.005 250)", surface: "oklch(100% 0 0)", fg: "oklch(22% 0.02 240)", muted: "oklch(50% 0.018 240)", border: "oklch(90% 0.008 240)", accent: "oklch(58% 0.16 145)" },
		posture: ["mono for IDs/code", "dense tables and status pills", "avoid hero illustrations", "show product and data"],
	},
	{
		id: "brutalist-experimental",
		label: "Brutalist experimental — Are.na / Yale",
		mood: "Visible grid, loud type, deliberate ugliness as confidence. Great for manifestos, art, indie, agency work.",
		references: ["Are.na", "Yale Center for British Art", "MSCHF", "Read.cv"],
		displayFont: "'Times New Roman', 'Iowan Old Style', Georgia, serif",
		bodyFont: "ui-monospace, 'IBM Plex Mono', 'JetBrains Mono', Menlo, monospace",
		palette: { bg: "oklch(96% 0.004 100)", surface: "oklch(100% 0 0)", fg: "oklch(15% 0.02 100)", muted: "oklch(40% 0.02 100)", border: "oklch(15% 0.02 100)", accent: "oklch(60% 0.22 25)" },
		posture: ["extreme serif display sizes", "body can be monospace", "full-strength borders", "asymmetric 70/30 compositions", "almost no radius/shadows/gradients"],
	},
];

function renderDirectionCss(direction: DirectionSpec) {
	return [`:root {`, `  --bg: ${direction.palette.bg};`, `  --surface: ${direction.palette.surface};`, `  --fg: ${direction.palette.fg};`, `  --muted: ${direction.palette.muted};`, `  --border: ${direction.palette.border};`, `  --accent: ${direction.palette.accent};`, `  --font-display: ${direction.displayFont};`, `  --font-body: ${direction.bodyFont};`, `  --font-mono: ${direction.monoFont || "ui-monospace, SFMono-Regular, Menlo, monospace"};`, `}`].join("\n");
}

function renderDirectionLibraryMarkdown() {
	const lines = ["# CMUX Design Direction Library", "", "Open-Design-inspired deterministic directions. Pick one before writing high-fidelity CSS; bind its tokens verbatim, then adapt only with documented rationale."];
	for (const direction of CMUX_DESIGN_DIRECTIONS) {
		lines.push("", `## ${direction.label}`, `- id: \`${direction.id}\``, `- mood: ${direction.mood}`, `- references: ${direction.references.join(", ")}`, "- posture:", ...direction.posture.map((p) => `  - ${p}`), "", "```css", renderDirectionCss(direction), "```");
	}
	return lines.join("\n");
}

function topicChecklist(deliverable: string) {
	const base = ["workflow.md", "design-context.md", "content-guidelines.md", "verification.md", "tweaks-system.md", "design-styles.md"];
	if (deliverable === "slides") return [...base, "slide-decks.md", "editable-pptx.md"];
	if (deliverable === "motion") return [...base, "animations.md", "animation-best-practices.md", "animation-pitfalls.md", "video-export.md", "audio-design-rules.md"];
	if (deliverable === "infographic") return [...base, "scene-templates.md"];
	if (deliverable === "review") return [...base, "critique-guide.md"];
	return [...base, "react-setup.md"];
}

function renderQuestionSet(goal: string, deliverable: string, brandOrProduct?: string) {
	const specific = deliverable === "slides"
		? ["How many slides and what narrative arc?", "Presenter notes needed?", "Final format: HTML only, PDF, editable PPTX, or all?", "Any mandatory data/diagrams?"]
		: deliverable === "motion"
			? ["Duration and aspect ratio?", "Final use: website hero, launch film, social, internal demo?", "Desired pacing and key beats?", "Need MP4/GIF/60fps/BGM/SFX export?"]
			: deliverable === "review"
				? ["Which artifact or URL should be reviewed?", "What design philosophy or target brand should it be judged against?", "Do you want strict scoring or quick fixes only?", "What constraints cannot be changed?"]
				: ["Primary audience and conversion/action?", "Must-have sections/screens/flows?", "How many visual variations and how far apart should they be?", "Which tweak controls should the final HTML expose?"];
	return [
		"**Design context**",
		"1. Do you have an existing design system, UI kit, screenshots, brand guide, or codebase to inspect? Where?",
		"2. Which references should be treated as inspiration versus hard constraints?",
		"3. Are there token files/components already in the project?",
		"",
		"**Assets and facts**",
		`4. ${brandOrProduct ? `For ${brandOrProduct}, do you have` : "Do you have"} logo, product images/UI screenshots, colors, fonts, and brand guidelines?`,
		"5. Are we allowed to web-search/gather official assets if anything is missing?",
		"",
		"**Scope and fidelity**",
		"6. Fidelity target: wireframe, mid-fi, or polished high-fi?",
		"7. Scope: one screen/page, one flow, full deck, or full campaign?",
		"",
		"**Variations and tweaks**",
		"8. How many directions/variations? Conservative-to-bold or all close to target?",
		"9. Which live tweaks matter: theme, accent, typography, density, layout, copy, feature flags?",
		"",
		"**Task-specific**",
		...specific.map((q, i) => `${10 + i}. ${q}`),
	].join("\n");
}

function renderDesignPlan(params: any) {
	const deliverable = params.deliverable || "prototype";
	const label = deliverableLabel(deliverable);
	const topics = topicChecklist(deliverable);
	const lines = [
		`# CMUX Design plan: ${params.goal}`,
		"",
		`- deliverable: ${label}`,
		params.brandOrProduct ? `- brand/product: ${params.brandOrProduct}` : null,
		params.audience ? `- audience: ${params.audience}` : null,
		`- variations: ${params.variations || 3}`,
		`- cmux mode: ${params.cmuxMode || "solo"}`,
		params.outputDir ? `- output directory: ${params.outputDir}` : null,
		"",
		"## Reference pack to consult",
		...topics.map((topic) => `- ${topic}`),
		"",
		"## Open Design upgrade layer",
		`- Mode contract: ${deliverable === "slides" ? "deck" : deliverable === "design-system" ? "design-system" : deliverable === "review" ? "review" : "prototype/template"}. Keep exports, preview, and acceptance criteria mode-specific.`,
		"- Active DESIGN.md is authoritative; if missing, create/fill one before final polish.",
		"- Use deterministic direction cards when the brand is unknown; bind palette/font tokens verbatim instead of freestyle CSS.",
		"- Write artifact metadata, tweak parameters, and handoff notes so the design can be resumed in cmux.",
		"- Prefer skill-style side files: assets/template.html, references/layouts.md, references/checklist.md for repeatable high-quality output.",
		"",
		"## Required starting behavior",
		"1. Verify current facts before claiming product/version/spec details.",
		"2. Search local design context first: screenshots, token files, components, DESIGN.md, brand guides, existing pages.",
		"3. If branded, execute the core asset protocol: ask -> search official sources -> download -> verify/extract -> freeze into brand-spec.md.",
		"4. Ask the full question batch once; do not drip-feed single questions unless only one detail is missing.",
		"5. If no brand is supplied, choose or ask the user to choose one direction from design-directions.md.",
		"",
		"## Execution passes",
		"- Pass 1: assumptions + placeholders + visual direction reasoning; show early for correction.",
		"- Pass 2: real content/components + 3 variations or a tweakable variation matrix.",
		"- Pass 3: polish type, spacing, contrast, motion timing, empty states, and responsive behavior.",
		"- Pass 4: five-dimensional critique (philosophy, hierarchy, execution, specificity, restraint), then fix sub-3 scores.",
		"- Pass 5: render verification, screenshot review, console/error check, export if requested, and concise caveats.",
		"",
		"## CMUX coordination",
		params.cmuxMode === "team" ? "- Recommended roles: design strategist/researcher, visual designer, prototype implementer, reviewer/exporter." : "- Use a single cmux browser surface for visual inspection; checkpoint before major changes.",
		"- Prefer cmux browser snapshots/checkpoints over ad-hoc external browser state when work must be resumed or handed off.",
		"- Use cmux notifications when long render/export jobs finish.",
		"",
		"## Clarifying question batch",
		renderQuestionSet(params.goal, deliverable, params.brandOrProduct),
		"",
		"## Deterministic direction options",
		...CMUX_DESIGN_DIRECTIONS.map((direction) => `- ${direction.id}: ${direction.label} — ${direction.mood}`),
		"",
		"## Acceptance criteria",
		"- Artifact clearly derives from supplied/verified design context, not generic AI slop.",
		"- DESIGN.md, brand-spec.md, product-facts.md, CMUX_TWEAKS.json, artifact.json, and CMUX_HANDOFF.md are filled or explicitly marked N/A.",
		"- At least three meaningful variations or live tweak controls when exploration is requested.",
		"- Visual hierarchy, typography, spacing, and asset usage are deliberate and documented.",
		"- Five-dimensional critique has no score below 3/5 before final delivery.",
		"- Browser verification completed; known caveats are listed.",
		params.needsExport ? "- Requested exports generated and smoke-checked." : null,
	].filter(Boolean);
	return lines.join("\n");
}

function starterHtml(title: string, deliverable: string) {
	const isSlides = deliverable === "slides";
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #11100e;
      --panel: #1b1916;
      --ink: #f5efe4;
      --muted: #a9a093;
      --accent: #d8a64a;
      --line: rgba(245,239,228,.16);
      --font-display: Georgia, "Times New Roman", serif;
      --font-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-family: var(--font-body); }
    .canvas { min-height: 100vh; display: grid; place-items: center; padding: 48px; }
    .artifact { width: min(1180px, 100%); border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 88%, black); padding: clamp(28px, 6vw, 84px); box-shadow: 0 30px 120px rgba(0,0,0,.32); }
    .eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .18em; font-size: 12px; font-weight: 700; }
    h1 { font-family: var(--font-display); font-size: clamp(44px, 9vw, 112px); line-height: .9; letter-spacing: -.06em; margin: 24px 0; text-wrap: balance; }
    p { color: var(--muted); font-size: clamp(17px, 2vw, 23px); line-height: 1.55; max-width: 68ch; text-wrap: pretty; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 44px; }
    .card { min-height: 160px; border: 1px solid var(--line); padding: 20px; background: rgba(255,255,255,.025); }
    .card strong { display: block; margin-bottom: 12px; }
    @media (max-width: 800px) { .canvas { padding: 20px; } .grid { grid-template-columns: 1fr; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
  </style>
</head>
<body>
<!--
CMUX Design assumptions:
- Replace this starter with the chosen design direction after context/asset review.
- Keep real brand assets and verified facts in brand-spec.md and product-facts.md.
- Add Tweaks controls when comparing variations.
-->
  <main class="canvas">
    <section class="artifact"${isSlides ? " style=\"aspect-ratio:16/9; min-height:0;\"" : ""}>
      <div class="eyebrow">CMUX Design Starter</div>
      <h1>${title}</h1>
      <p>This is a placeholder canvas. Replace it after completing the design-context pass, asset protocol, and variation plan.</p>
      <div class="grid">
        <div class="card"><strong>Direction A</strong><span>Conservative system-faithful option.</span></div>
        <div class="card"><strong>Direction B</strong><span>Editorial / differentiated option.</span></div>
        <div class="card"><strong>Direction C</strong><span>Bold exploratory option.</span></div>
      </div>
    </section>
  </main>
</body>
</html>
`;
}

function buildDesignMd(title: string, params: any) {
	return `# ${title}

> CMUX/Open-Design-compatible 9-section DESIGN.md. Fill this before final polish; use N/A only when a section genuinely does not apply.

## Visual Theme & Atmosphere
- Intent: ${params.goal}
- Chosen direction: TBD (see design-directions.md)
- Mood words: TBD
- Avoided clichés: generic mesh gradients, random glass cards, emoji icons, invented metrics.

## Color Palette & Roles
\`\`\`css
:root {
  --bg: TBD;
  --surface: TBD;
  --fg: TBD;
  --muted: TBD;
  --border: TBD;
  --accent: TBD;
}
\`\`\`
- Palette source: brand-spec.md / chosen direction / existing app tokens.

## Typography Rules
- Display font: TBD
- Body font: TBD
- Mono font: TBD
- Scale: TBD
- Numeric style: tabular when data-heavy.

## Component Stylings
- Buttons: TBD
- Cards/panels: TBD
- Forms/tables/navigation: TBD
- Device/deck/frame rules: TBD

## Layout Principles
- Canvas/surface: ${params.deliverable === "slides" ? "16:9 slide stage" : params.deliverable === "motion" ? "fixed motion canvas" : "responsive artifact"}
- Grid: TBD
- Density: TBD
- Section rhythm: TBD

## Depth & Elevation
- Shadows/elevation: TBD
- Borders/radii: TBD
- Backdrop/texture: TBD

## Do's and Don'ts
### Do
- Trace every major visual choice to brand-spec.md, product-facts.md, design-directions.md, or supplied references.
- Use real assets or honest placeholders.
- Keep one decisive flourish.
### Don't
- Invent current facts or metrics.
- Use decorations that don't support the content.
- Ship a high-fi artifact before browser verification.

## Responsive Behavior
- Primary viewport/canvas: TBD
- Breakpoints: TBD
- Mobile/tablet behavior: TBD
- Reduced motion behavior: honor \`prefers-reduced-motion\`.

## Agent Prompt Guide
- Work in passes: context/facts → direction/tokens → structure → implementation → critique → verification/export.
- Read CMUX_DESIGN_BRIEF.md, brand-spec.md, product-facts.md, CMUX_TWEAKS.json, and design-directions.md before writing final CSS.
- Run five-dimensional critique: philosophy, hierarchy, execution, specificity, restraint. Fix any score below 3/5.
`;
}

function buildBrandSpec(title: string, brandOrProduct?: string) {
	return `# ${brandOrProduct || title} · Brand Spec

> Collection date: TBD
> Asset sources: TBD
> Completeness: TBD

## Core assets
| Asset | Required? | Path/source | Status | Notes |
|---|---:|---|---|---|
| Logo | yes for any brand | TBD | missing | Use official SVG/PNG when possible. |
| Product imagery | yes for physical products | TBD | TBD | Prefer official hero/press images. |
| UI screenshots | yes for digital products | TBD | TBD | Prefer current official product/app screenshots. |
| Colors | supporting | TBD | TBD | Extract from real assets/CSS, filter demo contamination. |
| Fonts | supporting | TBD | TBD | Verify from brand guide/site CSS. |

## Asset quality notes
- Use 5 search rounds / 10 candidates / choose 2 strong assets for non-logo imagery.
- Each chosen non-logo asset should be 8/10+ or omitted with an honest placeholder.
- Logo is a recognition primitive: if it exists, use it; if missing, stop and ask.
`;
}

function buildProductFacts(brandOrProduct?: string) {
	return `# Product Facts

${brandOrProduct ? `Subject: ${brandOrProduct}` : "Subject: TBD"}

## Verified facts
| Fact | Source | Date checked | Confidence |
|---|---|---|---|
| Existence/status | TBD | TBD | TBD |
| Current version/specs | TBD | TBD | TBD |
| Official URL(s) | TBD | TBD | TBD |

## Notes
- Do not fill this file from memory when the task depends on current product/version/spec claims.
`;
}

function buildTweaksSpec(params: any) {
	return json({
		version: 1,
		purpose: "Open-Design-style live tweak contract for CMUX Design artifacts.",
		parameters: [
			{ name: "direction", type: "enum", values: CMUX_DESIGN_DIRECTIONS.map((d) => d.id), default: CMUX_DESIGN_DIRECTIONS[0].id, affects: ["palette", "typography", "layoutPosture"] },
			{ name: "accent", type: "color", default: "var(--accent)", affects: ["cta", "links", "oneFlourish"] },
			{ name: "typeScale", type: "number", min: 0.88, max: 1.18, step: 0.02, default: 1, affects: ["headlines", "body"] },
			{ name: "density", type: "enum", values: ["airy", "balanced", "dense"], default: "balanced", affects: ["spacing", "grid", "sectionRhythm"] },
			{ name: "motion", type: "enum", values: ["none", "restrained", "expressive"], default: params.deliverable === "motion" ? "expressive" : "restrained", affects: ["transitions", "ambientAnimation"] },
		],
		rules: [
			"Expose these as real UI controls when useful; otherwise document final chosen values.",
			"Do not add a tweak that breaks brand-spec.md, accessibility, or the selected direction posture.",
			"One accent budget: links + primary CTA + at most one flourish.",
		],
	});
}

function buildArtifactManifest(title: string, params: any) {
	return json({
		version: 1,
		title,
		goal: params.goal,
		mode: params.deliverable || "prototype",
		brandOrProduct: params.brandOrProduct || null,
		variations: params.variations || 3,
		primaryOutput: params.deliverable === "slides" ? "slides/01-title.html" : "index.html",
		files: {
			designSystem: "DESIGN.md",
			brief: "CMUX_DESIGN_BRIEF.md",
			brandSpec: "brand-spec.md",
			productFacts: "product-facts.md",
			tweaks: "CMUX_TWEAKS.json",
			directions: "design-directions.md",
			handoff: "CMUX_HANDOFF.md",
		},
		qualityGates: ["facts verified", "direction tokens bound", "checklist passed", "5d critique >= 3/5", "browser verified", "exports smoke-checked if requested"],
		createdBy: "cmux_design_scaffold",
	});
}

function buildSkillProtocolMd() {
	return `# CMUX Skill Protocol Notes

Open Design's strongest reusable idea is that design capability should be packaged as files, not hidden in a product UI.

Recommended local skill shape for reusable CMUX Design work:

\`\`\`
my-design-skill/
├── SKILL.md
├── assets/
│   └── template.html
└── references/
    ├── layouts.md
    └── checklist.md
\`\`\`

Minimum \`SKILL.md\` frontmatter for design skills:

\`\`\`yaml
---
name: my-design-skill
description: What this skill produces and when to use it.
od:
  mode: prototype # prototype | deck | template | design-system
  preview:
    type: html
    entry: index.html
  design_system:
    requires: true
  inputs: []
  parameters: []
  outputs:
    primary: index.html
---
\`\`\`

CMUX Design does not require this frontmatter yet, but this scaffold records it so future agents can promote successful artifacts into reusable skills.
`;
}

function buildCommand(params: any) {
	const root = params.repoPath ? mustRepoRoot(params.repoPath) : resolveRepoRoot();
	const scripts = root ? join(root, "scripts") : "<huashu-design>/scripts";
	const workflow = params.workflow;
	const html = params.htmlPath ? resolve(params.htmlPath) : "<artifact.html>";
	const slides = params.slidesDir ? resolve(params.slidesDir) : "<slides-dir>";
	const out = params.outPath ? resolve(params.outPath) : "<output-file>";
	let command = "";
	let prereqs: string[] = [];
	if (workflow === "verify_html") {
		const viewports = params.viewports || "1440x900";
		const slideFlag = params.slides ? ` --slides ${Number(params.slides)}` : "";
		const showFlag = params.show ? " --show" : "";
		command = `python3 ${JSON.stringify(join(scripts, "verify.py"))} ${JSON.stringify(html)} --viewports ${JSON.stringify(viewports)}${slideFlag}${showFlag}`;
		prereqs = ["pip install playwright", "python3 -m playwright install chromium"];
	} else if (workflow === "render_video") {
		const duration = Number(params.duration || 30);
		const width = Number(params.width || 1920);
		const height = Number(params.height || 1080);
		command = `NODE_PATH=$(npm root -g) node ${JSON.stringify(join(scripts, "render-video.js"))} ${JSON.stringify(html)} --duration=${duration} --width=${width} --height=${height}`;
		prereqs = ["npm install -g playwright", "ffmpeg on PATH", "HTML should set window.__ready=true or use Huashu Stage component"];
	} else if (workflow === "convert_formats") {
		const gifWidth = Number(params.gifWidth || 960);
		const flag = params.minterpolate ? " --minterpolate" : "";
		command = `bash ${JSON.stringify(join(scripts, "convert-formats.sh"))} ${JSON.stringify(params.htmlPath || "<input.mp4>")} ${gifWidth}${flag}`;
		prereqs = ["ffmpeg on PATH"];
	} else if (workflow === "add_music") {
		const mood = params.mood || "tech";
		const outFlag = params.outPath ? ` --out=${JSON.stringify(out)}` : "";
		command = `bash ${JSON.stringify(join(scripts, "add-music.sh"))} ${JSON.stringify(params.htmlPath || "<input.mp4>")} --mood=${mood}${outFlag}`;
		prereqs = ["ffmpeg on PATH", "Huashu assets/bgm-*.mp3 available"];
	} else if (workflow === "export_deck_pdf") {
		const width = Number(params.width || 1920);
		const height = Number(params.height || 1080);
		command = `NODE_PATH=$(npm root -g) node ${JSON.stringify(join(scripts, "export_deck_pdf.mjs"))} --slides ${JSON.stringify(slides)} --out ${JSON.stringify(out.endsWith(".pdf") ? out : "<deck.pdf>")} --width ${width} --height ${height}`;
		prereqs = ["npm install playwright pdf-lib"];
	} else if (workflow === "export_deck_pptx") {
		command = `NODE_PATH=$(npm root -g) node ${JSON.stringify(join(scripts, "export_deck_pptx.mjs"))} --slides ${JSON.stringify(slides)} --out ${JSON.stringify(out.endsWith(".pptx") ? out : "<deck.pptx>")}`;
		prereqs = ["npm install playwright pptxgenjs sharp", "Slides must follow editable-pptx.md constraints from the first line"];
	} else if (workflow === "export_deck_stage_pdf") {
		const width = Number(params.width || 1920);
		const height = Number(params.height || 1080);
		command = `NODE_PATH=$(npm root -g) node ${JSON.stringify(join(scripts, "export_deck_stage_pdf.mjs"))} --html ${JSON.stringify(html)} --out ${JSON.stringify(out.endsWith(".pdf") ? out : "<deck.pdf>")} --width ${width} --height ${height}`;
		prereqs = ["npm install playwright", "Single HTML deck-stage architecture"];
	} else {
		throw new Error(`Unknown workflow: ${workflow}`);
	}
	return { command, prereqs, repoRoot: root, workflow };
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n${PREAMBLE}` }));

	pi.registerTool({
		name: "cmux_design_status",
		label: "CMUX Design Status",
		description: "Check Huashu Design repo availability, CMUX-design artifacts, and local verification/export toolchain readiness.",
		promptSnippet: "Use before CMUX Design work to verify the Huashu repo and export tooling are available.",
		parameters: Type.Object({
			repoPath: Type.Optional(Type.String({ description: "Optional path to a local huashu-design clone." })),
			validate: Type.Optional(Type.Boolean({ description: "Run bounded module availability probes. Default false." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const p = params as any;
				const root = resolveRepoRoot(p.repoPath);
				return ok(renderStatus(root, Boolean(p.validate)), { repoRoot: root, stats: root ? repoStats(root) : null });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_status" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_repo_digest",
		label: "CMUX Design Repo Digest",
		description: "Deeply inspect the local Huashu Design repo and summarize matching references, assets, demos, and scripts.",
		promptSnippet: "Use when you need to ground a CMUX Design task in the Huashu repo's workflows and references.",
		parameters: Type.Object({
			repoPath: Type.Optional(Type.String({ description: "Optional path to a local huashu-design clone." })),
			query: Type.Optional(Type.String({ description: "Optional query such as slides, animation, tweaks, verification, brand assets, infographic." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum references to include. Default 8." })),
			includeExcerpts: Type.Optional(Type.Boolean({ description: "Include short excerpts from matched reference files. Default false." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const p = params as any;
				const root = mustRepoRoot(p.repoPath);
				const limit = Math.max(1, Math.min(20, Number(p.limit || 8)));
				const matches = searchReferences(root, p.query, limit);
				const stats = repoStats(root);
				const lines = ["# Huashu Design repo digest", "", `- root: ${root}`, `- references: ${stats.references}`, `- assets: ${stats.assets}`, `- scripts: ${stats.scripts}`, `- demos: ${stats.demos}`, "", "## Core takeaways", "- Design context first; blank-page high-fi is last resort.", "- Brand/product work requires fact verification plus logo/product/UI asset collection.", "- Work like a junior designer: assumptions/placeholders early, then variations, then polish, then verification.", "- The repo ships starter components/assets for canvases, device frames, deck stages, animation timeline, and exports.", "- Output paths include HTML prototypes, slide decks, MP4/GIF animation, PDF/PPTX, and design critique reports.", "", "## Matching references"];
				for (const ref of matches) {
					lines.push(`### ${ref.title}`, `- file: ${ref.file}`, `- summary: ${ref.summary}`);
					if (p.includeExcerpts) lines.push("", "```md", readText(ref.path, 1400), "```");
				}
				lines.push("", "## Scripts", ...listFilesSafe(join(root, "scripts")).map((s) => `- ${s}`), "", "## Demo count", `- HTML demos: ${stats.demos}`);
				return ok(lines.join("\n"), { root, stats, matches });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_repo_digest" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_open_design_digest",
		label: "CMUX Design Open Design Digest",
		description: "Inspect a local nexu-io/open-design clone and summarize reusable modes, skill metadata, design systems, direction prompts, frames, and implementation ideas for CMUX Design.",
		promptSnippet: "Use when you need Open-Design-grounded ideas for improving CMUX Design workflows, scaffolds, or skill packs.",
		parameters: Type.Object({
			repoPath: Type.Optional(Type.String({ description: "Optional path to a local open-design clone." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum skills/design systems to list. Default 12." })),
			includePromptExcerpts: Type.Optional(Type.Boolean({ description: "Include short excerpts from key prompt files. Default false." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const p = params as any;
				const root = mustOpenDesignRoot(p.repoPath);
				const limit = Math.max(1, Math.min(50, Number(p.limit || 12)));
				const stats = openDesignStats(root);
				const lines = [
					"# Open Design repo digest for CMUX Design",
					"",
					`- root: ${root}`,
					`- design systems: ${stats.designSystems}`,
					`- skills: ${stats.skills}`,
					`- frames: ${stats.frames}`,
					`- prompt-template media: ${stats.promptTemplateImages}`,
					"",
					"## Reusable concepts to bring into CMUX Design",
					"- Mode contracts: prototype, deck, template, design-system, plus media surfaces. Each mode has its own preview/export/checklist shape.",
					"- File-based skill protocol: SKILL.md + assets/template.html + references/layouts.md + references/checklist.md + optional metadata for preview, inputs, parameters, outputs.",
					"- 9-section DESIGN.md resolver: active design systems are versionable files and should be injected before implementation.",
					"- Direction cards: deterministic palettes/font stacks/posture so agents do not freestyle visual taste.",
					"- Artifact persistence: artifact.json, history.jsonl, tweak parameters, and preview checkpoints keep design work resumable.",
					"- Shared frames: use device/browser frame assets rather than redrawing phones/laptops in every artifact.",
					"",
					"## Sample skills",
					...listOpenDesignSkillSummaries(root, limit).map((skill) => `- ${skill.name} (${skill.mode}): ${skill.description}`),
					"",
					"## Sample design systems",
					...listOpenDesignSystemSummaries(root, limit).map((system) => `- ${system.name}: ${system.title}${system.summary ? ` — ${system.summary}` : ""}`),
					"",
					"## CMUX implementation targets",
					"- extensions/cmux-design.ts: status/digest, deterministic direction pack, richer plan/scaffold/prompt, Open-Design artifact metadata.",
					"- skills/cmux-design/SKILL.md: workflow should require mode contract, DESIGN.md, tweak spec, artifact metadata, and 5D critique.",
					"- research/cmux-design/open-design: keep clone for local inspection; do not vendor upstream wholesale into the extension.",
				];
				if (p.includePromptExcerpts) {
					for (const rel of ["apps/daemon/src/prompts/discovery.ts", "apps/daemon/src/prompts/directions.ts", "docs/skills-protocol.md", "docs/modes.md"]) {
						const file = join(root, rel);
						if (existsSync(file)) lines.push("", `## Excerpt: ${rel}`, "```", readText(file, 1800), "```");
					}
				}
				return ok(lines.join("\n"), { root, stats });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_open_design_digest" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_direction_pack",
		label: "CMUX Design Direction Pack",
		description: "Return Open-Design-inspired deterministic visual directions with CSS tokens, posture rules, and optional JSON question-form body.",
		promptSnippet: "Use when a design brief lacks a brand or needs clear visual alternatives before high-fidelity work.",
		parameters: Type.Object({
			directionId: Type.Optional(Type.String({ description: "Optional direction id to return in detail." })),
			format: Type.Optional(StringEnum(["markdown", "json", "question-form"] as const, { description: "Output format. Default markdown." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const p = params as any;
				const format = p.format || "markdown";
				const directions = p.directionId ? CMUX_DESIGN_DIRECTIONS.filter((d) => d.id === p.directionId) : CMUX_DESIGN_DIRECTIONS;
				if (p.directionId && directions.length === 0) throw new Error(`Unknown directionId: ${p.directionId}`);
				if (format === "json") return ok(json(directions), { directions });
				if (format === "question-form") {
					const body = {
						description: "Pick a visual direction. Each option has a real palette, font stack, and layout posture.",
						questions: [{ id: "direction", label: "Direction", type: "radio", required: true, options: directions.map((d) => `${d.id} — ${d.label}`) }, { id: "accent_override", label: "Accent override (optional)", type: "text" }],
					};
					return ok(["<question-form id=\"direction\" title=\"Pick a visual direction\">", json(body), "</question-form>"].join("\n"), { directions, body });
				}
				return ok(p.directionId ? directions.map((direction) => [`# ${direction.label}`, "", `- id: ${direction.id}`, `- mood: ${direction.mood}`, `- references: ${direction.references.join(", ")}`, "", "```css", renderDirectionCss(direction), "```", "", "## Posture", ...direction.posture.map((x) => `- ${x}`)].join("\n")).join("\n\n") : renderDirectionLibraryMarkdown(), { directions });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_direction_pack" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_plan",
		label: "CMUX Design Plan",
		description: "Create a Huashu-inspired, cmux-aware execution plan, clarifying question batch, acceptance criteria, and reference-pack checklist.",
		promptSnippet: "Use before launching a CMUX Design prototype/deck/motion/review job.",
		parameters: Type.Object({
			goal: Type.String({ description: "Design task or desired artifact." }),
			deliverable: Type.Optional(StringEnum(["prototype", "web", "slides", "motion", "infographic", "design-system", "review"] as const, { description: "Target deliverable type." })),
			brandOrProduct: Type.Optional(Type.String({ description: "Specific brand/product, if any." })),
			audience: Type.Optional(Type.String({ description: "Target audience." })),
			variations: Type.Optional(Type.Integer({ description: "Desired number of visual variations. Default 3." })),
			outputDir: Type.Optional(Type.String({ description: "Expected output directory." })),
			cmuxMode: Type.Optional(StringEnum(["solo", "team", "browser-review"] as const, { description: "How to coordinate in cmux." })),
			needsExport: Type.Optional(Type.Boolean({ description: "Whether final export artifacts such as MP4/PDF/PPTX are expected." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const plan = renderDesignPlan(params as any);
				return ok(plan, { plan: params });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_plan" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_scaffold",
		label: "CMUX Design Scaffold",
		description: "Create a CMUX Design workspace with brief, DESIGN.md, brand-spec.md, product-facts.md, and optional starter HTML.",
		promptSnippet: "Use to initialize files for a CMUX Design artifact before implementation.",
		parameters: Type.Object({
			goal: Type.String({ description: "Design task or artifact goal." }),
			outputDir: Type.String({ description: "Directory to create or populate." }),
			title: Type.Optional(Type.String({ description: "Project/artifact title. Defaults from goal." })),
			deliverable: Type.Optional(StringEnum(["prototype", "web", "slides", "motion", "infographic", "design-system", "review"] as const, { description: "Target deliverable type." })),
			brandOrProduct: Type.Optional(Type.String({ description: "Specific brand/product, if any." })),
			variations: Type.Optional(Type.Integer({ description: "Desired number of variations. Default 3." })),
			includeHtmlStarter: Type.Optional(Type.Boolean({ description: "Write starter index.html. Default true unless deliverable=review/design-system." })),
			includeCmuxHandoff: Type.Optional(Type.Boolean({ description: "Write CMUX_HANDOFF.md. Default true." })),
			overwrite: Type.Optional(Type.Boolean({ description: "Allow overwriting existing generated files." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const p = params as any;
				const cwd = ctx?.cwd || process.cwd();
				const outDir = resolve(cwd, p.outputDir);
				mkdirSync(outDir, { recursive: true });
				const title = p.title || safeSlug(p.goal).split("-").map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
				const deliverable = p.deliverable || "prototype";
				const files: Record<string, string> = {
					"CMUX_DESIGN_BRIEF.md": renderDesignPlan({ ...p, title, deliverable, outputDir: outDir }),
					"DESIGN.md": buildDesignMd(title, { ...p, deliverable }),
					"brand-spec.md": buildBrandSpec(title, p.brandOrProduct),
					"product-facts.md": buildProductFacts(p.brandOrProduct),
					"CMUX_TWEAKS.json": buildTweaksSpec({ ...p, deliverable }),
					"design-directions.md": renderDirectionLibraryMarkdown(),
					"artifact.json": buildArtifactManifest(title, { ...p, deliverable }),
					"skill-protocol.md": buildSkillProtocolMd(),
					"history.jsonl": json({ ts: new Date().toISOString(), action: "scaffold", title, goal: p.goal, deliverable }) + "\n",
					"README.md": `# ${title}\n\nCMUX Design workspace for: ${p.goal}\n\nStart with \`CMUX_DESIGN_BRIEF.md\`, choose/fill \`design-directions.md\`, fill \`product-facts.md\`, \`brand-spec.md\`, and \`DESIGN.md\`, then implement/verify/export the artifact. \`artifact.json\` and \`history.jsonl\` are Open-Design-style persistence metadata for handoff/review.\n`,
				};
				if (p.includeCmuxHandoff !== false) {
					files["CMUX_HANDOFF.md"] = `# CMUX Handoff\n\n## Current state\n- Scaffold created.\n- Open Design upgrades included: artifact.json, history.jsonl, CMUX_TWEAKS.json, design-directions.md, skill-protocol.md, 9-section DESIGN.md.\n\n## Next actions\n1. Complete fact/context/asset pass.\n2. Choose a deterministic direction and bind tokens into DESIGN.md / CSS.\n3. Implement first placeholder pass, then variation/tweaks pass.\n4. Run 5-dimensional critique and fix any score below 3/5.\n5. Verify in a cmux browser surface and checkpoint.\n\n## Surfaces / agents\n- Workspace: TBD\n- Browser surface: TBD\n- Agent/team: TBD\n`;
				}
				const shouldHtml = p.includeHtmlStarter !== undefined ? p.includeHtmlStarter : !["review", "design-system"].includes(deliverable);
				if (shouldHtml) files[deliverable === "slides" ? "slides/01-title.html" : "index.html"] = starterHtml(title, deliverable);
				const written: string[] = [];
				for (const [relative, content] of Object.entries(files)) {
					const target = join(outDir, relative);
					if (!p.overwrite && existsSync(target)) throw new Error(`File already exists: ${target}`);
					ensureParentDir(target);
					writeFileSync(target, content);
					written.push(target);
				}
				return ok(["# CMUX Design scaffold created", "", `- output: ${outDir}`, `- files: ${written.length}`, "", ...written.map((file) => `- ${file}`)].join("\n"), { outputDir: outDir, written });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_scaffold" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_build_command",
		label: "CMUX Design Build Command",
		description: "Construct verified Huashu Design commands for HTML verification, video rendering, GIF/60fps conversion, music, and deck exports.",
		promptSnippet: "Use before running Huashu verify/export scripts so flags are not guessed manually.",
		parameters: Type.Object({
			workflow: StringEnum(["verify_html", "render_video", "convert_formats", "add_music", "export_deck_pdf", "export_deck_pptx", "export_deck_stage_pdf"] as const, { description: "Build/export workflow." }),
			repoPath: Type.Optional(Type.String({ description: "Optional path to a local huashu-design clone." })),
			htmlPath: Type.Optional(Type.String({ description: "HTML path for verify/render/stage export, or input MP4 for convert/music workflows." })),
			slidesDir: Type.Optional(Type.String({ description: "Slides directory for deck export workflows." })),
			outPath: Type.Optional(Type.String({ description: "Output path for PDF/PPTX/music workflows." })),
			duration: Type.Optional(Type.Number({ description: "Video duration in seconds. Default 30." })),
			width: Type.Optional(Type.Integer({ description: "Viewport/export width. Default 1920." })),
			height: Type.Optional(Type.Integer({ description: "Viewport/export height. Default 1080." })),
			viewports: Type.Optional(Type.String({ description: "Verification viewport list, e.g. 1440x900,375x667." })),
			slides: Type.Optional(Type.Integer({ description: "Number of slides to screenshot during verification." })),
			show: Type.Optional(Type.Boolean({ description: "Open non-headless browser for verification." })),
			mood: Type.Optional(Type.String({ description: "BGM mood for add_music: tech, ad, educational, tutorial, etc." })),
			gifWidth: Type.Optional(Type.Integer({ description: "GIF width for convert_formats. Default 960." })),
			minterpolate: Type.Optional(Type.Boolean({ description: "Use motion-compensated 60fps interpolation for convert_formats." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = buildCommand(params as any);
				const lines = ["# CMUX Design command", "", "```bash", result.command, "```", "", "## Prerequisites", ...result.prereqs.map((p) => `- ${p}`), "", result.repoRoot ? `- repo root: ${result.repoRoot}` : "- repo root: not auto-detected; replace <huashu-design> in command"];
				return ok(lines.join("\n"), result);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_build_command" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_design_prompt",
		label: "CMUX Design Prompt",
		description: "Generate an operator-ready prompt for a solo Pi agent or cmux team to execute a Huashu-inspired design job.",
		promptSnippet: "Use when launching or briefing CMUX agents for design work.",
		parameters: Type.Object({
			goal: Type.String({ description: "Design task or artifact goal." }),
			deliverable: Type.Optional(StringEnum(["prototype", "web", "slides", "motion", "infographic", "design-system", "review"] as const, { description: "Target deliverable type." })),
			brandOrProduct: Type.Optional(Type.String({ description: "Specific brand/product, if any." })),
			contextPaths: Type.Optional(Type.Array(Type.String(), { description: "Relevant files/directories/screenshots/design systems to inspect." })),
			outputDir: Type.Optional(Type.String({ description: "Expected output directory." })),
			cmuxMode: Type.Optional(StringEnum(["solo", "team"] as const, { description: "Launch posture." })),
			referenceTopics: Type.Optional(Type.Array(Type.String(), { description: "Huashu reference files/topics to emphasize." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const p = params as any;
				const deliverable = p.deliverable || "prototype";
				const topics = p.referenceTopics?.length ? p.referenceTopics : topicChecklist(deliverable);
				const prompt = [
					`You are executing a CMUX Design job as a Huashu-inspired designer inside Pi/cmux.`,
					"",
					`Goal: ${p.goal}`,
					`Deliverable: ${deliverableLabel(deliverable)}`,
					p.brandOrProduct ? `Brand/product: ${p.brandOrProduct}` : null,
					p.outputDir ? `Output directory: ${p.outputDir}` : null,
					p.contextPaths?.length ? `Context paths to inspect first:\n${p.contextPaths.map((x: string) => `- ${x}`).join("\n")}` : null,
					"",
					"Operating rules:",
					"1. Start from existing design context; blank-page high-fi is last resort.",
					"2. Verify current product/version/spec facts before asserting them.",
					"3. For brands, gather/freeze logo, product/UI imagery, colors, fonts, and source URLs into brand-spec.md.",
					"4. If no brand is supplied, choose or ask for one deterministic direction from design-directions.md / cmux_design_direction_pack and bind tokens verbatim.",
					"5. Work in Open-Design/Huashu passes: assumptions/placeholders -> mode-specific structure -> variations/tweaks -> polish -> 5D critique -> verification/export.",
					"6. Maintain Open-Design-style handoff metadata: artifact.json, history.jsonl, CMUX_TWEAKS.json, DESIGN.md, and CMUX_HANDOFF.md.",
					"7. Avoid AI slop: generic gradients, emoji icons, random SVG people, CSS silhouettes as products, tokenless visual choices.",
					"8. Verify in browser and capture screenshots before final delivery. Use cmux browser checkpoints/handoffs if available.",
					"",
					"Huashu reference topics to consult:",
					...topics.map((topic: string) => `- ${topic}`),
					"",
					"Before implementing, ask the full question batch if any major requirement is missing. If requirements are clear, write assumptions into the artifact and proceed.",
				].filter(Boolean).join("\n");
				return ok(prompt, { prompt, topics });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_design_prompt" });
			}
		},
	});
}
