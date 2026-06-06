import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFetchMock,
  restoreFetch,
  routeJson,
  routeError,
  findCall,
  BASE,
} from './helpers/fetch-mock.js';
import { makeCtx } from './helpers/fetch-mock.js';
import { runTool, assertOk, assertError } from './helpers/tools.js';

describe('tfs_testconnection', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('returns success and hits /_apis/projects with api-version', async () => {
    routeJson('/_apis/projects', { count: 1, value: [{ id: 'p1' }] });

    const out = await runTool('tfs_testconnection', {}, makeCtx());

    assertOk(out);
    assert.match(out, /Microsoft TFS connection successful/);

    const call = findCall('GET', `${BASE}/_apis/projects`);
    assert.ok(call, 'expected a GET to /_apis/projects');
    assert.match(call.url, /api-version=6\.0/);
    assert.match(call.url, /%24top=1/); // $top=1 url-encoded
    // Basic auth header built from the PAT (":test-pat" base64).
    assert.match(call.headers.Authorization ?? '', /^Basic /);
  });

  it('returns the ❌ branch on 401', async () => {
    routeError('/_apis/projects', 401, 'Unauthorized');

    const out = await runTool('tfs_testconnection', {}, makeCtx());

    assertError(out);
    assert.match(out, /Microsoft TFS connection failed/);
  });
});
