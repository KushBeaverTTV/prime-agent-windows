import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	encodePrivateFrame,
	type PrivateFrame,
	PrivateFrameDecoder,
	PrivateFramedChannel,
	type PrivateFrameHeaderValidator,
} from "../src/modes/session-worker/private-framing.js";

interface TestHeader {
	type: string;
	requestId?: string;
}

const isTestHeader: PrivateFrameHeaderValidator<TestHeader> = (value: unknown): value is TestHeader => {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; requestId?: unknown };
	return (
		typeof candidate.type === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string")
	);
};

describe("private worker framing", () => {
	it("decodes headers and opaque payloads across arbitrary chunk boundaries", () => {
		const first = encodePrivateFrame({ type: "event", requestId: "one" }, Buffer.from([0, 1, 2, 255]));
		const second = encodePrivateFrame({ type: "response", requestId: "two" }, Buffer.from("payload"));
		const combined = Buffer.concat([first, second]);
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const frames = [];

		for (let offset = 0; offset < combined.length; offset += 3) {
			frames.push(...decoder.push(combined.subarray(offset, offset + 3)));
		}
		decoder.finish();

		expect(frames).toEqual([
			{ header: { type: "event", requestId: "one" }, payload: Buffer.from([0, 1, 2, 255]) },
			{ header: { type: "response", requestId: "two" }, payload: Buffer.from("payload") },
		]);
	});

	it("rejects invalid lengths, JSON, and routing headers", () => {
		const oversized = Buffer.alloc(8);
		oversized.writeUInt32BE(1025, 0);
		expect(() =>
			new PrivateFrameDecoder(isTestHeader, { maxHeaderBytes: 1024, maxPayloadBytes: 1024 }).push(oversized),
		).toThrow("Invalid private frame header length");

		const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from("{")]);
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidJson)).toThrow(
			"Invalid private frame header JSON",
		);

		const invalidHeader = encodePrivateFrame({ missing: "type" }, Buffer.alloc(0));
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidHeader)).toThrow(
			"Invalid private frame routing header",
		);
	});

	it("reports an incomplete trailing frame", () => {
		const decoder = new PrivateFrameDecoder(isTestHeader);
		decoder.push(encodePrivateFrame({ type: "event" }, Buffer.from("body")).subarray(0, 9));
		expect(() => decoder.finish()).toThrow("incomplete bytes");
	});

	it("decodes frames split one byte at a time", () => {
		const frames = [
			encodePrivateFrame({ type: "event", requestId: "one" }, Buffer.from([0, 1, 2, 255])),
			encodePrivateFrame({ type: "response", requestId: "two" }, Buffer.from("payload")),
			encodePrivateFrame({ type: "event" }, Buffer.alloc(0)),
		];
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const decoded: PrivateFrame<TestHeader>[] = [];
		for (const byte of Buffer.concat(frames)) {
			decoded.push(...decoder.push(Buffer.from([byte])));
		}
		decoder.finish();

		expect(decoded).toEqual([
			{ header: { type: "event", requestId: "one" }, payload: Buffer.from([0, 1, 2, 255]) },
			{ header: { type: "response", requestId: "two" }, payload: Buffer.from("payload") },
			{ header: { type: "event" }, payload: Buffer.alloc(0) },
		]);
	});

	it("tracks unread bytes while frames span chunk boundaries", () => {
		const frame = encodePrivateFrame({ type: "event" }, Buffer.from("a".repeat(100)));
		const decoder = new PrivateFrameDecoder(isTestHeader);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.push(frame.subarray(0, 20));
		expect(decoder.bufferedBytes).toBe(20);
		decoder.push(frame.subarray(20, 50));
		expect(decoder.bufferedBytes).toBe(50);
		// A complete frame is decoded in one push; nothing stays buffered.
		const decoded = decoder.push(frame.subarray(50));
		expect(decoded).toEqual([{ header: { type: "event" }, payload: Buffer.from("a".repeat(100)) }]);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.finish();
	});

	it("decodes a large frame delivered in small chunks in near-linear time", () => {
		// A decoder that re-copies its whole pending buffer on every socket read
		// turns one ~8MB frame into ~8GB of memcpy at 4KB reads. A linear decoder
		// finishes in well under a second; the quadratic one cannot. The budget
		// stays generous so slow CI runners do not flake on the linear path.
		const frame = encodePrivateFrame({ type: "event", requestId: "large" }, Buffer.alloc(8 * 1024 * 1024, 7));
		const decoder = new PrivateFrameDecoder(isTestHeader);

		const started = performance.now();
		const decoded: PrivateFrame<TestHeader>[] = [];
		for (let offset = 0; offset < frame.length; offset += 4096) {
			decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + 4096, frame.length))));
		}
		const elapsed = performance.now() - started;

		expect(decoded).toHaveLength(1);
		expect(decoded[0]?.header).toEqual({ type: "event", requestId: "large" });
		const payload = decoded[0]?.payload;
		expect(payload?.length).toBe(8 * 1024 * 1024);
		expect(payload?.[0]).toBe(7);
		expect(payload?.[4 * 1024 * 1024]).toBe(7);
		expect(payload?.[8 * 1024 * 1024 - 1]).toBe(7);
		expect(elapsed).toBeLessThan(2000);
		decoder.finish();
	});

	it("consumes a frame split across many chunks without calling Array.prototype.shift", () => {
		// The decoder used to shift every fully consumed chunk off the pending
		// queue, so a frame delivered in N small socket writes cost O(N^2)
		// array element moves inside a single consume() call. A head cursor skips
		// spent chunks instead of shifting them, so a fully synchronous decode
		// loop run under a shift-counting Array.prototype.shift patch must see
		// zero shift calls.
		const frame = encodePrivateFrame({ type: "event", requestId: "large" }, Buffer.alloc(8 * 1024 * 1024, 3));
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const decoded: PrivateFrame<TestHeader>[] = [];

		const originalShift = Array.prototype.shift;
		let shiftCalls = 0;
		Array.prototype.shift = function (this: unknown[]): unknown {
			shiftCalls += 1;
			return originalShift.apply(this);
		};
		try {
			for (let offset = 0; offset < frame.length; offset += 1024) {
				decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + 1024, frame.length))));
			}
		} finally {
			Array.prototype.shift = originalShift;
		}

		expect(shiftCalls).toBe(0);
		expect(decoded).toHaveLength(1);
		expect(decoded[0]?.header).toEqual({ type: "event", requestId: "large" });
		expect(decoded[0]?.payload.length).toBe(8 * 1024 * 1024);
		decoder.finish();
	});

	it("decodes a large frame delivered in tiny chunks within a per-chunk work budget", () => {
		// Per-chunk bookkeeping costs scale with the chunk count, not just total
		// bytes: a 64MB frame in 256B writes spans ~262k chunks, and any cost
		// proportional to the pending queue per consumed chunk (shifting or
		// splicing one entry off the front at a time) is quadratic in that
		// count. The budget keeps generous margin for slow runners on the
		// linear path; the quadratic path needs several seconds even locally.
		const frame = encodePrivateFrame({ type: "event", requestId: "tiny-chunks" }, Buffer.alloc(64 * 1024 * 1024, 7));
		const decoder = new PrivateFrameDecoder(isTestHeader);

		const started = performance.now();
		const decoded: PrivateFrame<TestHeader>[] = [];
		for (let offset = 0; offset < frame.length; offset += 256) {
			decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + 256, frame.length))));
		}
		const elapsed = performance.now() - started;

		expect(decoded).toHaveLength(1);
		expect(decoded[0]?.header).toEqual({ type: "event", requestId: "tiny-chunks" });
		expect(decoded[0]?.payload.length).toBe(64 * 1024 * 1024);
		expect(elapsed).toBeLessThan(2500);
		decoder.finish();
	});

	it("sends frames through a duplex channel without interpreting payload bytes", async () => {
		const stream = new PassThrough();
		const channel = new PrivateFramedChannel(stream, isTestHeader);
		const received = new Promise<{ header: TestHeader; payload: Buffer }>((resolve) => {
			channel.onFrame(resolve);
		});

		await channel.send({ type: "snapshot", requestId: "request" }, Buffer.from([9, 8, 7]));

		await expect(received).resolves.toEqual({
			header: { type: "snapshot", requestId: "request" },
			payload: Buffer.from([9, 8, 7]),
		});
		channel.close();
	});
});
