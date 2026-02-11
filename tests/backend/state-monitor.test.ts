import { describe, expect, test, vi } from "vitest";
import { TmuxStateMonitor } from "../../src/backend/state/state-monitor.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";

describe("state monitor", () => {
  test("publishes only when state changes", async () => {
    const tmux = new FakeTmuxGateway(["main"]);
    const onUpdate = vi.fn();
    const onError = vi.fn();

    const monitor = new TmuxStateMonitor(tmux, 50, onUpdate, onError);
    await monitor.start();

    await new Promise((resolve) => setTimeout(resolve, 70));
    const firstCount = onUpdate.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(onUpdate.mock.calls.length).toBe(firstCount);

    await tmux.newWindow("main");
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(onUpdate.mock.calls.length).toBeGreaterThan(firstCount);

    monitor.stop();
    expect(onError).not.toHaveBeenCalled();
  });
});
