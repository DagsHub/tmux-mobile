import { describe, expect, test } from "vitest";
import { TerminalRuntime } from "../../src/backend/pty/terminal-runtime.js";
import { FakePtyFactory } from "../harness/fakePty.js";

describe("terminal runtime", () => {
  test("applies latest resize when attaching after an early resize", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);

    runtime.resize(140, 50);
    runtime.attachToSession("main");

    expect(factory.latestProcess().resizes.at(0)).toEqual({ cols: 140, rows: 50 });
  });

  test("ignores invalid resize values", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);

    runtime.resize(Number.NaN, 40);
    runtime.resize(1, 1);
    runtime.attachToSession("main");

    expect(factory.latestProcess().resizes.at(0)).toEqual({ cols: 80, rows: 24 });
  });
});
