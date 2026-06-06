import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFetchMock,
  restoreFetch,
  route,
  routeJson,
  routeError,
  findCall,
  makeCtx,
  BASE,
} from './helpers/fetch-mock.js';
import { runTool, assertOk, assertError } from './helpers/tools.js';

describe('tfs_getbuilds', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists builds with $top and api-version', async () => {
    routeJson('/_apis/build/builds', {
      value: [{ id: 1, buildNumber: '20240101.1', status: 'completed', result: 'succeeded' }],
    });
    const out = await runTool('tfs_getbuilds', { project: 'Seller', maxResults: 5 }, makeCtx());
    assertOk(out);
    assert.match(out, /Builds of project Seller/);
    const call = findCall('GET', `${BASE}/Seller/_apis/build/builds`);
    assert.ok(call);
    assert.match(call.url, /%24top=5/);
    assert.match(call.url, /api-version=6\.0/);
  });

  it('rejects missing project', async () => {
    const out = await runTool('tfs_getbuilds', {}, makeCtx());
    assertError(out);
  });
});

describe('tfs_queuebuild', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('POSTs a build request referencing the definition id', async () => {
    route({ method: 'POST', match: '/_apis/build/builds', respond: { body: { id: 7, buildNumber: 'b7', status: 'inProgress' } } });
    const out = await runTool(
      'tfs_queuebuild',
      { project: 'Seller', definitionId: 42 },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /Build queued successfully/);
    const call = findCall('POST', `${BASE}/Seller/_apis/build/builds`);
    assert.ok(call);
    const body = JSON.parse(call.body ?? '{}');
    assert.equal(body.definition?.id, 42);
  });

  it('rejects a non-integer definitionId without a network call', async () => {
    const out = await runTool('tfs_queuebuild', { project: 'Seller' }, makeCtx());
    assertError(out);
    assert.equal(findCall('POST', '/_apis/build/builds'), undefined);
  });

  it('rejects invalid parametersJson', async () => {
    const out = await runTool(
      'tfs_queuebuild',
      { project: 'Seller', definitionId: 1, parametersJson: '{not json' },
      makeCtx()
    );
    assertError(out);
    assert.match(out, /JSON/);
  });
});

describe('tfs_cancelbuild', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('PATCHes the build to cancelling', async () => {
    route({ method: 'PATCH', match: '/_apis/build/builds/9', respond: { body: { id: 9, status: 'cancelling' } } });
    const out = await runTool('tfs_cancelbuild', { project: 'Seller', buildId: 9 }, makeCtx());
    assertOk(out);
    const call = findCall('PATCH', '/_apis/build/builds/9');
    assert.ok(call);
    assert.match(call.body ?? '', /cancelling/);
  });
});

describe('tfs_getbuilddefinitions', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists build definitions sorted by name', async () => {
    routeJson('/_apis/build/definitions', {
      value: [
        { id: 2, name: 'Zeta', type: 'build', queueStatus: 'enabled' },
        { id: 1, name: 'Alpha', type: 'build', queueStatus: 'enabled' },
      ],
    });
    const out = await runTool('tfs_getbuilddefinitions', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.ok(out.indexOf('Alpha') < out.indexOf('Zeta'), 'definitions should be alphabetically ordered');
    assert.ok(findCall('GET', `${BASE}/Seller/_apis/build/definitions`));
  });

  it('returns ❌ on error', async () => {
    routeError('/_apis/build/definitions', 500, 'Boom');
    const out = await runTool('tfs_getbuilddefinitions', { project: 'Seller' }, makeCtx());
    assertError(out);
  });
});
