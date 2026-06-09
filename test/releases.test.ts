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

describe('tfs_getreleasedefinition', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('fetches a single definition and lists artifacts + environments', async () => {
    routeJson('/_apis/release/definitions/42', {
      id: 42,
      name: 'Deploy-Seller',
      artifacts: [
        { alias: 'drop', type: 'Build', isPrimary: true },
        { alias: 'secondary', type: 'Build' },
      ],
      environments: [
        { id: 1, name: 'recette', rank: 1 },
        { id: 2, name: 'Prod_BDX', rank: 2 },
      ],
    }, 'GET');
    const out = await runTool(
      'tfs_getreleasedefinition',
      { project: 'Seller', definitionId: 42 },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /Deploy-Seller/);
    assert.match(out, /drop \[Build\] \(primary\)/);
    assert.match(out, /Prod_BDX/);
    const call = findCall('GET', `${BASE}/Seller/_apis/release/definitions/42`);
    assert.ok(call);
    assert.match(call.url, /api-version=5\.1-preview\.3/);
  });

  it('requires a definition ID', async () => {
    const out = await runTool('tfs_getreleasedefinition', { project: 'Seller' }, makeCtx());
    assertError(out);
  });
});

describe('tfs_createrelease', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('POSTs a release with the explicit alias, build instanceReference and manualEnvironments', async () => {
    route({
      method: 'POST',
      match: '/_apis/release/releases',
      respond: {
        body: {
          id: 99,
          name: 'Release-99',
          status: 'active',
          environments: [{ id: 1, name: 'recette', status: 'notDeployed' }],
          _links: { web: { href: 'http://tfs.test/web/release/99' } },
        },
      },
    });

    const out = await runTool(
      'tfs_createrelease',
      {
        project: 'Seller',
        definitionId: 42,
        buildId: 12345,
        artifactAlias: 'drop',
        description: 'hotfix branch',
        manualEnvironments: ['Prod_BDX', 'Prod_PAR'],
      },
      makeCtx()
    );

    assertOk(out);
    assert.match(out, /Release created successfully/);
    assert.match(out, /Release-99/);
    assert.match(out, /Prod_BDX, Prod_PAR/);
    assert.match(out, /http:\/\/tfs\.test\/web\/release\/99/);

    const call = findCall('POST', `${BASE}/Seller/_apis/release/releases`);
    assert.ok(call, 'expected the release POST');
    assert.match(call.url, /api-version=6\.0/);
    // No definition GET when alias is explicit.
    assert.equal(findCall('GET', '/_apis/release/definitions/42'), undefined);

    const body = JSON.parse(call.body ?? '{}');
    assert.equal(body.definitionId, 42);
    assert.equal(body.isDraft, false);
    assert.deepEqual(body.artifacts, [
      { alias: 'drop', instanceReference: { id: '12345' } },
    ]);
    assert.deepEqual(body.manualEnvironments, ['Prod_BDX', 'Prod_PAR']);
    assert.equal(body.description, 'hotfix branch');
  });

  it('resolves the artifact alias via GET definition (primary first) when omitted', async () => {
    routeJson('/_apis/release/definitions/42', {
      id: 42,
      artifacts: [
        { alias: 'secondary', type: 'Build' },
        { alias: 'primaryDrop', type: 'Build', isPrimary: true },
      ],
    }, 'GET');
    route({
      method: 'POST',
      match: '/_apis/release/releases',
      respond: { body: { id: 100, name: 'Release-100', status: 'active' } },
    });

    const out = await runTool(
      'tfs_createrelease',
      { project: 'Seller', definitionId: 42, buildId: '777' },
      makeCtx()
    );

    assertOk(out);
    assert.ok(findCall('GET', '/_apis/release/definitions/42'), 'expected the definition lookup');
    const call = findCall('POST', `${BASE}/Seller/_apis/release/releases`);
    assert.ok(call);
    const body = JSON.parse(call.body ?? '{}');
    assert.deepEqual(body.artifacts, [
      { alias: 'primaryDrop', instanceReference: { id: '777' } },
    ]);
    assert.equal(body.manualEnvironments, undefined);
  });

  it('errors when the definition has no artifact and no alias is given', async () => {
    routeJson('/_apis/release/definitions/42', { id: 42, artifacts: [] }, 'GET');
    const out = await runTool(
      'tfs_createrelease',
      { project: 'Seller', definitionId: 42, buildId: 1 },
      makeCtx()
    );
    assertError(out);
    assert.match(out, /no artifact/);
    assert.equal(findCall('POST', '/_apis/release/releases'), undefined);
  });

  it('requires a build ID', async () => {
    const out = await runTool(
      'tfs_createrelease',
      { project: 'Seller', definitionId: 42 },
      makeCtx()
    );
    assertError(out);
  });

  it('returns ❌ on HTTP error from the release POST', async () => {
    route({
      method: 'POST',
      match: '/_apis/release/releases',
      respond: { status: 400, statusText: 'Bad Request', body: { message: 'invalid artifact' } },
    });
    const out = await runTool(
      'tfs_createrelease',
      { project: 'Seller', definitionId: 42, buildId: 1, artifactAlias: 'drop' },
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
