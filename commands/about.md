---
name: microsoft-tfs:about
description: Displays information about the Microsoft TFS Node plugin (version, config, env status)
---

# About — microsoft-tfs

Shows the user:
1. Plugin version (read from `.claude-plugin/plugin.json`).
2. Status of the expected environment variables:
   - `TFS_TOKEN`: set / not set (without revealing the value) — the only auth method
   - `TFS_BASE_URL` (default: `http://tfs.example.com:8080/tfs`)
   - `TFS_ORG` (default: `DefaultCollection`)
3. MCP tools currently exposed (list from `src/tools/index.ts`).
