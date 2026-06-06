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

const PROJECTS = {
  count: 2,
  value: [
    { id: 'p1', name: 'Seller', state: 'wellFormed', visibility: 'private', url: 'http://x/p1' },
    { id: 'p2', name: 'Catalog', state: 'wellFormed', visibility: 'private', url: 'http://x/p2' },
  ],
};

describe('tfs_getprojects', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('lists projects from /_apis/projects', async () => {
    routeJson('/_apis/projects', PROJECTS);
    const out = await runTool('tfs_getprojects', {}, makeCtx());
    assertOk(out);
    assert.match(out, /Available Microsoft TFS projects \(2\)/);
    assert.match(out, /Seller/);
    const call = findCall('GET', `${BASE}/_apis/projects`);
    assert.ok(call);
    assert.match(call.url, /api-version=6\.0/);
  });

  it('returns ❌ on server error', async () => {
    routeError('/_apis/projects', 500, 'Boom');
    const out = await runTool('tfs_getprojects', {}, makeCtx());
    assertError(out);
  });
});

describe('tfs_searchprojects', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('filters client-side by search term', async () => {
    routeJson('/_apis/projects', PROJECTS);
    const out = await runTool('tfs_searchprojects', { searchTerm: 'sell' }, makeCtx());
    assertOk(out);
    assert.match(out, /Projects found for 'sell'/);
    assert.match(out, /Seller/);
    assert.doesNotMatch(out, /Catalog/);
  });

  it('reports no match for an unknown term', async () => {
    routeJson('/_apis/projects', PROJECTS);
    const out = await runTool('tfs_searchprojects', { searchTerm: 'zzz' }, makeCtx());
    assert.match(out, /No project found for 'zzz'/);
  });
});

describe('tfs_getproject', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  it('returns project details, encoding the name in the path', async () => {
    routeJson('/_apis/projects/Seller', PROJECTS.value[0]);
    const out = await runTool('tfs_getproject', { projectName: 'Seller' }, makeCtx());
    assertOk(out);
    assert.match(out, /Details of project Seller/);
    assert.ok(findCall('GET', `${BASE}/_apis/projects/Seller`));
  });

  it('rejects a blank project name without any network call', async () => {
    const out = await runTool('tfs_getproject', { projectName: '  ' }, makeCtx());
    assertError(out);
    assert.equal(findCall('GET', '/_apis/projects'), undefined);
  });
});
