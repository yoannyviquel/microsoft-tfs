# microsoft-tfs

Microsoft TFS MCP server for Claude Code — Node/TypeScript implementation over stdio.

Port of the original .NET TFS plugin.

## Prerequisites

- Node.js >= 20
- A TFS token (PAT) with access to the target projects

## Installation

### 1. Clone / update the `claude-plugins` repo

```powershell
git clone <your-claude-plugins-repo-url> claude-plugins
# or if already cloned:
cd claude-plugins
git checkout master
git pull
```

### 2. Register the marketplace in Claude Code

```
/plugin marketplace add <path-to>\claude-plugins
```

Do this **once** per machine. Claude Code then remembers the local marketplace.

### 3. Install the plugin

```
/plugin install microsoft-tfs@<marketplace-name>
```

### 4. Configure the TFS token

On install, Claude Code **prompts you directly** (via the plugin's `userConfig`) for:

- **TFS Personal Access Token** (required, stored securely) → `TFS_TOKEN`
- **TFS Base URL** (optional, default `http://tfs.example.com:8080/tfs`) → `TFS_BASE_URL`
- **TFS Collection / Organization** (optional, default `DefaultCollection`) → `TFS_ORG`

These values are injected automatically into the stdio server environment via `${user_config.*}` — **no need to edit `settings.json`**.

Authentication is done **by PAT only** (`TFS_TOKEN`).

> To reconfigure afterwards: `/plugin` → microsoft-tfs → reconfigure.

### 5. Reload the Claude Code config

```
/reload-plugins
```

### 6. **Restart Claude Code** (required on first install and after every update)

```
/exit
```

Then relaunch Claude Code. The MCP stdio process is spawned at startup — `/reload-plugins` does not restart it.

### 7. Verify

```
/microsoft-tfs:doctor
```

Should show the loaded version and confirm the TFS connection.

### Later updates

```
git pull                                  # from claude-plugins/
/plugin                                   # detects the new version
/reload-plugins
/exit                                     # restart Claude to relaunch the MCP stdio process
```

## Available tools (37)

**Connection (1)**: `testconnection`

**Projects (3)**: `getprojects`, `searchprojects`, `getproject`

**Work items (6)**: `createworkitem`, `addcomment`, `searchworkitems`, `getworkitem`, `updateworkitem`, `deleteworkitem`

**Repositories (2)**: `getrepositories`, `searchrepositories`

**Builds (4)**: `getbuilds`, `queuebuild`, `cancelbuild`, `getbuilddefinitions`

**Releases (7)**: `getreleasedefinitions`, `getreleases`, `getdeployments`, `deployrelease`, `getreleaseapprovals`, `approverelease`, `abandonrelease`

**Pull Requests (15)**: `getpullrequests`, `getpullrequest`, `createpullrequest`, `updatepullrequest`, `abandonpullrequest`, `voteonpullrequest`, `completepullrequest`, `setautocompletepullrequest`, `markpullrequestdraft`, `publishpullrequest`, `getpullrequestcomments`, `addpullrequestcomment`, `resolvepullrequestcomment`, `getpullrequestdiff`, `getpullrequestiterations`

**Branches (1)**: `cleanbranches`

All names are prefixed with `tfs_` (e.g. `tfs_testconnection`).

## Development

```bash
npm install
npm run build         # produces dist/server.js (ESM bundle, shebang)
npm run dev           # runs the server over stdio via tsx
npm test              # offline E2E tests (fetch is mocked — deterministic, no TFS_TOKEN, no network)
npm run smoke         # E2E smoke test against the real TFS (requires TFS_TOKEN)
npm run typecheck     # typecheck the source (src/)
npm run typecheck:test # typecheck source + tests (test/)
```

### E2E tests (offline)

Tests under `test/` exercise the real path `args → handler → TfsClient → fetch → markdown`,
replacing only `globalThis.fetch` with a route-driven fake (`test/helpers/fetch-mock.ts`).
No network, no PAT: they run anywhere and in CI. Each tool has at least a happy-path case
(plus an assertion on the URL/method actually called), an error case, and argument validation
where relevant. `test/registry.test.ts` locks down the set of 39 exposed tools. To add a tool,
update `EXPECTED_TOOLS` (a deliberate API change) and add its file to the `test` script in `package.json`.

## Architecture

See `src/server.ts` for the MCP bootstrap. Tools are registered via a flat `ToolDefinition[]` list aggregated in `src/tools/index.ts`.
