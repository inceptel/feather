import fs from 'fs'
import os from 'os'
import path from 'path'

// PATH for a test server that must never reach the host's real tmux server:
// a tmux with no sessions (every call fails, as on an idle host).
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-no-tmux-'))
fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
process.on('exit', () => fs.rmSync(bin, { recursive: true, force: true }))

export const NO_TMUX_PATH = `${bin}${path.delimiter}${process.env.PATH || ''}`
