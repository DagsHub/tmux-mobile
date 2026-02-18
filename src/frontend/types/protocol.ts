export interface TmuxSessionSummary {
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxPaneState {
  index: number;
  id: string;
  currentCommand: string;
  active: boolean;
  width: number;
  height: number;
}

export interface TmuxWindowState {
  index: number;
  name: string;
  active: boolean;
  zoomed: boolean;
  paneCount: number;
  panes: TmuxPaneState[];
}

export interface TmuxSessionState extends TmuxSessionSummary {
  windowStates: TmuxWindowState[];
}

export interface TmuxStateSnapshot {
  sessions: TmuxSessionState[];
  capturedAt: string;
}

export type ControlServerMessage =
  | { type: "auth_ok"; clientId: string; requiresPassword: boolean }
  | { type: "auth_error"; reason: string }
  | { type: "attached"; session: string }
  | { type: "session_picker"; sessions: TmuxSessionSummary[] }
  | { type: "tmux_state"; state: TmuxStateSnapshot }
  | { type: "scrollback"; paneId: string; text: string; lines: number }
  | { type: "error"; message: string }
  | { type: "info"; message: string };
