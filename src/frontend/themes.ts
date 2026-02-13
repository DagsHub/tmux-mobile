export interface ThemeConfig {
  name: string;
  xterm: { background: string; foreground: string; cursor: string };
}

export const themes: Record<string, ThemeConfig> = {
  midnight: {
    name: "Midnight",
    xterm: {
      background: "#0d1117",
      foreground: "#d1e4ff",
      cursor: "#93c5fd"
    }
  },
  amber: {
    name: "Amber",
    xterm: {
      background: "#1a1208",
      foreground: "#ffb000",
      cursor: "#ff8c00"
    }
  },
  solarized: {
    name: "Solarized Dark",
    xterm: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#2aa198"
    }
  },
  dracula: {
    name: "Dracula",
    xterm: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#bd93f9"
    }
  },
  nord: {
    name: "Nord",
    xterm: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0"
    }
  },
  gruvbox: {
    name: "Gruvbox",
    xterm: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fe8019"
    }
  }
};
