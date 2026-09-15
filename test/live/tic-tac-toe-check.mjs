#!/usr/bin/env node
// Independent acceptance runner. Usage: node test/live/tic-tac-toe-check.mjs URL OUTPUT_DIR
// DOM contract: buttons [data-cell="0".."8"] with X/O text; role=status;
// New game button; numeric counters [data-score="X"|"O"|"draw"].
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

export const WIN_LINES = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];
const winner = board => ['X', 'O'].find(mark => WIN_LINES.some(line => line.every(index => board[index] === mark)));

// Find a legal game ending in the requested line, never playing beyond an earlier win.
export function winningSequence(mark, target) {
  function search(board, moves) {
    const won = winner(board);
    if (won) return won === mark && target.every(index => board[index] === mark) ? moves : null;
    if (moves.length === 9) return null;
    const turn = moves.length % 2 ? 'O' : 'X';
    for (let index = 0; index < 9; index++) {
      // Winner only occupies this line, so another simultaneous winning line
      // cannot accidentally mask a missing check for the line under test.
      if (board[index] || (turn === mark ? !target.includes(index) : target.includes(index))) continue;
      const next = [...board]; next[index] = turn;
      const found = search(next, [...moves, index]);
      if (found) return found;
    }
    return null;
  }
  const sequence = search(Array(9).fill(''), []);
  assert.ok(sequence, `No valid game for ${mark}: ${target}`);
  return sequence;
}

const cell = (page, index) => page.locator(`button[data-cell="${index}"]`);
const status = page => page.getByRole('status');
const newGame = page => page.getByRole('button', { name: /^new game$/i });
const board = async page => Promise.all(Array.from({ length: 9 }, (_, index) => cell(page, index).innerText().then(text => text.trim())));
async function scores(page) {
  const result = {};
  for (const mark of ['X', 'O', 'draw']) {
    const text = (await page.locator(`[data-score="${mark}"]`).innerText()).trim();
    assert.match(text, /^\d+$/, `${mark} score must be an integer counter`);
    result[mark] = Number(text);
  }
  return result;
}
async function reset(page) {
  const before = await scores(page);
  await newGame(page).click();
  assert.deepEqual(await board(page), Array(9).fill(''), 'New game clears all squares');
  await expect(status(page)).toContainText(/\bX\b/i);
  assert.deepEqual(await scores(page), before, 'New game preserves scores');
}
async function play(page, moves) {
  const before = await scores(page);
  const expected = Array(9).fill('');
  for (const [turn, index] of moves.entries()) {
    await cell(page, index).click();
    expected[index] = turn % 2 ? 'O' : 'X';
    await expect(cell(page, index)).toHaveText(expected[index]);
    assert.deepEqual(await board(page), expected, 'Only the selected square changes');
    if (turn < moves.length - 1) {
      assert.deepEqual(await scores(page), before, 'No premature score increment');
      await expect(status(page)).toContainText(turn % 2 ? /\bX\b/i : /\bO\b/i);
    }
  }
  return before;
}
async function assertLocked(page) {
  const beforeBoard = await board(page);
  const beforeScores = await scores(page);
  const beforeStatus = await status(page).innerText();
  for (let index = 0; index < 9; index++) {
    if (!await cell(page, index).isDisabled()) await cell(page, index).click();
  }
  assert.deepEqual(await board(page), beforeBoard, 'Game over locks the board');
  assert.deepEqual(await scores(page), beforeScores, 'Repeated clicks do not increment scores');
  assert.equal(await status(page).innerText(), beforeStatus, 'Game over status stays visible');
}

