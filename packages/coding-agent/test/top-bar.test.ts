import { beforeEach, describe, expect, it } from "vitest";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeEach(() => {
	initTheme("dark");
});

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("TopBar", () => {
	it("renders the chat name as a slab with hazard stripes on the right", () => {
		const bar = new TopBar({ getChatName: () => "demo" });
		const [line] = bar.render(21);
		const plain = stripAnsi(line);
		expect(plain.startsWith(" ▌ demo")).toBe(true);
		expect(plain).toContain("▚");
		expect(plain.length).toBe(21);
	});

	it("shows MODEL and COST pairs only when known", () => {
		const full = new TopBar({
			getChatName: () => "demo",
			getCostUsd: () => 1.42,
			getModelLabel: () => "anthropic/claude-sonnet-4",
		});
		const [fullLine] = full.render(80);
		const plain = stripAnsi(fullLine);
		expect(plain).toContain("MODEL anthropic/claude-sonnet-4");
		expect(plain).toContain("COST $1.42");
		expect(plain).toContain("  //  ");

		const bare = new TopBar({ getChatName: () => "demo", getCostUsd: () => undefined });
		const [bareLine] = bare.render(40);
		const barePlain = stripAnsi(bareLine);
		expect(barePlain).not.toContain("MODEL");
		expect(barePlain).not.toContain("COST");
	});

	it("collapses embedded newlines so the bar stays a single row", () => {
		const bar = new TopBar({ getChatName: () => "line1\nline2" });
		const lines = bar.render(40);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain("line1 line2");
	});

	it("strips terminal escape sequences from the chat name", () => {
		const bar = new TopBar({ getChatName: () => "a\u001b[2Jb\u001b]0;title\u0007c" });
		const [line] = bar.render(60);
		const plain = stripAnsi(line);
		expect(plain).not.toContain("\u001b");
		expect(plain).not.toContain("\u0007");
		expect(plain).toContain("a [2Jb ]0;title c");
	});

	it("renders the slab even when the chat name is empty", () => {
		const bar = new TopBar({ getChatName: () => undefined });
		const lines = bar.render(21);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain("▚");
	});

	it("truncates to the terminal width", () => {
		const bar = new TopBar({ getChatName: () => "a-very-long-chat-name-that-overflows", getCostUsd: () => 9.99 });
		const [line] = bar.render(12);
		expect(stripAnsi(line).length).toBeLessThanOrEqual(12);
	});
});
