import type {
  TmuxPaneState,
  TmuxSessionSummary,
  TmuxWindowState
} from "../types/protocol.js";

const splitLine = (line: string): string[] => line.split("\t").map((item) => item.trim());

export const parseSessions = (raw: string): TmuxSessionSummary[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, attached, windows] = splitLine(line);
      return {
        name,
        attached: attached === "1",
        windows: Number.parseInt(windows, 10)
      };
    });

export const parseWindows = (raw: string): Omit<TmuxWindowState, "panes">[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, active, zoomed, panes] = splitLine(line);
      return {
        index: Number.parseInt(index, 10),
        name,
        active: active === "1",
        zoomed: zoomed === "1",
        paneCount: Number.parseInt(panes, 10)
      };
    });

export const parsePanes = (raw: string): TmuxPaneState[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, id, currentCommand, active, dimensions] = splitLine(line);
      const [width, height] = dimensions.split("x");
      return {
        index: Number.parseInt(index, 10),
        id,
        currentCommand,
        active: active === "1",
        width: Number.parseInt(width, 10),
        height: Number.parseInt(height, 10)
      };
    });
