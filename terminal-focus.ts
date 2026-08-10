import { spawnSync } from "node:child_process";

const LSAPPINFO = "/usr/bin/lsappinfo";

export function matchesTerminalApplication(
  termProgram: string | undefined,
  frontmostInfo: string,
): boolean | undefined {
  const terminal = (termProgram ?? "").toLowerCase();
  const application = frontmostInfo.toLowerCase();

  if (terminal.includes("ghostty")) {
    return application.includes("ghostty");
  }
  if (terminal.includes("iterm")) {
    return application.includes("com.googlecode.iterm2") || application.includes("iterm");
  }
  if (terminal.includes("apple_terminal")) {
    return application.includes("com.apple.terminal");
  }
  return undefined;
}

export function isTerminalApplicationFrontmost(
  termProgram = process.env.TERM_PROGRAM,
): boolean | undefined {
  const front = spawnSync(LSAPPINFO, ["front"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  const applicationId = front.stdout.trim();
  if (front.status !== 0 || !applicationId) return undefined;

  const info = spawnSync(
    LSAPPINFO,
    ["info", "-only", "name,bundleid", applicationId],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    },
  );
  if (info.status !== 0 || !info.stdout.trim()) return undefined;
  return matchesTerminalApplication(termProgram, info.stdout);
}
