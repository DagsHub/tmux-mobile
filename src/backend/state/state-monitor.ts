import { buildSnapshot } from "../tmux/types.js";
import type { TmuxStateSnapshot } from "../types/protocol.js";
import type { TmuxGateway } from "../tmux/types.js";

export class TmuxStateMonitor {
  private timer?: NodeJS.Timeout;
  private lastSerializedState?: string;

  public constructor(
    private readonly tmux: TmuxGateway,
    private readonly pollIntervalMs: number,
    private readonly onUpdate: (state: TmuxStateSnapshot) => void,
    private readonly onError: (error: Error) => void
  ) {}

  public async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async forcePublish(): Promise<void> {
    const snapshot = await buildSnapshot(this.tmux);
    this.lastSerializedState = JSON.stringify(snapshot.sessions);
    this.onUpdate(snapshot);
  }

  private async tick(): Promise<void> {
    try {
      const snapshot = await buildSnapshot(this.tmux);
      const serialized = JSON.stringify(snapshot.sessions);
      if (serialized !== this.lastSerializedState) {
        this.lastSerializedState = serialized;
        this.onUpdate(snapshot);
      }
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
