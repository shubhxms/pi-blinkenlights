import assert from "node:assert/strict";
import test from "node:test";

import {
	findTmuxPane,
	findTmuxPaneByTty,
	normalizeTty,
	parseTmuxClients,
	parseTmuxPanes,
	selectTmuxPaneForTty,
} from "../focus.mjs";

test("normalizes tty values", () => {
	assert.equal(normalizeTty("ttys004"), "/dev/ttys004");
	assert.equal(normalizeTty("/dev/ttys004"), "/dev/ttys004");
	assert.equal(normalizeTty(""), undefined);
});

test("parses tmux panes, clients, and matches by tty", () => {
	const output = "%1\t/dev/ttys001\t@1\t$1\tmain\n%2\tttys004\t@2\t$1\tmain\n";
	assert.deepEqual(parseTmuxPanes(output), [
		{ paneId: "%1", paneTty: "/dev/ttys001", windowId: "@1", sessionId: "$1", sessionName: "main" },
		{ paneId: "%2", paneTty: "/dev/ttys004", windowId: "@2", sessionId: "$1", sessionName: "main" },
	]);
	assert.deepEqual(parseTmuxClients("/dev/ttys000\t$1\tmain\t1\n"), [
		{ clientTty: "/dev/ttys000", sessionId: "$1", sessionName: "main", active: true },
	]);
	const pane = findTmuxPaneByTty("/dev/ttys004", "tmux-socket", () => output);
	assert.equal(pane?.paneId, "%2");
	const paneById = findTmuxPane({ tty: "/dev/ttys-missing", tmuxPane: "%1" }, "tmux-socket", () => output);
	assert.equal(paneById?.paneTty, "/dev/ttys001");
});

test("selects tmux pane through the target tmux environment and attached client", () => {
	const panes = "%1\t/dev/ttys001\t@1\t$1\tmain\n%2\t/dev/ttys004\t@2\t$1\tmain\n";
	const clients = "/dev/ttys000\t$1\tmain\t1\n";
	const reads = [];
	const writes = [];
	const read = (_command, args, options) => {
		reads.push({ args, tmux: options.env.TMUX });
		return args[0] === "list-clients" ? clients : panes;
	};
	const run = (_command, args, options) => {
		writes.push({ args, tmux: options.env.TMUX });
		return { status: 0 };
	};

	const result = selectTmuxPaneForTty("/dev/ttys004", "target-tmux-env", run, read);
	assert.equal(result.focused, true);
	assert.deepEqual(reads.map((entry) => entry.tmux), ["target-tmux-env", "target-tmux-env"]);
	assert.deepEqual(writes, [
		{ args: ["switch-client", "-c", "/dev/ttys000", "-t", "@2"], tmux: "target-tmux-env" },
		{ args: ["select-window", "-t", "@2"], tmux: "target-tmux-env" },
		{ args: ["select-pane", "-t", "%2"], tmux: "target-tmux-env" },
	]);
});
