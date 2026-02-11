import os from "node:os";
import * as pty from "node-pty";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";

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

export class NodePtyFactory implements PtyFactory {
  public spawnTmuxAttach(session: string): PtyProcess {
    const shell = os.platform() === "win32" ? "cmd.exe" : "tmux";
    const args = os.platform() === "win32" ? ["/c", "tmux", "attach-session", "-t", session] : ["attach-session", "-t", session];

    const spawned = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>
    });

    return new NodePtyProcess(spawned);
  }
}
