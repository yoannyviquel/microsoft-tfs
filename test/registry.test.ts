import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allTools } from '../src/tools/index.js';

// The full public tool surface. Adding or removing a tool is a deliberate API
// change — update this list on purpose so the diff documents it.
const EXPECTED_TOOLS = [
  // connection
  'tfs_testconnection',
  // projects
  'tfs_getprojects',
  'tfs_searchprojects',
  'tfs_getproject',
  // work items
  'tfs_createworkitem',
  'tfs_addcomment',
  'tfs_searchworkitems',
  'tfs_getworkitem',
  'tfs_updateworkitem',
  'tfs_deleteworkitem',
  // repositories
  'tfs_searchrepositories',
  'tfs_getrepositories',
  // builds
  'tfs_getbuilds',
  'tfs_queuebuild',
  'tfs_cancelbuild',
  'tfs_getbuilddefinitions',
  // releases
  'tfs_getreleasedefinitions',
  'tfs_getreleasedefinition',
  'tfs_getreleases',
  'tfs_getdeployments',
  'tfs_deployrelease',
  'tfs_getreleaseapprovals',
  'tfs_approverelease',
  'tfs_abandonrelease',
  'tfs_createrelease',
  // pull requests
  'tfs_getpullrequests',
  'tfs_getpullrequest',
  'tfs_createpullrequest',
  'tfs_updatepullrequest',
  'tfs_abandonpullrequest',
  'tfs_voteonpullrequest',
  'tfs_completepullrequest',
  'tfs_setautocompletepullrequest',
  'tfs_markpullrequestdraft',
  'tfs_publishpullrequest',
  'tfs_getpullrequestcomments',
  'tfs_addpullrequestcomment',
  'tfs_resolvepullrequestcomment',
  'tfs_getpullrequestdiff',
  'tfs_getpullrequestiterations',
  // branches
  'tfs_cleanbranches',
].sort();

describe('tool registry', () => {
  it('exposes exactly the expected set of tools', () => {
    const actual = allTools.map((t) => t.name).sort();
    assert.deepEqual(actual, EXPECTED_TOOLS);
  });

  it('has no duplicate tool names', () => {
    const names = allTools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'duplicate tool name detected');
  });

  it('every tool has a non-empty description and an object input schema', () => {
    for (const t of allTools) {
      assert.ok(t.description && t.description.trim().length > 0, `${t.name} missing description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} inputSchema.type must be "object"`);
    }
  });

  it('every required field is declared in properties', () => {
    for (const t of allTools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const req of t.inputSchema.required ?? []) {
        assert.ok(
          props.includes(req),
          `${t.name}: required "${req}" is not declared in properties`
        );
      }
    }
  });

  it('server routing finds known tools and misses unknown ones', () => {
    // Mirrors the lookup in src/server.ts.
    const find = (name: string) => allTools.find((t) => t.name === name);
    assert.ok(find('tfs_testconnection'), 'known tool should resolve');
    assert.equal(find('tfs_does_not_exist'), undefined, 'unknown tool must not resolve');
  });
});
