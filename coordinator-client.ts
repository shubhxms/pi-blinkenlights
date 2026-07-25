import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DndValue } from "./dnd.ts";
import type { FocusHotkeySettings, Phase, ResolvedSettings } from "./patterns.ts";

export interface FocusMetadata {
  pid: number;
  cwd: string;
  tty?: string;
  tmux?: string;
  tmuxPane?: string;
  termProgram?: string;
}

const RETRY_DELAY_MS = 50;
const RETRY_COUNT = 60;
const RESPAWN_INTERVAL_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 1_000;

export class CoordinatorClient {
  private readonly clientId = randomUUID();
  private readonly helperPath: string;
  private readonly hotkeyHelperPath: string | undefined;
  private readonly projectKey: string;
  private readonly focusMetadata: FocusMetadata;
  private readonly socketPath: string;
  private readonly notifyError: (message: string) => void;
  private socket: Socket | undefined;
  private pendingSocket: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private previewRevision = 0;
  private alertRevision = 0;
  private closed = false;
  private capabilities = new Set<string>();
  private lastSettings?: ResolvedSettings;
  private activeAlertRequest?: {
    priority: number;
    timeoutMs: number;
    projectKey: string;
    phases: Phase[];
  };

  constructor(
    helperPath: string,
    projectKey: string,
    notifyError: (message: string) => void,
    socketPath?: string,
    hotkeyHelperPath?: string,
    focusMetadata?: FocusMetadata,
  ) {
    this.helperPath = helperPath;
    this.hotkeyHelperPath = hotkeyHelperPath;
    this.projectKey = projectKey;
    this.focusMetadata = focusMetadata ?? { pid: process.pid, cwd: projectKey };
    this.notifyError = notifyError;
    const uid = process.getuid?.() ?? 0;
    this.socketPath =
      socketPath ?? join(tmpdir(), `pi-blinkenlights-${uid}`, "coordinator.sock");
  }

