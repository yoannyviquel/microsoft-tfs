#!/usr/bin/env node

// src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync
} from "fs";
import path from "path";

// src/config.ts
var DEFAULT_BASE_URL = "http://tfs.example.com:8080/tfs";
var DEFAULT_ORG = "DefaultCollection";
function readEnv(name) {
  const raw = process.env[name];
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  return trimmed === "" ? void 0 : trimmed;
}
function loadConfig() {
  const token = readEnv("TFS_TOKEN");
  if (!token) {
    throw new Error(
      "Authentication required: set TFS_TOKEN (PAT) in the env block of ~/.claude/settings.json."
    );
  }
  const baseUrl = (readEnv("TFS_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const organization = readEnv("TFS_ORG") ?? DEFAULT_ORG;
  return { baseUrl, organization, token };
}

// src/auth.ts
function buildBasicAuthHeader(cfg) {
  const encoded = Buffer.from(`:${cfg.token}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

// src/errors.ts
var TfsError = class extends Error {
  operation;
  status;
  responseBody;
  constructor(operation, status, message, responseBody) {
    super(`Microsoft TFS error during ${operation} (${status}): ${message}`);
    this.name = "TfsError";
    this.operation = operation;
    this.status = status;
    this.responseBody = responseBody;
  }
};

// src/tfs-client.ts
var TfsClient = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  cfg;
  _authenticatedUserId;
  get baseUrl() {
    return this.cfg.baseUrl;
  }
  get organization() {
    return this.cfg.organization;
  }
  url(path2, query) {
    const sep = path2.startsWith("/") ? "" : "/";
    let url = `${this.cfg.baseUrl}/${this.cfg.organization}${sep}${path2}`;
    if (!query) return url;
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === void 0 || v === null || v === "") continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length === 0) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
  }
  async request(method, url, body, opts) {
    const headers = {
      "Authorization": buildBasicAuthHeader(this.cfg),
      "Accept": "application/json",
      "User-Agent": "microsoft-tfs/1.0"
    };
    let payload;
    if (body !== void 0) {
      headers["Content-Type"] = opts?.contentType ?? "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      let parsedMessage;
      try {
        const parsed = JSON.parse(text);
        parsedMessage = parsed?.message;
      } catch {
      }
      throw new TfsError(
        opts?.operationName ?? `${method} ${url}`,
        res.status,
        parsedMessage ?? res.statusText ?? "Unknown error",
        text
      );
    }
    if (!text) return void 0;
    return JSON.parse(text);
  }
  get(url, operationName) {
    return this.request("GET", url, void 0, { operationName });
  }
  async getAuthenticatedUserId() {
    if (this._authenticatedUserId && this._authenticatedUserId.length > 0) {
      return this._authenticatedUserId;
    }
    const url = this.url("/_apis/connectionData", { "api-version": "6.0-preview.1" });
    const data = await this.get(
      url,
      "retrieving the authenticated user"
    );
    const id = data?.authenticatedUser?.id;
    if (!id || id.trim().length === 0) {
      throw new Error(
        "Unable to resolve the authenticated user via /_apis/connectionData (id missing)"
      );
    }
    this._authenticatedUserId = id;
    return id;
  }
};

// src/tools/connection.ts
var testConnection = {
  name: "tfs_testconnection",
  description: "Tests the connection to Microsoft TFS and validates the credentials",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  handler: async (_args, { client }) => {
    try {
      const url = client.url("/_apis/projects", { "api-version": "6.0", "$top": 1 });
      await client.get(url, "testing the Microsoft TFS connection");
      return "\u2705 **Microsoft TFS connection successful!**\n\n\u{1F517} **Status:** Authentication validated";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `\u274C **Microsoft TFS connection failed:**

\u26A0\uFE0F ${message}`;
    }
  }
};
var connectionTools = [testConnection];

// src/formatting/icons.ts
var ICON = {
  success: "\u2705",
  error: "\u274C",
  warning: "\u26A0\uFE0F",
  key: "\u{1F511}",
  list: "\u{1F4CB}",
  state: "\u{1F4CA}",
  tag: "\u{1F3F7}\uFE0F",
  bolt: "\u26A1",
  user: "\u{1F464}",
  edit: "\u{1F4DD}",
  calendar: "\u{1F4C5}",
  refresh: "\u{1F504}",
  link: "\u{1F517}",
  branchSource: "\u{1F33F}",
  branchTarget: "\u{1F3AF}",
  flag: "\u{1F3C1}",
  lock: "\u{1F512}",
  merge: "\u{1F500}",
  reviewers: "\u{1F465}"
};
function getChangeTypeIcon(changeType) {
  switch ((changeType ?? "").toLowerCase()) {
    case "add":
      return "\u2705";
    case "edit":
      return "\u270F\uFE0F";
    case "delete":
      return "\u274C";
    case "rename":
      return "\u{1F504}";
    case "merge":
      return "\u{1F500}";
    case "copy":
      return "\u{1F4CB}";
    case "move":
      return "\u{1F4E6}";
    case "branch":
      return "\u{1F33F}";
    case "undelete":
      return "\u267B\uFE0F";
    default:
      return "\u{1F4C4}";
  }
}

// src/formatting/markdown.ts
function formatErrorResponse(operation, error, requestDetails = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [];
  lines.push(`${ICON.error} **Error while ${operation}:**`);
  lines.push("");
  lines.push(`${ICON.warning} ${message}`);
  lines.push("");
  const entries = Object.entries(requestDetails);
  if (entries.length > 0) {
    lines.push(`${ICON.list} **Request details:**`);
    for (const [key, value] of entries) {
      lines.push(`- ${key}: ${value ?? "Not specified"}`);
    }
  }
  return lines.join("\n");
}
var DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
function formatFileSize(bytes) {
  const value = typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let len = value;
  let order = 0;
  while (len >= 1024 && order < sizes.length - 1) {
    order++;
    len /= 1024;
  }
  const rounded = Math.round(len * 100) / 100;
  const formatted = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted} ${sizes[order]}`;
}
function formatDate(iso) {
  if (!iso) return void 0;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return void 0;
  const parts = DATE_FORMATTER.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}
function formatWorkItemDetails(workItem, includeDescription = false) {
  const fields = workItem.fields ?? {};
  const lines = [];
  lines.push(`${ICON.key} **ID:** ${workItem.id ?? ""}`);
  lines.push(`${ICON.list} **Title:** ${fields["System.Title"] ?? "Untitled"}`);
  lines.push(`${ICON.state} **State:** ${fields["System.State"] ?? "Unknown"}`);
  lines.push(`${ICON.tag} **Type:** ${fields["System.WorkItemType"] ?? "Unknown"}`);
  if (fields["System.Priority"] !== void 0 && fields["System.Priority"] !== null) {
    lines.push(`${ICON.bolt} **Priority:** ${fields["System.Priority"]}`);
  }
  if (fields["System.AssignedTo"]) {
    lines.push(`${ICON.user} **Assigned to:** ${fields["System.AssignedTo"].displayName ?? ""}`);
  }
  if (fields["System.CreatedBy"]) {
    lines.push(`${ICON.edit} **Created by:** ${fields["System.CreatedBy"].displayName ?? ""}`);
  }
  const createdDate = formatDate(fields["System.CreatedDate"]);
  if (createdDate) {
    lines.push(`${ICON.calendar} **Created on:** ${createdDate}`);
  }
  const changedDate = formatDate(fields["System.ChangedDate"]);
  if (changedDate) {
    lines.push(`${ICON.refresh} **Modified on:** ${changedDate}`);
  }
  const description = fields["System.Description"];
  if (description) {
    if (includeDescription) {
      lines.push("");
      lines.push(`${ICON.edit} **Description:**`);
      lines.push(description);
    } else {
      const truncated = description.length > 100 ? description.substring(0, 100) + "..." : description;
      lines.push(`${ICON.edit} **Description:** ${truncated}`);
    }
  }
  if (workItem.url) {
    lines.push(`${ICON.link} **Link:** ${workItem.url}`);
  }
  return lines.join("\n") + "\n";
}
function buildPullRequestUrl(project, repositoryName, pullRequestId) {
  const base = (process.env.TFS_BASE_URL?.trim() || "http://tfs.example.com:8080/tfs").replace(/\/+$/, "");
  const org = process.env.TFS_ORG?.trim() || "DefaultCollection";
  return `${base}/${org}/${project}/_git/${repositoryName}/pullrequest/${pullRequestId}`;
}
function formatPullRequestThreadStatus(threadOrStatus) {
  const status = typeof threadOrStatus === "object" && threadOrStatus !== null ? threadOrStatus.status : threadOrStatus;
  if (typeof status === "string") {
    return status.trim().length === 0 ? "unknown" : status;
  }
  if (typeof status === "number" && Number.isFinite(status)) {
    switch (status) {
      case 0:
        return "unknown";
      case 1:
        return "active";
      case 2:
        return "fixed";
      case 3:
        return "wontFix";
      case 4:
        return "closed";
      case 5:
        return "byDesign";
      case 6:
        return "pending";
      default:
        return `numeric(${status})`;
    }
  }
  return "unknown";
}
function formatPullRequestDetails(pullRequest, includeDescription = false) {
  const lines = [];
  lines.push(`${ICON.key} **ID:** ${pullRequest.pullRequestId ?? ""}`);
  lines.push(`${ICON.list} **Title:** ${pullRequest.title ?? ""}`);
  lines.push(`${ICON.state} **Status:** ${pullRequest.status ?? ""}`);
  lines.push(`${ICON.branchSource} **Source branch:** ${pullRequest.sourceRefName ?? ""}`);
  lines.push(`${ICON.branchTarget} **Target branch:** ${pullRequest.targetRefName ?? ""}`);
  if (pullRequest.createdBy) {
    lines.push(`${ICON.user} **Created by:** ${pullRequest.createdBy.displayName ?? ""}`);
  }
  const creationDate = formatDate(pullRequest.creationDate);
  if (creationDate) {
    lines.push(`${ICON.calendar} **Created on:** ${creationDate}`);
  }
  const closedDate = formatDate(pullRequest.closedDate);
  if (closedDate) {
    lines.push(`${ICON.flag} **Closed on:** ${closedDate}`);
  }
  if (pullRequest.closedBy) {
    lines.push(`${ICON.lock} **Closed by:** ${pullRequest.closedBy.displayName ?? ""}`);
  }
  if (pullRequest.isDraft === true) {
    lines.push(`${ICON.edit} **Draft:** Yes`);
  }
  if (pullRequest.mergeStatus && pullRequest.mergeStatus.length > 0) {
    lines.push(`${ICON.merge} **Merge status:** ${pullRequest.mergeStatus}`);
  }
  if (pullRequest.reviewers && pullRequest.reviewers.length > 0) {
    lines.push(`${ICON.reviewers} **Reviewers:** ${pullRequest.reviewers.length}`);
  }
  if (pullRequest.description && pullRequest.description.length > 0) {
    if (includeDescription) {
      lines.push("");
      lines.push(`${ICON.edit} **Description:**`);
      lines.push(pullRequest.description);
    } else {
      const truncated = pullRequest.description.length > 100 ? pullRequest.description.substring(0, 100) + "..." : pullRequest.description;
      lines.push(`${ICON.edit} **Description:** ${truncated}`);
    }
  }
  if (pullRequest.url && pullRequest.url.length > 0) {
    const projectName = pullRequest.repository?.project?.name;
    const repoName = pullRequest.repository?.name;
    if (projectName && projectName.length > 0 && repoName && repoName.length > 0 && typeof pullRequest.pullRequestId === "number") {
      const correctUrl = buildPullRequestUrl(projectName, repoName, pullRequest.pullRequestId);
      lines.push(`${ICON.link} **Link:** ${correctUrl}`);
    } else {
      lines.push(`${ICON.link} **Link:** ${pullRequest.url}`);
    }
  }
  return lines.join("\n") + "\n";
}

// src/tools/projects.ts
function formatDateShort(iso) {
  const formatted = formatDate(iso);
  if (!formatted) return void 0;
  const spaceIdx = formatted.indexOf(" ");
  return spaceIdx >= 0 ? formatted.substring(0, spaceIdx) : formatted;
}
var getProjects = {
  name: "tfs_getprojects",
  description: "Fetches all accessible Microsoft TFS projects",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  handler: async (_args, { client }) => {
    try {
      const url = client.url("/_apis/projects", { "api-version": "6.0" });
      const response = await client.get(
        url,
        "fetching projects"
      );
      const projects = response.value ?? [];
      if (projects.length === 0) {
        return "\u{1F4C1} **No project found**\n\n\u{1F4A1} **You may not have access to any projects or no project is configured**";
      }
      const lines = [];
      lines.push(`\u{1F4C1} **Available Microsoft TFS projects (${projects.length})**`);
      lines.push("");
      for (const project of projects) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${project.id ?? ""}`);
        lines.push(`\u{1F4CB} **Name:** ${project.name ?? ""}`);
        if (project.description) {
          lines.push(`\u{1F4DD} **Description:** ${project.description}`);
        }
        lines.push(`\u{1F4CA} **State:** ${project.state ?? ""}`);
        lines.push(`\u{1F441}\uFE0F **Visibility:** ${project.visibility ?? ""}`);
        const updated = formatDate(project.lastUpdateTime);
        if (updated) {
          lines.push(`\u{1F504} **Last updated:** ${updated}`);
        }
        lines.push(`\u{1F517} **URL:** ${project.url ?? ""}`);
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching projects", err, {});
    }
  }
};
var searchProjects = {
  name: "tfs_searchprojects",
  description: "Searches Microsoft TFS projects by keywords (lightweight alternative to getprojects)",
  inputSchema: {
    type: "object",
    properties: {
      searchTerm: {
        type: "string",
        description: "Search term to filter projects (name or description)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results to return (default 10)"
      }
    },
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const rawSearchTerm = typeof args.searchTerm === "string" ? args.searchTerm : "";
    const rawMax = typeof args.maxResults === "number" ? args.maxResults : 10;
    const maxResults = rawMax <= 0 || rawMax > 50 ? 10 : rawMax;
    try {
      const url = client.url("/_apis/projects", { "api-version": "6.0" });
      const response = await client.get(
        url,
        "searching projects"
      );
      const allProjects = response.value ?? [];
      let projects;
      if (!rawSearchTerm.trim()) {
        projects = allProjects.slice(0, maxResults);
      } else {
        const needle = rawSearchTerm.toLowerCase();
        projects = allProjects.filter((p) => {
          const nameMatch = (p.name ?? "").toLowerCase().includes(needle);
          const descMatch = !!p.description && p.description.toLowerCase().includes(needle);
          return nameMatch || descMatch;
        }).slice(0, maxResults);
      }
      if (projects.length === 0) {
        return rawSearchTerm.trim().length === 0 ? "\u{1F4C1} **No project found**\n\n\u{1F4A1} **You may not have access to any projects or no project is configured**" : `\u{1F50D} **No project found for '${rawSearchTerm}'**

\u{1F4A1} **Try other keywords or check the spelling**`;
      }
      const lines = [];
      const header = !rawSearchTerm.trim() ? `\u{1F4C1} **Microsoft TFS projects (first ${projects.length} results)**` : `\u{1F50D} **Projects found for '${rawSearchTerm}' (${projects.length} results)**`;
      lines.push(header);
      lines.push("");
      for (const project of projects) {
        lines.push("---");
        lines.push(`\u{1F4CB} **${project.name ?? ""}** \`${project.id ?? ""}\``);
        if (project.description) {
          lines.push(`\u{1F4DD} ${project.description}`);
        }
        lines.push(
          `\u{1F4CA} State: ${project.state ?? ""} | \u{1F441}\uFE0F Visibility: ${project.visibility ?? ""}`
        );
        const updatedShort = formatDateShort(project.lastUpdateTime);
        if (updatedShort) {
          lines.push(`\u{1F504} Updated: ${updatedShort}`);
        }
        lines.push("");
      }
      if (projects.length === maxResults) {
        lines.push(
          `\u{1F4A1} *Display limited to ${maxResults} results. Use more specific keywords to refine the search.*`
        );
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("searching projects", err, {
        searchTerm: rawSearchTerm,
        maxResults
      });
    }
  }
};
var getProject = {
  name: "tfs_getproject",
  description: "Fetches the details of a specific Microsoft TFS project",
  inputSchema: {
    type: "object",
    properties: {
      projectName: {
        type: "string",
        description: "The Microsoft TFS project name"
      }
    },
    required: ["projectName"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const projectName = typeof args.projectName === "string" ? args.projectName : "";
    try {
      if (!projectName.trim()) {
        throw new Error("The project name is required");
      }
      const url = client.url(`/_apis/projects/${encodeURIComponent(projectName)}`, {
        "api-version": "6.0"
      });
      let project = null;
      try {
        project = await client.get(url, "fetching the project");
      } catch {
        project = null;
      }
      if (!project) {
        return `\u274C **Project not found**

\u{1F50D} **Searched name:** ${projectName}
\u{1F4A1} **Check that the project name is correct and that you have access permissions**`;
      }
      const lines = [];
      lines.push(`\u{1F4C1} **Details of project ${project.name ?? ""}**`);
      lines.push("");
      lines.push("---");
      lines.push(`\u{1F511} **ID:** ${project.id ?? ""}`);
      lines.push(`\u{1F4CB} **Name:** ${project.name ?? ""}`);
      if (project.description) {
        lines.push(`\u{1F4DD} **Description:** ${project.description}`);
      }
      lines.push(`\u{1F4CA} **State:** ${project.state ?? ""}`);
      lines.push(`\u{1F441}\uFE0F **Visibility:** ${project.visibility ?? ""}`);
      const updated = formatDate(project.lastUpdateTime);
      if (updated) {
        lines.push(`\u{1F504} **Last updated:** ${updated}`);
      }
      lines.push(`\u{1F517} **URL:** ${project.url ?? ""}`);
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the project", err, {
        "Project name": projectName
      });
    }
  }
};
var projectTools = [
  getProjects,
  searchProjects,
  getProject
];

// src/tools/work-items.ts
function requireString(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function requireInteger(value, displayName) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
async function fetchWorkItemsBatch(client, project, ids) {
  if (ids.length === 0) return [];
  const idsParam = ids.join(",");
  const url = client.url(projectPath(project, "/_apis/wit/workitems"), {
    ids: idsParam,
    "api-version": "6.0"
  });
  const response = await client.get(
    url,
    "fetching work items"
  );
  return response.value ?? [];
}
var createWorkItem = {
  name: "tfs_createworkitem",
  description: "Creates a new Microsoft TFS work item",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      workItemType: {
        type: "string",
        description: "The work item type (Bug, Task, User Story, Feature, etc.)"
      },
      title: {
        type: "string",
        description: "The work item title"
      },
      description: {
        type: "string",
        description: "The detailed work item description (optional)"
      },
      assignedTo: {
        type: "string",
        description: "The assigned user (optional)"
      },
      priority: {
        type: "integer",
        description: "The priority (1=Very high, 2=High, 3=Medium, 4=Low) - default 2"
      }
    },
    required: ["project", "workItemType", "title"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const workItemType = typeof args.workItemType === "string" ? args.workItemType : "";
    const title = typeof args.title === "string" ? args.title : "";
    const description = typeof args.description === "string" ? args.description : void 0;
    const assignedTo = typeof args.assignedTo === "string" ? args.assignedTo : void 0;
    const priority = typeof args.priority === "number" ? args.priority : 2;
    try {
      requireString(project, "The project name");
      requireString(workItemType, "The work item type");
      requireString(title, "The title");
      const patchDocument = [];
      patchDocument.push({ op: "add", path: "/fields/System.Title", value: title });
      if (description) {
        patchDocument.push({ op: "add", path: "/fields/System.Description", value: description });
      }
      if (assignedTo) {
        patchDocument.push({ op: "add", path: "/fields/System.AssignedTo", value: assignedTo });
      }
      patchDocument.push({ op: "add", path: "/fields/System.Priority", value: priority });
      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/$${encodeURIComponent(workItemType)}`),
        { "api-version": "6.0" }
      );
      const workItem = await client.request(
        "POST",
        url,
        patchDocument,
        {
          contentType: "application/json-patch+json",
          operationName: "creating the work item"
        }
      );
      const lines = [];
      lines.push("\u2705 **Microsoft TFS work item created successfully!**");
      lines.push("");
      lines.push(`\u{1F194} **ID:** ${workItem.id ?? ""}`);
      lines.push(`\u{1F4C1} **Project:** ${project}`);
      lines.push(`\u{1F4CB} **Title:** ${title}`);
      lines.push(`\u{1F3F7}\uFE0F **Type:** ${workItemType}`);
      lines.push(`\u26A1 **Priority:** ${priority}`);
      if (description) {
        lines.push(`\u{1F4DD} **Description:** ${description}`);
      }
      if (assignedTo) {
        lines.push(`\u{1F464} **Assigned to:** ${assignedTo}`);
      }
      lines.push(`\u{1F517} **Link:** ${workItem.url ?? ""}`);
      return lines.join("\n");
    } catch (err) {
      return formatErrorResponse("creating the Microsoft TFS work item", err, {
        Project: project,
        Type: workItemType,
        Title: title,
        Description: description ?? "None",
        "Assigned to": assignedTo ?? "None",
        Priority: priority
      });
    }
  }
};
var addComment = {
  name: "tfs_addcomment",
  description: "Adds a comment to a Microsoft TFS work item",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      workItemId: {
        type: "integer",
        description: "The work item ID"
      },
      comment: {
        type: "string",
        description: "The comment to add"
      }
    },
    required: ["project", "workItemId", "comment"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const workItemId = typeof args.workItemId === "number" ? args.workItemId : NaN;
    const comment = typeof args.comment === "string" ? args.comment : "";
    try {
      requireString(project, "The project name");
      requireInteger(workItemId, "The work item ID");
      requireString(comment, "The comment");
      const url = client.url(
        projectPath(project, `/_apis/wit/workItems/${workItemId}/comments`),
        { "api-version": "6.0" }
      );
      try {
        await client.request(
          "POST",
          url,
          { text: comment },
          { operationName: "adding the comment" }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `\u274C **Error while adding the comment:**

\u26A0\uFE0F ${message}`;
      }
      const workItemUrl = `${client.baseUrl}/${client.organization}/${encodeURIComponent(project)}/_workitems/edit/${workItemId}`;
      return `\u2705 **Comment added successfully!**

\u{1F511} **Work Item:** ${workItemId}
\u{1F4AC} **Comment:** ${comment}

\u{1F517} **Link:** ${workItemUrl}`;
    } catch (err) {
      return formatErrorResponse("adding the comment", err, {
        Project: project,
        "Work Item ID": Number.isFinite(workItemId) ? workItemId : "",
        Comment: comment
      });
    }
  }
};
var searchWorkItems = {
  name: "tfs_searchworkitems",
  description: "Searches Microsoft TFS work items by ID or title keywords",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      searchTerm: {
        type: "string",
        description: "Search term - work item ID or title keywords"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results to return (default 10)"
      }
    },
    required: ["project", "searchTerm"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const searchTerm = typeof args.searchTerm === "string" ? args.searchTerm : "";
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 10;
    try {
      requireString(project, "The project name");
      requireString(searchTerm, "The search term");
      const numericId = /^-?\d+$/.test(searchTerm.trim()) ? Number.parseInt(searchTerm.trim(), 10) : null;
      const wiql = numericId !== null ? `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Id] = ${numericId}` : `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Title] CONTAINS '${searchTerm}'`;
      const wiqlUrl = client.url(projectPath(project, "/_apis/wit/wiql"), {
        "api-version": "6.0"
      });
      const queryResult = await client.request(
        "POST",
        wiqlUrl,
        { query: wiql },
        { operationName: "searching" }
      );
      const refs = queryResult.workItems ?? [];
      const workItems = refs.length > 0 ? await fetchWorkItemsBatch(
        client,
        project,
        refs.slice(0, maxResults).map((wi) => wi.id)
      ) : [];
      if (workItems.length === 0) {
        return `\u{1F50D} **No work item found for '${searchTerm}' in project '${project}'**

\u{1F4A1} **Suggestions:**
- Check the spelling of the search term
- Use more general keywords
- Search by work item ID`;
      }
      const lines = [];
      lines.push(`\u{1F50D} **Search results for '${searchTerm}' in '${project}'**`);
      lines.push("");
      lines.push(`\u{1F4CA} **${workItems.length} work item(s) found**`);
      lines.push("");
      for (const workItem of workItems) {
        lines.push("---");
        lines.push(formatWorkItemDetails(workItem).trimEnd());
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("searching", err, {
        Project: project,
        "Search term": searchTerm,
        "Maximum number of results": maxResults
      });
    }
  }
};
var getWorkItem = {
  name: "tfs_getworkitem",
  description: "Fetches the complete details of a Microsoft TFS work item",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      workItemId: {
        type: "integer",
        description: "The work item ID"
      }
    },
    required: ["project", "workItemId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const workItemId = typeof args.workItemId === "number" ? args.workItemId : NaN;
    try {
      requireString(project, "The project name");
      requireInteger(workItemId, "The work item ID");
      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { "api-version": "6.0" }
      );
      let workItem = null;
      try {
        workItem = await client.get(
          url,
          "fetching the work item"
        );
      } catch {
        workItem = null;
      }
      if (!workItem || workItem.id === void 0) {
        return `\u274C **Work item not found**

\u{1F50D} **Searched ID:** ${workItemId} in project '${project}'
\u{1F4A1} **Check that the work item ID is correct and that you have access permissions**`;
      }
      const lines = [];
      lines.push(`\u{1F4CB} **Details of work item ${workItem.id}**`);
      lines.push("");
      lines.push("---");
      lines.push(formatWorkItemDetails(workItem, true).trimEnd());
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the work item", err, {
        Project: project,
        "Work Item ID": Number.isFinite(workItemId) ? workItemId : ""
      });
    }
  }
};
var updateWorkItem = {
  name: "tfs_updateworkitem",
  description: "Updates an existing Microsoft TFS work item",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      workItemId: {
        type: "integer",
        description: "The ID of the work item to update"
      },
      title: {
        type: "string",
        description: "The new title (optional)"
      },
      description: {
        type: "string",
        description: "The new description (optional)"
      },
      assignedTo: {
        type: "string",
        description: "The new assignee (optional)"
      },
      state: {
        type: "string",
        description: "The new state (optional)"
      },
      priority: {
        type: "integer",
        description: "The new priority (1-4) (optional)"
      }
    },
    required: ["project", "workItemId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const workItemId = typeof args.workItemId === "number" ? args.workItemId : NaN;
    const title = typeof args.title === "string" ? args.title : void 0;
    const description = typeof args.description === "string" ? args.description : void 0;
    const assignedTo = typeof args.assignedTo === "string" ? args.assignedTo : void 0;
    const state = typeof args.state === "string" ? args.state : void 0;
    const priority = typeof args.priority === "number" ? args.priority : void 0;
    try {
      requireString(project, "The project name");
      requireInteger(workItemId, "The work item ID");
      const hasTitle = !!title && title.trim().length > 0;
      const hasDescription = !!description && description.trim().length > 0;
      const hasAssignedTo = !!assignedTo && assignedTo.trim().length > 0;
      const hasState = !!state && state.trim().length > 0;
      const hasPriority = priority !== void 0 && priority !== null;
      if (!hasTitle && !hasDescription && !hasAssignedTo && !hasState && !hasPriority) {
        throw new Error("At least one field to update must be provided");
      }
      const patchDocument = [];
      if (hasTitle) {
        patchDocument.push({ op: "replace", path: "/fields/System.Title", value: title });
      }
      if (hasDescription) {
        patchDocument.push({
          op: "replace",
          path: "/fields/System.Description",
          value: description
        });
      }
      if (hasAssignedTo) {
        patchDocument.push({
          op: "replace",
          path: "/fields/System.AssignedTo",
          value: assignedTo
        });
      }
      if (hasState) {
        patchDocument.push({ op: "replace", path: "/fields/System.State", value: state });
      }
      if (hasPriority) {
        patchDocument.push({
          op: "replace",
          path: "/fields/System.Priority",
          value: priority
        });
      }
      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { "api-version": "6.0" }
      );
      await client.request("PATCH", url, patchDocument, {
        contentType: "application/json-patch+json",
        operationName: "updating the work item"
      });
      const updateDetails = [];
      if (hasTitle) updateDetails.push(`\u{1F4CB} **Title:** ${title}`);
      if (hasDescription) updateDetails.push(`\u{1F4DD} **Description:** ${description}`);
      if (hasAssignedTo) updateDetails.push(`\u{1F464} **Assigned to:** ${assignedTo}`);
      if (hasState) updateDetails.push(`\u{1F4CA} **State:** ${state}`);
      if (hasPriority) updateDetails.push(`\u26A1 **Priority:** ${priority}`);
      return `\u2705 **Microsoft TFS work item updated successfully!**

\u{1F511} **ID:** ${workItemId}
\u{1F4C1} **Project:** ${project}

**Updated fields:**
` + updateDetails.join("\n");
    } catch (err) {
      return formatErrorResponse("updating the Microsoft TFS work item", err, {
        Project: project,
        "Work Item ID": Number.isFinite(workItemId) ? workItemId : "",
        Title: title ?? "Unchanged",
        Description: description ?? "Unchanged",
        "Assigned to": assignedTo ?? "Unchanged",
        State: state ?? "Unchanged",
        Priority: priority !== void 0 ? priority : "Unchanged"
      });
    }
  }
};
var deleteWorkItem = {
  name: "tfs_deleteworkitem",
  description: "Deletes a Microsoft TFS work item",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      workItemId: {
        type: "integer",
        description: "The ID of the work item to delete"
      }
    },
    required: ["project", "workItemId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const workItemId = typeof args.workItemId === "number" ? args.workItemId : NaN;
    try {
      requireString(project, "The project name");
      requireInteger(workItemId, "The work item ID");
      const url = client.url(
        projectPath(project, `/_apis/wit/workitems/${workItemId}`),
        { "api-version": "6.0" }
      );
      await client.request("DELETE", url, void 0, {
        operationName: "deleting the work item"
      });
      return `\u2705 **Microsoft TFS work item deleted successfully!**

\u{1F511} **Deleted ID:** ${workItemId}
\u{1F4C1} **Project:** ${project}

\u26A0\uFE0F **Warning:** This action is irreversible. The work item and all its associated data have been permanently deleted.`;
    } catch (err) {
      return formatErrorResponse("deleting the Microsoft TFS work item", err, {
        Project: project,
        "Work Item ID": Number.isFinite(workItemId) ? workItemId : ""
      });
    }
  }
};
var workItemTools = [
  createWorkItem,
  addComment,
  searchWorkItems,
  getWorkItem,
  updateWorkItem,
  deleteWorkItem
];

// src/tools/repositories.ts
function requireString2(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath2(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
var searchRepositories = {
  name: "tfs_searchrepositories",
  description: "Searches the Git repositories of a Microsoft TFS project by keywords (lightweight alternative to getrepositories)",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      searchTerm: {
        type: "string",
        description: "Search term to filter the repositories (name)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results to return (default 10)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const rawSearchTerm = typeof args.searchTerm === "string" ? args.searchTerm : "";
    const rawMax = typeof args.maxResults === "number" ? args.maxResults : 10;
    const maxResults = rawMax <= 0 || rawMax > 50 ? 10 : rawMax;
    try {
      requireString2(project, "The project name");
      const url = client.url(
        projectPath2(project, "/_apis/git/repositories"),
        { "api-version": "6.0" }
      );
      const response = await client.get(
        url,
        "searching the repositories"
      );
      const allRepositories = response.value ?? [];
      let repositories;
      if (!rawSearchTerm.trim()) {
        repositories = allRepositories.slice(0, maxResults);
      } else {
        const needle = rawSearchTerm.toLowerCase();
        repositories = allRepositories.filter((r) => (r.name ?? "").toLowerCase().includes(needle)).slice(0, maxResults);
      }
      if (repositories.length === 0) {
        return rawSearchTerm.trim().length === 0 ? `\u{1F4C2} **No repository found for project '${project}'**

\u{1F4A1} **The project may not have any repositories configured**` : `\u{1F50D} **No repository found for '${rawSearchTerm}' in project '${project}'**

\u{1F4A1} **Try different keywords or check the spelling**`;
      }
      const lines = [];
      const header = !rawSearchTerm.trim() ? `\u{1F4C2} **Repositories of project ${project} (first ${repositories.length} results)**` : `\u{1F50D} **Repositories found for '${rawSearchTerm}' in ${project} (${repositories.length} results)**`;
      lines.push(header);
      lines.push("");
      for (const repo of repositories) {
        lines.push("---");
        lines.push(`\u{1F4CB} **${repo.name ?? ""}** \`${repo.id ?? ""}\``);
        if (repo.defaultBranch) {
          lines.push(`\u{1F33F} Branch: ${repo.defaultBranch}`);
        }
        lines.push(`\u{1F4BE} Size: ${formatFileSize(repo.size)}`);
        if (repo.remoteUrl) {
          lines.push(`\u{1F310} URL: ${repo.remoteUrl}`);
        }
        lines.push("");
      }
      if (repositories.length === maxResults) {
        lines.push(
          `\u{1F4A1} *Display limited to ${maxResults} results. Use more specific keywords to refine the search.*`
        );
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("searching the repositories", err, {
        project,
        searchTerm: rawSearchTerm,
        maxResults
      });
    }
  }
};
var getRepositories = {
  name: "tfs_getrepositories",
  description: "Fetches the Git repositories of a Microsoft TFS project",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    try {
      requireString2(project, "The project name");
      const url = client.url(
        projectPath2(project, "/_apis/git/repositories"),
        { "api-version": "6.0" }
      );
      const response = await client.get(
        url,
        "fetching the repositories"
      );
      const repositories = response.value ?? [];
      if (repositories.length === 0) {
        return `\u{1F4C2} **No repository found for project '${project}'**

\u{1F4A1} **The project may not have any repositories configured**`;
      }
      const lines = [];
      lines.push(
        `\u{1F4C2} **Repositories of project ${project} (${repositories.length})**`
      );
      lines.push("");
      for (const repo of repositories) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${repo.id ?? ""}`);
        lines.push(`\u{1F4CB} **Name:** ${repo.name ?? ""}`);
        if (repo.defaultBranch) {
          lines.push(`\u{1F33F} **Default branch:** ${repo.defaultBranch}`);
        }
        lines.push(`\u{1F4BE} **Size:** ${formatFileSize(repo.size)}`);
        if (repo.remoteUrl) {
          lines.push(`\u{1F310} **Remote URL:** ${repo.remoteUrl}`);
        }
        lines.push(`\u{1F517} **Link:** ${repo.url ?? ""}`);
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the repositories", err, {
        Project: project
      });
    }
  }
};
var repositoryTools = [
  searchRepositories,
  getRepositories
];

// src/tools/builds.ts
function requireString3(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function requireInteger2(value, displayName) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath3(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
function parseBuildParameters(parametersJson) {
  if (!parametersJson || !parametersJson.trim()) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(parametersJson);
  } catch {
    throw new Error("The JSON format of the parameters is invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The JSON format of the parameters is invalid");
  }
  const result = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") {
      throw new Error("The JSON format of the parameters is invalid");
    }
    result[k] = v;
  }
  return result;
}
var getBuilds = {
  name: "tfs_getbuilds",
  description: "Fetches the builds of a Microsoft TFS project",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 10)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 10;
    try {
      requireString3(project, "The project name");
      const url = client.url(projectPath3(project, "/_apis/build/builds"), {
        $top: maxResults,
        "api-version": "6.0"
      });
      const response = await client.get(
        url,
        "fetching the builds"
      );
      const builds = response.value ?? [];
      if (builds.length === 0) {
        return `\u{1F528} **No build found for project '${project}'**

\u{1F4A1} **The project may not have any builds configured**`;
      }
      const ordered = [...builds].sort((a, b) => {
        const at = a.startTime ? Date.parse(a.startTime) : 0;
        const bt = b.startTime ? Date.parse(b.startTime) : 0;
        return bt - at;
      });
      const lines = [];
      lines.push(`\u{1F528} **Builds of project ${project} (${builds.length})**`);
      lines.push("");
      for (const build of ordered) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${build.id ?? ""}`);
        lines.push(`\u{1F4CB} **Number:** ${build.buildNumber ?? ""}`);
        lines.push(`\u{1F4CA} **Status:** ${build.status ?? ""}`);
        lines.push(`\u{1F3AF} **Result:** ${build.result ?? ""}`);
        const startedAt = formatDate(build.startTime);
        if (startedAt) {
          lines.push(`\u{1F550} **Started on:** ${startedAt}`);
        }
        const finishedAt = formatDate(build.finishTime);
        if (finishedAt) {
          lines.push(`\u{1F3C1} **Finished on:** ${finishedAt}`);
        }
        if (build.sourceBranch) {
          lines.push(`\u{1F33F} **Branch:** ${build.sourceBranch}`);
        }
        lines.push(`\u{1F517} **Link:** ${build.url ?? ""}`);
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the builds", err, {
        Project: project,
        "Maximum number of results": maxResults
      });
    }
  }
};
var queueBuild = {
  name: "tfs_queuebuild",
  description: "Queues or re-queues a build pipeline on Microsoft TFS",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      definitionId: {
        type: "integer",
        description: "The ID of the build definition (pipeline)"
      },
      sourceBranch: {
        type: "string",
        description: "Source branch (optional, e.g. refs/heads/main)"
      },
      sourceVersion: {
        type: "string",
        description: "Source version / commit ID (optional)"
      },
      parametersJson: {
        type: "string",
        description: 'Build parameters in JSON format (optional, e.g. {"param1":"value1"})'
      }
    },
    required: ["project", "definitionId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const definitionId = typeof args.definitionId === "number" ? args.definitionId : NaN;
    const sourceBranch = typeof args.sourceBranch === "string" ? args.sourceBranch : void 0;
    const sourceVersion = typeof args.sourceVersion === "string" ? args.sourceVersion : void 0;
    const parametersJson = typeof args.parametersJson === "string" ? args.parametersJson : void 0;
    try {
      requireString3(project, "The project name");
      requireInteger2(definitionId, "The build definition ID");
      const parameters = parseBuildParameters(parametersJson);
      const buildRequest = {
        definition: { id: definitionId }
      };
      if (sourceBranch && sourceBranch.trim()) {
        buildRequest.sourceBranch = sourceBranch;
      }
      if (sourceVersion && sourceVersion.trim()) {
        buildRequest.sourceVersion = sourceVersion;
      }
      if (parameters && Object.keys(parameters).length > 0) {
        buildRequest.parameters = JSON.stringify(parameters);
      }
      const url = client.url(projectPath3(project, "/_apis/build/builds"), {
        "api-version": "6.0"
      });
      const build = await client.request(
        "POST",
        url,
        buildRequest,
        { operationName: "queuing the build" }
      );
      let result = `\u2705 **Build queued successfully!**

\u{1F194} **ID:** ${build.id ?? ""}
\u{1F4CB} **Number:** ${build.buildNumber ?? ""}
\u{1F4C1} **Project:** ${project}
\u{1F527} **Definition ID:** ${definitionId}
\u{1F4CA} **Status:** ${build.status ?? ""}
`;
      if (build.sourceBranch) {
        result += `\u{1F33F} **Branch:** ${build.sourceBranch}
`;
      }
      if (build.sourceVersion) {
        result += `\u{1F4CC} **Version:** ${build.sourceVersion}
`;
      }
      const startedAt = formatDate(build.startTime);
      if (startedAt) {
        result += `\u{1F550} **Started on:** ${startedAt}
`;
      }
      result += `\u{1F517} **Link:** ${build.url ?? ""}`;
      return result;
    } catch (err) {
      return formatErrorResponse("queuing the build", err, {
        Project: project,
        "Definition ID": Number.isFinite(definitionId) ? definitionId : "",
        Branch: sourceBranch ?? "Default",
        Version: sourceVersion ?? "Default",
        Parameters: parametersJson ?? "None"
      });
    }
  }
};
var cancelBuild = {
  name: "tfs_cancelbuild",
  description: "Cancels a running or pending Microsoft TFS build",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      buildId: {
        type: "integer",
        description: "The ID of the build to cancel"
      }
    },
    required: ["project", "buildId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const buildId = typeof args.buildId === "number" ? args.buildId : NaN;
    try {
      requireString3(project, "The project name");
      requireInteger2(buildId, "The build ID");
      const url = client.url(
        projectPath3(project, `/_apis/build/builds/${buildId}`),
        { "api-version": "6.0" }
      );
      const build = await client.request(
        "PATCH",
        url,
        { status: "cancelling" },
        { operationName: "cancelling the build" }
      );
      return `\u2705 **Build cancelled successfully!**

\u{1F194} **ID:** ${build.id ?? ""}
\u{1F4CB} **Number:** ${build.buildNumber ?? ""}
\u{1F4C1} **Project:** ${project}
\u{1F4CA} **Status:** ${build.status ?? ""}
\u{1F517} **Link:** ${build.url ?? ""}`;
    } catch (err) {
      return formatErrorResponse("cancelling the build", err, {
        Project: project,
        "Build ID": Number.isFinite(buildId) ? buildId : ""
      });
    }
  }
};
var getBuildDefinitions = {
  name: "tfs_getbuilddefinitions",
  description: "Fetches the build definitions (pipelines) of a Microsoft TFS project",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 50)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 50;
    try {
      requireString3(project, "The project name");
      const url = client.url(
        projectPath3(project, "/_apis/build/definitions"),
        { $top: maxResults, "api-version": "6.0" }
      );
      const response = await client.get(
        url,
        "fetching the build definitions"
      );
      const definitions = response.value ?? [];
      if (definitions.length === 0) {
        return `\u{1F527} **No build definition found for project '${project}'**

\u{1F4A1} **The project may not have any pipelines configured**`;
      }
      const ordered = [...definitions].sort(
        (a, b) => (a.name ?? "").localeCompare(b.name ?? "")
      );
      const lines = [];
      lines.push(
        `\u{1F527} **Build definitions of project ${project} (${definitions.length})**`
      );
      lines.push("");
      for (const definition of ordered) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${definition.id ?? ""}`);
        lines.push(`\u{1F4CB} **Name:** ${definition.name ?? ""}`);
        if (definition.path) {
          lines.push(`\u{1F4C2} **Path:** ${definition.path}`);
        }
        lines.push(`\u{1F3F7}\uFE0F **Type:** ${definition.type ?? ""}`);
        lines.push(`\u{1F4CA} **Status:** ${definition.queueStatus ?? ""}`);
        if (definition.repository && definition.repository.name) {
          lines.push(`\u{1F4E6} **Repository:** ${definition.repository.name}`);
        }
        lines.push(`\u{1F517} **Link:** ${definition.url ?? ""}`);
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the build definitions",
        err,
        {
          Project: project,
          "Maximum number of results": maxResults
        }
      );
    }
  }
};
var buildTools = [
  getBuilds,
  queueBuild,
  cancelBuild,
  getBuildDefinitions
];

// src/tools/releases.ts
function requireString4(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath4(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
function environmentIcon(status) {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "\u2705";
    case "partiallysucceeded":
      return "\u26A0\uFE0F";
    case "failed":
    case "rejected":
    case "canceled":
      return "\u274C";
    case "inprogress":
    case "queued":
    case "scheduled":
      return "\u23F3";
    case "notdeployed":
      return "\u23F8\uFE0F";
    default:
      return "\u2022";
  }
}
function deploymentIcon(status) {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "\u2705";
    case "partiallysucceeded":
      return "\u26A0\uFE0F";
    case "failed":
      return "\u274C";
    case "inprogress":
      return "\u23F3";
    default:
      return "\u2022";
  }
}
var getReleaseDefinitions = {
  name: "tfs_getreleasedefinitions",
  description: "Fetches the release definitions (deployment pipelines) of a Microsoft TFS project",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      searchText: {
        type: "string",
        description: "Search text to filter by name (optional)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 50)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const searchText = typeof args.searchText === "string" ? args.searchText : void 0;
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 50;
    try {
      requireString4(project, "The project name");
      const url = client.url(
        projectPath4(project, "/_apis/release/definitions"),
        {
          $top: maxResults,
          "api-version": "5.1-preview.3",
          searchText: searchText && searchText.trim().length > 0 ? searchText : void 0
        }
      );
      const response = await client.get(
        url,
        "fetching the release definitions"
      );
      const definitions = response.value ?? [];
      if (definitions.length === 0) {
        return `\u{1F680} **No release definition found for project '${project}'**

\u{1F4A1} **The project may not have any release pipelines configured**`;
      }
      const ordered = [...definitions].sort(
        (a, b) => (a.name ?? "").localeCompare(b.name ?? "")
      );
      const lines = [];
      lines.push(
        `\u{1F680} **Release definitions of project ${project} (${definitions.length})**`
      );
      lines.push("");
      for (const definition of ordered) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${definition.id ?? ""}`);
        lines.push(`\u{1F4CB} **Name:** ${definition.name ?? ""}`);
        if (definition.path && definition.path !== "\\") {
          lines.push(`\u{1F4C2} **Path:** ${definition.path}`);
        }
        if (definition.releaseNameFormat) {
          lines.push(`\u{1F3F7}\uFE0F **Format:** ${definition.releaseNameFormat}`);
        }
        const modifiedOn = formatDate(definition.modifiedOn);
        if (modifiedOn) {
          lines.push(`\u{1F504} **Modified on:** ${modifiedOn}`);
        }
        if (definition.url) {
          lines.push(`\u{1F517} **Link:** ${definition.url}`);
        }
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the release definitions",
        err,
        {
          Project: project,
          "Search text": searchText ?? "None",
          "Maximum number of results": maxResults
        }
      );
    }
  }
};
var getReleases = {
  name: "tfs_getreleases",
  description: "Fetches the releases of a Microsoft TFS project with their status per environment (useful to see which version is deployed where)",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      definitionId: {
        type: "integer",
        description: "Release definition ID to filter by (optional)"
      },
      statusFilter: {
        type: "string",
        description: "Release status filter: draft, active, abandoned (optional)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 10)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const definitionId = typeof args.definitionId === "number" ? args.definitionId : void 0;
    const statusFilter = typeof args.statusFilter === "string" ? args.statusFilter : void 0;
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 10;
    try {
      requireString4(project, "The project name");
      const url = client.url(
        projectPath4(project, "/_apis/release/releases"),
        {
          $top: maxResults,
          $expand: "environments",
          "api-version": "5.1-preview.8",
          definitionId,
          statusFilter: statusFilter && statusFilter.trim().length > 0 ? statusFilter : void 0
        }
      );
      const response = await client.get(
        url,
        "fetching the releases"
      );
      const releases = response.value ?? [];
      if (releases.length === 0) {
        return `\u{1F680} **No release found for project '${project}'**`;
      }
      const ordered = [...releases].sort((a, b) => {
        const at = a.createdOn ? Date.parse(a.createdOn) : 0;
        const bt = b.createdOn ? Date.parse(b.createdOn) : 0;
        return bt - at;
      });
      const lines = [];
      lines.push(`\u{1F680} **Releases of project ${project} (${releases.length})**`);
      lines.push("");
      for (const release of ordered) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${release.id ?? ""}`);
        lines.push(`\u{1F4CB} **Name:** ${release.name ?? ""}`);
        lines.push(`\u{1F4CA} **Status:** ${release.status ?? ""}`);
        if (release.releaseDefinition) {
          lines.push(
            `\u{1F527} **Pipeline:** ${release.releaseDefinition.name ?? ""} (ID ${release.releaseDefinition.id ?? ""})`
          );
        }
        const createdOn = formatDate(release.createdOn);
        if (createdOn) {
          lines.push(`\u{1F4C5} **Created on:** ${createdOn}`);
        }
        if (release.createdBy) {
          lines.push(`\u{1F464} **Created by:** ${release.createdBy.displayName ?? ""}`);
        }
        const environments = release.environments ?? [];
        if (environments.length > 0) {
          lines.push(`\u{1F30D} **Environments:**`);
          for (const env of environments) {
            const deployStatus = env.deploymentStatus && env.deploymentStatus.length > 0 ? env.deploymentStatus : env.status ?? "";
            const icon = environmentIcon(deployStatus);
            lines.push(`   ${icon} ${env.name ?? ""}: ${deployStatus}`);
          }
        }
        if (release.url) {
          lines.push(`\u{1F517} **Link:** ${release.url}`);
        }
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the releases", err, {
        Project: project,
        "Definition ID": definitionId !== void 0 ? String(definitionId) : "All",
        "Status filter": statusFilter ?? "None",
        "Maximum number of results": maxResults
      });
    }
  }
};
var getDeployments = {
  name: "tfs_getdeployments",
  description: "Fetches the deployments of a Microsoft TFS project. Helps answer 'which version is in prod?' by filtering by environment and succeeded status.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      definitionId: {
        type: "integer",
        description: "Release definition ID to filter by (optional)"
      },
      environmentName: {
        type: "string",
        description: "Environment name to filter by (e.g. 'prod', 'recette') - client-side filtering (optional)"
      },
      deploymentStatus: {
        type: "string",
        description: "Status filter: succeeded, failed, partiallySucceeded, inProgress, all (optional)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 10)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const definitionId = typeof args.definitionId === "number" ? args.definitionId : void 0;
    const environmentName = typeof args.environmentName === "string" ? args.environmentName : void 0;
    const deploymentStatus = typeof args.deploymentStatus === "string" ? args.deploymentStatus : void 0;
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 10;
    try {
      requireString4(project, "The project name");
      const url = client.url(
        projectPath4(project, "/_apis/release/deployments"),
        {
          $top: maxResults,
          "api-version": "5.1-preview.2",
          definitionId,
          deploymentStatus: deploymentStatus && deploymentStatus.trim().length > 0 ? deploymentStatus : void 0
        }
      );
      const response = await client.get(
        url,
        "fetching the deployments"
      );
      let deployments = response.value ?? [];
      if (environmentName && environmentName.trim().length > 0) {
        const target = environmentName.toLowerCase();
        deployments = deployments.filter(
          (d) => d.releaseEnvironment != null && (d.releaseEnvironment.name ?? "").toLowerCase() === target
        );
      }
      if (deployments.length === 0) {
        const suffix = environmentName && environmentName.length > 0 ? ` on environment '${environmentName}'` : "";
        return `\u{1F4E6} **No deployment found for project '${project}'**${suffix}`;
      }
      const ordered = [...deployments].sort((a, b) => {
        const at = Date.parse(
          a.completedOn ?? a.startedOn ?? a.queuedOn ?? ""
        );
        const bt = Date.parse(
          b.completedOn ?? b.startedOn ?? b.queuedOn ?? ""
        );
        const aVal = Number.isNaN(at) ? 0 : at;
        const bVal = Number.isNaN(bt) ? 0 : bt;
        return bVal - aVal;
      });
      const lines = [];
      lines.push(
        `\u{1F4E6} **Deployments of project ${project} (${deployments.length})**`
      );
      lines.push("");
      for (const deploy of ordered) {
        const icon = deploymentIcon(deploy.deploymentStatus ?? "");
        lines.push("---");
        lines.push(`${icon} **Deployment ID:** ${deploy.id ?? ""}`);
        if (deploy.release) {
          lines.push(
            `\u{1F680} **Release:** ${deploy.release.name ?? ""} (ID ${deploy.release.id ?? ""})`
          );
        }
        if (deploy.releaseDefinition) {
          lines.push(
            `\u{1F527} **Pipeline:** ${deploy.releaseDefinition.name ?? ""} (ID ${deploy.releaseDefinition.id ?? ""})`
          );
        }
        if (deploy.releaseEnvironment) {
          lines.push(
            `\u{1F30D} **Environment:** ${deploy.releaseEnvironment.name ?? ""}`
          );
        }
        lines.push(`\u{1F4CA} **Status:** ${deploy.deploymentStatus ?? ""}`);
        if (deploy.operationStatus) {
          lines.push(`\u2699\uFE0F **Operation:** ${deploy.operationStatus}`);
        }
        if (deploy.reason) {
          lines.push(`\u{1F4A1} **Reason:** ${deploy.reason}`);
        }
        if (deploy.attempt !== void 0 && deploy.attempt > 0) {
          lines.push(`\u{1F501} **Attempt:** ${deploy.attempt}`);
        }
        const queuedOn = formatDate(deploy.queuedOn);
        if (queuedOn) {
          lines.push(`\u{1F4C5} **Queued on:** ${queuedOn}`);
        }
        const startedOn = formatDate(deploy.startedOn);
        if (startedOn) {
          lines.push(`\u{1F550} **Started on:** ${startedOn}`);
        }
        const completedOn = formatDate(deploy.completedOn);
        if (completedOn) {
          lines.push(`\u{1F3C1} **Completed on:** ${completedOn}`);
        }
        if (deploy.requestedFor) {
          lines.push(
            `\u{1F464} **Requested for:** ${deploy.requestedFor.displayName ?? ""}`
          );
        }
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the deployments", err, {
        Project: project,
        "Definition ID": definitionId !== void 0 ? String(definitionId) : "All",
        Environment: environmentName ?? "All",
        Status: deploymentStatus ?? "All",
        "Maximum number of results": maxResults
      });
    }
  }
};
var deployRelease = {
  name: "tfs_deployrelease",
  description: "Deploys (or redeploys) a Microsoft TFS release to a given environment, e.g. preprod, recette, prod. Triggers the stage deployment by setting its status to 'inProgress'. Identify the environment by its name (environmentName) or its ID (environmentId).",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      releaseId: {
        type: "integer",
        description: "The ID of the release to deploy"
      },
      environmentName: {
        type: "string",
        description: "Name of the target environment (e.g. 'preprod', 'recette', 'prod'). Required if environmentId is absent. Case-insensitive."
      },
      environmentId: {
        type: "integer",
        description: "ID of the target environment. Required if environmentName is absent (takes precedence if both are provided)."
      },
      comment: {
        type: "string",
        description: "Comment associated with the deployment (optional)"
      }
    },
    required: ["project", "releaseId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const releaseId = typeof args.releaseId === "number" ? args.releaseId : NaN;
    const environmentName = typeof args.environmentName === "string" ? args.environmentName : void 0;
    const environmentId = typeof args.environmentId === "number" ? args.environmentId : void 0;
    const comment = typeof args.comment === "string" ? args.comment : void 0;
    try {
      requireString4(project, "The project name");
      if (!Number.isInteger(releaseId)) {
        throw new Error("The release ID is required");
      }
      if (environmentId === void 0 && !environmentName) {
        throw new Error(
          "The target environment is required (provide environmentName or environmentId)"
        );
      }
      const releaseUrl = client.url(
        projectPath4(project, `/_apis/release/releases/${releaseId}`),
        { "api-version": "5.1-preview.8" }
      );
      const release = await client.get(
        releaseUrl,
        "fetching the release"
      );
      const environments = release.environments ?? [];
      let target;
      if (environmentId !== void 0) {
        target = environments.find((e) => e.id === environmentId);
      } else if (environmentName) {
        const needle = environmentName.toLowerCase();
        target = environments.find(
          (e) => (e.name ?? "").toLowerCase() === needle
        );
      }
      if (!target || target.id === void 0) {
        const available = environments.length > 0 ? environments.map((e) => `${e.name ?? "?"} (ID ${e.id ?? "?"})`).join(", ") : "none";
        const wanted = environmentId !== void 0 ? `ID ${environmentId}` : `'${environmentName}'`;
        throw new Error(
          `Environment ${wanted} not found on release ${releaseId}. Available environments: ${available}`
        );
      }
      const updateRequest = {
        status: "inProgress"
      };
      if (comment && comment.trim()) {
        updateRequest.comment = comment;
      }
      const deployUrl = client.url(
        projectPath4(
          project,
          `/_apis/release/releases/${releaseId}/environments/${target.id}`
        ),
        { "api-version": "5.1-preview.6" }
      );
      const updated = await client.request(
        "PATCH",
        deployUrl,
        updateRequest,
        { operationName: "deploying the release" }
      );
      const status = updated.status ?? updated.deploymentStatus ?? "inProgress";
      let result = `\u{1F680} **Deployment triggered successfully!**

\u{1F4C1} **Project:** ${project}
\u{1F194} **Release:** ${release.name ?? releaseId} (ID ${releaseId})
\u{1F30D} **Environment:** ${target.name ?? ""} (ID ${target.id})
\u{1F4CA} **Status:** ${status}
`;
      if (comment && comment.trim()) {
        result += `\u{1F4AC} **Comment:** ${comment}
`;
      }
      if (release.url) {
        result += `\u{1F517} **Release link:** ${release.url}
`;
      }
      result += `
\u{1F4A1} Track progress with \`tfs_getreleases\` or \`tfs_getdeployments\`.`;
      return result;
    } catch (err) {
      return formatErrorResponse("deploying the release", err, {
        Project: project,
        "Release ID": Number.isInteger(releaseId) ? releaseId : "",
        Environment: environmentName ?? "None",
        "Environment ID": environmentId !== void 0 ? String(environmentId) : "None",
        Comment: comment ?? "None"
      });
    }
  }
};
function approvalIcon(status) {
  switch (status.toLowerCase()) {
    case "approved":
      return "\u2705";
    case "rejected":
      return "\u274C";
    case "pending":
      return "\u23F3";
    case "reassigned":
      return "\u{1F501}";
    case "canceled":
      return "\u{1F6AB}";
    default:
      return "\u2022";
  }
}
var getReleaseApprovals = {
  name: "tfs_getreleaseapprovals",
  description: "Fetches Microsoft TFS release approvals (pre/post-deployment approval gates). By default lists pending ones to find out which deployment is blocked on an approval. Filterable by release.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      releaseId: {
        type: "integer",
        description: "Release ID to filter the approvals (optional)"
      },
      statusFilter: {
        type: "string",
        description: "Status filter: pending, approved, rejected, reassigned, canceled, all (default pending)"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 25)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const releaseId = typeof args.releaseId === "number" ? args.releaseId : void 0;
    const statusFilter = typeof args.statusFilter === "string" && args.statusFilter.trim().length > 0 ? args.statusFilter : "pending";
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 25;
    try {
      requireString4(project, "The project name");
      const url = client.url(
        projectPath4(project, "/_apis/release/approvals"),
        {
          $top: maxResults,
          "api-version": "5.1-preview.3",
          statusFilter: statusFilter.toLowerCase() === "all" ? void 0 : statusFilter,
          releaseIdsFilter: releaseId
        }
      );
      const response = await client.get(
        url,
        "fetching the release approvals"
      );
      const approvals = response.value ?? [];
      if (approvals.length === 0) {
        const suffix = releaseId !== void 0 ? ` on release ${releaseId}` : "";
        return `\u{1F50F} **No '${statusFilter}' approval found for project '${project}'**${suffix}`;
      }
      const lines = [];
      lines.push(
        `\u{1F50F} **Release approvals of project ${project} (${approvals.length})**`
      );
      lines.push("");
      for (const approval of approvals) {
        const icon = approvalIcon(approval.status ?? "");
        lines.push("---");
        lines.push(`${icon} **Approval ID:** ${approval.id ?? ""}`);
        lines.push(`\u{1F4CA} **Status:** ${approval.status ?? ""}`);
        if (approval.approvalType) {
          lines.push(`\u{1F3F7}\uFE0F **Type:** ${approval.approvalType}`);
        }
        if (approval.release) {
          lines.push(
            `\u{1F680} **Release:** ${approval.release.name ?? ""} (ID ${approval.release.id ?? ""})`
          );
        }
        if (approval.releaseEnvironment) {
          lines.push(
            `\u{1F30D} **Environment:** ${approval.releaseEnvironment.name ?? ""} (ID ${approval.releaseEnvironment.id ?? ""})`
          );
        }
        if (approval.approver) {
          lines.push(
            `\u{1F464} **Assigned to:** ${approval.approver.displayName ?? approval.approver.uniqueName ?? ""}`
          );
        }
        const createdOn = formatDate(approval.createdOn);
        if (createdOn) {
          lines.push(`\u{1F4C5} **Created on:** ${createdOn}`);
        }
        if (approval.comments) {
          lines.push(`\u{1F4AC} **Comment:** ${approval.comments}`);
        }
        lines.push("");
      }
      lines.push(
        `\u{1F4A1} Approve or reject with \`tfs_approverelease\` by passing the **Approval ID**.`
      );
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the release approvals",
        err,
        {
          Project: project,
          "Release ID": releaseId !== void 0 ? String(releaseId) : "All",
          "Status filter": statusFilter,
          "Maximum number of results": maxResults
        }
      );
    }
  }
};
var approveRelease = {
  name: "tfs_approverelease",
  description: "Approves or rejects a Microsoft TFS release approval (pre/post-deployment approval gate). Unblocks (approved) or stops (rejected) the deployment of a pending stage. Get the approvalId via tfs_getreleaseapprovals.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      approvalId: {
        type: "integer",
        description: "The ID of the approval to process (obtained via tfs_getreleaseapprovals)"
      },
      status: {
        type: "string",
        description: "Decision: 'approved' to approve, 'rejected' to reject (default 'approved')"
      },
      comment: {
        type: "string",
        description: "Comment associated with the decision (optional)"
      }
    },
    required: ["project", "approvalId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const approvalId = typeof args.approvalId === "number" ? args.approvalId : NaN;
    const rawStatus = typeof args.status === "string" && args.status.trim().length > 0 ? args.status.trim().toLowerCase() : "approved";
    const comment = typeof args.comment === "string" ? args.comment : void 0;
    try {
      requireString4(project, "The project name");
      if (!Number.isInteger(approvalId)) {
        throw new Error("The approval ID is required");
      }
      if (rawStatus !== "approved" && rawStatus !== "rejected") {
        throw new Error(
          `Invalid status '${rawStatus}'. Accepted values: 'approved' or 'rejected'`
        );
      }
      const updateRequest = {
        status: rawStatus
      };
      if (comment && comment.trim()) {
        updateRequest.comments = comment;
      }
      const approvalUrl = client.url(
        projectPath4(project, `/_apis/release/approvals/${approvalId}`),
        { "api-version": "5.1-preview.3" }
      );
      const updated = await client.request(
        "PATCH",
        approvalUrl,
        updateRequest,
        { operationName: "processing the release approval" }
      );
      const verb = rawStatus === "approved" ? "approved" : "rejected";
      const icon = rawStatus === "approved" ? "\u2705" : "\u274C";
      let result = `${icon} **Approval ${verb} successfully!**

\u{1F4C1} **Project:** ${project}
\u{1F511} **Approval ID:** ${approvalId}
\u{1F4CA} **Status:** ${updated.status ?? rawStatus}
`;
      if (updated.release) {
        result += `\u{1F680} **Release:** ${updated.release.name ?? ""} (ID ${updated.release.id ?? ""})
`;
      }
      if (updated.releaseEnvironment) {
        result += `\u{1F30D} **Environment:** ${updated.releaseEnvironment.name ?? ""}
`;
      }
      if (updated.approvedBy) {
        result += `\u{1F464} **Processed by:** ${updated.approvedBy.displayName ?? ""}
`;
      }
      if (comment && comment.trim()) {
        result += `\u{1F4AC} **Comment:** ${comment}
`;
      }
      result += `
\u{1F4A1} Track the deployment progress with \`tfs_getreleases\` or \`tfs_getdeployments\`.`;
      return result;
    } catch (err) {
      return formatErrorResponse(
        "processing the release approval",
        err,
        {
          Project: project,
          "Approval ID": Number.isInteger(approvalId) ? approvalId : "",
          Decision: rawStatus,
          Comment: comment ?? "None"
        }
      );
    }
  }
};
var abandonRelease = {
  name: "tfs_abandonrelease",
  description: "Abandons a Microsoft TFS release (sets its status to 'abandoned'). Useful to cancel a release that introduces a regression. An explanatory comment is required. Get the releaseId via tfs_getreleases.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The name of the Microsoft TFS project"
      },
      releaseId: {
        type: "integer",
        description: "The ID of the release to abandon"
      },
      comment: {
        type: "string",
        description: "Comment explaining the abandonment (required)"
      }
    },
    required: ["project", "releaseId", "comment"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const releaseId = typeof args.releaseId === "number" ? args.releaseId : NaN;
    const comment = typeof args.comment === "string" ? args.comment : "";
    try {
      requireString4(project, "The project name");
      if (!Number.isInteger(releaseId)) {
        throw new Error("The release ID is required");
      }
      requireString4(comment, "The abandonment comment");
      const updateRequest = {
        status: "abandoned",
        comment
      };
      const releaseUrl = client.url(
        projectPath4(project, `/_apis/release/releases/${releaseId}`),
        { "api-version": "5.1-preview.8", $expand: "environments" }
      );
      const updated = await client.request(
        "PATCH",
        releaseUrl,
        updateRequest,
        { operationName: "abandoning the release" }
      );
      const finalStatus = (updated.status ?? "").toLowerCase();
      if (finalStatus !== "abandoned") {
        const deployed = (updated.environments ?? []).filter((e) => {
          const s = (e.deploymentStatus || e.status || "").toLowerCase();
          return s === "succeeded" || s === "inprogress" || s === "partiallysucceeded";
        }).map((e) => e.name ?? "?");
        const envSuffix = deployed.length > 0 ? ` Environment(s) still deployed: ${deployed.join(", ")}.` : "";
        throw new Error(
          `The abandonment did not take effect: release ${releaseId} is still in status '${updated.status ?? "unknown"}'.${envSuffix} Abandoning a release does not unpublish an already deployed environment \u2014 redeploy the previous version (tfs_deployrelease) or cancel the affected stage.`
        );
      }
      let result = `\u{1F6AB} **Release abandoned successfully!**

\u{1F4C1} **Project:** ${project}
\u{1F194} **Release:** ${updated.name ?? releaseId} (ID ${releaseId})
\u{1F4CA} **Status:** ${updated.status ?? "abandoned"}
\u{1F4AC} **Comment:** ${comment}
`;
      if (updated.url) {
        result += `\u{1F517} **Release link:** ${updated.url}
`;
      }
      return result;
    } catch (err) {
      return formatErrorResponse("abandoning the release", err, {
        Project: project,
        "Release ID": Number.isInteger(releaseId) ? releaseId : "",
        Comment: comment || "None"
      });
    }
  }
};
var releaseTools = [
  getReleaseDefinitions,
  getReleases,
  getDeployments,
  deployRelease,
  getReleaseApprovals,
  approveRelease,
  abandonRelease
];

