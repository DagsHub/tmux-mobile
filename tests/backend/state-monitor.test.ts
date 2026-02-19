import { describe, expect, test, vi } from "vitest";
import { TmuxStateMonitor } from "../../src/backend/state/state-monitor.js";
import { FakeTmuxGateway } from "../harness/fakeTmux.js";

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe("state monitor", () => {
  test("publishes only when state changes", async () => {
    const tmux = new FakeTmuxGateway(["main"]);
    const onUpdate = vi.fn();
    const onError = vi.fn();

    const monitor = new TmuxStateMonitor(tmux, 50, onUpdate, onError);
    await monitor.start();

    await delay(70);
    const firstCount = onUpdate.mock.calls.length;
    await delay(70);

    expect(onUpdate.mock.calls.length).toBe(firstCount);

    await tmux.newWindow("main");
    await delay(70);

    expect(onUpdate.mock.calls.length).toBeGreaterThan(firstCount);

    monitor.stop();
    expect(onError).not.toHaveBeenCalled();
  });

  test("ignores stale tick snapshot that resolves after force publish", async () => {
    const tmux = new FakeTmuxGateway(["main"]);
    const [initialPane] = await tmux.listPanes("main", 0);
    const onUpdate = vi.fn();
    const onError = vi.fn();

    let listPanesCalls = 0;
    let secondTickStarted = false;
    let releaseSecondTick: (() => void) | undefined;
    const secondTickReleased = new Promise<void>((resolve) => {
      releaseSecondTick = resolve;
    });

    const originalListPanes = tmux.listPanes.bind(tmux);
    vi.spyOn(tmux, "listPanes").mockImplementation(async (...args) => {
      listPanesCalls += 1;
      if (listPanesCalls !== 2) {
        return originalListPanes(...args);
      }

      const staleSnapshot = await originalListPanes(...args);
      secondTickStarted = true;
      await secondTickReleased;
      return staleSnapshot;
    });

    const monitor = new TmuxStateMonitor(tmux, 5, onUpdate, onError);
    await monitor.start();

    await expect.poll(() => secondTickStarted).toBe(true);
    await tmux.zoomPane(initialPane.id);
    await monitor.forcePublish();
    const forcePublishCalls = onUpdate.mock.calls.length;

    releaseSecondTick?.();
    await delay(20);
    monitor.stop();

    const zoomStatesAfterForcePublish = onUpdate.mock.calls
      .slice(forcePublishCalls)
      .map(([snapshot]) => snapshot.sessions[0].windowStates[0].panes[0].zoomed);

    expect(zoomStatesAfterForcePublish).not.toContain(false);
    expect(onUpdate).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("ignores stale forced snapshot that resolves after a newer force publish", async () => {
    const tmux = new FakeTmuxGateway(["main"]);
    const [initialPane] = await tmux.listPanes("main", 0);
    const onUpdate = vi.fn();
    const onError = vi.fn();

    let listPanesCalls = 0;
    let firstForceStarted = false;
    let releaseFirstForce: (() => void) | undefined;
    const firstForceReleased = new Promise<void>((resolve) => {
      releaseFirstForce = resolve;
    });

    const originalListPanes = tmux.listPanes.bind(tmux);
    vi.spyOn(tmux, "listPanes").mockImplementation(async (...args) => {
      listPanesCalls += 1;
      if (listPanesCalls !== 2) {
        return originalListPanes(...args);
      }

      const staleSnapshot = await originalListPanes(...args);
      firstForceStarted = true;
      await firstForceReleased;
      return staleSnapshot;
    });

    const monitor = new TmuxStateMonitor(tmux, 1_000, onUpdate, onError);
    await monitor.start();

    const firstForcePublish = monitor.forcePublish();
    await expect.poll(() => firstForceStarted).toBe(true);

    await tmux.zoomPane(initialPane.id);
    await monitor.forcePublish();
    const updatesAfterSecondForce = onUpdate.mock.calls.length;

    releaseFirstForce?.();
    await firstForcePublish;
    await delay(20);
    monitor.stop();

    const zoomStatesAfterSecondForce = onUpdate.mock.calls
      .slice(updatesAfterSecondForce)
      .map(([snapshot]) => snapshot.sessions[0].windowStates[0].panes[0].zoomed);

    expect(zoomStatesAfterSecondForce).not.toContain(false);
    expect(onUpdate.mock.calls.at(-1)?.[0].sessions[0].windowStates[0].panes[0].zoomed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
