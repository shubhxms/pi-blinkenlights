import {
	CONFIG_DIR_NAME,
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

import type { DndValue } from "./dnd.ts";

import {
	BUILTIN_PATTERNS,
	formatPattern,
	parsePattern,
	parsePriority,
	parseTimeoutSeconds,
	renderWaveform,
	resolveSettings,
	type Phase,
	type ResolvedSettings,
	type StoredSettings,
} from "./patterns.ts";

type Scope = "global" | "project";

export interface PatternPreview {
	start(phases: Phase[]): Promise<void> | void;
	stop(): void;
}

export interface BlinkenlightsSettingsStore {
	current(): ResolvedSettings;
	load(ctx: ExtensionContext): ResolvedSettings;
	openMenu(
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
		preview?: PatternPreview,
	): Promise<void>;
	setDnd(
		ctx: ExtensionCommandContext,
		scope: Scope,
		until: DndValue,
		onChange: (settings: ResolvedSettings) => void,
	): void;
}

async function selectPatternWithPreview(
	ctx: ExtensionCommandContext,
	names: string[],
	patterns: Record<string, Phase[]>,
	preview?: PatternPreview,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const items: SelectItem[] = names.map((name) => ({
			value: name,
			label: name,
			description: formatPattern(patterns[name] ?? []),
		}));
		const list = new SelectList(items, Math.min(items.length, 8), getSelectListTheme());
		const previewText = new Text("", 1, 0);
		let previewTimer: ReturnType<typeof setTimeout> | undefined;

		const updatePreview = (item: SelectItem, play: boolean) => {
			const phases = patterns[item.value];
			if (!phases) return;
			previewText.setText(
				`${theme.fg("accent", renderWaveform(phases))}\n${theme.fg("dim", formatPattern(phases))}`,
			);
			if (previewTimer) clearTimeout(previewTimer);
			if (play && preview) {
				previewTimer = setTimeout(() => {
					Promise.resolve(preview.start(phases)).catch((error) => {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					});
				}, 150);
			}
			tui.requestRender();
		};

		const finish = (value: string | undefined) => {
			if (previewTimer) clearTimeout(previewTimer);
			preview?.stop();
			done(value);
		};

		list.onSelectionChange = (item) => updatePreview(item, true);
		list.onSelect = (item) => finish(item.value);
		list.onCancel = () => finish(undefined);

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose a blink pattern")), 1, 0));
		container.addChild(list);
		container.addChild(previewText);
		container.addChild(new Text(theme.fg("dim", "↑↓ preview · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const initial = list.getSelectedItem();
		if (initial) updatePreview(initial, true);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => {
				container.invalidate();
				const selected = list.getSelectedItem();
				if (selected) updatePreview(selected, false);
			},
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function readSettings(path: string): StoredSettings {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${path}: invalid JSON: ${reason}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}

	const input = value as Record<string, unknown>;
	const settings: StoredSettings = {};
	if (input.activePattern !== undefined) {
		if (
			typeof input.activePattern !== "string" ||
			!input.activePattern.trim()
		) {
			throw new Error(`${path}: activePattern must be a non-empty string`);
		}
		settings.activePattern = input.activePattern;
	}
	if (input.timeoutSeconds !== undefined) {
		settings.timeoutSeconds = parseTimeoutSeconds(input.timeoutSeconds);
	}
	if (input.priority !== undefined) {
		settings.priority = parsePriority(input.priority);
	}
	if (input.enabled !== undefined) {
		if (typeof input.enabled !== "boolean") throw new Error(`${path}: enabled must be boolean`);
		settings.enabled = input.enabled;
	}
	if (input.dndUntil !== undefined) {
		if (
			input.dndUntil !== null &&
			(typeof input.dndUntil !== "number" || !Number.isSafeInteger(input.dndUntil))
		) {
			throw new Error(`${path}: dndUntil must be null or a timestamp`);
		}
		settings.dndUntil = input.dndUntil as number | null;
	}
	if (input.patterns !== undefined) {
		if (
			!input.patterns ||
			typeof input.patterns !== "object" ||
			Array.isArray(input.patterns)
		) {
			throw new Error(`${path}: patterns must be an object`);
		}
		settings.patterns = {};
		for (const [name, source] of Object.entries(input.patterns)) {
			if (!name.trim() || typeof source !== "string") {
				throw new Error(`${path}: pattern names and values must be strings`);
			}
			settings.patterns[name] = formatPattern(parsePattern(source));
		}
	}
	return settings;
}

function writeSettings(path: string, settings: StoredSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

export function createSettingsStore(): BlinkenlightsSettingsStore {
	const globalPath = join(getAgentDir(), "blinkenlights.json");
	let projectPath: string | undefined;
	let globalSettings: StoredSettings = {};
	let projectSettings: StoredSettings = {};
	let resolved = resolveSettings();

	const load = (ctx: ExtensionContext): ResolvedSettings => {
		projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "blinkenlights.json");
		const readScope = (path: string): StoredSettings => {
			try {
				return readSettings(path);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return {};
			}
		};
		globalSettings = readScope(globalPath);
		projectSettings = ctx.isProjectTrusted() ? readScope(projectPath) : {};

		try {
			resolved = resolveSettings(globalSettings, projectSettings);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			projectSettings = { ...projectSettings, activePattern: undefined };
			try {
				resolved = resolveSettings(globalSettings, projectSettings);
			} catch {
				globalSettings = { ...globalSettings, activePattern: undefined };
				resolved = resolveSettings(globalSettings, projectSettings);
			}
		}
		return resolved;
	};

	const chooseScope = async (
		ctx: ExtensionCommandContext,
	): Promise<Scope | undefined> => {
		if (!ctx.isProjectTrusted()) return "global";
		const choice = await ctx.ui.select("Save setting to", [
			"Project override",
			"Global default",
		]);
		if (choice === "Project override") return "project";
		if (choice === "Global default") return "global";
		return undefined;
	};

	const update = (
		ctx: ExtensionCommandContext,
		scope: Scope,
		mutate: (settings: StoredSettings) => void,
		onChange: (settings: ResolvedSettings) => void,
	): void => {
		const target = scope === "project" ? projectSettings : globalSettings;
		const path = scope === "project" ? projectPath : globalPath;
		if (!path) throw new Error("project settings path is unavailable");
		mutate(target);
		writeSettings(path, target);
		onChange(load(ctx));
	};

	const choosePattern = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
		preview?: PatternPreview,
	): Promise<void> => {
		const scope = await chooseScope(ctx);
		if (!scope) return;
		const available = scope === "global"
			? Object.fromEntries(
					Object.entries({ ...BUILTIN_PATTERNS, ...(globalSettings.patterns ?? {}) }).map(
						([name, source]) => [name, parsePattern(source)],
					),
				)
			: resolved.patterns;
		const names = Object.keys(available).sort((left, right) =>
			left.localeCompare(right),
		);
		const name = await selectPatternWithPreview(ctx, names, available, preview);
		if (!name) return;
		update(
			ctx,
			scope,
			(settings) => {
				settings.activePattern = name;
			},
			onChange,
		);
	};

	const changeTimeout = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
	): Promise<void> => {
		const input = await ctx.ui.input(
			"Maximum blink time in seconds",
			String(resolved.timeoutSeconds),
		);
		if (input === undefined) return;
		let seconds: number;
		try {
			seconds = parseTimeoutSeconds(input);
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
			return;
		}
		const scope = await chooseScope(ctx);
		if (!scope) return;
		update(
			ctx,
			scope,
			(settings) => {
				settings.timeoutSeconds = seconds;
			},
			onChange,
		);
	};

	const changePriority = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
	): Promise<void> => {
		const levels = new Map([
			["Urgent · 1", 1],
			["High · 5", 5],
			["Normal · 10", 10],
			["Low · 15", 15],
		]);
		const choice = await ctx.ui.select("Priority (lower wins)", [
			...levels.keys(),
			"Custom",
		]);
		if (!choice) return;
		let priority: number;
		try {
			const value = choice === "Custom"
				? await ctx.ui.input("Positive integer priority", String(resolved.priority))
				: levels.get(choice);
			if (value === undefined) return;
			priority = parsePriority(value);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		const scope = await chooseScope(ctx);
		if (!scope) return;
		update(ctx, scope, (settings) => {
			settings.priority = priority;
		}, onChange);
	};

	const changeEnabled = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
	): Promise<void> => {
		const choice = await ctx.ui.select("Blinkenlights default", ["Enabled", "Disabled"]);
		if (!choice) return;
		const scope = await chooseScope(ctx);
		if (!scope) return;
		update(ctx, scope, (settings) => {
			settings.enabled = choice === "Enabled";
		}, onChange);
	};

	const savePattern = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
	): Promise<void> => {
		const name = (await ctx.ui.input("Pattern name", "My pattern"))?.trim();
		if (!name) return;
		if (name.length > 60 || BUILTIN_PATTERNS[name]) {
			ctx.ui.notify("Use a unique name of at most 60 characters", "error");
			return;
		}

		const source = await ctx.ui.input(
			"Repeating phases",
			"on 120ms, off 80ms, on 120ms, off 700ms",
		);
		if (!source) return;
		let canonical: string;
		try {
			canonical = formatPattern(parsePattern(source));
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
			return;
		}

		const scope = await chooseScope(ctx);
		if (!scope) return;
		update(
			ctx,
			scope,
			(settings) => {
				settings.patterns ??= {};
				settings.patterns[name] = canonical;
				settings.activePattern = name;
			},
			onChange,
		);
	};

	const deletePattern = async (
		ctx: ExtensionCommandContext,
		onChange: (settings: ResolvedSettings) => void,
	): Promise<void> => {
		const scope = await chooseScope(ctx);
		if (!scope) return;
		const target = scope === "project" ? projectSettings : globalSettings;
		const names = Object.keys(target.patterns ?? {}).sort((left, right) =>
			left.localeCompare(right),
		);
		if (names.length === 0) {
			ctx.ui.notify(`No saved ${scope} patterns`, "info");
			return;
		}
		const name = await ctx.ui.select("Delete pattern", names);
		if (!name) return;
		if (scope === "global" && projectSettings.activePattern === name) {
			ctx.ui.notify("This pattern is selected by the project override", "error");
			return;
		}
		update(
			ctx,
			scope,
			(settings) => {
				const { [name]: _removed, ...remaining } = settings.patterns ?? {};
				settings.patterns = remaining;
				if (settings.activePattern === name) settings.activePattern = undefined;
			},
			onChange,
		);
	};

	return {
		current: () => resolved,
		load,
		async openMenu(ctx, onChange, preview) {
			onChange(load(ctx));
			while (true) {
				const actions = [
					`Enabled · ${resolved.enabled ? "on" : "off"}`,
					`Pattern · ${resolved.activePattern}`,
					`Timeout · ${resolved.timeoutSeconds}s`,
					`Priority · ${resolved.priority} (lower wins)`,
					"Save custom pattern",
					"Delete custom pattern",
				];
				if (ctx.isProjectTrusted() && projectPath && existsSync(projectPath)) {
					actions.push("Clear project overrides");
				}
				actions.push("Done");

				const action = await ctx.ui.select("Blinkenlights settings", actions);
				if (!action || action === "Done") return;
				if (action.startsWith("Enabled ·")) await changeEnabled(ctx, onChange);
				else if (action.startsWith("Pattern ·")) await choosePattern(ctx, onChange, preview);
				else if (action.startsWith("Timeout ·"))
					await changeTimeout(ctx, onChange);
				else if (action.startsWith("Priority ·"))
					await changePriority(ctx, onChange);
				else if (action === "Save custom pattern")
					await savePattern(ctx, onChange);
				else if (action === "Delete custom pattern")
					await deletePattern(ctx, onChange);
				else if (action === "Clear project overrides" && projectPath) {
					rmSync(projectPath, { force: true });
					onChange(load(ctx));
				}
			}
		},
		setDnd(ctx, scope, until, onChange) {
			update(ctx, scope, (settings) => {
				settings.dndUntil = until;
			}, onChange);
		},
	};
}