// src/tools/pull-requests.ts
function requireString5(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath5(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
function repoPath(project, repositoryId, suffix) {
  return projectPath5(
    project,
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}${suffix}`
  );
}
function normalizeRepoPath(path2) {
  if (path2 === void 0 || path2 === null) return "";
  const trimmed = path2.trim();
  if (trimmed.length === 0) return "";
  let p = trimmed.replace(/\\/g, "/");
  if (!p.startsWith("/")) {
    p = "/" + p.replace(/^\/+/, "");
  }
  return p;
}
function basename(p) {
  const cleaned = p.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? cleaned : cleaned.substring(idx + 1);
}
function pathsMatchForPrComment(candidateRepoPath, normalizedTarget) {
  const n = normalizeRepoPath(candidateRepoPath);
  if (n.length === 0 || normalizedTarget.length === 0) return false;
  if (n.toLowerCase() === normalizedTarget.toLowerCase()) return true;
  const a = basename(n);
  const b = basename(normalizedTarget);
  return a.length > 0 && b.length > 0 && a.toLowerCase() === b.toLowerCase();
}
function* enumerateChangePaths(change) {
  if (change.item?.path && change.item.path.trim().length > 0) {
    yield change.item.path;
  }
  if (change.sourceServerItem?.path && change.sourceServerItem.path.trim().length > 0) {
    yield change.sourceServerItem.path;
  }
}
function findMatchingChangeForPath(changes, normalizedTarget) {
  for (const c of changes) {
    for (const path2 of enumerateChangePaths(c)) {
      if (pathsMatchForPrComment(path2, normalizedTarget)) {
        return c;
      }
    }
  }
  return null;
}
function resolveChanges(response) {
  if (response.changeEntries && response.changeEntries.length > 0) {
    return response.changeEntries;
  }
  return response.value ?? [];
}
async function getPullRequestIterations(client, project, repositoryId, pullRequestId) {
  const url = client.url(repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/iterations`), {
    "api-version": "6.0"
  });
  const response = await client.get(
    url,
    "fetching the pull request iterations"
  );
  return response.value ?? [];
}
async function getPullRequestIterationChanges(client, project, repositoryId, pullRequestId, iterationId) {
  const url = client.url(
    repoPath(
      project,
      repositoryId,
      `/pullrequests/${pullRequestId}/iterations/${iterationId}/changes`
    ),
    { "api-version": "6.0" }
  );
  const response = await client.get(
    url,
    "fetching the pull request iteration changes"
  );
  return resolveChanges(response);
}
var getPullRequests = {
  name: "tfs_getpullrequests",
  description: "Fetches the pull requests of a Microsoft TFS repository",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      status: {
        type: "string",
        description: "Status of the pull requests to filter (active, completed, abandoned) - optional"
      },
      maxResults: {
        type: "integer",
        description: "Maximum number of results (default 25)"
      }
    },
    required: ["project", "repositoryId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const status = typeof args.status === "string" ? args.status : void 0;
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 25;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      const url = client.url(repoPath(project, repositoryId, "/pullrequests"), {
        "api-version": "6.0",
        $top: maxResults,
        "searchCriteria.status": status && status.trim().length > 0 ? status : void 0
      });
      const response = await client.get(
        url,
        "fetching the pull requests"
      );
      const pullRequests = response.value ?? [];
      if (pullRequests.length === 0) {
        const statusFilter = status && status.trim().length > 0 ? ` with status '${status}'` : "";
        return `\u{1F504} **No pull request found${statusFilter} for repository '${repositoryId}' in project '${project}'**

\u{1F4A1} **The repository may not have any pull requests or they may have a different status**`;
      }
      const statusFilter2 = status && status.trim().length > 0 ? ` (${status})` : "";
      const ordered = [...pullRequests].sort((a, b) => {
        const at = a.creationDate ? Date.parse(a.creationDate) : 0;
        const bt = b.creationDate ? Date.parse(b.creationDate) : 0;
        return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
      });
      const lines = [];
      lines.push(
        `\u{1F504} **Pull requests of repository ${repositoryId}${statusFilter2} (${pullRequests.length})**`
      );
      lines.push("");
      for (const pr of ordered) {
        lines.push("---");
        lines.push(formatPullRequestDetails(pr).trimEnd());
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the pull requests", err, {
        Project: project,
        "Repository ID": repositoryId,
        Status: status ?? "All",
        "Maximum results": maxResults
      });
    }
  }
};
var getPullRequest = {
  name: "tfs_getpullrequest",
  description: "Fetches the details of a specific Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      let pullRequest;
      try {
        pullRequest = await client.get(
          url,
          "fetching the pull request"
        );
      } catch (innerErr) {
        const status = innerErr?.status ?? 0;
        if (status > 0 && status !== 200) {
          pullRequest = void 0;
        } else {
          throw innerErr;
        }
      }
      if (!pullRequest || pullRequest.pullRequestId === void 0) {
        return `\u274C **Pull request not found**

\u{1F50D} **Searched ID:** ${pullRequestId} in repository '${repositoryId}' of project '${project}'
\u{1F4A1} **Check that the pull request ID is correct and that you have access permissions**`;
      }
      const lines = [];
      lines.push(`\u{1F504} **Pull request details ${pullRequest.pullRequestId}**`);
      lines.push("");
      lines.push("---");
      lines.push(formatPullRequestDetails(pullRequest, true).trimEnd());
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("fetching the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
      });
    }
  }
};
var createPullRequest = {
  name: "tfs_createpullrequest",
  description: "Creates a new Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      sourceRefName: {
        type: "string",
        description: "Source branch name (e.g. refs/heads/feature-branch)"
      },
      targetRefName: {
        type: "string",
        description: "Target branch name (e.g. refs/heads/main)"
      },
      jiraTicketId: {
        type: "string",
        description: "Jira ticket ID (will be automatically prefixed to the title)"
      },
      title: { type: "string", description: "Pull request title" },
      description: {
        type: "string",
        description: "Pull request description (optional)"
      },
      isDraft: {
        type: "boolean",
        description: "Create as draft (default false)"
      },
      reviewerIds: {
        type: "string",
        description: "Reviewer IDs separated by commas (optional)"
      }
    },
    required: [
      "project",
      "repositoryId",
      "sourceRefName",
      "targetRefName",
      "jiraTicketId",
      "title"
    ],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const sourceRefName = typeof args.sourceRefName === "string" ? args.sourceRefName : "";
    const targetRefName = typeof args.targetRefName === "string" ? args.targetRefName : "";
    const jiraTicketId = typeof args.jiraTicketId === "string" ? args.jiraTicketId : "";
    const title = typeof args.title === "string" ? args.title : "";
    const description = typeof args.description === "string" ? args.description : void 0;
    const isDraft = typeof args.isDraft === "boolean" ? args.isDraft : false;
    const reviewerIds = typeof args.reviewerIds === "string" ? args.reviewerIds : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      requireString5(sourceRefName, "The source branch");
      requireString5(targetRefName, "The target branch");
      requireString5(jiraTicketId, "The Jira ticket ID");
      requireString5(title, "The title");
      const expectedPrefixWithJira = `#JIRA${jiraTicketId}`;
      const expectedPrefixWithoutJira = `#${jiraTicketId}`;
      const lowerTitle = title.toLowerCase();
      const formattedTitle = lowerTitle.startsWith(expectedPrefixWithJira.toLowerCase()) || lowerTitle.startsWith(expectedPrefixWithoutJira.toLowerCase()) ? title : `${expectedPrefixWithJira} ${title}`;
      const reviewerList = reviewerIds && reviewerIds.trim().length > 0 ? reviewerIds.split(",").map((id) => id.trim()).filter((id) => id.length > 0) : void 0;
      const reviewers = reviewerList?.map((id) => ({ id, isRequired: false })) ?? [];
      const createRequest = {
        sourceRefName,
        targetRefName,
        title: formattedTitle,
        description: description ?? "",
        isDraft,
        reviewers
      };
      const url = client.url(repoPath(project, repositoryId, "/pullrequests"), {
        "api-version": "6.0"
      });
      const pullRequest = await client.request(
        "POST",
        url,
        createRequest,
        { operationName: "creating the pull request" }
      );
      const repositoryName = pullRequest.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        pullRequest.pullRequestId ?? 0
      );
      let result = `\u2705 **Microsoft TFS pull request created successfully!**

\u{1F194} **ID:** ${pullRequest.pullRequestId ?? ""}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F3AB} **Jira ticket:** ${jiraTicketId}
\u{1F4CB} **Title:** ${formattedTitle}
\u{1F33F} **Source:** ${sourceRefName}
\u{1F3AF} **Target:** ${targetRefName}
\u{1F4CA} **Status:** ${pullRequest.status ?? ""}
`;
      if (isDraft) {
        result += `\u{1F4DD} **Draft:** Yes
`;
      }
      if (description && description.length > 0) {
        result += `\u{1F4DD} **Description:** ${description}
`;
      }
      if (reviewerList && reviewerList.length > 0) {
        result += `\u{1F465} **Reviewers:** ${reviewerList.length}
`;
      }
      result += `\u{1F517} **Link:** ${pullRequestUrl}`;
      return result;
    } catch (err) {
      return formatErrorResponse("creating the Microsoft TFS pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Source branch": sourceRefName,
        "Target branch": targetRefName,
        "Jira ticket": jiraTicketId,
        Title: title,
        Description: description ?? "None",
        Draft: isDraft,
        Reviewers: reviewerIds ?? "None"
      });
    }
  }
};
var updatePullRequest = {
  name: "tfs_updatepullrequest",
  description: "Updates an existing Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: {
        type: "integer",
        description: "The ID of the pull request to update"
      },
      title: { type: "string", description: "The new title (optional)" },
      description: {
        type: "string",
        description: "The new description (optional)"
      },
      status: {
        type: "string",
        description: "The new status (active, completed, abandoned) (optional)"
      }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const title = typeof args.title === "string" ? args.title : void 0;
    const description = typeof args.description === "string" ? args.description : void 0;
    const status = typeof args.status === "string" ? args.status : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const hasTitle = typeof title === "string" && title.trim().length > 0;
      const hasDescription = typeof description === "string" && description.trim().length > 0;
      const hasStatus = typeof status === "string" && status.trim().length > 0;
      if (!hasTitle && !hasDescription && !hasStatus) {
        throw new Error("At least one field to update must be provided");
      }
      const updateRequest = {};
      if (hasTitle && title !== void 0) updateRequest.title = title;
      if (hasDescription && description !== void 0)
        updateRequest.description = description;
      if (hasStatus && status !== void 0) updateRequest.status = status;
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      const updatedPullRequest = await client.request(
        "PATCH",
        url,
        updateRequest,
        { operationName: "updating the pull request" }
      );
      const updateDetails = [];
      if (hasTitle) updateDetails.push(`\u{1F4CB} **Title:** ${title}`);
      if (hasDescription) updateDetails.push(`\u{1F4DD} **Description:** ${description}`);
      if (hasStatus) updateDetails.push(`\u{1F4CA} **Status:** ${status}`);
      const repositoryName = updatedPullRequest.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updatedPullRequest.pullRequestId ?? pullRequestId
      );
      return `\u2705 **Microsoft TFS pull request updated successfully!**

\u{1F511} **ID:** ${updatedPullRequest.pullRequestId ?? ""}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}

**Updated fields:**
` + updateDetails.join("\n") + `

\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("updating the Microsoft TFS pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
        Title: title ?? "Unchanged",
        Description: description ?? "Unchanged",
        Status: status ?? "Unchanged"
      });
    }
  }
};
var abandonPullRequest = {
  name: "tfs_abandonpullrequest",
  description: "Abandons a Microsoft TFS pull request (PATCH status=abandoned)",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: {
        type: "integer",
        description: "The ID of the pull request to abandon"
      }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      try {
        await client.request(
          "PATCH",
          url,
          { status: "abandoned" },
          { operationName: "abandoning the pull request" }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `\u274C **Error while abandoning the pull request:**

