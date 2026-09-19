import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatUsd } from "../../../utils/format.js";
import { theme } from "../theme/theme.js";

const HAZARD_STRIPE = "▚";

export interface TopBarOptions {
	getChatName: () => string | undefined;
	/** Total session spend in USD (branch total, subagents included). */
	getCostUsd?: () => number | undefined;
	/** Current model label, provider-prefixed short form (e.g. `anthropic/claude-sonnet-4`). */
	getModelLabel?: () => string | undefined;
}

/**
 * Pinned top bar for fullscreen chats, rendered as a Cornerstone slab: `▌ <chat
 * name>` on the left, KV pairs `MODEL <id>  //  COST $x.xx` after it (each only
 * when known), and hazard stripes filling the rest of the row. Rendered as the
 * fullscreen viewport's pinned header, so it stays on screen in every scroll
 * position. Always exactly one row.
 */
export class TopBar implements Component {
	private readonly options: TopBarOptions;

	constructor(options: TopBarOptions) {
		this.options = options;
	}

	invalidate(): void {
		// Render output is derived from live session state via getters.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// Strip terminal control characters (C0, DEL, C1): persisted session or
		// model names could carry escape sequences that would execute on every
		// bar repaint. Then collapse all whitespace: an embedded newline in the
		// name would emit multiple rows and break the fixed fullscreen frame.
		const sanitize = (value: string | undefined): string =>
			(value ?? "")
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		const name = sanitize(this.options.getChatName());
		const model = sanitize(this.options.getModelLabel?.());
		const cost = this.options.getCostUsd?.();
		const parts: string[] = [];
		if (name) parts.push(name);
		if (model) parts.push(`MODEL ${model}`);
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
			parts.push(`COST ${formatUsd(cost)}`);
		}
		const left = ` ▌ ${parts.join("  //  ")}`;
		// Same layout as the agents-view slab: content left, hazard stripes in the
		// right quarter, one blank column on the far right.
		const right = " ";
		const stripeWidth = Math.max(0, Math.floor(safeWidth / 4) - visibleWidth(right));
		const label = truncateToWidth(left, Math.max(0, safeWidth - stripeWidth - visibleWidth(right)), "");
		const gap = " ".repeat(Math.max(0, safeWidth - visibleWidth(label) - stripeWidth - visibleWidth(right)));
		return [theme.bg("accent", theme.fg("bg", `${label}${gap}${HAZARD_STRIPE.repeat(stripeWidth)}${right}`))];
	}
}
