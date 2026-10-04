import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSessionLock } from '../src/lock.js';

test('second lock on the same dir fails; release frees it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-'));
  const first = await acquireSessionLock(dir);
  await assert.rejects(acquireSessionLock(dir), error => error.code === 'ELOCKED');
  const other = await acquireSessionLock(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lock-')));
  await other.release();
  await first.release();
  const again = await acquireSessionLock(dir);
  await again.release();
});