\u26A0\uFE0F ${message}`;
      }
      return `\u2705 **Microsoft TFS pull request abandoned successfully!**

\u{1F511} **Abandoned ID:** ${pullRequestId}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}

\u26A0\uFE0F **Note:** The pull request has been marked as 'abandoned' and can no longer be merged.`;
    } catch (err) {
      return formatErrorResponse("abandoning the Microsoft TFS pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
      });
    }
  }
};
var VOTE_VALUE_BY_NAME = {
  approve: 10,
  approveWithSuggestions: 5,
  reset: 0,
  waitForAuthor: -5,
  reject: -10
};
function voteLabel(vote) {
  switch (vote) {
    case "approve":
      return "\u2705 Approved";
    case "approveWithSuggestions":
      return "\u2611\uFE0F Approved with suggestions";
    case "waitForAuthor":
      return "\u23F3 Waiting for the author";
    case "reject":
      return "\u274C Rejected";
    case "reset":
      return "\u21A9\uFE0F Vote reset";
    default:
      return vote;
  }
}
var voteOnPullRequest = {
  name: "tfs_voteonpullrequest",
  description: "Votes on a Microsoft TFS pull request as a reviewer. 'vote' values: 'approve' = approve (10), 'approveWithSuggestions' = approve with suggestions (5), 'waitForAuthor' = wait for the author (-5), 'reject' = reject (-10), 'reset' = reset your vote (0). By default the vote is cast for the authenticated user (resolved via connectionData); provide reviewerId to vote on behalf of another reviewer (impersonation, requires permissions).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      vote: {
        type: "string",
        enum: ["approve", "approveWithSuggestions", "waitForAuthor", "reject", "reset"],
        description: "Vote action: approve (10) | approveWithSuggestions (5) | waitForAuthor (-5) | reject (-10) | reset (0)"
      },
      reviewerId: {
        type: "string",
        description: "Reviewer GUID; optional, default = authenticated user resolved via /_apis/connectionData"
      }
    },
    required: ["project", "repositoryId", "pullRequestId", "vote"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const vote = typeof args.vote === "string" ? args.vote : "";
    const reviewerIdArg = typeof args.reviewerId === "string" && args.reviewerId.trim().length > 0 ? args.reviewerId.trim() : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      requireString5(vote, "The vote action");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!(vote in VOTE_VALUE_BY_NAME)) {
        throw new Error(
          `Invalid vote '${vote}'. Expected values: approve, approveWithSuggestions, waitForAuthor, reject, reset`
        );
      }
      const reviewerId = reviewerIdArg ?? await client.getAuthenticatedUserId();
      const voteValue = VOTE_VALUE_BY_NAME[vote];
      const url = client.url(
        repoPath(
          project,
          repositoryId,
          `/pullrequests/${pullRequestId}/reviewers/${encodeURIComponent(reviewerId)}`
        ),
        { "api-version": "6.0" }
      );
      await client.request(
        "PUT",
        url,
        { vote: voteValue, id: reviewerId },
        { operationName: "voting on the pull request" }
      );
      const pullRequestUrl = buildPullRequestUrl(project, repositoryId, pullRequestId);
      return `${voteLabel(vote)} **on the pull request!**

