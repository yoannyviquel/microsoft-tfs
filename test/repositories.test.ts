import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFetchMock,
  restoreFetch,
  routeJson,
  routeError,
  findCall,
  makeCtx,
  BASE,
} from './helpers/fetch-mock.js';
import { runTool, assertOk, assertError } from './helpers/tools.js';

const REPOS = {
  count: 2,
  value: [
    { id: 'r1', name: 'seller-api', defaultBranch: 'refs/heads/main', size: 2048, remoteUrl: 'http://x/r1', url: 'http://x/r1' },
    { id: 'r2', name: 'seller-web', defaultBranch: 'refs/heads/main', size: 0, url: 'http://x/r2' },
  ],
};

describe('tfs_getrepositories', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists repositories for a project', async () => {
    routeJson('/_apis/git/repositories', REPOS);
    const out = await runTool('tfs_getrepositories', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.match(out, /Repositories of project Seller \(2\)/);
    assert.match(out, /seller-api/);
    const call = findCall('GET', `${BASE}/Seller/_apis/git/repositories`);
    assert.ok(call);
    assert.match(call.url, /api-version=6\.0/);
  });

  it('rejects a missing project without a network call', async () => {
    const out = await runTool('tfs_getrepositories', {}, makeCtx());
    assertError(out);
    assert.equal(findCall('GET', '/_apis/git/repositories'), undefined);
  });

  it('returns ❌ on error', async () => {
    routeError('/_apis/git/repositories', 403, 'Forbidden');
    const out = await runTool('tfs_getrepositories', { project: 'Seller' }, makeCtx());
    assertError(out);
  });
});

describe('tfs_searchrepositories', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('filters repositories by name', async () => {
    routeJson('/_apis/git/repositories', REPOS);
    const out = await runTool(
      'tfs_searchrepositories',
      { project: 'Seller', searchTerm: 'web' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /seller-web/);
    assert.doesNotMatch(out, /seller-api/);
  });
});
