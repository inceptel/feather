import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { activityDescription, toolImagePath, toolInputDisplay, toolOutputDisplay, toolPresentation } from '../../frontend/src/lib/toolPresentation.js'

describe('Codex tool presentation', () => {
  it('identifies web weather calls even when Codex stores the tool as run', () => {
    assert.deepEqual(
      toolPresentation('run', {
        weather: [{ location: '32250' }],
        response_length: 'short',
      }),
      { name: 'Web', summary: 'Weather · 32250' },
    )
  })

  it('shows useful arguments for unfamiliar tools', () => {
    assert.deepEqual(
      toolPresentation('mystery_tool', { resource_id: 'abc-123' }),
      { name: 'Mystery Tool', summary: 'Resource id · abc-123' },
    )
  })

  it('keeps existing shell command labels and summaries', () => {
    assert.deepEqual(
      toolPresentation('exec_command', { cmd: 'npm test' }),
      { name: 'Bash', summary: 'npm test' },
    )
  })

  it('unwraps Codex exec orchestration to show the nested command', () => {
    assert.deepEqual(
      toolPresentation('exec', {
        raw: 'const r = await tools.exec_command({"cmd":"git status --short","workdir":"/home/user/feather"});\ntext(r.output);',
      }),
      { name: 'Bash', summary: 'git status --short' },
    )
  })

  it('exposes local view_image inputs for Feather previews', () => {
    assert.equal(
      toolImagePath('view_image', { path: '/home/user/feather/uploads/example.png', detail: 'original' }),
      '/home/user/feather/uploads/example.png',
    )
    assert.equal(toolImagePath('read', { path: '/tmp/example.png' }), '')
  })

  it('is total over bounded but malformed bridge arguments', () => {
    assert.doesNotThrow(() => toolPresentation('read', { path: {} }))
    assert.deepEqual(toolPresentation('read', { path: {} }), { name: 'Read', summary: '' })
    assert.deepEqual(toolPresentation('__proto__', {}), { name: 'Proto', summary: '' })
    assert.deepEqual(toolPresentation('exec_command', { cmd: {} }), { name: 'Bash', summary: '' })
  })

  it('turns plumbing tools into intent-first Activity descriptions', () => {
    assert.equal(activityDescription('eval', { title: 'Evaluating Activity state' }), 'Evaluating Activity state')
    assert.equal(activityDescription('bash', { command: 'npm test' }), 'Running npm test')
    assert.equal(activityDescription('grep', { pattern: 'TODO', path: 'src' }), 'Searching TODO in src')
    assert.equal(activityDescription('write', { path: 'src/state.js' }), 'Writing src/state.js')
  })

  it('prefers the declared intent over every tool-derived fallback', () => {
    assert.equal(
      activityDescription('bash', { command: 'git status' }, 'Checking repository state'),
      'Checking repository state',
    )
  })

  it('formats common Activity inputs as readable evidence instead of transport JSON', () => {
    assert.equal(toolInputDisplay('bash', { command: 'printf ok' }), 'printf ok')
    assert.equal(toolInputDisplay('grep', { pattern: 'launch', path: 'notes.md' }), 'Pattern: launch\nPath: notes.md')
    assert.equal(toolInputDisplay('read', { path: 'AGENTS.md', offset: 5, limit: 20 }), 'Path: AGENTS.md\nStart: 5\nLimit: 20')
    assert.equal(toolInputDisplay('glob', { pattern: '*.ts', path: 'frontend/src' }), 'Pattern: *.ts\nPath: frontend/src')
    assert.equal(toolInputDisplay('eval', { language: 'py', title: 'Check state', code: 'print(state)' }), 'Language: py\nPurpose: Check state\n\nprint(state)')
    assert.equal(toolInputDisplay('write', { path: 'state.txt', content: 'ready' }), 'Path: state.txt\n\nready')
    assert.equal(
      toolInputDisplay('exec', { raw: 'await tools.exec_command({\"cmd\":\"git status --short\"})' }),
      'git status --short',
    )
  })

  it('unwraps common tool output envelopes', () => {
    assert.equal(toolOutputDisplay({ output: 'calculation=144' }), 'calculation=144')
    assert.equal(toolOutputDisplay({ text: 'found launch' }), 'found launch')
    assert.equal(toolOutputDisplay({ content: [{ type: 'text', text: 'wrapped output' }] }), 'wrapped output')
    assert.equal(toolOutputDisplay({
      content: [{ type: 'text', text: '[file#tag]\\n1:raw output' }],
      details: { displayContent: { text: 'clean output' } },
    }), 'clean output')
  })
})
