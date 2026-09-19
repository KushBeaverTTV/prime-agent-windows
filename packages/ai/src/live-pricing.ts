/**
 * Live model pricing from https://models.dev/api.json.
 *
 * The compile-time snapshot in models.generated.ts ages between releases; this
 * module refreshes cost data at runtime so cost displays track current provider
 * prices. It is intentionally Node-only (fs cache) and is therefore reachable
 * through the `@earendil-works/pi-ai/live-pricing` subpath export rather than
 * the browser-safe root entry.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, Model } from "./types.js";

/** USD per million tokens — same units as `Model.cost`. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface LivePricingSnapshot {
	fetchedAt: number;
	providers: Record<string, Record<string, ModelCost>>;
}

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Our provider ids where models.dev uses a different top-level key, mirroring
 * the key choice in scripts/generate-models.ts. OpenRouter and vercel-ai-gateway
 * prices come from their own catalogs (and runtime usage cost reporting), so
 * they have no entry here.
 */
const PROVIDER_TO_MODELS_DEV_KEY: Record<string, string> = {
	zai: "zai-coding-plan",
	fireworks: "fireworks-ai",
	"kimi-coding": "kimi-for-coding",
	xiaomi: "xiaomi",
	"xiaomi-token-plan-cn": "xiaomi",
	"xiaomi-token-plan-ams": "xiaomi",
	"xiaomi-token-plan-sgp": "xiaomi",
};

interface ModelsDevModelEntry {
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
}

function isModelCost(value: unknown): value is ModelCost {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.input === "number" &&
		typeof record.output === "number" &&
		typeof record.cacheRead === "number" &&
		typeof record.cacheWrite === "number"
	);
}

function parseSnapshot(value: unknown): LivePricingSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { fetchedAt?: unknown; providers?: unknown };
	if (typeof candidate.fetchedAt !== "number" || !candidate.providers || typeof candidate.providers !== "object") {
		return undefined;
	}
	const providers: Record<string, Record<string, ModelCost>> = {};
	for (const [provider, models] of Object.entries(candidate.providers)) {
		if (!models || typeof models !== "object") continue;
		const entries: Record<string, ModelCost> = {};
		for (const [id, cost] of Object.entries(models)) {
			if (isModelCost(cost)) entries[id] = cost;
		}
		providers[provider] = entries;
	}
	return { fetchedAt: candidate.fetchedAt, providers };
}

function readCache(cachePath: string): LivePricingSnapshot | undefined {
	try {
		return parseSnapshot(JSON.parse(readFileSync(cachePath, "utf-8")));
	} catch {
		return undefined;
	}
}

function writeCache(cachePath: string, snapshot: LivePricingSnapshot): void {
	mkdirSync(dirname(cachePath), { recursive: true });
	const tempPath = `${cachePath}.tmp-${process.pid}`;
	writeFileSync(tempPath, JSON.stringify(snapshot));
	renameSync(tempPath, cachePath);
}

function mapModelsDevPayload(data: Record<string, unknown>, fetchedAt: number): LivePricingSnapshot {
	const providers: Record<string, Record<string, ModelCost>> = {};
	for (const [providerKey, providerValue] of Object.entries(data)) {
		const models = (providerValue as { models?: unknown } | undefined)?.models;
		if (!models || typeof models !== "object") continue;
		const entries: Record<string, ModelCost> = {};
		for (const [modelId, modelValue] of Object.entries(models)) {
			const cost = (modelValue as ModelsDevModelEntry | undefined)?.cost;
			if (!cost) continue;
			entries[modelId] = {
				input: cost.input || 0,
				output: cost.output || 0,
				cacheRead: cost.cache_read || 0,
				cacheWrite: cost.cache_write || 0,
			};
		}
		if (Object.keys(entries).length > 0) providers[providerKey] = entries;
	}
	return { fetchedAt, providers };
}

/**
 * Read the cached snapshot; serve it when fresh. Otherwise fetch models.dev
 * (unless offline), persist the result atomically, and fall back to the stale
 * cache on any failure. Never throws.
 */
export async function refreshLivePricing(
	cachePath: string,
	options: { offline: boolean; ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number },
): Promise<LivePricingSnapshot | undefined> {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const cached = readCache(cachePath);
	if (cached && now() - cached.fetchedAt < ttlMs) {
		return cached;
	}
	if (options.offline) {
		return cached;
	}
	try {
		const fetchImpl = options.fetchImpl ?? fetch;
		const response = await fetchImpl(MODELS_DEV_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok) return cached;
		const data: unknown = await response.json();
		if (!data || typeof data !== "object") return cached;
		const snapshot = mapModelsDevPayload(data as Record<string, unknown>, now());
		try {
			writeCache(cachePath, snapshot);
		} catch {
			// A read-only agent dir must not drop a good fetch.
		}
		return snapshot;
	} catch {
		return cached;
	}
}

/**
 * Return `model` with its cost replaced by the live entry when the snapshot
 * carries one for `model.provider`/`model.id`; the same object otherwise.
 * Gateway-style ids (`upstream/model`) also match on the unprefixed id.
 */
export function applyLivePricing<TApi extends Api>(
	model: Model<TApi>,
	snapshot: LivePricingSnapshot | undefined,
): Model<TApi> {
	if (!snapshot) return model;
	const key = PROVIDER_TO_MODELS_DEV_KEY[model.provider] ?? model.provider;
	const entries = snapshot.providers[key];
	if (!entries) return model;
	const cost =
		entries[model.id] ??
		(model.id.includes("/") ? entries[model.id.slice(model.id.lastIndexOf("/") + 1)] : undefined);
	if (!cost) return model;
	return { ...model, cost: { ...cost } };
}
