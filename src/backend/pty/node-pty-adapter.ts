import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";
import { toFlatStringEnv, withoutTmuxEnv } from "../util/env.js";

const require = createRequire(import.meta.url);
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const ensureNodePtySpawnHelperExecutable = (
  logger?: Pick<Console, "log" | "error">
): void => {
  if (os.platform() === "win32") {
    return;
  }

  try {
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");
    const rootDir = path.resolve(path.dirname(unixTerminalPath), "..");
    const candidates = [
      path.join(rootDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      path.join(rootDir, "build", "Release", "spawn-helper"),
      path.join(rootDir, "build", "Debug", "spawn-helper")
    ];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      fs.chmodSync(candidate, 0o755);
      logger?.log("node-pty spawn-helper is executable", candidate);
      return;
    }
  } catch (error) {
    logger?.error("unable to ensure node-pty spawn-helper permissions", error);
  }
};

class NodePtyProcess implements PtyProcess {
  public constructor(private readonly process: pty.IPty) {}

  public write(data: string): void {
    this.process.write(data);
  }

  public resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  public onData(handler: (data: string) => void): void {
    this.process.onData(handler);
  }

  public onExit(handler: (code: number) => void): void {
    this.process.onExit(({ exitCode }) => handler(exitCode));
  }

  public kill(): void {
    this.process.kill();
  }
}

class ScriptPtyProcess implements PtyProcess {
  public constructor(private readonly process: ChildProcessWithoutNullStreams) {}

  public write(data: string): void {
    this.process.stdin.write(data);
  }

  public resize(_cols: number, _rows: number): void {
    // script(1) wrapper does not expose dynamic resize hooks portably.
  }

  public onData(handler: (data: string) => void): void {
    this.process.stdout.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
    this.process.stderr.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
  }

  public onExit(handler: (code: number) => void): void {
    this.process.on("exit", (code) => handler(code ?? 0));
  }

  public kill(): void {
    this.process.kill("SIGTERM");
  }
}

export class NodePtyFactory implements PtyFactory {
  private nodePtyUnavailable = false;
  private readonly forceScriptFallback: boolean;

  public constructor(private readonly logger?: Pick<Console, "log" | "error">) {
    this.forceScriptFallback = process.env.TMUX_MOBILE_FORCE_SCRIPT_PTY === "1";
    ensureNodePtySpawnHelperExecutable(this.logger);
  }

  public spawnTmuxAttach(session: string): PtyProcess {
    if (os.platform() !== "win32" && (this.forceScriptFallback || this.nodePtyUnavailable)) {
      return this.spawnViaScript(session);
    }

    try {
      const shell = os.platform() === "win32" ? "cmd.exe" : "/bin/sh";
      const args =
        os.platform() === "win32"
          ? ["/c", "tmux", "attach-session", "-t", session]
          : ["-lc", `exec tmux attach-session -t ${shellQuote(session)}`];
      this.logger?.log("[pty] spawn", shell, args.join(" "));

      const spawned = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: toFlatStringEnv(withoutTmuxEnv(process.env))
      });

      return new NodePtyProcess(spawned);
    } catch (error) {
      if (os.platform() !== "win32") {
        this.nodePtyUnavailable = true;
        this.logger?.error("node-pty unavailable; falling back to script(1)", error);
        return this.spawnViaScript(session);
      }

      throw error;
    }
  }

  private spawnViaScript(session: string): PtyProcess {
    const env = withoutTmuxEnv(process.env);

    if (os.platform() === "darwin") {
      const command = "script";
      const args = ["-q", "/dev/null", "tmux", "attach-session", "-t", session];
      this.logger?.log("[pty-fallback] spawn", command, args.join(" "));
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return new ScriptPtyProcess(child);
    }

    if (os.platform() === "linux") {
      const command = "script";
      const attachCommand = `tmux attach-session -t ${shellQuote(session)}`;
      const args = ["-qfc", attachCommand, "/dev/null"];
      this.logger?.log("[pty-fallback] spawn", command, args.join(" "));
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return new ScriptPtyProcess(child);
    }

    throw new Error(`PTY fallback unsupported on ${os.platform()}`);
  }
}
