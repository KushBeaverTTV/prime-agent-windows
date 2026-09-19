import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLivePricing, type LivePricingSnapshot, refreshLivePricing } from "../src/live-pricing.js";
import { applyReportedCost, getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model, Usage } from "../src/types.js";

const usageState = vi.hoisted(() => ({ chunk: undefined as Record<string, unknown> | undefined }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: usageState.chunk,
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function pricedModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "vendor/foo",
		name: "Foo",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 4, output: 12, cacheRead: 0.4, cacheWrite: 9 },
		contextWindow: 128000,
		maxTokens: 32000,
		...overrides,
	};
}

function snapshot(providers: LivePricingSnapshot["providers"]): LivePricingSnapshot {
	return { fetchedAt: Date.now(), providers };
}

describe("applyLivePricing", () => {
	it("rewrites cost for a provider/id entry", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const live = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
		const result = applyLivePricing(model, snapshot({ anthropic: { "claude-sonnet-4-5": live } }));
		expect(result.cost).toEqual(live);
	});

	it("maps provider ids to their models.dev key", () => {
		const model = getModelsById("zai");
		const live = { input: 0.2, output: 1, cacheRead: 0.05, cacheWrite: 0.3 };
		const result = applyLivePricing(model, snapshot({ "zai-coding-plan": { [model.id]: live } }));
		expect(result.cost).toEqual(live);
	});

	it("matches a gateway-style id on its unprefixed tail", () => {
		const live = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.3 };
		const result = applyLivePricing(pricedModel(), snapshot({ openrouter: { foo: live } }));
		expect(result.cost).toEqual(live);
	});

	it("returns the same model when the snapshot has no entry", () => {
		const model = pricedModel();
		expect(applyLivePricing(model, snapshot({ openrouter: {} }))).toBe(model);
		expect(applyLivePricing(model, undefined)).toBe(model);
	});
});

function getModelsById(provider: "zai"): Model<"openai-completions"> {
	const model = getModel(provider, "glm-4.7") as Model<"openai-completions">;
	if (!model) throw new Error("expected zai/glm-4.7 in the bundled catalog");
	return model;
}

describe("refreshLivePricing", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function cachePath(): string {
		dir = mkdtempSync(join(tmpdir(), "pi-live-pricing-"));
		return join(dir, "model-pricing.json");
	}

	it("serves a fresh cache without fetching", async () => {
		const path = cachePath();
		const cached = snapshot({
			anthropic: { "claude-sonnet-4-5": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
		});
		writeFileSync(path, JSON.stringify(cached));
		const fetchImpl = vi.fn(() => Promise.reject(new Error("must not fetch")));
		const result = await refreshLivePricing(path, { offline: false, fetchImpl });
		expect(result?.providers.anthropic["claude-sonnet-4-5"]).toEqual(cached.providers.anthropic["claude-sonnet-4-5"]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("fetches a stale cache, maps models.dev fields, and persists atomically", async () => {
		const path = cachePath();
		writeFileSync(path, JSON.stringify({ fetchedAt: 0, providers: {} }));
		const payload = {
			anthropic: {
				models: {
					"claude-sonnet-4-5": {
						cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
					},
				},
			},
		};
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload)));
		const result = await refreshLivePricing(path, { offline: false, fetchImpl });
		expect(result?.providers.anthropic["claude-sonnet-4-5"]).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
		const persisted = JSON.parse(readFileSync(path, "utf-8")) as LivePricingSnapshot;
		expect(persisted.providers.anthropic["claude-sonnet-4-5"].cacheWrite).toBe(3.75);
	});

	it("falls back to the stale cache when the fetch fails", async () => {
		const path = cachePath();
		const cached = snapshot({ openai: { "gpt-5.1": { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } } });
		cached.fetchedAt = 0;
		writeFileSync(path, JSON.stringify(cached));
		const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
		const result = await refreshLivePricing(path, { offline: false, fetchImpl });
		expect(result?.providers.openai["gpt-5.1"].output).toBe(4);
	});

	it("returns the cache in offline mode and undefined with no cache", async () => {
		const path = cachePath();
		const cached = snapshot({ openai: { "gpt-5.1": { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } } });
		cached.fetchedAt = 0;
		writeFileSync(path, JSON.stringify(cached));
		const fetchImpl = vi.fn(() => Promise.reject(new Error("must not fetch")));
		expect((await refreshLivePricing(path, { offline: true, fetchImpl }))?.providers.openai).toBeDefined();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await refreshLivePricing(join(dir, "missing.json"), { offline: true })).toBeUndefined();
	});
});

describe("applyReportedCost", () => {
	it("rescales components so they sum to the reported total", () => {
		const usage: Usage = {
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
			cost: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, total: 6 },
		};
		applyReportedCost(usage, 12);
		expect(usage.cost.total).toBe(12);
		expect(usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite).toBeCloseTo(12, 10);
		expect(usage.cost.input).toBeCloseTo(8, 10);
	});

	it("ignores missing and invalid reported totals", () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		applyReportedCost(usage, undefined);
		applyReportedCost(usage, Number.NaN);
		applyReportedCost(usage, -1);
		expect(usage.cost.total).toBe(0);
		applyReportedCost(usage, 0.5);
		expect(usage.cost.total).toBe(0.5);
	});
});

describe("provider-reported usage cost", () => {
	it("prefers the billed total reported on the completion chunk", async () => {
		usageState.chunk = {
			prompt_tokens: 100,
			completion_tokens: 10,
			cost: 0.005,
		};
		const message = await streamOpenAICompletions(
			pricedModel(),
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
			{ apiKey: "test-key" },
		).result();
		expect(message.usage.cost.total).toBe(0.005);
		expect(message.usage.cost.input).toBeGreaterThan(0);
	});

	it("keeps static pricing when the provider reports no cost", async () => {
		usageState.chunk = { prompt_tokens: 100, completion_tokens: 10 };
		const message = await streamOpenAICompletions(
			pricedModel(),
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
			{ apiKey: "test-key" },
		).result();
		expect(message.usage.cost.total).toBeCloseTo((100 * 4 + 10 * 12) / 1_000_000, 10);
	});
});
