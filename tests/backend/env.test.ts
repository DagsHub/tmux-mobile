import { describe, expect, test } from "vitest";
import { toFlatStringEnv, withoutTmuxEnv } from "../../src/backend/util/env.js";

describe("env utils", () => {
  test("removes tmux-specific env vars", () => {
    const input = {
      TMUX: "/tmp/tmux-123/default,123,0",
      TMUX_PANE: "%7",
      PATH: "/usr/bin"
    } as NodeJS.ProcessEnv;

    const output = withoutTmuxEnv(input);
    expect(output.TMUX).toBeUndefined();
    expect(output.TMUX_PANE).toBeUndefined();
    expect(output.PATH).toBe("/usr/bin");
  });

  test("flattens env by removing undefined values", () => {
    const input = {
      A: "1",
      B: undefined
    } as NodeJS.ProcessEnv;

    expect(toFlatStringEnv(input)).toEqual({ A: "1" });
  });
});
