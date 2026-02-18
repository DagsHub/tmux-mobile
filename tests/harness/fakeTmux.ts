import type {
  TmuxPaneState,
  TmuxSessionSummary,
  TmuxWindowState
} from "../../src/backend/types/protocol.js";
import type { TmuxGateway } from "../../src/backend/tmux/types.js";

interface SessionNode {
  name: string;
  attached: boolean;
  windows: WindowNode[];
}

interface WindowNode {
  index: number;
  name: string;
  active: boolean;
  zoomed: boolean;
  panes: PaneNode[];
}

interface PaneNode {
  index: number;
  id: string;
  command: string;
  active: boolean;
  width: number;
  height: number;
}

let paneCounter = 20;

interface FakeTmuxOptions {
  attachedSession?: string;
  failSwitchClient?: boolean;
}

const buildDefaultSession = (name: string): SessionNode => ({
  name,
  attached: false,
  windows: [
    {
      index: 0,
      name: "shell",
      active: true,
      zoomed: false,
      panes: [
        {
          index: 0,
          id: `%${paneCounter++}`,
          command: "bash",
          active: true,
          width: 120,
          height: 40
        }
      ]
    }
  ]
});

export class FakeTmuxGateway implements TmuxGateway {
  private sessions: SessionNode[] = [];
  private failSwitchClient = false;
  public readonly calls: string[] = [];

  public constructor(seedSessions: string[] = [], options: FakeTmuxOptions = {}) {
    this.sessions = seedSessions.map((name) => buildDefaultSession(name));
    this.failSwitchClient = options.failSwitchClient ?? false;
    if (options.attachedSession) {
      this.markAttached(options.attachedSession);
    }
  }

  public listSessions(): Promise<TmuxSessionSummary[]> {
    this.calls.push("listSessions");
    return Promise.resolve(
      this.sessions.map((session) => ({
        name: session.name,
        attached: session.attached,
        windows: session.windows.length
      }))
    );
  }

  public listWindows(sessionName: string): Promise<Omit<TmuxWindowState, "panes">[]> {
    this.calls.push(`listWindows:${sessionName}`);
    const session = this.findSession(sessionName);
    return Promise.resolve(
      session.windows.map((window) => ({
        index: window.index,
        name: window.name,
        active: window.active,
        paneCount: window.panes.length
      }))
    );
  }

  public listPanes(sessionName: string, windowIndex: number): Promise<TmuxPaneState[]> {
    this.calls.push(`listPanes:${sessionName}:${windowIndex}`);
    const window = this.findWindow(sessionName, windowIndex);
    return Promise.resolve(
      window.panes.map((pane) => ({
        index: pane.index,
        id: pane.id,
        currentCommand: pane.command,
        active: pane.active,
        width: pane.width,
        height: pane.height,
        zoomed: window.zoomed
      }))
    );
  }

  public async createSession(name: string): Promise<void> {
    this.calls.push(`createSession:${name}`);
    if (this.sessions.some((session) => session.name === name)) {
      return;
    }
    this.sessions.push(buildDefaultSession(name));
  }

  public async killSession(name: string): Promise<void> {
    this.calls.push(`killSession:${name}`);
    this.sessions = this.sessions.filter((session) => session.name !== name);
  }

  public async switchClient(sessionName: string): Promise<void> {
    this.calls.push(`switchClient:${sessionName}`);
    if (this.failSwitchClient) {
      throw new Error("no current client");
    }
    this.markAttached(sessionName);
  }

  public async newWindow(sessionName: string): Promise<void> {
    this.calls.push(`newWindow:${sessionName}`);
    const session = this.findSession(sessionName);
    for (const window of session.windows) {
      window.active = false;
    }
    const nextIndex = session.windows.at(-1)?.index ?? -1;
    session.windows.push({
      index: nextIndex + 1,
      name: `win-${nextIndex + 1}`,
      active: true,
      zoomed: false,
      panes: [
        {
          index: 0,
          id: `%${paneCounter++}`,
          command: "bash",
          active: true,
          width: 120,
          height: 40
        }
      ]
    });
  }

  public async killWindow(sessionName: string, windowIndex: number): Promise<void> {
    this.calls.push(`killWindow:${sessionName}:${windowIndex}`);
    const session = this.findSession(sessionName);
    session.windows = session.windows.filter((window) => window.index !== windowIndex);
    if (session.windows.length > 0) {
      session.windows[0].active = true;
    }
  }

  public async selectWindow(sessionName: string, windowIndex: number): Promise<void> {
    this.calls.push(`selectWindow:${sessionName}:${windowIndex}`);
    const session = this.findSession(sessionName);
    for (const window of session.windows) {
      window.active = window.index === windowIndex;
    }
  }

  public async splitWindow(paneId: string, orientation: "h" | "v"): Promise<void> {
    this.calls.push(`splitWindow:${paneId}:${orientation}`);
    const { session, window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = false;
    }
    window.zoomed = false;
    window.panes.push({
      index: window.panes.length,
      id: `%${paneCounter++}`,
      command: "bash",
      active: true,
      width: orientation === "h" ? 60 : 120,
      height: orientation === "v" ? 20 : 40
    });
    for (const s of this.sessions) {
      s.attached = s.name === session.name;
    }
  }

  public async killPane(paneId: string): Promise<void> {
    this.calls.push(`killPane:${paneId}`);
    const { window } = this.findByPane(paneId);
    window.panes = window.panes.filter((pane) => pane.id !== paneId);
    if (window.panes.length > 0) {
      window.panes[0].active = true;
    }
  }

  public async selectPane(paneId: string): Promise<void> {
    this.calls.push(`selectPane:${paneId}`);
    const { window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = pane.id === paneId;
    }
  }

  public async zoomPane(paneId: string): Promise<void> {
    this.calls.push(`zoomPane:${paneId}`);
    const { window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = pane.id === paneId;
    }
    window.zoomed = !window.zoomed;
  }

  public async isPaneZoomed(paneId: string): Promise<boolean> {
    this.calls.push(`isPaneZoomed:${paneId}`);
    const { window } = this.findByPane(paneId);
    return window.zoomed;
  }

  public async capturePane(paneId: string, lines: number): Promise<string> {
    this.calls.push(`capturePane:${paneId}:${lines}`);
    return `captured ${lines} lines for ${paneId}`;
  }

  public setFailSwitchClient(value: boolean): void {
    this.failSwitchClient = value;
  }

  private markAttached(sessionName: string): void {
    for (const session of this.sessions) {
      session.attached = session.name === sessionName;
    }
  }

  private findSession(name: string): SessionNode {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) {
      throw new Error(`session not found: ${name}`);
    }
    return session;
  }

  private findWindow(sessionName: string, windowIndex: number): WindowNode {
    const session = this.findSession(sessionName);
    const window = session.windows.find((candidate) => candidate.index === windowIndex);
    if (!window) {
      throw new Error(`window not found: ${sessionName}:${windowIndex}`);
    }
    return window;
  }

  private findByPane(paneId: string): { session: SessionNode; window: WindowNode; pane: PaneNode } {
    for (const session of this.sessions) {
      for (const window of session.windows) {
        for (const pane of window.panes) {
          if (pane.id === paneId) {
            return { session, window, pane };
          }
        }
      }
    }

    throw new Error(`pane not found: ${paneId}`);
  }
}
