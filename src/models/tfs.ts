// TypeScript interfaces mirroring the JSON DTOs returned by the Microsoft TFS / TFS REST API.
// TFS responses use camelCase property names (C# side relies on JsonNamingPolicy.CamelCase).

export interface TfsProject {
  id?: string;
  name?: string;
  description?: string;
  url?: string;
  state?: string;
  visibility?: string;
  lastUpdateTime?: string;
}

export interface TfsProjectsResponse {
  count?: number;
  value?: TfsProject[];
}

export interface TfsIdentity {
  displayName?: string;
  uniqueName?: string;
  id?: string;
  imageUrl?: string;
}

export interface TfsWorkItemFields {
  'System.Id'?: number;
  'System.Title'?: string;
  'System.Description'?: string;
  'System.WorkItemType'?: string;
  'System.State'?: string;
  'System.AssignedTo'?: TfsIdentity;
  'System.CreatedBy'?: TfsIdentity;
  'System.CreatedDate'?: string;
  'System.ChangedDate'?: string;
  'System.Priority'?: number;
  'System.Tags'?: string;
  'System.AreaPath'?: string;
  'System.IterationPath'?: string;
  'Microsoft.VSTS.Scheduling.StoryPoints'?: number;
  'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
}

export interface TfsWorkItem {
  id?: number;
  url?: string;
  fields?: TfsWorkItemFields;
  relations?: Record<string, unknown>;
}

export interface TfsWorkItemPatchOperation {
  op: string;
  path: string;
  value: unknown;
}

export interface TfsWorkItemReference {
  id: number;
  url?: string;
}

export interface TfsQueryResult {
  queryType?: string;
  workItems?: TfsWorkItemReference[];
  columns?: unknown[];
}

export interface TfsWorkItemBatchResponse {
  count?: number;
  value?: TfsWorkItem[];
}

export interface TfsOperationResult {
  success: boolean;
  message: string;
  workItemId?: number;
  workItemUrl?: string;
  operationType?: string;
}

export interface TfsRepository {
  id?: string;
  name?: string;
  url?: string;
  project?: TfsProject;
  defaultBranch?: string;
  remoteUrl?: string;
  size?: number;
}

export interface TfsRepositoriesResponse {
  count?: number;
  value?: TfsRepository[];
}

export interface TfsBuildDefinition {
  id?: number;
  name?: string;
  url?: string;
  path?: string;
  type?: string;
  queueStatus?: string;
  project?: TfsProject;
  repository?: TfsRepository;
}

export interface TfsBuildDefinitionsResponse {
  count?: number;
  value?: TfsBuildDefinition[];
}

export interface TfsBuild {
  id?: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  url?: string;
  repository?: TfsRepository;
  sourceBranch?: string;
  sourceVersion?: string;
  definition?: TfsBuildDefinition;
}

export interface TfsBuildsResponse {
  count?: number;
  value?: TfsBuild[];
}

export interface TfsQueueBuildRequest {
  definition: { id: number };
  sourceBranch?: string;
  sourceVersion?: string;
  parameters?: string;
}

export interface TfsUser {
  displayName?: string;
  uniqueName?: string;
  id?: string;
  imageUrl?: string;
}

export interface TfsReleaseDefinition {
  id?: number;
  name?: string;
  path?: string;
  url?: string;
  releaseNameFormat?: string;
  createdOn?: string;
  modifiedOn?: string;
}

export interface TfsReleaseDefinitionsResponse {
  count?: number;
  value?: TfsReleaseDefinition[];
}

export interface TfsReleaseArtifact {
  alias?: string;
  type?: string;
  isPrimary?: boolean;
  isRetained?: boolean;
}

export interface TfsReleaseDefinitionEnvironmentRef {
  id?: number;
  name?: string;
  rank?: number;
}

/** Detailed release definition (single fetch) — exposes artifacts and environments. */
export interface TfsReleaseDefinitionDetail extends TfsReleaseDefinition {
  artifacts?: TfsReleaseArtifact[];
  environments?: TfsReleaseDefinitionEnvironmentRef[];
}

export interface TfsReleaseDefinitionRef {
  id?: number;
  name?: string;
  path?: string;
  url?: string;
}

export interface TfsReleaseRef {
  id?: number;
  name?: string;
  url?: string;
}

export interface TfsReleaseEnvironment {
  id?: number;
  releaseId?: number;
  name?: string;
  status?: string;
  deploymentStatus?: string;
  createdOn?: string;
  modifiedOn?: string;
}

export interface TfsRelease {
  id?: number;
  name?: string;
  status?: string;
  createdOn?: string;
  modifiedOn?: string;
  url?: string;
  description?: string;
  createdBy?: TfsUser;
  modifiedBy?: TfsUser;
  releaseDefinition?: TfsReleaseDefinitionRef;
  environments?: TfsReleaseEnvironment[];
  _links?: { web?: { href?: string }; self?: { href?: string } };
}

export interface TfsReleasesResponse {
  count?: number;
  value?: TfsRelease[];
}

export interface TfsReleaseDeployment {
  id?: number;
  releaseDefinition?: TfsReleaseDefinitionRef;
  release?: TfsReleaseRef;
  releaseEnvironment?: TfsReleaseEnvironment;
  deploymentStatus?: string;
  operationStatus?: string;
  reason?: string;
  queuedOn?: string;
  startedOn?: string;
  completedOn?: string;
  requestedBy?: TfsUser;
  requestedFor?: TfsUser;
  attempt?: number;
}

export interface TfsReleaseDeploymentsResponse {
  count?: number;
  value?: TfsReleaseDeployment[];
}

export interface TfsUpdateReleaseEnvironmentRequest {
  status: string;
  comment?: string;
}

