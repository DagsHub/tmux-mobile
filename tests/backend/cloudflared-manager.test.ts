import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { CloudflaredManager } from "../../src/backend/cloudflared/manager.js";

class FakeCloudflaredProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public killed = false;

  public kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  });
}

describe("cloudflared manager", () => {
  test("does not fail on early stderr error text if a tunnel URL is emitted", async () => {
    const process = new FakeCloudflaredProcess();
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        process.stderr.write("2026-03-15T21:15:11Z ERR Error unmarshaling QuickTunnel response, retrying\n");
        process.stdout.write("https://resilient-example.trycloudflare.com\n");
      });
      return process;
    });

    const manager = new CloudflaredManager({
      execFileImpl,
      spawnProcess,
      maxAttempts: 1,
      retryDelayMs: 0,
      startupTimeoutMs: 100
    });

    await expect(manager.start(8767)).resolves.toEqual({
      publicUrl: "https://resilient-example.trycloudflare.com"
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  test("retries quick tunnel startup after a transient failure", async () => {
    const firstProcess = new FakeCloudflaredProcess();
    const secondProcess = new FakeCloudflaredProcess();
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const spawnProcess = vi
      .fn()
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          firstProcess.stderr.write("2026-03-15T21:15:11Z ERR Error unmarshaling QuickTunnel response\n");
          firstProcess.emit("exit", 1);
        });
        return firstProcess;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          secondProcess.stdout.write("https://steady-example.trycloudflare.com\n");
        });
        return secondProcess;
      });

    const manager = new CloudflaredManager({
      execFileImpl,
      spawnProcess,
      maxAttempts: 2,
      retryDelayMs: 0,
      startupTimeoutMs: 100
    });

    await expect(manager.start(8767)).resolves.toEqual({
      publicUrl: "https://steady-example.trycloudflare.com"
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});
