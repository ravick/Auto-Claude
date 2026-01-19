/**
 * Azure DevOps API response types
 *
 * These types represent the raw API responses from Azure DevOps REST API.
 * They are used internally by the handlers and converted to frontend types.
 */

// ============================================
// Work Item Types (from WIT API)
// ============================================

export interface ADOWorkItemResponse {
  id: number;
  rev: number;
  fields: {
    'System.Id': number;
    'System.Title': string;
    'System.Description'?: string;
    'System.State': string;
    'System.WorkItemType': string;
    'System.Tags'?: string;
    'System.CreatedDate': string;
    'System.ChangedDate': string;
    'System.IterationPath'?: string;
    'System.AreaPath'?: string;
    'System.CreatedBy': ADOIdentityRef;
    'System.AssignedTo'?: ADOIdentityRef;
    'System.ChangedBy'?: ADOIdentityRef;
    'Microsoft.VSTS.Common.Priority'?: number;
    'Microsoft.VSTS.Common.Severity'?: string;
    [key: string]: unknown;
  };
  url: string;
  /** Work item relations (attachments, links, etc.) - populated when using $expand=relations */
  relations?: ADOWorkItemRelation[];
  _links?: {
    self: { href: string };
    workItemUpdates: { href: string };
    html: { href: string };
  };
}

export interface ADOWorkItemListResponse {
  count: number;
  value: ADOWorkItemResponse[];
}

export interface ADOWiqlQueryResponse {
  queryType: 'flat' | 'oneHop' | 'tree';
  queryResultType: 'workItem' | 'workItemLink';
  asOf: string;
  columns: Array<{ referenceName: string; name: string; url: string }>;
  workItems: Array<{ id: number; url: string }>;
}

// ============================================
// Identity Types
// ============================================

export interface ADOIdentityRef {
  id?: string;
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
  descriptor?: string;
  _links?: {
    avatar: { href: string };
  };
}

// ============================================
// Project Types
// ============================================

export interface ADOProjectResponse {
  id: string;
  name: string;
  description?: string;
  url: string;
  state: 'wellFormed' | 'createPending' | 'deleted' | 'deleting' | 'new' | 'unchanged';
  revision: number;
  visibility: 'private' | 'public';
  lastUpdateTime: string;
}

export interface ADOProjectListResponse {
  count: number;
  value: ADOProjectResponse[];
}

// ============================================
// Repository Types (from Git API)
// ============================================

export interface ADORepositoryResponse {
  id: string;
  name: string;
  url: string;
  project: {
    id: string;
    name: string;
    state: string;
    visibility: string;
  };
  defaultBranch: string;
  size: number;
  remoteUrl: string;
  sshUrl: string;
  webUrl: string;
  isDisabled?: boolean;
}

export interface ADORepositoryListResponse {
  count: number;
  value: ADORepositoryResponse[];
}

// ============================================
// Pull Request Types (from Git API)
// ============================================

export interface ADOPullRequestResponse {
  pullRequestId: number;
  codeReviewId: number;
  status: 'active' | 'abandoned' | 'completed';
  createdBy: ADOIdentityRef;
  creationDate: string;
  closedDate?: string;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  mergeStatus: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure';
  isDraft: boolean;
  mergeId?: string;
  lastMergeSourceCommit?: {
    commitId: string;
    url: string;
  };
  lastMergeTargetCommit?: {
    commitId: string;
    url: string;
  };
  lastMergeCommit?: {
    commitId: string;
    url: string;
  };
  reviewers: ADOReviewer[];
  labels?: Array<{ id: string; name: string; active: boolean }>;
  url: string;
  supportsIterations: boolean;
  repository: {
    id: string;
    name: string;
    url: string;
    project: {
      id: string;
      name: string;
      state: string;
      visibility: string;
    };
  };
  _links?: {
    self: { href: string };
    web: { href: string };
  };
}

export interface ADOReviewer {
  id: string;
  displayName: string;
  uniqueName: string;
  imageUrl?: string;
  vote: number; // -10=rejected, -5=waiting, 0=no vote, 5=approved with suggestions, 10=approved
  isRequired?: boolean;
  isFlagged?: boolean;
  reviewerUrl?: string;
}

export interface ADOPullRequestListResponse {
  count: number;
  value: ADOPullRequestResponse[];
}

// ============================================
// PR Thread/Comment Types
// ============================================

export interface ADOPRThread {
  id: number;
  publishedDate: string;
  lastUpdatedDate: string;
  comments: ADOPRComment[];
  status: 'unknown' | 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending';
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
    leftFileStart?: { line: number; offset: number };
    leftFileEnd?: { line: number; offset: number };
  };
  isDeleted: boolean;
  _links?: {
    self: { href: string };
  };
}

