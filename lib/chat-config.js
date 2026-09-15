import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agents = new Set(['claude', 'codex', 'omp']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => Object.assign(new Error(message), { status: 400 });

function role(value, fallback) {
  if (value !== undefined && !record(value)) throw invalid('chat role configuration must be an object');
  const result = { ...fallback, ...value };
  if (!agents.has(result.agent)) throw invalid('unsupported chat agent');
  if (typeof result.model !== 'string' || result.model.length > 200 || (result.model && !/^[a-zA-Z0-9._:/-]+$/.test(result.model))) {
    throw invalid('invalid chat model');
  }
  return result;
}

export function validateChatConfig(value = {}) {
  if (!record(value)) throw invalid('chat configuration must be an object');
  const creator = role(value.creator, { agent: 'claude', model: '' });
  const reviewer = role(value.reviewer, { agent: 'codex', model: '' });
  const standbyPairs = value.standbyPairs ?? 1;
  const reviewPolicy = value.reviewPolicy ?? 'adaptive';
  const progressIntervalMinutes = value.progressIntervalMinutes ?? 15;
  if (!Number.isInteger(standbyPairs) || standbyPairs < 0 || standbyPairs > 4) throw invalid('standbyPairs must be an integer from 0 to 4');
  if (!['adaptive', 'always'].includes(reviewPolicy)) throw invalid('unsupported review policy');
  if (!Number.isInteger(progressIntervalMinutes) || progressIntervalMinutes < 1 || progressIntervalMinutes > 1440) throw invalid('progressIntervalMinutes must be an integer from 1 to 1440');
  return { creator, reviewer, standbyPairs, reviewPolicy, progressIntervalMinutes };
}

export function loadChatConfig({ env = process.env, file = env.FEATHER_CHAT_CONFIG || path.join(os.homedir(), '.feather', 'chat-config.json') } = {}) {
  let value = {};
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (env.FEATHER_CHAT_POOL_SIZE !== undefined) {
    if (!/^\d+$/.test(env.FEATHER_CHAT_POOL_SIZE)) throw invalid('invalid FEATHER_CHAT_POOL_SIZE');
    if (!record(value)) throw invalid('chat configuration must be an object');
    value = { ...value, standbyPairs: Number(env.FEATHER_CHAT_POOL_SIZE) };
  }
  return validateChatConfig(value);
}

export function resolveChatOptions(body = {}, config = validateChatConfig()) {
  if (!record(body)) throw invalid('chat request must be an object');
  config = validateChatConfig(config);
  const creator = role({ agent: body.agent ?? config.creator.agent,
    model: body.model ?? (body.agent && body.agent !== config.creator.agent ? '' : config.creator.model) }, config.creator);
  const reviewer = role({ agent: body.reviewerAgent ?? config.reviewer.agent,
    model: body.reviewerModel ?? (body.reviewerAgent && body.reviewerAgent !== config.reviewer.agent ? '' : config.reviewer.model) }, config.reviewer);
  const policy = validateChatConfig({ ...config, reviewPolicy: body.reviewPolicy ?? config.reviewPolicy,
    progressIntervalMinutes: body.progressIntervalMinutes ?? config.progressIntervalMinutes });
  return { ...body, agent: creator.agent, model: creator.model, reviewerAgent: reviewer.agent, reviewerModel: reviewer.model,
    reviewPolicy: policy.reviewPolicy, progressIntervalMinutes: policy.progressIntervalMinutes };
}
