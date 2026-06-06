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

describe('tfs_getreleasedefinitions', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists definitions using the 5.1-preview.3 api-version', async () => {
    routeJson('/_apis/release/definitions', { value: [{ id: 1, name: 'Deploy' }] });
    const out = await runTool('tfs_getreleasedefinitions', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.match(out, /Release definitions/);
    const call = findCall('GET', `${BASE}/Seller/_apis/release/definitions`);
    assert.ok(call);
    assert.match(call.url, /api-version=5\.1-preview\.3/);
  });

  it('returns ❌ on error', async () => {
    routeError('/_apis/release/definitions', 500, 'Boom');
    const out = await runTool('tfs_getreleasedefinitions', { project: 'Seller' }, makeCtx());
    assertError(out);
  });
});

describe('tfs_getreleases', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists releases with environments', async () => {
    routeJson('/_apis/release/releases', {
      value: [{ id: 10, name: 'Release-10', status: 'active', environments: [{ id: 1, name: 'prod', status: 'succeeded' }] }],
    });
    const out = await runTool('tfs_getreleases', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.match(out, /Releases of project Seller/);
    assert.match(out, /prod/);
  });
});

describe('tfs_getdeployments', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('fetches deployments', async () => {
    routeJson('/_apis/release/deployments', {
      value: [{ id: 1, deploymentStatus: 'succeeded', releaseEnvironment: { name: 'prod' } }],
    });
    const out = await runTool('tfs_getdeployments', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.ok(findCall('GET', `${BASE}/Seller/_apis/release/deployments`));
  });
});

describe('tfs_getreleaseapprovals', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('fetches pending approvals', async () => {
    routeJson('/_apis/release/approvals', { value: [{ id: 1, status: 'pending' }] });
    const out = await runTool('tfs_getreleaseapprovals', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.ok(findCall('GET', `${BASE}/Seller/_apis/release/approvals`));
  });
});

describe('tfs_deployrelease', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('resolves the environment then PATCHes it to inProgress', async () => {
    routeJson('/_apis/release/releases/10', {
      id: 10,
      name: 'Release-10',
      environments: [{ id: 5, name: 'prod' }],
    }, 'GET');
    route({ method: 'PATCH', match: '/environments/5', respond: { body: { id: 5, status: 'inProgress' } } });

    const out = await runTool(
      'tfs_deployrelease',
      { project: 'Seller', releaseId: 10, environmentName: 'prod' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /Deployment triggered/);
    assert.ok(findCall('GET', '/_apis/release/releases/10'), 'expected the release lookup');
    assert.ok(findCall('PATCH', '/_apis/release/releases/10/environments/5'), 'expected the env PATCH');
  });

  it('rejects when neither environmentName nor environmentId is given', async () => {
    const out = await runTool('tfs_deployrelease', { project: 'Seller', releaseId: 10 }, makeCtx());
    assertError(out);
    assert.equal(findCall('GET', '/_apis/release/releases/10'), undefined);
  });

  it('errors when the environment is not found on the release', async () => {
    routeJson('/_apis/release/releases/10', { id: 10, environments: [{ id: 1, name: 'recette' }] });
    const out = await runTool(
      'tfs_deployrelease',
      { project: 'Seller', releaseId: 10, environmentName: 'prod' },
      makeCtx()
    );
    assertError(out);
    assert.match(out, /not found/);
  });
});

describe('tfs_approverelease', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('PATCHes the approval as approved', async () => {
    route({ method: 'PATCH', match: '/_apis/release/approvals/7', respond: { body: { id: 7, status: 'approved' } } });
    const out = await runTool(
      'tfs_approverelease',
      { project: 'Seller', approvalId: 7, status: 'approved' },
      makeCtx()
    );
    assertOk(out);
    assert.ok(findCall('PATCH', '/_apis/release/approvals/7'));
  });

  it('rejects an invalid status', async () => {
    const out = await runTool(
      'tfs_approverelease',
      { project: 'Seller', approvalId: 7, status: 'maybe' },
      makeCtx()
    );
    assertError(out);
  });
});

describe('tfs_abandonrelease', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('PATCHes the release to abandoned', async () => {
    route({ method: 'PATCH', match: '/_apis/release/releases/10', respond: { body: { id: 10, status: 'abandoned' } } });
    const out = await runTool(
      'tfs_abandonrelease',
      { project: 'Seller', releaseId: 10, comment: 'regression' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /abandoned successfully/);
  });

  it('requires an abandon comment', async () => {
    const out = await runTool('tfs_abandonrelease', { project: 'Seller', releaseId: 10, comment: '' }, makeCtx());
    assertError(out);
  });
});