\u{1F511} **Pull Request:** ${pullRequestId}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}
\u{1F464} **Reviewer:** ${reviewerId}${reviewerIdArg ? "" : " (self)"}
\u{1F5F3}\uFE0F **Vote:** ${vote} (${voteValue})
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("voting on the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
        Vote: vote,
        "Reviewer ID": reviewerIdArg ?? "self (auto)"
      });
    }
  }
};
function buildCompletionOptions(mergeStrategy, deleteSourceBranch, mergeCommitMessage) {
  const opts = {};
  if (mergeStrategy && mergeStrategy.length > 0) opts.mergeStrategy = mergeStrategy;
  if (typeof deleteSourceBranch === "boolean") opts.deleteSourceBranch = deleteSourceBranch;
  if (mergeCommitMessage && mergeCommitMessage.length > 0)
    opts.mergeCommitMessage = mergeCommitMessage;
  return opts;
}
var VALID_MERGE_STRATEGIES = /* @__PURE__ */ new Set([
  "noFastForward",
  "rebase",
  "rebaseMerge",
  "squash"
]);
var completePullRequest = {
  name: "tfs_completepullrequest",
  description: "Completes (merges) a Microsoft TFS pull request immediately. Fails if the policies are not satisfied (use setautocompletepullrequest otherwise).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      mergeStrategy: {
        type: "string",
        enum: ["noFastForward", "rebase", "rebaseMerge", "squash"],
        description: "Merge strategy; default = squash"
      },
      deleteSourceBranch: {
        type: "boolean",
        description: "Delete the source branch after merge (optional)"
      },
      mergeCommitMessage: {
        type: "string",
        description: "Custom message for the merge commit (optional)"
      }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const mergeStrategy = typeof args.mergeStrategy === "string" && args.mergeStrategy.length > 0 ? args.mergeStrategy : "squash";
    const deleteSourceBranch = typeof args.deleteSourceBranch === "boolean" ? args.deleteSourceBranch : void 0;
    const mergeCommitMessage = typeof args.mergeCommitMessage === "string" ? args.mergeCommitMessage : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!VALID_MERGE_STRATEGIES.has(mergeStrategy)) {
        throw new Error(
          `Invalid mergeStrategy '${mergeStrategy}'. Values: noFastForward, rebase, rebaseMerge, squash`
        );
      }
      const getUrl = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      const pr = await client.get(
        getUrl,
        "fetching the pull request before completion"
      );
      const commitId = pr.lastMergeSourceCommit?.commitId;
      if (!commitId || commitId.length === 0) {
        throw new Error(
          "lastMergeSourceCommit.commitId not found on the pull request \u2014 unable to complete (PR not ready?)"
        );
      }
      const completionOptions = buildCompletionOptions(
        mergeStrategy,
        deleteSourceBranch,
        mergeCommitMessage
      );
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      const updated = await client.request(
        "PATCH",
        url,
        {
          status: "completed",
          lastMergeSourceCommit: { commitId },
          completionOptions
        },
        { operationName: "completing the pull request" }
      );
      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );
      return `\u2705 **Pull request completed successfully!**

\u{1F511} **ID:** ${updated.pullRequestId ?? pullRequestId}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4CA} **Status:** ${updated.status ?? "completed"}
\u{1F500} **Strategy:** ${mergeStrategy}
` + (deleteSourceBranch !== void 0 ? `\u{1F5D1}\uFE0F **Source branch deleted:** ${deleteSourceBranch ? "Yes" : "No"}
` : "") + (mergeCommitMessage ? `\u{1F4DD} **Merge message:** ${mergeCommitMessage}
` : "") + `\u{1F4CD} **Source commit:** ${commitId.substring(0, 8)}...
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("completing the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
        "Merge strategy": mergeStrategy,
        "Delete source branch": deleteSourceBranch === void 0 ? "Not specified" : deleteSourceBranch,
        "Merge message": mergeCommitMessage ?? "None"
      });
    }
  }
};
var setAutoCompletePullRequest = {
  name: "tfs_setautocompletepullrequest",
  description: "Enables auto-complete on a Microsoft TFS pull request. The merge triggers automatically when all policies pass. autoCompleteSetBy is forced to the authenticated user (Microsoft TFS rejects an arbitrary GUID).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      mergeStrategy: {
        type: "string",
        enum: ["noFastForward", "rebase", "rebaseMerge", "squash"],
        description: "Merge strategy; default = squash"
      },
      deleteSourceBranch: {
        type: "boolean",
        description: "Delete the source branch after merge (optional)"
      },
      mergeCommitMessage: {
        type: "string",
        description: "Custom message for the merge commit (optional)"
      }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const mergeStrategy = typeof args.mergeStrategy === "string" && args.mergeStrategy.length > 0 ? args.mergeStrategy : "squash";
    const deleteSourceBranch = typeof args.deleteSourceBranch === "boolean" ? args.deleteSourceBranch : void 0;
    const mergeCommitMessage = typeof args.mergeCommitMessage === "string" ? args.mergeCommitMessage : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!VALID_MERGE_STRATEGIES.has(mergeStrategy)) {
        throw new Error(
          `Invalid mergeStrategy '${mergeStrategy}'. Values: noFastForward, rebase, rebaseMerge, squash`
        );
      }
      const selfId = await client.getAuthenticatedUserId();
      const completionOptions = buildCompletionOptions(
        mergeStrategy,
        deleteSourceBranch,
        mergeCommitMessage
      );
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
        { "api-version": "6.0" }
      );
      const updated = await client.request(
        "PATCH",
        url,
        {
          autoCompleteSetBy: { id: selfId },
          completionOptions
        },
        { operationName: "enabling auto-complete on the pull request" }
      );
      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );
      return `\u2699\uFE0F **Auto-complete enabled on the pull request!**

