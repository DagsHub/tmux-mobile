import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOGGER: Pick<Console, "log" | "error"> = {
  log: () => undefined,
  error: (...values: unknown[]) => {
    console.error(...values);
  }
};

const serialize = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const createLogger = (
  logFilePath: string | undefined
): Pick<Console, "log" | "error"> => {
  if (!logFilePath) {
    return DEFAULT_LOGGER;
  }

  const resolvedPath = path.resolve(logFilePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const write = (level: "INFO" | "ERROR", values: unknown[]): void => {
    const line = `${new Date().toISOString()} [${level}] ${values
      .map((value) => serialize(value))
      .join(" ")}\n`;
    fs.appendFileSync(resolvedPath, line, "utf8");
  };

  return {
    log: (...values: unknown[]) => {
      write("INFO", values);
    },
    error: (...values: unknown[]) => {
      write("ERROR", values);
    }
  };
};
