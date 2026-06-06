import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installFetchMock,
  restoreFetch,
  route,
  routeJson,
  findCall,
  countMethod,
  makeCtx,
} from './helpers/fetch-mock.js';
import { runTool, assertOk, assertError } from './helpers/tools.js';

describe('tfs_cleanbranches (dry-run)', () => {
  beforeEach(installFetchMock);
  afterEach(restoreFetch);

  function wireRepoWithOldBranch(): void {
    // Order matters: most specific URL patterns first (first-match wins).
    routeJson('/refs', {
      value: [
        { name: 'refs/heads/old-feature', objectId: 'aaa' },
        { name: 'refs/heads/master', objectId: 'bbb' },
      ],
    });
    routeJson('/commits/', { committer: { date: '2020-01-01T00:00:00Z' } });
    routeJson('/pullrequests', { value: [] });
    routeJson('/_apis/git/repositories', { value: [{ id: 'r1', name: 'seller-api' }] });
  }

  it('previews deletions without issuing any write request', async () => {
    wireRepoWithOldBranch();

    const out = await runTool('tfs_cleanbranches', { project: 'Seller', dryRun: true }, makeCtx());

    assertOk(out);
    assert.match(out, /DRY RUN/);
    // The stale, non-master, PR-free branch is eligible and shows up in the preview.
    assert.match(out, /old-feature/);
    // master is never deleted.
    assert.doesNotMatch(out, /\/master/);
    // Dry-run must never write: no branch-delete POST/PATCH/PUT/DELETE.
    assert.equal(countMethod('POST'), 0, 'dry-run must not POST');
    assert.equal(countMethod('PATCH'), 0);
    assert.equal(countMethod('PUT'), 0);
    assert.equal(countMethod('DELETE'), 0);
    // It did read the repository list.
    assert.ok(findCall('GET', '/_apis/git/repositories'));
  });

  it('defaults to dry-run when dryRun is omitted', async () => {
    wireRepoWithOldBranch();
    const out = await runTool('tfs_cleanbranches', { project: 'Seller' }, makeCtx());
    assertOk(out);
    assert.match(out, /DRY RUN/);
    assert.equal(countMethod('POST'), 0);
  });

  it('rejects a missing project', async () => {
    const out = await runTool('tfs_cleanbranches', {}, makeCtx());
    assertError(out);
  });
});
