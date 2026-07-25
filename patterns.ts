import type { DndValue } from "./dnd.ts";

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 604_800;
export const DEFAULT_PRIORITY = 10;
export const DEFAULT_FOCUS_HOTKEY: FocusHotkeySettings = {
	enabled: true,
	type: "doubleModifier",
	modifier: "command",
	intervalMs: 350,
};

const MIN_PHASE_MS = 20;
const MAX_PHASE_MS = 60_000;
const MAX_PHASES = 64;
const MAX_CYCLE_MS = 300_000;

export interface Phase {
	on: boolean;
	durationMs: number;
}

export type FocusModifier = "command" | "control" | "option" | "shift";

export interface FocusHotkeySettings {
	enabled: boolean;
	type: "doubleModifier";
	modifier: FocusModifier;
	intervalMs: number;
}

export interface StoredSettings {
	activePattern?: string;
	timeoutSeconds?: number;
	priority?: number;
	enabled?: boolean;
	dndUntil?: DndValue;
	patterns?: Record<string, string>;
	focusHotkey?: Partial<FocusHotkeySettings>;
}

export interface ResolvedSettings {
	activePattern: string;
	timeoutSeconds: number;
	priority: number;
	enabled: boolean;
	globalDndUntil: DndValue;
	projectDndUntil: DndValue;
	patterns: Record<string, Phase[]>;
	focusHotkey: FocusHotkeySettings;
}

export const BUILTIN_PATTERNS: Record<string, string> = {
	Classic: "on 500ms, off 500ms",
	"Double pulse": "on 120ms, off 100ms, on 120ms, off 660ms",
	Heartbeat: "on 80ms, off 100ms, on 180ms, off 900ms",
	SOS: "on 150ms, off 150ms, on 150ms, off 150ms, on 150ms, off 450ms, on 450ms, off 150ms, on 450ms, off 150ms, on 450ms, off 450ms, on 150ms, off 150ms, on 150ms, off 150ms, on 150ms, off 1050ms",
};

export function parseTimeoutSeconds(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
	const text = String(value);
	if (!/^\d+$/.test(text))
		throw new Error("timeout must be a whole number of seconds");

	const seconds = Number(text);
	if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
	return seconds;
}

export function parsePriority(value: unknown): number {
	if (value === undefined) return DEFAULT_PRIORITY;
	const text = String(value);
	if (!/^\d+$/.test(text)) throw new Error("priority must be a positive integer");
	const priority = Number(text);
	if (priority < 1 || priority > 1_000_000) {
		throw new Error("priority must be between 1 and 1000000");
	}
	return priority;
}

export function parseFocusHotkey(value: unknown = {}): FocusHotkeySettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("focusHotkey must be an object");
	}
	const input = value as Partial<Record<keyof FocusHotkeySettings, unknown>>;
	const enabled = input.enabled ?? DEFAULT_FOCUS_HOTKEY.enabled;
	if (typeof enabled !== "boolean") throw new Error("focusHotkey.enabled must be boolean");

	const type = input.type ?? DEFAULT_FOCUS_HOTKEY.type;
	if (type !== "doubleModifier") throw new Error("focusHotkey.type must be doubleModifier");

	const modifier = input.modifier ?? DEFAULT_FOCUS_HOTKEY.modifier;
	if (!["command", "control", "option", "shift"].includes(String(modifier))) {
		throw new Error("focusHotkey.modifier must be command, control, option, or shift");
	}

	const intervalMs = input.intervalMs ?? DEFAULT_FOCUS_HOTKEY.intervalMs;
	if (!Number.isInteger(intervalMs) || Number(intervalMs) < 100 || Number(intervalMs) > 2_000) {
		throw new Error("focusHotkey.intervalMs must be between 100 and 2000");
	}

	return {
		enabled,
		type,
		modifier: modifier as FocusModifier,
		intervalMs: Number(intervalMs),
	};
}

export function parsePattern(source: string): Phase[] {
	const parts = source.split(",").map((part) => part.trim());
	if (parts.length < 2 || parts.length > MAX_PHASES) {
		throw new Error(`pattern must contain between 2 and ${MAX_PHASES} phases`);
	}

	const phases = parts.map((part, index) => {
		const match = /^(on|off)\s+(\d+)ms$/i.exec(part);
		if (!match) throw new Error(`invalid phase ${index + 1}: ${part}`);

		const durationMs = Number(match[2]);
		if (durationMs < MIN_PHASE_MS || durationMs > MAX_PHASE_MS) {
			throw new Error(
				`phase ${index + 1} must last ${MIN_PHASE_MS}-${MAX_PHASE_MS}ms`,
			);
		}
		return { on: match[1]?.toLowerCase() === "on", durationMs };
	});

	for (let index = 1; index < phases.length; index++) {
		if (phases[index]?.on === phases[index - 1]?.on) {
			throw new Error(`phases ${index} and ${index + 1} must alternate on/off`);
		}
	}
	if (phases[0]?.on === phases.at(-1)?.on) {
		throw new Error(
			"first and last phases must alternate when the pattern repeats",
		);
	}

	const cycleMs = phases.reduce((total, phase) => total + phase.durationMs, 0);
	if (cycleMs > MAX_CYCLE_MS)
		throw new Error(`pattern cycle cannot exceed ${MAX_CYCLE_MS}ms`);
	return phases;
}

export function formatPattern(phases: Phase[]): string {
	return phases
		.map((phase) => `${phase.on ? "on" : "off"} ${phase.durationMs}ms`)
		.join(", ");
}

export function renderWaveform(phases: Phase[], width = 36): string {
	if (!Number.isInteger(width) || width < 1) throw new Error("waveform width must be positive");
	const cycleMs = phases.reduce((total, phase) => total + phase.durationMs, 0);
	let waveform = "";
	for (let cell = 0; cell < width; cell++) {
		const position = ((cell + 0.5) * cycleMs) / width;
		let elapsed = 0;
		const phase = phases.find((candidate) => {
			elapsed += candidate.durationMs;
			return position < elapsed;
		});
		waveform += phase?.on ? "█" : "·";
	}
	return waveform;
}

export function resolveSettings(
	globalSettings: StoredSettings = {},
	projectSettings: StoredSettings = {},
): ResolvedSettings {
	const sources = {
		...BUILTIN_PATTERNS,
		...(globalSettings.patterns ?? {}),
		...(projectSettings.patterns ?? {}),
	};
	const patterns = Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [
			name,
			parsePattern(source),
		]),
	);
	const activePattern =
		projectSettings.activePattern ?? globalSettings.activePattern ?? "Classic";
	if (!patterns[activePattern])
		throw new Error(`unknown active pattern: ${activePattern}`);

	return {
		activePattern,
		timeoutSeconds: parseTimeoutSeconds(
			projectSettings.timeoutSeconds ?? globalSettings.timeoutSeconds,
		),
		priority: parsePriority(projectSettings.priority ?? globalSettings.priority),
		enabled: projectSettings.enabled ?? globalSettings.enabled ?? true,
		globalDndUntil: globalSettings.dndUntil,
		projectDndUntil: projectSettings.dndUntil,
		patterns,
		focusHotkey: parseFocusHotkey({
			...(globalSettings.focusHotkey ?? {}),
			...(projectSettings.focusHotkey ?? {}),
		}),
	};
}
