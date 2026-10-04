// One writer per pi session. pi-durable has no cross-process lock, so the
// agent listens on a Linux abstract Unix socket named after the session dir
// while it runs. The kernel frees the name when the process dies, so a killed
// agent leaves nothing stale, and a second agent for the same dir fails to
// listen and exits. Abstract names also avoid the 108-byte socket path limit.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function lockName(sessionDir) {
  let dir = path.resolve(sessionDir);
  try { dir = fs.realpathSync(dir); } catch { /* not created yet */ }
  return `\0feather-pi-${createHash('sha256').update(dir).digest('hex').slice(0, 32)}`;
}

export function acquireSessionLock(sessionDir) {
  const name = lockName(sessionDir);
  return new Promise((resolve, reject) => {
    const server = net.createServer(connection => connection.end());
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') reject(Object.assign(new Error('another pi agent is running for this session'), { code: 'ELOCKED' }));
      else reject(error);
    });
    server.listen(name, () => {
      server.unref();
      resolve({ release: () => new Promise(done => server.close(() => done())) });
    });
  });
}
