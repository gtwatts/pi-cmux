import { existsSync } from "node:fs";

function normalizeText(value: any) {
	const text = String(value || "").trim();
	return text || null;
}

export function normalizeCheckpointRecord(raw: any, options: { key: string; collection?: string | null; checkpointPath: string; statePath: string; stateSize?: number | null } ) {
	const stateExists = existsSync(options.statePath);
	const stateSize = Number(options.stateSize || 0) || 0;
	const observation = raw?.observation || {
		url: normalizeText(raw?.url),
		title: normalizeText(raw?.title),
		pageType: normalizeText(raw?.pageType),
		headings: Array.isArray(raw?.headings) ? raw.headings : [],
		flags: Array.isArray(raw?.flags) ? raw.flags : [],
	};
	const schemaVersion = Number(raw?.schemaVersion || raw?.version || 1) || 1;
	const normalized = {
		schemaVersion: 2,
		key: normalizeText(raw?.key) || options.key,
		collection: normalizeText(raw?.collection) || normalizeText(options.collection) || null,
		statePath: normalizeText(raw?.statePath) || options.statePath,
		checkpointPath: normalizeText(raw?.checkpointPath) || options.checkpointPath,
		note: normalizeText(raw?.note),
		tags: Array.isArray(raw?.tags) ? [...new Set(raw.tags.map((item: any) => String(item).trim()).filter(Boolean))] : [],
		bookmarked: Boolean(raw?.bookmarked),
		observedAt: normalizeText(raw?.observedAt) || normalizeText(raw?.createdAt) || null,
		migratedFromVersion: schemaVersion < 2 ? schemaVersion : null,
		observation,
		integrity: {
			observationFingerprint: normalizeText(raw?.integrity?.observationFingerprint) || null,
			statePresent: raw?.integrity?.statePresent ?? stateExists,
			stateSize: raw?.integrity?.stateSize ?? stateSize,
		},
	};
	const changed = JSON.stringify(normalized) !== JSON.stringify(raw || {});
	return { checkpoint: normalized, changed, legacy: schemaVersion < 2 };
}

export function restoreModeForCheckpoint(checkpoint: any, options: { stateExists: boolean }) {
	if (options.stateExists) return "state";
	if (checkpoint?.observation?.url) return "url-fallback";
	return "metadata-only-unrestorable";
}
