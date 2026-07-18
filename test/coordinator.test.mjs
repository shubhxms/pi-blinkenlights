import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const coordinatorPath = fileURLToPath(
	new URL("../coordinator.mjs", import.meta.url),
);
const phases = [
	{ on: true, durationMs: 100 },
	{ on: false, durationMs: 100 },
];

async function waitFor(check, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const value = check();
			if (value) return value;
		} catch {
			// The coordinator or its log may not exist yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for coordinator");
}

function connectClient(socketPath, clientId) {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.includes('"type":"ready"')) resolve(socket);
		});
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ type: "hello", clientId })}\n`);
		});
	});
}

function send(socket, message) {
	socket.write(`${JSON.stringify(message)}\n`);
}

test("coordinator preempts and restores alerts across clients", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "blinkenlights-test-"));
	const socketPath = join(directory, "coordinator.sock");
	const helperPath = join(directory, "fake-helper.mjs");
	const logPath = join(directory, "workers.log");
	writeFileSync(
		helperPath,
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.BLINKENLIGHTS_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst timer = setTimeout(() => process.exit(0), Number(process.argv[2]));\nprocess.stdin.resume();\nprocess.stdin.on("end", () => { clearTimeout(timer); process.exit(0); });\n`,
	);
	chmodSync(helperPath, 0o755);

	const daemon = spawn(
		process.execPath,
		[coordinatorPath, socketPath, helperPath],
		{
			env: { ...process.env, BLINKENLIGHTS_TEST_LOG: logPath },
			stdio: "ignore",
		},
	);
	t.after(() => {
		daemon.kill("SIGTERM");
		rmSync(directory, { recursive: true, force: true });
	});

	await waitFor(() => existsSync(socketPath));
	const first = await connectClient(socketPath, "first");
	const urgent = await connectClient(socketPath, "urgent");
	t.after(() => {
		first.destroy();
		urgent.destroy();
	});

	send(first, {
		type: "alert",
		request: { priority: 10, timeoutMs: 5_000, projectKey: "/first", phases },
	});
	await waitFor(
		() => readFileSync(logPath, "utf8").trim().split("\n").length >= 1,
	);

	send(urgent, {
		type: "alert",
		request: { priority: 1, timeoutMs: 5_000, projectKey: "/urgent", phases },
	});
	await waitFor(
		() => readFileSync(logPath, "utf8").trim().split("\n").length >= 2,
	);

	send(urgent, { type: "ack" });
	const lines = await waitFor(() => {
		const entries = readFileSync(logPath, "utf8").trim().split("\n");
		return entries.length >= 3 ? entries : undefined;
	});
	let restoredArgs;
	try {
		restoredArgs = JSON.parse(lines[2]);
	} catch (error) {
		assert.fail(error instanceof Error ? error.message : String(error));
	}
	assert.ok(Number(restoredArgs[0]) > 0 && Number(restoredArgs[0]) < 5_000);
	assert.deepEqual(restoredArgs.slice(1), ["1:100", "0:100"]);

	send(urgent, {
		type: "preview",
		phases: [
			{ on: true, durationMs: 50 },
			{ on: false, durationMs: 150 },
		],
	});
	await waitFor(
		() => readFileSync(logPath, "utf8").trim().split("\n").length >= 4,
	);
	send(urgent, { type: "previewStop" });
	const previewLines = await waitFor(() => {
		const entries = readFileSync(logPath, "utf8").trim().split("\n");
		return entries.length >= 5 ? entries : undefined;
	});
	assert.match(previewLines[3], /"1:50","0:150"/);
	assert.match(previewLines[4], /"1:100","0:100"/);

	send(urgent, { type: "dnd", scope: "global", until: null });
	send(first, {
		type: "alert",
		request: { priority: 10, timeoutMs: 5_000, projectKey: "/first", phases },
	});
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 5);

	send(urgent, { type: "dndOff", scope: "global" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	send(first, {
		type: "alert",
		request: { priority: 10, timeoutMs: 5_000, projectKey: "/first", phases },
	});
	await waitFor(() => readFileSync(logPath, "utf8").trim().split("\n").length >= 6);
});
