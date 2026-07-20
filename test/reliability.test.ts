import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoordinatorClient } from "../coordinator-client.ts";
import { resolveSettings } from "../patterns.ts";

const settings = resolveSettings();

function makeHelper(logPath: string): string {
	const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const timer = setTimeout(() => process.exit(0), Number(process.argv[2]));
process.stdin.resume();
process.stdin.on("end", () => { clearTimeout(timer); process.exit(0); });
`;
	writeFileSync(logPath, "");
	const helperPath = join(logPath, "..", "helper.mjs");
	writeFileSync(helperPath, script);
	chmodSync(helperPath, 0o755);
	return helperPath;
}

async function waitFor<T>(check: () => T, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const value = check();
			if (value) return value;
		} catch {
			// log/socket may not exist yet
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for coordinator");
}

function logLines(logPath: string): number {
	try {
		return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function holderPid(lockPath: string): number | undefined {
	try {
		return Number(readFileSync(lockPath, "utf8"));
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("client reconnects after the daemon dies mid-session", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "blink-rel-live-"));
	const socketPath = join(directory, "coordinator.sock");
	const lockPath = `${socketPath}.lock`;
	const logPath = join(directory, "workers.log");
	const helperPath = makeHelper(logPath);
	t.after(() => rmSync(directory, { recursive: true, force: true }));

	const client = new CoordinatorClient(helperPath, "/proj", () => {}, socketPath);
	await client.connect();
	await client.alert(settings);
	await waitFor(() => logLines(logPath) >= 1);

	// Simulate the daemon crashing while the session is alive.
	const deadPid = Number(readFileSync(lockPath, "utf8"));
	process.kill(deadPid, "SIGKILL");

	// The client notices the dead socket and proactively respawns + reconnects.
	await waitFor(() => {
		const next = holderPid(lockPath);
	return typeof next === "number" && next !== deadPid && isAlive(next);
	});

	await client.alert(settings);
	await waitFor(() => logLines(logPath) >= 2);

	client.close();
});

test("client recovers when its first daemon spawn loses the lock race", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "blink-rel-race-"));
	const socketPath = join(directory, "coordinator.sock");
	const lockPath = `${socketPath}.lock`;
	const logPath = join(directory, "workers.log");
	const helperPath = makeHelper(logPath);
	t.after(() => rmSync(directory, { recursive: true, force: true }));

	// Hold the coordinator lock with a live, unrelated process. Any daemon the
	// client spawns will see this pid alive, yield, and exit 0 — exactly what
	// happens when another daemon is mid-shutdown and still owns the lock.
	const blocker = spawn(process.execPath, [
		"-e",
		"setTimeout(() => {}, 60000)",
	]);
	t.after(() => blocker.kill("SIGKILL"));
	writeFileSync(lockPath, String(blocker.pid));

	const client = new CoordinatorClient(helperPath, "/proj", () => {}, socketPath);
	const connecting = client.connect();

	// Let the client fail a few connect attempts, each spawn losing the race.
	await new Promise((resolve) => setTimeout(resolve, 600));
	blocker.kill("SIGKILL"); // release the lock

	// With respawn-on-retry, the client eventually spawns a winning daemon.
	await connecting;
	assert.ok(!existsSync(`${socketPath}.stale`));

	await client.alert(settings);
	await waitFor(() => logLines(logPath) >= 1);

	client.close();
});
