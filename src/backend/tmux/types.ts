import type {
  TmuxPaneState,
  TmuxSessionState,
  TmuxSessionSummary,
  TmuxStateSnapshot,
  TmuxWindowState
} from "../types/protocol.js";

export interface TmuxGateway {
  listSessions(): Promise<TmuxSessionSummary[]>;
  listWindows(session: string): Promise<Omit<TmuxWindowState, "panes">[]>;
  listPanes(session: string, windowIndex: number): Promise<TmuxPaneState[]>;
  createSession(name: string): Promise<void>;
  createGroupedSession(name: string, targetSession: string): Promise<void>;
  killSession(name: string): Promise<void>;
  switchClient(session: string): Promise<void>;
  newWindow(session: string): Promise<void>;
  killWindow(session: string, windowIndex: number): Promise<void>;
  selectWindow(session: string, windowIndex: number): Promise<void>;
  splitWindow(paneId: string, orientation: "h" | "v"): Promise<void>;
  killPane(paneId: string): Promise<void>;
  selectPane(paneId: string): Promise<void>;
  zoomPane(paneId: string): Promise<void>;
  isPaneZoomed(paneId: string): Promise<boolean>;
  capturePane(paneId: string, lines: number): Promise<string>;
  renameSession(oldName: string, newName: string): Promise<void>;
  renameWindow(session: string, windowIndex: number, newName: string): Promise<void>;
  respawnPane(paneId: string): Promise<void>;
  breakPane(paneId: string): Promise<void>;
  swapWindow(session: string, srcIndex: number, dstIndex: number): Promise<void>;
  setSessionDefaultDirectory(session: string, directory: string | null): Promise<void>;
  setWindowDefaultDirectory(
    session: string,
    windowIndex: number,
    directory: string | null
  ): Promise<void>;
}

export const buildSnapshot = async (
  tmux: TmuxGateway
): Promise<TmuxStateSnapshot> => {
  const sessions = await tmux.listSessions();
  const sessionStates: TmuxSessionState[] = [];

  for (const session of sessions) {
    const windows = await tmux.listWindows(session.name);
    const withPanes: TmuxWindowState[] = [];
    for (const window of windows) {
      const panes = await tmux.listPanes(session.name, window.index);
      withPanes.push({ ...window, panes });
    }
    sessionStates.push({ ...session, windowStates: withPanes });
  }

  return {
    sessions: sessionStates,
    capturedAt: new Date().toISOString()
  };
};
