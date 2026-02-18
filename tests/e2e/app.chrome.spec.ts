import { expect, test } from "@playwright/test";
import { startE2EServer, type StartedE2EServer } from "./harness/test-server.js";

test.describe("tmux-mobile browser behavior", () => {
  test.describe("auto attach + drawer + terminal", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("auto-attaches and renders terminal viewport", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.locator(".top-title")).toContainText("Window: 0: shell");
      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);

      await expect.poll(() => server.ptyFactory.processes.length).toBeGreaterThan(0);
      server.ptyFactory.latestProcess().emitData("hello from e2e\r\n");

      await expect(page.getByTestId("terminal-host")).toBeVisible();
      const hostBox = await page.getByTestId("terminal-host").boundingBox();
      expect(hostBox?.height ?? 0).toBeGreaterThan(120);

      const [screenWidth, screenHeight] = await page.evaluate(() => {
        const screen = document.querySelector(".terminal-host .xterm-screen") as HTMLElement | null;
        if (!screen) {
          return [0, 0] as const;
        }
        const rect = screen.getBoundingClientRect();
        return [rect.width, rect.height] as const;
      });

      expect(screenWidth).toBeGreaterThan(40);
      expect(screenHeight).toBeGreaterThan(40);
      await expect(page.getByTestId("top-status-indicator")).not.toHaveClass(/error/);
    });

    test("drawer closes via backdrop and close button and preserves section spacing", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      await page.getByTestId("drawer-toggle").click();
      await expect(page.locator(".drawer")).toBeVisible();

      const sessionGap = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="sessions-list"]');
        const last = list?.querySelector("li:last-child button") as HTMLElement | null;
        const action = document.querySelector(
          '[data-testid="new-session-button"]'
        ) as HTMLElement | null;
        if (!last || !action) {
          return -1;
        }
        return action.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
      });

      const windowGap = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="windows-list"]');
        const last = list?.querySelector("li:last-child button") as HTMLElement | null;
        const action = document.querySelector(
          '[data-testid="new-window-button"]'
        ) as HTMLElement | null;
        if (!last || !action) {
          return -1;
        }
        return action.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
      });

      expect(sessionGap).toBeGreaterThan(2);
      expect(windowGap).toBeGreaterThan(2);

      await page.evaluate(() => {
        const backdrop = document.querySelector('[data-testid=\"drawer-backdrop\"]') as HTMLElement | null;
        if (!backdrop) {
          return;
        }
        const rect = backdrop.getBoundingClientRect();
        const clickX = Math.max(rect.right - 8, rect.left + 8);
        const clickY = Math.max(rect.top + 24, rect.top + 8);
        const target = document.elementFromPoint(clickX, clickY) as HTMLElement | null;
        target?.click();
      });
      await expect(page.locator(".drawer")).toHaveCount(0);

      await page.getByTestId("drawer-toggle").click();
      await expect(page.locator(".drawer")).toBeVisible();
      await page.getByTestId("drawer-close").click();
      await expect(page.locator(".drawer")).toHaveCount(0);
    });
  });

  test.describe("session picker", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({ sessions: ["work", "dev"], defaultSession: "main" });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("selecting a session from modal attaches and closes modal", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
      await page.getByTestId("session-picker-overlay").getByRole("button", { name: "work" }).click();

      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);
      await expect(page.locator(".top-title")).toContainText("Window: 0: shell");

      await expect.poll(() => server.ptyFactory.lastSpawnedSession).toBe("work");
    });
  });

  test.describe("password auth", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({
        sessions: ["main"],
        defaultSession: "main",
        password: "correct-horse"
      });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("shows feedback for wrong password and allows retry", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();

      await page.getByPlaceholder("Enter password").fill("wrong-password");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByTestId("password-error")).toContainText("Wrong password. Try again.");
      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();

      await page.getByPlaceholder("Enter password").fill("correct-horse");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByRole("heading", { name: "Password Required" })).toHaveCount(0);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.getByTestId("top-status-indicator")).not.toHaveClass(/error/);
    });

    test("shows feedback when saved password is wrong", async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("tmux-mobile-password", "wrong-password");
      });

      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByRole("heading", { name: "Password Required" })).toBeVisible();
      await expect(page.getByTestId("password-error")).toContainText("Wrong password. Try again.");

      await page.getByPlaceholder("Enter password").fill("correct-horse");
      await page.getByRole("button", { name: "Connect" }).click();

      await expect(page.getByRole("heading", { name: "Password Required" })).toHaveCount(0);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
    });
  });

  test.describe("sticky zoom toggle", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("defaults off on wide screens and toggles sticky zoom state", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      // Open drawer
      await page.getByTestId("drawer-toggle").click();
      await expect(page.locator(".drawer")).toBeVisible();

      // Verify sticky zoom toggle exists and is off by default
      const toggle = page.getByTestId("sticky-zoom-toggle");
      await expect(toggle).toBeVisible();
      await expect(toggle).toContainText("Sticky Zoom: Off");

      // Turn on sticky zoom
      await toggle.click();
      await expect(toggle).toContainText("Sticky Zoom: On");
      await expect(toggle).toHaveClass(/active/);

      // Turn off sticky zoom
      await toggle.click();
      await expect(toggle).toContainText("Sticky Zoom: Off");
      await expect(toggle).not.toHaveClass(/active/);
    });

    test("defaults on for narrow screens when no sticky zoom preference is stored", async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.removeItem("tmux-mobile-sticky-zoom");
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      await page.getByTestId("drawer-toggle").click();
      await expect(page.getByTestId("sticky-zoom-toggle")).toContainText("Sticky Zoom: On");
      await expect(page.getByTestId("sticky-zoom-toggle")).toHaveClass(/active/);
    });

    test("sticky zoom state persists across page reloads", async ({ page }) => {
      // Set sticky zoom on via localStorage
      await page.addInitScript(() => {
        localStorage.setItem("tmux-mobile-sticky-zoom", "true");
      });

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

      // Open drawer and verify sticky zoom is on
      await page.getByTestId("drawer-toggle").click();
      await expect(page.getByTestId("sticky-zoom-toggle")).toContainText("Sticky Zoom: On");
    });

    test("shows zoom indicators for active pane in drawer and top bar", async ({ page }, testInfo) => {
      const collectZoomDebug = async (phase: string): Promise<void> => {
        const topIndicator = page.getByTestId("top-zoom-indicator");
        const activePaneIndicator = page.getByTestId("active-pane-zoom-indicator");
        const paneButtons = page.getByRole("button", { name: /^%\d+:/ });

        let tmuxPanes: unknown = null;
        let tmuxPanesError: string | null = null;
        try {
          tmuxPanes = await server.tmux.listPanes("main", 0);
        } catch (error) {
          tmuxPanesError = error instanceof Error ? error.message : String(error);
        }

        const debug = {
          phase,
          topZoomIndicator: {
            ariaLabel: await topIndicator.getAttribute("aria-label"),
            title: await topIndicator.getAttribute("title"),
            text: await topIndicator.textContent()
          },
          activePaneZoomIndicator: {
            count: await activePaneIndicator.count(),
            ariaLabel: await activePaneIndicator.getAttribute("aria-label"),
            title: await activePaneIndicator.getAttribute("title"),
            text: await activePaneIndicator.textContent()
          },
          paneButtons: {
            count: await paneButtons.count(),
            labels: await paneButtons.allTextContents()
          },
          zoomCalls: server.tmux.calls.filter((call) => call.startsWith("zoomPane:")),
          recentTmuxCalls: server.tmux.calls.slice(-30),
          tmuxPanes,
          tmuxPanesError
        };

        const payload = JSON.stringify(debug, null, 2);
        console.error(`[sticky-zoom-debug] ${payload}`);
        await testInfo.attach(`sticky-zoom-${phase}`, {
          body: payload,
          contentType: "application/json"
        });
      };

      const expectZoomIndicators = async (expected: "on" | "off", phase: string): Promise<void> => {
        const expectedAriaLabel = `Pane zoom: ${expected}`;
        try {
          await expect(page.getByTestId("top-zoom-indicator")).toHaveAttribute(
            "aria-label",
            expectedAriaLabel
          );
          await expect(page.getByTestId("active-pane-zoom-indicator")).toHaveAttribute(
            "aria-label",
            expectedAriaLabel
          );
        } catch (error) {
          await collectZoomDebug(phase);
          throw error;
        }
      };

      const initialPanes = await server.tmux.listPanes("main", 0);
      await server.tmux.splitWindow(initialPanes[0].id, "h");

      await page.goto(`${server.baseUrl}/?token=${server.token}`);
      await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);
      await expect(page.getByTestId("top-zoom-indicator")).toHaveAttribute("aria-label", "Pane zoom: off");

      await page.getByTestId("drawer-toggle").click();
      await expect(page.locator(".drawer")).toBeVisible();
      await expect(page.getByTestId("active-pane-zoom-indicator")).toHaveAttribute(
        "aria-label",
        "Pane zoom: off"
      );
      await expect(page.getByRole("button", { name: /^%\d+:/ })).toHaveCount(2);

      const zoomButton = page.getByRole("button", { name: "Zoom Pane" });
      await expect(zoomButton).toBeEnabled();
      const initialZoomCalls = server.tmux.calls.filter((call) => call.startsWith("zoomPane:")).length;
      await zoomButton.click();
      await expect
        .poll(() => server.tmux.calls.filter((call) => call.startsWith("zoomPane:")).length)
        .toBe(initialZoomCalls + 1);
      await expectZoomIndicators("on", "after-first-zoom");

      await zoomButton.click();
      await expect
        .poll(() => server.tmux.calls.filter((call) => call.startsWith("zoomPane:")).length)
        .toBe(initialZoomCalls + 2);
      await expectZoomIndicators("off", "after-second-zoom");
    });
  });

  test.describe("session picker fallback when switch-client fails", () => {
    let server: StartedE2EServer;

    test.beforeAll(async () => {
      server = await startE2EServer({
        sessions: ["work", "dev"],
        defaultSession: "main",
        failSwitchClient: true
      });
    });

    test.afterAll(async () => {
      await server.stop();
    });

    test("clicking session still attaches", async ({ page }) => {
      await page.goto(`${server.baseUrl}/?token=${server.token}`);

      await expect(page.getByTestId("session-picker-overlay")).toBeVisible();
      await page.getByTestId("session-picker-overlay").getByRole("button", { name: "dev" }).click();

      await expect(page.getByTestId("session-picker-overlay")).toHaveCount(0);
      await expect(page.locator(".top-title")).toContainText("Window: 0: shell");
      await expect.poll(() => server.ptyFactory.lastSpawnedSession).toBe("dev");
    });
  });
});
