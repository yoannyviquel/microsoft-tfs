import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const ENV_KEYS = ['TFS_TOKEN', 'TFS_BASE_URL', 'TFS_ORG'] as const;

describe('loadConfig', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws when TFS_TOKEN is absent', () => {
    assert.throws(() => loadConfig(), /TFS_TOKEN/);
  });

  it('treats a blank TFS_TOKEN as absent', () => {
    process.env.TFS_TOKEN = '   ';
    assert.throws(() => loadConfig(), /TFS_TOKEN/);
  });

  it('applies defaults for base url and organization', () => {
    process.env.TFS_TOKEN = 'pat';
    const cfg = loadConfig();
    assert.equal(cfg.token, 'pat');
    assert.equal(cfg.baseUrl, 'http://tfs.example.com:8080/tfs');
    assert.equal(cfg.organization, 'DefaultCollection');
  });

  it('trims env values and strips a trailing slash from base url', () => {
    process.env.TFS_TOKEN = '  pat  ';
    process.env.TFS_BASE_URL = '  http://my.tfs/tfs/  ';
    process.env.TFS_ORG = '  MyCollection  ';
    const cfg = loadConfig();
    assert.equal(cfg.token, 'pat');
    assert.equal(cfg.baseUrl, 'http://my.tfs/tfs');
    assert.equal(cfg.organization, 'MyCollection');
  });
});
