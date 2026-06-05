---
name: microsoft-tfs:doctor
description: Diagnoses the connection to the Microsoft TFS server (Node stdio)
---

# Doctor — microsoft-tfs

Invokes the `tfs_testconnection` MCP tool and reports the result.

Steps:
1. Call the `tfs_testconnection` MCP tool (no arguments).
2. Display the raw response (Markdown).
3. On failure, suggest to the user:
   - Check that `TFS_TOKEN` is set in `~/.claude/settings.json` (the `env` block).
   - Check network access to `http://tfs.example.com:8080/tfs`.
   - Check that the PAT has not expired.
