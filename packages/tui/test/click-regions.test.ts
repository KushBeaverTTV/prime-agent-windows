import assert from "node:assert";
import { describe, it } from "node:test";
import type { ClickPosition, ClickRegion } from "../src/click-regions.js";
import { Box } from "../src/components/box.js";
import { Editor } from "../src/components/editor.js";
import { hyperlink } from "../src/terminal-image.js";
import { type Component, Container, TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class RegionComponent implements Component {
	private regions: ClickRegion[] = [];
	constructor(
		private readonly handler: (position: ClickPosition) => void,
		rendered: string[],
		private readonly line = 0,
		private readonly col = 0,
		private readonly width = 10,
		private readonly height = 1,
	) {
		this.rendered = rendered;
	}

	rendered: string[];
	static rows(handler: (position: ClickPosition) => void, count: number, line: number, col: number, width = 10) {
		return new RegionComponent(
			handler,
			Array.from({ length: count }, (_, i) => `row ${i}`),
			line,
			col,
			width,
		);
	}
	render(_width: number): string[] {
		this.regions =
			this.rendered.length > this.line
				? [{ line: this.line, col: this.col, width: this.width, height: this.height, onClick: this.handler }]
				: [];
		return this.rendered;
	}
	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}
	invalidate(): void {}
}

class PlainComponent implements Component {
	constructor(private readonly rendered: string[]) {}
	render(_width: number): string[] {
		return this.rendered;
	}
	invalidate(): void {}
}

const leftPress = (x: number, y: number, motion = false): string => `\x1b[<${motion ? 32 : 0};${x};${y}M`;
const leftRelease = (x: number, y: number): string => `\x1b[<0;${x};${y}m`;

function setup(cols = 40, rows = 10): { terminal: VirtualTerminal; tui: TUI } {
	const terminal = new VirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	tui.start();
	return { terminal, tui };
}

