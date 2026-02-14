import { expect, test } from "@playwright/test";
import { startE2EServer, type StartedE2EServer } from "./harness/test-server.js";

let server: StartedE2EServer | undefined;

test.beforeAll(async () => {
  server = await startE2EServer({ sessions: ["main"], defaultSession: "main" });
});

test.afterAll(async () => {
  if (server) {
    await server.stop();
  }
});

test("capture UI screenshot for PR preview", async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

  // Wait for terminal to be fully rendered
  await expect(page.getByTestId("terminal-host")).toBeVisible();

  // Emit some sample content so the terminal isn't blank
  await expect.poll(() => server.ptyFactory.processes.length).toBeGreaterThan(0);
  server.ptyFactory.latestProcess().emitData("$ tmux-mobile running\r\n");

  // Small delay for render
  await page.waitForTimeout(500);

  await page.screenshot({
    path: "screenshots/main-view.png",
    fullPage: true
  });
});

test("capture drawer open screenshot", async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);
  await expect(page.getByTestId("top-status-indicator")).toHaveClass(/ok/);

  await page.getByTestId("drawer-toggle").click();
  await expect(page.locator(".drawer")).toBeVisible();

  await page.screenshot({
    path: "screenshots/drawer-open.png",
    fullPage: true
  });
});
