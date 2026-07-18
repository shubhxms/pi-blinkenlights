import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Phase, type ResolvedSettings } from "./patterns.ts";
import { createSettingsStore } from "./settings.ts";

export { parsePattern, parseTimeoutSeconds, resolveSettings } from "./patterns.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const FOCUS_EVENTS_ON = "\x1b[?1004h";
const FOCUS_EVENTS_OFF = "\x1b[?1004l";
const WIDGET_ID = "blinkenlights-focus";
const INPUT_TOOL_NAMES = new Set(["ask_user_question", "question", "questionnaire"]);

interface BlinkChild {
  stdin: { end(): void } | null;
  once(event: "exit", listener: (...args: unknown[]) => void): unknown;
}

export class BlinkController {
  private child: BlinkChild | undefined;
  private readonly launch: (timeoutSeconds: number, phases: Phase[]) => BlinkChild;

  constructor(launch: (timeoutSeconds: number, phases: Phase[]) => BlinkChild) {
    this.launch = launch;
  }

  get isRunning(): boolean {
    return this.child !== undefined;
  }

  start(timeoutSeconds: number, phases: Phase[]): void {
    if (this.child) return;
    const child = this.launch(timeoutSeconds, phases);
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
    });
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin?.end();
  }
}

async function buildHelper(pi: ExtensionAPI): Promise<string> {
  const source = fileURLToPath(new URL("./blinkenlights.c", import.meta.url));
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const cacheDirectory = join(homedir(), "Library", "Caches", "pi-blinkenlights");
  const binary = join(cacheDirectory, `blinkenlights-${digest}`);
  if (existsSync(binary)) return binary;

  mkdirSync(cacheDirectory, { recursive: true });
  const temporaryBinary = `${binary}.${process.pid}`;
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

function installFocusTracking(ctx: ExtensionContext, stop: () => void): () => void {
  let removeInputListener: (() => void) | undefined;
  ctx.ui.setWidget(WIDGET_ID, (tui) => {
    removeInputListener = tui.addInputListener((data: string) => {
      const focused = data.includes(FOCUS_IN);
      const remaining = data.replaceAll(FOCUS_IN, "").replaceAll(FOCUS_OUT, "");
      if (focused || remaining.length > 0) stop();
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
  let helper: string | undefined;
  let removeFocusTracking: (() => void) | undefined;
  let reportedHelperFailure = false;
  let notifyError: (message: string) => void = () => {};

  const controller = new BlinkController((timeout, phases) => {
    if (!helper) throw new Error("Blinkenlights helper is unavailable");
    const args = [
      String(timeout),
      ...phases.map((phase) => `${phase.on ? 1 : 0}:${phase.durationMs}`),
    ];
    const child = spawn(helper, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => notifyError(error.message));
    child.once("exit", (code) => {
      if (code && !reportedHelperFailure) {
        reportedHelperFailure = true;
        const reason = code === 2
          ? "No writable Caps Lock LED found; macOS may require Input Monitoring permission"
          : stderr.trim() || `Blinkenlights helper exited with code ${code}`;
        notifyError(reason);
      }
    });
    return child as ChildProcess & BlinkChild;
  });

  const stop = (): void => controller.stop();
  const start = (): void => {
    if (!helper) return;
    const pattern = settings.patterns[settings.activePattern];
    if (!pattern) {
      notifyError(`Unknown blink pattern: ${settings.activePattern}`);
      return;
    }
    try {
      controller.start(settings.timeoutSeconds, pattern);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error));
    }
  };

  pi.registerCommand("blinkenlights", {
    description: "Configure blink patterns and timeout",
    handler: async (_args, ctx) => {
      stop();
      await settingsStore.openMenu(ctx, (next) => {
        stop();
        settings = next;
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stop();
    notifyError = (message) => ctx.ui.notify(message, "error");
    settings = settingsStore.load(ctx);
    if (process.platform !== "darwin" || ctx.mode !== "tui") return;

    try {
      helper = await buildHelper(pi);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    removeFocusTracking?.();
    removeFocusTracking = installFocusTracking(ctx, stop);
  });

  pi.on("agent_start", stop);
  pi.on("input", stop);
  pi.on("agent_settled", start);
  pi.on("tool_execution_start", (event) => {
    if (INPUT_TOOL_NAMES.has(event.toolName)) start();
  });
  pi.on("tool_execution_end", (event) => {
    if (INPUT_TOOL_NAMES.has(event.toolName)) stop();
  });

  pi.on("session_shutdown", () => {
    stop();
    removeFocusTracking?.();
    removeFocusTracking = undefined;
  });
}
