import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 604_800;
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const FOCUS_EVENTS_ON = "\x1b[?1004h";
const FOCUS_EVENTS_OFF = "\x1b[?1004l";
const WIDGET_ID = "caps-lock-blinker-focus";
const INPUT_TOOL_NAMES = new Set(["ask_user_question", "question", "questionnaire"]);

interface BlinkChild {
  stdin: { end(): void } | null;
  once(event: "exit", listener: (...args: unknown[]) => void): unknown;
}

export function parseTimeoutSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("timeout must be a whole number of seconds");

  const seconds = Number(text);
  if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

export class BlinkController {
  private child: BlinkChild | undefined;
  private readonly launch: (timeoutSeconds: number) => BlinkChild;

  constructor(launch: (timeoutSeconds: number) => BlinkChild) {
    this.launch = launch;
  }
  get isRunning(): boolean {
    return this.child !== undefined;
  }

  start(timeoutSeconds: number): void {
    if (this.child) return;
    const child = this.launch(timeoutSeconds);
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
  const source = fileURLToPath(new URL("./caps-led.c", import.meta.url));
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const cacheDirectory = join(homedir(), "Library", "Caches", "pi-caps-lock-blinker");
  const binary = join(cacheDirectory, `caps-led-${digest}`);
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

export default function capsLockBlinker(pi: ExtensionAPI): void {
  pi.registerFlag("caps-blink-timeout", {
    description: "Maximum Caps Lock LED blink time in seconds",
    type: "string",
    default: process.env.PI_CAPS_BLINK_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS),
  });

  let helper: string | undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let removeInputListener: (() => void) | undefined;
  let reportedHelperFailure = false;
  let notifyError: (message: string) => void = () => {};

  const controller = new BlinkController((timeout) => {
    if (!helper) throw new Error("Caps Lock LED helper is unavailable");

    const child = spawn(helper, [String(timeout)], {
      stdio: ["pipe", "ignore", "pipe"],
    });
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
          : stderr.trim() || `Caps Lock LED helper exited with code ${code}`;
        notifyError(reason);
      }
    });
    return child as ChildProcess & BlinkChild;
  });

  const stop = (): void => controller.stop();
  const start = (): void => {
    if (!helper) return;
    try {
      controller.start(timeoutSeconds);
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    notifyError = (message) => ctx.ui.notify(message, "error");
    if (process.platform !== "darwin" || ctx.mode !== "tui") return;

    try {
      timeoutSeconds = parseTimeoutSeconds(pi.getFlag("caps-blink-timeout"));
      helper = await buildHelper(pi);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, (tui) => {
      removeInputListener?.();
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

  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    removeInputListener?.();
    removeInputListener = undefined;
    if (process.platform === "darwin" && ctx.mode === "tui") {
      process.stdout.write(FOCUS_EVENTS_OFF);
      ctx.ui.setWidget(WIDGET_ID, undefined);
    }
  });
}
