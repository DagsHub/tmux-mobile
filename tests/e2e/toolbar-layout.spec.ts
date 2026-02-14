import { expect, test } from '@playwright/test';
import { startE2EServer, type StartedE2EServer } from './harness/test-server.js';

let server: StartedE2EServer;

test.beforeAll(async () => {
  server = await startE2EServer({ sessions: ['main'], defaultSession: 'main' });
});

test.afterAll(async () => {
  await server.stop();
});

test('toolbar layout: unified rows with balanced button distribution', async ({ page }) => {
  await page.goto(`${server.baseUrl}/?token=${server.token}`);

  const mainRows = await page.locator('.toolbar-main').all();
  expect(mainRows.length).toBe(2);

  // Row 1: Esc, Ctrl, Alt, Cmd, Meta, /, @, Hm, ↑, Ed (10 buttons)
  const row1Buttons = await mainRows[0].locator('button').all();
  const row1Labels = await Promise.all(row1Buttons.map(b => b.textContent()));
  console.log('Row 1 buttons:', row1Labels);
  expect(row1Buttons.length).toBe(10);
  expect(row1Labels).toEqual(['Esc', 'Ctrl', 'Alt', 'Cmd', 'Meta', '/', '@', 'Hm', '↑', 'Ed']);

  // Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ..., ←, ↓, → (10 buttons)
  const row2Buttons = await mainRows[1].locator('button').all();
  const row2Labels = await Promise.all(row2Buttons.map(b => b.textContent()));
  console.log('Row 2 buttons:', row2Labels);
  expect(row2Buttons.length).toBe(10);
  expect(row2Labels).toEqual(['^C', '^B', '^R', 'Sft', 'Tab', 'Enter', '...', '←', '↓', '→']);

  // ^C should be in row 2, not row 1
  expect(row1Labels).not.toContain('^C');
  expect(row2Labels).toContain('^C');

  // All modifiers should be in the main visible rows
  const allLabels = [...row1Labels, ...row2Labels];
  for (const mod of ['Ctrl', 'Alt', 'Cmd', 'Meta', 'Sft']) {
    expect(allLabels).toContain(mod);
  }

  // All direct children should be buttons (no wrapper divs)
  for (const row of mainRows) {
    const children = await row.locator(':scope > *').all();
    const tags = await Promise.all(children.map(c => c.evaluate(el => el.tagName)));
    expect(tags.every(tag => tag === 'BUTTON')).toBe(true);
  }

  // Buttons should fill the width
  const toolbarBox = await page.locator('.toolbar').boundingBox();
  for (const row of mainRows) {
    const buttons = await row.locator('button').all();
    const firstBtn = await buttons[0].boundingBox();
    const lastBtn = await buttons[buttons.length - 1].boundingBox();
    const rowWidth = (lastBtn!.x + lastBtn!.width) - firstBtn!.x;
    const toolbarContentWidth = toolbarBox!.width - 14;
    console.log(`Row width: ${rowWidth.toFixed(0)}, toolbar content: ${toolbarContentWidth.toFixed(0)}`);
    expect(rowWidth).toBeGreaterThan(toolbarContentWidth * 0.95);
  }

  // Check button sizes are reasonable
  for (const btn of [...row1Buttons, ...row2Buttons]) {
    const box = await btn.boundingBox();
    console.log(`Button "${await btn.textContent()}": h=${box!.height.toFixed(0)} w=${box!.width.toFixed(0)}`);
    expect(box!.height).toBeGreaterThan(25);
  }
});
