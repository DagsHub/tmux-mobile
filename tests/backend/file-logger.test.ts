import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../../src/backend/util/file-logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("file logger", () => {
  test("is quiet by default except for errors", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger(undefined);

    logger.log("debug line");
    logger.error("boom");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  test("writes log and error entries to file when debug path is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-mobile-logger-"));
    const logPath = path.join(tmpDir, "debug.log");
    const logger = createLogger(logPath);

    logger.log("hello", { a: 1 });
    logger.error(new Error("oops"));

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("[INFO] hello {\"a\":1}");
    expect(content).toContain("[ERROR] Error: oops");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
