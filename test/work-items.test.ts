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

const WI = {
  id: 123,
  url: 'http://x/wit/123',
  fields: {
    'System.Title': 'A bug',
    'System.State': 'Active',
    'System.WorkItemType': 'Bug',
    'System.Priority': 2,
  },
};

describe('tfs_createworkitem', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('POSTs a json-patch document to workitems/$Type', async () => {
    route({ method: 'POST', match: '/_apis/wit/workitems/', respond: { body: { id: 42, url: 'http://x/42' } } });
    const out = await runTool(
      'tfs_createworkitem',
      { project: 'Seller', workItemType: 'Bug', title: 'New bug' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /created successfully/);
    assert.match(out, /\*\*ID:\*\* 42/);
    const call = findCall('POST', `${BASE}/Seller/_apis/wit/workitems/$Bug`);
    assert.ok(call, 'expected POST to workitems/$Bug (type in the path, not encoded)');
    assert.match(call.headers['Content-Type'] ?? '', /json-patch\+json/);
    const patch = JSON.parse(call.body ?? '[]');
    assert.ok(patch.some((op: any) => op.path === '/fields/System.Title' && op.value === 'New bug'));
  });

  it('rejects a missing title without a network call', async () => {
    const out = await runTool(
      'tfs_createworkitem',
      { project: 'Seller', workItemType: 'Bug' },
      makeCtx()
    );
    assertError(out);
    assert.equal(findCall('POST', '/_apis/wit/workitems'), undefined);
  });
});

describe('tfs_getworkitem', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('returns formatted details', async () => {
    routeJson('/_apis/wit/workitems/123', WI);
    const out = await runTool('tfs_getworkitem', { project: 'Seller', workItemId: 123 }, makeCtx());
    assertOk(out);
    assert.match(out, /Details of work item 123/);
    assert.match(out, /A bug/);
  });

  it('reports not found when the API errors', async () => {
    routeError('/_apis/wit/workitems/999', 404, 'Not found');
    const out = await runTool('tfs_getworkitem', { project: 'Seller', workItemId: 999 }, makeCtx());
    assertError(out);
    assert.match(out, /not found/);
  });
});

describe('tfs_searchworkitems', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('runs a WIQL query then batch-fetches the matches', async () => {
    routeJson('/_apis/wit/wiql', { workItems: [{ id: 123 }] }, 'POST');
    route({ method: 'GET', match: '/_apis/wit/workitems?', respond: { body: { count: 1, value: [WI] } } });
    const out = await runTool(
      'tfs_searchworkitems',
      { project: 'Seller', searchTerm: 'bug', maxResults: 5 },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /1 work item\(s\) found/);
    assert.ok(findCall('POST', `${BASE}/Seller/_apis/wit/wiql`), 'expected a WIQL POST');
    assert.ok(findCall('GET', '/_apis/wit/workitems?ids='), 'expected a batch GET with ids=');
  });
});

describe('tfs_addcomment', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('posts a comment to the work item', async () => {
    route({ method: 'POST', match: '/comments', respond: { body: { id: 1 } } });
    const out = await runTool(
      'tfs_addcomment',
      { project: 'Seller', workItemId: 123, comment: 'hello' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /Comment added successfully/);
    assert.ok(findCall('POST', '/_apis/wit/workItems/123/comments'));
  });
});

describe('tfs_updateworkitem', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('PATCHes the changed fields', async () => {
    route({ method: 'PATCH', match: '/_apis/wit/workitems/123', respond: { body: WI } });
    const out = await runTool(
      'tfs_updateworkitem',
      { project: 'Seller', workItemId: 123, state: 'Resolved' },
      makeCtx()
    );
    assertOk(out);
    assert.match(out, /updated successfully/);
    const call = findCall('PATCH', '/_apis/wit/workitems/123');
    assert.ok(call);
    const patch = JSON.parse(call.body ?? '[]');
    assert.ok(patch.some((op: any) => op.path === '/fields/System.State' && op.value === 'Resolved'));
  });

  it('rejects an update with no fields and no network call', async () => {
    const out = await runTool('tfs_updateworkitem', { project: 'Seller', workItemId: 123 }, makeCtx());
    assertError(out);
    assert.equal(findCall('PATCH', '/_apis/wit/workitems/123'), undefined);
  });
});

describe('tfs_deleteworkitem', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('DELETEs the work item', async () => {
    route({ method: 'DELETE', match: '/_apis/wit/workitems/123', respond: { status: 200 } });
    const out = await runTool('tfs_deleteworkitem', { project: 'Seller', workItemId: 123 }, makeCtx());
    assertOk(out);
    assert.match(out, /deleted successfully/);
    assert.ok(findCall('DELETE', '/_apis/wit/workitems/123'));
  });
});
