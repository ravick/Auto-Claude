import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  AzureDevOpsProject,
  AzureDevOpsRepository,
  AzureDevOpsWorkItem,
  AzureDevOpsPullRequest,
  AzureDevOpsSyncStatus,
  AzureDevOpsImportResult,
  AzureDevOpsInvestigationStatus,
  AzureDevOpsInvestigationResult,
  AzureDevOpsPRReviewResult,
  AzureDevOpsPRReviewProgress,
  AzureDevOpsTeam,
  AzureDevOpsBacklog,
  AzureDevOpsSavedQuery,
  IPCResult
} from '../../../shared/types';
import { createIpcListener, invokeIpc, sendIpc, IpcListenerCleanup } from './ipc-utils';

/**
 * Azure DevOps Integration API operations
 */
export interface AzureDevOpsAPI {
  // Project and repository operations
  getAzureDevOpsProjects: (projectId: string) => Promise<IPCResult<AzureDevOpsProject[]>>;
  getAzureDevOpsRepositories: (projectId: string) => Promise<IPCResult<AzureDevOpsRepository[]>>;
  checkAzureDevOpsConnection: (projectId: string) => Promise<IPCResult<AzureDevOpsSyncStatus>>;

  // Work item operations
  getAzureDevOpsWorkItems: (projectId: string, state?: 'open' | 'closed' | 'all') => Promise<IPCResult<AzureDevOpsWorkItem[]>>;
  getAzureDevOpsWorkItem: (projectId: string, workItemId: number) => Promise<IPCResult<AzureDevOpsWorkItem>>;
  investigateAzureDevOpsWorkItem: (projectId: string, workItemId: number) => void;
  importAzureDevOpsWorkItems: (projectId: string, workItemIds: number[]) => Promise<IPCResult<AzureDevOpsImportResult>>;

  // Data source operations (teams, backlogs, saved queries)
  getAzureDevOpsTeams: (projectId: string) => Promise<IPCResult<AzureDevOpsTeam[]>>;
  getAzureDevOpsBacklogs: (projectId: string, teamName?: string) => Promise<IPCResult<AzureDevOpsBacklog[]>>;
  getAzureDevOpsBacklogWorkItems: (projectId: string, backlogId: string, teamName?: string, state?: 'open' | 'closed' | 'all') => Promise<IPCResult<AzureDevOpsWorkItem[]>>;
  getAzureDevOpsSavedQueries: (projectId: string) => Promise<IPCResult<AzureDevOpsSavedQuery[]>>;
  executeAzureDevOpsSavedQuery: (projectId: string, queryId: string, state?: 'open' | 'closed' | 'all') => Promise<IPCResult<AzureDevOpsWorkItem[]>>;

  // Pull request operations
  getAzureDevOpsPullRequests: (projectId: string, state?: 'active' | 'completed' | 'abandoned' | 'all') => Promise<IPCResult<AzureDevOpsPullRequest[]>>;
  getAzureDevOpsPullRequest: (projectId: string, pullRequestId: number) => Promise<IPCResult<AzureDevOpsPullRequest>>;
  runAzureDevOpsPRReview: (projectId: string, pullRequestId: number) => void;
  postAzureDevOpsPRComment: (projectId: string, pullRequestId: number, content: string, filePath?: string, line?: number) => Promise<IPCResult<boolean>>;

