import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePanes, parseSessions, parseWindows } from "./parser.js";
import type { TmuxGateway } from "./types.js";
import { withoutTmuxEnv } from "../util/env.js";

const execFileAsync = promisify(execFile);

const SESSION_FMT = "#{session_name}\t#{session_attached}\t#{session_windows}";
const WINDOW_FMT = "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}";
const PANE_FMT = "#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_active}\t#{pane_width}x#{pane_height}";

interface TmuxCliExecutorOptions {
  socketName?: string;
  socketPath?: string;
  tmuxBinary?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
}

const isNoServerRunningError = (message: string): boolean =>
  /no server running|failed to connect to server|error connecting to .*no such file or directory/i.test(
    message
  );

export class TmuxCliExecutor implements TmuxGateway {
  private readonly tmuxBinary: string;
  private readonly tmuxArgsPrefix: string[];
  private readonly timeoutMs: number;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly traceTmux: boolean;

  public constructor(options: TmuxCliExecutorOptions = {}) {
    if (options.socketName && options.socketPath) {
      throw new Error("tmux socketName and socketPath are mutually exclusive");
    }

    this.tmuxBinary = options.tmuxBinary ?? "tmux";
    this.tmuxArgsPrefix = options.socketPath
      ? ["-S", options.socketPath]
      : options.socketName
        ? ["-L", options.socketName]
        : [];
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
    this.traceTmux = process.env.TMUX_MOBILE_TRACE_TMUX === "1";
  }

  private async runTmux(args: string[]): Promise<string> {
    const finalArgs = [...this.tmuxArgsPrefix, ...args];
    try {
      if (this.traceTmux) {
        this.logger?.log("[tmux]", this.tmuxBinary, finalArgs.join(" "));
      }
      const { stdout } = await execFileAsync(this.tmuxBinary, finalArgs, {
        timeout: this.timeoutMs,
        env: withoutTmuxEnv(process.env)
      });
      return stdout.trim();
    } catch (error) {
      const serialized = error instanceof Error ? error.message : String(error);
      throw new Error(
        `tmux command failed: ${this.tmuxBinary} ${finalArgs.join(" ")} => ${serialized}`
      );
    }
  }

  private async runTmuxMaybeNoServer(args: string[]): Promise<string | null> {
    try {
      return await this.runTmux(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNoServerRunningError(message)) {
        return null;
      }
      throw error;
    }
  }

  public async listSessions() {
    const output = await this.runTmuxMaybeNoServer(["list-sessions", "-F", SESSION_FMT]);
    if (!output) {
      return [];
    }
    return parseSessions(output);
  }

  public async listWindows(session: string) {
    const output = await this.runTmux(["list-windows", "-t", session, "-F", WINDOW_FMT]);
    if (!output) {
      return [];
    }
    return parseWindows(output);
  }

  public async listPanes(session: string, windowIndex: number) {
    const output = await this.runTmux([
      "list-panes",
      "-t",
      `${session}:${windowIndex}`,
      "-F",
      PANE_FMT
    ]);
    if (!output) {
      return [];
    }
    return parsePanes(output);
  }

  public async createSession(name: string): Promise<void> {
    await this.runTmux(["new-session", "-d", "-s", name]);
  }

  public async createGroupedSession(name: string, targetSession: string): Promise<void> {
    await this.runTmux(["new-session", "-d", "-s", name, "-t", targetSession]);
  }

  public async killSession(name: string): Promise<void> {
    await this.runTmux(["kill-session", "-t", name]);
  }

  public async switchClient(session: string): Promise<void> {
    await this.runTmux(["switch-client", "-t", session]);
  }

  public async newWindow(session: string): Promise<void> {
    await this.runTmux(["new-window", "-t", session]);
  }

  public async killWindow(session: string, windowIndex: number): Promise<void> {
    await this.runTmux(["kill-window", "-t", `${session}:${windowIndex}`]);
  }

  public async selectWindow(session: string, windowIndex: number): Promise<void> {
    await this.runTmux(["select-window", "-t", `${session}:${windowIndex}`]);
  }

  public async splitWindow(paneId: string, orientation: "h" | "v"): Promise<void> {
    await this.runTmux(["split-window", `-${orientation}`, "-t", paneId]);
  }

  public async killPane(paneId: string): Promise<void> {
    await this.runTmux(["kill-pane", "-t", paneId]);
  }

  public async selectPane(paneId: string): Promise<void> {
    await this.runTmux(["select-pane", "-t", paneId]);
  }

  public async zoomPane(paneId: string): Promise<void> {
    await this.runTmux(["resize-pane", "-Z", "-t", paneId]);
  }

  public async capturePane(paneId: string, lines: number): Promise<string> {
    return this.runTmux(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
  }
}