export async function run(siteUrl, outputDir) {
  const url = new URL(siteUrl);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'Use an HTTP(S) site URL');
  const destination = path.resolve(outputDir);
  await fs.mkdir(destination, { recursive: true });
  const report = { siteUrl: url.href, startedAt: new Date().toISOString(), tests: [], passed: false };
  let browser;
  async function check(name, verify, width = 1280) {
    const entry = { name, passed: false };
    report.tests.push(entry);
    let page;
    try {
      page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await expect(page.locator('button[data-cell]')).toHaveCount(9);
      await expect(status(page)).toHaveCount(1);
      await verify(page);
      entry.passed = true;
    } catch (error) { entry.error = error.stack || String(error); }
    finally {
      if (page) {
        entry.screenshot = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        await page.screenshot({ path: path.join(destination, entry.screenshot), fullPage: true }).catch(error => { entry.screenshotError = String(error); });
        await page.close();
      }
    }
    console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${name}`);
  }
  try {
    browser = await chromium.launch({ headless: true });
    await check('Alternation and occupied-square protection', async page => {
      await reset(page);
      const before = await scores(page);
      await cell(page, 0).click();
      await expect(cell(page, 0)).toHaveText('X');
      await expect(status(page)).toContainText(/\bO\b/i);
      if (!await cell(page, 0).isDisabled()) await cell(page, 0).click();
      await expect(cell(page, 0)).toHaveText('X');
      await expect(status(page)).toContainText(/\bO\b/i);
      await cell(page, 1).click();
      await expect(cell(page, 1)).toHaveText('O');
      await expect(status(page)).toContainText(/\bX\b/i);
      assert.deepEqual(await scores(page), before);
      await reset(page);
    });
    for (const mark of ['X', 'O']) for (const [index, line] of WIN_LINES.entries()) {
      await check(`${mark} wins line ${index + 1} (${line.join(',')})`, async page => {
        await reset(page);
        const before = await play(page, winningSequence(mark, line));
        await expect(status(page)).toContainText(new RegExp(`\\b${mark}\\b`, 'i'));
        await expect(status(page)).toContainText(/win|won|winner/i);
        assert.deepEqual(await scores(page), { ...before, [mark]: before[mark] + 1 });
        await assertLocked(page);
        await reset(page);
      });
    }
    await check('Draw and cumulative scoreboard', async page => {
      await reset(page);
      const before = await play(page, [0,1,2,4,3,5,7,6,8]);
      await expect(status(page)).toContainText(/draw|tie/i);
      assert.deepEqual(await scores(page), { ...before, draw: before.draw + 1 });
      await assertLocked(page);
      await reset(page);
      await play(page, winningSequence('X', WIN_LINES[0]));
      assert.deepEqual(await scores(page), { X: before.X + 1, O: before.O, draw: before.draw + 1 });
      await reset(page);
    });
    await check('Keyboard and live status', async page => {
      await reset(page);
      await expect(status(page)).toHaveAttribute('aria-live', 'polite');
      const appearance = element => {
        const css = getComputedStyle(element);
        return { outline: `${css.outlineStyle} ${css.outlineWidth} ${css.outlineColor}`, border: `${css.borderStyle} ${css.borderWidth} ${css.borderColor}`, shadow: css.boxShadow };
      };
      await page.locator('body').click({ position: { x: 0, y: 0 } });
      const unfocused = await cell(page, 0).evaluate(appearance);
      let reached = false;
      for (let presses = 0; presses < 30; presses++) {
        await page.keyboard.press('Tab');
        reached = await cell(page, 0).evaluate(element => element === document.activeElement);
        if (reached) break;
      }
      assert.ok(reached, 'First square is reachable using Tab');
      const focused = await cell(page, 0).evaluate(appearance);
      assert.notDeepEqual(focused, unfocused, 'Keyboard focus must visibly change outline, border, or shadow');
      await page.keyboard.press('Enter');
      await expect(cell(page, 0)).toHaveText('X');
      await cell(page, 1).focus();
      await page.keyboard.press('Space');
      await expect(cell(page, 1)).toHaveText('O');
      await expect(status(page)).toContainText(/\bX\b/i);
    });
    for (const width of [390, 1280]) await check(`Layout at ${width}px`, async page => {
      await reset(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), 'No horizontal overflow');
      for (let index = 0; index < 9; index++) {
        await expect(cell(page, index)).toBeVisible();
        const bounds = await cell(page, index).boundingBox();
        assert.ok(bounds.width >= 24 && bounds.height >= 24 && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Squares fit the viewport and meet minimum target size');
      }
    }, width);
    report.passed = report.tests.length === 21 && report.tests.every(test => test.passed);
  } catch (error) { report.error = error.stack || String(error); }
  finally {
    await browser?.close();
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(destination, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , siteUrl, outputDir] = process.argv;
  if (!siteUrl || !outputDir) {
    console.error('Usage: node test/live/tic-tac-toe-check.mjs SITE_URL OUTPUT_DIR');
    process.exitCode = 2;
  } else {
    try {
      const report = await run(siteUrl, outputDir);
      console.log(`${report.tests.filter(test => test.passed).length}/${report.tests.length} checks passed; ${path.resolve(outputDir, 'report.json')}`);
      process.exitCode = report.passed ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 2; }
  }
}
