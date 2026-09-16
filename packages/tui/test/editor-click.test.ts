import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createEditor(cols = 40, rows = 24): Editor {
	return new Editor(new TUI(new VirtualTerminal(cols, rows)), defaultEditorTheme);
}

function clickRegions(editor: Editor) {
	const regions = editor.getClickRegions();
	assert.strictEqual(regions.length, 1);
	return regions[0]!;
}

describe("editor click regions", () => {
	it("places the cursor at the clicked column and focuses the editor", () => {
		const editor = createEditor();
		editor.setText("hello world");
		editor.render(40);

		assert.strictEqual(editor.focused, false);
		clickRegions(editor).onClick({ row: 0, col: 4 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
		assert.strictEqual(editor.focused, true);
	});

	it("maps clicks on wrapped rows to their logical source position", () => {
		const editor = createEditor(10);
		editor.setText("aaaa bbbb cccc dddd");
		const lines = editor.render(10);
		assert.ok(lines.length > 3, "text wraps across multiple rows");

		const region = clickRegions(editor);
		assert.strictEqual(region.line, 1);
		region.onClick({ row: 0, col: 0 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		region.onClick({ row: 1, col: 2 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });
		region.onClick({ row: 2, col: 3 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 });
	});

	it("uses one deterministic boundary rule for wide graphemes", () => {
		const editor = createEditor();
		editor.setText("a🎉b");
		editor.render(40);
		const region = clickRegions(editor);

		region.onClick({ row: 0, col: 1 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 }, "first half lands before");
		region.onClick({ row: 0, col: 2 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 }, "second half lands after");
	});

	it("snaps clicks inside an atomic paste marker to its boundary, split or not", () => {
		const editor = createEditor();
		editor.handleInput(`\x1b[200~${Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")}\x1b[201~`);
		const marker = editor.getText();
		assert.strictEqual(marker, "[paste #1 +15 lines]");
		editor.render(40);
		const region = clickRegions(editor);

		region.onClick({ row: 0, col: 9 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }, "left half lands before");
		region.onClick({ row: 0, col: 10 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 20 }, "right half lands after");

		editor.render(12); // narrow width force-splits the marker across two rows
		const split = clickRegions(editor);
		assert.strictEqual(split.height, 2, "marker wraps onto two visual rows");
		split.onClick({ row: 0, col: 9 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }, "first chunk lands before");
		split.onClick({ row: 1, col: 0 });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 20 }, "continuation chunk lands after");
		split.onClick({ row: 0, col: 11 });
		const cursor = editor.getCursor();
		assert.ok(
			cursor.line === 0 && (cursor.col === 0 || cursor.col === 20),
			`padding click lands on a marker boundary, not mid-marker (got ${cursor.col})`,
		);
	});

	it("maps clicks through editor scroll using visible rows only", () => {
		const editor = createEditor();
		editor.setText(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
		editor.render(40);
		const region = clickRegions(editor);
		assert.strictEqual(region.height, 7, "only the visible slice is clickable");

		region.onClick({ row: 0, col: 0 });
		assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 0 });
		region.onClick({ row: 5, col: 2 });
		assert.deepStrictEqual(editor.getCursor(), { line: 8, col: 2 });
	});
});
