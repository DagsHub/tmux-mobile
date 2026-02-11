import { EventEmitter } from "node:events";
import type { PtyFactory, PtyProcess } from "../../src/backend/pty/pty-adapter.js";

class FakePtyProcess implements PtyProcess {
  private readonly events = new EventEmitter();
  public readonly writes: string[] = [];
  public readonly resizes: Array<{ cols: number; rows: number }> = [];

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  public onData(handler: (data: string) => void): void {
    this.events.on("data", handler);
  }

  public onExit(handler: (code: number) => void): void {
    this.events.on("exit", handler);
  }

  public kill(): void {
    this.events.emit("exit", 0);
  }

  public emitData(data: string): void {
    this.events.emit("data", data);
  }
}

export class FakePtyFactory implements PtyFactory {
  public lastSpawnedSession?: string;
  public readonly processes: FakePtyProcess[] = [];

  public spawnTmuxAttach(session: string): PtyProcess {
    this.lastSpawnedSession = session;
    const process = new FakePtyProcess();
    this.processes.push(process);
    return process;
  }

  public latestProcess(): FakePtyProcess {
    const latest = this.processes.at(-1);
    if (!latest) {
      throw new Error("No PTY process has been created");
    }
    return latest;
  }
}