\u{1F511} **ID:** ${updated.pullRequestId ?? pullRequestId}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F464} **Set by:** ${selfId} (self)
\u{1F500} **Strategy:** ${mergeStrategy}
` + (deleteSourceBranch !== void 0 ? `\u{1F5D1}\uFE0F **Source branch deleted:** ${deleteSourceBranch ? "Yes" : "No"}
` : "") + (mergeCommitMessage ? `\u{1F4DD} **Merge message:** ${mergeCommitMessage}
` : "") + `\u23F1\uFE0F **The merge will trigger once policies are satisfied**
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("enabling auto-complete on the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
        "Merge strategy": mergeStrategy,
        "Delete source branch": deleteSourceBranch === void 0 ? "Not specified" : deleteSourceBranch,
        "Merge message": mergeCommitMessage ?? "None"
      });
    }
  }
};
async function patchDraftFlag(client, project, repositoryId, pullRequestId, isDraft, operationName) {
  const url = client.url(
    repoPath(project, repositoryId, `/pullrequests/${pullRequestId}`),
    { "api-version": "6.0" }
  );
  return client.request(
    "PATCH",
    url,
    { isDraft },
    { operationName }
  );
}
var markPullRequestDraft = {
  name: "tfs_markpullrequestdraft",
  description: "Marks a Microsoft TFS pull request as draft (isDraft=true)",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const updated = await patchDraftFlag(
        client,
        project,
        repositoryId,
        pullRequestId,
        true,
        "marking the pull request as draft"
      );
      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );
      return `\u{1F4DD} **Pull request marked as draft!**

\u{1F511} **ID:** ${updated.pullRequestId ?? pullRequestId}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4DD} **Draft:** Yes
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("marking the pull request as draft", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
      });
    }
  }
};
var publishPullRequest = {
  name: "tfs_publishpullrequest",
  description: "Takes a Microsoft TFS pull request out of draft mode (isDraft=false)",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const updated = await patchDraftFlag(
        client,
        project,
        repositoryId,
        pullRequestId,
        false,
        "publishing the pull request (out of draft)"
      );
      const repositoryName = updated.repository?.name ?? repositoryId;
      const pullRequestUrl = buildPullRequestUrl(
        project,
        repositoryName,
        updated.pullRequestId ?? pullRequestId
      );
      return `\u{1F680} **Pull request published (out of draft)!**

