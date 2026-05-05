/**
 * CMUX Browser Intelligence — Semantic browser automation with observe/act/assert/extract workflows, session checkpoints, memory, and recovery for cmux browser surfaces.
 */
// @ts-nocheck
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectBinary } from "../lib/extension-shared.ts";
import { writeCmuxBridgeAuxEvent } from "../lib/cmux-pi-bridge-shared.ts";
import { normalizeCheckpointRecord, restoreModeForCheckpoint } from "../lib/cmux-browser-checkpoints.ts";

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_OBSERVE_MAX_DEPTH = 5;
const DEFAULT_LIMIT = 20;
const BASE_DIR = join(homedir(), ".pi", "agent", ".cmux-browser-intelligence");
const CHECKPOINT_DIR = join(BASE_DIR, "checkpoints");
const STATE_DIR = join(BASE_DIR, "state");
const SKILLS_DIR = join(BASE_DIR, "skills");
const INTERACTION_SKILLS_DIR = join(SKILLS_DIR, "interaction-skills");
const DOMAIN_SKILLS_DIR = join(SKILLS_DIR, "domain-skills");
const LOCKS_PATH = join(BASE_DIR, "locks.json");
const MEMORY_PATH = join(BASE_DIR, "memory.json");
const CHECKPOINT_POLICY_PATH = join(BASE_DIR, "checkpoint-policy.json");

const PREAMBLE = `
# CMUX Browser Intelligence

Use these tools when browser work should happen inside a cmux browser surface but the agent needs more than raw click/fill/snapshot primitives.

## Core browser workflow
- Prefer \`cmux_browser_observe\` before major actions so you understand the page, current risks, and likely next steps.
- Prefer \`cmux_browser_act\` over raw low-level browser actions when you want semantic targeting like “click the Continue button” or “fill the Email field”.
- Use \`cmux_browser_assert\` after important actions to verify success instead of assuming the page changed correctly.
- Use \`cmux_browser_extract\` when you need structured links, forms, tables, cards, key-value data, or field-specific extraction.
- Use \`cmux_browser_recover\` when the page is blocked, a target cannot be resolved, a modal interrupts progress, or the browser needs stabilization before continuing.
- Use \`cmux_browser_doctor\` when a browser surface feels stale, wrong, unlocked, auth-blocked, or otherwise suspicious and you want diagnostics before mutating it further.
- Use \`cmux_browser_bootstrap\` to prepare or reuse a browser surface, optionally focus it, navigate it, recall site memory, and create an initial checkpoint before real work begins.
- Use \`cmux_browser_focus_and_notify\` when a setup, verification, or operator-visible step should explicitly bring a shared browser surface to the front.
- Use \`cmux_browser_mechanic\` when you are dealing with a hard browser mechanic like dialogs, uploads, downloads, iframes, or shadow DOM and want the right playbooks plus any safe recovery help.
- Use \`cmux_browser_run_task\` when a single tool should handle an observe/act/assert/extract/checkpoint/recovery loop for a higher-level browser goal.
- Use \`cmux_browser_lock\` to coordinate ownership of a shared browser surface across a cmux team and avoid two agents fighting over the same tab.
- Use \`cmux_browser_memory\` to remember site-specific notes, workflows, checkpoints, and recurring browser knowledge.
- Use \`cmux_browser_learn\` to promote successful browser knowledge into durable memory with attribution and optional skill-pack publication.
- Use \`cmux_browser_skill_pack\` to manage reusable interaction and domain browser skill packs stored under the CMUX browser intelligence runtime directory.
- Use \`cmux_browser_session\` checkpoint/restore/diff/handoff when one agent or a cmux team needs continuity across steps or between agents.

## Team/orchestrator guidance
- A navigator agent can drive \`cmux_browser_act\` while a verifier agent uses \`cmux_browser_assert\` or \`cmux_browser_observe\` on the same surface.
- Use checkpoints before risky transitions like login, checkout, destructive actions, or multi-step flows.
- When handing work to another agent, create a checkpoint and a handoff note so the next agent can restore the browser state and continue from context.

## Routing guidance
- Use CMUX browser for single-agent local visual browsing, not just orchestrated multi-agent work.
- Use CMUX browser when one or more agents should share the same live page or browser surface.
- If the task is primarily scraping, search, crawl, or structured extraction across many pages/sites, Hyperbrowser is usually the better route.
- If the task needs stealth, proxies, CAPTCHA solving, or cloud-hosted browser state, Hyperbrowser is usually the better route.

## Operational rules
- Use \`cmux_status\` if you need to verify general cmux readiness, workspace state, or socket health.
- These tools operate on cmux browser surfaces. Pass \`surface\` when you want an explicit target; otherwise cmux surface defaults may apply.
- Do not use the standalone built-in \`browser\` tool for cmux browser-surface workflows unless the user explicitly asks for it and you are not operating on a cmux browser surface.
- If browser work is inside cmux, prefer \`cmux_browser_*\` tools end-to-end so locks, recovery, checkpoints, and shared-surface coordination remain consistent.
- Treat every mutating browser step as a plan/act/verify loop. For research/scraping, use selective crawling: extract links, rank by goal/keywords, visit only the most relevant pages, checkpoint before risky transitions, and stop at auth/destructive boundaries.
- Fully agentic browsing is allowed for normal UI work (navigation, search, drafting, form filling, opening menus, filtering, extracting, downloading) but irreversible/externally visible actions must stop for explicit user approval first. Examples requiring approval: Post/Publish, Save profile changes, Send message, Connect/Follow, Submit/Apply, Delete/Remove, Purchase/Pay/Transfer, account/security changes, and accepting final confirmation dialogs.
`;

function ensureDir(path: string) {
	mkdirSync(path, { recursive: true });
}

function initializeStorage() {
	ensureDir(BASE_DIR);
	ensureDir(CHECKPOINT_DIR);
	ensureDir(STATE_DIR);
	ensureDir(SKILLS_DIR);
	ensureDir(INTERACTION_SKILLS_DIR);
	ensureDir(DOMAIN_SKILLS_DIR);
	ensureStarterSkillPacks();
}

function ok(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function fail(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: `Error: ${text}` }],
		details: { error: true, ...details },
	};
}

function recoveryHintText(message: string, params: { surface?: string; goal?: string; action?: string } = {}) {
	const parts = [String(message || "Unknown browser error")];
	const actionLabel = params.action ? ` after ${params.action}` : "";
	parts.push(`Hint: If the page may be blocked, stale, modal-interrupted, or semantically ambiguous${actionLabel}, run cmux_browser_recover with strategy=\"auto\" before retrying blindly.`);
	if (params.surface) parts.push(`Suggested params: { "surface": "${params.surface}", "strategy": "auto"${params.goal ? `, "goal": "${String(params.goal).replace(/"/g, '\\"')}"` : ""} }`);
	return parts.join("\n");
}

function failWithRecoveryHint(message: string, details: Record<string, unknown> = {}, params: { surface?: string; goal?: string; action?: string } = {}) {
	return fail(recoveryHintText(message, params), {
		...details,
		suggestedNextTool: "cmux_browser_recover",
		recoverySuggestion: {
			surface: params.surface || null,
			strategy: "auto",
			goal: params.goal || null,
		},
	});
}

function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function parsePossiblyJson(text: string) {
	const trimmed = String(text || "").trim();
	if (!trimmed) return null;
	const once = parseJson(trimmed);
	if (once !== null) {
		if (typeof once === "string") {
			const nested = parseJson(once);
			return nested ?? once;
		}
		return once;
	}
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		return parseJson(trimmed);
	}
	return null;
}

