import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BlinkenlightsRuntime } from "./runtime.ts";

export { parseDndValue } from "./dnd.ts";
export {
	parsePattern,
	parsePriority,
	parseTimeoutSeconds,
	renderWaveform,
	resolveSettings,
} from "./patterns.ts";

export default function blinkenlights(pi: ExtensionAPI): void {
	new BlinkenlightsRuntime(pi).register();
}
