import { describe, expect, test } from "vitest";
import { parsePanes, parseSessions, parseWindows } from "../../src/backend/tmux/parser.js";

describe("tmux parser", () => {
  test("parses session lines", () => {
    const parsed = parseSessions("main\t1\t2\nwork\t0\t1");
    expect(parsed).toEqual([
      { name: "main", attached: true, windows: 2 },
      { name: "work", attached: false, windows: 1 }
    ]);
  });

  test("parses windows and panes", () => {
    const windows = parseWindows("0\tbash\t1\t0\t2");
    expect(windows[0]).toEqual({ index: 0, name: "bash", active: true, zoomed: false, paneCount: 2 });

    const panes = parsePanes("0\t%1\tbash\t1\t120x30");
    expect(panes[0]).toEqual({
      index: 0,
      id: "%1",
      currentCommand: "bash",
      active: true,
      width: 120,
      height: 30
    });
  });
});
