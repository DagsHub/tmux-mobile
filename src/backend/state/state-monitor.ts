import { buildSnapshot } from "../tmux/types.js";
import type { TmuxStateSnapshot } from "../types/protocol.js";
import type { TmuxGateway } from "../tmux/types.js";

export class TmuxStateMonitor {
  private timer?: NodeJS.Timeout;
  private lastSerializedState?: string;
  private nextRequestId = 0;
  private latestHandledRequestId = 0;

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
    await this.publishSnapshot(true);
  }

  private async tick(): Promise<void> {
    try {
      await this.publishSnapshot(false);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async publishSnapshot(force: boolean): Promise<void> {
    const requestId = ++this.nextRequestId;
    const snapshot = await buildSnapshot(this.tmux);

    // Discard stale async completions; a newer snapshot request already finished.
    if (requestId < this.latestHandledRequestId) {
      return;
    }

    this.latestHandledRequestId = requestId;
    const serialized = JSON.stringify(snapshot.sessions);
    if (force || serialized !== this.lastSerializedState) {
      this.lastSerializedState = serialized;
      this.onUpdate(snapshot);
    }
  }
}
