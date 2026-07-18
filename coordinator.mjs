import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

import { Scheduler } from "./scheduler.mjs";

const [socketPath, helperPath] = process.argv.slice(2);
if (!socketPath || !helperPath) process.exit(64);
const lockPath = `${socketPath}.lock`;

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(socketPath), 0o700);

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function acquireLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const descriptor = openSync(lockPath, "wx", 0o600);
			writeFileSync(descriptor, String(process.pid));
			closeSync(descriptor);
			return true;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const pid = Number(readFileSync(lockPath, "utf8"));
			if (Number.isInteger(pid) && processExists(pid)) return false;
			rmSync(lockPath, { force: true });
		}
	}
	return false;
}

if (!acquireLock()) process.exit(0);
rmSync(socketPath, { force: true });

const scheduler = new Scheduler();
const connections = new Set();
const clientConnections = new Map();
let desiredSelection;
let worker;
let applying = false;
let shuttingDown = false;
let idleTimer;
let hadClient = false;

function selectionKey(selection) {
	return selection
		? `${selection.kind}:${selection.clientId}:${selection.revision}`
		: undefined;
}

function broadcast(message) {
	const encoded = `${JSON.stringify(message)}\n`;
	for (const socket of connections) {
		if (!socket.destroyed) socket.write(encoded);
	}
}

async function forceLedOff() {
	await new Promise((resolve) => {
		const child = spawn(helperPath, ["20", "0:20", "1:20"], { stdio: "ignore" });
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish();
		}, 500);
		timer.unref();
		child.once("close", finish);
		child.once("error", finish);
	});
}

async function stopWorker() {
	const active = worker;
	worker = undefined;
	if (!active) return;
	let forced = false;
	await new Promise((resolve) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(terminateTimer);
			clearTimeout(killTimer);
			clearTimeout(giveUpTimer);
			resolve();
		};
		const terminateTimer = setTimeout(() => active.child.kill("SIGTERM"), 500);
		const killTimer = setTimeout(() => {
			forced = true;
			active.child.kill("SIGKILL");
		}, 1_000);
		const giveUpTimer = setTimeout(finish, 1_500);
		terminateTimer.unref();
		killTimer.unref();
		giveUpTimer.unref();
		active.child.once("close", finish);
		active.child.stdin?.end();
	});
	if (forced) await forceLedOff();
}

function startWorker(selection) {
	const timeoutMs =
		selection.kind === "preview" ? 604_800_000 : selection.remainingMs;
	const args = [
		String(Math.max(1, Math.floor(timeoutMs))),
		...selection.phases.map(
			(phase) => `${phase.on ? 1 : 0}:${phase.durationMs}`,
		),
	];
	const child = spawn(helperPath, args, { stdio: ["pipe", "ignore", "pipe"] });
	const active = { child, key: selectionKey(selection), selection, stderr: "" };
	worker = active;
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		active.stderr += chunk;
	});
	child.on("error", (error) => {
		active.stderr ||= error.message;
	});
	child.on("close", (code) => {
		if (worker !== active) return;
		worker = undefined;
		if (code && !shuttingDown) {
			broadcast({
				type: "error",
				message:
					code === 2
						? "No writable Caps Lock LED found; macOS may require Input Monitoring permission"
						: active.stderr.trim() ||
							`Blinkenlights helper exited with code ${code}`,
			});
		}
		desiredSelection =
			selection.kind === "alert"
				? scheduler.acknowledge(selection.clientId)
				: scheduler.clearPreview(selection.clientId);
		void applySelection();
	});
}

async function applySelection() {
	if (applying) return;
	applying = true;
	try {
		while (selectionKey(desiredSelection) !== worker?.key) {
			await stopWorker();
			const target = desiredSelection;
			if (target) startWorker(target);
		}
	} finally {
		applying = false;
		if (selectionKey(desiredSelection) !== worker?.key) void applySelection();
	}
}

function reconcile(selection = scheduler.refresh()) {
	desiredSelection = selection;
	void applySelection();
}

function handleMessage(socket, message) {
	if (!message || typeof message !== "object")
		throw new Error("invalid message");
	if (message.type === "hello") {
		if (
			socket.clientId ||
			typeof message.clientId !== "string" ||
			message.clientId.length < 1 ||
			message.clientId.length > 128 ||
			clientConnections.has(message.clientId)
		) {
			throw new Error("invalid or duplicate client id");
		}
		socket.clientId = message.clientId;
		clientConnections.set(message.clientId, socket);
		socket.write(`${JSON.stringify({ type: "ready" })}\n`);
		return;
	}

	if (!socket.clientId) throw new Error("hello required");
	if (message.type === "alert") {
		reconcile(scheduler.upsertAlert(socket.clientId, message.request));
	} else if (message.type === "ack") {
		reconcile(scheduler.acknowledge(socket.clientId));
	} else if (message.type === "preview") {
		reconcile(scheduler.setPreview(socket.clientId, message.phases));
	} else if (message.type === "previewStop") {
		reconcile(scheduler.clearPreview(socket.clientId));
	} else if (message.type === "dnd") {
		reconcile(scheduler.setDnd(message.scope, message.projectKey, message.until));
	} else if (message.type === "dndOff") {
		reconcile(scheduler.clearDnd(message.scope, message.projectKey));
	} else {
		throw new Error(`unknown message type: ${message.type}`);
	}
}

const server = createServer((socket) => {
	hadClient = true;
	clearTimeout(idleTimer);
	connections.add(socket);
	socket.setEncoding("utf8");
	let buffer = "";

	socket.on("data", (chunk) => {
		buffer += chunk;
		if (buffer.length > 1_000_000) return socket.destroy();
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			try {
				handleMessage(socket, JSON.parse(line));
			} catch (error) {
				socket.write(
					`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`,
				);
			}
		}
	});

	socket.on("close", () => {
		connections.delete(socket);
		if (socket.clientId) {
			clientConnections.delete(socket.clientId);
			reconcile(scheduler.removeClient(socket.clientId));
		}
		if (hadClient && connections.size === 0) {
			idleTimer = setTimeout(() => void shutdown(), 1_000);
			idleTimer.unref();
		}
	});
	socket.on("error", () => {});
});

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	desiredSelection = undefined;
	await stopWorker();
	server.close();
	rmSync(socketPath, { force: true });
	rmSync(lockPath, { force: true });
	process.exit(0);
}

server.on("error", () => void shutdown());
server.listen(socketPath, () => {
	chmodSync(socketPath, 0o600);
	idleTimer = setTimeout(() => {
		if (connections.size === 0) void shutdown();
	}, 2_000);
	idleTimer.unref();
});
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