  // Event listeners
  onAzureDevOpsInvestigationProgress: (
    callback: (projectId: string, status: AzureDevOpsInvestigationStatus) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsInvestigationComplete: (
    callback: (projectId: string, result: AzureDevOpsInvestigationResult) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsInvestigationError: (
    callback: (projectId: string, error: string) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRReviewProgress: (
    callback: (projectId: string, progress: AzureDevOpsPRReviewProgress) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRReviewComplete: (
    callback: (projectId: string, result: AzureDevOpsPRReviewResult) => void
  ) => IpcListenerCleanup;
  onAzureDevOpsPRReviewError: (
    callback: (projectId: string, error: string) => void
  ) => IpcListenerCleanup;
}

/**
 * Creates the Azure DevOps Integration API implementation
 */
export const createAzureDevOpsAPI = (): AzureDevOpsAPI => ({
  // Project and repository operations
  getAzureDevOpsProjects: (projectId: string): Promise<IPCResult<AzureDevOpsProject[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_PROJECTS, projectId),

  getAzureDevOpsRepositories: (projectId: string): Promise<IPCResult<AzureDevOpsRepository[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_REPOSITORIES, projectId),

  checkAzureDevOpsConnection: (projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION, projectId),

  // Work item operations
  getAzureDevOpsWorkItems: (projectId: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS, projectId, state),

  getAzureDevOpsWorkItem: (projectId: string, workItemId: number): Promise<IPCResult<AzureDevOpsWorkItem>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM, projectId, workItemId),

  investigateAzureDevOpsWorkItem: (projectId: string, workItemId: number): void =>
    sendIpc(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATE_WORK_ITEM, projectId, workItemId),

  importAzureDevOpsWorkItems: (projectId: string, workItemIds: number[]): Promise<IPCResult<AzureDevOpsImportResult>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS, projectId, workItemIds),

  // Data source operations (teams, backlogs, saved queries)
  getAzureDevOpsTeams: (projectId: string): Promise<IPCResult<AzureDevOpsTeam[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_TEAMS, projectId),

  getAzureDevOpsBacklogs: (projectId: string, teamName?: string): Promise<IPCResult<AzureDevOpsBacklog[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_BACKLOGS, projectId, teamName),

  getAzureDevOpsBacklogWorkItems: (projectId: string, backlogId: string, teamName?: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_BACKLOG_WORK_ITEMS, projectId, backlogId, teamName, state),

  getAzureDevOpsSavedQueries: (projectId: string): Promise<IPCResult<AzureDevOpsSavedQuery[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_GET_SAVED_QUERIES, projectId),

  executeAzureDevOpsSavedQuery: (projectId: string, queryId: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_EXECUTE_SAVED_QUERY, projectId, queryId, state),

  // Pull request operations
  getAzureDevOpsPullRequests: (projectId: string, state?: 'active' | 'completed' | 'abandoned' | 'all'): Promise<IPCResult<AzureDevOpsPullRequest[]>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_PR_LIST, projectId, state),

  getAzureDevOpsPullRequest: (projectId: string, pullRequestId: number): Promise<IPCResult<AzureDevOpsPullRequest>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_PR_GET, projectId, pullRequestId),

  runAzureDevOpsPRReview: (projectId: string, pullRequestId: number): void =>
    sendIpc(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW, projectId, pullRequestId),

  postAzureDevOpsPRComment: (projectId: string, pullRequestId: number, content: string, filePath?: string, line?: number): Promise<IPCResult<boolean>> =>
    invokeIpc(IPC_CHANNELS.AZURE_DEVOPS_PR_POST_COMMENT, projectId, pullRequestId, content, filePath, line),

  // Event listeners
  onAzureDevOpsInvestigationProgress: (
    callback: (projectId: string, status: AzureDevOpsInvestigationStatus) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_PROGRESS, callback),

  onAzureDevOpsInvestigationComplete: (
    callback: (projectId: string, result: AzureDevOpsInvestigationResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_COMPLETE, callback),

  onAzureDevOpsInvestigationError: (
    callback: (projectId: string, error: string) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_ERROR, callback),

  onAzureDevOpsPRReviewProgress: (
    callback: (projectId: string, progress: AzureDevOpsPRReviewProgress) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_PROGRESS, callback),

  onAzureDevOpsPRReviewComplete: (
    callback: (projectId: string, result: AzureDevOpsPRReviewResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_COMPLETE, callback),

  onAzureDevOpsPRReviewError: (
    callback: (projectId: string, error: string) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_ERROR, callback)
});
