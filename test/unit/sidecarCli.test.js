import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)
const roots = []

const runWithInput = (file, args, options, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    } else {
      resolve({ stdout, stderr })
    }
  })
  child.stdin.end(input)
})

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

describe('sidecar CLI', () => {
  it('posts exact text from stdin or a file and requires an escape for literal input flags', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-sidecar-cli-'))
    roots.push(root)
    const fakeBin = path.join(root, 'bin')
    fs.mkdirSync(fakeBin)
    const fakeTmux = path.join(fakeBin, 'tmux')
    fs.writeFileSync(fakeTmux, '#!/bin/sh\nprintf "feather-12345678\\n"\n')
    fs.chmodSync(fakeTmux, 0o755)
    const textFile = path.join(root, 'message.txt')
    fs.writeFileSync(textFile, 'Message loaded from a file.\nSecond line.')

    const requests = []
    const server = http.createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ seq: requests.length }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

    const cli = path.resolve(import.meta.dirname, '../../bin/sidecar')
    const env = {
      ...process.env,
      FEATHER_URL: `http://127.0.0.1:${server.address().port}`,
      FEATHER_SESSION_ID: '',
      FEATHER_BRIDGE_TOKEN: '',
      PATH: `${fakeBin}:${process.env.PATH}`,
    }
    try {
      await runWithInput(
        cli,
        ['post', '--to', 'caretaker', '--group', 'room-feather', '--stdin'],
        { env },
        'Message loaded from stdin.\nSecond line.',
      )
      await run(cli, ['post', '--to', 'caretaker', '--group', 'room-feather', '--file', textFile], { env })
      await run(cli, ['post', '--to', 'caretaker', '--group', 'room-feather', '--', '--file', '/tmp/reference'], { env })

      assert.deepEqual(requests, [
        {
          url: '/api/sidecar/post',
          body: {
            fromPrefix: '12345678',
            to: 'caretaker',
            text: 'Message loaded from stdin.\nSecond line.',
            group: 'room-feather',
          },
        },
        {
          url: '/api/sidecar/post',
          body: {
            fromPrefix: '12345678',
            to: 'caretaker',
            text: 'Message loaded from a file.\nSecond line.',
            group: 'room-feather',
          },
        },
        {
          url: '/api/sidecar/post',
          body: {
            fromPrefix: '12345678',
            to: 'caretaker',
            text: '--file /tmp/reference',
            group: 'room-feather',
          },
        },
      ])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