function stringify(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function formatBytes(value: unknown) {
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0) return "—";
	if (num < 1024) return `${Math.round(num)} B`;
	if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
	if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
	return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function uniqueStrings(items: any[]) {
	return Array.from(new Set((items || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string) {
	const seen = new Set<string>();
	const next: T[] = [];
	for (const item of items || []) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		next.push(item);
	}
	return next;
}

function safeKey(input: string) {
	return String(input || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120) || "checkpoint";
}

function readJsonFile(path: string) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function writeJsonFile(path: string, value: unknown) {
	ensureDir(dirname(path));
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function nowIso() {
	return new Date().toISOString();
}

function observationFingerprint(observation: any) {
	try {
		return createHash("sha1").update(JSON.stringify(observation || {})).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

function readLocksRegistry() {
	return readJsonFile(LOCKS_PATH) || { version: 1, locks: {} };
}

function writeLocksRegistry(value: any) {
	writeJsonFile(LOCKS_PATH, value);
}

function readMemoryRegistry() {
	return readJsonFile(MEMORY_PATH) || { version: 1, entries: [] };
}

function writeMemoryRegistry(value: any) {
	writeJsonFile(MEMORY_PATH, value);
}

function parseUrlHostname(value?: string | null) {
	if (!value) return null;
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function inferSiteKey(site?: string | null, url?: string | null) {
	const fromSite = String(site || "").trim().toLowerCase();
	if (fromSite) return fromSite;
	return parseUrlHostname(url) || null;
}

function isLockExpired(lock: any) {
	if (!lock?.expiresAt) return false;
	const stamp = new Date(lock.expiresAt).getTime();
	return Number.isFinite(stamp) ? stamp <= Date.now() : false;
}

function normalizeLockOwnerValue(owner: unknown) {
	const value = typeof owner === "string" ? owner.trim() : "";
	return value || null;
}

function acquireSurfaceLockOwner(params: { owner?: string | null }) {
	if (!Object.prototype.hasOwnProperty.call(params, "owner")) return "agent";
	if (params.owner === undefined) return "agent";
	return normalizeLockOwnerValue(params.owner);
}

function activeLockForSurface(surface: string) {
	const registry = readLocksRegistry();
	const lock = registry?.locks?.[surface] || null;
	if (!lock) return null;
	if (isLockExpired(lock)) {
		delete registry.locks[surface];
		writeLocksRegistry(registry);
		return null;
	}
	return lock;
}

function acquireSurfaceLock(params: { surface: string; owner?: string; team?: string; note?: string; leaseSeconds?: number; force?: boolean }) {
	const registry = readLocksRegistry();
	const existing = registry?.locks?.[params.surface] || null;
	const requestedOwner = acquireSurfaceLockOwner(params);
	if (existing && !isLockExpired(existing) && normalizeLockOwnerValue(existing.owner) !== requestedOwner && !params.force) {
		throw new Error(`Surface ${params.surface} is locked by ${existing.owner}${existing.team ? ` (${existing.team})` : ""}`);
	}
	const leaseSeconds = Math.max(30, Math.min(86_400, Number(params.leaseSeconds || 1_800)));
	const now = nowIso();
	const record = {
		surface: params.surface,
		owner: requestedOwner,
		team: params.team || null,
		note: params.note || null,
		acquiredAt: existing?.acquiredAt || now,
		updatedAt: now,
		leaseSeconds,
		expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
	};
	registry.locks = registry.locks || {};
	registry.locks[params.surface] = record;
	writeLocksRegistry(registry);
	return record;
}

function releaseSurfaceLock(params: { surface: string; owner?: string; force?: boolean }) {
	const registry = readLocksRegistry();
	const existing = registry?.locks?.[params.surface] || null;
	if (!existing) return null;
	if (isLockExpired(existing)) {
		delete registry.locks[params.surface];
		writeLocksRegistry(registry);
		return null;
	}
	const existingOwner = normalizeLockOwnerValue(existing.owner);
	const requestedOwner = normalizeLockOwnerValue(params.owner);
	if (!params.force && existingOwner && !requestedOwner) {
		throw new Error(`owner is required to release the lock on ${params.surface} unless force=true`);
	}
	if (!params.force && existingOwner && requestedOwner && existingOwner !== requestedOwner) {
		throw new Error(`Surface ${params.surface} is locked by ${existing.owner}, not ${params.owner}`);
	}
	delete registry.locks[params.surface];
	writeLocksRegistry(registry);
	return existing;
}

function assertSurfaceLockOwnership(params: { surface: string; owner?: string; team?: string; allowUnlocked?: boolean }) {
	const lock = activeLockForSurface(params.surface);
	if (!lock) {
		if (params.allowUnlocked) return null;
		throw new Error(`Surface ${params.surface} is not currently locked`);
	}
	const expectedOwner = normalizeLockOwnerValue(params.owner);
	if (expectedOwner && normalizeLockOwnerValue(lock.owner) !== expectedOwner) {
		throw new Error(`Surface ${params.surface} is locked by ${lock.owner}, not ${params.owner}`);
	}
	if (params.team && lock.team && lock.team !== params.team) {
		throw new Error(`Surface ${params.surface} is locked for team ${lock.team}, not ${params.team}`);
	}
	return lock;
}

function renewSurfaceLock(params: { surface: string; owner?: string; team?: string; note?: string; leaseSeconds?: number; force?: boolean }) {
	const existing = activeLockForSurface(params.surface);
	if (!existing) throw new Error(`Surface ${params.surface} is not currently locked`);
	const existingOwner = normalizeLockOwnerValue(existing.owner);
	const requestedOwner = normalizeLockOwnerValue(params.owner);
	if (!params.force && existingOwner && !requestedOwner) {
		throw new Error(`owner is required to renew the lock on ${params.surface} unless force=true`);
	}
	if (!params.force && requestedOwner && existingOwner && existingOwner !== requestedOwner) {
		throw new Error(`Surface ${params.surface} is locked by ${existing.owner}, not ${params.owner}`);
	}
	if (!params.force && params.team && existing.team && existing.team !== params.team) {
		throw new Error(`Surface ${params.surface} is locked for team ${existing.team}, not ${params.team}`);
	}
	return acquireSurfaceLock({
		surface: params.surface,
		owner: existingOwner,
		team: params.team !== undefined ? params.team : existing.team,
		note: params.note !== undefined ? params.note : existing.note,
		leaseSeconds: params.leaseSeconds ?? existing.leaseSeconds,
		force: Boolean(params.force),
	});
}

function handoffSurfaceLock(params: { surface: string; owner?: string; newOwner: string; team?: string; note?: string; leaseSeconds?: number; force?: boolean }) {
	const existing = activeLockForSurface(params.surface);
	if (!existing) throw new Error(`Surface ${params.surface} is not currently locked`);
	const requestedOwner = normalizeLockOwnerValue(params.owner);
	if (!params.force && !requestedOwner) {
		throw new Error(`owner is required to hand off the lock on ${params.surface} unless force=true`);
	}
	if (!params.force && requestedOwner && normalizeLockOwnerValue(existing.owner) !== requestedOwner) {
		throw new Error(`Surface ${params.surface} is locked by ${existing.owner}, not ${params.owner}`);
	}
	if (!params.force && params.team && existing.team && existing.team !== params.team) {
		throw new Error(`Surface ${params.surface} is locked for team ${existing.team}, not ${params.team}`);
	}
	const record = acquireSurfaceLock({
		surface: params.surface,
		owner: params.newOwner,
		team: params.team !== undefined ? params.team : existing.team,
		note: params.note !== undefined ? params.note : existing.note,
		leaseSeconds: params.leaseSeconds ?? existing.leaseSeconds,
		force: true,
	});
	return { previous: existing, record };
}

function sweepExpiredLocks() {
	const registry = readLocksRegistry();
	const removed = [] as any[];
	for (const [surface, lock] of Object.entries(registry.locks || {})) {
		if (!isLockExpired(lock)) continue;
		removed.push({ surface, ...(lock as any) });
		delete registry.locks[surface];
	}
	if (removed.length) writeLocksRegistry(registry);
	return { removed, removedCount: removed.length };
}

function upsertMemoryEntry(entry: any) {
	const registry = readMemoryRegistry();
	const key = entry.key || `memory-${safeKey((entry.site || entry.title || "site") + "-" + Date.now())}`;
	const existingIndex = (registry.entries || []).findIndex((item: any) => item.key === key);
	const previous = existingIndex >= 0 ? registry.entries[existingIndex] : null;
	const record = {
		key,
		site: entry.site || null,
		kind: entry.kind || "note",
		title: entry.title || null,
		content: entry.content || null,
		url: entry.url || null,
		tags: uniqueStrings(entry.tags || []),
		attribution: entry.attribution || previous?.attribution || null,
		confidence: entry.confidence ?? previous?.confidence ?? null,
		lastVerifiedAt: entry.lastVerifiedAt || previous?.lastVerifiedAt || null,
		deprecated: entry.deprecated ?? previous?.deprecated ?? false,
		createdAt: previous?.createdAt || nowIso(),
		updatedAt: nowIso(),
	};
	registry.entries = registry.entries || [];
	if (existingIndex >= 0) registry.entries[existingIndex] = record;
	else registry.entries.unshift(record);
	writeMemoryRegistry(registry);
	return record;
}

function recallMemoryEntries(params: { site?: string | null; query?: string | null; kind?: string | null; limit?: number }) {
	const registry = readMemoryRegistry();
	const site = String(params.site || "").trim().toLowerCase();
	const query = String(params.query || "").trim().toLowerCase();
	const kind = String(params.kind || "").trim().toLowerCase();
	let entries = (registry.entries || []).slice();
	if (site) entries = entries.filter((entry: any) => String(entry.site || "").toLowerCase() === site);
	if (kind) entries = entries.filter((entry: any) => String(entry.kind || "").toLowerCase() === kind);
	if (query) {
		entries = entries.filter((entry: any) => {
			const hay = [entry.key, entry.site, entry.kind, entry.title, entry.content, entry.url, entry.attribution, ...(entry.tags || [])].join(" ").toLowerCase();
			return hay.includes(query);
		});
		entries = entries.sort((a: any, b: any) => {
			const ah = [a.title, a.content, ...(a.tags || [])].join(" ").toLowerCase().includes(query) ? 1 : 0;
			const bh = [b.title, b.content, ...(b.tags || [])].join(" ").toLowerCase().includes(query) ? 1 : 0;
			return bh - ah || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
		});
	} else {
		entries = entries.sort((a: any, b: any) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
	}
	return entries.slice(0, Math.max(1, Math.min(100, Number(params.limit || 10))));
}

function deleteMemoryEntries(params: { key?: string | null; site?: string | null }) {
	const registry = readMemoryRegistry();
	const before = (registry.entries || []).length;
	if (params.key) {
		registry.entries = (registry.entries || []).filter((entry: any) => entry.key !== params.key);
	} else if (params.site) {
		const site = String(params.site || "").trim().toLowerCase();
		registry.entries = (registry.entries || []).filter((entry: any) => String(entry.site || "").toLowerCase() !== site);
	}
	writeMemoryRegistry(registry);
	return { removed: before - (registry.entries || []).length, entries: registry.entries || [] };
}

function resolveCmuxBinary() {
	return process.env.CMUX_BUNDLED_CLI_PATH || detectBinary("cmux");
}

function installHelp() {
	return [
		"cmux CLI was not found.",
		"Install cmux from https://cmux.com/docs/getting-started",
		"Homebrew:",
		"  brew tap manaflow-ai/cmux",
		"  brew install --cask cmux",
	].join("\n");
}

function addFlag(args: string[], flag: string, value: unknown) {
	if (value === undefined || value === null || value === "") return;
	args.push(flag, String(value));
}

function addBoolFlag(args: string[], flag: string, enabled?: boolean) {
	if (enabled) args.push(flag);
}

async function execCmux(
	pi: ExtensionAPI,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeout?: number;
	} = {},
) {
	const binary = resolveCmuxBinary();
	if (!binary) throw new Error(installHelp());

	const result = await pi.exec(binary, args, {
		signal: options.signal,
		timeout: options.timeout ?? DEFAULT_TIMEOUT,
	});

	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const code = result.code ?? 0;
	if (code !== 0) {
		throw new Error((stderr || stdout || `cmux exited with code ${code}`).trim());
	}

	return {
		binary,
		args,
		stdout,
		stderr,
		code,
	};
}

async function execCmuxJson(
	pi: ExtensionAPI,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeout?: number;
	} = {},
) {
	const result = await execCmux(pi, args, options);
	const data = parseJson(result.stdout);
	if (data === null) {
		throw new Error(`Expected JSON from cmux, got:\n${result.stdout || result.stderr}`);
	}
	return { ...result, data };
}

async function execCmuxRpc(
	pi: ExtensionAPI,
	method: string,
	params: Record<string, unknown> = {},
	options: {
		signal?: AbortSignal;
		timeout?: number;
	} = {},
) {
	return execCmuxJson(pi, ["rpc", method, JSON.stringify(params || {})], options);
}

async function execBrowser(
	pi: ExtensionAPI,
	surface: string | undefined,
	browserArgs: string[],
	options: { signal?: AbortSignal; timeout?: number } = {},
) {
	const args = ["browser"] as string[];
	addFlag(args, "--surface", surface);
	args.push(...browserArgs);
	return execCmux(pi, args, options);
}

async function execBrowserText(
	pi: ExtensionAPI,
	surface: string | undefined,
	browserArgs: string[],
	options: { signal?: AbortSignal; timeout?: number } = {},
) {
	const result = await execBrowser(pi, surface, browserArgs, options);
	return (result.stdout || "").trim();
}

async function execBrowserJson(
	pi: ExtensionAPI,
	surface: string | undefined,
	browserArgs: string[],
	options: { signal?: AbortSignal; timeout?: number } = {},
) {
	const text = await execBrowserText(pi, surface, browserArgs, options);
	const data = parsePossiblyJson(text);
	if (data === null) {
		throw new Error(`Expected JSON from cmux browser, got:\n${text}`);
	}
	return data;
}

function decodeHtmlEntities(value: string) {
	return String(value || "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_m, code) => {
			const num = Number(code);
			return Number.isFinite(num) ? String.fromCodePoint(num) : "";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_m, code) => {
			const num = Number.parseInt(code, 16);
			return Number.isFinite(num) ? String.fromCodePoint(num) : "";
		});
}

function htmlText(value: string) {
	return decodeHtmlEntities(String(value || "")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|section|article|button|a)>/gi, "\n")
		.replace(/<[^>]+>/g, " "))
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\n\s+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function parseHtmlAttrs(attrText: string) {
	const attrs: Record<string, string> = {};
	const re = /([:@\w.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(String(attrText || "")))) {
		const name = String(match[1] || "").toLowerCase();
		if (!name) continue;
		attrs[name] = decodeHtmlEntities(match[3] ?? match[4] ?? match[5] ?? "");
	}
	return attrs;
}

function cssAttrSelector(attr: string, value: string, tag = "") {
	const escaped = String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `${tag || ""}[${attr}="${escaped}"]`;
}

function cssAttrContainsSelector(attr: string, value: string, tag = "") {
	let needle = String(value || "").trim();
	try {
		const url = new URL(needle);
		needle = url.pathname && url.pathname !== "/" ? url.pathname : url.hostname;
	} catch {
		// not a URL
	}
	needle = needle.replace(/\s+/g, " ").slice(0, 80).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `${tag || ""}[${attr}*="${needle}"]`;
}

function normForMatch(value: string) {
	return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function textMatchesCandidate(haystack: string, target: string, exact?: boolean) {
	const hay = normForMatch(haystack);
	const needle = normForMatch(target);
	if (!needle) return false;
	return exact ? hay === needle : hay.includes(needle);
}

function extractNativeCandidatesFromHtml(html: string, targetKind = "any") {
	const candidates: any[] = [];
	const seen = new Set<string>();
	const add = (candidate: any) => {
		if (!candidate?.selector) return;
		const key = `${candidate.selector}|${candidate.text || ""}|${candidate.kind || ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};
	const kindAllows = (kind: string) => {
		if (!targetKind || targetKind === "any") return true;
		if (targetKind === "button") return kind === "button" || kind === "link";
		return kind === targetKind;
	};
	const openTagRe = /<([a-z][\w:-]*)\b([^>]*)>/gi;
	let open: RegExpExecArray | null;
	while ((open = openTagRe.exec(html || ""))) {
		const tag = String(open[1] || "").toLowerCase();
		const attrs = parseHtmlAttrs(open[2] || "");
		const role = String(attrs.role || "").toLowerCase();
		const type = String(attrs.type || "").toLowerCase();
		let kind = "any";
		if (tag === "a" || role === "link") kind = "link";
		else if (tag === "button" || role === "button" || type === "button" || type === "submit") kind = "button";
		else if (tag === "input" || tag === "textarea" || attrs.contenteditable === "true" || role === "textbox") kind = "input";
		else if (tag === "select") kind = "select";
		else if (type === "checkbox" || role === "checkbox") kind = "checkbox";
		if (!kindAllows(kind) && !(attrs["aria-label"] || attrs.placeholder || attrs.title || attrs.alt)) continue;
		const label = attrs["aria-label"] || attrs.placeholder || attrs.title || attrs.alt || attrs.name || attrs.id || "";
		let selector = null;
		if (attrs["aria-label"]) selector = cssAttrSelector("aria-label", attrs["aria-label"], "");
		else if (attrs.placeholder) selector = cssAttrSelector("placeholder", attrs.placeholder, tag === "textarea" ? "textarea" : "input");
		else if (attrs.name) selector = cssAttrSelector("name", attrs.name, tag);
		else if (attrs.id) selector = cssAttrSelector("id", attrs.id, tag);
		else if (attrs.href) selector = cssAttrContainsSelector("href", attrs.href, "a");
		if (selector && label) add({ kind, tag, text: label, selector, source: "attribute", attrs });
	}
	const pairedRe = /<(a|button|div|span)\b([^>]*)>([\s\S]{0,4000}?)<\/\1>/gi;
	let paired: RegExpExecArray | null;
	while ((paired = pairedRe.exec(html || ""))) {
		const tag = String(paired[1] || "").toLowerCase();
		const attrs = parseHtmlAttrs(paired[2] || "");
		const role = String(attrs.role || "").toLowerCase();
		let kind = tag === "a" || role === "link" ? "link" : tag === "button" || role === "button" ? "button" : "any";
		if (!kindAllows(kind)) continue;
		const text = htmlText(paired[3] || "").slice(0, 500);
		if (!text) continue;
		let selector = null;
		if (attrs["aria-label"]) selector = cssAttrSelector("aria-label", attrs["aria-label"], "");
		else if (attrs.href) selector = cssAttrContainsSelector("href", attrs.href, "a");
		else if (attrs.id) selector = cssAttrSelector("id", attrs.id, tag);
		if (selector) add({ kind, tag, text, selector, source: "element-text", attrs });
	}
	return candidates;
}

function collectNativeLinks(html: string, limit = DEFAULT_LIMIT) {
	const items: any[] = [];
	const re = /<a\b([^>]*)>([\s\S]{0,3000}?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html || "")) && items.length < limit) {
		const attrs = parseHtmlAttrs(match[1] || "");
		const href = attrs.href || "";
		const text = htmlText(match[2] || "") || attrs["aria-label"] || attrs.title || href;
		if (href || text) items.push({ text: truncate(text, 220), href });
	}
	return uniqueBy(items, (item) => `${item.text}|${item.href}`);
}

function collectNativeButtons(html: string, limit = DEFAULT_LIMIT) {
	const candidates = extractNativeCandidatesFromHtml(html, "button")
		.filter((item: any) => item.text)
		.map((item: any) => ({ text: truncate(item.text, 220), selector: item.selector, kind: item.kind, source: item.source }));
	return uniqueBy(candidates, (item) => `${item.text}|${item.selector}`).slice(0, limit);
}

function collectNativeInputs(html: string, limit = DEFAULT_LIMIT) {
	return extractNativeCandidatesFromHtml(html, "input")
		.map((item: any) => ({ tag: item.tag || "input", type: item.attrs?.type || "input", name: item.attrs?.name || "", id: item.attrs?.id || "", placeholder: item.attrs?.placeholder || "", label: item.attrs?.["aria-label"] || item.text || "", selector: item.selector }))
		.slice(0, limit);
}

function collectNativeHeadings(html: string, limit = DEFAULT_LIMIT) {
	const items: any[] = [];
	const re = /<(h[1-6])\b[^>]*>([\s\S]{0,1000}?)<\/\1>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html || "")) && items.length < limit) {
		const text = htmlText(match[2] || "");
		if (text) items.push({ level: match[1].toLowerCase(), text: truncate(text, 220) });
	}
	return items;
}

function splitNativeCardsFromText(text: string, limit = DEFAULT_LIMIT) {
	const normalized = String(text || "").replace(/\r/g, "");
	const chunks = normalized.split(/\n\s*Feed post\s*\n/gi).slice(1);
	return chunks
		.map((chunk) => chunk.replace(/\n{3,}/g, "\n\n").trim())
		.filter(Boolean)
		.map((chunk) => ({ text: truncate(chunk, 900) }))
		.slice(0, limit);
}

async function collectNativeObservationFallback(
	pi: ExtensionAPI,
	params: { surface?: string; selector?: string; limit?: number; evalError?: string },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const selector = params.selector || "body";
	const limit = Math.max(5, Math.min(50, Number(params.limit || DEFAULT_LIMIT)));
	const [url, title, bodyText, html] = await Promise.all([
		execBrowserText(pi, params.surface, ["url"], { signal, timeout }).catch(() => ""),
		execBrowserText(pi, params.surface, ["get", "title"], { signal, timeout }).catch(() => ""),
		execBrowserText(pi, params.surface, ["get", "text", selector], { signal, timeout }).catch(() => ""),
		execBrowserText(pi, params.surface, ["get", "html", selector], { signal, timeout }).catch(() => ""),
	]);
	const buttons = collectNativeButtons(html, limit);
	const links = collectNativeLinks(html, limit);
	const inputs = collectNativeInputs(html, limit);
	const headings = collectNativeHeadings(html, limit);
	const cards = splitNativeCardsFromText(bodyText, limit);
	const textSample = String(bodyText || htmlText(html)).replace(/\s+/g, " ").trim().slice(0, 1600);
	const alerts = /captcha|verify you are human|try again later|temporarily restricted|sign in/i.test(bodyText) ? [{ text: truncate(bodyText, 300) }] : [];
	return {
		nativeFallback: true,
		fallbackReason: params.evalError || "cmux browser eval unavailable",
		title,
		url,
		readyState: "unknown-native-fallback",
		headings,
		buttons,
		links,
		inputs,
		forms: [],
		alerts,
		errors: params.evalError ? [{ text: `Eval unavailable; used native get/snapshot fallback: ${params.evalError}` }] : [],
		modals: /dialog|modal/i.test(html) ? [{ text: "Possible dialog/modal markup present" }] : [],
		tables: [],
		cards,
		primaryActions: buttons.map((item: any) => item.text).filter((text: string) => /continue|next|submit|sign in|log in|search|save|download|export|checkout|pay|confirm|apply|send|post|follow|connect|message|start/i.test(text)).slice(0, limit),
		textSample,
		counts: {
			buttons: buttons.length,
			links: links.length,
			inputs: inputs.length,
			forms: 0,
			alerts: alerts.length,
			errors: params.evalError ? 1 : 0,
			modals: /dialog|modal/i.test(html) ? 1 : 0,
			tables: 0,
			cards: cards.length,
		},
	};
}

async function resolveNativeSelector(
	pi: ExtensionAPI,
	surface: string | undefined,
	query: { target?: string; targetKind?: string; exact?: boolean },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	if (!query.target) throw new Error("target is required when selector is not provided");
	const html = await execBrowserText(pi, surface, ["get", "html", "body"], { signal, timeout });
	const candidates = extractNativeCandidatesFromHtml(html, query.targetKind || "any")
		.map((candidate: any) => {
			const score = (textMatchesCandidate(candidate.text, query.target || "", query.exact) ? 100 : 0)
				+ (candidate.source === "attribute" ? 20 : 0)
				+ (candidate.kind === query.targetKind ? 10 : 0)
				+ (/aria-label|placeholder/.test(candidate.selector || "") ? 8 : 0);
			return { ...candidate, score };
		})
		.filter((candidate: any) => candidate.score > 0)
		.sort((a: any, b: any) => b.score - a.score);
	const best = candidates[0];
	if (!best) {
		throw new Error(`Unable to resolve semantic target "${query.target}" with native HTML fallback`);
	}
	return {
		ok: true,
		strategy: "native-html",
		selector: best.selector,
		match: best.text,
		score: best.score,
		triedSelector: best.selector,
		candidates: candidates.slice(0, 5).map((item: any) => ({ text: item.text, selector: item.selector, score: item.score, kind: item.kind })),
	};
}

async function nativeExtractFallback(
	pi: ExtensionAPI,
	params: { surface?: string; mode: string; selector?: string; limit?: number; fields?: any[]; evalError?: string },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const selector = params.selector || "body";
	const limit = Math.max(1, Math.min(100, Number(params.limit || DEFAULT_LIMIT)));
	if (params.mode === "fields") {
		const data: any = {};
		for (const field of params.fields || []) {
			if (!field?.selector) {
				data[field?.name || "field"] = null;
				continue;
			}
			const prop = field.property || "text";
			const args = prop === "attr" ? ["get", "attr", field.selector, field.attribute || "href"] : ["get", prop, field.selector];
			data[field.name] = await execBrowserText(pi, params.surface, args, { signal, timeout }).catch(() => null);
		}
		return { mode: params.mode, data, nativeFallback: true, evalError: params.evalError || null };
	}
	const text = await execBrowserText(pi, params.surface, ["get", "text", selector], { signal, timeout }).catch(() => "");
	const html = params.mode === "text" ? "" : await execBrowserText(pi, params.surface, ["get", "html", selector], { signal, timeout }).catch(() => "");
	let data: any = null;
	if (params.mode === "text") data = String(text || "").slice(0, 12000);
	else if (params.mode === "links") data = collectNativeLinks(html, limit);
	else if (params.mode === "buttons") data = collectNativeButtons(html, limit);
	else if (params.mode === "forms") data = [];
	else if (params.mode === "cards") data = splitNativeCardsFromText(text, limit);
	else if (params.mode === "kv") data = [];
	else if (params.mode === "table") data = null;
	else data = { title: await execBrowserText(pi, params.surface, ["get", "title"], { signal, timeout }).catch(() => ""), url: await execBrowserText(pi, params.surface, ["url"], { signal, timeout }).catch(() => ""), text: String(text || "").slice(0, 4000), linkCount: collectNativeLinks(html, 500).length, buttonCount: collectNativeButtons(html, 500).length, inputCount: collectNativeInputs(html, 500).length };
	return { mode: params.mode, data, nativeFallback: true, evalError: params.evalError || null };
}

let browserRuntimeCapabilitiesCache: any = null;

async function getBrowserRuntimeCapabilities(
	pi: ExtensionAPI,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	if (browserRuntimeCapabilitiesCache) return browserRuntimeCapabilitiesCache;
	const help = await execCmux(pi, ["browser", "--help"], { signal, timeout }).then((result) => result.stdout || "").catch(() => "");
	const capabilities = {
		helpAvailable: Boolean(help),
		dialog: /\bdialog\s+<accept\|dismiss>/i.test(help),
		downloadWait: /\bdownload\s+\[wait\]/i.test(help),
		frame: /\bframe\s+<main\|selector>/i.test(help),
		tabList: /\btab\s+<new\|list\|switch\|close/i.test(help),
		networkRequests: /network\s+<route\|unroute\|requests>/i.test(help),
		trace: /\btrace\s+<start\|stop>/i.test(help),
		futureUploadSetFiles: /set[- ]files|upload\s+<|file chooser|chooser/i.test(help),
		missingUploadSetFiles: !/set[- ]files|upload\s+<|file chooser|chooser/i.test(help),
		rawHelpPreview: truncate(String(help || "").trim(), 800),
	};
	browserRuntimeCapabilitiesCache = capabilities;
	return capabilities;
}

function normalizeNetworkEntry(item: any, fallbackIndex = 0) {
	if (typeof item === "string") {
		const methodMatch = item.match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
		const urlMatch = item.match(/https?:\/\/\S+/);
		return {
			id: `${fallbackIndex}:${item}`,
			method: methodMatch?.[1]?.toUpperCase() || null,
			url: urlMatch?.[0] || item,
			status: null,
			type: null,
			raw: item,
		};
	}
	const method = item?.method || item?.request?.method || null;
	const url = item?.url || item?.request?.url || item?.href || null;
	const status = item?.status || item?.response?.status || null;
	const type = item?.resourceType || item?.type || item?.response?.mimeType || null;
		return {
			id: String(item?.id || item?.requestId || `${fallbackIndex}:${method || "?"}:${url || stringify(item)}`),
			method,
			url,
			status,
			type,
			raw: item,
		};
}

function parseBrowserNetworkRequests(raw: string) {
	const text = String(raw || "").trim();
	if (!text) return [] as any[];
	const parsed = parsePossiblyJson(text);
	if (Array.isArray(parsed)) return parsed.map((item: any, index: number) => normalizeNetworkEntry(item, index));
	if (parsed && Array.isArray((parsed as any).requests)) return (parsed as any).requests.map((item: any, index: number) => normalizeNetworkEntry(item, index));
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => normalizeNetworkEntry(line, index));
}

async function captureBrowserNetworkState(
	pi: ExtensionAPI,
	surface: string | undefined,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const capabilities = await getBrowserRuntimeCapabilities(pi, signal, timeout).catch(() => null);
	if (!capabilities?.networkRequests) return null;
	const raw = await execBrowserText(pi, surface, ["network", "requests"], { signal, timeout }).catch(() => "");
	if (!raw) return { raw: "", requests: [], count: 0 };
	const requests = parseBrowserNetworkRequests(raw);
	return { raw, requests, count: requests.length };
}

function diffBrowserNetworkState(before: any, after: any) {
	if (!before || !after) return null;
	const beforeIds = new Set((before.requests || []).map((item: any) => item.id));
	const added = (after.requests || []).filter((item: any) => !beforeIds.has(item.id));
	if (!added.length) return null;
	return {
		beforeCount: before.count || 0,
		afterCount: after.count || 0,
		added,
		addedPreview: added.slice(0, 8),
	};
}

async function listBrowserSurfaces(
	pi: ExtensionAPI,
	workspace?: string | null,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const rpc = await execCmuxRpc(pi, "surface.list", workspace ? { workspace_id: workspace } : {}, { signal, timeout });
	const payload = rpc.data || {};
	return {
		workspace: payload.workspace_ref || workspace || process.env.CMUX_WORKSPACE_ID || null,
		surfaces: (payload.surfaces || []).filter((surface: any) => surface?.type === "browser"),
		raw: payload,
	};
}

function pickPreferredBrowserSurface(surfaces: any[], preferredSurface?: string | null) {
	if (!Array.isArray(surfaces) || !surfaces.length) return null;
	if (preferredSurface) {
		const exact = surfaces.find((surface: any) => surface.ref === preferredSurface || surface.id === preferredSurface);
		if (exact) return exact;
	}
	const focused = surfaces.find((surface: any) => surface.focused || surface.selected_in_pane);
	return focused || surfaces[0] || null;
}

async function createBrowserSurface(
	pi: ExtensionAPI,
	params: { workspace?: string | null; url?: string | null },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const before = await listBrowserSurfaces(pi, params.workspace || null, signal, timeout).catch(() => ({ workspace: params.workspace || process.env.CMUX_WORKSPACE_ID || null, surfaces: [] }));
	const args = ["new-surface", "--type", "browser"] as string[];
	addFlag(args, "--workspace", params.workspace || process.env.CMUX_WORKSPACE_ID || null);
	addFlag(args, "--url", params.url || null);
	await execCmux(pi, args, { signal, timeout });
	const after = await listBrowserSurfaces(pi, before.workspace || params.workspace || null, signal, timeout);
	const beforeRefs = new Set((before.surfaces || []).map((surface: any) => surface.ref || surface.id));
	const created = after.surfaces.find((surface: any) => !beforeRefs.has(surface.ref || surface.id)) || pickPreferredBrowserSurface(after.surfaces);
	if (!created) throw new Error("Unable to identify the newly created browser surface.");
	return { workspace: after.workspace, surface: created, before, after };
}

async function focusBrowserSurface(
	pi: ExtensionAPI,
	params: { surface: string; workspace?: string | null; flash?: boolean; notifyTitle?: string | null; notifyBody?: string | null },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	await execCmux(pi, ["focus-surface", "--surface", params.surface, ...(params.workspace ? ["--workspace", params.workspace] : [])], { signal, timeout });
	if (params.flash) {
		await execCmux(pi, ["trigger-flash", ...(params.workspace ? ["--workspace", params.workspace] : []), "--surface", params.surface], { signal, timeout }).catch(() => null);
	}
	if (params.notifyTitle) {
		const args = ["notify", "--title", params.notifyTitle] as string[];
		addFlag(args, "--body", params.notifyBody || null);
		addFlag(args, "--workspace", params.workspace || null);
		addFlag(args, "--surface", params.surface);
		await execCmux(pi, args, { signal, timeout }).catch(() => null);
	}
	const snapshot = await execBrowserText(pi, params.surface, ["snapshot", "-i", "--compact", "--max-depth", "2"], { signal, timeout }).catch(() => null);
	return { focused: true, surface: params.surface, workspace: params.workspace || null, snapshot };
}

function truncate(text: string, length = 240) {
	const value = String(text || "").replace(/\s+/g, " ").trim();
	if (value.length <= length) return value;
	return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function shortList(items: any[], limit = DEFAULT_LIMIT, mapper = (item: any) => String(item)) {
	return (items || []).slice(0, limit).map(mapper);
}

function scorePageType(summary: any) {
	const text = [summary.title, summary.textSample, ...(summary.headings || []).map((h: any) => h.text || h)]
		.join(" ")
		.toLowerCase();
	const url = String(summary.url || "").toLowerCase();
	const hasPassword = (summary.inputs || []).some((input: any) => input.type === "password");
	const formCount = Number(summary.counts?.forms || 0);
	const tableCount = Number(summary.counts?.tables || 0);
	const cardCount = Number(summary.counts?.cards || 0);
	const alertCount = Number(summary.counts?.alerts || 0) + Number(summary.counts?.errors || 0);

	if (hasPassword || /sign in|log in|login|password|two-factor|2fa|verify/.test(text + " " + url)) return "auth";
	if (/checkout|billing|payment|pay now|credit card|review order/.test(text + " " + url)) return "checkout";
	if (/search|results|filter|sort by/.test(text) && (cardCount > 2 || tableCount > 0 || /search/.test(url))) return "search-results";
	if (/dashboard|overview|analytics|settings|admin/.test(text + " " + url)) return "dashboard";
	if (tableCount > 0) return "table";
	if (formCount > 0) return "form";
	if (cardCount > 2) return "listing";
	if (/docs|documentation|api|guide|reference/.test(text + " " + url)) return "documentation";
	if (alertCount > 0) return "error-or-alert";
	return "content";
}

function buildObservationSummary(summary: any, options: { includeSnapshot?: boolean } = {}) {
	const lines = [
		"# cmux browser observation",
		"",
		`- surface: ${summary.surface || "default"}`,
		`- page type: ${summary.pageType}`,
		`- title: ${summary.title || "—"}`,
		`- url: ${summary.url || "—"}`,
		`- ready state: ${summary.readyState || "unknown"}`,
		`- counts: buttons=${summary.counts?.buttons || 0}, links=${summary.counts?.links || 0}, inputs=${summary.counts?.inputs || 0}, forms=${summary.counts?.forms || 0}, tables=${summary.counts?.tables || 0}, cards=${summary.counts?.cards || 0}, alerts=${summary.counts?.alerts || 0}, modals=${summary.counts?.modals || 0}`,
	];

	if (summary.flags?.length) {
		lines.push(`- flags: ${summary.flags.join(", ")}`);
	}
	if (summary.headings?.length) {
		lines.push("", "## Headings", ...shortList(summary.headings, 8, (item) => `- ${item.text || item}`));
	}
	if (summary.primaryActions?.length) {
		lines.push("", "## Primary actions", ...shortList(summary.primaryActions, 8, (item) => `- ${item}`));
	}
	if (summary.forms?.length) {
		lines.push(
			"",
			"## Forms",
			...shortList(summary.forms, 5, (form) => {
				const actions = (form.buttonTexts || []).slice(0, 4).join(", ");
				return `- form ${form.index}: fields=${form.fieldCount}, buttons=${actions || "—"}`;
			}),
		);
	}
	if (summary.inputs?.length) {
		lines.push(
			"",
			"## Inputs",
			...shortList(summary.inputs, 8, (input) => `- ${input.type || "input"}: ${input.label || input.name || input.placeholder || input.id || "unnamed"}`),
		);
	}
	if (summary.alerts?.length || summary.errors?.length) {
		lines.push(
			"",
			"## Alerts / errors",
			...shortList([...(summary.alerts || []), ...(summary.errors || [])], 8, (item) => `- ${truncate(item.text || item, 180)}`),
		);
	}
	if (summary.textSample) {
		lines.push("", "## Text sample", truncate(summary.textSample, 500));
	}
	if (options.includeSnapshot && summary.interactiveSnapshot) {
		lines.push("", "## Interactive snapshot", "```text", summary.interactiveSnapshot, "```");
	}
	return lines.join("\n");
}

function buildFlags(summary: any) {
	const flags = [] as string[];
	if ((summary.modals || []).length) flags.push("modal-present");
	if ((summary.alerts || []).length || (summary.errors || []).length) flags.push("alerts-present");
	if ((summary.inputs || []).some((input: any) => input.type === "password")) flags.push("auth-boundary");
	if ((summary.buttons || []).some((button: any) => /delete|remove|publish|submit|confirm|pay/i.test(button.text || ""))) flags.push("destructive-or-commit-action-visible");
	if ((summary.forms || []).length > 0) flags.push("form-step");
	if ((summary.tables || []).length > 0) flags.push("data-table");
	return flags;
}

function safeCollection(input: string) {
	return safeKey(input || "default");
}

function checkpointPaths(key: string, collection?: string) {
	const safe = safeKey(key);
	const collectionKey = collection ? safeCollection(collection) : null;
	return {
		key: safe,
		collection: collectionKey,
		jsonPath: collectionKey ? join(CHECKPOINT_DIR, collectionKey, `${safe}.json`) : join(CHECKPOINT_DIR, `${safe}.json`),
		statePath: collectionKey ? join(STATE_DIR, collectionKey, `${safe}.json`) : join(STATE_DIR, `${safe}.json`),
	};
}

function walkJsonFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return walkJsonFiles(full);
		return entry.isFile() && entry.name.endsWith(".json") ? [full] : [];
	});
}

function listCheckpointEntries(options: { limit?: number; query?: string; pageType?: string; urlContains?: string; tag?: string; collection?: string; bookmarkedOnly?: boolean } = {}) {
	if (!existsSync(CHECKPOINT_DIR)) return [] as any[];
	const query = String(options.query || "").trim().toLowerCase();
	const pageTypeFilter = String(options.pageType || "").trim().toLowerCase();
	const urlContains = String(options.urlContains || "").trim().toLowerCase();
	const tagFilter = String(options.tag || "").trim().toLowerCase();
	const collectionFilter = String(options.collection || "").trim().toLowerCase();
	return walkJsonFiles(CHECKPOINT_DIR)
		.map((checkpointPath) => {
			const payload = readJsonFile(checkpointPath) || {};
			const relative = checkpointPath.slice(CHECKPOINT_DIR.length + 1);
			const inferredCollection = relative.includes("/") ? relative.split("/")[0] : null;
			const fileName = checkpointPath.split("/").pop() || "checkpoint.json";
			const fallbackStatePath = payload.statePath || join(STATE_DIR, relative);
			const normalized = normalizeCheckpointRecord(payload, {
				key: payload.key || fileName.replace(/\.json$/, ""),
				collection: payload.collection || inferredCollection || null,
				checkpointPath,
				statePath: fallbackStatePath,
				stateSize: checkpointFileSize(fallbackStatePath),
			});
			const checkpoint = normalized.checkpoint;
			const checkpointSize = checkpointFileSize(checkpointPath);
			const stateSize = checkpointFileSize(checkpoint.statePath);
			return {
				key: checkpoint.key,
				collection: checkpoint.collection || inferredCollection || null,
				note: checkpoint.note || null,
				observedAt: checkpoint.observedAt || null,
				url: checkpoint.observation?.url || null,
				title: checkpoint.observation?.title || null,
				pageType: checkpoint.observation?.pageType || null,
				flags: checkpoint.observation?.flags || [],
				primaryActions: checkpoint.observation?.primaryActions || [],
				tags: uniqueStrings(checkpoint.tags || []),
				bookmarked: Boolean(checkpoint.bookmarked),
				statePath: checkpoint.statePath,
				checkpointPath,
				checkpointSize,
				stateSize,
				bytes: checkpointSize + stateSize,
				hasState: existsSync(checkpoint.statePath),
				legacy: normalized.legacy,
			};
		})
		.filter((entry: any) => !pageTypeFilter || String(entry.pageType || "").toLowerCase() === pageTypeFilter)
		.filter((entry: any) => !urlContains || String(entry.url || "").toLowerCase().includes(urlContains))
		.filter((entry: any) => !collectionFilter || String(entry.collection || "").toLowerCase() === collectionFilter)
		.filter((entry: any) => !options.bookmarkedOnly || entry.bookmarked)
		.filter((entry: any) => !tagFilter || (entry.tags || []).some((tag: string) => tag.toLowerCase() === tagFilter))
		.filter((entry: any) => {
			if (!query) return true;
			const hay = [entry.key, entry.collection, entry.note, entry.url, entry.title, entry.pageType, ...(entry.flags || []), ...(entry.primaryActions || []), ...(entry.tags || [])]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return hay.includes(query);
		})
		.sort((a: any, b: any) => String(b.observedAt || "").localeCompare(String(a.observedAt || "")))
		.slice(0, Math.max(1, Math.min(200, Number(options.limit || 50))));
}

function resolveCheckpointRecord(key: string, collection?: string) {
	const safe = safeKey(key);
	if (collection) {
		const paths = checkpointPaths(safe, collection);
		const checkpoint = readJsonFile(paths.jsonPath);
		return normalizeResolvedCheckpoint({ paths, checkpoint });
	}
	const matches = listCheckpointEntries({ limit: 500, query: safe }).filter((entry: any) => String(entry.key || "") === safe);
	if (matches.length) {
		const best = matches[0];
		return normalizeResolvedCheckpoint({
			paths: {
				key: best.key,
				collection: best.collection || null,
				jsonPath: best.checkpointPath,
				statePath: best.statePath,
			},
			checkpoint: readJsonFile(best.checkpointPath),
		});
	}
	const paths = checkpointPaths(safe);
	return normalizeResolvedCheckpoint({ paths, checkpoint: readJsonFile(paths.jsonPath) });
}

function normalizeResolvedCheckpoint(resolved: any) {
	const checkpoint = resolved?.checkpoint || readJsonFile(resolved?.paths?.jsonPath);
	if (!checkpoint || !resolved?.paths) return resolved;
	const normalized = normalizeCheckpointRecord(checkpoint, {
		key: resolved.paths.key,
		collection: resolved.paths.collection || null,
		checkpointPath: resolved.paths.jsonPath,
		statePath: resolved.paths.statePath,
		stateSize: checkpointFileSize(resolved.paths.statePath),
	});
	if (normalized.changed) writeJsonFile(resolved.paths.jsonPath, normalized.checkpoint);
	return { ...resolved, checkpoint: normalized.checkpoint, normalized: normalized.changed, legacy: normalized.legacy };
}

function moveCheckpointRecord(current: any, target: { key: string; collection?: string | null; jsonPath: string; statePath: string }) {
	if (existsSync(target.jsonPath) || existsSync(target.statePath)) throw new Error(`Target checkpoint already exists: ${target.key}`);
	mkdirSync(dirname(target.jsonPath), { recursive: true });
	mkdirSync(dirname(target.statePath), { recursive: true });
	if (existsSync(current.paths.jsonPath)) renameSync(current.paths.jsonPath, target.jsonPath);
	if (existsSync(current.paths.statePath)) renameSync(current.paths.statePath, target.statePath);
	const checkpoint = readJsonFile(target.jsonPath) || current.checkpoint || {};
	checkpoint.key = target.key;
	checkpoint.collection = target.collection || null;
	checkpoint.checkpointPath = target.jsonPath;
	checkpoint.statePath = target.statePath;
	checkpoint.movedAt = new Date().toISOString();
	writeJsonFile(target.jsonPath, checkpoint);
	return checkpoint;
}

function checkpointFileSize(path: string) {
	try {
		return statSync(path).size || 0;
	} catch {
		return 0;
	}
}

function readCheckpointPolicy() {
	const current = readJsonFile(CHECKPOINT_POLICY_PATH) || {};
	return {
		version: 1,
		autoPruneEnabled: current.autoPruneEnabled !== false,
		maxAgeHours: Math.max(1, Number(current.maxAgeHours || 168)),
		maxEntries: Math.max(10, Number(current.maxEntries || 250)),
		maxTotalBytes: Math.max(1024 * 1024, Number(current.maxTotalBytes || 200 * 1024 * 1024)),
	};
}

function writeCheckpointPolicy(patch: any = {}) {
	const current = readCheckpointPolicy();
	const next = {
		...current,
		version: 1,
		autoPruneEnabled: typeof patch.autoPruneEnabled === "boolean" ? patch.autoPruneEnabled : current.autoPruneEnabled,
		maxAgeHours: Math.max(1, Number(patch.maxAgeHours ?? current.maxAgeHours ?? 168)),
		maxEntries: Math.max(10, Number(patch.maxEntries ?? current.maxEntries ?? 250)),
		maxTotalBytes: Math.max(1024 * 1024, Number(patch.maxTotalBytes ?? current.maxTotalBytes ?? 200 * 1024 * 1024)),
	};
	writeJsonFile(CHECKPOINT_POLICY_PATH, next);
	return next;
}

function pruneCheckpointStorage(options: { maxAgeHours?: number; maxEntries?: number; maxTotalBytes?: number; dryRun?: boolean } = {}) {
	const entries = listCheckpointEntries({ limit: 5000 }).map((entry: any) => ({
		...entry,
		checkpointSize: checkpointFileSize(entry.checkpointPath),
		stateSize: checkpointFileSize(entry.statePath),
		bytes: checkpointFileSize(entry.checkpointPath) + checkpointFileSize(entry.statePath),
		anchorMs: entry.observedAt ? new Date(entry.observedAt).getTime() : 0,
	})).sort((a: any, b: any) => Number(b.anchorMs || 0) - Number(a.anchorMs || 0));
	const retained = [...entries];
	const removed = [] as any[];
	const maxAgeMs = Math.max(1, Number(options.maxAgeHours || 168)) * 60 * 60 * 1000;
	const maxEntries = Math.max(1, Number(options.maxEntries || 250));
	const maxTotalBytes = Math.max(1024 * 1024, Number(options.maxTotalBytes || 200 * 1024 * 1024));
	const moveToRemoved = (entry: any, reason: string) => {
		const index = retained.findIndex((item: any) => item.key === entry.key && String(item.collection || "") === String(entry.collection || ""));
		if (index === -1) return;
		retained.splice(index, 1);
		removed.push({ ...entry, reason });
	};
	for (const entry of [...retained]) {
		const ageMs = entry.anchorMs ? Date.now() - entry.anchorMs : Number.POSITIVE_INFINITY;
		if (ageMs >= maxAgeMs) moveToRemoved(entry, "age");
	}
	while (retained.length > maxEntries) moveToRemoved(retained[retained.length - 1], "count-cap");
	const totalBytes = () => retained.reduce((sum: number, entry: any) => sum + Number(entry.bytes || 0), 0);
	while (retained.length && totalBytes() > maxTotalBytes) moveToRemoved(retained[retained.length - 1], "size-cap");
	if (options.dryRun !== true) {
		for (const entry of removed) {
			if (existsSync(entry.checkpointPath)) rmSync(entry.checkpointPath, { force: true });
			if (existsSync(entry.statePath)) rmSync(entry.statePath, { force: true });
		}
	}
	return {
		removed,
		removedCount: removed.length,
		retainedCount: retained.length,
		totalBytesAfter: totalBytes(),
		totalBytesBefore: entries.reduce((sum: number, entry: any) => sum + Number(entry.bytes || 0), 0),
	};
}

function buildObserveScript(options: { limit?: number; selector?: string } = {}) {
	const config = {
		limit: Math.max(5, Math.min(50, Number(options.limit || DEFAULT_LIMIT))),
		selector: options.selector || null,
	};
	return `(() => {
		const config = ${JSON.stringify(config)};

		try {		const root = config.selector ? document.querySelector(config.selector) : document.body;
		if (!root) {
			return JSON.stringify({ error: 'Root selector not found', selector: config.selector });
		}
		const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
		const visible = (el) => {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const textOf = (el) => norm(el.innerText || el.textContent || '');
		const attr = (el, name) => norm(el.getAttribute(name) || '');
		const labelOf = (el) => {
			const aria = attr(el, 'aria-label');
			if (aria) return aria;
			if (el.labels && el.labels.length) {
				const labels = Array.from(el.labels).map((label) => textOf(label)).filter(Boolean);
				if (labels.length) return labels.join(' ');
			}
			const id = attr(el, 'id');
			if (id) {
				const explicit = document.querySelector('label[for="' + CSS.escape(id) + '"]');
				if (explicit) return textOf(explicit);
			}
			const wrapping = el.closest('label');
			if (wrapping) return textOf(wrapping);
			return '';
		};
		const pick = (nodes, mapper) => Array.from(nodes).filter(visible).slice(0, config.limit).map(mapper);
		const headings = pick(root.querySelectorAll('h1,h2,h3,h4'), (el) => ({ level: el.tagName.toLowerCase(), text: textOf(el) }));
		const buttons = pick(root.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'), (el) => ({
			text: textOf(el) || attr(el, 'value') || attr(el, 'aria-label') || attr(el, 'title'),
			disabled: !!el.disabled || attr(el, 'aria-disabled') === 'true',
			type: attr(el, 'type') || el.tagName.toLowerCase(),
		})).filter((item) => item.text);
		const links = pick(root.querySelectorAll('a[href], [role="link"]'), (el) => ({
			text: textOf(el) || attr(el, 'aria-label') || attr(el, 'title'),
			href: el.href || attr(el, 'href'),
		})).filter((item) => item.text || item.href);
		const inputNodes = root.querySelectorAll('input, textarea, select');
		const inputs = pick(inputNodes, (el) => ({
			tag: el.tagName.toLowerCase(),
			type: attr(el, 'type') || el.tagName.toLowerCase(),
			name: attr(el, 'name'),
			id: attr(el, 'id'),
			placeholder: attr(el, 'placeholder'),
			label: labelOf(el),
			required: el.required || attr(el, 'aria-required') === 'true',
			disabled: !!el.disabled || attr(el, 'aria-disabled') === 'true',
			checked: !!el.checked,
		}));
		const forms = pick(root.querySelectorAll('form'), (form, index) => ({
			index,
			method: attr(form, 'method') || 'get',
			action: attr(form, 'action') || location.href,
			fieldCount: form.querySelectorAll('input, textarea, select').length,
			buttonTexts: Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
				.filter(visible)
				.slice(0, 6)
				.map((el) => textOf(el) || attr(el, 'value'))
				.filter(Boolean),
		}));
		const alerts = pick(root.querySelectorAll('[role="alert"], [aria-live], .alert, .notice, .toast, .notification'), (el) => ({ text: textOf(el) }));
		const errors = pick(root.querySelectorAll('[aria-invalid="true"], .error, .errors, .field-error, .form-error, .invalid-feedback'), (el) => ({ text: textOf(el) || labelOf(el) || attr(el, 'aria-label') }));
		const modals = pick(root.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], .modal'), (el) => ({ text: textOf(el).slice(0, 300) }));
		const tables = pick(root.querySelectorAll('table'), (el, index) => ({
			index,
			rows: el.querySelectorAll('tr').length,
			columns: Math.max(...Array.from(el.querySelectorAll('tr')).slice(0, 3).map((row) => row.children.length), 0),
		}));
		const cards = pick(root.querySelectorAll('article, li, [data-card], .card, .result, .search-result'), (el) => ({ text: textOf(el).slice(0, 160) })).filter((item) => item.text);
		const textSample = norm(root.innerText || root.textContent || '').slice(0, 1600);
		const primaryActions = buttons
			.map((item) => item.text)
			.filter((text) => /continue|next|submit|sign in|log in|search|save|download|export|checkout|pay|confirm|apply|send/i.test(text))
			.slice(0, config.limit);
		return JSON.stringify({
			title: document.title || '',
			url: location.href,
			readyState: document.readyState,
			headings,
			buttons,
			links,
			inputs,
			forms,
			alerts,
			errors,
			modals,
			tables,
			cards,
			primaryActions,
			textSample,
			counts: {
				buttons: buttons.length,
				links: links.length,
				inputs: inputs.length,
				forms: forms.length,
				alerts: alerts.length,
				errors: errors.length,
				modals: modals.length,
				tables: tables.length,
				cards: cards.length,
			},
		});
		} catch (error) {
			return JSON.stringify({ error: 'observe-script-error', message: String(error && (error.message || error)), stack: String(error && error.stack || '').slice(0, 1200), title: document.title || '', url: location.href, readyState: document.readyState, headings: [], buttons: [], links: [], inputs: [], forms: [], alerts: [], errors: [{ text: String(error && (error.message || error)) }], modals: [], tables: [], cards: [], primaryActions: [], textSample: String(document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 1600), counts: { buttons: 0, links: 0, inputs: 0, forms: 0, alerts: 0, errors: 1, modals: 0, tables: 0, cards: 0 } });
		}
	})();`;
}

function buildResolverScript(query: Record<string, unknown>) {
	return `(() => {
		const query = ${JSON.stringify(query)};

		try {		const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
		const lower = (value) => norm(value).toLowerCase();
		const visible = (el) => {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const textOf = (el) => norm(el.innerText || el.textContent || '');
		const attr = (el, name) => norm(el.getAttribute(name) || '');
		const selectorOf = (el) => {
			if (!el || !el.tagName) return null;
			const parts = [el.tagName.toLowerCase()];
			const id = attr(el, 'id');
			if (id) parts.push('#' + CSS.escape(id));
			const name = attr(el, 'name');
			if (name) parts.push('[name=' + JSON.stringify(name) + ']');
			const type = attr(el, 'type');
			if (type) parts.push('[type=' + JSON.stringify(type) + ']');
			return parts.join('');
		};
		const labelOf = (el) => {
			const values = [];
			if (el.labels && el.labels.length) values.push(...Array.from(el.labels).map((label) => textOf(label)).filter(Boolean));
			const id = attr(el, 'id');
			const root = el.getRootNode && el.getRootNode();
			if (id && root && typeof root.querySelector === 'function') {
				const explicit = root.querySelector('label[for="' + CSS.escape(id) + '"]');
				if (explicit) values.push(textOf(explicit));
			}
			if (id) {
				const explicitDoc = document.querySelector('label[for="' + CSS.escape(id) + '"]');
				if (explicitDoc) values.push(textOf(explicitDoc));
			}
			const wrapping = el.closest('label');
			if (wrapping) values.push(textOf(wrapping));
			return values.filter(Boolean).join(' ');
		};
		const signature = (el) => [
			textOf(el),
			attr(el, 'aria-label'),
			attr(el, 'title'),
			attr(el, 'placeholder'),
			attr(el, 'name'),
			attr(el, 'id'),
			labelOf(el),
		].filter(Boolean).join(' | ');
		const target = lower(query.target);
		const exact = !!query.exact;
		const kind = query.targetKind || 'any';
		const selectorMap = {
			button: 'button,[role="button"],input[type="button"],input[type="submit"],a',
			link: 'a[href],[role="link"]',
			input: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]',
			checkbox: 'input[type="checkbox"],[role="checkbox"]',
			select: 'select',
			any: 'button,[role="button"],input,textarea,select,a[href],[role="link"],[contenteditable="true"]',
		};
		const baseSelector = selectorMap[kind] || selectorMap.any;
		const roots = [];
		const walkRoots = (root, shadowMeta = null, depth = 0) => {
			if (!root || depth > 6) return;
			roots.push({ root, shadowMeta, depth });
			const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
			for (const el of elements) {
				if (el.shadowRoot) {
					walkRoots(el.shadowRoot, {
						hostSelector: selectorOf(el),
						hostTag: el.tagName.toLowerCase(),
						hostText: textOf(el).slice(0, 160),
					}, depth + 1);
				}
			}
		};
		walkRoots(document, null, 0);
		const candidates = roots.flatMap(({ root, shadowMeta, depth }) => Array.from(root.querySelectorAll ? root.querySelectorAll(baseSelector) : []).filter(visible).map((el) => {
			const signatureText = signature(el);
			const signatureLower = lower(signatureText);
			let score = 0;
			if (!target) score += 1;
			if (target) {
				if (exact && signatureLower === target) score += 120;
				if (signatureLower.includes(target)) score += 80;
				if (lower(textOf(el)) === target) score += 60;
				if (lower(labelOf(el)) === target) score += 60;
				if (lower(attr(el, 'placeholder')) === target) score += 50;
				if (lower(attr(el, 'name')) === target) score += 40;
				if (lower(attr(el, 'id')) === target) score += 30;
			}
			if (kind === 'button' && (el.tagName === 'BUTTON' || attr(el, 'role') === 'button')) score += 10;
			if (kind === 'link' && (el.tagName === 'A' || attr(el, 'role') === 'link')) score += 10;
			if (kind === 'input' && ['INPUT', 'TEXTAREA'].includes(el.tagName)) score += 10;
			if (kind === 'checkbox' && (attr(el, 'type') === 'checkbox' || attr(el, 'role') === 'checkbox')) score += 10;
			if (kind === 'select' && el.tagName === 'SELECT') score += 10;
			if (el.disabled || attr(el, 'aria-disabled') === 'true') score -= 15;
			if (shadowMeta) score += 5;
			return { el, score, signature: signatureText, strategy: shadowMeta ? 'shadow' : 'selector', shadowMeta, depth };
		}))).sort((a, b) => b.score - a.score);
		const best = candidates[0];
		if (!best || best.score <= 0) {
			return JSON.stringify({ ok: false, triedSelector: baseSelector, candidates: candidates.slice(0, 5).map((item) => ({ score: item.score, signature: item.signature, strategy: item.strategy, hostSelector: item.shadowMeta?.hostSelector || null })) });
		}
		best.el.scrollIntoView({ block: 'center', inline: 'center' });
		if (best.strategy === 'shadow') {
			return JSON.stringify({
				ok: true,
				strategy: 'shadow',
				match: best.signature,
				score: best.score,
				triedSelector: baseSelector,
				shadowHostSelector: best.shadowMeta?.hostSelector || null,
				shadowHostTag: best.shadowMeta?.hostTag || null,
				shadowDepth: best.depth || 1,
			});
		}
		const tag = 'cmux-browser-intel-' + Math.random().toString(36).slice(2, 10);
		best.el.setAttribute('data-cmux-browser-intel-target', tag);
		best.el.setAttribute('data-cmux-browser-intel-last-match', best.signature.slice(0, 400));
		return JSON.stringify({
			ok: true,
			strategy: 'selector',
			selector: '[data-cmux-browser-intel-target="' + tag + '"]',
			match: best.signature,
			score: best.score,
			triedSelector: baseSelector,
		});
		} catch (error) {
			return JSON.stringify({ ok: false, error: 'resolver-script-error', message: String(error && (error.message || error)), target: query && query.target || null, candidates: [] });
		}
	})();`;
}

function buildAbsentSelectorScript(selector: string) {
	return `(() => {
		const selector = ${JSON.stringify(selector)};
		const el = document.querySelector(selector);
		if (!el) return JSON.stringify({ absent: true, reason: 'not-found' });
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		const visible = !!style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
		return JSON.stringify({ absent: !visible, reason: visible ? 'still-visible' : 'hidden' });
	})();`;
}

function buildAbsentTextScript(text: string) {
	return `(() => {
		const needle = ${JSON.stringify(String(text || '').toLowerCase())};
		const haystack = String(document.body?.innerText || document.body?.textContent || '').toLowerCase();
		return JSON.stringify({ absent: !haystack.includes(needle) });
	})();`;
}

function buildExtractScript(params: { mode: string; selector?: string; limit?: number; fields?: any[] }) {
	const config = {
		mode: params.mode,
		selector: params.selector || null,
		limit: Math.max(1, Math.min(100, Number(params.limit || DEFAULT_LIMIT))),
		fields: params.fields || [],
	};
	return `(() => {
		const config = ${JSON.stringify(config)};

		try {		const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
		const visible = (el) => {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const textOf = (el) => norm(el.innerText || el.textContent || '');
		const root = config.selector ? document.querySelector(config.selector) : document.body;
		if (!root) return JSON.stringify({ error: 'Root selector not found', selector: config.selector });
		if (config.mode === 'fields') {
			const output = {};
			for (const field of config.fields || []) {
				const el = field.selector ? document.querySelector(field.selector) : null;
				let value = null;
				if (el) {
					if ((field.property || 'text') === 'html') value = el.innerHTML;
					else if (field.property === 'value') value = 'value' in el ? el.value : null;
					else if (field.property === 'attr') value = field.attribute ? el.getAttribute(field.attribute) : null;
					else value = textOf(el);
				}
				output[field.name] = value;
			}
			return JSON.stringify({ mode: 'fields', data: output });
		}
		if (config.mode === 'links') {
			return JSON.stringify({ mode: 'links', data: Array.from(root.querySelectorAll('a[href]')).filter(visible).slice(0, config.limit).map((el) => ({ text: textOf(el), href: el.href || el.getAttribute('href') })) });
		}
		if (config.mode === 'buttons') {
			return JSON.stringify({ mode: 'buttons', data: Array.from(root.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')).filter(visible).slice(0, config.limit).map((el) => ({ text: textOf(el) || el.getAttribute('value') || '', disabled: !!el.disabled })) });
		}
		if (config.mode === 'forms') {
			return JSON.stringify({ mode: 'forms', data: Array.from(root.querySelectorAll('form')).filter(visible).slice(0, config.limit).map((form, index) => ({ index, action: form.getAttribute('action') || location.href, method: form.getAttribute('method') || 'get', fieldCount: form.querySelectorAll('input,textarea,select').length, text: textOf(form).slice(0, 300) })) });
		}
		if (config.mode === 'table') {
			const table = root.matches('table') ? root : root.querySelector('table');
			if (!table) return JSON.stringify({ mode: 'table', data: null });
			const headers = Array.from(table.querySelectorAll('thead th')).map((el) => textOf(el));
			const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, config.limit).map((row) => Array.from(row.children).map((cell) => textOf(cell)));
			return JSON.stringify({ mode: 'table', data: { headers, rows } });
		}
		if (config.mode === 'cards') {
			const cards = Array.from(root.querySelectorAll(config.selector || 'article, li, .card, .result, .search-result, [data-card]')).filter(visible).slice(0, config.limit).map((el) => ({ text: textOf(el).slice(0, 400), links: Array.from(el.querySelectorAll('a[href]')).slice(0, 3).map((a) => ({ text: textOf(a), href: a.href || a.getAttribute('href') })) }));
			return JSON.stringify({ mode: 'cards', data: cards });
		}
		if (config.mode === 'kv') {
			const out = [];
			for (const dt of Array.from(root.querySelectorAll('dt')).slice(0, config.limit)) {
				const dd = dt.nextElementSibling;
				if (dd && dd.tagName === 'DD') out.push({ key: textOf(dt), value: textOf(dd) });
			}
			for (const row of Array.from(root.querySelectorAll('tr')).slice(0, config.limit)) {
				const cells = Array.from(row.children).map((cell) => textOf(cell)).filter(Boolean);
				if (cells.length === 2) out.push({ key: cells[0], value: cells[1] });
			}
			return JSON.stringify({ mode: 'kv', data: out.slice(0, config.limit) });
		}
		if (config.mode === 'text') {
			return JSON.stringify({ mode: 'text', data: textOf(root).slice(0, 5000) });
		}
		const summary = {
			title: document.title || '',
			url: location.href,
			text: textOf(root).slice(0, 2000),
			linkCount: root.querySelectorAll('a[href]').length,
			buttonCount: root.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]').length,
			inputCount: root.querySelectorAll('input,textarea,select').length,
		};
		return JSON.stringify({ mode: 'summary', data: summary });
		} catch (error) {
			return JSON.stringify({ mode: config && config.mode || 'unknown', error: 'extract-script-error', message: String(error && (error.message || error)), data: null });
		}
	})();`;
}

async function collectObservation(
	pi: ExtensionAPI,
	params: { surface?: string; includeSnapshot?: boolean; interactiveSnapshot?: boolean; compact?: boolean; maxDepth?: number; selector?: string; limit?: number },
	signal?: AbortSignal,
) {
	const timeout = DEFAULT_TIMEOUT;
	const surface = params.surface;
	const [identify, url, title, base] = await Promise.all([
		execBrowserText(pi, surface, ["identify"], { signal, timeout }),
		execBrowserText(pi, surface, ["url"], { signal, timeout }).catch(() => ""),
		execBrowserText(pi, surface, ["get", "title"], { signal, timeout }).catch(() => ""),
		execBrowserJson(pi, surface, ["eval", buildObserveScript({ selector: params.selector, limit: params.limit })], { signal, timeout }).catch((error: any) => ({
			__nativeFallbackNeeded: true,
			nativeFallbackReason: `observe-eval-failed: ${error?.message || String(error)}`,
		})),
	]);

	let interactiveSnapshot = "";
	if (params.includeSnapshot !== false) {
		const snapshotArgs = ["snapshot"] as string[];
		if (params.interactiveSnapshot !== false) snapshotArgs.push("-i");
		addBoolFlag(snapshotArgs, "--compact", params.compact !== false);
		addFlag(snapshotArgs, "--max-depth", params.maxDepth ?? DEFAULT_OBSERVE_MAX_DEPTH);
		addFlag(snapshotArgs, "--selector", params.selector);
		interactiveSnapshot = await execBrowserText(pi, surface, snapshotArgs, { signal, timeout }).catch(() => "");
	}

	let effectiveBase = base;
	if (base?.__nativeFallbackNeeded) {
		effectiveBase = await collectNativeObservationFallback(
			pi,
			{ surface, selector: params.selector, limit: params.limit, evalError: base.nativeFallbackReason },
			signal,
			timeout,
		).catch((fallbackError: any) => ({
			error: `observe-native-fallback-failed: ${fallbackError?.message || String(fallbackError)}`,
			title: null,
			url: null,
			readyState: null,
			headings: [],
			buttons: [],
			links: [],
			inputs: [],
			forms: [],
			alerts: [],
			errors: [{ text: base.nativeFallbackReason }, { text: `Native fallback failed: ${fallbackError?.message || String(fallbackError)}` }],
			modals: [],
			tables: [],
			cards: [],
			primaryActions: [],
			textSample: "",
			counts: { buttons: 0, links: 0, inputs: 0, forms: 0, alerts: 0, errors: 2, modals: 0, tables: 0, cards: 0 },
		}));
	}

	const summary = {
		...effectiveBase,
		surface: surface || identify || process.env.CMUX_SURFACE_ID || null,
		url: effectiveBase?.url || url || null,
		title: effectiveBase?.title || title || null,
		interactiveSnapshot,
		pageType: scorePageType(effectiveBase || {}),
	};
	summary.flags = buildFlags(summary);
	return summary;
}

async function resolveSmartSelector(
	pi: ExtensionAPI,
	surface: string | undefined,
	query: { target?: string; targetKind?: string; exact?: boolean },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	if (!query.target) throw new Error("target is required when selector is not provided");
	let resolved: any = null;
	let evalError: any = null;
	try {
		resolved = await execBrowserJson(pi, surface, ["eval", buildResolverScript(query)], { signal, timeout });
	} catch (error: any) {
		evalError = error;
		const nativeResolved = await resolveNativeSelector(pi, surface, query, signal, timeout).catch(() => null);
		if (nativeResolved?.ok) return nativeResolved;
		throw error;
	}
	if (!resolved?.ok || (!resolved?.selector && resolved?.strategy !== "shadow")) {
		const nativeResolved = await resolveNativeSelector(pi, surface, query, signal, timeout).catch(() => null);
		if (nativeResolved?.ok) return nativeResolved;
		throw new Error(
			`Unable to resolve semantic target${query.target ? ` \"${query.target}\"` : ""}${resolved?.candidates?.length ? `; top candidates: ${resolved.candidates.map((c: any) => c.signature).join(" | ")}` : ""}${evalError ? `; eval error: ${evalError.message || String(evalError)}` : ""}`,
		);
	}
	return resolved;
}

async function resetBrowserFrameContext(
	pi: ExtensionAPI,
	surface: string | undefined,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	return execBrowserText(pi, surface, ["frame", "main"], { signal, timeout }).catch(() => null);
}

async function resolveSmartSelectorInFrames(
	pi: ExtensionAPI,
	surface: string | undefined,
	query: { target?: string; targetKind?: string; exact?: boolean },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const inspection = await execBrowserJson(pi, surface, ["eval", buildMechanicInspectScript("iframes")], { signal, timeout }).catch(() => null);
	const frames = (inspection?.frames || []).filter((frame: any) => frame?.selector).sort((a: any, b: any) => Number(b.visible) - Number(a.visible));
	let lastError: any = null;
	for (const frame of frames.slice(0, 8)) {
		try {
			await execBrowserText(pi, surface, ["frame", frame.selector], { signal, timeout });
			const resolved = await resolveSmartSelector(pi, surface, query, signal, timeout);
			return { frame, resolved };
		} catch (error: any) {
			lastError = error;
		}
	}
	await resetBrowserFrameContext(pi, surface, signal, timeout);
	if (lastError) throw lastError;
	return null;
}

function buildShadowActionScript(config: Record<string, unknown>) {
	return `(() => {
		const config = ${JSON.stringify(config)};
		const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
		const lower = (value) => norm(value).toLowerCase();
		const visible = (el) => {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		};
		const textOf = (el) => norm(el.innerText || el.textContent || '');
		const attr = (el, name) => norm(el.getAttribute(name) || '');
		const selectorOf = (el) => {
			if (!el || !el.tagName) return null;
			const parts = [el.tagName.toLowerCase()];
			const id = attr(el, 'id');
			if (id) parts.push('#' + CSS.escape(id));
			const name = attr(el, 'name');
			if (name) parts.push('[name=' + JSON.stringify(name) + ']');
			const type = attr(el, 'type');
			if (type) parts.push('[type=' + JSON.stringify(type) + ']');
			return parts.join('');
		};
		const labelOf = (el) => {
			const values = [];
			if (el.labels && el.labels.length) values.push(...Array.from(el.labels).map((label) => textOf(label)).filter(Boolean));
			const id = attr(el, 'id');
			const root = el.getRootNode && el.getRootNode();
			if (id && root && typeof root.querySelector === 'function') {
				const explicit = root.querySelector('label[for="' + CSS.escape(id) + '"]');
				if (explicit) values.push(textOf(explicit));
			}
			const wrapping = el.closest('label');
			if (wrapping) values.push(textOf(wrapping));
			return values.filter(Boolean).join(' ');
		};
		const signature = (el) => [textOf(el), attr(el, 'aria-label'), attr(el, 'title'), attr(el, 'placeholder'), attr(el, 'name'), attr(el, 'id'), labelOf(el)].filter(Boolean).join(' | ');
		const selectorMap = {
			button: 'button,[role="button"],input[type="button"],input[type="submit"],a',
			link: 'a[href],[role="link"]',
			input: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),textarea,[contenteditable="true"]',
			checkbox: 'input[type="checkbox"],[role="checkbox"]',
			select: 'select',
			any: 'button,[role="button"],input,textarea,select,a[href],[role="link"],[contenteditable="true"]',
		};
		const baseSelector = selectorMap[config.targetKind || 'any'] || selectorMap.any;
		const roots = [];
		const walkRoots = (root, shadowMeta = null, depth = 0) => {
			if (!root || depth > 6) return;
			roots.push({ root, shadowMeta, depth });
			const elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
			for (const el of elements) {
				if (el.shadowRoot) walkRoots(el.shadowRoot, { hostSelector: selectorOf(el), hostTag: el.tagName.toLowerCase() }, depth + 1);
			}
		};
		walkRoots(document, null, 0);
		const target = lower(config.target);
		const exact = !!config.exact;
		const candidates = roots.flatMap(({ root, shadowMeta, depth }) => Array.from(root.querySelectorAll ? root.querySelectorAll(baseSelector) : []).filter(visible).map((el) => {
			const signatureText = signature(el);
			const signatureLower = lower(signatureText);
			let score = 0;
			if (!target) score += 1;
			if (target) {
				if (exact && signatureLower === target) score += 120;
				if (signatureLower.includes(target)) score += 80;
				if (lower(textOf(el)) === target) score += 60;
				if (lower(labelOf(el)) === target) score += 60;
				if (lower(attr(el, 'placeholder')) === target) score += 50;
				if (lower(attr(el, 'name')) === target) score += 40;
				if (lower(attr(el, 'id')) === target) score += 30;
			}
			if (shadowMeta) score += 5;
			return { el, score, signature: signatureText, shadowMeta, depth };
		})).sort((a, b) => b.score - a.score);
		const best = candidates[0];
		if (!best || best.score <= 0) {
			return JSON.stringify({ ok: false, error: 'shadow target not found', candidates: candidates.slice(0, 5).map((item) => ({ score: item.score, signature: item.signature, hostSelector: item.shadowMeta?.hostSelector || null })) });
		}
		const el = best.el;
		const InputCtor = typeof InputEvent === 'function' ? InputEvent : Event;
		const fire = (type, ctor = Event) => el.dispatchEvent(new ctor(type, { bubbles: true, composed: true }));
		const setValue = (nextValue) => {
			if ('value' in el) {
				el.focus();
				el.value = nextValue;
				fire('input', InputCtor);
				fire('change');
				return el.value;
			}
			if (el.isContentEditable) {
				el.focus();
				el.textContent = nextValue;
				fire('input', InputCtor);
				return textOf(el);
			}
			return null;
		};
		let valueAfter = 'value' in el ? el.value : (el.isContentEditable ? textOf(el) : null);
		if (config.mode === 'getValue') {
			return JSON.stringify({ ok: true, value: valueAfter, match: best.signature, hostSelector: best.shadowMeta?.hostSelector || null, shadowDepth: best.depth || 1 });
		}
		el.scrollIntoView({ block: 'center', inline: 'center' });
		switch (config.action) {
			case 'click':
				if (typeof el.click === 'function') el.click(); else fire('click', MouseEvent);
				break;
			case 'dblclick':
				fire('dblclick', MouseEvent);
				break;
			case 'focus':
				if (typeof el.focus === 'function') el.focus();
				break;
			case 'hover':
				fire('mouseover', MouseEvent);
				fire('mouseenter', MouseEvent);
				break;
			case 'fill':
				valueAfter = setValue(String(config.text || ''));
				break;
			case 'type':
				valueAfter = setValue(String(valueAfter || '') + String(config.text || ''));
				break;
			case 'select':
				valueAfter = setValue(String(config.value || ''));
				break;
			case 'check':
				if ('checked' in el) {
					el.checked = true;
					fire('input');
					fire('change');
				}
				break;
			case 'uncheck':
				if ('checked' in el) {
					el.checked = false;
					fire('input');
					fire('change');
				}
				break;
			case 'scroll_into_view':
				el.scrollIntoView({ block: 'center', inline: 'center' });
				break;
			default:
				return JSON.stringify({ ok: false, error: 'unsupported shadow action: ' + config.action });
		}
		return JSON.stringify({ ok: true, action: config.action, match: best.signature, valueAfter: 'value' in el ? el.value : (el.isContentEditable ? textOf(el) : valueAfter), checkedAfter: 'checked' in el ? !!el.checked : null, hostSelector: best.shadowMeta?.hostSelector || null, hostTag: best.shadowMeta?.hostTag || null, shadowDepth: best.depth || 1 });
	})();`;
}

async function executeShadowAction(
	pi: ExtensionAPI,
	surface: string | undefined,
	query: { target?: string; targetKind?: string; exact?: boolean },
	params: { action: string; text?: string; value?: string },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const result = await execBrowserJson(pi, surface, ["eval", buildShadowActionScript({ ...query, ...params })], { signal, timeout });
	if (!result?.ok) throw new Error(result?.error || "shadow action failed");
	return result;
}

async function readShadowValue(
	pi: ExtensionAPI,
	surface: string | undefined,
	query: { target?: string; targetKind?: string; exact?: boolean },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const result = await execBrowserJson(pi, surface, ["eval", buildShadowActionScript({ ...query, mode: "getValue" })], { signal, timeout });
	if (!result?.ok) throw new Error(result?.error || "shadow value lookup failed");
	return result;
}

async function runPostconditions(
	pi: ExtensionAPI,
	params: { surface?: string; waitForSelector?: string; waitForText?: string; waitForUrlContains?: string; waitForLoadState?: string; expectTitleIncludes?: string; expectValue?: string; selectorForValue?: string; shadowValueQuery?: { target?: string; targetKind?: string; exact?: boolean } | null },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const surface = params.surface;
	const checks = [] as any[];
	if (params.waitForSelector || params.waitForText || params.waitForUrlContains || params.waitForLoadState) {
		const waitArgs = ["wait"] as string[];
		addFlag(waitArgs, "--selector", params.waitForSelector);
		addFlag(waitArgs, "--text", params.waitForText);
		addFlag(waitArgs, "--url-contains", params.waitForUrlContains);
		addFlag(waitArgs, "--load-state", params.waitForLoadState);
		addFlag(waitArgs, "--timeout-ms", timeout);
		await execBrowserText(pi, surface, waitArgs, { signal, timeout });
		checks.push({ type: "wait", passed: true, selector: params.waitForSelector || null, text: params.waitForText || null, urlContains: params.waitForUrlContains || null, loadState: params.waitForLoadState || null });
	}
	if (params.expectTitleIncludes) {
		const title = await execBrowserText(pi, surface, ["get", "title"], { signal, timeout });
		const passed = title.toLowerCase().includes(String(params.expectTitleIncludes).toLowerCase());
		checks.push({ type: "titleIncludes", expected: params.expectTitleIncludes, actual: title, passed });
		if (!passed) throw new Error(`Title did not include expected text: ${params.expectTitleIncludes}`);
	}
	if (params.expectValue && params.selectorForValue) {
		const value = await execBrowserText(pi, surface, ["get", "value", params.selectorForValue], { signal, timeout });
		const passed = String(value) === String(params.expectValue);
		checks.push({ type: "valueEquals", expected: params.expectValue, actual: value, passed });
		if (!passed) throw new Error(`Value did not match expected text for ${params.selectorForValue}`);
	} else if (params.expectValue && params.shadowValueQuery?.target) {
		const valueResult = await readShadowValue(pi, surface, params.shadowValueQuery, signal, timeout);
		const actual = valueResult?.value;
		const passed = String(actual) === String(params.expectValue);
		checks.push({ type: "valueEquals", expected: params.expectValue, actual, passed, strategy: "shadow" });
		if (!passed) throw new Error(`Value did not match expected text for shadow target ${params.shadowValueQuery.target}`);
	}
	return checks;
}

function renderActionResult(action: string, payload: any) {
	const lines = [
		`# cmux browser act: ${action}`,
		"",
		`- surface: ${payload.surface || "default"}`,
		`- selector: ${payload.selector || "—"}`,
	];
	if (payload.target) lines.push(`- target: ${payload.target}`);
	if (payload.url) lines.push(`- url: ${payload.url}`);
	if (payload.resolutionStrategy) lines.push(`- resolution strategy: ${payload.resolutionStrategy}`);
	if (payload.frameContext?.selector) lines.push(`- frame context: ${payload.frameContext.selector}`);
	if (payload.match) lines.push(`- resolved match: ${truncate(payload.match, 220)}`);
	if (payload.result) lines.push(`- command result: ${truncate(typeof payload.result === "string" ? payload.result : stringify(payload.result), 220)}`);
	if (payload.tabTransition?.createdTabs?.length) lines.push(`- new tabs detected: ${payload.tabTransition.createdTabs.map((tab: any) => tab.index).join(", ")}`);
	if (payload.tabTransition?.adoptedTab?.targetIndex !== undefined) lines.push(`- adopted tab: ${payload.tabTransition.adoptedTab.targetIndex}`);
	if (payload.downloadDiff?.created?.length || payload.downloadDiff?.updated?.length) lines.push(`- download changes: +${payload.downloadDiff?.created?.length || 0} new, ${payload.downloadDiff?.updated?.length || 0} updated`);
	if (payload.networkTransition?.added?.length) lines.push(`- network changes: +${payload.networkTransition.added.length} request${payload.networkTransition.added.length === 1 ? "" : "s"}`);
	if (payload.skillPacks?.length) lines.push(`- matching skill packs: ${payload.skillPacks.length}`);
	if (payload.checks?.length) {
		lines.push("", "## Verification", ...payload.checks.map((check: any) => `- ${check.type}: ${check.passed ? "passed" : "failed"}${check.expected ? ` expected=${truncate(check.expected, 80)}` : ""}${check.actual ? ` actual=${truncate(check.actual, 80)}` : ""}`));
	}
	if (payload.observation) {
		lines.push("", "## Post-action observation", buildObservationSummary(payload.observation, { includeSnapshot: false }));
	}
	if (payload.downloadDiff?.created?.length || payload.downloadDiff?.updated?.length) {
		lines.push("", "## Download diff");
		if (payload.downloadDiff.created?.length) lines.push(...payload.downloadDiff.created.map((item: any) => `- new: ${item.name} • ${item.modifiedAt} • ${item.bytes} bytes`));
		if (payload.downloadDiff.updated?.length) lines.push(...payload.downloadDiff.updated.map((item: any) => `- updated: ${item.after.name} • ${item.after.modifiedAt} • ${item.after.bytes} bytes`));
	}
	if (payload.downloadArtifacts?.length) {
		lines.push("", "## Recent download artifacts", ...payload.downloadArtifacts.map((item: any) => `- ${item.name} • ${item.modifiedAt} • ${item.bytes} bytes`));
	}
	if (payload.tabTransition?.createdTabs?.length || payload.tabTransition?.activeChanged || payload.tabTransition?.urlChanged) {
		lines.push("", "## Tab transition");
		if (payload.tabTransition.createdTabs?.length) lines.push(...payload.tabTransition.createdTabs.map((tab: any) => `- created tab ${tab.index}${tab.url ? ` • ${tab.url}` : ""}${tab.title ? ` • ${truncate(tab.title, 120)}` : ""}`));
		if (payload.tabTransition.activeChanged) lines.push(`- active tab: ${payload.tabTransition.beforeActiveIndex ?? "—"} -> ${payload.tabTransition.afterActiveIndex ?? "—"}`);
		if (payload.tabTransition.urlChanged) lines.push(`- url: ${payload.tabTransition.beforeUrl || "—"} -> ${payload.tabTransition.afterUrl || "—"}`);
	}
	if (payload.networkTransition?.added?.length) {
		lines.push("", "## Network transition", ...payload.networkTransition.addedPreview.map((item: any) => `- ${item.method || "REQ"} ${truncate(item.url || stringify(item.raw), 180)}${item.status ? ` • ${item.status}` : ""}${item.type ? ` • ${item.type}` : ""}`));
	}
	if (payload.mechanicAssists?.length) {
		lines.push("", "## Mechanic assists", ...payload.mechanicAssists.map((item: any) => `- ${item.mechanic}: ${item.status}${item.notes?.length ? ` • ${truncate(item.notes.join(" | "), 180)}` : ""}`));
	}
	if (payload.recovery) {
		lines.push("", "## Recovery", renderRecoveryResult(payload.recovery));
	}
	if (payload.skillPacks?.length) {
		lines.push("", "## Matching skill packs", ...payload.skillPacks.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`));
	}
	return lines.join("\n");
}

function renderAssertResult(payload: any) {
	const lines = ["# cmux browser assert", ""];
	for (const check of payload.checks || []) {
		lines.push(`- ${check.type}: ${check.passed ? "passed" : "failed"}${check.expected ? ` expected=${truncate(check.expected, 80)}` : ""}${check.actual ? ` actual=${truncate(check.actual, 80)}` : ""}`);
	}
	if (payload.observation) {
		lines.push("", "## Observation", buildObservationSummary(payload.observation, { includeSnapshot: false }));
	}
	return lines.join("\n");
}

function renderExtractResult(mode: string, data: any) {
	const lines = [`# cmux browser extract: ${mode}`, ""];
	if (data === null || data === undefined) {
		lines.push("- No data extracted.");
		return lines.join("\n");
	}
	if (typeof data === "string") {
		lines.push(data);
		return lines.join("\n");
	}
	if (Array.isArray(data)) {
		lines.push(...data.slice(0, 20).map((item) => `- ${truncate(typeof item === "string" ? item : stringify(item), 240)}`));
		if (!data.length) lines.push("- No items.");
		return lines.join("\n");
	}
	lines.push("```json", stringify(data), "```");
	return lines.join("\n");
}

function renderLockResult(action: string, payload: any) {
	const lines = [
		`# cmux browser lock: ${action}`,
		"",
		payload.surface ? `- surface: ${payload.surface}` : null,
		payload.owner ? `- owner: ${payload.owner}` : null,
		payload.team ? `- team: ${payload.team}` : null,
		payload.note ? `- note: ${truncate(payload.note, 240)}` : null,
		payload.expiresAt ? `- expires: ${payload.expiresAt}` : null,
	].filter(Boolean);
	if (typeof payload.removedCount === "number") lines.push(`- removedCount: ${payload.removedCount}`);
	if (Array.isArray(payload.locks)) {
		lines.push("", action === "sweep" ? "## Removed locks" : "## Active locks", ...(payload.locks.length ? payload.locks.map((lock: any) => `- ${lock.surface}: owner=${lock.owner}${lock.team ? ` team=${lock.team}` : ""}${lock.expiresAt ? ` expires=${lock.expiresAt}` : ""}`) : [action === "sweep" ? "- No expired locks removed." : "- No active locks."]));
	}
	return lines.join("\n");
}

function renderMemoryResult(action: string, payload: any) {
	const lines = [`# cmux browser memory: ${action}`, ""];
	if (payload.site) lines.push(`- site: ${payload.site}`);
	if (payload.entry) {
		lines.push(`- key: ${payload.entry.key}`);
		if (payload.entry.kind) lines.push(`- kind: ${payload.entry.kind}`);
		if (payload.entry.title) lines.push(`- title: ${payload.entry.title}`);
		if (payload.entry.attribution) lines.push(`- attribution: ${payload.entry.attribution}`);
		if (payload.entry.confidence !== null && payload.entry.confidence !== undefined) lines.push(`- confidence: ${payload.entry.confidence}`);
	}
	if (Array.isArray(payload.entries)) {
		lines.push("", "## Entries", ...(payload.entries.length ? payload.entries.map((entry: any) => {
			const meta = [entry.attribution ? `by=${entry.attribution}` : null, entry.confidence !== null && entry.confidence !== undefined ? `confidence=${entry.confidence}` : null]
				.filter(Boolean)
				.join(" ");
			return `- ${entry.key} [${entry.kind || "note"}] ${entry.title || entry.site || "untitled"}${meta ? ` (${meta})` : ""}: ${truncate(entry.content || "", 200)}`;
		}) : ["- No memory entries."]));
	}
	if (typeof payload.removed === "number") lines.push(`- removed: ${payload.removed}`);
	return lines.join("\n");
}

function buildDiff(previous: any, current: any) {
	const lines = ["# cmux browser checkpoint diff", ""];
	lines.push(`- title: ${previous?.observation?.title || "—"} -> ${current?.title || "—"}`);
	lines.push(`- url: ${previous?.observation?.url || "—"} -> ${current?.url || "—"}`);
	lines.push(`- page type: ${previous?.observation?.pageType || "—"} -> ${current?.pageType || "—"}`);
	const countKeys = ["buttons", "links", "inputs", "forms", "tables", "cards", "alerts", "modals"];
	for (const key of countKeys) {
		const before = previous?.observation?.counts?.[key] ?? 0;
		const after = current?.counts?.[key] ?? 0;
		if (before !== after) lines.push(`- ${key}: ${before} -> ${after}`);
	}
	const beforeActions = (previous?.observation?.primaryActions || []).join(", ");
	const afterActions = (current?.primaryActions || []).join(", ");
	if (beforeActions !== afterActions) lines.push(`- primary actions: ${beforeActions || "—"} -> ${afterActions || "—"}`);
	if (previous?.note || current?.note) lines.push(`- note: ${current?.note || previous?.note || "—"}`);
	return lines.join("\n");
}

function isDestructiveText(text?: string) {
	return /(delete|remove|destroy|publish|post\b|submit|submit order|place order|pay|confirm purchase|charge|transfer|send now|finalize|save changes|save profile|update profile|apply now|easy apply|connect|follow|unfollow|endorse|recommend|invite|send message|send\b|confirm|accept)/i.test(String(text || ""));
}

function classifyBrowserActionRisk(params: any = {}) {
	const action = String(params.action || "").toLowerCase();
	const targetText = [params.target, params.text, params.value, params.dialogText, params.url]
		.filter(Boolean)
		.map((item) => String(item))
		.join(" ");
	const lower = targetText.toLowerCase();
	const reasons: string[] = [];
	let level: "low" | "medium" | "high" | "irreversible" = "low";
	const bump = (next: typeof level, reason: string) => {
		reasons.push(reason);
		const order: Record<string, number> = { low: 0, medium: 1, high: 2, irreversible: 3 };
		if (order[next] > order[level]) level = next;
	};
	if (["fill", "type", "select", "check", "uncheck"].includes(action)) {
		bump("medium", "mutates local page/form state but usually remains reversible until submitted or saved");
	}
	if (["dialog_accept"].includes(action)) bump("high", "accepts a browser/page dialog that may confirm an action");
	if (["click", "dblclick", "press"].includes(action) && /\b(enter|return)\b/i.test(String(params.key || ""))) {
		bump("medium", "pressing Enter may submit focused forms");
	}
	if (["click", "dblclick", "press", "dialog_accept"].includes(action) && /(post\b|publish|share\b|repost|comment|reply|send\b|message|invite|connect|follow|unfollow|endorse|recommend|save changes|save profile|update profile|submit|apply now|easy apply|delete|remove|archive|deactivate|close account|confirm|finalize|purchase|pay|charge|transfer)/i.test(lower)) {
		bump("irreversible", "target appears externally visible, persistent, destructive, financial, or profile/account-changing");
	}
	if (/(linkedin\.com|linkedin)/i.test(lower) && /(post\b|publish|share\b|comment|reply|send\b|connect|follow|save|profile|experience|headline|about|featured|recommendation|endorse)/i.test(lower)) {
		bump("irreversible", "LinkedIn action may change a profile, relationship graph, message, or public post");
	}
	if (isDestructiveText(targetText)) bump("irreversible", "matches irreversible/destructive action vocabulary");
	return {
		level,
		reasons: uniqueStrings(reasons),
		requiresApproval: level === "high" || level === "irreversible",
	};
}

function approvalGrantedForBrowserRisk(params: any = {}) {
	return params.approvalGranted === true || params.userApproved === true || params.explicitApproval === true;
}

function renderBrowserApprovalRequired(risk: any, params: any = {}) {
	return [
		"# cmux browser action requires approval",
		"",
		`- action: ${params.action || "—"}`,
		params.target ? `- target: ${params.target}` : null,
		params.text ? `- text: ${truncate(params.text, 180)}` : null,
		params.url ? `- url: ${params.url}` : null,
		`- risk: ${risk.level}`,
		...(risk.reasons || []).map((reason: string) => `- reason: ${reason}`),
		"",
		"This action was not executed. Ask the user for explicit approval, then retry with approvalGranted=true and an approvalNote.",
	].filter(Boolean).join("\n");
}

function extractQuotedTarget(goal: string) {
	const match = String(goal || "").match(/["“]([^"”]+)["”]/);
	return match?.[1]?.trim() || null;
}

function inferExtractModeFromGoal(goal: string, observation?: any) {
	const text = String(goal || "").toLowerCase();
	if (/(link|href|url)/.test(text)) return "links";
	if (/(button|cta|action)/.test(text)) return "buttons";
	if (/(form|field|input)/.test(text)) return "forms";
	if (/(table|row|column|csv|spreadsheet)/.test(text) || (observation?.counts?.tables || 0) > 0) return "table";
	if (/(card|pricing|plan|result|listing|vendor|product)/.test(text) || (observation?.counts?.cards || 0) > 2) return "cards";
	if (/(key.?value|details|metadata|spec)/.test(text)) return "kv";
	if (/(text|content|body|copy)/.test(text)) return "text";
	return "summary";
}

function inferIntentFromGoal(goal: string) {
	const text = String(goal || "");
	const lower = text.toLowerCase();
	const target = extractQuotedTarget(text);
	const wantsExtraction = /(extract|scrape|collect|list|summari[sz]e|capture|gather|research|analy[sz]e|inspect)/.test(lower);
	const searchMatch = text.match(/search(?: for)?\s+["“]?([^"”]+)["”]?/i);
	const clickVerb = /(click|open|follow|choose|select|go to|navigate to)/i.test(lower);
	const fillVerb = /(fill|enter|type)/i.test(lower);
	return {
		lower,
		target,
		searchQuery: searchMatch?.[1]?.trim() || null,
		wantsExtraction,
		clickVerb,
		fillVerb,
	};
}

function buildRunTaskPlan(goal: string, observation: any, params: any, intent: any) {
	const plannedSteps: string[] = [];
	if (params.resumeFromCheckpointKey) plannedSteps.push(`restore checkpoint ${safeKey(params.resumeFromCheckpointKey)}`);
	if (params.url) plannedSteps.push(`navigate to ${params.url}`);
	plannedSteps.push("observe current page");
	if (params.useMemory !== false) plannedSteps.push("recall site memory if available");
	if (params.checkpointKey) plannedSteps.push(`save checkpoint ${safeKey(params.checkpointKey)}`);
	if ((observation?.modals || []).length) plannedSteps.push("attempt to dismiss blocking modal if present");
	if (intent.searchQuery) plannedSteps.push(`fill search input with ${intent.searchQuery} and submit`);
	if (intent.target && intent.clickVerb) plannedSteps.push(`resolve and click semantic target ${intent.target}`);
	if (params.extractMode || intent.wantsExtraction) plannedSteps.push(`extract ${params.extractMode || inferExtractModeFromGoal(goal, observation)} data`);
	if (params.followLinks || Number(params.researchDepth || 1) > 1) plannedSteps.push("selectively rank and visit relevant links for bounded research/scraping");
	if (params.successUrlContains || params.successText || params.successTitleIncludes) plannedSteps.push("verify postconditions");
	if (params.finalCheckpointKey) plannedSteps.push(`save final checkpoint ${safeKey(params.finalCheckpointKey)}`);
	return {
		intent,
		extractMode: params.extractMode || (intent.wantsExtraction ? inferExtractModeFromGoal(goal, observation) : null),
		plannedSteps,
	};
}

function normalizeResearchKeywords(goal: string, keywords?: any[]) {
	const fromGoal = String(goal || "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !["research", "scrape", "extract", "collect", "about", "with", "from", "page", "pages", "website", "compare", "find"].includes(word));
	return uniqueStrings([...(keywords || []), ...fromGoal].map((item: any) => String(item || "").toLowerCase().trim()).filter(Boolean)).slice(0, 24);
}

function scoreResearchLink(link: any, goal: string, keywords: string[], currentUrl?: string | null) {
	const text = `${link?.text || ""} ${link?.href || link?.url || ""} ${link?.label || ""}`.toLowerCase();
	let score = 0;
	for (const keyword of keywords) {
		if (keyword && text.includes(keyword)) score += 4;
	}
	if (/(pricing|docs|documentation|about|features|case-stud|blog|research|report|news|contact|team|product|solutions)/.test(text)) score += 2;
	if (/(login|sign in|signup|register|cart|checkout|privacy|terms|cookie|mailto:|tel:|javascript:|#)/.test(text)) score -= 8;
	try {
		const base = currentUrl ? new URL(currentUrl) : null;
		const url = new URL(link?.href || link?.url || "", currentUrl || undefined);
		if (base && url.hostname === base.hostname) score += 2;
		if (url.protocol !== "http:" && url.protocol !== "https:") score -= 20;
	} catch {
		score -= 20;
	}
	if (/research|scan|crawl|scrape|extract|collect/i.test(goal || "")) score += 1;
	return score;
}

function selectResearchLinks(links: any[], params: { goal: string; keywords: string[]; currentUrl?: string | null; limit: number }) {
	const seen = new Set<string>();
	return (links || [])
		.map((link: any) => {
			const href = link?.href || link?.url || link?.to || null;
			let absolute = href;
			try { absolute = new URL(href, params.currentUrl || undefined).toString(); } catch { /* keep original */ }
			return { ...link, href: absolute, score: scoreResearchLink({ ...link, href: absolute }, params.goal, params.keywords, params.currentUrl) };
		})
		.filter((link: any) => link.href && link.score > -4)
		.filter((link: any) => {
			const key = String(link.href).replace(/#.*$/, "");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a: any, b: any) => b.score - a.score)
		.slice(0, Math.max(0, params.limit));
}

async function saveBrowserCheckpoint(
	pi: ExtensionAPI,
	params: { key: string; surface?: string; note?: string; includeSnapshot?: boolean; maxDepth?: number; timeout?: number },
	signal?: AbortSignal,
) {
	const paths = checkpointPaths(params.key);
	const observation = await collectObservation(
		pi,
		{
			surface: params.surface,
			includeSnapshot: params.includeSnapshot !== false,
			interactiveSnapshot: true,
			compact: true,
			maxDepth: params.maxDepth ?? DEFAULT_OBSERVE_MAX_DEPTH,
			limit: DEFAULT_LIMIT,
		},
		signal,
	);
	await execBrowserText(pi, params.surface, ["state", "save", paths.statePath], { signal, timeout: params.timeout ?? DEFAULT_TIMEOUT });
	const stateSize = checkpointFileSize(paths.statePath);
	const payload = {
		schemaVersion: 2,
		key: paths.key,
		statePath: paths.statePath,
		checkpointPath: paths.jsonPath,
		note: params.note || null,
		observedAt: new Date().toISOString(),
		observation,
		integrity: {
			observationFingerprint: observationFingerprint(observation),
			statePresent: existsSync(paths.statePath),
			stateSize,
		},
	};
	writeJsonFile(paths.jsonPath, payload);
	return payload;
}

async function maybeDismissModal(pi: ExtensionAPI, surface: string | undefined, observation: any, signal?: AbortSignal, timeout = DEFAULT_TIMEOUT) {
	if (!(observation?.modals || []).length) return null;
	const candidates = ["close", "dismiss", "not now", "no thanks", "accept", "agree", "ok", "okay", "continue", "cancel", "later", "×"];
	for (const candidate of candidates) {
		try {
			if (isDestructiveText(candidate)) continue;
			const resolved = await resolveSmartSelector(pi, surface, { target: candidate, targetKind: "button", exact: false }, signal, timeout);
			const args = ["click", resolved.selector, "--snapshot-after"];
			const result = await execBrowserText(pi, surface, args, { signal, timeout });
			const nextObservation = await collectObservation(pi, { surface, includeSnapshot: false, limit: 12, maxDepth: 3 }, signal).catch(() => null);
			return { candidate, resolved, result, observation: nextObservation };
		} catch {
			// try next candidate
		}
	}
	return null;
}

function inferRecoverySkillPackMatches(classification: any, observation: any, errorText?: string) {
	const matches = [] as Array<{ packId: string; reason: string }>;
	const issues = classification?.issues || [];
	const error = String(errorText || "").toLowerCase();
	if (issues.includes("modal-blocker") || /dialog|modal|consent|cookie/.test(error)) matches.push({ packId: "dialogs", reason: "modal/dialog blocker detected" });
	if (issues.includes("missing-target-or-input") || /iframe|frame/.test(error)) matches.push({ packId: "iframes", reason: "target may be inside an iframe" });
	if (issues.includes("missing-target-or-input") || /shadow/.test(error)) matches.push({ packId: "shadow-dom", reason: "target may be inside shadow DOM or encapsulated components" });
	if (/upload|file input|choose file/.test(error)) matches.push({ packId: "file-uploads", reason: "file upload flow detected" });
	if (/download|save file|export/.test(error) || /(download|export)/i.test(String(observation?.textSample || ""))) matches.push({ packId: "downloads", reason: "download or export flow detected" });
	const available = new Map(listSkillPackEntries({ kind: "interaction" }).map((entry: any) => [entry.packId, entry]));
	return uniqueBy(matches, (item) => item.packId).map((item) => ({ ...item, entry: available.get(item.packId) || null })).filter((item) => item.entry);
}

function classifyRecoveryContext(observation: any, errorText?: string, goal?: string) {
	const error = String(errorText || "");
	const issues = [] as string[];
	const strategies = [] as string[];
	if ((observation?.modals || []).length) {
		issues.push("modal-blocker");
		strategies.push("dismiss_modal", "wait");
	}
	if ((observation?.flags || []).includes("auth-boundary")) {
		issues.push("auth-boundary");
		strategies.push("checkpoint", "back");
	}
	if ((observation?.alerts || []).length || (observation?.errors || []).length || (observation?.flags || []).includes("alerts-present")) {
		issues.push("page-alerts");
		strategies.push("wait", "reload", "checkpoint");
	}
	if (/Unable to resolve semantic target/i.test(error)) {
		issues.push("semantic-target-resolution-failed");
		strategies.push("dismiss_modal", "wait", "reload");
	}
	if (/Assertion failed/i.test(error)) {
		issues.push("assertion-failed");
		strategies.push("wait", "reload", "checkpoint");
	}
	if (/timeout|timed out|load state|wait/i.test(error)) {
		issues.push("slow-or-loading-page");
		strategies.push("wait", "reload", "checkpoint");
	}
	if (/not found|required/i.test(error)) {
		issues.push("missing-target-or-input");
		strategies.push("dismiss_modal", "wait");
	}
	if (!issues.length) issues.push("generic-browser-failure");
	if (!strategies.length) strategies.push("wait", "reload", "checkpoint");
	const base = {
		goal: goal || null,
		errorText: error || null,
		issues: uniqueStrings(issues),
		strategies: uniqueStrings(strategies),
	};
	return {
		...base,
		suggestedSkillPacks: inferRecoverySkillPackMatches(base, observation, errorText),
	};
}

async function performRecovery(
	pi: ExtensionAPI,
	params: { surface?: string; strategy?: string; errorText?: string; goal?: string; checkpointKey?: string; note?: string; includeSnapshot?: boolean },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const beforeObservation = await collectObservation(
		pi,
		{ surface: params.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 },
		signal,
	).catch(() => null);
	const classification = classifyRecoveryContext(beforeObservation, params.errorText, params.goal);
	const strategies = params.strategy && params.strategy !== "auto"
		? [params.strategy]
		: classification.strategies;
	const actions = [] as any[];
	let afterObservation = beforeObservation;
	let checkpoint = null as any;
	let status = "noop";
	for (const strategy of strategies) {
		if (strategy === "dismiss_modal") {
			const result = await maybeDismissModal(pi, params.surface, afterObservation, signal, timeout).catch(() => null);
			if (result) {
				actions.push({ strategy, result });
				afterObservation = result.observation || afterObservation;
				status = "recovered";
			}
			continue;
		}
		if (strategy === "wait") {
			const result = await execBrowserText(pi, params.surface, ["wait", "--load-state", "complete", "--timeout-ms", String(Math.min(timeout, 12_000))], { signal, timeout }).catch((error: any) => `wait failed: ${error.message || String(error)}`);
			actions.push({ strategy, result });
			afterObservation = await collectObservation(pi, { surface: params.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 }, signal).catch(() => afterObservation);
			status = status === "noop" ? "stabilized" : status;
			continue;
		}
		if (strategy === "reload") {
			const result = await execBrowserText(pi, params.surface, ["reload", "--snapshot-after"], { signal, timeout }).catch((error: any) => `reload failed: ${error.message || String(error)}`);
			actions.push({ strategy, result });
			afterObservation = await collectObservation(pi, { surface: params.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 }, signal).catch(() => afterObservation);
			status = status === "noop" ? "reloaded" : status;
			continue;
		}
		if (strategy === "back") {
			const result = await execBrowserText(pi, params.surface, ["back", "--snapshot-after"], { signal, timeout }).catch((error: any) => `back failed: ${error.message || String(error)}`);
			actions.push({ strategy, result });
			afterObservation = await collectObservation(pi, { surface: params.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 }, signal).catch(() => afterObservation);
			status = status === "noop" ? "navigated-back" : status;
			continue;
		}
		if (strategy === "checkpoint") {
			const key = params.checkpointKey || `recovery-${safeKey((params.goal || beforeObservation?.title || "browser") + "-" + Date.now())}`;
			checkpoint = await saveBrowserCheckpoint(
				pi,
				{
					key,
					surface: params.surface,
					note: params.note || params.errorText || `Recovery checkpoint for ${params.goal || "browser task"}`,
					includeSnapshot: params.includeSnapshot !== false,
					timeout,
				},
				signal,
			).catch(() => null);
			actions.push({ strategy, checkpointKey: checkpoint?.key || key });
			status = status === "noop" ? "checkpointed" : status;
		}
	}
	return { status, classification, beforeObservation, afterObservation, actions, checkpoint };
}

function renderRecoveryResult(payload: any) {
	const lines = [
		"# cmux browser recover",
		"",
		`- status: ${payload.status}`,
		`- issues: ${(payload.classification?.issues || []).join(", ") || "none detected"}`,
		`- strategies: ${(payload.classification?.strategies || []).join(", ") || "none"}`,
		payload.lock?.owner ? `- lock owner: ${payload.lock.owner}` : null,
		payload.lock?.team ? `- lock team: ${payload.lock.team}` : null,
		payload.releasedRecoveryLock ? `- releasedRecoveryLock: yes` : null,
		payload.checkpoint?.key ? `- checkpoint key: ${payload.checkpoint.key}` : null,
	].filter(Boolean);
	if (payload.actions?.length) {
		lines.push("", "## Recovery actions", ...payload.actions.map((action: any) => `- ${action.strategy}: ${truncate(typeof action.result === "string" ? action.result : stringify(action), 220)}`));
	}
	if (payload.classification?.suggestedSkillPacks?.length) {
		lines.push("", "## Suggested skill packs", ...payload.classification.suggestedSkillPacks.map((item: any) => `- ${item.packId}: ${item.reason}`));
	}
	if (payload.beforeObservation) {
		lines.push("", "## Before", buildObservationSummary(payload.beforeObservation, { includeSnapshot: false }));
	}
	if (payload.afterObservation) {
		lines.push("", "## After", buildObservationSummary(payload.afterObservation, { includeSnapshot: false }));
	}
	return lines.join("\n");
}

function addDoctorIssue(report: any, issue: { code: string; severity?: string; summary: string; recommendation?: string }) {
	report.issues = report.issues || [];
	report.issues.push({
		code: issue.code,
		severity: issue.severity || "warning",
		summary: issue.summary,
		recommendation: issue.recommendation || null,
	});
	if (issue.recommendation) {
		report.recommendations = report.recommendations || [];
		report.recommendations.push(issue.recommendation);
	}
}

function classifyDoctorStatus(report: any) {
	const severities = (report.issues || []).map((issue: any) => String(issue.severity || "warning").toLowerCase());
	if (severities.includes("blocking") || severities.includes("error")) return "blocked";
	if (severities.includes("warning")) return "needs-attention";
	return "healthy";
}

function renderDoctorResult(report: any) {
	const lines = [
		"# cmux browser doctor",
		"",
		`- status: ${report.status}`,
		`- surface: ${report.surface || "default / inferred"}`,
		report.site ? `- site: ${report.site}` : null,
		report.cmuxBinary ? `- cmux binary: ${report.cmuxBinary}` : "- cmux binary: missing",
		report.identify ? `- identify: ${truncate(report.identify, 220)}` : null,
		report.url ? `- url: ${report.url}` : null,
		report.title ? `- title: ${truncate(report.title, 220)}` : null,
		report.observation?.pageType ? `- page type: ${report.observation.pageType}` : null,
		report.observation?.flags?.length ? `- flags: ${report.observation.flags.join(", ")}` : null,
		report.runtimeCapabilities ? `- runtime capabilities: dialog=${report.runtimeCapabilities.dialog ? "yes" : "no"}, downloadWait=${report.runtimeCapabilities.downloadWait ? "yes" : "no"}, frame=${report.runtimeCapabilities.frame ? "yes" : "no"}, tabList=${report.runtimeCapabilities.tabList ? "yes" : "no"}, networkRequests=${report.runtimeCapabilities.networkRequests ? "yes" : "no"}, uploadSetFiles=${report.runtimeCapabilities.futureUploadSetFiles ? "yes" : "no"}` : null,
		report.lock?.owner ? `- lock owner: ${report.lock.owner}` : null,
		report.lock?.team ? `- lock team: ${report.lock.team}` : null,
		report.lock?.expiresAt ? `- lock expiresAt: ${report.lock.expiresAt}` : null,
		report.memorySummary ? `- memory entries: ${report.memorySummary.count}` : null,
		report.checkpointSummary ? `- matching checkpoints: ${report.checkpointSummary.count}` : null,
		report.skillPackSummary ? `- matching skill packs: ${report.skillPackSummary.count}` : null,
	].filter(Boolean);
	if (report.issues?.length) {
		lines.push("", "## Issues", ...report.issues.map((issue: any) => `- [${issue.severity}] ${issue.code}: ${issue.summary}`));
	}
	if (report.recommendations?.length) {
		lines.push("", "## Recommendations", ...uniqueStrings(report.recommendations).map((item: string) => `- ${item}`));
	}
	if (report.observation) {
		lines.push("", "## Observation", buildObservationSummary(report.observation, { includeSnapshot: false }));
	}
	if (report.memoryEntries?.length) {
		lines.push("", "## Site memory", ...report.memoryEntries.map((entry: any) => `- ${entry.key} [${entry.kind || "note"}] ${entry.title || entry.site || "untitled"}: ${truncate(entry.content || "", 160)}`));
	}
	if (report.checkpoints?.length) {
		lines.push("", "## Recent checkpoints", ...report.checkpoints.map((entry: any) => `- ${entry.key}${entry.collection ? ` [${entry.collection}]` : ""}: ${entry.pageType || "unknown"} • ${truncate(entry.title || entry.url || "untitled", 160)} • ${entry.observedAt || "—"}`));
	}
	if (report.skillPacks?.length) {
		lines.push("", "## Matching skill packs", ...report.skillPacks.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`));
	}
	if (report.runtimeCapabilities?.rawHelpPreview) {
		lines.push("", "## Runtime capabilities preview", "```text", truncate(report.runtimeCapabilities.rawHelpPreview, 1200), "```");
	}
	if (report.surfaceHealthText) {
		lines.push("", "## Surface health", "```text", truncate(report.surfaceHealthText, 1600), "```");
	}
	if (report.tabListRaw) {
		lines.push("", "## Tab list", "```text", truncate(report.tabListRaw, 1600), "```");
	}
	return lines.join("\n");
}

function skillPackRoot(kind: string, site?: string | null) {
	const normalizedKind = String(kind || "interaction").toLowerCase();
	if (normalizedKind === "domain") return join(DOMAIN_SKILLS_DIR, safeKey(site || "site"));
	return INTERACTION_SKILLS_DIR;
}

function skillPackPath(params: { kind: string; packId: string; site?: string | null }) {
	const packId = safeKey(params.packId || "skill-pack");
	const root = skillPackRoot(params.kind, params.site);
	return {
		packId,
		root,
		path: join(root, `${packId}.md`),
	};
}

function serializeSkillPack(entry: any) {
	const frontmatter = [
		"---",
		`kind: ${entry.kind}`,
		`packId: ${entry.packId}`,
		entry.site ? `site: ${entry.site}` : null,
		entry.title ? `title: ${JSON.stringify(entry.title)}` : null,
		entry.createdAt ? `createdAt: ${entry.createdAt}` : null,
		entry.updatedAt ? `updatedAt: ${entry.updatedAt}` : null,
		entry.createdBy ? `createdBy: ${entry.createdBy}` : null,
		entry.sourceMemoryKey ? `sourceMemoryKey: ${entry.sourceMemoryKey}` : null,
		entry.tags?.length ? `tags: ${JSON.stringify(entry.tags)}` : null,
		entry.confidence !== null && entry.confidence !== undefined ? `confidence: ${entry.confidence}` : null,
		"---",
		"",
		entry.content || "",
	]
		.filter(Boolean)
		.join("\n");
	return frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
}

function ensureStarterSkillPacks() {
	const starters = [
		{
			kind: "interaction",
			packId: "dialogs",
			title: "Dialog and modal handling",
			tags: ["recovery", "modal", "dialogs"],
			confidence: 0.85,
			content: [
				"# Dialogs",
				"",
				"Use when a modal, cookie banner, consent gate, or pop-up blocks normal browsing.",
				"",
				"## Preferred sequence",
				"- observe the page first",
				"- look for safe dismiss text like Close, Dismiss, Not now, No thanks, Later, Cancel",
				"- avoid destructive-looking buttons",
				"- verify the underlying page becomes interactable afterward",
			].join("\n"),
		},
		{
			kind: "interaction",
			packId: "file-uploads",
			title: "File upload handling",
			tags: ["upload", "file-input", "forms"],
			confidence: 0.72,
			content: [
				"# File uploads",
				"",
				"Use when a form requires selecting or uploading a local file.",
				"",
				"## Guidance",
				"- prefer a real input[type=file] when present",
				"- checkpoint before upload if the flow is multi-step",
				"- verify the file name or upload status appears after selection",
			].join("\n"),
		},
		{
			kind: "interaction",
			packId: "iframes",
			title: "Iframe interaction",
			tags: ["iframe", "embedded-content", "recovery"],
			confidence: 0.76,
			content: [
				"# Iframes",
				"",
				"Use when expected controls are missing from the main DOM or page actions seem embedded.",
				"",
				"## Guidance",
				"- suspect iframes when selectors unexpectedly fail on pages with visible controls",
				"- verify whether the target is inside an embedded frame before retrying",
				"- prefer observation and scoped retries over blind reload loops",
			].join("\n"),
		},
		{
			kind: "interaction",
			packId: "shadow-dom",
			title: "Shadow DOM interaction",
			tags: ["shadow-dom", "web-components", "recovery"],
			confidence: 0.74,
			content: [
				"# Shadow DOM",
				"",
				"Use when controls are visible but standard selector-based resolution fails repeatedly.",
				"",
				"## Guidance",
				"- suspect web-component encapsulation",
				"- use observation, fallback DOM inspection, and careful retries",
				"- avoid assuming the element is absent until shadow-root causes are ruled out",
			].join("\n"),
		},
		{
			kind: "interaction",
			packId: "downloads",
			title: "Download verification",
			tags: ["download", "artifact", "verification"],
			confidence: 0.7,
			content: [
				"# Downloads",
				"",
				"Use when browser actions should produce a downloaded artifact.",
				"",
				"## Guidance",
				"- checkpoint before download if the action may navigate away",
				"- verify file creation or success messaging after the click",
				"- treat download flows as verification-sensitive, not just click-sensitive",
			].join("\n"),
		},
		{
			kind: "domain",
			site: "github.com",
			packId: "repo-actions",
			title: "GitHub repo actions",
			tags: ["github", "repo", "domain"],
			confidence: 0.83,
			content: [
				"# GitHub repo actions",
				"",
				"Use when browsing or acting inside GitHub repository pages.",
				"",
				"## Guidance",
				"- prefer opening new tabs when the current page context matters",
				"- star/watch/fork and PR actions are commit-like and should be treated with explicit verification",
				"- auth boundaries and consent banners should be handled before assuming selector failure",
			].join("\n"),
		},
	];
	for (const starter of starters) {
		const target = skillPackPath({ kind: starter.kind, packId: starter.packId, site: starter.site || null });
		if (existsSync(target.path)) continue;
		ensureDir(target.root);
		writeFileSync(target.path, serializeSkillPack({ ...starter, createdAt: nowIso(), updatedAt: nowIso(), createdBy: "cmux-browser-intelligence-starter" }), "utf-8");
	}
}

function parseSkillPack(text: string, path: string) {
	const input = String(text || "");
	if (!input.startsWith("---\n")) return { metadata: {}, content: input, path };
	const end = input.indexOf("\n---\n", 4);
	if (end < 0) return { metadata: {}, content: input, path };
	const metaBlock = input.slice(4, end).split(/\r?\n/);
	const metadata: any = {};
	for (const line of metaBlock) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		const value = rawValue.trim();
		if (!value) metadata[key] = "";
		else if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith('"') && value.endsWith('"'))) metadata[key] = parsePossiblyJson(value) ?? value;
		else if (/^(true|false)$/i.test(value)) metadata[key] = value.toLowerCase() === "true";
		else if (/^-?\d+(?:\.\d+)?$/.test(value)) metadata[key] = Number(value);
		else metadata[key] = value;
	}
	return { metadata, content: input.slice(end + 5).trim(), path };
}

function listSkillPackEntries(options: { kind?: string; site?: string | null } = {}) {
	const kind = String(options.kind || "").trim().toLowerCase();
	const files = [] as string[];
	const collect = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) collect(full);
			else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
		}
	};
	if (!kind || kind === "interaction") collect(INTERACTION_SKILLS_DIR);
	if (!kind || kind === "domain") collect(options.site ? join(DOMAIN_SKILLS_DIR, safeKey(options.site)) : DOMAIN_SKILLS_DIR);
	return files.map((path) => {
		const parsed = parseSkillPack(readFileSync(path, "utf-8"), path);
		return {
			path,
			kind: parsed.metadata.kind || (path.includes(`${DOMAIN_SKILLS_DIR}/`) ? "domain" : "interaction"),
			packId: parsed.metadata.packId || path.split("/").pop()?.replace(/\.md$/, "") || "skill-pack",
			site: parsed.metadata.site || null,
			title: parsed.metadata.title || null,
			tags: uniqueStrings(parsed.metadata.tags || []),
			confidence: parsed.metadata.confidence ?? null,
			createdBy: parsed.metadata.createdBy || null,
			updatedAt: parsed.metadata.updatedAt || parsed.metadata.createdAt || null,
			content: parsed.content || "",
		};
	});
}

function writeSkillPackEntry(entry: any) {
	const target = skillPackPath({ kind: entry.kind, packId: entry.packId, site: entry.site || null });
	ensureDir(target.root);
	const payload = {
		kind: entry.kind,
		packId: target.packId,
		site: entry.site || null,
		title: entry.title || null,
		createdAt: entry.createdAt || nowIso(),
		updatedAt: nowIso(),
		createdBy: entry.createdBy || null,
		sourceMemoryKey: entry.sourceMemoryKey || null,
		tags: uniqueStrings(entry.tags || []),
		confidence: entry.confidence ?? null,
		content: entry.content || "",
	};
	writeFileSync(target.path, serializeSkillPack(payload), "utf-8");
	return { ...payload, path: target.path };
}

function deleteSkillPackEntry(params: { kind: string; packId: string; site?: string | null }) {
	const target = skillPackPath(params);
	if (existsSync(target.path)) rmSync(target.path, { force: true });
	return { deleted: true, ...target };
}

function renderBootstrapResult(payload: any) {
	const lines = [
		"# cmux browser bootstrap",
		"",
		`- status: ${payload.status}`,
		payload.action ? `- action: ${payload.action}` : null,
		payload.workspace ? `- workspace: ${payload.workspace}` : null,
		payload.surface ? `- surface: ${payload.surface}` : null,
		payload.url ? `- url: ${payload.url}` : null,
		payload.lock?.owner ? `- lock owner: ${payload.lock.owner}` : null,
		payload.site ? `- site: ${payload.site}` : null,
		payload.checkpoint?.key ? `- checkpoint key: ${payload.checkpoint.key}` : null,
		payload.skillPacks?.length ? `- matching skill packs: ${payload.skillPacks.length}` : null,
	].filter(Boolean);
	if (payload.memoryEntries?.length) {
		lines.push("", "## Site memory", ...payload.memoryEntries.map((entry: any) => `- ${entry.key} [${entry.kind || "note"}] ${entry.title || entry.site || "untitled"}: ${truncate(entry.content || "", 160)}`));
	}
	if (payload.skillPacks?.length) {
		lines.push("", "## Matching skill packs", ...payload.skillPacks.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`));
	}
	if (payload.observation) {
		lines.push("", "## Observation", buildObservationSummary(payload.observation, { includeSnapshot: false }));
	}
	if (payload.notes?.length) {
		lines.push("", "## Notes", ...payload.notes.map((note: string) => `- ${note}`));
	}
	return lines.join("\n");
}

function renderFocusResult(payload: any) {
	const lines = [
		"# cmux browser focus and notify",
		"",
		`- surface: ${payload.surface}`,
		payload.workspace ? `- workspace: ${payload.workspace}` : null,
		payload.focused ? "- focused: yes" : "- focused: no",
		payload.notified ? "- notified: yes" : null,
		payload.flash ? "- flash: yes" : null,
	].filter(Boolean);
	if (payload.snapshot) lines.push("", "## Snapshot", "```text", truncate(payload.snapshot, 1200), "```");
	return lines.join("\n");
}

function renderSkillPackResult(action: string, payload: any) {
	const lines = [`# cmux browser skill pack: ${action}`, ""];
	if (payload.entry) {
		lines.push(`- packId: ${payload.entry.packId}`);
		lines.push(`- kind: ${payload.entry.kind}`);
		if (payload.entry.site) lines.push(`- site: ${payload.entry.site}`);
		if (payload.entry.path) lines.push(`- path: ${payload.entry.path}`);
	}
	if (Array.isArray(payload.entries)) {
		lines.push("", "## Skill packs", ...(payload.entries.length ? payload.entries.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`) : ["- No skill packs found."]));
	}
	if (payload.content) lines.push("", "## Content", payload.content);
	if (typeof payload.removed === "number") lines.push(`- removed: ${payload.removed}`);
	return lines.join("\n");
}

function mechanicPackIds(mechanic: string) {
	const normalized = String(mechanic || "").toLowerCase();
	if (normalized === "dialogs") return ["dialogs"];
	if (normalized === "uploads") return ["file-uploads"];
	if (normalized === "downloads") return ["downloads"];
	if (normalized === "iframes") return ["iframes"];
	if (normalized === "shadow_dom") return ["shadow-dom"];
	return [];
}

function buildMechanicInspectScript(mechanic: string) {
	const normalized = String(mechanic || "").toLowerCase();
	return `(() => {
		const visible = (el) => {
			if (!el) return false;
			const s = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
		};
		const textOf = (el) => ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
		const selectorOf = (el) => {
			if (!el || !el.tagName) return null;
			const parts = [el.tagName.toLowerCase()];
			if (el.id) parts.push('#' + el.id);
			if (el.getAttribute('name')) parts.push('[name=' + JSON.stringify(el.getAttribute('name')) + ']');
			if (el.getAttribute('type')) parts.push('[type=' + JSON.stringify(el.getAttribute('type')) + ']');
			return parts.join('');
		};
		if (${JSON.stringify(normalized)} === 'uploads') {
			const inputs = Array.from(document.querySelectorAll('input[type="file"]')).slice(0, 12).map((el) => ({
				selector: selectorOf(el),
				multiple: !!el.multiple,
				accept: el.getAttribute('accept') || null,
				disabled: !!el.disabled,
				visible: visible(el),
				text: textOf(el.closest('label, form, div') || el).slice(0, 200),
			}));
			return JSON.stringify({ mechanic: 'uploads', fileInputCount: inputs.length, inputs });
		}
		if (${JSON.stringify(normalized)} === 'downloads') {
			const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"]')).filter((el) => visible(el)).map((el) => ({
				selector: selectorOf(el),
				text: textOf(el).slice(0, 160),
				href: el.href || el.getAttribute('href') || null,
				download: el.getAttribute('download') || null,
			})).filter((item) => /(download|export|csv|pdf|save|report)/i.test([item.text, item.href, item.download].filter(Boolean).join(' '))).slice(0, 16);
			return JSON.stringify({ mechanic: 'downloads', candidateCount: candidates.length, candidates });
		}
		if (${JSON.stringify(normalized)} === 'iframes') {
			const frames = Array.from(document.querySelectorAll('iframe, frame')).slice(0, 16).map((el, index) => ({
				index,
				title: el.getAttribute('title') || null,
				name: el.getAttribute('name') || null,
				src: el.getAttribute('src') || null,
				visible: visible(el),
				selector: selectorOf(el),
			}));
			return JSON.stringify({ mechanic: 'iframes', frameCount: frames.length, frames });
		}
		if (${JSON.stringify(normalized)} === 'shadow_dom') {
			const hosts = Array.from(document.querySelectorAll('*')).filter((el) => el.shadowRoot).slice(0, 16).map((el) => ({
				tag: el.tagName.toLowerCase(),
				selector: selectorOf(el),
				mode: el.shadowRoot?.mode || 'open',
				text: textOf(el).slice(0, 160),
			}));
			return JSON.stringify({ mechanic: 'shadow_dom', hostCount: hosts.length, hosts });
		}
		const dialogCandidates = Array.from(document.querySelectorAll('dialog,[role="dialog"],[aria-modal="true"],.modal,.dialog,[data-modal]')).filter((el) => visible(el)).slice(0, 12).map((el) => ({
			selector: selectorOf(el),
			text: textOf(el).slice(0, 220),
			buttons: Array.from(el.querySelectorAll('button,[role="button"]')).slice(0, 8).map((button) => textOf(button)).filter(Boolean),
		}));
		return JSON.stringify({ mechanic: 'dialogs', dialogCount: dialogCandidates.length, dialogs: dialogCandidates });
	})();`;
}

function listRecentDownloadArtifacts(options: { limit?: number; sinceMinutes?: number } = {}) {
	const downloadsDir = join(homedir(), 'Downloads');
	if (!existsSync(downloadsDir)) return [] as any[];
	const sinceMinutes = Math.max(1, Math.min(24 * 60, Number(options.sinceMinutes || 30)));
	const cutoff = Date.now() - sinceMinutes * 60_000;
	return readdirSync(downloadsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const path = join(downloadsDir, entry.name);
			const stats = statSync(path);
			return { name: entry.name, path, bytes: stats.size || 0, modifiedAt: new Date(stats.mtimeMs).toISOString(), modifiedMs: stats.mtimeMs };
		})
		.filter((entry) => entry.modifiedMs >= cutoff)
		.sort((a, b) => b.modifiedMs - a.modifiedMs)
		.slice(0, Math.max(1, Math.min(20, Number(options.limit || 8))));
}

function diffDownloadArtifacts(before: any[] = [], after: any[] = []) {
	const beforeByPath = new Map((before || []).map((entry: any) => [entry.path, entry]));
	const created = [] as any[];
	const updated = [] as any[];
	for (const entry of after || []) {
		const previous = beforeByPath.get(entry.path);
		if (!previous) created.push(entry);
		else if (Number(entry.modifiedMs || 0) > Number(previous.modifiedMs || 0) || Number(entry.bytes || 0) !== Number(previous.bytes || 0)) updated.push({ before: previous, after: entry });
	}
	return {
		created,
		updated,
		changed: [...created, ...updated.map((item) => item.after)],
	};
}

function parseBrowserTabList(raw: string) {
	const text = String(raw || "").trim();
	if (!text) return [] as any[];
	const parsed = parsePossiblyJson(text);
	if (Array.isArray(parsed)) return parsed.map((item: any, index: number) => ({ index: Number(item.index ?? item.id ?? index), active: Boolean(item.active ?? item.current ?? item.selected), title: item.title || null, url: item.url || item.href || null, raw: item }));
	if (parsed && Array.isArray((parsed as any).tabs)) return (parsed as any).tabs.map((item: any, index: number) => ({ index: Number(item.index ?? item.id ?? index), active: Boolean(item.active ?? item.current ?? item.selected), title: item.title || null, url: item.url || item.href || null, raw: item }));
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
		const active = /^[*>]/.test(line) || /\b(active|selected|current)\b/i.test(line);
		const indexMatch = line.match(/(?:^|\s|\[)(\d+)(?:\]|\s|:|-|$)/);
		const urlMatch = line.match(/https?:\/\/\S+/);
		const parsedIndex = indexMatch ? Number(indexMatch[1]) : index;
		let title = line.replace(/^[*>]\s*/, "");
		if (indexMatch) title = title.replace(indexMatch[0], " ");
		if (urlMatch) title = title.replace(urlMatch[0], " ");
		return { index: parsedIndex, active, title: String(title || "").replace(/\s+/g, " ").trim(), url: urlMatch?.[0] || null, raw: line };
	});
}

async function captureBrowserTabState(
	pi: ExtensionAPI,
	surface: string | undefined,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const [raw, url, title] = await Promise.all([
		execBrowserText(pi, surface, ["tab", "list"], { signal, timeout }).catch(() => ""),
		execBrowserText(pi, surface, ["url"], { signal, timeout }).catch(() => null),
		execBrowserText(pi, surface, ["get", "title"], { signal, timeout }).catch(() => null),
	]);
	const tabs = parseBrowserTabList(raw || "");
	return {
		raw,
		tabs,
		count: tabs.length,
		activeIndex: tabs.find((tab: any) => tab.active)?.index ?? null,
		url,
		title,
	};
}

function diffBrowserTabState(before: any, after: any) {
	if (!before || !after) return null;
	const beforeIndices = new Set((before.tabs || []).map((tab: any) => Number(tab.index)));
	const createdTabs = (after.tabs || []).filter((tab: any) => !beforeIndices.has(Number(tab.index))).sort((a: any, b: any) => Number(a.index) - Number(b.index));
	const activeChanged = before.activeIndex !== after.activeIndex;
	const urlChanged = String(before.url || "") !== String(after.url || "");
	if (!createdTabs.length && !activeChanged && !urlChanged) return null;
	return {
		beforeCount: before.count || 0,
		afterCount: after.count || 0,
		createdTabs,
		activeChanged,
		beforeActiveIndex: before.activeIndex ?? null,
		afterActiveIndex: after.activeIndex ?? null,
		beforeUrl: before.url || null,
		afterUrl: after.url || null,
		urlChanged,
	};
}

async function adoptNewestBrowserTab(
	pi: ExtensionAPI,
	params: { surface?: string; tabTransition: any },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const createdTabs = params.tabTransition?.createdTabs || [];
	if (!createdTabs.length) return null;
	const target = createdTabs[createdTabs.length - 1];
	await execBrowserText(pi, params.surface, ["tab", "switch", String(target.index)], { signal, timeout });
	const afterState = await captureBrowserTabState(pi, params.surface, signal, timeout).catch(() => null);
	return {
		targetIndex: target.index,
		target,
		afterState,
	};
}

function mergeMechanicAssists(items: any[] = []) {
	return uniqueBy((items || []).filter(Boolean), (item: any) => `${item.mechanic || "unknown"}:${item.status || "unknown"}:${(item.notes || []).join("|")}`);
}

function inferRecoveryMechanics(assists: any[] = []) {
	return new Set((assists || []).map((item: any) => String(item?.mechanic || "").toLowerCase()).filter(Boolean));
}

async function attemptMechanicRecoveryForAction(
	pi: ExtensionAPI,
	params: { surface?: string | null; action?: string | null; target?: string | null; errorText?: string | null; assists?: any[]; includeSnapshot?: boolean; downloadTimeoutMs?: number },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const mechanics = inferRecoveryMechanics(params.assists || []);
	if (!mechanics.size) return null;
	const actions = [] as any[];
	let afterObservation = null as any;
	let status = "noop";
	if (mechanics.has("dialogs")) {
		const observation = await collectObservation(pi, { surface: params.surface || undefined, includeSnapshot: false, limit: 12, maxDepth: 3 }, signal).catch(() => null);
		const dismiss = observation ? await maybeDismissModal(pi, params.surface || undefined, observation, signal, timeout).catch(() => null) : null;
		if (dismiss) {
			actions.push({ strategy: "dismiss_modal", result: dismiss });
			afterObservation = dismiss.observation || afterObservation;
			status = "recovered";
		}
	}
	if (mechanics.has("downloads") && ["click", "dblclick", "press"].includes(String(params.action || ""))) {
		const wait = await waitForBrowserDownload(pi, { surface: params.surface || undefined, timeoutMs: Math.min(Number(params.downloadTimeoutMs || timeout), timeout) }, signal, Math.min(Number(params.downloadTimeoutMs || timeout), timeout)).catch(() => null);
		if (wait) {
			actions.push({ strategy: "wait_for_download", result: wait });
			status = status === "noop" ? "stabilized" : status;
		}
	}
	if (!actions.length) return null;
	return {
		status,
		classification: {
			issues: uniqueStrings(Array.from(mechanics)),
			strategies: uniqueStrings(actions.map((item: any) => item.strategy)),
			suggestedSkillPacks: [],
		},
		actions,
		beforeObservation: null,
		afterObservation,
		checkpoint: null,
	};
}

function inferMechanicsFromText(text?: string | null) {
	const input = String(text || "").toLowerCase();
	const mechanics = [] as string[];
	if (/(dialog|modal|consent|cookie|popup)/.test(input)) mechanics.push("dialogs");
	if (/(upload|file input|choose file|attachment)/.test(input)) mechanics.push("uploads");
	if (/(download|export|csv|pdf|save file)/.test(input)) mechanics.push("downloads");
	if (/(iframe|frame|embedded)/.test(input)) mechanics.push("iframes");
	if (/(shadow|web component|custom element)/.test(input)) mechanics.push("shadow_dom");
	return uniqueStrings(mechanics);
}

async function collectMechanicAssistsForFailure(
	pi: ExtensionAPI,
	params: { surface?: string | null; text?: string | null; limit?: number },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const mechanics = inferMechanicsFromText(params.text);
	const assists = [] as any[];
	for (const mechanic of mechanics.slice(0, 3)) {
		const payload = await runBrowserMechanic(
			pi,
			{ mechanic, action: "inspect", surface: params.surface || undefined, limit: params.limit || 3 },
			signal,
			timeout,
		).catch(() => null);
		if (payload) assists.push(payload);
	}
	return assists;
}

function shouldTrackDownloadArtifacts(params: any) {
	const text = [params?.action, params?.target, params?.url, params?.text, params?.value].filter(Boolean).join(" ").toLowerCase();
	return /(download|export|csv|pdf|save file|report)/.test(text);
}

async function waitForBrowserDownload(
	pi: ExtensionAPI,
	params: { surface?: string | null; path?: string | null; timeoutMs?: number },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const args = ["download", "wait"] as string[];
	addFlag(args, "--path", params.path || null);
	addFlag(args, "--timeout-ms", params.timeoutMs || timeout);
	const result = await execBrowserText(pi, params.surface || undefined, args, { signal, timeout: params.timeoutMs || timeout });
	return {
		commandResult: result,
		artifacts: listRecentDownloadArtifacts({ limit: 8, sinceMinutes: 30 }),
	};
}

async function handleBrowserDialog(
	pi: ExtensionAPI,
	params: { surface?: string | null; action: "accept" | "dismiss"; text?: string | null },
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const args = ["dialog", params.action] as string[];
	if (params.text) args.push(params.text);
	const result = await execBrowserText(pi, params.surface || undefined, args, { signal, timeout });
	return { commandResult: result };
}

function renderMechanicResult(payload: any) {
	const lines = [
		"# cmux browser mechanic",
		"",
		`- mechanic: ${payload.mechanic}`,
		`- action: ${payload.action}`,
		payload.surface ? `- surface: ${payload.surface}` : null,
		payload.site ? `- site: ${payload.site}` : null,
		payload.status ? `- status: ${payload.status}` : null,
	].filter(Boolean);
	if (payload.notes?.length) lines.push("", "## Notes", ...payload.notes.map((note: string) => `- ${note}`));
	if (payload.skillPacks?.length) lines.push("", "## Matching skill packs", ...payload.skillPacks.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`));
	if (payload.memoryEntries?.length) lines.push("", "## Matching memory", ...payload.memoryEntries.map((entry: any) => `- ${entry.key} [${entry.kind || "note"}] ${entry.title || entry.site || "untitled"}: ${truncate(entry.content || "", 180)}`));
	if (payload.inspection) lines.push("", "## Inspection", truncate(stringify(payload.inspection), 2600));
	if (payload.downloadArtifacts?.length) lines.push("", "## Recent download artifacts", ...payload.downloadArtifacts.map((item: any) => `- ${item.name} • ${item.modifiedAt} • ${item.bytes} bytes`));
	if (payload.result) lines.push("", "## Result", typeof payload.result === "string" ? payload.result : truncate(stringify(payload.result), 1400));
	if (payload.observation) lines.push("", "## Observation", buildObservationSummary(payload.observation, { includeSnapshot: false }));
	return lines.join("\n");
}

async function runBrowserMechanic(
	pi: ExtensionAPI,
	params: any,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const mechanic = String(params.mechanic || "").toLowerCase();
	const action = String(params.action || "guide").toLowerCase();
	const surface = params.surface || process.env.CMUX_SURFACE_ID || null;
	const observation = await collectObservation(pi, { surface: surface || undefined, includeSnapshot: false, limit: 12, maxDepth: 3 }, signal).catch(() => null);
	const site = inferSiteKey(params.site, observation?.url || null);
	const packs = mechanicPackIds(mechanic);
	const interactionSkillPacks = listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => packs.includes(entry.packId));
	const domainSkillPacks = site ? listSkillPackEntries({ kind: "domain", site }).slice(0, 3) : [];
	const memoryEntries = site ? recallMemoryEntries({ site, query: mechanic, limit: Math.max(1, Math.min(10, Number(params.limit || 5))) }) : [];
	const notes = [] as string[];
	let status = "guided";
	let result: any = null;
	let inspection: any = null;
	let downloadArtifacts: any[] = [];

	if (action === "inspect" || action === "apply_safe_recovery") {
		inspection = await execBrowserJson(pi, surface || undefined, ["eval", buildMechanicInspectScript(mechanic)], { signal, timeout }).catch(() => null);
	}
	if (mechanic === "dialogs") {
		notes.push("Prefer safe dismiss text like Close, Dismiss, Not now, No thanks, Later, or Cancel.");
		if (inspection?.dialogCount !== undefined) notes.push(`Detected ${inspection.dialogCount} visible dialog/modal candidate(s).`);
		if (action === "apply_safe_recovery") {
			result = await handleBrowserDialog(pi, { surface, action: "dismiss", text: params.dialogText || null }, signal, timeout).catch(() => null);
			if (!result) result = await maybeDismissModal(pi, surface || undefined, observation, signal, timeout).catch(() => null);
			status = result ? "applied-safe-recovery" : "no-safe-recovery-result";
			if (!result) notes.push("No safe modal-dismiss candidate could be resolved automatically.");
		}
	} else if (mechanic === "uploads") {
		notes.push("Prefer real file inputs when present and verify file-name/status after selection.");
		notes.push("Checkpoint before multi-step uploads so the flow can be resumed safely.");
		if (inspection?.fileInputCount !== undefined) notes.push(`Detected ${inspection.fileInputCount} file-input candidate(s).`);
		if (action === "prepare_target" && inspection?.inputs?.length) {
			const candidate = inspection.inputs.find((item: any) => item.visible && item.selector) || inspection.inputs.find((item: any) => item.selector);
			if (candidate?.selector) {
				result = await execBrowserText(pi, surface || undefined, ["focus", candidate.selector, "--snapshot-after"], { signal, timeout }).catch(() => null);
				status = result ? "prepared-upload-target" : "failed-to-prepare-upload-target";
				notes.push(`Focused candidate upload target ${candidate.selector}.`);
				notes.push("Direct file attachment is not yet exposed by the cmux browser CLI, so this prepares the target but does not set local files automatically.");
			}
		}
		if (!inspection?.fileInputCount) status = action === "inspect" ? "inspected-no-file-input" : status;
	} else if (mechanic === "downloads") {
		notes.push("Treat downloads as verification-sensitive. Confirm artifact creation or success messaging after the triggering action.");
		if (inspection?.candidateCount !== undefined) notes.push(`Detected ${inspection.candidateCount} download/export candidate(s) in the page.`);
		if (action === "wait_for_download") {
			result = await waitForBrowserDownload(pi, { surface, path: params.path || null, timeoutMs: timeout }, signal, timeout).catch(() => null);
			downloadArtifacts = result?.artifacts || [];
			status = result ? "waited-for-download" : "download-wait-failed";
		} else if (action === "inspect" || action === "apply_safe_recovery") {
			downloadArtifacts = listRecentDownloadArtifacts({ limit: params.limit || 5, sinceMinutes: params.sinceMinutes || 30 });
			if (downloadArtifacts.length) notes.push(`Found ${downloadArtifacts.length} recent file(s) in ~/Downloads.`);
			else notes.push("No recent download artifacts found in ~/Downloads for the requested time window.");
			status = "inspected-downloads";
		}
	} else if (mechanic === "iframes") {
		notes.push("If visible controls seem missing from the main DOM, suspect iframe scoping before retrying blindly.");
		if (inspection?.frameCount !== undefined) notes.push(`Detected ${inspection.frameCount} iframe/frame element(s).`);
		status = action === "inspect" ? "inspected-iframes" : status;
	} else if (mechanic === "shadow_dom") {
		notes.push("If visible controls exist but selector resolution keeps failing, suspect encapsulated web components or shadow DOM.");
		if (inspection?.hostCount !== undefined) notes.push(`Detected ${inspection.hostCount} shadow-host candidate(s).`);
		status = action === "inspect" ? "inspected-shadow-dom" : status;
	} else {
		notes.push("Unknown mechanic requested. Use one of dialogs, uploads, downloads, iframes, or shadow_dom.");
		status = "unsupported-mechanic";
	}

	return {
		mechanic,
		action,
		surface,
		site,
		status,
		skillPacks: [...interactionSkillPacks, ...domainSkillPacks],
		memoryEntries,
		observation,
		inspection,
		downloadArtifacts,
		result,
		notes,
	};
}

async function runBrowserDoctor(
	pi: ExtensionAPI,
	params: any,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const surface = params.surface || process.env.CMUX_SURFACE_ID || null;
	const report: any = {
		ranAt: nowIso(),
		surface,
		owner: params.owner || null,
		team: params.team || null,
		cmuxBinary: resolveCmuxBinary() || null,
		issues: [],
		recommendations: [],
		lock: surface ? activeLockForSurface(surface) : null,
		memoryEntries: [],
		checkpoints: [],
		memorySummary: null,
		checkpointSummary: null,
		skillPacks: [],
		skillPackSummary: null,
	};

	if (!report.cmuxBinary) {
		addDoctorIssue(report, {
			code: "cmux-cli-missing",
			severity: "blocking",
			summary: "cmux CLI is not available, so browser diagnostics cannot run.",
			recommendation: installHelp(),
		});
		report.status = classifyDoctorStatus(report);
		return report;
	}

	if (!surface) {
		addDoctorIssue(report, {
			code: "surface-unspecified",
			severity: "warning",
			summary: "No browser surface was specified. Doctor will rely on cmux/browser defaults, which may point at the wrong surface.",
			recommendation: "Pass an explicit browser `surface` when diagnosing shared or uncertain browser state.",
		});
	}

	if (report.lock && params.owner && report.lock.owner !== params.owner) {
		addDoctorIssue(report, {
			code: "lock-owned-by-other",
			severity: "blocking",
			summary: `Surface ${surface} is locked by ${report.lock.owner}, not ${params.owner}.`,
			recommendation: `Use cmux_browser_lock handoff or coordinate with ${report.lock.owner} before mutating this shared surface.`,
		});
	} else if (report.lock && params.team && report.lock.team && report.lock.team !== params.team) {
		addDoctorIssue(report, {
			code: "lock-team-mismatch",
			severity: "warning",
			summary: `Surface ${surface} is currently associated with team ${report.lock.team}, not ${params.team}.`,
			recommendation: "Verify the intended team owns this surface before continuing browser work.",
		});
	} else if (!report.lock && params.owner) {
		report.recommendations.push(`Consider acquiring a browser lock for ${surface || "the target surface"} before performing mutating shared-surface actions.`);
	}

	try {
		report.runtimeCapabilities = await getBrowserRuntimeCapabilities(pi, signal, timeout).catch(() => null);
		report.identify = await execBrowserText(pi, surface || undefined, ["identify"], { signal, timeout });
	} catch (error: any) {
		report.identifyError = error.message || String(error);
		addDoctorIssue(report, {
			code: "browser-identify-failed",
			severity: "blocking",
			summary: `Unable to identify the target browser surface${surface ? ` (${surface})` : ""}: ${report.identifyError}`,
			recommendation: "Verify you are targeting a live browser surface. If state is stale, try cmux_browser_recover or restore a checkpoint with cmux_browser_session.",
		});
		report.status = classifyDoctorStatus(report);
		return report;
	}

	report.url = await execBrowserText(pi, surface || undefined, ["url"], { signal, timeout }).catch(() => null);
	report.title = await execBrowserText(pi, surface || undefined, ["get", "title"], { signal, timeout }).catch(() => null);

	if (params.includeObservation !== false) {
		try {
			report.observation = await collectObservation(
				pi,
				{ surface: surface || undefined, includeSnapshot: false, limit: Math.max(6, Math.min(20, Number(params.limit || 12))), maxDepth: 3 },
				signal,
			);
		} catch (error: any) {
			report.observationError = error.message || String(error);
			addDoctorIssue(report, {
				code: "observation-failed",
				severity: "warning",
				summary: `Observation failed: ${report.observationError}`,
				recommendation: "If the surface is unstable, run cmux_browser_recover before retrying a deeper browser workflow.",
			});
		}
	}

	report.site = inferSiteKey(params.site, report.observation?.url || report.url || null);

	if (params.includeSurfaceHealth !== false) {
		report.surfaceHealthText = await execCmux(pi, ["surface-health"], { signal, timeout }).then((result) => (result.stdout || "").trim()).catch(() => null);
	}

	if (params.includeTabList !== false) {
		report.tabListRaw = await execBrowserText(pi, surface || undefined, ["tab", "list"], { signal, timeout }).catch(() => null);
	}

	if (report.site && params.includeMemory !== false) {
		report.memoryEntries = recallMemoryEntries({ site: report.site, query: params.memoryQuery || null, limit: Math.max(1, Math.min(10, Number(params.memoryLimit || 5))) });
		report.memorySummary = {
			count: report.memoryEntries.length,
			kinds: uniqueStrings(report.memoryEntries.map((entry: any) => entry.kind || "note")),
			latestUpdatedAt: report.memoryEntries[0]?.updatedAt || null,
		};
	}

	if (params.includeCheckpointSummary !== false) {
		report.checkpoints = listCheckpointEntries({
			limit: Math.max(1, Math.min(10, Number(params.checkpointLimit || 5))),
			...(report.site ? { urlContains: report.site } : {}),
		});
		report.checkpointSummary = {
			count: report.checkpoints.length,
			latestObservedAt: report.checkpoints[0]?.observedAt || null,
			bookmarkedCount: report.checkpoints.filter((entry: any) => entry.bookmarked).length,
		};
	}

	if (report.runtimeCapabilities?.missingUploadSetFiles) {
		addDoctorIssue(report, {
			code: "upload-runtime-capability-missing",
			severity: "warning",
			summary: "The current cmux browser runtime does not appear to expose a true file-upload attachment primitive.",
			recommendation: "Upload flows can prepare/focus file targets but cannot yet set local files directly until the underlying cmux browser runtime adds set-files/file-chooser support.",
		});
	}
	if (report.runtimeCapabilities?.networkRequests !== true) {
		report.recommendations.push("Network-request inspection is unavailable or unconfirmed in this cmux browser runtime, so network-aware verification may be limited.");
	}
	if (report.observation?.flags?.includes("modal-present")) {
		addDoctorIssue(report, {
			code: "modal-present",
			severity: "warning",
			summary: "A modal or blocking overlay appears to be present on the page.",
			recommendation: "Consider cmux_browser_recover with strategy=\"dismiss_modal\" before continuing.",
		});
	}
	if (report.observation?.flags?.includes("alerts-present")) {
		addDoctorIssue(report, {
			code: "alerts-present",
			severity: "warning",
			summary: "The page appears to contain alerts or error states.",
			recommendation: "Inspect the current page state with cmux_browser_observe or cmux_browser_assert before retrying the last browser action.",
		});
	}
	if (report.observation?.flags?.includes("auth-boundary")) {
		addDoctorIssue(report, {
			code: "auth-boundary",
			severity: "warning",
			summary: "The current page appears to be an auth/login boundary.",
			recommendation: "Prefer checkpoint + handoff or explicit credential-aware continuation instead of blind retries through auth.",
		});
	}
	if (report.observation?.flags?.includes("destructive-or-commit-action-visible")) {
		addDoctorIssue(report, {
			code: "commit-action-visible",
			severity: "warning",
			summary: "Commit-like or destructive actions are visible on the page.",
			recommendation: "Use explicit verification and, when shared, lock ownership before taking any commit-like browser action.",
		});
	}

	if (report.site) {
		report.skillPacks = listSkillPackEntries({ kind: "domain", site: report.site }).slice(0, 5);
		report.skillPackSummary = { count: report.skillPacks.length };
	}

	if (report.site && !report.memoryEntries.length) {
		report.recommendations.push(`No site memory was found for ${report.site}. If you learn durable workflow details here, save them with cmux_browser_memory.`);
	}
	if (report.site && !report.checkpoints.length) {
		report.recommendations.push(`No recent checkpoints matched ${report.site}. Consider saving a checkpoint before risky browser work.`);
	}
	if (!report.tabListRaw) {
		report.recommendations.push("Tab list could not be retrieved. If tab context seems wrong, verify the intended surface and active tab before proceeding.");
	}

	report.recommendations = uniqueStrings(report.recommendations);
	report.status = classifyDoctorStatus(report);
	return report;
}

async function runBrowserBootstrap(
	pi: ExtensionAPI,
	params: any,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	const workspace = params.workspace || process.env.CMUX_WORKSPACE_ID || null;
	const shouldAcquireLock = params.acquireLock === true || (!!params.owner && params.acquireLock !== false);
	const visibility = String(params.visibility || (params.focus ? "visible" : "background")).toLowerCase();
	const notes = [] as string[];
	let selectedSurface: any = null;
	let action = "reused";
	let lockRecord: any = null;

	if (params.surface) {
		selectedSurface = { ref: params.surface, id: params.surface, workspace_ref: workspace, type: "browser" };
		action = "explicit-surface";
	} else {
		const listed = await listBrowserSurfaces(pi, workspace, signal, timeout).catch(() => ({ workspace, surfaces: [] }));
		selectedSurface = params.reuseExisting === false ? null : pickPreferredBrowserSurface(listed.surfaces);
		if (selectedSurface) {
			action = "reused-surface";
		} else if (params.createIfMissing !== false) {
			const created = await createBrowserSurface(pi, { workspace: listed.workspace || workspace, url: params.url || null }, signal, timeout);
			selectedSurface = created.surface;
			action = "created-surface";
			notes.push(`Created browser surface ${selectedSurface.ref || selectedSurface.id}.`);
		} else {
			throw new Error("No reusable browser surface was found and createIfMissing=false.");
		}
	}

	const surface = selectedSurface?.ref || selectedSurface?.id || params.surface || null;
	if (!surface) throw new Error("Unable to resolve a browser surface for bootstrap.");

	const doctor = await runBrowserDoctor(
		pi,
		{
			surface,
			owner: params.owner,
			team: params.team,
			includeObservation: false,
			includeSurfaceHealth: false,
			includeTabList: false,
			includeMemory: false,
			includeCheckpointSummary: false,
		},
		signal,
		timeout,
	);
	if (doctor.status === "blocked") {
		throw new Error(`Bootstrap doctor blocked progress for ${surface}: ${(doctor.issues || []).map((issue: any) => issue.code).join(", ") || "unknown issue"}`);
	}

	if (shouldAcquireLock) {
		lockRecord = acquireSurfaceLock({ surface, owner: params.owner, team: params.team, note: params.note || `bootstrap: ${params.url || params.goal || "browser"}`, leaseSeconds: params.leaseSeconds || 1800, force: false });
		notes.push(`Acquired browser lock for ${lockRecord.owner}.`);
	}

	if (params.openInNewTab) {
		await execBrowserText(pi, surface, ["tab", "new"], { signal, timeout }).catch(() => null);
		notes.push("Opened a new tab before navigation.");
	}

	if (params.url && action !== "created-surface") {
		await runTaskAction(
			pi,
			{ surface, action: "navigate", url: params.url, waitForLoadState: params.waitForLoadState || "complete", includeObservation: false },
			signal,
			timeout,
		);
		notes.push(`Navigated ${surface} to ${params.url}.`);
	}

	let focusResult = null;
	if (visibility === "visible" || visibility === "notify") {
		focusResult = await focusBrowserSurface(
			pi,
			{
				surface,
				workspace,
				flash: params.flash === true,
				notifyTitle: visibility === "notify" ? params.notifyTitle || "CMUX browser ready" : null,
				notifyBody: visibility === "notify" ? params.notifyBody || `Browser surface ${surface} is ready.` : null,
			},
			signal,
			timeout,
		);
	}

	const observation = await collectObservation(
		pi,
		{ surface, includeSnapshot: false, limit: Math.max(6, Math.min(20, Number(params.limit || 12))), maxDepth: 3 },
		signal,
	).catch(() => null);
	const site = inferSiteKey(params.site, observation?.url || params.url || null);
	const memoryEntries = params.useMemory === false || !site
		? []
		: recallMemoryEntries({ site, query: params.memoryQuery || null, kind: params.memoryKind || null, limit: Math.max(1, Math.min(10, Number(params.memoryLimit || 5))) });
	const skillPacks = site ? listSkillPackEntries({ kind: "domain", site }).slice(0, 5) : [];
	let checkpoint = null;
	if (params.checkpointKey) {
		checkpoint = await saveBrowserCheckpoint(
			pi,
			{ key: params.checkpointKey, surface, note: params.note || `Bootstrap checkpoint for ${site || params.url || surface}`, includeSnapshot: params.includeSnapshot !== false, timeout },
			signal,
		).catch(() => null);
	}

	return {
		status: "ready",
		action,
		workspace,
		surface,
		url: observation?.url || params.url || null,
		site,
		lock: lockRecord,
		focusResult,
		memoryEntries,
		skillPacks,
		observation,
		checkpoint,
		notes,
	};
}

async function runTaskAction(
	pi: ExtensionAPI,
	params: any,
	signal?: AbortSignal,
	timeout = DEFAULT_TIMEOUT,
) {
	let selector = params.selector;
	let resolved: any = null;
	let mechanicAssists: any[] = Array.isArray(params._priorMechanicAssists) ? [...params._priorMechanicAssists] : [];
	let frameContext: any = null;
	let restoredMainFrame = false;
	let tabTransition: any = null;
	let recovery: any = Array.isArray(params._priorRecoveries) ? params._priorRecoveries[params._priorRecoveries.length - 1] || null : null;
	const action = String(params.action);
	if (params.stopBeforeIrreversible !== false) {
		const risk = classifyBrowserActionRisk(params);
		if (risk.requiresApproval && !approvalGrantedForBrowserRisk(params)) {
			const error: any = new Error(`Browser action requires explicit user approval before execution: ${risk.level} risk (${risk.reasons.join("; ") || "risky action"})`);
			error.approvalRequired = true;
			error.risk = risk;
			throw error;
		}
	}
	const resolutionQuery = {
		target: params.target,
		targetKind: params.targetKind || (action === "fill" || action === "type" ? "input" : action === "select" ? "select" : action === "check" || action === "uncheck" ? "checkbox" : "button"),
		exact: params.exact,
	};
	const snapshotAfter = params.snapshotAfter ?? ["navigate", "click", "dblclick", "fill", "type", "select", "check", "uncheck", "scroll_into_view", "dialog_dismiss", "dialog_accept"].includes(action);
	const needsSemanticResolution = !selector && ["click", "dblclick", "hover", "focus", "fill", "type", "select", "check", "uncheck", "scroll_into_view"].includes(action);
	const shouldMonitorTabs = params.detectTabChanges !== false && ["click", "dblclick", "press"].includes(action);
	const shouldMonitorDownloads = action === "download_wait" || shouldTrackDownloadArtifacts(params);
	const shouldMonitorNetwork = params.detectNetworkChanges !== false && ["click", "dblclick", "press", "navigate", "download_wait"].includes(action);
	const preTabState = shouldMonitorTabs ? await captureBrowserTabState(pi, params.surface, signal, timeout).catch(() => null) : null;
	const preNetworkState = shouldMonitorNetwork ? await captureBrowserNetworkState(pi, params.surface, signal, timeout).catch(() => null) : null;
	const downloadBaseline = shouldMonitorDownloads ? listRecentDownloadArtifacts({ limit: params.downloadArtifactLimit || 8, sinceMinutes: params.downloadSinceMinutes || 30 }) : [];
	if (needsSemanticResolution) {
		try {
			resolved = await resolveSmartSelector(pi, params.surface, resolutionQuery, signal, timeout);
			selector = resolved.selector;
		} catch (mainError: any) {
			try {
				const frameResolved = await resolveSmartSelectorInFrames(pi, params.surface, resolutionQuery, signal, timeout);
				if (frameResolved?.resolved) {
					frameContext = frameResolved.frame;
					resolved = frameResolved.resolved;
					selector = resolved.selector;
					mechanicAssists.push({ mechanic: "iframes", status: "resolved-in-frame", notes: [`Resolved target inside frame ${frameContext.selector || frameContext.name || frameContext.index || "unknown"}.`] });
				} else {
					throw mainError;
				}
			} catch {
				mechanicAssists = mergeMechanicAssists([
					...mechanicAssists,
					...(await collectMechanicAssistsForFailure(pi, { surface: params.surface || null, text: `${mainError.message || String(mainError)} ${params.target || ""}` }, signal, timeout).catch(() => [])),
				]);
				if (!params._mechanicRecoveryAttempted) {
					const autoRecovery = await attemptMechanicRecoveryForAction(
						pi,
						{
							surface: params.surface || null,
							action,
							target: params.target || null,
							errorText: mainError.message || String(mainError),
							assists: mechanicAssists,
							includeSnapshot: params.includeObservation !== false,
							downloadTimeoutMs: params.downloadTimeoutMs,
						},
						signal,
						timeout,
					).catch(() => null);
					if (autoRecovery) {
						const retried = await runTaskAction(
							pi,
							{
								...params,
								_mechanicRecoveryAttempted: true,
								_priorMechanicAssists: mechanicAssists,
								_priorRecoveries: [...(params._priorRecoveries || []), autoRecovery],
							},
							signal,
							timeout,
						);
						retried.recovery = retried.recovery || autoRecovery;
						retried.mechanicAssists = mergeMechanicAssists([...(retried.mechanicAssists || []), ...mechanicAssists]);
						return retried;
					}
				}
				const mechanicHint = mechanicAssists.length
					? ` Mechanic hints: ${mechanicAssists.map((item: any) => `${item.mechanic}(${item.status})`).join(", ")}.`
					: "";
				throw new Error(`${mainError.message || String(mainError)}${mechanicHint}`);
			}
		}
	}
	let result: any = null;
	let checks: any[] = [];
	let observation: any = null;
	try {
		switch (action) {
			case "open":
				result = await execBrowserText(pi, params.surface, ["open", ...(params.url ? [params.url] : [])], { signal, timeout });
				break;
			case "navigate": {
				if (!params.url) throw new Error("url is required for navigate");
				const args = ["navigate", params.url] as string[];
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			case "press": {
				if (!params.key) throw new Error("key is required for press");
				const args = ["press", params.key] as string[];
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			case "dialog_dismiss": {
				result = await handleBrowserDialog(pi, { surface: params.surface || null, action: "dismiss", text: params.dialogText || null }, signal, timeout);
				break;
			}
			case "dialog_accept": {
				result = await handleBrowserDialog(pi, { surface: params.surface || null, action: "accept", text: params.dialogText || null }, signal, timeout);
				break;
			}
			case "download_wait": {
				result = await waitForBrowserDownload(pi, { surface: params.surface || null, path: params.downloadPath || null, timeoutMs: params.downloadTimeoutMs || timeout }, signal, timeout);
				break;
			}
			case "wait": {
				const waitArgs = ["wait"] as string[];
				addFlag(waitArgs, "--selector", selector || params.waitForSelector);
				addFlag(waitArgs, "--text", params.text || params.waitForText);
				addFlag(waitArgs, "--url-contains", params.waitForUrlContains);
				addFlag(waitArgs, "--load-state", params.waitForLoadState);
				addFlag(waitArgs, "--timeout-ms", timeout);
				result = await execBrowserText(pi, params.surface, waitArgs, { signal, timeout });
				break;
			}
			case "fill":
			case "type": {
				if (resolved?.strategy === "shadow") {
					result = await executeShadowAction(pi, params.surface, resolutionQuery, { action, text: params.text }, signal, timeout);
					mechanicAssists.push({ mechanic: "shadow_dom", status: "executed-shadow-fallback", notes: [`Executed ${action} via open shadow DOM fallback${resolved.shadowHostSelector ? ` on ${resolved.shadowHostSelector}` : ""}.`] });
					break;
				}
				if (!selector) throw new Error(`${action} requires selector or target`);
				const args = [action, selector] as string[];
				if (typeof params.text === "string") args.push(params.text);
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			case "select": {
				if (resolved?.strategy === "shadow") {
					result = await executeShadowAction(pi, params.surface, resolutionQuery, { action, value: params.value }, signal, timeout);
					mechanicAssists.push({ mechanic: "shadow_dom", status: "executed-shadow-fallback", notes: [`Executed ${action} via open shadow DOM fallback${resolved.shadowHostSelector ? ` on ${resolved.shadowHostSelector}` : ""}.`] });
					break;
				}
				if (!selector || typeof params.value !== "string") throw new Error("select requires selector/target and value");
				const args = ["select", selector, params.value] as string[];
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			case "check":
			case "uncheck":
			case "click":
			case "dblclick":
			case "hover":
			case "focus": {
				if (resolved?.strategy === "shadow") {
					result = await executeShadowAction(pi, params.surface, resolutionQuery, { action }, signal, timeout);
					mechanicAssists.push({ mechanic: "shadow_dom", status: "executed-shadow-fallback", notes: [`Executed ${action} via open shadow DOM fallback${resolved.shadowHostSelector ? ` on ${resolved.shadowHostSelector}` : ""}.`] });
					break;
				}
				if (!selector) throw new Error(`${action} requires selector or target`);
				const args = [action, selector] as string[];
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			case "scroll_into_view": {
				if (resolved?.strategy === "shadow") {
					result = await executeShadowAction(pi, params.surface, resolutionQuery, { action }, signal, timeout);
					mechanicAssists.push({ mechanic: "shadow_dom", status: "executed-shadow-fallback", notes: [`Executed ${action} via open shadow DOM fallback${resolved.shadowHostSelector ? ` on ${resolved.shadowHostSelector}` : ""}.`] });
					break;
				}
				if (!selector) throw new Error("scroll_into_view requires selector or target");
				const args = ["scroll-into-view", selector] as string[];
				addBoolFlag(args, "--snapshot-after", snapshotAfter);
				result = await execBrowserText(pi, params.surface, args, { signal, timeout });
				break;
			}
			default:
				throw new Error(`Unsupported action: ${action}`);
		}
		if (shouldMonitorTabs) {
			const postTabState = await captureBrowserTabState(pi, params.surface, signal, timeout).catch(() => null);
			tabTransition = diffBrowserTabState(preTabState, postTabState);
			if (tabTransition?.createdTabs?.length && params.switchToNewTab !== false) {
				const adoptedTab = await adoptNewestBrowserTab(pi, { surface: params.surface, tabTransition }, signal, timeout).catch(() => null);
				if (adoptedTab) {
					tabTransition = { ...tabTransition, adoptedTab, afterState: adoptedTab.afterState || postTabState };
				}
			}
		}
		let browserDownloadResult: any = null;
		let networkTransition: any = null;
		if (shouldMonitorDownloads && params.autoWaitForDownload !== false && ["click", "dblclick", "press", "download_wait"].includes(action)) {
			browserDownloadResult = await waitForBrowserDownload(
				pi,
				{ surface: params.surface || null, path: params.downloadPath || null, timeoutMs: Math.min(Number(params.downloadTimeoutMs || timeout), timeout) },
				signal,
				Math.min(Number(params.downloadTimeoutMs || timeout), timeout),
			).catch(() => null);
			if (browserDownloadResult && action === "download_wait") result = browserDownloadResult;
		}
		if (shouldMonitorNetwork) {
			const postNetworkState = await captureBrowserNetworkState(pi, params.surface, signal, timeout).catch(() => null);
			networkTransition = diffBrowserNetworkState(preNetworkState, postNetworkState);
		}
		checks = await runPostconditions(
			pi,
			{
				surface: params.surface,
				waitForSelector: params.waitForSelector,
				waitForText: params.waitForText,
				waitForUrlContains: params.waitForUrlContains,
				waitForLoadState: params.waitForLoadState,
				expectTitleIncludes: params.expectTitleIncludes,
				expectValue: params.expectValue,
				selectorForValue: selector,
				shadowValueQuery: resolved?.strategy === "shadow" ? resolutionQuery : null,
			},
			signal,
			timeout,
		);
		if (frameContext) {
			await resetBrowserFrameContext(pi, params.surface, signal, timeout);
			restoredMainFrame = true;
		}
		observation = params.includeObservation === false ? null : await collectObservation(
			pi,
			{ surface: params.surface, includeSnapshot: false, limit: 12, maxDepth: 3 },
			signal,
		).catch(() => null);
		const site = inferSiteKey(null, observation?.url || params.url || null);
		const skillPacks = site ? listSkillPackEntries({ kind: "domain", site }).slice(0, 3) : [];
		const downloadArtifacts = shouldMonitorDownloads ? listRecentDownloadArtifacts({ limit: params.downloadArtifactLimit || 8, sinceMinutes: params.downloadSinceMinutes || 30 }) : [];
		const downloadDiff = shouldMonitorDownloads ? diffDownloadArtifacts(downloadBaseline, downloadArtifacts) : null;
		return {
			action,
			surface: params.surface || process.env.CMUX_SURFACE_ID || null,
			selector,
			target: params.target || null,
			url: params.url || null,
			match: resolved?.match || null,
			result,
			checks,
			observation,
			skillPacks,
			downloadArtifacts,
			mechanicAssists: mergeMechanicAssists(mechanicAssists),
			resolutionStrategy: resolved?.strategy || (selector ? "selector" : null),
			frameContext,
			restoredMainFrame,
			tabTransition,
			networkTransition,
			downloadDiff,
			recovery,
		};
	} catch (error: any) {
		const errorMessage = error?.message || String(error);
		if (
			params.toleratePageJsErrors !== false &&
			/(js_error|JavaScript exception|Timed out waiting for JavaScript result)/i.test(errorMessage) &&
			["click", "dblclick", "press", "navigate", "fill", "type", "focus"].includes(action)
		) {
			const tolerantObservation = await collectObservation(
				pi,
				{ surface: params.surface, includeSnapshot: false, limit: 12, maxDepth: 3 },
				signal,
			).catch(() => null);
			return {
				action,
				surface: params.surface || process.env.CMUX_SURFACE_ID || null,
				selector,
				target: params.target || null,
				url: params.url || null,
				match: resolved?.match || null,
				result: null,
				error: errorMessage,
				warning: "Browser/page JavaScript error was tolerated after the action; inspect observation/postconditions instead of aborting the workflow.",
				checks: [],
				observation: tolerantObservation,
				skillPacks: [],
				downloadArtifacts: [],
				mechanicAssists: mergeMechanicAssists(mechanicAssists),
				resolutionStrategy: resolved?.strategy || (selector ? "selector" : null),
				frameContext,
				restoredMainFrame,
				tabTransition,
				networkTransition: null,
				downloadDiff: null,
				recovery,
			};
		}
		if (!params._mechanicRecoveryAttempted) {
			mechanicAssists = mergeMechanicAssists([
				...mechanicAssists,
				...(await collectMechanicAssistsForFailure(pi, { surface: params.surface || null, text: `${error.message || String(error)} ${params.target || params.url || params.text || ""}` }, signal, timeout).catch(() => [])),
			]);
			const autoRecovery = await attemptMechanicRecoveryForAction(
				pi,
				{
					surface: params.surface || null,
					action,
					target: params.target || null,
					errorText: error.message || String(error),
					assists: mechanicAssists,
					includeSnapshot: params.includeObservation !== false,
					downloadTimeoutMs: params.downloadTimeoutMs,
				},
				signal,
				timeout,
			).catch(() => null);
			if (autoRecovery) {
				recovery = autoRecovery;
				const retried = await runTaskAction(
					pi,
					{
						...params,
						_mechanicRecoveryAttempted: true,
						_priorMechanicAssists: mechanicAssists,
						_priorRecoveries: [...(params._priorRecoveries || []), autoRecovery],
					},
					signal,
					timeout,
				);
				retried.recovery = retried.recovery || autoRecovery;
				retried.mechanicAssists = mergeMechanicAssists([...(retried.mechanicAssists || []), ...mechanicAssists]);
				return retried;
			}
		}
		throw error;
	} finally {
		if (frameContext && !restoredMainFrame) {
			await resetBrowserFrameContext(pi, params.surface, signal, timeout).catch(() => null);
		}
	}
}

function summarizeActionSignalsForRunTask(actionPayload: any, context: { label?: string; goal?: string } = {}) {
	const label = context.label || actionPayload?.action || "action";
	const notes = [] as string[];
	const steps = [] as any[];
	const handoffFragments = [] as string[];
	const downloads = [
		...((actionPayload?.downloadDiff?.created || []).map((item: any) => item.name)),
		...((actionPayload?.downloadDiff?.updated || []).map((item: any) => item.after?.name || item.name)),
	].filter(Boolean);
	if (actionPayload?.tabTransition?.createdTabs?.length) {
		const created = actionPayload.tabTransition.createdTabs.map((tab: any) => tab.index).join(", ");
		const adopted = actionPayload.tabTransition.adoptedTab?.targetIndex;
		notes.push(`${label} opened ${actionPayload.tabTransition.createdTabs.length} new tab${actionPayload.tabTransition.createdTabs.length === 1 ? "" : "s"}${adopted !== undefined ? ` and adopted tab ${adopted}` : ""}.`);
		steps.push({ kind: "tab-transition", summary: `${label} created tab(s) ${created}${adopted !== undefined ? ` and adopted ${adopted}` : ""}`, payload: actionPayload.tabTransition });
		handoffFragments.push(`new tabs: ${created}${adopted !== undefined ? ` (adopted ${adopted})` : ""}`);
	}
	if (downloads.length) {
		notes.push(`${label} changed download artifacts: ${downloads.slice(0, 4).join(", ")}${downloads.length > 4 ? ` (+${downloads.length - 4} more)` : ""}.`);
		steps.push({ kind: "download-verify", summary: `${label} produced ${downloads.length} download artifact change${downloads.length === 1 ? "" : "s"}`, payload: actionPayload.downloadDiff });
		handoffFragments.push(`downloads: ${downloads.slice(0, 4).join(", ")}${downloads.length > 4 ? ` (+${downloads.length - 4} more)` : ""}`);
	}
	if (actionPayload?.networkTransition?.added?.length) {
		const preview = actionPayload.networkTransition.addedPreview.map((item: any) => `${item.method || "REQ"} ${truncate(item.url || stringify(item.raw), 120)}`);
		notes.push(`${label} triggered ${actionPayload.networkTransition.added.length} new network request${actionPayload.networkTransition.added.length === 1 ? "" : "s"}.`);
		steps.push({ kind: "network-verify", summary: `${label} produced ${actionPayload.networkTransition.added.length} network request change${actionPayload.networkTransition.added.length === 1 ? "" : "s"}`, payload: actionPayload.networkTransition });
		handoffFragments.push(`network: ${preview.slice(0, 3).join("; ")}${preview.length > 3 ? ` (+${preview.length - 3} more)` : ""}`);
	}
	if (actionPayload?.recovery) {
		const strategies = (actionPayload.recovery.actions || []).map((item: any) => item.strategy).filter(Boolean);
		notes.push(`${label} needed bounded recovery${strategies.length ? ` (${uniqueStrings(strategies).join(", ")})` : ""} before continuing.`);
		steps.push({ kind: "action-recovery", summary: `${label} used bounded recovery (${actionPayload.recovery.status || "completed"})`, payload: actionPayload.recovery });
		handoffFragments.push(`recovery: ${actionPayload.recovery.status || "completed"}${strategies.length ? ` via ${uniqueStrings(strategies).join(", ")}` : ""}`);
	}
	if (actionPayload?.resolutionStrategy === "shadow") {
		notes.push(`${label} resolved through open shadow DOM fallback.`);
	}
	if (actionPayload?.frameContext?.selector) {
		notes.push(`${label} resolved inside iframe ${actionPayload.frameContext.selector}.`);
	}
	return { notes, steps, handoffFragments };
}

function composeRunTaskCheckpointNote(base: string, fragments: string[] = []) {
	const clean = uniqueStrings(fragments || []);
	if (!clean.length) return base;
	return `${base}\n\nContext:\n- ${clean.join("\n- ")}`;
}

function renderRunTaskResult(payload: any) {
	const lines = [
		"# cmux browser run task",
		"",
		`- goal: ${payload.goal}`,
		`- status: ${payload.status}`,
		`- surface: ${payload.surface || "default"}`,
		payload.site ? `- site: ${payload.site}` : null,
		payload.lock?.owner ? `- lock owner: ${payload.lock.owner}` : null,
		payload.startedUrl ? `- started url: ${payload.startedUrl}` : null,
		payload.finalObservation?.url ? `- final url: ${payload.finalObservation.url}` : null,
		payload.finalObservation?.pageType ? `- final page type: ${payload.finalObservation.pageType}` : null,
		payload.checkpointKey ? `- checkpoint key: ${payload.checkpointKey}` : null,
		payload.finalCheckpointKey ? `- final checkpoint key: ${payload.finalCheckpointKey}` : null,
	].filter(Boolean);
	if (payload.plan?.plannedSteps?.length) {
		lines.push("", "## Planned steps", ...payload.plan.plannedSteps.map((step: string) => `- ${step}`));
	}
	if (payload.notes?.length) {
		lines.push("", "## Notes", ...payload.notes.map((note: string) => `- ${note}`));
	}
	if (payload.operationalSignals?.length) {
		lines.push("", "## Operational signals", ...payload.operationalSignals.map((item: string) => `- ${item}`));
	}
	if (payload.steps?.length) {
		lines.push("", "## Steps", ...payload.steps.map((step: any, index: number) => `- ${index + 1}. ${step.kind}: ${truncate(step.summary || stringify(step), 280)}`));
	}
	if (payload.recalledMemory?.length) {
		lines.push("", "## Site memory", ...payload.recalledMemory.map((entry: any) => `- ${entry.key} [${entry.kind || "note"}] ${entry.title || entry.site || "untitled"}: ${truncate(entry.content || "", 200)}`));
	}
	if (payload.suggestedSkillPacks?.length) {
		lines.push("", "## Suggested skill packs", ...payload.suggestedSkillPacks.map((entry: any) => `- ${entry.packId} [${entry.kind}]${entry.site ? ` ${entry.site}` : ""}${entry.title ? ` — ${entry.title}` : ""}`));
	}
	if (payload.extraction) {
		lines.push("", "## Extraction", renderExtractResult(payload.extraction.mode, payload.extraction.data));
	}
	if (payload.researchPages?.length) {
		lines.push("", "## Research pages", ...payload.researchPages.map((page: any) => `- ${truncate(page.title || page.url, 160)} • ${page.url} • mode=${page.mode} • score=${page.score}`));
	}
	if (payload.recovery) {
		lines.push("", "## Recovery", renderRecoveryResult(payload.recovery));
	}
	if (payload.finalObservation) {
		lines.push("", "## Final observation", buildObservationSummary(payload.finalObservation, { includeSnapshot: false }));
	}
	if (payload.handoff) {
		lines.push("", "## Handoff hint", `- restore key: ${payload.handoff.key}`);
		if (payload.handoff.note) lines.push(`- note: ${truncate(payload.handoff.note, 400)}`);
		if (payload.handoff.signals?.length) lines.push(...payload.handoff.signals.map((item: string) => `- signal: ${truncate(item, 220)}`));
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	initializeStorage();

	pi.on("before_agent_start", async () => {
		return { systemPrompt: PREAMBLE };
	});

	pi.registerTool({
		name: "cmux_browser_doctor",
		label: "cmux Browser Doctor",
		description:
			"Diagnose a cmux browser surface before risky work by checking surface reachability, lock ownership, observation health, site memory, and checkpoint continuity.",
		promptSnippet:
			"Use when a browser surface feels wrong, stale, auth-blocked, unexpectedly shared, or otherwise suspicious and you want diagnostics before mutating it further.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			owner: Type.Optional(Type.String({ description: "Optional expected lock owner / agent alias." })),
			team: Type.Optional(Type.String({ description: "Optional expected team name for shared-surface checks." })),
			site: Type.Optional(Type.String({ description: "Optional site key override for memory/checkpoint summaries." })),
			includeObservation: Type.Optional(Type.Boolean({ description: "Include a structured browser observation when reachable. Default true." })),
			includeSurfaceHealth: Type.Optional(Type.Boolean({ description: "Include cmux surface-health output when available. Default true." })),
			includeTabList: Type.Optional(Type.Boolean({ description: "Include the browser tab list when available. Default true." })),
			includeMemory: Type.Optional(Type.Boolean({ description: "Include site-memory recall summary when a site can be inferred. Default true." })),
			includeCheckpointSummary: Type.Optional(Type.Boolean({ description: "Include recent checkpoint summary for the inferred site. Default true." })),
			memoryQuery: Type.Optional(Type.String({ description: "Optional query to filter site memory recall." })),
			memoryLimit: Type.Optional(Type.Integer({ description: "How many memory entries to summarize. Default 5." })),
			checkpointLimit: Type.Optional(Type.Integer({ description: "How many matching checkpoints to summarize. Default 5." })),
			limit: Type.Optional(Type.Integer({ description: "Observation section limit when includeObservation=true. Default 12." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const report = await runBrowserDoctor(pi, p, signal, timeout);
				await writeCmuxBridgeAuxEvent(ctx, "browser_doctor_ran", {
					surface: report.surface || null,
					site: report.site || null,
					status: report.status,
					issueCodes: (report.issues || []).map((issue: any) => issue.code),
					summary: `Browser doctor ${report.status}${report.site ? ` for ${report.site}` : ""}.`,
				}).catch(() => null);
				return ok(renderDoctorResult(report), report);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_doctor" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_bootstrap",
		label: "cmux Browser Bootstrap",
		description:
			"Prepare or reuse a cmux browser surface for real work by selecting or creating a surface, optionally acquiring a lock, navigating, focusing, recalling site memory, and saving an initial checkpoint.",
		promptSnippet:
			"Use before substantial browser work so the agent starts from a known-good browser surface with the right visibility, memory, and checkpoint context.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Optional existing browser surface ref, id, or index." })),
			workspace: Type.Optional(Type.String({ description: "Workspace ref, id, or index used when selecting or creating browser surfaces." })),
			url: Type.Optional(Type.String({ description: "Optional URL to navigate to during bootstrap." })),
			site: Type.Optional(Type.String({ description: "Optional site key override for memory recall." })),
			reuseExisting: Type.Optional(Type.Boolean({ description: "Reuse an existing browser surface when possible. Default true." })),
			createIfMissing: Type.Optional(Type.Boolean({ description: "Create a browser surface when none can be reused. Default true." })),
			openInNewTab: Type.Optional(Type.Boolean({ description: "Open a new browser tab before navigation when reusing a surface." })),
			owner: Type.Optional(Type.String({ description: "Optional lock owner / agent alias." })),
			team: Type.Optional(Type.String({ description: "Optional team name for lock-aware bootstrap." })),
			acquireLock: Type.Optional(Type.Boolean({ description: "Acquire a browser lock during bootstrap. Default true when owner is set." })),
			leaseSeconds: Type.Optional(Type.Integer({ description: "Lock lease in seconds when acquireLock=true. Default 1800." })),
			checkpointKey: Type.Optional(Type.String({ description: "Optional initial checkpoint key to save after bootstrap." })),
			useMemory: Type.Optional(Type.Boolean({ description: "Recall site memory during bootstrap. Default true." })),
			memoryQuery: Type.Optional(Type.String({ description: "Optional memory query filter." })),
			memoryKind: Type.Optional(Type.String({ description: "Optional memory kind filter such as workflow, selector, interaction_skill, or domain_skill." })),
			memoryLimit: Type.Optional(Type.Integer({ description: "How many memory entries to summarize. Default 5." })),
			visibility: Type.Optional(StringEnum(["background", "visible", "notify"] as const, { description: "Whether bootstrap should keep the surface in the background, focus it visibly, or focus and notify. Default background unless focus=true." })),
			focus: Type.Optional(Type.Boolean({ description: "Shortcut for visibility=visible." })),
			flash: Type.Optional(Type.Boolean({ description: "Flash the surface/workspace when focusing it." })),
			notifyTitle: Type.Optional(Type.String({ description: "Notification title when visibility=notify." })),
			notifyBody: Type.Optional(Type.String({ description: "Notification body when visibility=notify." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "Include interactive snapshot in the initial checkpoint. Default true." })),
			limit: Type.Optional(Type.Integer({ description: "Observation limit after bootstrap. Default 12." })),
			waitForLoadState: Type.Optional(StringEnum(["interactive", "complete"] as const, { description: "Load state to wait for after navigation. Default complete." })),
			note: Type.Optional(Type.String({ description: "Optional bootstrap note used for lock/checkpoint context." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const payload = await runBrowserBootstrap(pi, p, signal, timeout);
				await writeCmuxBridgeAuxEvent(ctx, "browser_bootstrap_completed", {
					surface: payload.surface || null,
					workspace: payload.workspace || null,
					site: payload.site || null,
					action: payload.action,
					checkpointKey: payload.checkpoint?.key || null,
					lockOwner: payload.lock?.owner || null,
					summary: `Browser bootstrap ${payload.action} on ${payload.surface || "browser surface"}.`,
				}).catch(() => null);
				return ok(renderBootstrapResult(payload), payload);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_bootstrap" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_focus_and_notify",
		label: "cmux Browser Focus and Notify",
		description:
			"Explicitly bring a shared cmux browser surface to the front, optionally flash it, notify the operator, and capture a compact snapshot for verification.",
		promptSnippet:
			"Use when a browser step should be operator-visible, especially setup, verification, auth-boundary, or review moments.",
		parameters: Type.Object({
			surface: Type.String({ description: "Browser surface ref, id, or index." }),
			workspace: Type.Optional(Type.String({ description: "Optional workspace ref, id, or index." })),
			owner: Type.Optional(Type.String({ description: "Optional expected lock owner." })),
			team: Type.Optional(Type.String({ description: "Optional expected team name." })),
			requireLock: Type.Optional(Type.Boolean({ description: "Require a compatible lock before focusing the surface." })),
			flash: Type.Optional(Type.Boolean({ description: "Flash the target surface/workspace." })),
			notify: Type.Optional(Type.Boolean({ description: "Send a cmux notification after focus." })),
			notifyTitle: Type.Optional(Type.String({ description: "Notification title." })),
			notifyBody: Type.Optional(Type.String({ description: "Notification body." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				if (p.requireLock || p.owner || p.team) assertSurfaceLockOwnership({ surface: p.surface, owner: p.owner, team: p.team, allowUnlocked: false });
				const focus = await focusBrowserSurface(
					pi,
					{
						surface: p.surface,
						workspace: p.workspace || process.env.CMUX_WORKSPACE_ID || null,
						flash: p.flash === true,
						notifyTitle: p.notify ? p.notifyTitle || "CMUX browser requires attention" : null,
						notifyBody: p.notify ? p.notifyBody || `Browser surface ${p.surface} is now focused.` : null,
					},
					signal,
					timeout,
				);
				const payload = { ...focus, notified: Boolean(p.notify), flash: Boolean(p.flash) };
				await writeCmuxBridgeAuxEvent(ctx, "browser_surface_focused", {
					surface: p.surface,
					workspace: p.workspace || process.env.CMUX_WORKSPACE_ID || null,
					owner: p.owner || null,
					team: p.team || null,
					notified: Boolean(p.notify),
					summary: `Browser surface ${p.surface} was focused${p.notify ? " and notified" : ""}.`,
				}).catch(() => null);
				return ok(renderFocusResult(payload), payload);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_focus_and_notify" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_mechanic",
		label: "cmux Browser Mechanic",
		description:
			"Guide or assist with hard browser mechanics such as dialogs, uploads, downloads, iframes, and shadow DOM by surfacing matching playbooks, memory, and safe recovery help.",
		promptSnippet:
			"Use when browser work is blocked by a specific browser mechanic and you want the right playbooks plus any safe assist the agent can provide.",
		parameters: Type.Object({
			mechanic: StringEnum(["dialogs", "uploads", "downloads", "iframes", "shadow_dom"] as const, { description: "Browser mechanic to inspect or assist." }),
			action: Type.Optional(StringEnum(["guide", "inspect", "apply_safe_recovery", "prepare_target", "wait_for_download"] as const, { description: "Whether to guide, inspect, apply bounded safe recovery, prepare a target, or wait for a download when supported. Default guide." })),
			surface: Type.Optional(Type.String({ description: "Optional browser surface ref, id, or index." })),
			site: Type.Optional(Type.String({ description: "Optional site key override." })),
			limit: Type.Optional(Type.Integer({ description: "How many matching memory items or artifacts to summarize. Default 5." })),
			sinceMinutes: Type.Optional(Type.Integer({ description: "For downloads inspection, how many minutes of recent local downloads to scan. Default 30." })),
			path: Type.Optional(Type.String({ description: "Optional download path to wait for when action=wait_for_download." })),
			dialogText: Type.Optional(Type.String({ description: "Optional prompt text for dialog accept/dismiss flows." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const payload = await runBrowserMechanic(pi, p, signal, timeout);
				return ok(renderMechanicResult(payload), payload);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_mechanic", mechanic: p.mechanic, action: p.action || "guide" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_observe",
		label: "cmux Browser Observe",
		description:
			"Build a structured page model for a cmux browser surface including page type, headings, forms, actions, alerts, and an optional interactive snapshot.",
		promptSnippet:
			"Use before or after important browser actions to understand the page semantically instead of reasoning only from raw selectors.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			selector: Type.Optional(Type.String({ description: "Optional root CSS selector to observe only a sub-region." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "Include an interactive snapshot in the result. Default true." })),
			interactiveSnapshot: Type.Optional(Type.Boolean({ description: "Request interactive snapshot mode. Default true." })),
			compact: Type.Optional(Type.Boolean({ description: "Use compact snapshot mode. Default true." })),
			maxDepth: Type.Optional(Type.Integer({ description: "Snapshot max depth. Default 5." })),
			limit: Type.Optional(Type.Integer({ description: "Per-section item limit. Default 20." })),
			saveKey: Type.Optional(Type.String({ description: "Optional checkpoint-like key to save the observation JSON without browser state." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const observation = await collectObservation(
					pi,
					{
						surface: p.surface,
						selector: p.selector,
						includeSnapshot: p.includeSnapshot !== false,
						interactiveSnapshot: p.interactiveSnapshot !== false,
						compact: p.compact !== false,
						maxDepth: p.maxDepth ?? DEFAULT_OBSERVE_MAX_DEPTH,
						limit: p.limit ?? DEFAULT_LIMIT,
					},
					signal,
				);
				let savedPath: string | null = null;
				if (p.saveKey) {
					const paths = checkpointPaths(p.saveKey);
					writeJsonFile(paths.jsonPath, {
						key: paths.key,
						observedAt: new Date().toISOString(),
						observation,
						note: null,
						statePath: null,
					});
					savedPath = paths.jsonPath;
				}
				return ok(buildObservationSummary(observation, { includeSnapshot: p.includeSnapshot !== false }), {
					observation,
					savedPath,
					timeout,
				});
			} catch (error: any) {
				return failWithRecoveryHint(error.message || String(error), { tool: "cmux_browser_observe" }, { surface: p.surface });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_act",
		label: "cmux Browser Act",
		description:
			"Perform robust browser actions inside cmux with semantic target resolution, optional retries, and post-action verification.",
		promptSnippet:
			"Use for goal-oriented browser actions like clicking a button by meaning, filling a field by label, navigating, waiting, and verifying outcomes. If the action fails, prefer cmux_browser_recover instead of blind retries.",
		parameters: Type.Object({
			action: StringEnum([
				"open",
				"navigate",
				"click",
				"dblclick",
				"hover",
				"focus",
				"fill",
				"type",
				"select",
				"press",
				"check",
				"uncheck",
				"scroll_into_view",
				"wait",
				"dialog_dismiss",
				"dialog_accept",
				"download_wait",
			] as const, { description: "High-level browser action to perform." }),
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			url: Type.Optional(Type.String({ description: "URL for open or navigate actions." })),
			selector: Type.Optional(Type.String({ description: "Direct CSS selector. Prefer when you already know the exact element." })),
			target: Type.Optional(Type.String({ description: "Semantic target text such as button text, link text, field label, placeholder, or control name." })),
			targetKind: Type.Optional(StringEnum(["button", "link", "input", "checkbox", "select", "any"] as const, { description: "Element kind for semantic resolution." })),
			text: Type.Optional(Type.String({ description: "Text to fill/type or wait for." })),
			value: Type.Optional(Type.String({ description: "Selection value for select actions." })),
			key: Type.Optional(Type.String({ description: "Keyboard key for press." })),
			dialogText: Type.Optional(Type.String({ description: "Optional dialog prompt text for accept/dismiss actions." })),
			downloadPath: Type.Optional(Type.String({ description: "Optional filesystem path to wait for when action=download_wait." })),
			downloadTimeoutMs: Type.Optional(Type.Integer({ description: "Optional timeout override for download_wait or auto download waits." })),
			detectTabChanges: Type.Optional(Type.Boolean({ description: "Detect tab/popup changes around click-like actions. Default true." })),
			switchToNewTab: Type.Optional(Type.Boolean({ description: "When a click-like action creates a new tab, switch to it automatically. Default true." })),
			detectNetworkChanges: Type.Optional(Type.Boolean({ description: "Capture network-request diffs around navigation/click-like actions when the runtime supports it. Default true." })),
			autoWaitForDownload: Type.Optional(Type.Boolean({ description: "For download-like actions, wait for a browser download event when feasible. Default true." })),
			stopBeforeIrreversible: Type.Optional(Type.Boolean({ description: "Block externally visible, persistent, destructive, financial, profile/account-changing, or confirmation actions unless explicitly approved. Default true." })),
			approvalGranted: Type.Optional(Type.Boolean({ description: "Set true only after the user explicitly approves this specific risky/irreversible action." })),
			approvalNote: Type.Optional(Type.String({ description: "Short note quoting or summarizing the user's approval for a risky/irreversible action." })),
			downloadArtifactLimit: Type.Optional(Type.Integer({ description: "How many recent download artifacts to include. Default 8." })),
			downloadSinceMinutes: Type.Optional(Type.Integer({ description: "How many recent download minutes to scan for artifact diffs. Default 30." })),
			exact: Type.Optional(Type.Boolean({ description: "Require exact semantic text match when resolving a target." })),
			snapshotAfter: Type.Optional(Type.Boolean({ description: "Ask cmux browser to snapshot after the action when supported." })),
			includeObservation: Type.Optional(Type.Boolean({ description: "Attach a structured post-action observation. Default true." })),
			waitForSelector: Type.Optional(Type.String({ description: "Postcondition: selector must appear or become ready." })),
			waitForText: Type.Optional(Type.String({ description: "Postcondition: text must appear." })),
			waitForUrlContains: Type.Optional(Type.String({ description: "Postcondition: page URL must contain this substring." })),
			waitForLoadState: Type.Optional(StringEnum(["interactive", "complete"] as const, { description: "Postcondition: browser load state." })),
			expectTitleIncludes: Type.Optional(Type.String({ description: "Postcondition: title must include this text." })),
			expectValue: Type.Optional(Type.String({ description: "Postcondition for fill/select: input value must equal this text." })),
			retries: Type.Optional(Type.Integer({ description: "Retry count when semantic resolution or action execution fails. Default 1." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			const retries = Math.max(1, Math.min(4, Number(p.retries || 1)));
			try {
				const risk = classifyBrowserActionRisk(p);
				if (p.stopBeforeIrreversible !== false && risk.requiresApproval && !approvalGrantedForBrowserRisk(p)) {
					const payload = { status: "approval_required", approvalRequired: true, risk, action: p.action, target: p.target || null, text: p.text || null, url: p.url || null };
					return ok(renderBrowserApprovalRequired(risk, p), payload);
				}
				let lastError: any = null;
				for (let attempt = 1; attempt <= retries; attempt += 1) {
					try {
						const action = String(p.action);
						const payload = await runTaskAction(
							pi,
							{
								...p,
								includeObservation: p.includeObservation,
							},
							signal,
							timeout,
						);
						payload.attempt = attempt;
						return ok(renderActionResult(action, payload), payload);
					} catch (error: any) {
						lastError = error;
					}
				}
				const mechanicAssists = await collectMechanicAssistsForFailure(pi, { surface: p.surface || null, text: `${lastError?.message || String(lastError)} ${p.target || p.url || p.text || ""}` }, signal, timeout).catch(() => []);
				return failWithRecoveryHint(lastError?.message || String(lastError), { tool: "cmux_browser_act", mechanicAssists }, { surface: p.surface, action: p.action, goal: p.target || p.url || p.text || null });
			} catch (error: any) {
				return failWithRecoveryHint(error.message || String(error), { tool: "cmux_browser_act" }, { surface: p.surface, action: p.action, goal: p.target || p.url || p.text || null });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_assert",
		label: "cmux Browser Assert",
		description:
			"Verify browser postconditions inside cmux such as selector visibility, text presence, URL changes, title changes, or absence of blockers.",
		promptSnippet:
			"Use after a risky or important step to verify that the browser reached the intended state. If verification fails because the page is unstable or blocked, use cmux_browser_recover before retrying.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			selector: Type.Optional(Type.String({ description: "Wait for this selector to become available." })),
			text: Type.Optional(Type.String({ description: "Wait for this visible text to appear." })),
			urlContains: Type.Optional(Type.String({ description: "Require the page URL to contain this substring." })),
			titleIncludes: Type.Optional(Type.String({ description: "Require the document title to include this text." })),
			loadState: Type.Optional(StringEnum(["interactive", "complete"] as const, { description: "Require a target browser load state." })),
			visibleSelector: Type.Optional(Type.String({ description: "Require this selector to be visible." })),
			enabledSelector: Type.Optional(Type.String({ description: "Require this selector to be enabled." })),
			checkedSelector: Type.Optional(Type.String({ description: "Require this selector to be checked." })),
			absentSelector: Type.Optional(Type.String({ description: "Require this selector to be absent or hidden." })),
			absentText: Type.Optional(Type.String({ description: "Require this text to no longer appear in page text." })),
			includeObservation: Type.Optional(Type.Boolean({ description: "Attach a compact structured observation. Default true." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const checks = [] as any[];
				await runPostconditions(
					pi,
					{
						surface: p.surface,
						waitForSelector: p.selector,
						waitForText: p.text,
						waitForUrlContains: p.urlContains,
						waitForLoadState: p.loadState,
						expectTitleIncludes: p.titleIncludes,
					},
					signal,
					timeout,
				).then((items) => checks.push(...items));

				for (const [type, selector] of [
					["visible", p.visibleSelector],
					["enabled", p.enabledSelector],
					["checked", p.checkedSelector],
				] as any[]) {
					if (!selector) continue;
					const value = await execBrowserText(pi, p.surface, ["is", type, selector], { signal, timeout });
					const passed = /true/i.test(value);
					checks.push({ type: `${type}Selector`, expected: selector, actual: value, passed });
					if (!passed) throw new Error(`Assertion failed: selector ${selector} is not ${type}`);
				}

				if (p.absentSelector) {
					const result = await execBrowserJson(pi, p.surface, ["eval", buildAbsentSelectorScript(p.absentSelector)], { signal, timeout });
					checks.push({ type: "absentSelector", expected: p.absentSelector, actual: stringify(result), passed: !!result?.absent });
					if (!result?.absent) throw new Error(`Assertion failed: selector still present or visible: ${p.absentSelector}`);
				}
				if (p.absentText) {
					const result = await execBrowserJson(pi, p.surface, ["eval", buildAbsentTextScript(p.absentText)], { signal, timeout });
					checks.push({ type: "absentText", expected: p.absentText, actual: stringify(result), passed: !!result?.absent });
					if (!result?.absent) throw new Error(`Assertion failed: text still present: ${p.absentText}`);
				}

				const observation = p.includeObservation === false ? null : await collectObservation(
					pi,
					{ surface: p.surface, includeSnapshot: false, limit: 12, maxDepth: 3 },
					signal,
				).catch(() => null);

				const payload = { checks, observation };
				return ok(renderAssertResult(payload), payload);
			} catch (error: any) {
				return failWithRecoveryHint(error.message || String(error), { tool: "cmux_browser_assert" }, { surface: p.surface, action: "assert" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_extract",
		label: "cmux Browser Extract",
		description:
			"Extract structured data from a cmux browser surface including links, buttons, forms, tables, cards, key-value pairs, or explicit fields.",
		promptSnippet:
			"Use when browser output should become structured data rather than freeform snapshot reading. If extraction fails because the page is unstable, recover before retrying.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			mode: StringEnum(["summary", "links", "buttons", "forms", "table", "cards", "kv", "fields", "text"] as const, { description: "Extraction mode." }),
			selector: Type.Optional(Type.String({ description: "Optional root selector to scope extraction." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum items or rows to return. Default 20." })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Output field name." }),
						selector: Type.String({ description: "CSS selector to extract from." }),
						property: Type.Optional(StringEnum(["text", "html", "value", "attr"] as const, { description: "How to read the matched element." })),
						attribute: Type.Optional(Type.String({ description: "Attribute name when property=attr." })),
					}),
					{ description: "Field list for mode=fields." },
				),
			),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				const payload = await execBrowserJson(
					pi,
					p.surface,
					["eval", buildExtractScript({ mode: p.mode, selector: p.selector, limit: p.limit, fields: p.fields })],
					{ signal, timeout },
				).catch(async (error: any) => {
					return nativeExtractFallback(
						pi,
						{ surface: p.surface, mode: p.mode, selector: p.selector, limit: p.limit, fields: p.fields, evalError: error?.message || String(error) },
						signal,
						timeout,
					);
				});
				return ok(renderExtractResult(p.mode, payload?.data), { mode: p.mode, payload });
			} catch (error: any) {
				return failWithRecoveryHint(error.message || String(error), { tool: "cmux_browser_extract", mode: p.mode }, { surface: p.surface, action: "extract" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_lock",
		label: "cmux Browser Lock",
		description:
			"Coordinate browser-surface ownership for cmux teams so only one agent actively drives a shared browser surface at a time.",
		promptSnippet:
			"Use when multiple agents share a browser surface and you need explicit ownership, handoff, renewal, or release.",
		parameters: Type.Object({
			action: StringEnum(["acquire", "release", "status", "list", "handoff", "renew", "assert", "sweep"] as const, { description: "Lock action." }),
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			owner: Type.Optional(Type.String({ description: "Agent/owner alias acquiring or releasing the lock." })),
			newOwner: Type.Optional(Type.String({ description: "New owner for handoff." })),
			team: Type.Optional(Type.String({ description: "Optional team name." })),
			note: Type.Optional(Type.String({ description: "Optional lock note or handoff message." })),
			leaseSeconds: Type.Optional(Type.Integer({ description: "Lease duration in seconds. Default 1800." })),
			allowUnlocked: Type.Optional(Type.Boolean({ description: "For assert, allow the surface to be unlocked instead of erroring." })),
			force: Type.Optional(Type.Boolean({ description: "Force the action even if another owner holds the lock." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as any;
			try {
				const surface = p.surface || process.env.CMUX_SURFACE_ID || null;
				if (!surface && !["list", "sweep"].includes(p.action)) throw new Error("surface is required for this lock action");
				if (p.action === "acquire") {
					const record = acquireSurfaceLock({ surface, owner: p.owner, team: p.team, note: p.note, leaseSeconds: p.leaseSeconds, force: p.force });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_acquired", { surface, owner: record.owner, team: record.team || null, leaseSeconds: record.leaseSeconds || null, summary: `Browser lock acquired on ${surface} by ${record.owner || "unknown"}.` }).catch(() => null);
					return ok(renderLockResult("acquire", record), record);
				}
				if (p.action === "release") {
					const record = releaseSurfaceLock({ surface, owner: p.owner, force: p.force });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_released", { surface, owner: p.owner || record?.owner || null, summary: `Browser lock released on ${surface}.` }).catch(() => null);
					return ok(renderLockResult("release", { ...(record || {}), surface }), { released: record || null, surface });
				}
				if (p.action === "status") {
					const record = activeLockForSurface(surface);
					return ok(renderLockResult("status", record || { surface, note: "unlocked" }), { surface, lock: record });
				}
				if (p.action === "list") {
					const registry = readLocksRegistry();
					const locks = Object.values(registry.locks || {}).filter((lock: any) => !isLockExpired(lock));
					return ok(renderLockResult("list", { locks }), { locks });
				}
				if (p.action === "assert") {
					const record = assertSurfaceLockOwnership({ surface, owner: p.owner, team: p.team, allowUnlocked: p.allowUnlocked === true });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_asserted", { surface, owner: p.owner || record?.owner || null, team: p.team || record?.team || null, unlocked: !record, summary: record ? `Browser lock asserted on ${surface}.` : `Browser surface ${surface} confirmed unlocked.` }).catch(() => null);
					return ok(renderLockResult("assert", record || { surface, note: "unlocked" }), { surface, lock: record, unlocked: !record });
				}
				if (p.action === "sweep") {
					const result = sweepExpiredLocks();
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_swept", { removedCount: result.removedCount, summary: `Browser lock sweep removed ${result.removedCount} expired lock(s).` }).catch(() => null);
					return ok(renderLockResult("sweep", { locks: result.removed, removedCount: result.removedCount }), result);
				}
				if (p.action === "renew") {
					const record = renewSurfaceLock({ surface, owner: p.owner, team: p.team, note: p.note, leaseSeconds: p.leaseSeconds, force: p.force === true });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_renewed", { surface, owner: record.owner, team: record.team || null, leaseSeconds: record.leaseSeconds || null, summary: `Browser lock renewed on ${surface} by ${record.owner || "unknown"}.` }).catch(() => null);
					return ok(renderLockResult("renew", record), record);
				}
				if (p.action === "handoff") {
					if (!p.newOwner) throw new Error("newOwner is required for handoff");
					const handoff = handoffSurfaceLock({ surface, owner: p.owner, newOwner: p.newOwner, team: p.team, note: p.note, leaseSeconds: p.leaseSeconds, force: p.force === true });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_handoff", { surface, owner: handoff.previous?.owner || null, newOwner: handoff.record.owner, team: handoff.record.team || null, summary: `Browser lock handed off on ${surface} to ${handoff.record.owner || "unknown"}.` }).catch(() => null);
					return ok(renderLockResult("handoff", handoff.record), handoff.record);
				}
				throw new Error(`Unsupported lock action: ${p.action}`);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_lock", action: p.action });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_memory",
		label: "cmux Browser Memory",
		description:
			"Store and recall site-specific browser knowledge such as workflow notes, selectors, checkpoints, and repeated task guidance.",
		promptSnippet:
			"Use when repeated browsing on the same site would benefit from durable memory and handoff notes.",
		parameters: Type.Object({
			action: StringEnum(["remember", "recall", "list", "forget"] as const, { description: "Memory action." }),
			surface: Type.Optional(Type.String({ description: "Optional browser surface ref used to infer the current URL/site." })),
			site: Type.Optional(Type.String({ description: "Logical site key or hostname, e.g. app.example.com." })),
			url: Type.Optional(Type.String({ description: "URL used to infer the site when site is omitted." })),
			query: Type.Optional(Type.String({ description: "Optional recall query string." })),
			key: Type.Optional(Type.String({ description: "Memory entry key for updates or deletion." })),
			kind: Type.Optional(StringEnum(["note", "workflow", "selector", "checkpoint", "handoff", "interaction_skill", "domain_skill"] as const, { description: "Memory kind or filter kind." })),
			title: Type.Optional(Type.String({ description: "Short title." })),
			content: Type.Optional(Type.String({ description: "Main memory content." })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional memory tags." })),
			attribution: Type.Optional(Type.String({ description: "Optional agent alias or attribution label." })),
			confidence: Type.Optional(Type.Number({ description: "Optional confidence score, typically 0-1." })),
			lastVerifiedAt: Type.Optional(Type.String({ description: "Optional verification timestamp for the memory entry." })),
			deprecated: Type.Optional(Type.Boolean({ description: "Mark the memory entry as deprecated." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum entries to return. Default 10." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			try {
				let resolvedUrl = p.url || null;
				if (!resolvedUrl && p.surface) {
					resolvedUrl = await execBrowserText(pi, p.surface, ["url"], { signal, timeout: DEFAULT_TIMEOUT }).catch(() => null);
				}
				const site = inferSiteKey(p.site, resolvedUrl);
				if (p.action === "remember") {
					if (!site) throw new Error("site or url is required to remember browser memory");
					const entry = upsertMemoryEntry({ key: p.key, site, kind: p.kind || "note", title: p.title, content: p.content, url: resolvedUrl || p.url || null, tags: p.tags || [], attribution: p.attribution, confidence: p.confidence, lastVerifiedAt: p.lastVerifiedAt, deprecated: p.deprecated });
					return ok(renderMemoryResult("remember", { site, entry }), { site, entry });
				}
				if (p.action === "recall") {
					const entries = recallMemoryEntries({ site, query: p.query, kind: p.kind || null, limit: p.limit || 10 });
					return ok(renderMemoryResult("recall", { site, entries }), { site, entries });
				}
				if (p.action === "list") {
					const registry = readMemoryRegistry();
					const sites = uniqueStrings((registry.entries || []).map((entry: any) => entry.site));
					return ok(renderMemoryResult("list", { entries: sites.map((siteKey: string) => ({ key: siteKey, kind: "site", title: siteKey, content: `${recallMemoryEntries({ site: siteKey, kind: p.kind || null, limit: 999 }).length} entries` })) }), { sites });
				}
				if (p.action === "forget") {
					const result = deleteMemoryEntries({ key: p.key, site });
					return ok(renderMemoryResult("forget", { site, removed: result.removed }), { site, ...result });
				}
				throw new Error(`Unsupported memory action: ${p.action}`);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_memory", action: p.action });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_learn",
		label: "cmux Browser Learn",
		description:
			"Promote successful browser knowledge into durable memory with attribution, confidence, and optional skill-pack publication.",
		promptSnippet:
			"Use after learning something durable about a site or workflow so later agents do not have to rediscover it.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Optional browser surface ref used to infer the current URL/site." })),
			site: Type.Optional(Type.String({ description: "Logical site key or hostname override." })),
			url: Type.Optional(Type.String({ description: "Optional URL used to infer the site." })),
			key: Type.Optional(Type.String({ description: "Optional memory key override." })),
			kind: Type.Optional(StringEnum(["workflow", "selector", "checkpoint", "handoff", "interaction_skill", "domain_skill"] as const, { description: "Kind of durable browser knowledge being learned." })),
			title: Type.String({ description: "Short title for the learned knowledge." }),
			content: Type.String({ description: "Main learned content." }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags." })),
			attribution: Type.Optional(Type.String({ description: "Agent alias or attribution label." })),
			confidence: Type.Optional(Type.Number({ description: "Confidence score, typically 0-1." })),
			lastVerifiedAt: Type.Optional(Type.String({ description: "Optional verification timestamp." })),
			promoteToSkillPack: Type.Optional(Type.Boolean({ description: "Also publish the learned content to an on-disk interaction/domain skill pack when kind is interaction_skill or domain_skill." })),
			packId: Type.Optional(Type.String({ description: "Optional pack id when promoteToSkillPack=true." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			try {
				let resolvedUrl = p.url || null;
				if (!resolvedUrl && p.surface) resolvedUrl = await execBrowserText(pi, p.surface, ["url"], { signal, timeout: p.timeoutMs ?? DEFAULT_TIMEOUT }).catch(() => null);
				const site = inferSiteKey(p.site, resolvedUrl);
				if (!site) throw new Error("site or url is required to learn durable browser knowledge");
				const entry = upsertMemoryEntry({ key: p.key, site, kind: p.kind || "workflow", title: p.title, content: p.content, url: resolvedUrl || p.url || null, tags: p.tags || [], attribution: p.attribution || process.env.PI_CMUX_AGENT_ALIAS || null, confidence: p.confidence ?? 0.8, lastVerifiedAt: p.lastVerifiedAt || nowIso() });
				let skillPack = null;
				if (p.promoteToSkillPack && ["interaction_skill", "domain_skill"].includes(entry.kind)) {
					skillPack = writeSkillPackEntry({ kind: entry.kind === "domain_skill" ? "domain" : "interaction", packId: p.packId || entry.title || entry.key, site, title: entry.title, tags: entry.tags || [], confidence: entry.confidence ?? null, createdBy: entry.attribution || null, sourceMemoryKey: entry.key, content: entry.content || "", createdAt: entry.createdAt || nowIso() });
				}
				await writeCmuxBridgeAuxEvent(ctx, "browser_workflow_learned", { surface: p.surface || process.env.CMUX_SURFACE_ID || null, site, key: entry.key, kind: entry.kind, skillPackId: skillPack?.packId || null, summary: `Browser knowledge learned for ${site}: ${entry.title || entry.key}` }).catch(() => null);
				return ok(renderMemoryResult("learn", { site, entry, entries: skillPack ? [{ key: skillPack.packId, kind: `${skillPack.kind}_skill_pack`, title: skillPack.title || skillPack.packId, content: skillPack.path }] : undefined }), { site, entry, skillPack });
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_learn" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_skill_pack",
		label: "cmux Browser Skill Pack",
		description:
			"List, inspect, publish, and delete reusable interaction or domain browser skill packs stored in the CMUX browser intelligence runtime directory.",
		promptSnippet:
			"Use when browser knowledge should become a reusable interaction or site-specific pack instead of a one-off memory note.",
		parameters: Type.Object({
			action: StringEnum(["list", "get", "publish", "delete", "suggest"] as const, { description: "Skill-pack action." }),
			kind: Type.Optional(StringEnum(["interaction", "domain"] as const, { description: "Interaction or domain skill-pack family." })),
			packId: Type.Optional(Type.String({ description: "Skill-pack identifier." })),
			site: Type.Optional(Type.String({ description: "Optional site key / hostname for domain packs." })),
			surface: Type.Optional(Type.String({ description: "Optional browser surface ref used to infer site for suggest/publish flows." })),
			title: Type.Optional(Type.String({ description: "Skill-pack title for publish." })),
			content: Type.Optional(Type.String({ description: "Skill-pack markdown body for publish." })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional skill-pack tags." })),
			confidence: Type.Optional(Type.Number({ description: "Optional confidence score." })),
			memoryKey: Type.Optional(Type.String({ description: "Optional existing memory key to publish from." })),
			query: Type.Optional(Type.String({ description: "Optional query for suggest/list flows." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum skill packs to return. Default 10." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			try {
				let resolvedUrl = null;
				if (p.surface) resolvedUrl = await execBrowserText(pi, p.surface, ["url"], { signal, timeout: DEFAULT_TIMEOUT }).catch(() => null);
				const site = inferSiteKey(p.site, resolvedUrl || null);
				if (p.action === "list") {
					const entries = listSkillPackEntries({ kind: p.kind, site }).slice(0, Math.max(1, Math.min(100, Number(p.limit || 10))));
					return ok(renderSkillPackResult("list", { entries }), { entries });
				}
				if (p.action === "get") {
					if (!p.packId) throw new Error("packId is required for get");
					if (p.kind === "domain" && !site) throw new Error("site or surface is required to get a domain skill pack");
					const entries = listSkillPackEntries({ kind: p.kind, site }).filter((entry: any) => entry.packId === safeKey(p.packId));
					const entry = entries[0];
					if (!entry) throw new Error(`Skill pack not found: ${p.packId}`);
					return ok(renderSkillPackResult("get", { entry, content: entry.content }), { entry });
				}
				if (p.action === "publish") {
					let sourceMemory = null;
					if (p.memoryKey) {
						sourceMemory = recallMemoryEntries({ site, query: p.memoryKey, limit: 50 }).find((entry: any) => entry.key === p.memoryKey) || null;
					}
					const kind = p.kind || (sourceMemory?.kind === "domain_skill" ? "domain" : sourceMemory?.kind === "interaction_skill" ? "interaction" : null);
					if (!kind) throw new Error("kind is required for publish unless memoryKey points to an interaction_skill or domain_skill memory entry");
					if (kind === "domain" && !site) throw new Error("site or surface is required to publish a domain skill pack");
					const content = p.content || sourceMemory?.content;
					if (!content) throw new Error("content is required for publish");
					const entry = writeSkillPackEntry({ kind, packId: p.packId || p.title || sourceMemory?.title || sourceMemory?.key || "skill-pack", site, title: p.title || sourceMemory?.title || null, tags: p.tags || sourceMemory?.tags || [], confidence: p.confidence ?? sourceMemory?.confidence ?? null, createdBy: process.env.PI_CMUX_AGENT_ALIAS || sourceMemory?.attribution || null, sourceMemoryKey: sourceMemory?.key || p.memoryKey || null, content, createdAt: nowIso() });
					return ok(renderSkillPackResult("publish", { entry }), { entry });
				}
				if (p.action === "delete") {
					if (!p.packId || !p.kind) throw new Error("packId and kind are required for delete");
					if (p.kind === "domain" && !site) throw new Error("site or surface is required to delete a domain skill pack");
					const result = deleteSkillPackEntry({ kind: p.kind, packId: p.packId, site });
					return ok(renderSkillPackResult("delete", { entry: { packId: result.packId, kind: p.kind, site, path: result.path } }), result);
				}
				if (p.action === "suggest") {
					const domainEntries = site ? listSkillPackEntries({ kind: "domain", site }) : [];
					const interactionEntries = listSkillPackEntries({ kind: "interaction" });
					const query = String(p.query || "").trim().toLowerCase();
					const entries = [...domainEntries, ...interactionEntries].filter((entry: any) => !query || [entry.packId, entry.title, entry.site, ...(entry.tags || [])].join(" ").toLowerCase().includes(query)).slice(0, Math.max(1, Math.min(20, Number(p.limit || 10))));
					return ok(renderSkillPackResult("suggest", { entries }), { site, entries });
				}
				throw new Error(`Unsupported skill-pack action: ${p.action}`);
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_skill_pack", action: p.action });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_recover",
		label: "cmux Browser Recover",
		description:
			"Classify browser failures inside cmux and attempt recovery strategies such as dismissing modals, waiting, reloading, backing up, or checkpointing for handoff.",
		promptSnippet:
			"Use immediately after a failed cmux browser step when the page looks blocked, stale, interrupted by a modal, or otherwise needs stabilization before continuing.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			strategy: Type.Optional(StringEnum(["auto", "dismiss_modal", "wait", "reload", "back", "checkpoint"] as const, { description: "Recovery strategy. Default auto." })),
			errorText: Type.Optional(Type.String({ description: "Optional failure/error text to classify." })),
			goal: Type.Optional(Type.String({ description: "Optional task goal for context and checkpoint naming." })),
			checkpointKey: Type.Optional(Type.String({ description: "Optional checkpoint key for checkpoint-based recovery." })),
			note: Type.Optional(Type.String({ description: "Optional note for recovery checkpoints or handoffs." })),
			owner: Type.Optional(Type.String({ description: "Optional owner alias used for lock-aware recovery." })),
			team: Type.Optional(Type.String({ description: "Optional team name used for lock-aware recovery." })),
			requireLock: Type.Optional(Type.Boolean({ description: "Require an existing compatible browser lock before recovery starts." })),
			acquireLock: Type.Optional(Type.Boolean({ description: "Acquire a browser lock before recovery starts." })),
			releaseLockOnComplete: Type.Optional(Type.Boolean({ description: "Release any recovery-acquired lock when recovery completes cleanly. Default true." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "Include snapshots in checkpoint-based recovery. Default true." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			const surface = p.surface || process.env.CMUX_SURFACE_ID || null;
			let acquiredLock: any = null;
			try {
				if (surface && p.acquireLock) {
					acquiredLock = acquireSurfaceLock({ surface, owner: p.owner, team: p.team, note: p.note || `recover: ${p.goal || p.strategy || "auto"}`, leaseSeconds: 1800, force: false });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_acquired", { surface, owner: acquiredLock.owner, team: acquiredLock.team || null, leaseSeconds: acquiredLock.leaseSeconds || null, summary: `Browser lock acquired on ${surface} by ${acquiredLock.owner || "unknown"} for recovery.` }).catch(() => null);
				} else if (surface && (p.requireLock || p.owner || p.team)) {
					const lock = assertSurfaceLockOwnership({ surface, owner: p.owner, team: p.team, allowUnlocked: false });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_asserted", { surface, owner: lock?.owner || p.owner || null, team: lock?.team || p.team || null, unlocked: false, summary: `Browser lock asserted on ${surface} for recovery.` }).catch(() => null);
				}
				await writeCmuxBridgeAuxEvent(ctx, "browser_recovery_started", { surface, strategy: p.strategy || "auto", goal: p.goal || null, errorText: p.errorText || null, owner: p.owner || acquiredLock?.owner || null, summary: `Browser recovery started (${p.strategy || "auto"}).` }).catch(() => null);
				const payload = await performRecovery(
					pi,
					{
						surface,
						strategy: p.strategy || "auto",
						errorText: p.errorText,
						goal: p.goal,
						checkpointKey: p.checkpointKey,
						note: p.note,
						includeSnapshot: p.includeSnapshot !== false,
					},
					signal,
					timeout,
				);
				const resultPayload = { ...payload, lock: acquiredLock || (surface ? activeLockForSurface(surface) : null) };
				await writeCmuxBridgeAuxEvent(ctx, "browser_recovery_completed", { surface, strategy: payload.strategy || p.strategy || "auto", status: payload.status || null, checkpointKey: payload.checkpoint?.key || null, owner: resultPayload.lock?.owner || p.owner || null, summary: `Browser recovery ${payload.status || "completed"}.` }).catch(() => null);
				if (acquiredLock && p.releaseLockOnComplete !== false) {
					releaseSurfaceLock({ surface, owner: acquiredLock.owner, force: false });
					await writeCmuxBridgeAuxEvent(ctx, "browser_lock_released", { surface, owner: acquiredLock.owner, summary: `Browser recovery released lock on ${surface}.` }).catch(() => null);
					resultPayload.releasedRecoveryLock = true;
				}
				return ok(renderRecoveryResult(resultPayload), resultPayload);
			} catch (error: any) {
				await writeCmuxBridgeAuxEvent(ctx, "browser_recovery_failed", { surface, strategy: p.strategy || "auto", error: error.message || String(error), owner: p.owner || acquiredLock?.owner || null, summary: `Browser recovery failed: ${error.message || String(error)}` }).catch(() => null);
				return fail(error.message || String(error), { tool: "cmux_browser_recover", surface, owner: p.owner || acquiredLock?.owner || null });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_run_task",
		label: "cmux Browser Run Task",
		description:
			"Run a high-level browser workflow inside cmux using an observe/act/assert/extract/checkpoint loop for common navigation and extraction tasks.",
		promptSnippet:
			"Use when you want one tool to drive a browser task end-to-end with checkpoints, semantic actions, verification, and structured extraction.",
		parameters: Type.Object({
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			site: Type.Optional(Type.String({ description: "Optional site key/hostname for memory recall and persistence." })),
			goal: Type.String({ description: "High-level goal such as extract pricing, search for a company, open a page section, or navigate to a target step." }),
			url: Type.Optional(Type.String({ description: "Optional starting URL to open or navigate to before planning." })),
			resumeFromCheckpointKey: Type.Optional(Type.String({ description: "Optional checkpoint key to restore before continuing the run." })),
			planOnly: Type.Optional(Type.Boolean({ description: "If true, inspect the page and return the planned workflow without mutating it." })),
			maxSteps: Type.Optional(Type.Integer({ description: "Maximum workflow steps to attempt. Default 6." })),
			researchDepth: Type.Optional(Type.Integer({ description: "For bounded long-range research/selective scraping, maximum relevant pages to visit including the starting page. Default 1; hard-capped at 8." })),
			followLinks: Type.Optional(Type.Boolean({ description: "If true, extract and rank links from the current page, then visit the most relevant pages for the goal." })),
			selectiveScrapeKeywords: Type.Optional(Type.Array(Type.String(), { description: "Keywords used to rank links and focus selective scraping/research." })),
			checkpointKey: Type.Optional(Type.String({ description: "Optional checkpoint key to save before risky work or when the run stops early." })),
			finalCheckpointKey: Type.Optional(Type.String({ description: "Optional checkpoint key to save at the end of the run." })),
			stopOnAuthBoundary: Type.Optional(Type.Boolean({ description: "Stop when the page appears to be an auth/login boundary. Default true." })),
			stopBeforeDestructive: Type.Optional(Type.Boolean({ description: "Stop before destructive or commit-like actions. Default true." })),
			stopBeforeIrreversible: Type.Optional(Type.Boolean({ description: "Block externally visible, persistent, destructive, financial, profile/account-changing, or confirmation actions unless explicitly approved. Default true." })),
			approvalGranted: Type.Optional(Type.Boolean({ description: "Set true only after the user explicitly approves this specific risky/irreversible action." })),
			approvalNote: Type.Optional(Type.String({ description: "Short note quoting or summarizing the user's approval for a risky/irreversible action." })),
			extractMode: Type.Optional(StringEnum(["summary", "links", "buttons", "forms", "table", "cards", "kv", "fields", "text"] as const, { description: "Optional final extraction mode. If omitted, inferred from the goal." })),
			extractSelector: Type.Optional(Type.String({ description: "Optional selector to scope extraction." })),
			fields: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Output field name." }),
						selector: Type.String({ description: "CSS selector to extract from." }),
						property: Type.Optional(StringEnum(["text", "html", "value", "attr"] as const, { description: "How to read the matched element." })),
						attribute: Type.Optional(Type.String({ description: "Attribute name when property=attr." })),
					}),
				),
			),
			owner: Type.Optional(Type.String({ description: "Optional owner/agent alias for lock coordination." })),
			team: Type.Optional(Type.String({ description: "Optional team name for lock coordination." })),
			acquireLock: Type.Optional(Type.Boolean({ description: "Acquire a browser-surface lock for this run. Default true when owner is set." })),
			releaseLockOnComplete: Type.Optional(Type.Boolean({ description: "Release the lock automatically when the run completes cleanly. Default true." })),
			useMemory: Type.Optional(Type.Boolean({ description: "Recall site memory for the current URL/site when available. Default true." })),
			memoryQuery: Type.Optional(Type.String({ description: "Optional query to filter site memory recall." })),
			memoryNoteOnComplete: Type.Optional(Type.String({ description: "Optional site-memory note to save when the run completes." })),
			successUrlContains: Type.Optional(Type.String({ description: "Optional success condition: final URL should contain this substring." })),
			successText: Type.Optional(Type.String({ description: "Optional success condition: final page text should contain this string." })),
			successTitleIncludes: Type.Optional(Type.String({ description: "Optional success condition: final title should include this string." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "Include interactive snapshots in checkpoint observations. Default true." })),
			detectTabChanges: Type.Optional(Type.Boolean({ description: "Propagate tab/popup detection into click-like actions during the run. Default true." })),
			switchToNewTab: Type.Optional(Type.Boolean({ description: "When click-like actions open a new tab during the run, adopt it automatically. Default true." })),
			detectNetworkChanges: Type.Optional(Type.Boolean({ description: "Propagate network-request diffing into navigation/click-like actions during the run. Default true when supported." })),
			autoWaitForDownload: Type.Optional(Type.Boolean({ description: "When click-like actions appear download-sensitive, wait for browser downloads automatically. Default true." })),
			allowRecovery: Type.Optional(Type.Boolean({ description: "Attempt browser recovery when a step fails. Default true." })),
			maxRecoveries: Type.Optional(Type.Integer({ description: "Maximum recovery attempts during the run. Default 2." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			const maxSteps = Math.max(1, Math.min(30, Number(p.maxSteps || 8)));
			const planOnly = Boolean(p.planOnly);
			const stopOnAuthBoundary = p.stopOnAuthBoundary !== false;
			const stopBeforeDestructive = p.stopBeforeDestructive !== false;
			const allowRecovery = p.allowRecovery !== false;
			const maxRecoveries = Math.max(0, Math.min(5, Number(p.maxRecoveries || 2)));
			const shouldAcquireLock = p.acquireLock === true || (!!p.owner && p.acquireLock !== false);
			const shouldReleaseLockOnComplete = p.releaseLockOnComplete !== false;
			const useMemory = p.useMemory !== false;
			let recoveryCount = 0;
			let lockRecord: any = null;
			let recalledMemory: any[] = [];
			let suggestedSkillPacks: any[] = [];
			let resolvedSite: string | null = null;
			let plan: any = null;
			const notes: string[] = [];
			const operationalSignals: string[] = [];
			const handoffFragments: string[] = [];
			const steps: any[] = [];
			try {
				let stepCount = 0;
				if (p.resumeFromCheckpointKey) {
					const paths = checkpointPaths(p.resumeFromCheckpointKey);
					if (!existsSync(paths.statePath)) throw new Error(`Checkpoint state not found for key: ${safeKey(p.resumeFromCheckpointKey)}`);
					await execBrowserText(pi, p.surface, ["state", "load", paths.statePath], { signal, timeout });
					steps.push({ kind: "restore", summary: `restored checkpoint ${safeKey(p.resumeFromCheckpointKey)}`, payload: { key: safeKey(p.resumeFromCheckpointKey), statePath: paths.statePath } });
					stepCount += 1;
				}
				if (p.url) {
					const navigate = await runTaskAction(
						pi,
						{ surface: p.surface, action: "navigate", url: p.url, waitForLoadState: "complete", includeObservation: true, detectTabChanges: p.detectTabChanges, switchToNewTab: p.switchToNewTab, detectNetworkChanges: p.detectNetworkChanges, autoWaitForDownload: p.autoWaitForDownload },
						signal,
						timeout,
					);
					steps.push({ kind: "navigate", summary: `navigated to ${p.url}`, payload: navigate });
					const navSignals = summarizeActionSignalsForRunTask(navigate, { label: "navigate", goal: p.goal });
					notes.push(...navSignals.notes);
					operationalSignals.push(...navSignals.notes);
					steps.push(...navSignals.steps);
					handoffFragments.push(...navSignals.handoffFragments);
					stepCount += 1;
				}

				let observation = await collectObservation(
					pi,
					{ surface: p.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: DEFAULT_OBSERVE_MAX_DEPTH },
					signal,
				);
				steps.push({ kind: "observe", summary: `observed ${observation.pageType} page ${observation.title || observation.url || ""}`.trim(), payload: observation });
				stepCount += 1;
				resolvedSite = inferSiteKey(p.site, observation.url || p.url || null);
				const intent = inferIntentFromGoal(p.goal);
				plan = buildRunTaskPlan(p.goal, observation, p, intent);
				if (shouldAcquireLock && p.surface) {
					lockRecord = acquireSurfaceLock({ surface: p.surface, owner: p.owner, team: p.team, note: `run_task: ${p.goal}`, leaseSeconds: 1800, force: false });
					steps.push({ kind: "lock", summary: `acquired browser lock for ${lockRecord.owner}`, payload: lockRecord });
				}
				if (useMemory && resolvedSite) {
					recalledMemory = recallMemoryEntries({ site: resolvedSite, query: p.memoryQuery || p.goal, limit: 5 });
					suggestedSkillPacks = [
						...listSkillPackEntries({ kind: "domain", site: resolvedSite }).slice(0, 3),
						...((/(dialog|modal|consent|cookie)/i.test(p.goal || "") ? listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => entry.packId === "dialogs") : [])),
						...((/(upload|file)/i.test(p.goal || "") ? listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => entry.packId === "file-uploads") : [])),
						...((/(download|export)/i.test(p.goal || "") ? listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => entry.packId === "downloads") : [])),
						...((/(iframe|frame)/i.test(p.goal || "") ? listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => entry.packId === "iframes") : [])),
						...((/(shadow)/i.test(p.goal || "") ? listSkillPackEntries({ kind: "interaction" }).filter((entry: any) => entry.packId === "shadow-dom") : [])),
					];
					suggestedSkillPacks = uniqueBy(suggestedSkillPacks, (entry: any) => `${entry.kind}:${entry.site || ""}:${entry.packId}`);
					if (recalledMemory.length) {
						notes.push(`Recalled ${recalledMemory.length} site memory entr${recalledMemory.length === 1 ? "y" : "ies"} for ${resolvedSite}.`);
						steps.push({ kind: "memory-recall", summary: `recalled site memory for ${resolvedSite}`, payload: recalledMemory });
					}
					if (suggestedSkillPacks.length) {
						notes.push(`Matched ${suggestedSkillPacks.length} reusable browser skill pack${suggestedSkillPacks.length === 1 ? "" : "s"} for this workflow.`);
						steps.push({ kind: "skill-pack-suggest", summary: `matched browser skill packs for ${resolvedSite}`, payload: suggestedSkillPacks });
					}
				}

				if (planOnly) {
					const payload = {
						goal: p.goal,
						status: "planned",
						surface: p.surface || process.env.CMUX_SURFACE_ID || null,
						startedUrl: p.url || null,
						checkpointKey: p.checkpointKey || null,
						finalCheckpointKey: p.finalCheckpointKey || null,
						lock: lockRecord,
						site: resolvedSite,
						recalledMemory,
						suggestedSkillPacks,
						notes: ["planOnly=true, so no browser mutations were executed after observation."],
						operationalSignals: uniqueStrings(operationalSignals),
						steps,
						plan,
						finalObservation: observation,
					};
					return ok(renderRunTaskResult(payload), payload);
				}

				if (p.checkpointKey) {
					const checkpoint = await saveBrowserCheckpoint(
						pi,
						{
							key: p.checkpointKey,
							surface: p.surface,
							note: `Start checkpoint for goal: ${p.goal}`,
							includeSnapshot: p.includeSnapshot !== false,
							timeout,
						},
						signal,
					);
					steps.push({ kind: "checkpoint", summary: `saved checkpoint ${checkpoint.key}`, payload: checkpoint });
				}

				if (stopOnAuthBoundary && (observation.flags || []).includes("auth-boundary")) {
					notes.push("Stopped at auth boundary so a human or credential-aware agent can continue safely.");
					const finalCheckpoint = p.finalCheckpointKey || p.checkpointKey || null;
					let handoff = null;
					if (finalCheckpoint) {
						handoff = await saveBrowserCheckpoint(
							pi,
							{
								key: finalCheckpoint,
								surface: p.surface,
								note: composeRunTaskCheckpointNote(`Auth boundary reached for goal: ${p.goal}`, handoffFragments),
								includeSnapshot: p.includeSnapshot !== false,
								timeout,
							},
							signal,
						);
					}
					const payload = {
						goal: p.goal,
						status: "paused-auth-boundary",
						surface: p.surface || process.env.CMUX_SURFACE_ID || null,
						startedUrl: p.url || null,
						checkpointKey: p.checkpointKey || null,
						finalCheckpointKey: handoff?.key || p.finalCheckpointKey || null,
						lock: lockRecord,
						site: resolvedSite,
						recalledMemory,
						suggestedSkillPacks,
						notes: uniqueStrings(notes),
						operationalSignals: uniqueStrings(operationalSignals),
						steps,
						plan,
						finalObservation: observation,
						handoff: handoff ? { key: handoff.key, note: handoff.note, signals: uniqueStrings(handoffFragments) } : null,
					};
					return ok(renderRunTaskResult(payload), payload);
				}

				const modalResult = stepCount < maxSteps ? await maybeDismissModal(pi, p.surface, observation, signal, timeout) : null;
				if (modalResult) {
					steps.push({ kind: "dismiss-modal", summary: `dismissed modal using ${modalResult.candidate}`, payload: modalResult });
					observation = modalResult.observation || observation;
					stepCount += 1;
				}

				if (intent.searchQuery && stepCount < maxSteps) {
					try {
						const searchAction = await runTaskAction(
							pi,
							{
								surface: p.surface,
								action: "fill",
								target: "search",
								targetKind: "input",
								text: intent.searchQuery,
								expectValue: intent.searchQuery,
								includeObservation: true,
								detectTabChanges: p.detectTabChanges,
								switchToNewTab: p.switchToNewTab,
								detectNetworkChanges: p.detectNetworkChanges,
								autoWaitForDownload: p.autoWaitForDownload,
							},
							signal,
							timeout,
						);
						steps.push({ kind: "search-fill", summary: `filled search with ${intent.searchQuery}`, payload: searchAction });
						const searchSignals = summarizeActionSignalsForRunTask(searchAction, { label: `search fill (${intent.searchQuery})`, goal: p.goal });
						notes.push(...searchSignals.notes);
						operationalSignals.push(...searchSignals.notes);
						steps.push(...searchSignals.steps);
						handoffFragments.push(...searchSignals.handoffFragments);
						stepCount += 1;
						if (stepCount < maxSteps) {
							const pressAction = await runTaskAction(
								pi,
								{ surface: p.surface, action: "press", key: "Enter", waitForLoadState: "complete", includeObservation: true, detectTabChanges: p.detectTabChanges, switchToNewTab: p.switchToNewTab, detectNetworkChanges: p.detectNetworkChanges, autoWaitForDownload: p.autoWaitForDownload },
								signal,
								timeout,
							);
							steps.push({ kind: "search-submit", summary: `submitted search for ${intent.searchQuery}`, payload: pressAction });
							const submitSignals = summarizeActionSignalsForRunTask(pressAction, { label: `search submit (${intent.searchQuery})`, goal: p.goal });
							notes.push(...submitSignals.notes);
							operationalSignals.push(...submitSignals.notes);
							steps.push(...submitSignals.steps);
							handoffFragments.push(...submitSignals.handoffFragments);
							observation = pressAction.observation || observation;
							stepCount += 1;
						}
					} catch (error: any) {
						notes.push(`Search workflow hit an issue: ${error.message || String(error)}`);
						if (allowRecovery && recoveryCount < maxRecoveries) {
							const recovery = await performRecovery(
								pi,
								{
									surface: p.surface,
									strategy: "auto",
									errorText: error.message || String(error),
									goal: p.goal,
									checkpointKey: p.checkpointKey ? `${p.checkpointKey}-recovery-${recoveryCount + 1}` : undefined,
									includeSnapshot: p.includeSnapshot !== false,
								},
								signal,
								timeout,
							);
							steps.push({ kind: "recover", summary: `recovery after search workflow failure (${recovery.status})`, payload: recovery });
							observation = recovery.afterObservation || observation;
							recoveryCount += 1;
						}
					}
				}

				if (intent.target && intent.clickVerb && stepCount < maxSteps) {
					if (stopBeforeDestructive && isDestructiveText(intent.target)) {
						notes.push(`Stopped before a potentially destructive action target: ${intent.target}`);
					} else {
						let actionPayload: any = null;
						const attempts = ["button", "link", "any"];
						let lastError: any = null;
						for (const kind of attempts) {
							try {
								actionPayload = await runTaskAction(
									pi,
									{ surface: p.surface, action: "click", target: intent.target, targetKind: kind, waitForLoadState: "complete", includeObservation: true, detectTabChanges: p.detectTabChanges, switchToNewTab: p.switchToNewTab, detectNetworkChanges: p.detectNetworkChanges, autoWaitForDownload: p.autoWaitForDownload, stopBeforeIrreversible: p.stopBeforeIrreversible, approvalGranted: p.approvalGranted, approvalNote: p.approvalNote },
									signal,
									timeout,
								);
								break;
							} catch (error: any) {
								lastError = error;
							}
						}
						if (actionPayload) {
							steps.push({ kind: "click-target", summary: `clicked semantic target ${intent.target}`, payload: actionPayload });
							const clickSignals = summarizeActionSignalsForRunTask(actionPayload, { label: `click ${intent.target}`, goal: p.goal });
							notes.push(...clickSignals.notes);
							operationalSignals.push(...clickSignals.notes);
							steps.push(...clickSignals.steps);
							handoffFragments.push(...clickSignals.handoffFragments);
							observation = actionPayload.observation || observation;
							stepCount += 1;
						} else if (lastError) {
							if (lastError.approvalRequired) {
								notes.push(`Stopped before approval-required action target: ${intent.target}`);
								steps.push({ kind: "approval-required", summary: `approval required before clicking ${intent.target}`, payload: { risk: lastError.risk || null, target: intent.target } });
							} else {
								notes.push(`Could not click target ${intent.target}: ${lastError.message || String(lastError)}`);
							}
							if (!lastError.approvalRequired && allowRecovery && recoveryCount < maxRecoveries) {
								const recovery = await performRecovery(
									pi,
									{
										surface: p.surface,
										strategy: "auto",
										errorText: lastError.message || String(lastError),
										goal: p.goal,
										checkpointKey: p.checkpointKey ? `${p.checkpointKey}-recovery-${recoveryCount + 1}` : undefined,
										includeSnapshot: p.includeSnapshot !== false,
									},
									signal,
									timeout,
								);
								steps.push({ kind: "recover", summary: `recovery after click failure (${recovery.status})`, payload: recovery });
								observation = recovery.afterObservation || observation;
								recoveryCount += 1;
							}
						}
					}
				}

				if ((!intent.searchQuery && !intent.target) || stepCount < maxSteps) {
					observation = await collectObservation(
						pi,
						{ surface: p.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 },
						signal,
					);
				}

				let extraction = null;
				if (p.extractMode || intent.wantsExtraction) {
					const mode = p.extractMode || inferExtractModeFromGoal(p.goal, observation);
					const payload = await execBrowserJson(
						pi,
						p.surface,
						["eval", buildExtractScript({ mode, selector: p.extractSelector, limit: DEFAULT_LIMIT, fields: p.fields })],
						{ signal, timeout },
					).catch((error: any) => nativeExtractFallback(pi, { surface: p.surface, mode, selector: p.extractSelector, limit: DEFAULT_LIMIT, fields: p.fields, evalError: error?.message || String(error) }, signal, timeout));
					extraction = { mode, data: payload?.data, payload };
					steps.push({ kind: "extract", summary: `extracted ${mode} data`, payload: extraction });
				}

				const researchDepth = Math.max(1, Math.min(8, Number(p.researchDepth || (p.followLinks ? 3 : 1))));
				const wantsResearch = researchDepth > 1 || p.followLinks || /\b(research|scrape across|crawl|compare|scan|collect from pages|long.?range)\b/i.test(p.goal || "");
				const researchPages: any[] = [];
				if (wantsResearch && researchDepth > 1 && stepCount < maxSteps) {
					const keywordSet = normalizeResearchKeywords(p.goal, p.selectiveScrapeKeywords || []);
					const linksPayload = await execBrowserJson(
						pi,
						p.surface,
						["eval", buildExtractScript({ mode: "links", selector: p.extractSelector, limit: Math.max(DEFAULT_LIMIT, 40) })],
						{ signal, timeout },
					).catch((error: any) => nativeExtractFallback(pi, { surface: p.surface, mode: "links", selector: p.extractSelector, limit: Math.max(DEFAULT_LIMIT, 40), evalError: error?.message || String(error) }, signal, timeout).catch(() => null));
					const candidates = selectResearchLinks(linksPayload?.data || [], { goal: p.goal, keywords: keywordSet, currentUrl: observation?.url || p.url || null, limit: researchDepth - 1 });
					if (candidates.length) steps.push({ kind: "research-link-rank", summary: `ranked ${candidates.length} selective research link(s)`, payload: { keywords: keywordSet, candidates } });
					for (const candidate of candidates) {
						if (stepCount >= maxSteps) break;
						try {
							const nav = await runTaskAction(
								pi,
								{ surface: p.surface, action: "navigate", url: candidate.href, waitForLoadState: "complete", includeObservation: true, detectTabChanges: p.detectTabChanges, switchToNewTab: p.switchToNewTab, detectNetworkChanges: p.detectNetworkChanges, autoWaitForDownload: p.autoWaitForDownload },
								signal,
								timeout,
							);
							const pageObservation = nav.observation || await collectObservation(pi, { surface: p.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 }, signal);
							const mode = p.extractMode || inferExtractModeFromGoal(p.goal, pageObservation);
							const pagePayload = await execBrowserJson(pi, p.surface, ["eval", buildExtractScript({ mode, selector: p.extractSelector, limit: DEFAULT_LIMIT, fields: p.fields })], { signal, timeout })
								.catch((error: any) => nativeExtractFallback(pi, { surface: p.surface, mode, selector: p.extractSelector, limit: DEFAULT_LIMIT, fields: p.fields, evalError: error?.message || String(error) }, signal, timeout).catch(() => null));
							const page = { url: pageObservation?.url || candidate.href, title: pageObservation?.title || candidate.text || candidate.href, mode, score: candidate.score, data: pagePayload?.data || null };
							researchPages.push(page);
							steps.push({ kind: "research-page", summary: `researched ${truncate(page.title || page.url, 120)}`, payload: page });
							observation = pageObservation || observation;
							stepCount += 1;
						} catch (error: any) {
							notes.push(`Research link skipped (${truncate(candidate.href, 120)}): ${error.message || String(error)}`);
							if (allowRecovery && recoveryCount < maxRecoveries) {
								const recovery = await performRecovery(pi, { surface: p.surface, strategy: "auto", errorText: error.message || String(error), goal: p.goal, includeSnapshot: p.includeSnapshot !== false }, signal, timeout).catch(() => null);
								if (recovery) {
									steps.push({ kind: "recover", summary: `recovery after research navigation failure (${recovery.status})`, payload: recovery });
									observation = recovery.afterObservation || observation;
									recoveryCount += 1;
								}
							}
						}
					}
				}

				const successChecks = [] as any[];
				if (p.successUrlContains || p.successText || p.successTitleIncludes) {
					successChecks.push(
						...(await runPostconditions(
							pi,
							{
								surface: p.surface,
								waitForUrlContains: p.successUrlContains,
								waitForText: p.successText,
								expectTitleIncludes: p.successTitleIncludes,
							},
							signal,
							timeout,
						)),
					);
					steps.push({ kind: "assert", summary: `verified success criteria`, payload: successChecks });
				}

				let finalCheckpoint = null;
				if (p.finalCheckpointKey) {
					finalCheckpoint = await saveBrowserCheckpoint(
						pi,
						{
							key: p.finalCheckpointKey,
							surface: p.surface,
							note: composeRunTaskCheckpointNote(`Final checkpoint for goal: ${p.goal}`, handoffFragments),
							includeSnapshot: p.includeSnapshot !== false,
							timeout,
						},
						signal,
					);
					steps.push({ kind: "checkpoint-final", summary: `saved final checkpoint ${finalCheckpoint.key}`, payload: finalCheckpoint });
				}

				if (resolvedSite && p.memoryNoteOnComplete) {
					const memoryEntry = upsertMemoryEntry({
						site: resolvedSite,
						kind: "workflow",
						title: p.goal,
						content: p.memoryNoteOnComplete,
						url: observation?.url || p.url || null,
						tags: ["run-task", p.team || ""],
					});
					steps.push({ kind: "memory-save", summary: `saved site memory ${memoryEntry.key}`, payload: memoryEntry });
				}
				if (shouldAcquireLock && shouldReleaseLockOnComplete && p.surface && !notes.some((note) => /Stopped before/.test(note))) {
					const released = releaseSurfaceLock({ surface: p.surface, owner: p.owner || lockRecord?.owner, force: false });
					steps.push({ kind: "lock-release", summary: `released browser lock for ${p.surface}`, payload: released });
				}
				const payload = {
					goal: p.goal,
					status: notes.some((note) => /Stopped before/.test(note)) ? "paused-safe-guard" : "completed",
					surface: p.surface || process.env.CMUX_SURFACE_ID || null,
					startedUrl: p.url || null,
					checkpointKey: p.checkpointKey || null,
					finalCheckpointKey: finalCheckpoint?.key || p.finalCheckpointKey || null,
					lock: lockRecord,
					site: resolvedSite,
					recalledMemory,
					suggestedSkillPacks,
					notes: uniqueStrings(notes),
					operationalSignals: uniqueStrings(operationalSignals),
					steps,
					plan,
					extraction,
					researchPages,
					successChecks,
					finalObservation: observation,
					handoff: finalCheckpoint ? { key: finalCheckpoint.key, note: finalCheckpoint.note, signals: uniqueStrings(handoffFragments) } : null,
				};
				return ok(renderRunTaskResult(payload), payload);
			} catch (error: any) {
				if (allowRecovery && recoveryCount < maxRecoveries) {
					const recovery = await performRecovery(
						pi,
						{
							surface: p.surface,
							strategy: "auto",
							errorText: error.message || String(error),
							goal: p.goal,
							checkpointKey: p.finalCheckpointKey || p.checkpointKey,
							includeSnapshot: p.includeSnapshot !== false,
						},
						signal,
						timeout,
					).catch(() => null);
					if (recovery) {
						const payload = {
							goal: p.goal,
							status: "recovered-paused",
							surface: p.surface || process.env.CMUX_SURFACE_ID || null,
							startedUrl: p.url || null,
							checkpointKey: p.checkpointKey || null,
							finalCheckpointKey: recovery.checkpoint?.key || p.finalCheckpointKey || null,
							lock: lockRecord,
							site: resolvedSite,
							recalledMemory,
							suggestedSkillPacks,
							notes: uniqueStrings([...notes, `Primary run_task flow hit an error: ${error.message || String(error)}`, "Recovery was attempted. Review the resulting page state before continuing."]),
							operationalSignals: uniqueStrings(operationalSignals),
							steps: [...steps, { kind: "recover", summary: `automatic recovery executed (${recovery.status})`, payload: recovery }],
							plan,
							finalObservation: recovery.afterObservation || recovery.beforeObservation || null,
							recovery,
							handoff: recovery.checkpoint ? { key: recovery.checkpoint.key, note: recovery.checkpoint.note, signals: uniqueStrings(handoffFragments) } : null,
						};
						return ok(renderRunTaskResult(payload), payload);
					}
				}
				return fail(error.message || String(error), { tool: "cmux_browser_run_task" });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_session",
		label: "cmux Browser Session",
		description:
			"Checkpoint, restore, diff, hand off, list, collection-summary, and delete cmux browser state so one agent or a team of agents can continue work reliably.",
		promptSnippet:
			"Use for persistent browser workflows, risk checkpoints, and multi-agent handoffs inside cmux.",
		parameters: Type.Object({
			action: StringEnum(["checkpoint", "restore", "diff", "handoff", "list", "collections", "rename", "move", "delete"] as const, { description: "Session continuity action." }),
			key: Type.Optional(Type.String({ description: "Logical checkpoint key, for example customer-signup-step-2." })),
			newKey: Type.Optional(Type.String({ description: "For rename, the new checkpoint key." })),
			toCollection: Type.Optional(Type.String({ description: "For move, destination collection/folder." })),
			surface: Type.Optional(Type.String({ description: "Browser surface ref, id, or index." })),
			note: Type.Optional(Type.String({ description: "Optional note, summary, blocker, or next-step hint." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "Include interactive snapshot when capturing checkpoint observation. Default true." })),
			maxDepth: Type.Optional(Type.Integer({ description: "Snapshot max depth when checkpointing. Default 5." })),
			limit: Type.Optional(Type.Integer({ description: "For list, maximum checkpoints to show. Default 20." })),
			query: Type.Optional(Type.String({ description: "For list, freeform search over key, note, title, URL, flags, actions, tags, and collection." })),
			pageType: Type.Optional(Type.String({ description: "For list, filter by page type such as auth, form, listing, or table." })),
			urlContains: Type.Optional(Type.String({ description: "For list, require the checkpoint URL to include this substring." })),
			tag: Type.Optional(Type.String({ description: "For list, require a checkpoint tag match." })),
			collection: Type.Optional(Type.String({ description: "For checkpoint/handoff/list/restore/delete, optional collection or folder name." })),
			bookmarkedOnly: Type.Optional(Type.Boolean({ description: "For list, show only bookmarked checkpoints." })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "For checkpoint/handoff, optional tags to store with the checkpoint." })),
			bookmarked: Type.Optional(Type.Boolean({ description: "For checkpoint/handoff, mark the checkpoint as bookmarked." })),
			timeoutMs: Type.Optional(Type.Integer({ description: "Command timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as any;
			const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT;
			try {
				if (p.action === "list") {
					const entries = listCheckpointEntries({
						limit: p.limit || 20,
						query: p.query,
						pageType: p.pageType,
						urlContains: p.urlContains,
						tag: p.tag,
						collection: p.collection,
						bookmarkedOnly: p.bookmarkedOnly,
					});
					const totalBytes = entries.reduce((sum: number, entry: any) => sum + Number(entry.bytes || 0), 0);
					return ok([
						"# cmux browser checkpoints",
						"",
						`- count: ${entries.length}`,
						`- totalBytes: ${formatBytes(totalBytes)}`,
						p.query ? `- query: ${p.query}` : null,
						p.pageType ? `- pageType: ${p.pageType}` : null,
						p.urlContains ? `- urlContains: ${p.urlContains}` : null,
						p.tag ? `- tag: ${p.tag}` : null,
						p.collection ? `- collection: ${p.collection}` : null,
						p.bookmarkedOnly ? `- bookmarkedOnly: yes` : null,
						...entries.flatMap((entry: any) => [
							"",
							`## ${entry.key}`,
							entry.collection ? `- collection: ${entry.collection}` : null,
							`- observedAt: ${entry.observedAt || "—"}`,
							`- pageType: ${entry.pageType || "—"}`,
							`- title: ${entry.title || "—"}`,
							`- url: ${entry.url || "—"}`,
							`- size: ${formatBytes(entry.bytes)} (metadata ${formatBytes(entry.checkpointSize)}, state ${formatBytes(entry.stateSize)})`,
							`- statePresent: ${entry.hasState ? "yes" : "no"}`,
							entry.legacy ? `- migrated: legacy schema repaired on read` : null,
							entry.flags?.length ? `- flags: ${entry.flags.join(", ")}` : null,
							entry.primaryActions?.length ? `- actions: ${entry.primaryActions.slice(0, 4).join("; ")}` : null,
							entry.tags?.length ? `- tags: ${entry.tags.join(", ")}` : null,
							entry.bookmarked ? `- bookmarked: yes` : null,
							entry.note ? `- note: ${truncate(entry.note, 240)}` : null,
						].filter(Boolean)),
					].filter(Boolean).join("\n"), { entries, totalBytes });
				}

				if (p.action === "collections") {
					const entries = listCheckpointEntries({ limit: 500 });
					const groups = new Map<string, { count: number; bookmarked: number; latestObservedAt: string | null; tags: Set<string>; totalBytes: number }>();
					for (const entry of entries) {
						const name = String(entry.collection || "default");
						const current = groups.get(name) || { count: 0, bookmarked: 0, latestObservedAt: null, tags: new Set<string>(), totalBytes: 0 };
						current.count += 1;
						current.bookmarked += entry.bookmarked ? 1 : 0;
						current.totalBytes += Number(entry.bytes || 0);
						if (!current.latestObservedAt || String(entry.observedAt || "") > String(current.latestObservedAt || "")) current.latestObservedAt = entry.observedAt || null;
						for (const tag of entry.tags || []) current.tags.add(String(tag));
						groups.set(name, current);
					}
					const rows = Array.from(groups.entries()).sort((a, b) => String(b[1].latestObservedAt || "").localeCompare(String(a[1].latestObservedAt || "")));
					return ok([
						"# cmux browser checkpoint collections",
						"",
						`- collections: ${rows.length}`,
						`- totalBytes: ${formatBytes(entries.reduce((sum: number, entry: any) => sum + Number(entry.bytes || 0), 0))}`,
						...rows.flatMap(([name, info]) => [
							"",
							`## ${name}`,
							`- count: ${info.count}`,
							`- bookmarked: ${info.bookmarked}`,
							`- totalBytes: ${formatBytes(info.totalBytes)}`,
							`- latestObservedAt: ${info.latestObservedAt || "—"}`,
							info.tags.size ? `- tags: ${Array.from(info.tags).sort().join(", ")}` : null,
						].filter(Boolean)),
					].join("\n"), { collections: rows.map(([name, info]) => ({ name, count: info.count, bookmarked: info.bookmarked, latestObservedAt: info.latestObservedAt, totalBytes: info.totalBytes, tags: Array.from(info.tags).sort() })) });
				}

				if (!p.key) throw new Error("key is required for this action");
				const resolved = resolveCheckpointRecord(p.key, p.collection);
				const paths = resolved.paths;
				switch (p.action) {
					case "checkpoint": {
						const checkpointCollection = p.collection ? safeCollection(p.collection) : null;
						const targetPaths = checkpointPaths(p.key, checkpointCollection || undefined);
						const observation = await collectObservation(
							pi,
							{
								surface: p.surface,
								includeSnapshot: p.includeSnapshot !== false,
								interactiveSnapshot: true,
								compact: true,
								maxDepth: p.maxDepth ?? DEFAULT_OBSERVE_MAX_DEPTH,
								limit: DEFAULT_LIMIT,
							},
							signal,
						);
						await execBrowserText(pi, p.surface, ["state", "save", targetPaths.statePath], { signal, timeout });
						const payload = {
							schemaVersion: 2,
							key: targetPaths.key,
							collection: targetPaths.collection || null,
							statePath: targetPaths.statePath,
							checkpointPath: targetPaths.jsonPath,
							note: p.note || null,
							tags: uniqueStrings(p.tags || []),
							bookmarked: Boolean(p.bookmarked),
							observedAt: new Date().toISOString(),
							observation,
							integrity: {
								observationFingerprint: observationFingerprint(observation),
								statePresent: existsSync(targetPaths.statePath),
								stateSize: checkpointFileSize(targetPaths.statePath),
							},
						};
						writeJsonFile(targetPaths.jsonPath, payload);
						const checkpointBytes = checkpointFileSize(targetPaths.jsonPath);
						const stateBytes = checkpointFileSize(targetPaths.statePath);
						const checkpointPolicy = readCheckpointPolicy();
						if (checkpointPolicy.autoPruneEnabled) pruneCheckpointStorage({ maxAgeHours: checkpointPolicy.maxAgeHours, maxEntries: checkpointPolicy.maxEntries, maxTotalBytes: checkpointPolicy.maxTotalBytes, dryRun: false });
						await writeCmuxBridgeAuxEvent(ctx, "browser_checkpoint_saved", { surface: p.surface || process.env.CMUX_SURFACE_ID || null, key: targetPaths.key, collection: targetPaths.collection || null, bookmarked: Boolean(payload.bookmarked), tags: payload.tags || [], summary: `Browser checkpoint saved: ${targetPaths.key}` }).catch(() => null);
						return ok(
							[
								"# cmux browser checkpoint saved",
								"",
								`- key: ${targetPaths.key}`,
								targetPaths.collection ? `- collection: ${targetPaths.collection}` : null,
								`- checkpoint: ${targetPaths.jsonPath}`,
								`- browser state: ${targetPaths.statePath}`,
								`- size: ${formatBytes(checkpointBytes + stateBytes)} (metadata ${formatBytes(checkpointBytes)}, state ${formatBytes(stateBytes)})`,
								p.note ? `- note: ${truncate(p.note, 240)}` : null,
								payload.tags?.length ? `- tags: ${payload.tags.join(", ")}` : null,
								payload.bookmarked ? `- bookmarked: yes` : null,
								"",
								buildObservationSummary(observation, { includeSnapshot: p.includeSnapshot !== false }),
							].filter(Boolean).join("\n"),
							payload,
						);
					}
					case "restore": {
						const checkpoint = resolved.checkpoint || readJsonFile(paths.jsonPath);
						let restoreMode = restoreModeForCheckpoint(checkpoint, { stateExists: existsSync(paths.statePath) });
						if (restoreMode === "state") {
							try {
								await execBrowserText(pi, p.surface, ["state", "load", paths.statePath], { signal, timeout });
							} catch (error: any) {
								if (checkpoint?.observation?.url) {
									restoreMode = "url-fallback";
									await execBrowserText(pi, p.surface, ["navigate", checkpoint.observation.url], { signal, timeout });
								} else {
									throw error;
								}
							}
						} else if (restoreMode === "url-fallback") {
							await execBrowserText(pi, p.surface, ["navigate", checkpoint.observation.url], { signal, timeout });
						} else {
							throw new Error(`Checkpoint state file not found and no URL fallback is available: ${paths.statePath}`);
						}
						await writeCmuxBridgeAuxEvent(ctx, "browser_checkpoint_restored", { surface: p.surface || process.env.CMUX_SURFACE_ID || null, key: paths.key, collection: paths.collection || null, restoreMode, summary: `Browser checkpoint restored: ${paths.key}` }).catch(() => null);
						return ok(
							[
								"# cmux browser checkpoint restored",
								"",
								`- key: ${paths.key}`,
								paths.collection ? `- collection: ${paths.collection}` : null,
								`- restore mode: ${restoreMode}`,
								`- browser state: ${paths.statePath}`,
							checkpoint?.migratedFromVersion ? `- migrated from schema: ${checkpoint.migratedFromVersion}` : null,
								checkpoint?.integrity?.observationFingerprint ? `- observation fingerprint: ${checkpoint.integrity.observationFingerprint}` : null,
								checkpoint?.observation?.title ? `- title: ${checkpoint.observation.title}` : null,
								checkpoint?.observation?.url ? `- url: ${checkpoint.observation.url}` : null,
								checkpoint?.note ? `- note: ${truncate(checkpoint.note, 240)}` : null,
							].filter(Boolean).join("\n"),
							{ key: paths.key, collection: paths.collection || null, checkpoint, statePath: paths.statePath, restoreMode },
						);
					}
					case "diff": {
						const checkpoint = resolved.checkpoint || readJsonFile(paths.jsonPath);
						if (!checkpoint) throw new Error(`Checkpoint metadata not found: ${paths.jsonPath}`);
						const current = await collectObservation(
							pi,
							{ surface: p.surface, includeSnapshot: false, limit: DEFAULT_LIMIT, maxDepth: 3 },
							signal,
						);
						const diff = buildDiff(checkpoint, current);
						return ok(diff, { key: paths.key, collection: paths.collection || null, checkpoint, current });
					}
					case "handoff": {
						const checkpoint = resolved.checkpoint || readJsonFile(paths.jsonPath);
						if (!checkpoint) throw new Error(`Checkpoint metadata not found: ${paths.jsonPath}`);
						if (p.note) checkpoint.note = p.note;
						if (Array.isArray(p.tags)) checkpoint.tags = uniqueStrings(p.tags);
						if (typeof p.bookmarked === "boolean") checkpoint.bookmarked = p.bookmarked;
						if (p.collection) checkpoint.collection = safeCollection(p.collection);
						if (p.note || Array.isArray(p.tags) || typeof p.bookmarked === "boolean" || p.collection) {
							checkpoint.handoffAt = new Date().toISOString();
							writeJsonFile(paths.jsonPath, checkpoint);
						}
						return ok(
							[
								"# cmux browser handoff",
								"",
								`- key: ${paths.key}`,
								checkpoint?.collection ? `- collection: ${checkpoint.collection}` : null,
								`- restore with: cmux_browser_session { action: "restore", key: "${paths.key}"${checkpoint?.collection ? `, collection: "${checkpoint.collection}"` : ""} }`,
								`- state path: ${checkpoint.statePath || paths.statePath}`,
								checkpoint?.observation?.pageType ? `- page type: ${checkpoint.observation.pageType}` : null,
								checkpoint?.observation?.title ? `- title: ${checkpoint.observation.title}` : null,
								checkpoint?.observation?.url ? `- url: ${checkpoint.observation.url}` : null,
								checkpoint?.note ? `- note: ${truncate(checkpoint.note, 400)}` : "- note: no note saved",
								checkpoint?.tags?.length ? `- tags: ${checkpoint.tags.join(", ")}` : null,
								checkpoint?.bookmarked ? `- bookmarked: yes` : null,
								"",
								"## Recommended next move",
								checkpoint?.observation?.primaryActions?.length
									? `- ${checkpoint.observation.primaryActions.join("; ")}`
									: "- Observe the page and verify the current step before taking action.",
							].filter(Boolean).join("\n"),
							{ key: paths.key, collection: checkpoint.collection || null, checkpoint },
						);
					}
					case "rename": {
						if (!p.newKey) throw new Error("newKey is required for rename");
						const target = checkpointPaths(p.newKey, paths.collection || undefined);
						const checkpoint = moveCheckpointRecord(resolved, target);
						await writeCmuxBridgeAuxEvent(ctx, "browser_checkpoint_renamed", { key: paths.key, newKey: target.key, collection: target.collection || null, summary: `Browser checkpoint renamed from ${paths.key} to ${target.key}.` }).catch(() => null);
						return ok([
							"# cmux browser checkpoint renamed",
							"",
							`- from: ${paths.key}`,
							`- to: ${target.key}`,
							target.collection ? `- collection: ${target.collection}` : null,
						].filter(Boolean).join("\n"), { fromKey: paths.key, toKey: target.key, collection: target.collection || null, checkpoint });
					}
					case "move": {
						const targetCollection = p.toCollection || p.collection;
						if (!targetCollection) throw new Error("toCollection is required for move");
						const target = checkpointPaths(paths.key, targetCollection);
						const checkpoint = moveCheckpointRecord(resolved, target);
						await writeCmuxBridgeAuxEvent(ctx, "browser_checkpoint_moved", { key: target.key, fromCollection: paths.collection || null, toCollection: target.collection || null, summary: `Browser checkpoint moved to ${target.collection || "default"}.` }).catch(() => null);
						return ok([
							"# cmux browser checkpoint moved",
							"",
							`- key: ${target.key}`,
							`- from collection: ${paths.collection || "default"}`,
							`- to collection: ${target.collection || "default"}`,
						].filter(Boolean).join("\n"), { key: target.key, fromCollection: paths.collection || null, toCollection: target.collection || null, checkpoint });
					}
					case "delete": {
						const checkpoint = resolved.checkpoint || readJsonFile(paths.jsonPath);
						if (existsSync(paths.jsonPath)) rmSync(paths.jsonPath, { force: true });
						if (existsSync(paths.statePath)) rmSync(paths.statePath, { force: true });
						await writeCmuxBridgeAuxEvent(ctx, "browser_checkpoint_deleted", { key: paths.key, collection: paths.collection || null, summary: `Browser checkpoint deleted: ${paths.key}` }).catch(() => null);
						return ok([
							"# cmux browser checkpoint deleted",
							"",
							`- key: ${paths.key}`,
							paths.collection ? `- collection: ${paths.collection}` : null,
							checkpoint?.observation?.title ? `- title: ${checkpoint.observation.title}` : null,
							checkpoint?.observation?.url ? `- url: ${checkpoint.observation.url}` : null,
						].filter(Boolean).join("\n"), { key: paths.key, collection: paths.collection || null, deleted: true, checkpoint });
					}
					default:
						throw new Error(`Unsupported session action: ${p.action}`);
				}
			} catch (error: any) {
				return fail(error.message || String(error), { tool: "cmux_browser_session", action: p.action });
			}
		},
	});

	pi.registerTool({
		name: "cmux_browser_checkpoint_policy",
		label: "cmux Browser Checkpoint Policy",
		description: "Get, set, or prune checkpoint retention policy for CMUX browser checkpoint storage.",
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "get, set, or prune. Default get." })),
			autoPruneEnabled: Type.Optional(Type.Boolean({ description: "Enable or disable automatic pruning." })),
			maxAgeHours: Type.Optional(Type.Integer({ description: "Maximum checkpoint age in hours." })),
			maxEntries: Type.Optional(Type.Integer({ description: "Maximum retained checkpoint entries." })),
			maxTotalBytes: Type.Optional(Type.Integer({ description: "Maximum retained checkpoint/state bytes." })),
			dryRun: Type.Optional(Type.Boolean({ description: "For prune, preview changes without deleting files. Default true." })),
		}),
		async execute(_toolCallId, params) {
			const p = params as any;
			const action = String(p.action || "get").toLowerCase();
			if (action === "set") {
				const policy = writeCheckpointPolicy({
					autoPruneEnabled: p.autoPruneEnabled,
					maxAgeHours: p.maxAgeHours,
					maxEntries: p.maxEntries,
					maxTotalBytes: p.maxTotalBytes,
				});
				return ok([
					"# cmux browser checkpoint policy",
					"",
					`- autoPruneEnabled: ${policy.autoPruneEnabled ? "yes" : "no"}`,
					`- maxAgeHours: ${policy.maxAgeHours}`,
					`- maxEntries: ${policy.maxEntries}`,
					`- maxTotalBytes: ${formatBytes(policy.maxTotalBytes)}`,
				].join("\n"), { policy });
			}
			if (action === "prune") {
				const policy = readCheckpointPolicy();
				const result = pruneCheckpointStorage({
					maxAgeHours: p.maxAgeHours || policy.maxAgeHours,
					maxEntries: p.maxEntries || policy.maxEntries,
					maxTotalBytes: p.maxTotalBytes || policy.maxTotalBytes,
					dryRun: p.dryRun !== false,
				});
				return ok([
					"# cmux browser checkpoint prune",
					"",
					`- dryRun: ${p.dryRun !== false ? "yes" : "no"}`,
					`- removed: ${result.removedCount}`,
					`- retained: ${result.retainedCount}`,
					`- totalBytesBefore: ${formatBytes(result.totalBytesBefore)}`,
					`- totalBytesAfter: ${formatBytes(result.totalBytesAfter)}`,
					...result.removed.slice(0, 20).map((entry: any) => `- ${entry.key}${entry.collection ? ` [${entry.collection}]` : ""}: ${entry.reason} (${formatBytes(entry.bytes)})`),
				].join("\n"), { result });
			}
			const policy = readCheckpointPolicy();
			return ok([
				"# cmux browser checkpoint policy",
				"",
				`- autoPruneEnabled: ${policy.autoPruneEnabled ? "yes" : "no"}`,
				`- maxAgeHours: ${policy.maxAgeHours}`,
				`- maxEntries: ${policy.maxEntries}`,
				`- maxTotalBytes: ${formatBytes(policy.maxTotalBytes)}`,
			].join("\n"), { policy });
		},
	});

	pi.registerCommand("cmux-browser-intel-doctor", {
		description: "Check whether the CMUX Browser Intelligence extension can see cmux and its storage directories",
		handler: async (_args, ctx) => {
			initializeStorage();
			const binary = resolveCmuxBinary();
			if (!binary) {
				ctx.ui.notify("cmux CLI not found for CMUX Browser Intelligence", "error");
				return;
			}
			ctx.ui.notify(`CMUX Browser Intelligence ready. cmux=${binary} storage=${BASE_DIR}`, "success");
		},
	});
}
