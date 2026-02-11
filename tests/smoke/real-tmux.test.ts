import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { TmuxCliExecutor } from "../../src/backend/tmux/cli-executor.js";

const execFileAsync = promisify(execFile);
const shouldRun = process.env.REAL_TMUX_SMOKE === "1";

const socketPath = (name: string): string => path.join("/tmp", `${name}.sock`);

const safeCleanup = async (sockPath: string): Promise<void> => {
  try {
    await execFileAsync("tmux", ["-S", sockPath, "kill-server"]);
  } catch {
    // no-op; cleanup should never fail the suite
  }
};

const canRunIsolatedTmux = (() => {
  if (!shouldRun) {
    return false;
  }

  const sockPath = socketPath(`tmux-mobile-preflight-${process.pid}`);
  const create = spawnSync("tmux", ["-S", sockPath, "new-session", "-d", "-s", "preflight"], {
    encoding: "utf8"
  });
  spawnSync("tmux", ["-S", sockPath, "kill-server"], { encoding: "utf8" });

  const output = `${create.stderr ?? ""}\n${create.stdout ?? ""}`.toLowerCase();
  if (output.includes("operation not permitted") || output.includes("permission denied")) {
    return false;
  }

  return create.status === 0;
})();

describe.skipIf(!canRunIsolatedTmux)("real tmux smoke", () => {
  test("creates and inspects an isolated tmux session", async () => {
    const sockPath = socketPath(`tmux-mobile-smoke-${process.pid}-${Date.now()}`);
    const sessionName = "smoke-main";
    const tmux = new TmuxCliExecutor({ socketPath: sockPath });

    await safeCleanup(sockPath);

    const before = await tmux.listSessions();
    expect(before).toEqual([]);

    await tmux.createSession(sessionName);
    const sessions = await tmux.listSessions();
    expect(sessions.some((session) => session.name === sessionName)).toBe(true);

    const windows = await tmux.listWindows(sessionName);
    expect(windows.length).toBeGreaterThan(0);

    const panes = await tmux.listPanes(sessionName, windows[0].index);
    expect(panes.length).toBeGreaterThan(0);

    const capture = await tmux.capturePane(panes[0].id, 25);
    expect(typeof capture).toBe("string");

    await tmux.killSession(sessionName);
    await safeCleanup(sockPath);
  }, 20_000);
});
