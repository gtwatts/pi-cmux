// @ts-nocheck
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

export function parseEnvFile(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) return {};

	const raw = readFileSync(filePath, "utf-8");
	const env: Record<string, string> = {};

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const idx = trimmed.indexOf("=");
		if (idx === -1) continue;

		const key = trimmed.slice(0, idx).trim();
		let value = trimmed.slice(idx + 1).trim();

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		env[key] = value;
	}

	return env;
}

export function detectBinary(name: string): string | null {
	const result = spawnSync("bash", ["-lc", `command -v ${name}`], {
		encoding: "utf-8",
	});
	if (result.status !== 0) return null;
	return result.stdout.trim() || null;
}

export function maskSecret(
	value: string | null,
	prefix = 3,
	suffix = 3,
	shortMask = "****",
): string {
	if (!value) return "missing";
	if (value.length <= prefix + suffix) return shortMask;
	return `${value.slice(0, prefix)}***${value.slice(-suffix)}`;
}