export interface ADOPRComment {
  id: number;
  parentCommentId: number;
  author: ADOIdentityRef;
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  lastContentUpdatedDate: string;
  commentType: 'unknown' | 'text' | 'codeChange' | 'system';
  usersLiked?: ADOIdentityRef[];
  isDeleted: boolean;
  _links?: {
    self: { href: string };
  };
}

export interface ADOPRThreadListResponse {
  count: number;
  value: ADOPRThread[];
}

// ============================================
// PR Iteration/Changes Types
// ============================================

export interface ADOPRIteration {
  id: number;
  description: string;
  author: ADOIdentityRef;
  createdDate: string;
  updatedDate: string;
  sourceRefCommit: {
    commitId: string;
  };
  targetRefCommit: {
    commitId: string;
  };
  commonRefCommit: {
    commitId: string;
  };
  hasMoreCommits: boolean;
  reason: 'push' | 'forcePush' | 'create' | 'rebase' | 'unknown';
  _links?: {
    self: { href: string };
  };
}

export interface ADOPRIterationListResponse {
  count: number;
  value: ADOPRIteration[];
}

export interface ADOPRChange {
  changeId: number;
  item: {
    objectId: string;
    originalObjectId?: string;
    gitObjectType: 'blob' | 'tree' | 'commit' | 'tag';
    commitId: string;
    path: string;
    isFolder: boolean;
    url: string;
  };
  changeType: 'add' | 'delete' | 'edit' | 'rename' | 'sourceRename' | 'targetRename' | 'all' | 'none';
  sourceServerItem?: string;
  originalPath?: string;
}

export interface ADOPRChangesResponse {
  changeEntries: ADOPRChange[];
  hasMoreChanges: boolean;
}

// ============================================
// Team Types
// ============================================

export interface ADOTeamResponse {
  id: string;
  name: string;
  description?: string;
  url: string;
  identityUrl?: string;
  projectName?: string;
  projectId?: string;
}

export interface ADOTeamListResponse {
  count: number;
  value: ADOTeamResponse[];
}

// ============================================
// Backlog Types (from Work API)
// ============================================

export interface ADOBacklogResponse {
  id: string;
  name: string;
  rank: number;
  type: 'product' | 'portfolio';
  isHidden: boolean;
  color: string;
  workItemCountLimit: number;
}

export interface ADOBacklogListResponse {
  count: number;
  value: ADOBacklogResponse[];
}

export interface ADOBacklogWorkItemsResponse {
  workItems: Array<{
    target: { id: number; url: string };
    source?: { id: number; url: string };
  }>;
}

// ============================================
// Saved Query Types (from WIT API)
// ============================================

export interface ADOQueryItem {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  isPublic: boolean;
  isInvalidSyntax?: boolean;
  queryType?: 'flat' | 'oneHop' | 'tree';
  createdBy?: ADOIdentityRef;
  createdDate?: string;
  lastModifiedBy?: ADOIdentityRef;
  lastModifiedDate?: string;
  hasChildren?: boolean;
  children?: ADOQueryItem[];
  url: string;
  _links?: {
    self: { href: string };
    html: { href: string };
    parent: { href: string };
    wiql: { href: string };
  };
}

export interface ADOQueryListResponse {
  count: number;
  value: ADOQueryItem[];
}

// ============================================
// Attachment Types
// ============================================

/**
 * Represents an attachment downloaded from Azure DevOps
 */
export interface ADOAttachmentInfo {
  /** Azure DevOps attachment GUID */
  id: string;
  /** Original filename from ADO */
  filename: string;
  /** Original URL from ADO */
  originalUrl: string;
  /** Local path relative to spec directory (e.g., "attachments/guid-filename.png") */
  localPath: string;
  /** MIME type of the file */
  mimeType: string;
  /** File size in bytes */
  size: number;
  /** Source: 'inline' for images in HTML content, 'attached' for file attachments */
  source: 'inline' | 'attached';
}

/**
 * Result of an attachment download operation
 */
export interface ADOAttachmentDownloadResult {
  success: boolean;
  attachment?: ADOAttachmentInfo;
  error?: string;
  skipped?: boolean;
  skipReason?: 'already_exists' | 'size_exceeded' | 'invalid_mime_type' | 'invalid_url' | 'download_failed';
}

/**
 * Work item relation from ADO API
 */
export interface ADOWorkItemRelation {
  /** Relation type (e.g., 'AttachedFile', 'ArtifactLink') */
  rel: string;
  /** URL of the related resource */
  url: string;
  /** Relation attributes */
  attributes?: {
    /** Attachment name (for AttachedFile relations) */
    name?: string;
    /** Resource size in bytes */
    resourceSize?: number;
    /** Comment on the attachment */
    comment?: string;
    /** Date the attachment was added */
    authorizedDate?: string;
    /** Resource creation date */
    resourceCreatedDate?: string;
  };
}

// ============================================
// Config Types
// ============================================

export interface AzureDevOpsConfig {
  organization: string;
  project: string;
  pat: string;
  repository?: string;
}
