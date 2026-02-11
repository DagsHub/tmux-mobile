import { EventEmitter } from "node:events";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";

interface TerminalRuntimeEvents {
  data: (payload: string) => void;
  exit: (code: number) => void;
  attach: (session: string) => void;
}

export class TerminalRuntime {
  private readonly events = new EventEmitter();
  private process?: PtyProcess;
  private session?: string;

  public constructor(private readonly factory: PtyFactory) {}

  public currentSession(): string | undefined {
    return this.session;
  }

  public attachToSession(session: string): void {
    if (this.session === session && this.process) {
      return;
    }

    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    this.session = session;
    const processRef = this.factory.spawnTmuxAttach(session);
    processRef.onData((data) => this.events.emit("data", data));
    processRef.onExit((code) => {
      this.events.emit("exit", code);
      if (this.process === processRef) {
        this.process = undefined;
      }
    });
    this.process = processRef;
    this.events.emit("attach", session);
  }

  public write(data: string): void {
    this.process?.write(data);
  }

  public resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  public on<K extends keyof TerminalRuntimeEvents>(
    event: K,
    handler: TerminalRuntimeEvents[K]
  ): () => void {
    this.events.on(event, handler as (...args: unknown[]) => void);
    return () => this.events.off(event, handler as (...args: unknown[]) => void);
  }

  public shutdown(): void {
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
  }
}