describe("fullscreen click regions", () => {
	it("dispatches a transcript click at the region-relative position", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const chat = RegionComponent.rows((p) => calls.push(p), 20, 15, 5);
		const dock = new PlainComponent(["> prompt", "footer"]);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(8, 4));
		terminal.sendInput(leftRelease(8, 4));
		await terminal.waitForRender();
		assert.deepStrictEqual(calls, [{ row: 0, col: 2 }]);

		tui.stop();
	});

	it("re-maps transcript regions after scrolling", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const chat = RegionComponent.rows((p) => calls.push(p), 20, 15, 5);
		const dock = new PlainComponent(["> prompt"]);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<64;5;5M"); // wheel up 3: region moves from row 4 to row 7
		await terminal.waitForRender();

		terminal.sendInput(leftPress(8, 5)); // stale position
		terminal.sendInput(leftRelease(8, 5));
		await terminal.waitForRender();
		terminal.sendInput(leftPress(8, 8));
		terminal.sendInput(leftRelease(8, 8));
		await terminal.waitForRender();
		assert.deepStrictEqual(calls, [{ row: 0, col: 2 }]);

		tui.stop();
	});

	it("ignores drags, mismatched releases, non-left and modified clicks", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const chat = RegionComponent.rows((p) => calls.push(p), 20, 15, 5);
		const dock = new PlainComponent(["> prompt"]);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(8, 5));
		terminal.sendInput(leftPress(9, 5, true));
		terminal.sendInput(leftRelease(9, 5));
		await terminal.waitForRender();
		terminal.sendInput(leftPress(8, 5));
		terminal.sendInput(leftRelease(8, 2)); // released outside the region
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<2;8;5M"); // right button
		terminal.sendInput("\x1b[<2;8;5m");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<4;8;5M"); // shift+left
		terminal.sendInput("\x1b[<4;8;5m");
		await terminal.waitForRender();
		assert.deepStrictEqual(calls, []);

		tui.stop();
	});

	it("maps clicks through the pinned header", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const pin = RegionComponent.rows((p) => calls.push(p), 1, 0, 2);
		const chat = new PlainComponent(Array.from({ length: 6 }, (_, i) => `chat ${i}`));
		const dock = new PlainComponent(["> prompt"]);
		tui.enterFullscreen({ scroll: [chat], dock, pin });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(3, 1));
		terminal.sendInput(leftRelease(3, 1));
		await terminal.waitForRender();
		assert.deepStrictEqual(calls, [{ row: 0, col: 0 }]);

		tui.stop();
	});

	it("drops dock regions clipped away and keeps the visible ones", async () => {
		const { terminal, tui } = setup();
		const top: ClickPosition[] = [];
		const bottom: ClickPosition[] = [];
		const dock = new Container();
		dock.addChild(RegionComponent.rows((p) => top.push(p), 1, 0, 0));
		dock.addChild(new PlainComponent(Array.from({ length: 6 }, () => "mid")));
		dock.addChild(RegionComponent.rows((p) => bottom.push(p), 1, 0, 3));
		const chat = new PlainComponent(Array.from({ length: 6 }, (_, i) => `chat ${i}`));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(4, 4)); // first visible dock row: clipped region is gone
		terminal.sendInput(leftRelease(4, 4));
		await terminal.waitForRender();
		terminal.sendInput(leftPress(5, 10)); // last dock row keeps its region
		terminal.sendInput(leftRelease(5, 10));
		await terminal.waitForRender();
		assert.deepStrictEqual(top, []);
		assert.deepStrictEqual(bottom, [{ row: 0, col: 1 }]);

		tui.stop();
	});

	it("blocks click-through under overlays and dispatches overlay regions", async () => {
		const { terminal, tui } = setup();
		const base: ClickPosition[] = [];
		const overlayCalls: ClickPosition[] = [];
		const chat = RegionComponent.rows((p) => base.push(p), 20, 15, 5);
		const dock = new PlainComponent(["> prompt", "footer"]);
		// 12 rows without maxHeight: taller than the 10-row screen, so the
		// composited buffer extends past the viewport and rows must map back.
		const overlay = RegionComponent.rows((p) => overlayCalls.push(p), 12, 0, 4);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		tui.showOverlay(overlay, { width: 20, anchor: "top-left", nonCapturing: true });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(7, 4)); // transcript region is covered by overlay pixels
		terminal.sendInput(leftRelease(7, 4));
		await terminal.waitForRender();
		terminal.sendInput(leftPress(7, 1)); // the overlay's own region
		terminal.sendInput(leftRelease(7, 1));
		await terminal.waitForRender();
		assert.deepStrictEqual(base, []);
		assert.deepStrictEqual(overlayCalls, [{ row: 0, col: 2 }]);

		tui.stop();
	});

	it("gives hyperlinks precedence over click regions", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const urls: string[] = [];
		const chat = new RegionComponent(
			(p) => calls.push(p),
			Array.from({ length: 20 }, (_, i) => `row ${i}`),
			15,
			5,
		);
		chat.rendered[15] = hyperlink("open docs", "https://example.com/docs");
		const dock = new PlainComponent(["> prompt"]);
		tui.onOpenUrl = (url) => urls.push(url);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(8, 5));
		terminal.sendInput(leftRelease(8, 5));
		await terminal.waitForRender();
		assert.deepStrictEqual(urls, ["https://example.com/docs"]);
		assert.deepStrictEqual(calls, []);

		tui.stop();
	});

	it("places the editor cursor through a real dock click", async () => {
		const { terminal, tui } = setup();
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		tui.enterFullscreen({
			scroll: [new PlainComponent(Array.from({ length: 20 }, (_, i) => `row ${i}`))],
			dock: editor,
		});
		await terminal.waitForRender();

		terminal.sendInput(leftPress(7, 9));
		terminal.sendInput(leftRelease(7, 9));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		assert.strictEqual(editor.focused, true);

		tui.stop();
	});

	it("keeps a tall dock editor clickable where the dock clips its top rows", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.start();
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("alpha\nbeta\ngamma\ndelta\nepsilon");
		const dock = new Container();
		dock.addChild(editor);
		dock.addChild(new PlainComponent(["foot a", "foot b"]));
		tui.enterFullscreen({ scroll: [new PlainComponent(Array.from({ length: 20 }, (_, i) => `row ${i}`))], dock });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(3, 4)); // first visible content row is "beta"
		terminal.sendInput(leftRelease(3, 4));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 2 });

		terminal.sendInput(leftPress(2, 6)); // "delta" stays visible
		terminal.sendInput(leftRelease(2, 6));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 1 });

		terminal.sendInput(leftPress(3, 9)); // footer row, outside the editor region
		terminal.sendInput(leftRelease(3, 9));
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 1 });

		tui.stop();
	});

	it("drops Box click regions when a child later renders empty", () => {
		const calls: ClickPosition[] = [];
		const child = new RegionComponent((p) => calls.push(p), ["row"], 0, 0);
		const box = new Box(1, 1);
		box.addChild(child);
		assert.ok(box.render(20).length > 0);
		assert.strictEqual(box.getClickRegions().length, 1);

		child.rendered = [];
		assert.deepStrictEqual(box.render(20), []);
		assert.strictEqual(box.getClickRegions().length, 0);
		assert.deepStrictEqual(calls, []);
	});

	it("clips overlay click regions to the rows the overlay actually renders", async () => {
		const { terminal, tui } = setup();
		const overlayCalls: ClickPosition[] = [];
		const chat = new PlainComponent(Array.from({ length: 20 }, (_, i) => `row ${i}`));
		const dock = new PlainComponent(["> prompt", "footer"]);
		const overlay = new RegionComponent(
			(p) => overlayCalls.push(p),
			Array.from({ length: 5 }, (_, i) => `ov ${i}`),
			0,
			0,
			10,
			5,
		);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		tui.showOverlay(overlay, { width: 20, anchor: "top-left", nonCapturing: true, maxHeight: 4 });
		await terminal.waitForRender();

		terminal.sendInput(leftPress(5, 5)); // one row below the maxHeight-clipped overlay
		terminal.sendInput(leftRelease(5, 5));
		await terminal.waitForRender();
		terminal.sendInput(leftPress(5, 1)); // a rendered overlay row still fires
		terminal.sendInput(leftRelease(5, 1));
		await terminal.waitForRender();
		assert.deepStrictEqual(overlayCalls, [{ row: 0, col: 4 }]);

		tui.stop();
	});

	it("dispatches nothing while fullscreen mouse is disabled", async () => {
		const { terminal, tui } = setup();
		const calls: ClickPosition[] = [];
		const chat = RegionComponent.rows((p) => calls.push(p), 20, 15, 5);
		const dock = new PlainComponent(["> prompt"]);
		tui.enterFullscreen({ scroll: [chat], dock, mouse: false });
		await terminal.waitForRender();
		assert.strictEqual(terminal.mouseTrackingActive, false);

		terminal.sendInput(leftPress(8, 5));
		terminal.sendInput(leftRelease(8, 5));
		await terminal.waitForRender();
		assert.deepStrictEqual(calls, []);

		tui.stop();
	});
});
