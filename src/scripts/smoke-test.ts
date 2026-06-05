import { loadConfig } from '../config.js';
import { TfsClient } from '../tfs-client.js';
import { allTools } from '../tools/index.js';
import type {
  TfsRepositoriesResponse,
  TfsRepository,
} from '../models/tfs.js';

interface SmokeCase {
  tool: string;
  args: Record<string, unknown>;
}

const cases: SmokeCase[] = [
  { tool: 'tfs_testconnection', args: {} },
  { tool: 'tfs_getprojects', args: {} },
  {
    tool: 'tfs_searchworkitems',
    args: { project: 'Seller', searchTerm: 'bug', maxResults: 1 },
  },
  { tool: 'tfs_getrepositories', args: { project: 'Seller' } },
  {
    tool: 'tfs_getbuilddefinitions',
    args: { project: 'Seller', maxResults: 5 },
  },
  {
    tool: 'tfs_getreleasedefinitions',
    args: { project: 'Seller', maxResults: 5 },
  },
];

async function runCase(
  c: SmokeCase,
  ctx: { client: TfsClient }
): Promise<boolean> {
  const tool = allTools.find((t) => t.name === c.tool);
  if (!tool) {
    console.error(`SKIP ${c.tool} — not registered`);
    return false;
  }
  try {
    const out = await tool.handler(c.args, ctx);
    const isFailure = out.startsWith('❌');
    if (isFailure) {
      console.error(`FAIL ${c.tool}\n${out}\n`);
      return false;
    }
    console.error(`PASS ${c.tool}`);
    return true;
  } catch (err) {
    console.error(
      `FAIL ${c.tool} — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

async function findFirstSellerRepoId(client: TfsClient): Promise<string | null> {
  try {
    const url = client.url('/Seller/_apis/git/repositories', {
      'api-version': '6.0',
    });
    const response = await client.get<TfsRepositoriesResponse>(
      url,
      'fetching the repositories'
    );
    const repos: TfsRepository[] = response.value ?? [];
    return repos[0]?.id ?? null;
  } catch (err) {
    console.error(
      `WARN unable to fetch a Seller repo for PR smoke: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TfsClient(config);
  const ctx = { client };

  let pass = 0;
  let fail = 0;

  for (const c of cases) {
    if (await runCase(c, ctx)) pass++;
    else fail++;
  }

  // 2-stage PR smoke: find a repo, then list active PRs on it.
  // Zero PRs is still a PASS (tool returns the "No pull request" branch, no ❌).
  const repoId = await findFirstSellerRepoId(client);
  if (repoId) {
    const prCase: SmokeCase = {
      tool: 'tfs_getpullrequests',
      args: {
        project: 'Seller',
        repositoryId: repoId,
        status: 'active',
        maxResults: 1,
      },
    };
    if (await runCase(prCase, ctx)) pass++;
    else fail++;
  } else {
    console.error(
      'SKIP tfs_getpullrequests — no repository discovered in Seller'
    );
  }

  // cleanbranches smoke — explicit dry-run for safety. May take a while.
  const cleanCase: SmokeCase = {
    tool: 'tfs_cleanbranches',
    args: { project: 'Seller', dryRun: true },
  };
  if (await runCase(cleanCase, ctx)) pass++;
  else fail++;

  console.error(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
