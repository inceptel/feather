import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOmpModel, resolveOmpThinking, ompModelFlags, sanitizeOmpModel } from '../../lib/omp.js'

describe('omp launch config', () => {
  it('defaults the model to gpt-5.6-sol and honors a valid override', () => {
    assert.equal(resolveOmpModel({}), 'openai-codex/gpt-5.6-sol')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'anthropic/claude-opus-4-8' }), 'anthropic/claude-opus-4-8')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'gpt-5.6-sol' }), 'gpt-5.6-sol')
  })

  it('treats empty model as opt-out and rejects shell-unsafe values', () => {
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '' }), '')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: '   ' }), '')
    // Anything with quotes/spaces/semicolons can't be a model id → fall back.
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: "sol'; rm -rf /" }), 'openai-codex/gpt-5.6-sol')
    assert.equal(resolveOmpModel({ FEATHER_OMP_MODEL: 'has space' }), 'openai-codex/gpt-5.6-sol')
  })

  it('defaults thinking to high and accepts only known levels', () => {
    assert.equal(resolveOmpThinking({}), 'high')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'medium' }), 'medium')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'xhigh' }), 'xhigh')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: 'bogus' }), 'high')
    assert.equal(resolveOmpThinking({ FEATHER_OMP_THINKING: '' }), 'high')
  })

  it('sanitizes per-session model overrides: valid id or empty, never a fallback', () => {
    assert.equal(sanitizeOmpModel('anthropic/claude-opus-5'), 'anthropic/claude-opus-5')
    assert.equal(sanitizeOmpModel(' opus '), 'opus')
    assert.equal(sanitizeOmpModel(''), '')
    assert.equal(sanitizeOmpModel(undefined), '')
    assert.equal(sanitizeOmpModel("sol'; rm -rf /"), '')
    assert.equal(sanitizeOmpModel('has space'), '')
  })

  it('builds the flag prefix, omitting empty parts', () => {
    assert.equal(ompModelFlags('openai-codex/gpt-5.6-sol', 'xhigh'), '--model openai-codex/gpt-5.6-sol --thinking xhigh ')
    assert.equal(ompModelFlags('', 'high'), '--thinking high ')
    assert.equal(ompModelFlags('gpt-5.6-sol', ''), '--model gpt-5.6-sol ')
    assert.equal(ompModelFlags('', ''), '')
  })
})
