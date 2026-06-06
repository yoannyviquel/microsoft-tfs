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

const PR = {
  pullRequestId: 1,
  title: 'My PR',
  status: 'active',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  repository: { name: 'seller-api', project: { name: 'Seller' } },
  url: 'http://x/pr/1',
};

describe('tfs_getpullrequests', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists active PRs with searchCriteria.status', async () => {
    routeJson('/pullrequests', { value: [PR] });
    const out = await runTool(
      'tfs_getpullrequests',
      { project: 'Seller', repositoryId: 'r1', status: 'active' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /Pull requests of repository r1/);
    const call = findCall('GET', `${BASE}/Seller/_apis/git/repositories/r1/pullrequests`);
    assert.ok(call);
    assert.match(call.url, /searchCriteria\.status=active/);
  });

  it('treats zero PRs as a (non-error) result', async () => {
    routeJson('/pullrequests', { value: [] });
    const out = await runTool(
      'tfs_getpullrequests',
      { project: 'Seller', repositoryId: 'r1', status: 'active' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /No pull request found/);
  });

  it('rejects a missing repositoryId', async () => {
    const out = await runTool('tfs_getpullrequests', { project: 'Seller' }, makeCtx());
    assertError(out);
  });
});

describe('tfs_getpullrequest', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('returns PR details', async () => {
    routeJson('/pullrequests/1', PR);
    const out = await runTool(
      'tfs_getpullrequest',
      { project: 'Seller', repositoryId: 'r1', pullRequestId: 1 },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /My PR/);
  });

  it('reports not found on 404', async () => {
    routeError('/pullrequests/999', 404, 'Not found');
    const out = await runTool(
      'tfs_getpullrequest',
      { project: 'Seller', repositoryId: 'r1', pullRequestId: 999 },
      makeCtx()
    );
    assertError(out);
  });
});

describe('tfs_createpullrequest', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('prefixes the Jira ticket and POSTs the create request', async () => {
    route({ method: 'POST', match: '/pullrequests', respond: { body: { pullRequestId: 5, status: 'active', repository: { name: 'seller-api' } } } });
    const out = await runTool(
      'tfs_createpullrequest',
      {
        project: 'Seller',
        repositoryId: 'r1',
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        jiraTicketId: '1234',
        title: 'Fix shipping',
      },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /#JIRA1234 Fix shipping/);
    const call = findCall('POST', `${BASE}/Seller/_apis/git/repositories/r1/pullrequests`);
    assert.ok(call);
    const body = JSON.parse(call.body ?? '{}');
    assert.equal(body.sourceRefName, 'refs/heads/feature');
    assert.equal(body.title, '#JIRA1234 Fix shipping');
  });

  it('rejects a missing jiraTicketId without a network call', async () => {
    const out = await runTool(
      'tfs_createpullrequest',
      {
        project: 'Seller',
        repositoryId: 'r1',
        sourceRefName: 'refs/heads/feature',
        targetRefName: 'refs/heads/main',
        title: 'Fix',
      },
      makeCtx()
    );
    assertError(out);
    assert.equal(findCall('POST', '/pullrequests'), undefined);
  });
});

describe('tfs_voteonpullrequest', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('resolves the self reviewer via connectionData then PUTs the vote', async () => {
    routeJson('/_apis/connectionData', { authenticatedUser: { id: 'self-1' } });
    route({ method: 'PUT', match: '/reviewers/self-1', respond: { body: { vote: 10 } } });

    const out = await runTool(
      'tfs_voteonpullrequest',
      { project: 'Seller', repositoryId: 'r1', pullRequestId: 1, vote: 'approve' },
      makeCtx()
    );
    assertOk(out);
    assert.ok(findCall('GET', '/_apis/connectionData'), 'expected the self-id lookup');
    assert.ok(findCall('PUT', '/reviewers/self-1'), 'expected the vote PUT');
  });

  it('rejects an invalid vote action without a network call', async () => {
    const out = await runTool(
      'tfs_voteonpullrequest',
      { project: 'Seller', repositoryId: 'r1', pullRequestId: 1, vote: 'sideways' },
      makeCtx()
    );
    assertError(out);
    assert.equal(findCall('GET', '/_apis/connectionData'), undefined);
  });
});
