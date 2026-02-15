import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../../src/backend/util/file-logger.js";

describe("file logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps debug logs silent but preserves error output when no debug log file is configured", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = createLogger(undefined);

    logger.log("debug");
    logger.error("error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("error");
  });

  test("writes logs to file when debug log file is configured", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-mobile-logger-"));
    const logPath = path.join(tempRoot, "debug.log");
    const logger = createLogger(logPath);

    logger.log("hello", { ok: true });
    logger.error("boom");

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("[INFO] hello {\"ok\":true}");
    expect(content).toContain("[ERROR] boom");
  });
});
