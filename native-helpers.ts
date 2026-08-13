import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FocusMetadata } from "./coordinator-client.ts";

async function buildNativeHelper(
	pi: ExtensionAPI,
	sourceName: string,
	binaryPrefix: string,
	frameworks: string[],
): Promise<string> {
	const source = fileURLToPath(new URL(`./${sourceName}`, import.meta.url));
	const digest = createHash("sha256")
		.update(readFileSync(source))
		.digest("hex")
		.slice(0, 16);
	const cacheDirectory = join(
		homedir(),
		"Library",
		"Caches",
		"pi-blinkenlights",
	);
	const binary = join(cacheDirectory, `${binaryPrefix}-${digest}`);
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
			...frameworks.flatMap((framework) => ["-framework", framework]),
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

export function buildHelper(pi: ExtensionAPI): Promise<string> {
	return buildNativeHelper(pi, "blinkenlights.c", "blinkenlights", [
		"CoreFoundation",
		"IOKit",
	]);
}

export function buildHotkeyHelper(pi: ExtensionAPI): Promise<string> {
	return buildNativeHelper(
		pi,
		"blinkenlights-hotkey.c",
		"blinkenlights-hotkey",
		["ApplicationServices", "CoreFoundation"],
	);
}

function currentTty(): string | undefined {
	for (const fd of [0, 1, 2]) {
		try {
			const target = readlinkSync(`/dev/fd/${fd}`);
			if (target.startsWith("/dev/tty")) return target;
		} catch {
			// Best effort only.
		}
	}

	try {
		const result = spawnSync(
			"lsof",
			["-a", "-p", String(process.pid), "-d", "0,1,2", "-Fn"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		if (result.status === 0) {
			return result.stdout
				.split("\n")
				.map((line) => line.slice(1))
				.find((line) => line.startsWith("/dev/tty"));
		}
	} catch {
		// Best effort only.
	}
	return undefined;
}

export function focusMetadata(ctx: ExtensionContext): FocusMetadata {
	return {
		pid: process.pid,
		cwd: ctx.cwd,
		tty: currentTty(),
		tmux: process.env.TMUX,
		tmuxPane: process.env.TMUX_PANE,
		termProgram: process.env.TERM_PROGRAM,
	};
}