\u{1F511} **ID:** ${updated.pullRequestId ?? pullRequestId}
\u{1F4C1} **Project:** ${project}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4DD} **Draft:** No
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse("publishing the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
      });
    }
  }
};
var getPullRequestComments = {
  name: "tfs_getpullrequestcomments",
  description: "Fetches the comments of a Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/threads`),
        { "api-version": "6.0" }
      );
      const response = await client.get(
        url,
        "fetching the pull request comments"
      );
      const threads = response.value ?? [];
      const comments = [];
      for (const thread of threads) {
        const threadId = typeof thread.id === "number" ? thread.id : 0;
        const threadStatus = formatPullRequestThreadStatus(thread);
        const threadComments = thread.comments ?? [];
        for (const c of threadComments) {
          comments.push({ ...c, threadId, threadStatus });
        }
      }
      if (comments.length === 0) {
        return `\u{1F4AC} **No comment found for pull request ${pullRequestId}**

\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}`;
      }
      const ordered = [...comments].sort((a, b) => {
        const at = a.publishedDate ? Date.parse(a.publishedDate) : 0;
        const bt = b.publishedDate ? Date.parse(b.publishedDate) : 0;
        return (Number.isNaN(at) ? 0 : at) - (Number.isNaN(bt) ? 0 : bt);
      });
      const lines = [];
      lines.push(
        `\u{1F4AC} **Pull request comments ${pullRequestId} (${comments.length})**`
      );
      lines.push("");
      for (const comment of ordered) {
        lines.push("---");
        if (comment.threadId !== 0) {
          lines.push(`\u{1F9F5} **Thread ID:** ${comment.threadId}`);
        }
        if (comment.threadStatus && comment.threadStatus.length > 0) {
          lines.push(`\u{1F4CC} **Thread status:** ${comment.threadStatus}`);
        }
        lines.push(`\u{1F511} **Comment ID:** ${comment.id ?? ""}`);
        if (comment.author) {
          lines.push(`\u{1F464} **Author:** ${comment.author.displayName ?? ""}`);
        }
        const publishedDate = formatDate(comment.publishedDate);
        if (publishedDate) {
          lines.push(`\u{1F4C5} **Published on:** ${publishedDate}`);
        }
        if (comment.lastUpdatedDate && comment.lastUpdatedDate !== comment.publishedDate) {
          const lastUpdated = formatDate(comment.lastUpdatedDate);
          if (lastUpdated) {
            lines.push(`\u{1F504} **Modified on:** ${lastUpdated}`);
          }
        }
        lines.push(`\u{1F4DD} **Content:**`);
        lines.push(comment.content ?? "");
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the pull request comments",
        err,
        {
          Project: project,
          "Repository ID": repositoryId,
          "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
        }
      );
    }
  }
};
var addPullRequestComment = {
  name: "tfs_addpullrequestcomment",
  description: "Adds a comment to a Microsoft TFS pull request. Without filePath: general comment. With filePath + lineStart: comment anchored on one or more lines (right side of the diff, resulting file).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      comment: { type: "string", description: "The comment to add" },
      filePath: {
        type: "string",
        description: "File path in the repo (e.g. /src/Service.cs), same form as in the diff; optional for a general comment"
      },
      lineStart: {
        type: "integer",
        description: "Start line number on the right file (>= 1), required if filePath is provided"
      },
      lineEnd: {
        type: "integer",
        description: "End line number (inclusive); default = lineStart for a single line"
      },
      startColumnOffset: {
        type: "integer",
        description: "Start column offset (1-based), default 1"
      },
      endColumnOffset: {
        type: "integer",
        description: "End column offset (1-based), default 1"
      },
      iterationId: {
        type: "integer",
        description: "Iteration used to resolve the file / changeTrackingId (default: latest iteration or the one aligned with secondComparingIteration)"
      },
      firstComparingIteration: {
        type: "integer",
        description: "First iteration of the comparison context (default 1)"
      },
      secondComparingIteration: {
        type: "integer",
        description: "Second iteration of the context (default: latest iteration of the PR)"
      },
      changeTrackingId: {
        type: "integer",
        description: "Microsoft TFS changeTrackingId; if omitted, inferred from filePath via the iteration changes"
      }
    },
    required: ["project", "repositoryId", "pullRequestId", "comment"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const comment = typeof args.comment === "string" ? args.comment : "";
    const filePath = typeof args.filePath === "string" ? args.filePath : void 0;
    const lineStart = typeof args.lineStart === "number" ? args.lineStart : void 0;
    const lineEnd = typeof args.lineEnd === "number" ? args.lineEnd : void 0;
    const startColumnOffset = typeof args.startColumnOffset === "number" ? args.startColumnOffset : void 0;
    const endColumnOffset = typeof args.endColumnOffset === "number" ? args.endColumnOffset : void 0;
    const iterationId = typeof args.iterationId === "number" ? args.iterationId : void 0;
    const firstComparingIteration = typeof args.firstComparingIteration === "number" ? args.firstComparingIteration : void 0;
    const secondComparingIteration = typeof args.secondComparingIteration === "number" ? args.secondComparingIteration : void 0;
    const changeTrackingIdArg = typeof args.changeTrackingId === "number" ? args.changeTrackingId : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      requireString5(comment, "The comment");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      let commentRequest;
      const hasFilePath = typeof filePath === "string" && filePath.trim().length > 0;
      if (!hasFilePath) {
        commentRequest = {
          comments: [
            {
              parentCommentId: 0,
              content: comment,
              commentType: 1
            }
          ],
          status: 1
        };
      } else {
        if (lineStart === void 0 || lineStart < 1) {
          return `\u274C **Error while adding the comment:**

\u26A0\uFE0F For a comment on the code, lineStart (>= 1) is required with filePath.`;
        }
        const iterations = await getPullRequestIterations(
          client,
          project,
          repositoryId,
          pullRequestId
        );
        if (iterations.length === 0) {
          return `\u274C **Error while adding the comment:**

\u26A0\uFE0F No iteration found for this pull request.`;
        }
        const ordered = [...iterations].filter(
          (i) => typeof i.id === "number"
        ).sort((a, b) => b.id - a.id);
        const lastIterationId = ordered[0]?.id ?? 0;
        const resolvedSecond = secondComparingIteration ?? iterationId ?? lastIterationId;
        const resolvedFirst = firstComparingIteration ?? 1;
        const iterationForChanges = iterationId ?? resolvedSecond;
        let resolvedTracking = changeTrackingIdArg;
        let secondComparingForContext = resolvedSecond;
        if (resolvedTracking === void 0) {
          const normalizedTarget = normalizeRepoPath(filePath);
          if (normalizedTarget.length === 0) {
            return `\u274C **Error while adding the comment:**

\u26A0\uFE0F Invalid or empty file path after normalization.`;
          }
          const tryIterations = [];
          const addIterationId = (id) => {
            if (id > 0 && !tryIterations.includes(id)) {
              tryIterations.push(id);
            }
          };
          addIterationId(iterationForChanges);
          addIterationId(resolvedSecond);
          for (const it of ordered) {
            addIterationId(it.id);
          }
          let match = null;
          let matchIteration = 0;
          for (const iterId of tryIterations) {
            const iterChanges = await getPullRequestIterationChanges(
              client,
              project,
              repositoryId,
              pullRequestId,
              iterId
            );
            const candidate = findMatchingChangeForPath(iterChanges, normalizedTarget);
            if (candidate && (candidate.changeTrackingId ?? 0) !== 0) {
              match = candidate;
              matchIteration = iterId;
              break;
            }
          }
          if (!match || (match.changeTrackingId ?? 0) === 0) {
            const sampleChanges = await getPullRequestIterationChanges(
              client,
              project,
              repositoryId,
              pullRequestId,
              iterationForChanges
            );
            const samplePathsSet = /* @__PURE__ */ new Set();
            const samplePaths = [];
            for (const change of sampleChanges.slice(0, 40)) {
              for (const path2 of enumerateChangePaths(change)) {
                if (!path2 || path2.trim().length === 0) continue;
                const key = path2.toLowerCase();
                if (samplePathsSet.has(key)) continue;
                samplePathsSet.add(key);
                samplePaths.push(path2);
                if (samplePaths.length >= 15) break;
              }
              if (samplePaths.length >= 15) break;
            }
            const sample = samplePaths.join(", ");
            return `\u274C **Error while adding the comment:**

\u26A0\uFE0F File not found in the tested iterations: '${filePath}'. Use changeTrackingId or a path aligned with the diff (e.g. /src/...). Examples: ${sample}`;
          }
          resolvedTracking = match.changeTrackingId ?? 0;
          secondComparingForContext = matchIteration;
        }
        let endLine = lineEnd ?? lineStart;
        if (endLine < lineStart) endLine = lineStart;
        const startOff = startColumnOffset ?? 1;
        const endOff = endColumnOffset ?? 1;
        commentRequest = {
          comments: [
            {
              parentCommentId: 0,
              content: comment,
              commentType: 1
            }
          ],
          status: 1,
          threadContext: {
            filePath: normalizeRepoPath(filePath),
            rightFileStart: { line: lineStart, offset: startOff },
            rightFileEnd: { line: endLine, offset: endOff }
          },
          pullRequestThreadContext: {
            changeTrackingId: resolvedTracking,
            iterationContext: {
              firstComparingIteration: resolvedFirst,
              secondComparingIteration: secondComparingForContext
            }
          }
        };
      }
      const url = client.url(
        repoPath(project, repositoryId, `/pullrequests/${pullRequestId}/threads`),
        { "api-version": "6.0" }
      );
      try {
        await client.request("POST", url, commentRequest, {
          operationName: "adding the comment to the pull request"
        });
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `\u274C **Error while adding the comment:**

\u26A0\uFE0F ${message}`;
      }
      const anchor = !hasFilePath ? "" : `
\u{1F4CD} **File:** \`${filePath}\`
\u{1F4CF} **Lines:** ${lineStart}-${lineEnd ?? lineStart}
`;
      return `\u2705 **Comment added successfully to the pull request!**

\u{1F511} **Pull Request:** ${pullRequestId}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}
` + anchor + `\u{1F4AC} **Comment:** ${comment}`;
    } catch (err) {
      return formatErrorResponse("adding the comment to the pull request", err, {
        Project: project,
        "Repository ID": repositoryId,
        "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
        Comment: comment
      });
    }
  }
};
var getPullRequestDiff = {
  name: "tfs_getpullrequestdiff",
  description: "Fetches the diff/changes of a Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      iterationId: {
        type: "integer",
        description: "ID of the specific iteration (optional, default the first iteration)"
      }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const iterationId = typeof args.iterationId === "number" ? args.iterationId : void 0;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      let changes;
      if (iterationId !== void 0) {
        changes = await getPullRequestIterationChanges(
          client,
          project,
          repositoryId,
          pullRequestId,
          iterationId
        );
      } else {
        const iterations = await getPullRequestIterations(
          client,
          project,
          repositoryId,
          pullRequestId
        );
        if (iterations.length === 0) {
          changes = [];
        } else {
          const latest = [...iterations].filter(
            (i) => typeof i.id === "number"
          ).sort((a, b) => b.id - a.id)[0];
          changes = latest ? await getPullRequestIterationChanges(
            client,
            project,
            repositoryId,
            pullRequestId,
            latest.id
          ) : [];
        }
      }
      if (changes.length === 0) {
        return `\u{1F4C4} **No change found for pull request ${pullRequestId}**

\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}
` + (iterationId !== void 0 ? `\u{1F504} **Iteration:** ${iterationId}
` : "") + `\u{1F4A1} **The pull request may not have any changes or the specified iteration does not exist**`;
      }
      const lines = [];
      const iterationText = iterationId !== void 0 ? ` (iteration ${iterationId})` : "";
      lines.push(
        `\u{1F4C4} **Changes of pull request ${pullRequestId}${iterationText} (${changes.length})**`
      );
      lines.push("");
      lines.push(`\u{1F4C2} **Repository:** ${repositoryId}`);
      lines.push(`\u{1F4C1} **Project:** ${project}`);
      lines.push("");
      const groups = /* @__PURE__ */ new Map();
      for (const c of changes) {
        const key = c.changeType ?? "";
        const list = groups.get(key);
        if (list) list.push(c);
        else groups.set(key, [c]);
      }
      const orderedGroupKeys = [...groups.keys()].sort(
        (a, b) => a.localeCompare(b)
      );
      for (const key of orderedGroupKeys) {
        const group = groups.get(key) ?? [];
        const changeTypeIcon = getChangeTypeIcon(key);
        lines.push(`## ${changeTypeIcon} **${key}** (${group.length} file(s))`);
        lines.push("");
        const orderedGroup = [...group].sort(
          (a, b) => (a.item?.path ?? "").localeCompare(b.item?.path ?? "")
        );
        for (const change of orderedGroup) {
          lines.push(
            `\u{1F4C1} **Path:** \`${change.item?.path ?? "(no item)"}\``
          );
          if ((change.changeTrackingId ?? 0) !== 0) {
            lines.push(`\u{1F3F7} **changeTrackingId:** ${change.changeTrackingId}`);
          }
          lines.push(`\u{1F527} **Type:** ${change.changeType ?? ""}`);
          if (change.item?.isFolder === true) {
            lines.push(`\u{1F4C2} **Object type:** Folder`);
          } else {
            lines.push(
              `\u{1F4C4} **Object type:** File (${change.item?.gitObjectType ?? "?"})`
            );
          }
          const objectId = change.item?.objectId;
          if (objectId && objectId.length > 0) {
            lines.push(`\u{1F511} **Object ID:** ${objectId.substring(0, 8)}...`);
          }
          if (change.sourceServerItem && change.sourceServerItem.path && change.sourceServerItem.path.length > 0) {
            lines.push(`\u{1F4CD} **Source path:** \`${change.sourceServerItem.path}\``);
          }
          if (change.item?.url && change.item.url.length > 0) {
            lines.push(`\u{1F517} **Link:** ${change.item.url}`);
          }
          lines.push("");
        }
      }
      lines.push("---");
      lines.push(`\u{1F4CA} **Summary:**`);
      for (const key of orderedGroupKeys) {
        const group = groups.get(key) ?? [];
        const changeTypeIcon = getChangeTypeIcon(key);
        lines.push(`- ${changeTypeIcon} ${key}: ${group.length} file(s)`);
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the pull request changes",
        err,
        {
          Project: project,
          "Repository ID": repositoryId,
          "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
          "Iteration ID": iterationId !== void 0 ? String(iterationId) : "First iteration"
        }
      );
    }
  }
};
var getPullRequestIterationsTool = {
  name: "tfs_getpullrequestiterations",
  description: "Fetches the list of iterations of a Microsoft TFS pull request",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" }
    },
    required: ["project", "repositoryId", "pullRequestId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      const iterations = await getPullRequestIterations(
        client,
        project,
        repositoryId,
        pullRequestId
      );
      if (iterations.length === 0) {
        return `\u{1F504} **No iteration found for pull request ${pullRequestId}**

\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}`;
      }
      const ordered = [...iterations].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      const lines = [];
      lines.push(
        `\u{1F504} **Iterations of pull request ${pullRequestId} (${iterations.length})**`
      );
      lines.push("");
      lines.push(`\u{1F4C2} **Repository:** ${repositoryId}`);
      lines.push(`\u{1F4C1} **Project:** ${project}`);
      lines.push("");
      for (const iteration of ordered) {
        lines.push("---");
        lines.push(`\u{1F511} **ID:** ${iteration.id ?? ""}`);
        if (iteration.description && iteration.description.length > 0) {
          lines.push(`\u{1F4DD} **Description:** ${iteration.description}`);
        }
        if (iteration.author) {
          lines.push(`\u{1F464} **Author:** ${iteration.author.displayName ?? ""}`);
        }
        const createdDate = formatDate(iteration.createdDate);
        if (createdDate) {
          lines.push(`\u{1F4C5} **Created on:** ${createdDate}`);
        }
        const updatedDate = formatDate(iteration.updatedDate);
        if (updatedDate) {
          lines.push(`\u{1F504} **Updated on:** ${updatedDate}`);
        }
        if (iteration.reason && iteration.reason.length > 0) {
          lines.push(`\u{1F4A1} **Reason:** ${iteration.reason}`);
        }
        if (iteration.sourceRefCommit?.commitId) {
          lines.push(
            `\u{1F4CD} **Source commit:** ${iteration.sourceRefCommit.commitId.substring(0, 8)}...`
          );
        }
        if (iteration.targetRefCommit?.commitId) {
          lines.push(
            `\u{1F3AF} **Target commit:** ${iteration.targetRefCommit.commitId.substring(0, 8)}...`
          );
        }
        if (iteration.hasMoreCommits === true) {
          lines.push(`\u{1F4DA} **More commits:** Yes`);
        }
        if (iteration.push) {
          const pushDate = formatDate(iteration.push.date);
          lines.push(
            `\u2B06\uFE0F **Push ID:** ${iteration.push.pushId ?? ""} on ${pushDate ?? ""}`
          );
        }
        lines.push("");
      }
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse(
        "fetching the pull request iterations",
        err,
        {
          Project: project,
          "Repository ID": repositoryId,
          "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : ""
        }
      );
    }
  }
};
var THREAD_STATUS_BY_NAME = {
  active: 1,
  fixed: 2,
  wontFix: 3,
  closed: 4,
  byDesign: 5,
  pending: 6
};
function threadStatusLabel(status) {
  switch (status) {
    case "fixed":
      return "\u2705 Resolved (fixed)";
    case "closed":
      return "\u{1F512} Closed (closed)";
    case "wontFix":
      return "\u{1F6AB} Will not be fixed (wontFix)";
    case "byDesign":
      return "\u{1F4D0} By design (byDesign)";
    case "active":
      return "\u{1F535} Reactivated (active)";
    case "pending":
      return "\u23F3 Pending (pending)";
    default:
      return status;
  }
}
var resolvePullRequestComment = {
  name: "tfs_resolvepullrequestcomment",
  description: "Resolves (closes) a comment thread of a Microsoft TFS pull request by changing its status. status values: 'fixed' = resolved (default), 'closed' = closed, 'wontFix' = will not be fixed, 'byDesign' = by design, 'active' = reactivate, 'pending' = pending. Use the threadId (Thread ID) returned by tfs_getpullrequestcomments.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "The Microsoft TFS project name" },
      repositoryId: { type: "string", description: "The repository ID" },
      pullRequestId: { type: "integer", description: "The pull request ID" },
      threadId: {
        type: "integer",
        description: "The ID of the comment thread to resolve (Thread ID returned by tfs_getpullrequestcomments)"
      },
      status: {
        type: "string",
        enum: ["fixed", "closed", "wontFix", "byDesign", "active", "pending"],
        description: "New thread status; default = fixed (resolved). closed = closed, wontFix = will not be fixed, byDesign = by design, active = reactivate, pending = pending"
      }
    },
    required: ["project", "repositoryId", "pullRequestId", "threadId"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const repositoryId = typeof args.repositoryId === "string" ? args.repositoryId : "";
    const pullRequestId = typeof args.pullRequestId === "number" ? args.pullRequestId : NaN;
    const threadId = typeof args.threadId === "number" ? args.threadId : NaN;
    const status = typeof args.status === "string" && args.status.length > 0 ? args.status : "fixed";
    try {
      requireString5(project, "The project name");
      requireString5(repositoryId, "The repository ID");
      if (!Number.isFinite(pullRequestId) || !Number.isInteger(pullRequestId)) {
        throw new Error("The pull request ID is required");
      }
      if (!Number.isFinite(threadId) || !Number.isInteger(threadId)) {
        throw new Error("The comment thread ID (threadId) is required");
      }
      if (!(status in THREAD_STATUS_BY_NAME)) {
        throw new Error(
          `Invalid status '${status}'. Expected values: fixed, closed, wontFix, byDesign, active, pending`
        );
      }
      const statusValue = THREAD_STATUS_BY_NAME[status];
      const url = client.url(
        repoPath(
          project,
          repositoryId,
          `/pullrequests/${pullRequestId}/threads/${threadId}`
        ),
        { "api-version": "6.0" }
      );
      try {
        await client.request(
          "PATCH",
          url,
          { status: statusValue },
          { operationName: "resolving the pull request comment thread" }
        );
      } catch (innerErr) {
        const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
        return `\u274C **Error while resolving the comment:**

\u26A0\uFE0F ${message}`;
      }
      const pullRequestUrl = buildPullRequestUrl(project, repositoryId, pullRequestId);
      return `${threadStatusLabel(status)} **\u2014 comment thread updated!**

\u{1F9F5} **Thread ID:** ${threadId}
\u{1F511} **Pull Request:** ${pullRequestId}
\u{1F4C2} **Repository:** ${repositoryId}
\u{1F4C1} **Project:** ${project}
\u{1F4CC} **New status:** ${status} (${statusValue})
\u{1F517} **Link:** ${pullRequestUrl}`;
    } catch (err) {
      return formatErrorResponse(
        "resolving the pull request comment thread",
        err,
        {
          Project: project,
          "Repository ID": repositoryId,
          "Pull Request ID": Number.isFinite(pullRequestId) ? pullRequestId : "",
          "Thread ID": Number.isFinite(threadId) ? threadId : "",
          Status: status
        }
      );
    }
  }
};
var pullRequestTools = [
  getPullRequests,
  getPullRequest,
  createPullRequest,
  updatePullRequest,
  abandonPullRequest,
  voteOnPullRequest,
  completePullRequest,
  setAutoCompletePullRequest,
  markPullRequestDraft,
  publishPullRequest,
  getPullRequestComments,
  addPullRequestComment,
  resolvePullRequestComment,
  getPullRequestDiff,
  getPullRequestIterationsTool
];

