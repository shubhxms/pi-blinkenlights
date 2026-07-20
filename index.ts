import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CoordinatorClient } from "./coordinator-client.ts";
import { describeDnd, parseDndValue, type DndValue } from "./dnd.ts";
import type { ResolvedSettings } from "./patterns.ts";
import { createSettingsStore } from "./settings.ts";

export { parseDndValue } from "./dnd.ts";
export {
  parsePattern,
  parsePriority,
  parseTimeoutSeconds,
  renderWaveform,
  resolveSettings,
} from "./patterns.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const FOCUS_EVENTS_ON = "\x1b[?1004h";
const FOCUS_EVENTS_OFF = "\x1b[?1004l";
const WIDGET_ID = "blinkenlights-focus";
const INPUT_TOOL_NAMES = new Set(["ask_user_question", "question", "questionnaire"]);

type DndScope = "global" | "project";

async function chooseDnd(
  ctx: ExtensionCommandContext,
  args: string,
): Promise<{ scope: DndScope; until: DndValue } | undefined> {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  let scope: DndScope | undefined;
  if (tokens[0] === "global" || tokens[0] === "project") {
    scope = tokens.shift() as DndScope;
  } else {
    const scopes = ctx.isProjectTrusted() ? ["Global", "Project"] : ["Global"];
    const selected = await ctx.ui.select("DND scope", scopes);
    if (!selected) return undefined;
    scope = selected.toLowerCase() as DndScope;
  }
  if (scope === "project" && !ctx.isProjectTrusted()) {
    throw new Error("Project DND requires a trusted project");
  }
  if (tokens.length > 1) throw new Error("Usage: /blinkenlights:dnd [global|project] [off|forever|30m]");

  let value = tokens[0];
  if (!value) {
    const mode = await ctx.ui.select("DND mode", ["Indefinite", "Timed", "Off"]);
    if (!mode) return undefined;
    if (mode === "Timed") {
      const duration = await ctx.ui.input("Duration", "30m");
      if (!duration) return undefined;
      value = duration;
    } else value = mode === "Indefinite" ? "forever" : "off";
  }
  return { scope, until: parseDndValue(value) };
}

async function buildHelper(pi: ExtensionAPI): Promise<string> {
  const source = fileURLToPath(new URL("./blinkenlights.c", import.meta.url));
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const cacheDirectory = join(homedir(), "Library", "Caches", "pi-blinkenlights");
  const binary = join(cacheDirectory, `blinkenlights-${digest}`);
  if (existsSync(binary)) return binary;

  mkdirSync(cacheDirectory, { recursive: true });
  const temporaryBinary = `${binary}.${process.pid}.${randomUUID()}`;
  const result = await pi.exec(
    "xcrun",
    [
      "clang",
      "-std=c11",
      "-Os",
      "-Wall",
      "-Wextra",
      source,
      "-framework",
      "CoreFoundation",
      "-framework",
      "IOKit",
      "-o",
      temporaryBinary,
    ],
    { timeout: 30_000 },
  );

  if (result.code !== 0) {
    rmSync(temporaryBinary, { force: true });
    throw new Error(result.stderr.trim() || "xcrun clang failed");
  }

  renameSync(temporaryBinary, binary);
  chmodSync(binary, 0o755);
  return binary;
}

function installFocusTracking(ctx: ExtensionContext, acknowledge: () => void): () => void {
  let removeInputListener: (() => void) | undefined;
  ctx.ui.setWidget(WIDGET_ID, (tui) => {
    removeInputListener = tui.addInputListener((data: string) => {
      const focused = data.includes(FOCUS_IN);
      const remaining = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
      if (focused || remaining.length > 0) acknowledge();
      if (remaining.length === 0) return { consume: true };
      return { data: remaining };
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

export default function blinkenlights(pi: ExtensionAPI): void {
  const settingsStore = createSettingsStore();
  let settings: ResolvedSettings = settingsStore.current();
  let coordinator: CoordinatorClient | undefined;
  let removeFocusTracking: (() => void) | undefined;
  let sessionGeneration = 0;
  let notifyError: (message: string) => void = () => {};
  let pendingAlert = false;

  const acknowledge = (): void => {
    coordinator?.acknowledge();
    pendingAlert = false;
  };
  const publishAlert = async (): Promise<void> => {
    const client = coordinator;
    if (!client) {
      pendingAlert = true;
      return;
    }
    if (!settings.enabled) {
      client.acknowledge();
      pendingAlert = false;
      return;
    }
    pendingAlert = false;
    try {
      await client.alert(settings);
    } catch (error) {
      if (client === coordinator) {
        notifyError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  pi.registerCommand("blinkenlights", {
    description: "Configure blink patterns, timeout, and priority",
    handler: async (_args, ctx) => {
      acknowledge();
      try {
        await settingsStore.openMenu(
          ctx,
          (next) => {
            acknowledge();
            settings = next;
          },
          {
            start: (phases) => coordinator?.preview(phases),
            stop: () => coordinator?.stopPreview(),
          },
        );
      } finally {
        coordinator?.stopPreview();
      }
    },
  });

  pi.registerCommand("blinkenlights:dnd", {
    description: "Set global or project Do Not Disturb",
    handler: async (args, ctx) => {
      try {
        const selection = await chooseDnd(ctx, args);
        if (!selection) return;
        settingsStore.setDnd(ctx, selection.scope, selection.until, (next) => {
          acknowledge();
          settings = next;
        });
        await coordinator?.setDnd(selection.scope, selection.until);
        ctx.ui.notify(
          `${selection.scope} DND: ${describeDnd(selection.until)}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++sessionGeneration;
    acknowledge();
    coordinator?.close();
    coordinator = undefined;
    removeFocusTracking?.();
    removeFocusTracking = undefined;
    notifyError = (message) => ctx.ui.notify(message, "error");
    settings = settingsStore.load(ctx);
    if (process.platform !== "darwin" || ctx.mode !== "tui") return;

    let client: CoordinatorClient | undefined;
    try {
      const helper = await buildHelper(pi);
      if (generation !== sessionGeneration) return;
      client = new CoordinatorClient(helper, ctx.cwd, notifyError);
      await client.connect();
      await client.syncDnd(settings);
      if (generation !== sessionGeneration) {
        client.close();
        return;
      }
      coordinator = client;
      if (pendingAlert) {
        pendingAlert = false;
        void publishAlert();
      }
    } catch (error) {
      client?.close();
      if (generation === sessionGeneration) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    }

    removeFocusTracking = installFocusTracking(ctx, acknowledge);
  });

  pi.on("agent_start", acknowledge);
  pi.on("input", acknowledge);
  pi.on("agent_settled", publishAlert);
  pi.on("tool_execution_start", async (event) => {
    if (INPUT_TOOL_NAMES.has(event.toolName)) await publishAlert();
  });
  pi.on("tool_execution_end", (event) => {
    if (INPUT_TOOL_NAMES.has(event.toolName)) acknowledge();
  });

  pi.on("session_shutdown", () => {
    sessionGeneration++;
    acknowledge();
    coordinator?.close();
    coordinator = undefined;
    removeFocusTracking?.();
    removeFocusTracking = undefined;
  });
}