  private reconnect(): void {
    if (this.closed || this.connecting) return;
    this.connecting = this.connectWithRetry()
      .catch((error) => {
        this.notifyError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.connecting = undefined;
      });
  }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Coordinator client is closed"));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithRetry().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async alert(settings: ResolvedSettings): Promise<void> {
    const phases = settings.patterns[settings.activePattern];
    if (!phases) throw new Error(`Unknown blink pattern: ${settings.activePattern}`);
    const revision = ++this.alertRevision;
    this.lastSettings = settings;
    const message = {
      type: "alert",
      request: {
        priority: settings.priority,
        timeoutMs: settings.timeoutSeconds * 1_000,
        projectKey: this.projectKey,
        phases,
      },
    };
    await this.connect();
    if (this.closed || revision !== this.alertRevision) return;
    this.sendMetadataIfSupported(settings);
    this.activeAlertRequest = message.request;
    this.sendIfConnected(message);
  }

  acknowledge(): void {
    this.alertRevision++;
    this.activeAlertRequest = undefined;
    this.sendIfConnected({ type: "ack" });
  }

  async configure(settings: ResolvedSettings): Promise<void> {
    this.lastSettings = settings;
    await this.connect();
    this.sendMetadataIfSupported(settings);
  }

  async focus(settings: ResolvedSettings): Promise<void> {
    await this.configure(settings);
    if (this.capabilities.has("focus")) this.sendIfConnected({ type: "focus" });
  }

  async preview(phases: Phase[]): Promise<void> {
    const revision = ++this.previewRevision;
    await this.connect();
    if (this.closed || revision !== this.previewRevision) return;
    this.sendIfConnected({ type: "preview", phases });
  }

  stopPreview(): void {
    this.previewRevision++;
    this.sendIfConnected({ type: "previewStop" });
  }

  async setDnd(scope: "global" | "project", until: DndValue): Promise<void> {
    const projectKey = scope === "project" ? this.projectKey : undefined;
    if (until === undefined || (typeof until === "number" && until <= Date.now())) {
      await this.send({ type: "dndOff", scope, projectKey });
    } else {
      await this.send({ type: "dnd", scope, projectKey, until });
    }
  }

  async syncDnd(settings: ResolvedSettings): Promise<void> {
    this.lastSettings = settings;
    await this.setDnd("global", settings.globalDndUntil);
    await this.setDnd("project", settings.projectDndUntil);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.previewRevision++;
    this.alertRevision++;
    this.activeAlertRequest = undefined;
    this.pendingSocket?.destroy();
    this.pendingSocket = undefined;
    this.socket?.end();
    this.socket = undefined;
  }

  private async send(message: unknown): Promise<void> {
    await this.connect();
    if (!this.closed) this.sendIfConnected(message);
  }

  private sendIfConnected(message: unknown): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  private sendMetadataIfSupported(settings: ResolvedSettings): void {
    if (this.capabilities.has("metadata")) {
      this.sendIfConnected({
        type: "metadata",
        focusHotkey: settings.focusHotkey,
        hotkeyHelperPath: this.hotkeyHelperPath,
      });
    }
  }

  private rearm(): void {
    if (!this.lastSettings) return;
    this.sendMetadataIfSupported(this.lastSettings);
    this.sendDndState(this.lastSettings);
    if (this.activeAlertRequest) {
      this.sendIfConnected({ type: "alert", request: this.activeAlertRequest });
    }
  }

  private sendDndState(settings: ResolvedSettings): void {
    for (const scope of ["global", "project"] as const) {
      const until =
        scope === "global" ? settings.globalDndUntil : settings.projectDndUntil;
      const projectKey = scope === "project" ? this.projectKey : undefined;
      const off =
        until === undefined || (typeof until === "number" && until <= Date.now());
      this.sendIfConnected(
        off
          ? { type: "dndOff", scope, projectKey }
          : { type: "dnd", scope, projectKey, until },
      );
    }
  }

  private async connectWithRetry(): Promise<void> {
    let lastSpawn = -Infinity;
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      if (this.closed) throw new Error("Coordinator client is closed");
      try {
        const socket = await this.openSocket();
        if (this.closed) {
          socket.destroy();
          throw new Error("Coordinator client is closed");
        }
        this.socket = socket;
        this.rearm();
        return;
      } catch (error) {
        lastError = error;
        if (this.closed) throw error;
        // Spawn (or re-spawn) the daemon. An earlier spawn may have exited
        // without listening because a concurrently-shutting-down daemon
        // still held the lock; re-spawning once it exits lets us recover.
        if (Date.now() - lastSpawn >= RESPAWN_INTERVAL_MS) {
          this.startDaemon();
          lastSpawn = Date.now();
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.pendingSocket = socket;
      let buffer = "";
      let ready = false;
      let settled = false;

      const cleanupHandshake = () => {
        clearTimeout(handshakeTimer);
        if (this.pendingSocket === socket) this.pendingSocket = undefined;
      };
      const failHandshake = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        socket.destroy();
        reject(error);
      };
      const finishHandshake = () => {
        if (settled) return;
        settled = true;
        ready = true;
        cleanupHandshake();
        resolve(socket);
      };
      const handshakeTimer = setTimeout(
        () => failHandshake(new Error("Coordinator handshake timed out")),
        HANDSHAKE_TIMEOUT_MS,
      );
      handshakeTimer.unref();

      socket.setEncoding("utf8");
      socket.on("error", (error) => {
        if (ready) {
          // Transient drop on a live connection: stay quiet and let the
          // close handler silently re-arm the connection.
          if (this.closed) this.notifyError(error.message);
        } else {
          failHandshake(error);
        }
      });
      socket.on("close", () => {
        const wasCurrent = this.socket === socket;
        if (wasCurrent) this.socket = undefined;
        if (!ready) {
          failHandshake(new Error("Coordinator closed during handshake"));
        } else if (wasCurrent && !this.closed) {
          void this.reconnect();
        }
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line) as { type?: string; message?: string; capabilities?: unknown };
            if (message.type === "ready" && !ready) {
              this.capabilities = new Set(Array.isArray(message.capabilities) ? message.capabilities : []);
              finishHandshake();
            } else if (message.type === "error" && message.message) {
              if (ready) this.notifyError(message.message);
              else failHandshake(new Error(message.message));
            }
          } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error));
            if (ready) this.notifyError(reason.message);
            else failHandshake(reason);
          }
        }
      });
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          type: "hello",
          clientId: this.clientId,
          focus: this.focusMetadata,
          hotkeyHelperPath: this.hotkeyHelperPath,
        })}\n`);
      });
    });
  }

  private startDaemon(): void {
    const daemonPath = fileURLToPath(new URL("./coordinator.mjs", import.meta.url));
    const args = [daemonPath, this.socketPath, this.helperPath];
    if (this.hotkeyHelperPath) args.push(this.hotkeyHelperPath);
    const daemon = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    daemon.unref();
  }
}