// src/tools/branches.ts
function requireString6(value, displayName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${displayName} is required`);
  }
  return value;
}
function projectPath6(project, suffix) {
  return `/${encodeURIComponent(project)}${suffix}`;
}
function repoPath2(project, repositoryId, suffix) {
  return projectPath6(
    project,
    `/_apis/git/repositories/${encodeURIComponent(repositoryId)}${suffix}`
  );
}
async function getBranchLastCommitDate(client, project, repositoryId, commitId) {
  try {
    const url = client.url(
      repoPath2(project, repositoryId, `/commits/${encodeURIComponent(commitId)}`),
      { "api-version": "6.0" }
    );
    let commit;
    try {
      commit = await client.get(url, "fetching the commit");
    } catch {
      return void 0;
    }
    const tryParse = (raw) => {
      if (!raw || raw.trim().length === 0) return void 0;
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return void 0;
      return date.toISOString();
    };
    return tryParse(commit.committer?.date) ?? tryParse(commit.author?.date) ?? tryParse(commit.push?.date);
  } catch {
    return void 0;
  }
}
async function getBranches(client, project, repositoryId) {
  try {
    const url = client.url(repoPath2(project, repositoryId, "/refs"), {
      filter: "heads/",
      "api-version": "6.0"
    });
    const response = await client.get(
      url,
      "fetching the branches"
    );
    const branches = response.value ?? [];
    for (const branch of branches) {
      if (branch.objectId) {
        branch.lastUpdateDate = await getBranchLastCommitDate(
          client,
          project,
          repositoryId,
          branch.objectId
        );
      }
    }
    return branches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Error while fetching the branches: ${message}`);
  }
}
async function getRepositories2(client, project) {
  const url = client.url(projectPath6(project, "/_apis/git/repositories"), {
    "api-version": "6.0"
  });
  const response = await client.get(
    url,
    "fetching the repositories"
  );
  return response.value ?? [];
}
async function getPullRequestsForRepo(client, project, repositoryId, status, maxResults) {
  try {
    const url = client.url(repoPath2(project, repositoryId, "/pullrequests"), {
      "api-version": "6.0",
      $top: maxResults,
      "searchCriteria.status": status
    });
    const response = await client.get(
      url,
      "fetching the pull requests"
    );
    return response.value ?? [];
  } catch {
    return [];
  }
}
async function deleteBranch(client, project, repositoryId, branchName) {
  try {
    const branches = await getBranches(client, project, repositoryId);
    const branch = branches.find(
      (b) => b.name === `refs/heads/${branchName}` || b.name === branchName
    );
    if (!branch || !branch.name || !branch.objectId) {
      return { success: false, errorMessage: "Branch not found" };
    }
    const deleteRequest = [
      {
        name: branch.name,
        oldObjectId: branch.objectId,
        newObjectId: "0000000000000000000000000000000000000000"
      }
    ];
    const url = client.url(repoPath2(project, repositoryId, "/refs"), {
      "api-version": "6.0"
    });
    let responseRaw;
    try {
      responseRaw = await client.request("POST", url, deleteRequest, {
        operationName: "deleting the branch"
      });
    } catch (innerErr) {
      const status = innerErr?.status ?? 0;
      const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (status === 401 || status === 403) {
        return {
          success: false,
          errorMessage: `Insufficient permissions to delete the branch. HTTP code: ${status}. Message: ${message || "Access denied"}`
        };
      }
      return {
        success: false,
        errorMessage: `Error while deleting (Code: ${status}): ${message}`
      };
    }
    if (responseRaw && typeof responseRaw === "object") {
      const root = responseRaw;
      if (Array.isArray(responseRaw) && responseRaw.length === 0) {
      } else if (Array.isArray(root.value) && root.value.length === 0) {
      } else {
        const errMsg = root.message ?? root.error;
        if (typeof errMsg === "string" && errMsg.length > 0) {
          const lower = errMsg.toLowerCase();
          if (lower.includes("permission") || lower.includes("access") || lower.includes("denied") || lower.includes("refus\xE9")) {
            return {
              success: false,
              errorMessage: `Insufficient permissions to delete the branch. Message: ${errMsg}`
            };
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const branchesAfterDelete = await getBranches(client, project, repositoryId);
    const stillExists = branchesAfterDelete.some(
      (b) => b.name === `refs/heads/${branchName}` || b.name === branchName
    );
    if (stillExists) {
      return {
        success: false,
        errorMessage: "Insufficient permissions to delete the branch. The branch still exists after the deletion attempt."
      };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorMessage: `Error while deleting the branch: ${message}`
    };
  }
}
function containsCaseInsensitive(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
function stripRefsHeads(name) {
  return name.replace(/^refs\/heads\//, "");
}
function parseLastUpdate(branch) {
  if (!branch.lastUpdateDate) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(branch.lastUpdateDate);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}
async function cleanBranches(client, project, dryRun, configKubeBranchesToKeep, branchRetentionMonths, keepBranchesWithOpenPr) {
  const result = {
    totalRepositories: 0,
    eligibleRepositories: 0,
    totalBranches: 0,
    deletedBranches: 0,
    failedDeletions: 0,
    skippedBranchesWithPr: 0,
    skippedBranchesRecent: 0,
    hasPermissionErrors: false,
    deletedBranchesList: [],
    failedBranchesList: [],
    skippedRepositories: [],
    skippedBranchesWithPrList: [],
    skippedBranchesRecentList: []
  };
  try {
    const repositories = await getRepositories2(client, project);
    result.totalRepositories = repositories.length;
    const now = /* @__PURE__ */ new Date();
    const retentionDate = new Date(now.getTime());
    retentionDate.setUTCMonth(retentionDate.getUTCMonth() - branchRetentionMonths);
    const retentionMs = retentionDate.getTime();
    const branchesToDelete = [];
    const repoDataList = await Promise.all(
      repositories.map(async (repo) => {
        const repoId = repo.id ?? "";
        const isConfigKubeRepo = containsCaseInsensitive(
          repo.name ?? "",
          "config_kube"
        );
        const [branches, activePullRequests] = await Promise.all([
          getBranches(client, project, repoId),
          getPullRequestsForRepo(client, project, repoId, "active", 100)
        ]);
        return {
          repo,
          isConfigKubeRepo,
          branches,
          activePullRequests
        };
      })
    );
    for (const repoData of repoDataList) {
      const { repo, isConfigKubeRepo, branches, activePullRequests } = repoData;
      if (!isConfigKubeRepo) {
        result.eligibleRepositories++;
      }
      const branchesWithActivePr = /* @__PURE__ */ new Set();
      if (keepBranchesWithOpenPr) {
        for (const pr of activePullRequests) {
          const sourceBranch = (pr.sourceRefName ?? "").replace(/^refs\/heads\//, "").replace(/^refs\//, "");
          if (sourceBranch.trim().length > 0) {
            branchesWithActivePr.add(sourceBranch.toLowerCase());
          }
        }
      }
      if (isConfigKubeRepo) {
        const branchesToKeepSet = new Set(
          [...branches].filter((b) => !containsCaseInsensitive(b.name ?? "", "master")).sort((a, b) => parseLastUpdate(b) - parseLastUpdate(a)).slice(0, configKubeBranchesToKeep).map((b) => stripRefsHeads(b.name ?? "").toLowerCase())
        );
        for (const branch of branches) {
          const branchName = stripRefsHeads(branch.name ?? "");
          if (containsCaseInsensitive(branchName, "master")) {
            continue;
          }
          if (branchesToKeepSet.has(branchName.toLowerCase())) {
            continue;
          }
          result.totalBranches++;
          if (!dryRun) {
            branchesToDelete.push({ repo, branchName });
          } else {
            result.deletedBranchesList.push(`${repo.name ?? ""}/${branchName}`);
          }
        }
        continue;
      }
      for (const branch of branches) {
        const branchName = stripRefsHeads(branch.name ?? "");
        if (containsCaseInsensitive(branchName, "master")) {
          continue;
        }
        if (keepBranchesWithOpenPr && branchesWithActivePr.has(branchName.toLowerCase())) {
          result.skippedBranchesWithPr++;
          result.skippedBranchesWithPrList.push(
            `${repo.name ?? ""}/${branchName}`
          );
          continue;
        }
        if (branch.lastUpdateDate) {
          const lastUpdateMs = Date.parse(branch.lastUpdateDate);
          if (!Number.isNaN(lastUpdateMs) && lastUpdateMs > retentionMs) {
            result.skippedBranchesRecent++;
            result.skippedBranchesRecentList.push(
              `${repo.name ?? ""}/${branchName}`
            );
            continue;
          }
        }
        result.totalBranches++;
        if (!dryRun) {
          branchesToDelete.push({ repo, branchName });
        } else {
          result.deletedBranchesList.push(`${repo.name ?? ""}/${branchName}`);
        }
      }
    }
    if (!dryRun && branchesToDelete.length > 0) {
      const CONCURRENCY = 10;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= branchesToDelete.length) return;
          const item = branchesToDelete[idx];
          if (!item) return;
          const { repo, branchName } = item;
          const repoId = repo.id ?? "";
          try {
            const { success, errorMessage } = await deleteBranch(
              client,
              project,
              repoId,
              branchName
            );
            if (success) {
              result.deletedBranches++;
              result.deletedBranchesList.push(`${repo.name ?? ""}/${branchName}`);
            } else {
              result.failedDeletions++;
              const err = errorMessage ?? "Unknown error";
              result.failedBranchesList.push(
                `${repo.name ?? ""}/${branchName} (${err})`
              );
              const lower = err.toLowerCase();
              if (lower.includes("insufficient permissions") || lower.includes("access denied")) {
                result.hasPermissionErrors = true;
              }
            }
          } catch (ex) {
            const errMsg = ex instanceof Error ? ex.message : String(ex);
            result.failedDeletions++;
            result.failedBranchesList.push(
              `${repo.name ?? ""}/${branchName} (${errMsg})`
            );
            const lower = errMsg.toLowerCase();
            if (lower.includes("permissions") || lower.includes("access") || lower.includes("acc\xE8s") || lower.includes("401") || lower.includes("403")) {
              result.hasPermissionErrors = true;
            }
          }
        }
      };
      const workers = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Error while cleaning up the branches: ${message}`);
  }
}
var cleanBranchesTool = {
  name: "tfs_cleanbranches",
  description: "Cleans up branches according to configurable criteria: excludes branches containing 'master', can keep branches with open PRs, recent branches, and the last N branches of config_kube repos",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "The Microsoft TFS project name"
      },
      dryRun: {
        type: "boolean",
        description: "Dry run mode (true) or actual deletion (false) - defaults to true"
      },
      configKubeBranchesToKeep: {
        type: "integer",
        description: "Number of config_kube branches to keep (defaults to 10)"
      },
      branchRetentionMonths: {
        type: "integer",
        description: "Branch retention period in months (defaults to 1)"
      },
      keepBranchesWithOpenPr: {
        type: "boolean",
        description: "Keep branches with open PRs (defaults to true)"
      }
    },
    required: ["project"],
    additionalProperties: false
  },
  handler: async (args, { client }) => {
    const project = typeof args.project === "string" ? args.project : "";
    const dryRun = typeof args.dryRun === "boolean" ? args.dryRun : true;
    let configKubeBranchesToKeep = typeof args.configKubeBranchesToKeep === "number" ? args.configKubeBranchesToKeep : 10;
    let branchRetentionMonths = typeof args.branchRetentionMonths === "number" ? args.branchRetentionMonths : 1;
    const keepBranchesWithOpenPr = typeof args.keepBranchesWithOpenPr === "boolean" ? args.keepBranchesWithOpenPr : true;
    try {
      requireString6(project, "The project name");
      if (configKubeBranchesToKeep < 0) {
        configKubeBranchesToKeep = 10;
      }
      if (branchRetentionMonths < 0) {
        branchRetentionMonths = 1;
      }
      const result = await cleanBranches(
        client,
        project,
        dryRun,
        configKubeBranchesToKeep,
        branchRetentionMonths,
        keepBranchesWithOpenPr
      );
      const lines = [];
      lines.push(`\u{1F9F9} **Branch cleanup - Project ${project}**
`);
      lines.push(
        `\u{1F3AF} **Mode:** ${dryRun ? "\u{1F50D} DRY RUN (no actual deletion)" : "\u26A0\uFE0F ACTUAL DELETION"}`
      );
      lines.push("");
      lines.push(`\u{1F4CA} **Statistics:**`);
      lines.push(`- \u{1F4C2} **Total repositories:** ${result.totalRepositories}`);
      lines.push(`- \u2705 **Eligible repositories:** ${result.eligibleRepositories}`);
      lines.push(
        `- \u274C **Excluded repositories:** ${result.skippedRepositories.length}`
      );
      lines.push(`- \u{1F33F} **Identified branches:** ${result.totalBranches}`);
      if (keepBranchesWithOpenPr && result.skippedBranchesWithPr > 0) {
        lines.push(
          `- \u{1F517} **Excluded branches (open PR):** ${result.skippedBranchesWithPr}`
        );
      }
      if (result.skippedBranchesRecent > 0) {
        lines.push(
          `- \u{1F4C5} **Excluded branches (updated < ${branchRetentionMonths} months ago):** ${result.skippedBranchesRecent}`
        );
      }
      if (!dryRun) {
        lines.push(`- \u{1F5D1}\uFE0F **Deleted branches:** ${result.deletedBranches}`);
        lines.push(`- \u26A0\uFE0F **Deletion failures:** ${result.failedDeletions}`);
      }
      lines.push("");
      if (result.skippedRepositories.length > 0) {
        lines.push(
          `\u{1F6AB} **Excluded repositories (${result.skippedRepositories.length}):**`
        );
        for (const repo of result.skippedRepositories.slice(0, 10)) {
          lines.push(`  - ${repo}`);
        }
        if (result.skippedRepositories.length > 10) {
          lines.push(
            `  ... and ${result.skippedRepositories.length - 10} more`
          );
        }
        lines.push("");
      }
      if (keepBranchesWithOpenPr && result.skippedBranchesWithPrList.length > 0) {
        lines.push(
          `\u{1F517} **Excluded branches with open PR (${result.skippedBranchesWithPrList.length}):**`
        );
        for (const branch of result.skippedBranchesWithPrList.slice(0, 20)) {
          lines.push(`  - \u{1F517} ${branch}`);
        }
        if (result.skippedBranchesWithPrList.length > 20) {
          lines.push(
            `  ... and ${result.skippedBranchesWithPrList.length - 20} more branches`
          );
        }
        lines.push("");
      }
      if (result.skippedBranchesRecentList.length > 0) {
        lines.push(
          `\u{1F4C5} **Excluded branches (updated < ${branchRetentionMonths} months ago) (${result.skippedBranchesRecentList.length}):**`
        );
        for (const branch of result.skippedBranchesRecentList.slice(0, 20)) {
          lines.push(`  - \u{1F4C5} ${branch}`);
        }
        if (result.skippedBranchesRecentList.length > 20) {
          lines.push(
            `  ... and ${result.skippedBranchesRecentList.length - 20} more branches`
          );
        }
        lines.push("");
      }
      if (dryRun && result.deletedBranchesList.length > 0) {
        lines.push(
          `\u{1F50D} **Branches that would be deleted (${result.deletedBranchesList.length}):**`
        );
        for (const branch of result.deletedBranchesList.slice(0, 20)) {
          lines.push(`  - \u{1F33F} ${branch}`);
        }
        if (result.deletedBranchesList.length > 20) {
          lines.push(
            `  ... and ${result.deletedBranchesList.length - 20} more branches`
          );
        }
        lines.push("");
        lines.push(
          `\u{1F4A1} **To perform the actual deletion, rerun with dryRun=false**`
        );
      } else if (!dryRun && result.deletedBranches > 0) {
        lines.push(
          `\u2705 **Branches deleted successfully (${result.deletedBranches}):**`
        );
        for (const branch of result.deletedBranchesList.slice(0, 20)) {
          lines.push(`  - \u{1F5D1}\uFE0F ${branch}`);
        }
        if (result.deletedBranchesList.length > 20) {
          lines.push(
            `  ... and ${result.deletedBranchesList.length - 20} more branches`
          );
        }
        lines.push("");
      }
      if (!dryRun && result.failedBranchesList.length > 0) {
        lines.push(
          `\u26A0\uFE0F **Deletion failures (${result.failedBranchesList.length}):**`
        );
        for (const branch of result.failedBranchesList.slice(0, 10)) {
          lines.push(`  - \u274C ${branch}`);
        }
        if (result.failedBranchesList.length > 10) {
          lines.push(
            `  ... and ${result.failedBranchesList.length - 10} more`
          );
        }
        lines.push("");
      }
      if (!dryRun && result.hasPermissionErrors) {
        lines.push(`\u{1F512} **\u26A0\uFE0F WARNING: Permission errors detected!**`);
        lines.push("");
        lines.push(
          `The permission errors indicate that you do not have the necessary rights to delete some branches.`
        );
        lines.push(
          `Make sure your Microsoft TFS account has the following permissions:`
        );
        lines.push(`  - **Force push** (contribute) on the repositories`);
        lines.push(`  - **Delete** on the branches`);
        lines.push(`  - **Manage permissions** if necessary`);
        lines.push("");
        lines.push(
          `\u{1F4A1} **Solution:** Contact your Microsoft TFS administrator to obtain the necessary permissions.`
        );
        lines.push("");
      }
      lines.push(`\u{1F4CB} **Applied criteria:**`);
      lines.push(`  - \u274C Excluded branches: contain 'master'`);
      if (keepBranchesWithOpenPr) {
        lines.push(`  - \u{1F517} Excluded branches: have an open pull request`);
      }
      lines.push(
        `  - \u{1F4C5} Excluded branches: updated less than ${branchRetentionMonths} months ago`
      );
      lines.push(
        `  - \u{1F4E6} config_kube repos: keep the last ${configKubeBranchesToKeep} branches (by update date)`
      );
      return lines.join("\n") + "\n";
    } catch (err) {
      return formatErrorResponse("cleaning up the branches", err, {
        Project: project,
        Mode: dryRun ? "Dry run" : "Actual deletion"
      });
    }
  }
};
var branchTools = [cleanBranchesTool];

// src/tools/index.ts
var allTools = [
  ...connectionTools,
  ...projectTools,
  ...workItemTools,
  ...repositoryTools,
  ...buildTools,
  ...releaseTools,
  ...pullRequestTools,
  ...branchTools
];

// src/server.ts
var PKG_VERSION = true ? "1.40.0" : "0.0.0-dev";
console.log = (...args) => console.error("[stdout-redirected]", ...args);
var PROCESS_NAME = "yoannyviquel_microsoft-tfs";
function ensureNamedBinary(name) {
  if (process.env.TFS_DISABLE_RENAME === "1") return;
  if (process.platform !== "win32") return;
  try {
    const scriptPath = process.argv[1];
    if (!scriptPath) return;
    const root = path.resolve(path.dirname(scriptPath), "..");
    const binDir = path.join(root, "bin");
    const exe = path.join(binDir, `${name}.exe`);
    if (path.basename(process.execPath).toLowerCase() === `${name}.exe`) return;
    if (!existsSync(exe)) {
      mkdirSync(binDir, { recursive: true });
      copyFileSync(process.execPath, exe);
    }
    try {
      const running = path.basename(process.execPath).toLowerCase();
      for (const f of readdirSync(binDir)) {
        const low = f.toLowerCase();
        if (low.startsWith("yoannyviquel_microsoft-tfs") && low.endsWith(".exe") && low !== `${name}.exe` && low !== running) {
          unlinkSync(path.join(binDir, f));
        }
      }
    } catch {
    }
    const mcpPath = path.join(root, ".mcp.json");
    const desired = "${CLAUDE_PLUGIN_ROOT}/bin/" + name + ".exe";
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    if (mcp?.mcpServers?.tfs && mcp.mcpServers.tfs.command !== desired) {
      mcp.mcpServers.tfs.command = desired;
      writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
    }
  } catch {
  }
}
async function main() {
  try {
    process.title = PROCESS_NAME;
  } catch {
  }
  ensureNamedBinary(PROCESS_NAME);
  const config = loadConfig();
  const client = new TfsClient(config);
  const ctx = { client };
  const server = new Server(
    { name: "microsoft-tfs", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = allTools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `\u274C Unknown tool: ${req.params.name}` }],
        isError: true
      };
    }
    try {
      const text = await tool.handler(req.params.arguments ?? {}, ctx);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const text = formatErrorResponse(`the execution of ${tool.name}`, err);
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`microsoft-tfs v${PKG_VERSION} ready (stdio)
`);
}
main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}
`);
  process.exit(1);
});
//# sourceMappingURL=server.js.map