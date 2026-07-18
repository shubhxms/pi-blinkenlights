import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  BUILTIN_PATTERNS,
  formatPattern,
  parsePattern,
  parseTimeoutSeconds,
  resolveSettings,
  type ResolvedSettings,
  type StoredSettings,
} from "./patterns.ts";

type Scope = "global" | "project";

export interface BlinkenlightsSettingsStore {
  current(): ResolvedSettings;
  load(ctx: ExtensionContext): ResolvedSettings;
  openMenu(
    ctx: ExtensionCommandContext,
    onChange: (settings: ResolvedSettings) => void,
  ): Promise<void>;
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
    if (typeof input.activePattern !== "string" || !input.activePattern.trim()) {
      throw new Error(`${path}: activePattern must be a non-empty string`);
    }
    settings.activePattern = input.activePattern;
  }
  if (input.timeoutSeconds !== undefined) {
    settings.timeoutSeconds = parseTimeoutSeconds(input.timeoutSeconds);
  }
  if (input.patterns !== undefined) {
    if (!input.patterns || typeof input.patterns !== "object" || Array.isArray(input.patterns)) {
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
    try {
      globalSettings = readSettings(globalPath);
      projectSettings = ctx.isProjectTrusted() ? readSettings(projectPath) : {};
      resolved = resolveSettings(globalSettings, projectSettings);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      globalSettings = {};
      projectSettings = {};
      resolved = resolveSettings();
    }
    return resolved;
  };

  const chooseScope = async (ctx: ExtensionCommandContext): Promise<Scope | undefined> => {
    if (!ctx.isProjectTrusted()) return "global";
    const choice = await ctx.ui.select("Save setting to", ["Project override", "Global default"]);
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
  ): Promise<void> => {
    const scope = await chooseScope(ctx);
    if (!scope) return;
    const available = scope === "global"
      ? { ...BUILTIN_PATTERNS, ...(globalSettings.patterns ?? {}) }
      : resolved.patterns;
    const names = Object.keys(available).sort((left, right) => left.localeCompare(right));
    const name = await ctx.ui.select("Blink pattern", names);
    if (!name) return;
    update(ctx, scope, (settings) => {
      settings.activePattern = name;
    }, onChange);
  };

  const changeTimeout = async (
    ctx: ExtensionCommandContext,
    onChange: (settings: ResolvedSettings) => void,
  ): Promise<void> => {
    const input = await ctx.ui.input("Maximum blink time in seconds", String(resolved.timeoutSeconds));
    if (input === undefined) return;
    let seconds: number;
    try {
      seconds = parseTimeoutSeconds(input);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    const scope = await chooseScope(ctx);
    if (!scope) return;
    update(ctx, scope, (settings) => {
      settings.timeoutSeconds = seconds;
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
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    const scope = await chooseScope(ctx);
    if (!scope) return;
    update(ctx, scope, (settings) => {
      settings.patterns ??= {};
      settings.patterns[name] = canonical;
      settings.activePattern = name;
    }, onChange);
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
    update(ctx, scope, (settings) => {
      const { [name]: _removed, ...remaining } = settings.patterns ?? {};
      settings.patterns = remaining;
      if (settings.activePattern === name) settings.activePattern = undefined;
    }, onChange);
  };

  return {
    current: () => resolved,
    load,
    async openMenu(ctx, onChange) {
      load(ctx);
      while (true) {
        const actions = [
          `Pattern · ${resolved.activePattern}`,
          `Timeout · ${resolved.timeoutSeconds}s`,
          "Save custom pattern",
          "Delete custom pattern",
        ];
        if (ctx.isProjectTrusted() && projectPath && existsSync(projectPath)) {
          actions.push("Clear project overrides");
        }
        actions.push("Done");

        const action = await ctx.ui.select("Blinkenlights settings", actions);
        if (!action || action === "Done") return;
        if (action.startsWith("Pattern ·")) await choosePattern(ctx, onChange);
        else if (action.startsWith("Timeout ·")) await changeTimeout(ctx, onChange);
        else if (action === "Save custom pattern") await savePattern(ctx, onChange);
        else if (action === "Delete custom pattern") await deletePattern(ctx, onChange);
        else if (action === "Clear project overrides" && projectPath) {
          rmSync(projectPath, { force: true });
          onChange(load(ctx));
        }
      }
    },
  };
}
