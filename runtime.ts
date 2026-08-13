import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { CoordinatorClient } from "./coordinator-client.ts";
import { describeDnd, parseDndValue, type DndValue } from "./dnd.ts";
import { installFocusTracking } from "./focus-tracking.ts";
import {
	buildHelper,
	buildHotkeyHelper,
	focusMetadata,
} from "./native-helpers.ts";
import type { ResolvedSettings } from "./patterns.ts";
import { createSettingsStore } from "./settings.ts";
import {
	isTerminalApplicationFrontmost,
	shouldSuppressForFocus,
} from "./terminal-focus.ts";

const INPUT_TOOL_NAMES = new Set([
	"ask_user_question",
	"question",
	"questionnaire",
]);
const FOCUS_POLL_INTERVAL_MS = 500;

type DndScope = "global" | "project";

export function shouldBlink(
	enabled: boolean,
	suppressWhenFocused: boolean,
	reportedFocused: boolean,
	applicationFrontmost: boolean | undefined,
): boolean {
	return (
		enabled &&
		(!suppressWhenFocused ||
			!shouldSuppressForFocus(reportedFocused, applicationFrontmost))
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function chooseDndValue(
	ctx: ExtensionCommandContext,
	value: string | undefined,
): Promise<string | undefined> {
	if (value) return value;

	const mode = await ctx.ui.select("DND mode", ["Indefinite", "Timed", "Off"]);
	if (!mode) return undefined;
	if (mode === "Indefinite") return "forever";
	if (mode === "Off") return "off";
	return ctx.ui.input("Duration", "30m");
}

async function chooseDnd(
	ctx: ExtensionCommandContext,
	args: string,
): Promise<{ scope: DndScope; until: DndValue } | undefined> {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	let scope: DndScope | undefined;
	if (tokens[0] === "global" || tokens[0] === "project") {
		scope = tokens.shift() as DndScope;
	} else {
		const selected = await ctx.ui.select(
			"DND scope",
			ctx.isProjectTrusted() ? ["Global", "Project"] : ["Global"],
		);
		if (!selected) return undefined;
		scope = selected.toLowerCase() as DndScope;
	}

	if (scope === "project" && !ctx.isProjectTrusted()) {
		throw new Error("Project DND requires a trusted project");
	}
	if (tokens.length > 1) {
		throw new Error(
			"Usage: /blinkenlights:dnd [global|project] [off|forever|30m]",
		);
	}

	const value = await chooseDndValue(ctx, tokens[0]);
	return value ? { scope, until: parseDndValue(value) } : undefined;
}

export class BlinkenlightsRuntime {
	private readonly settingsStore = createSettingsStore();
	private settings: ResolvedSettings = this.settingsStore.current();
	private coordinator: CoordinatorClient | undefined;
	private removeFocusTracking: (() => void) | undefined;
	private generation = 0;
	private reportError: (message: string) => void = () => {};
	private pendingAlert = false;
	private windowFocused = false;
	private focusPollTimer: ReturnType<typeof setInterval> | undefined;
	private focusPollExpiry: ReturnType<typeof setTimeout> | undefined;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.registerCommands();
		this.pi.on("session_start", async (_event, ctx) => this.startSession(ctx));
		this.pi.on("agent_start", () => this.acknowledge());
		this.pi.on("input", () => this.acknowledge());
		this.pi.on("agent_settled", async () => this.publishAlert());
		this.pi.on("tool_execution_start", async (event) => {
			if (INPUT_TOOL_NAMES.has(event.toolName)) await this.publishAlert();
		});
		this.pi.on("tool_execution_end", (event) => {
			if (INPUT_TOOL_NAMES.has(event.toolName)) this.acknowledge();
		});
		this.pi.on("session_shutdown", () => this.closeSession());
	}

	private registerCommands(): void {
		this.pi.registerCommand("blinkenlights", {
			description: "Configure blink patterns, timeout, and priority",
			handler: async (_args, ctx) => {
				this.acknowledge();
				try {
					await this.settingsStore.openMenu(
						ctx,
						(settings) => this.updateSettings(settings),
						{
							start: (phases) => this.coordinator?.preview(phases),
							stop: () => this.coordinator?.stopPreview(),
						},
					);
				} finally {
					this.coordinator?.stopPreview();
				}
			},
		});

		this.pi.registerCommand("blinkenlights:focus", {
			description:
				"Focus the terminal session with the active Blinkenlights alert",
			handler: async (_args, ctx) => {
				try {
					if (!this.coordinator) {
						ctx.ui.notify(
							"Blinkenlights coordinator is not connected",
							"error",
						);
						return;
					}
					await this.coordinator.focus(this.settings);
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});

		this.pi.registerCommand("blinkenlights:dnd", {
			description: "Set global or project Do Not Disturb",
			handler: async (args, ctx) => {
				try {
					const selection = await chooseDnd(ctx, args);
					if (!selection) return;
					this.settingsStore.setDnd(
						ctx,
						selection.scope,
						selection.until,
						(settings) => {
							this.acknowledge();
							this.settings = settings;
						},
					);
					await this.coordinator?.setDnd(selection.scope, selection.until);
					ctx.ui.notify(
						`${selection.scope} DND: ${describeDnd(selection.until)}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
			},
		});
	}

	private updateSettings(settings: ResolvedSettings): void {
		this.acknowledge();
		this.settings = settings;
		void this.coordinator?.configure(settings).catch((error) => {
			this.reportError(errorMessage(error));
		});
	}

	private async startSession(ctx: ExtensionContext): Promise<void> {
		this.closeSession();
		const generation = this.generation;
		this.reportError = (message) => ctx.ui.notify(message, "error");
		this.settings = this.settingsStore.load(ctx);
		if (process.platform !== "darwin" || ctx.mode !== "tui") return;

		let client: CoordinatorClient | undefined;
		try {
			const helper = await buildHelper(this.pi);
			const hotkeyHelper = await this.tryBuildHotkeyHelper(ctx);
			if (generation !== this.generation) return;

			client = new CoordinatorClient(
				helper,
				ctx.cwd,
				this.reportError,
				undefined,
				hotkeyHelper,
				focusMetadata(ctx),
			);
			await client.connect();
			await client.syncDnd(this.settings);
			if (generation !== this.generation) {
				client.close();
				return;
			}

			this.coordinator = client;
			await client.configure(this.settings);
			if (this.pendingAlert) {
				this.pendingAlert = false;
				void this.publishAlert();
			}
		} catch (error) {
			client?.close();
			if (generation === this.generation) this.reportError(errorMessage(error));
			return;
		}

		this.removeFocusTracking = installFocusTracking(ctx, (focused) => {
			this.windowFocused = focused;
			if (focused) this.acknowledge();
		});
	}

	private async tryBuildHotkeyHelper(
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		try {
			return await buildHotkeyHelper(this.pi);
		} catch (error) {
			ctx.ui.notify(
				`Blinkenlights focus hotkey unavailable: ${errorMessage(error)}`,
				"error",
			);
			return undefined;
		}
	}

	private closeSession(): void {
		this.generation++;
		this.acknowledge();
		this.coordinator?.close();
		this.coordinator = undefined;
		this.removeFocusTracking?.();
		this.removeFocusTracking = undefined;
		this.windowFocused = false;
	}

	private acknowledge(): void {
		this.coordinator?.acknowledge();
		this.pendingAlert = false;
		this.stopFocusPolling();
	}

	private async publishAlert(): Promise<void> {
		const client = this.coordinator;
		if (!client) {
			this.pendingAlert = true;
			return;
		}

		const applicationFrontmost = this.windowFocused
			? isTerminalApplicationFrontmost()
			: undefined;
		if (
			!shouldBlink(
				this.settings.enabled,
				this.settings.suppressWhenFocused,
				this.windowFocused,
				applicationFrontmost,
			)
		) {
			client.acknowledge();
			this.pendingAlert = false;
			return;
		}

		this.pendingAlert = false;
		try {
			await client.alert(this.settings);
			if (client === this.coordinator) this.startFocusPolling();
		} catch (error) {
			if (client === this.coordinator) this.reportError(errorMessage(error));
		}
	}

	private startFocusPolling(): void {
		this.stopFocusPolling();
		this.focusPollTimer = setInterval(() => {
			if (isTerminalApplicationFrontmost() === true) this.acknowledge();
		}, FOCUS_POLL_INTERVAL_MS);
		this.focusPollTimer.unref();
		this.focusPollExpiry = setTimeout(
			() => this.stopFocusPolling(),
			this.settings.timeoutSeconds * 1_000,
		);
		this.focusPollExpiry.unref();
	}

	private stopFocusPolling(): void {
		if (this.focusPollTimer) clearInterval(this.focusPollTimer);
		if (this.focusPollExpiry) clearTimeout(this.focusPollExpiry);
		this.focusPollTimer = undefined;
		this.focusPollExpiry = undefined;
	}
}
