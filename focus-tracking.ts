import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const FOCUS_EVENTS_ON = "\x1b[?1004h";
const FOCUS_EVENTS_OFF = "\x1b[?1004l";
const WIDGET_ID = "blinkenlights-focus";

export function installFocusTracking(
	ctx: ExtensionContext,
	onFocusChange: (focused: boolean) => void,
): () => void {
	let removeInputListener: (() => void) | undefined;
	ctx.ui.setWidget(WIDGET_ID, (tui) => {
		removeInputListener = tui.addInputListener((data: string) => {
			if (data.includes(FOCUS_IN)) onFocusChange(true);
			if (data.includes(FOCUS_OUT)) onFocusChange(false);

			const remaining = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
			if (remaining.length > 0) onFocusChange(true);
			return remaining.length === 0 ? { consume: true } : { data: remaining };
		});
		return { render: () => [], invalidate: () => {} };
	});
	process.stdout.write(FOCUS_EVENTS_ON);

	return () => {
		removeInputListener?.();
		process.stdout.write(FOCUS_EVENTS_OFF);
		ctx.ui.setWidget(WIDGET_ID, undefined);
	};
}