export interface TfsUpdateReleaseRequest {
  status: string;
  comment?: string;
}

export interface TfsCreateReleaseArtifactMetadata {
  alias: string;
  // instanceReference must carry the build NUMBER (name), not only the id,
  // otherwise the release engine cannot resolve $(Build.BuildNumber) and the
  // release name comes out empty (e.g. " - 001").
  instanceReference: { id: string; name?: string };
}

export interface TfsUpdateReleaseNameRequest {
  name: string;
}

export interface TfsCreateReleaseRequest {
  definitionId: number;
  description?: string;
  isDraft?: boolean;
  artifacts?: TfsCreateReleaseArtifactMetadata[];
  manualEnvironments?: string[];
}

export interface TfsReleaseApproval {
  id?: number;
  revision?: number;
  approvalType?: string;
  status?: string;
  comments?: string;
  createdOn?: string;
  modifiedOn?: string;
  approver?: TfsUser;
  approvedBy?: TfsUser;
  release?: TfsReleaseRef;
  releaseDefinition?: TfsReleaseDefinitionRef;
  releaseEnvironment?: TfsReleaseEnvironment;
  isAutomated?: boolean;
  rank?: number;
  url?: string;
}

export interface TfsReleaseApprovalsResponse {
  count?: number;
  value?: TfsReleaseApproval[];
}

export interface TfsUpdateReleaseApprovalRequest {
  status: string;
  comments?: string;
}

// ---------- Pull Requests ----------

export interface TfsPullRequest {
  pullRequestId?: number;
  title?: string;
  description?: string;
  status?: string;
  creationDate?: string;
  closedDate?: string;
  createdBy?: TfsUser;
  closedBy?: TfsUser;
  sourceRefName?: string;
  targetRefName?: string;
  url?: string;
  repository?: TfsRepository;
  isDraft?: boolean;
  mergeStatus?: string;
  reviewers?: TfsUser[];
  lastMergeSourceCommit?: { commitId?: string };
  autoCompleteSetBy?: TfsUser;
}

export interface TfsConnectionData {
  authenticatedUser?: {
    id?: string;
    displayName?: string;
    uniqueName?: string;
  };
}

export interface TfsPullRequestCompletionOptions {
  mergeStrategy?: string;
  deleteSourceBranch?: boolean;
  mergeCommitMessage?: string;
}

export interface TfsPullRequestSearchResult {
  value?: TfsPullRequest[];
  count?: number;
}

export interface TfsReviewer {
  id?: string;
  isRequired?: boolean;
}

export interface TfsPullRequestCreateRequest {
  sourceRefName: string;
  targetRefName: string;
  title: string;
  description: string;
  isDraft: boolean;
  reviewers: TfsReviewer[];
}

export interface TfsPullRequestCommentRaw {
  id?: number;
  content?: string;
  author?: TfsUser;
  publishedDate?: string;
  lastUpdatedDate?: string;
  lastContentUpdatedDate?: string;
  commentType?: string;
  isDeleted?: boolean;
  url?: string;
}

export interface TfsPullRequestComment extends TfsPullRequestCommentRaw {
  threadId: number;
  threadStatus: string;
}

export interface TfsPullRequestThreadStatusContainer {
  status?: number | string;
}

export interface TfsPullRequestThread
  extends TfsPullRequestThreadStatusContainer {
  id?: number;
  comments?: TfsPullRequestCommentRaw[];
}

export interface TfsPullRequestThreadsResponse {
  value?: TfsPullRequestThread[];
  count?: number;
}

export interface TfsPullRequestFileItem {
  path?: string;
  url?: string;
  objectId?: string;
  gitObjectType?: string;
  isFolder?: boolean;
}

export interface TfsPullRequestChange {
  changeTrackingId?: number;
  changeType?: string;
  item?: TfsPullRequestFileItem;
  sourceServerItem?: TfsPullRequestFileItem;
}

export interface TfsPullRequestChangesResponse {
  changeEntries?: TfsPullRequestChange[];
  value?: TfsPullRequestChange[];
  count?: number;
}

export interface TfsCommitReference {
  commitId?: string;
  url?: string;
}

export interface TfsPushReference {
  pushId?: number;
  date?: string;
  pushedBy?: TfsUser;
}

export interface TfsPullRequestIteration {
  id?: number;
  description?: string;
  author?: TfsUser;
  createdDate?: string;
  updatedDate?: string;
  reason?: string;
  sourceRefCommit?: TfsCommitReference;
  targetRefCommit?: TfsCommitReference;
  commonRefCommit?: TfsCommitReference;
  hasMoreCommits?: boolean;
  push?: TfsPushReference;
}

export interface TfsPullRequestIterationsResponse {
  value?: TfsPullRequestIteration[];
  count?: number;
}

// ---------- Branches ----------

export interface TfsBranch {
  name?: string;
  objectId?: string;
  creator?: TfsUser;
  url?: string;
  /** Computed last commit date (UTC ISO string). Not returned directly by the refs API. */
  lastUpdateDate?: string;
}

export interface TfsBranchesResponse {
  value?: TfsBranch[];
  count?: number;
}

export interface TfsBranchDeletionResult {
  success: boolean;
  errorMessage?: string;
}

export interface TfsCleanBranchesResult {
  totalRepositories: number;
  eligibleRepositories: number;
  totalBranches: number;
  deletedBranches: number;
  failedDeletions: number;
  skippedBranchesWithPr: number;
  skippedBranchesRecent: number;
  hasPermissionErrors: boolean;
  deletedBranchesList: string[];
  failedBranchesList: string[];
  skippedRepositories: string[];
  skippedBranchesWithPrList: string[];
  skippedBranchesRecentList: string[];
}
