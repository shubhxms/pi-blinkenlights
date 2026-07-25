import { execFileSync, spawnSync } from "node:child_process";

export function normalizeTty(value) {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const trimmed = value.trim();
	return trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed.replace(/^\/dev\//, "")}`;
}

function tmuxEnv(tmux) {
	return typeof tmux === "string" && tmux.trim()
		? { ...process.env, TMUX: tmux }
		: process.env;
}

function tmuxRead(args, tmux, run = execFileSync) {
	return run("tmux", args, {
		encoding: "utf8",
		env: tmuxEnv(tmux),
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function tmuxRun(args, tmux, run = spawnSync) {
	return run("tmux", args, { env: tmuxEnv(tmux), stdio: "ignore" });
}

export function parseTmuxPanes(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [paneId, paneTty, windowId, sessionId, sessionName] = line.split("\t");
			return { paneId, paneTty: normalizeTty(paneTty), windowId, sessionId, sessionName };
		})
		.filter((pane) => pane.paneId && pane.paneTty);
}

export function parseTmuxClients(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [clientTty, sessionId, sessionName, active] = line.split("\t");
			return {
				clientTty: normalizeTty(clientTty),
				sessionId,
				sessionName,
				active: active === "1",
			};
		})
		.filter((client) => client.clientTty && (client.sessionId || client.sessionName));
}

export function listTmuxPanes(tmux, run = execFileSync) {
	return parseTmuxPanes(tmuxRead([
		"list-panes",
		"-a",
		"-F",
		"#{pane_id}\t#{pane_tty}\t#{window_id}\t#{session_id}\t#{session_name}",
	], tmux, run));
}

export function listTmuxClients(tmux, run = execFileSync) {
	try {
		return parseTmuxClients(tmuxRead([
			"list-clients",
			"-F",
			"#{client_tty}\t#{session_id}\t#{session_name}\t#{client_active}",
		], tmux, run));
	} catch {
		return [];
	}
}

export function findTmuxPane(target, tmux, run = execFileSync) {
	const normalized = normalizeTty(target?.tty);
	const tmuxPane = typeof target?.tmuxPane === "string" && target.tmuxPane.trim()
		? target.tmuxPane.trim()
		: undefined;
	if (!normalized && !tmuxPane) return undefined;
	try {
		const panes = listTmuxPanes(tmux, run);
		return panes.find((pane) => tmuxPane && pane.paneId === tmuxPane) ??
			panes.find((pane) => normalized && pane.paneTty === normalized);
	} catch {
		return undefined;
	}
}

export function findTmuxPaneByTty(tty, tmux, run = execFileSync) {
	return findTmuxPane({ tty }, tmux, run);
}

function tmuxTargetForClient(client, pane) {
	const target = pane.windowId || pane.sessionId || pane.sessionName;
	if (!target) return undefined;
	return client ? ["-c", client.clientTty, "-t", target] : ["-t", target];
}

export function selectTmuxPane(target, tmux, run = spawnSync, read = execFileSync) {
	const pane = findTmuxPane(target, tmux, read);
	if (!pane) return { focused: false, reason: "no tmux pane matched target" };

	const clients = listTmuxClients(tmux, read).filter((client) =>
		(client.sessionId && client.sessionId === pane.sessionId) ||
		(client.sessionName && client.sessionName === pane.sessionName),
	);
	const activeClients = clients.filter((client) => client.active);
	const targetClients = activeClients.length > 0 ? activeClients : clients.length > 0 ? clients : [undefined];
	let ok = false;

	for (const client of targetClients) {
		const switchTarget = tmuxTargetForClient(client, pane);
		if (switchTarget) {
			const result = tmuxRun(["switch-client", ...switchTarget], tmux, run);
			ok = ok || result.status === 0;
		}
	}
	if (pane.windowId) {
		const result = tmuxRun(["select-window", "-t", pane.windowId], tmux, run);
		ok = ok || result.status === 0;
	}
	const paneResult = tmuxRun(["select-pane", "-t", pane.paneId], tmux, run);
	ok = ok || paneResult.status === 0;

	return ok
		? { focused: true, pane, clients: targetClients.filter(Boolean) }
		: { focused: false, pane, clients: targetClients.filter(Boolean), reason: "tmux commands failed" };
}

export function selectTmuxPaneForTty(tty, tmux, run = spawnSync, read = execFileSync) {
	return selectTmuxPane({ tty }, tmux, run, read);
}

function runOsaScript(script) {
	const result = spawnSync("osascript", ["-e", script], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return result.status === 0;
}

function osaString(value) {
	return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function activateApplication(name) {
	return runOsaScript(`tell application "${osaString(name)}" to activate`);
}

function focusTerminalAppByTty(target) {
	const tty = normalizeTty(target.tty);
	const shortTty = tty?.replace(/^\/dev\//, "");
	const termProgram = String(target.termProgram ?? "").toLowerCase();

	if (termProgram.includes("iterm")) {
		const script = `
			tell application "iTerm"
				activate
				repeat with w in windows
					repeat with t in tabs of w
						repeat with s in sessions of t
							if tty of s is "${osaString(tty)}" or tty of s is "${osaString(shortTty)}" then
								select w
								select t
								select s
								return
							end if
						end repeat
					end repeat
				end repeat
				error "iTerm tty not found"
			end tell`;
		return runOsaScript(script) || activateApplication("iTerm") || activateApplication("iTerm2");
	}

	if (termProgram.includes("apple_terminal") || termProgram.includes("terminal")) {
		const script = `
			tell application "Terminal"
				activate
				repeat with w in windows
					repeat with t in tabs of w
						if tty of t is "${osaString(tty)}" or tty of t is "${osaString(shortTty)}" then
							set selected tab of w to t
							set index of w to 1
							return
						end if
					end repeat
				end repeat
				error "Terminal tty not found"
			end tell`;
		return runOsaScript(script) || activateApplication("Terminal");
	}

	if (termProgram.includes("ghostty")) return activateApplication("Ghostty");
	return activateApplication("Ghostty") || activateApplication("iTerm2") || activateApplication("iTerm") || activateApplication("Terminal");
}

export function focusTarget(target) {
	if (!target || typeof target !== "object") return { focused: false, reason: "missing focus target" };
	const tmuxResult = selectTmuxPane(target, target.tmux);
	const appTarget = tmuxResult.clients?.[0]?.clientTty
		? { ...target, tty: tmuxResult.clients[0].clientTty }
		: target;
	const appFocused = focusTerminalAppByTty(appTarget);
	return {
		focused: tmuxResult.focused || appFocused,
		tmuxFocused: tmuxResult.focused,
		appFocused,
		reason: tmuxResult.focused || appFocused ? undefined : tmuxResult.reason ?? "no tmux pane or terminal app matched",
		diagnostic: {
			targetTty: normalizeTty(target.tty),
			hasTmux: typeof target.tmux === "string" && target.tmux.length > 0,
			tmuxPane: target.tmuxPane,
			termProgram: target.termProgram,
			appTargetTty: normalizeTty(appTarget.tty),
			matchedPane: tmuxResult.pane,
			matchedClients: tmuxResult.clients,
			tmuxReason: tmuxResult.reason,
		},
	};
}
