export const withoutTmuxEnv = (
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  return next;
};

export const toFlatStringEnv = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
};
