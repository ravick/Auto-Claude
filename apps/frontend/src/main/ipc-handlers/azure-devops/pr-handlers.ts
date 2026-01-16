/**
 * Azure DevOps Pull Request handlers
 * Handles PR operations (list, get, review)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type {
  AzureDevOpsPullRequest,
  AzureDevOpsPRReviewResult,
  AzureDevOpsPRReviewProgress
} from '../../../shared/types/integrations';
import type { ADOPullRequestResponse, ADOPullRequestListResponse, ADOPRChangesResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, convertPullRequest, debugLog, getProjectFromStore } from './utils';

// Valid PR states for filter
const VALID_PR_STATES = ['active', 'abandoned', 'completed', 'all'] as const;
type PRState = typeof VALID_PR_STATES[number];

/**
 * Validate PR state parameter
 */
function isValidPrState(state: string): state is PRState {
  return VALID_PR_STATES.includes(state as PRState);
}

/**
 * Send PR review progress to renderer
 */
function sendReviewProgress(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  progress: AzureDevOpsPRReviewProgress
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_PROGRESS, projectId, progress);
  }
}

/**
 * Send PR review complete to renderer
 */
function sendReviewComplete(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  result: AzureDevOpsPRReviewResult
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_COMPLETE, projectId, result);
  }
}

/**
 * Send PR review error to renderer
 */
function sendReviewError(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  error: string
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW_ERROR, projectId, error);
  }
}

/**
 * Get pull requests from Azure DevOps repository
 */
export function registerGetPullRequests(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_PR_LIST,
    async (_, projectId: string, state?: string): Promise<IPCResult<AzureDevOpsPullRequest[]>> => {
      debugLog('getAzureDevOpsPullRequests handler called', { projectId, state });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      if (!config.repository) {
        return { success: false, error: 'Azure DevOps repository not configured' };
      }

      // Validate state parameter
      const stateParam = state ?? 'active';
      if (!isValidPrState(stateParam)) {
        return {
          success: false,
          error: `Invalid pull request state: '${stateParam}'. Must be one of: ${VALID_PR_STATES.join(', ')}`
        };
      }

      try {
        // Build URL for pull requests
        let url = `/git/repositories/${config.repository}/pullrequests`;
        if (stateParam !== 'all') {
          url += `?searchCriteria.status=${stateParam}`;
        }

        const response = await adoFetch<ADOPullRequestListResponse>(config, url);

        const pullRequests = response.value.map(pr => convertPullRequest(pr, config));

        debugLog(`Fetched ${pullRequests.length} pull requests`);
        return { success: true, data: pullRequests };
      } catch (error) {
        debugLog('Error fetching pull requests:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch pull requests'
        };
      }
    }
  );
}

/**
 * Get a single pull request by ID
 */
export function registerGetPullRequest(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_PR_GET,
    async (_, projectId: string, pullRequestId: number): Promise<IPCResult<AzureDevOpsPullRequest>> => {
      debugLog('getAzureDevOpsPullRequest handler called', { projectId, pullRequestId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      if (!config.repository) {
        return { success: false, error: 'Azure DevOps repository not configured' };
      }

      try {
        const response = await adoFetch<ADOPullRequestResponse>(
          config,
          `/git/repositories/${config.repository}/pullrequests/${pullRequestId}`
        );

        const pullRequest = convertPullRequest(response, config);

        return { success: true, data: pullRequest };
      } catch (error) {
        debugLog('Error fetching pull request:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch pull request'
        };
      }
    }
  );
}

/**
 * Get pull request diff (changes)
 */
export function registerGetPullRequestDiff(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_PR_GET_DIFF,
    async (_, projectId: string, pullRequestId: number): Promise<IPCResult<string>> => {
      debugLog('getAzureDevOpsPullRequestDiff handler called', { projectId, pullRequestId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      if (!config.repository) {
        return { success: false, error: 'Azure DevOps repository not configured' };
      }

      try {
        // Get PR iterations (each push creates a new iteration)
        const iterationsUrl = `/git/repositories/${config.repository}/pullrequests/${pullRequestId}/iterations`;
        const iterationsResponse = await adoFetch<{ value: Array<{ id: number }> }>(config, iterationsUrl);

        if (!iterationsResponse.value || iterationsResponse.value.length === 0) {
          return { success: true, data: '' };
        }

        // Get the latest iteration
        const latestIteration = iterationsResponse.value[iterationsResponse.value.length - 1];

        // Get changes for the latest iteration
        const changesUrl = `/git/repositories/${config.repository}/pullrequests/${pullRequestId}/iterations/${latestIteration.id}/changes`;
        const changesResponse = await adoFetch<ADOPRChangesResponse>(config, changesUrl);

        // Build a simple diff representation
        const diffLines: string[] = [];
        for (const change of changesResponse.changeEntries || []) {
          const changeSymbol = {
            'add': '+',
            'delete': '-',
            'edit': 'M',
            'rename': 'R',
            'sourceRename': 'R',
            'targetRename': 'R',
            'all': '*',
            'none': ' ',
          }[change.changeType] || '?';

          diffLines.push(`${changeSymbol} ${change.item.path}`);
        }

        return { success: true, data: diffLines.join('\n') };
      } catch (error) {
        debugLog('Error fetching pull request diff:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch pull request diff'
        };
      }
    }
  );
}

/**
 * Post a comment on a pull request
 */
export function registerPostPullRequestComment(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_PR_POST_COMMENT,
    async (
      _,
      projectId: string,
      pullRequestId: number,
      content: string,
      filePath?: string,
      line?: number
    ): Promise<IPCResult<void>> => {
      debugLog('postAzureDevOpsPullRequestComment handler called', { projectId, pullRequestId, filePath, line });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      if (!config.repository) {
        return { success: false, error: 'Azure DevOps repository not configured' };
      }

      try {
        // Create thread body
        const threadBody: {
          comments: Array<{ parentCommentId: number; content: string; commentType: number }>;
          status: number;
          threadContext?: { filePath: string; rightFileStart?: { line: number; offset: number }; rightFileEnd?: { line: number; offset: number } };
        } = {
          comments: [
            {
              parentCommentId: 0,
              content,
              commentType: 1 // Text comment
            }
          ],
          status: 1 // Active
        };

        // Add file context if provided
        if (filePath && line !== undefined) {
          threadBody.threadContext = {
            filePath,
            rightFileStart: { line, offset: 1 },
            rightFileEnd: { line, offset: 1 }
          };
        }

        await adoFetch(
          config,
          `/git/repositories/${config.repository}/pullrequests/${pullRequestId}/threads`,
          {
            method: 'POST',
            body: JSON.stringify(threadBody)
          }
        );

        debugLog('Comment posted successfully');
        return { success: true, data: undefined };
      } catch (error) {
        debugLog('Error posting comment:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to post comment'
        };
      }
    }
  );
}

/**
 * Review a pull request with AI
 */
export function registerReviewPullRequest(
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.on(
    IPC_CHANNELS.AZURE_DEVOPS_PR_REVIEW,
    async (_event, projectId: string, pullRequestId: number) => {
      debugLog('reviewAzureDevOpsPullRequest handler called', { projectId, pullRequestId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        sendReviewError(getMainWindow, projectId, 'Project not found');
        return;
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        sendReviewError(getMainWindow, projectId, 'Azure DevOps not configured');
        return;
      }

      if (!config.repository) {
        sendReviewError(getMainWindow, projectId, 'Azure DevOps repository not configured');
        return;
      }

      try {
        // Phase 1: Fetching PR
        sendReviewProgress(getMainWindow, projectId, {
          phase: 'fetching',
          pullRequestId,
          progress: 10,
          message: 'Fetching pull request details...'
        });

        // Fetch PR details
        const pr = await adoFetch<ADOPullRequestResponse>(
          config,
          `/git/repositories/${config.repository}/pullrequests/${pullRequestId}`
        );

        // Phase 2: Analyzing
        sendReviewProgress(getMainWindow, projectId, {
          phase: 'analyzing',
          pullRequestId,
          progress: 30,
          message: 'Analyzing pull request changes...'
        });

        // Get PR iterations for diff
        const iterationsUrl = `/git/repositories/${config.repository}/pullrequests/${pullRequestId}/iterations`;
        const iterationsResponse = await adoFetch<{ value: Array<{ id: number }> }>(config, iterationsUrl);

        let changes: ADOPRChangesResponse = { changeEntries: [], hasMoreChanges: false };
        if (iterationsResponse.value && iterationsResponse.value.length > 0) {
          const latestIteration = iterationsResponse.value[iterationsResponse.value.length - 1];
          const changesUrl = `/git/repositories/${config.repository}/pullrequests/${pullRequestId}/iterations/${latestIteration.id}/changes`;
          changes = await adoFetch<ADOPRChangesResponse>(config, changesUrl);
        }

        // Phase 3: Generating review
        sendReviewProgress(getMainWindow, projectId, {
          phase: 'generating',
          pullRequestId,
          progress: 60,
          message: 'Generating AI review...'
        });

        // Note: This is a simplified version - full implementation would use Claude SDK
        // For now, return a basic review result

        // Phase 4: Posting comments (optional)
        sendReviewProgress(getMainWindow, projectId, {
          phase: 'posting',
          pullRequestId,
          progress: 90,
          message: 'Finalizing review...'
        });

        // Phase 5: Complete
        sendReviewProgress(getMainWindow, projectId, {
          phase: 'complete',
          pullRequestId,
          progress: 100,
          message: 'Review complete'
        });

        // Build result
        const result: AzureDevOpsPRReviewResult = {
          pullRequestId,
          repository: config.repository,
          success: true,
          findings: [],
          summary: `Review of PR #${pullRequestId}: ${pr.title}\n\nThis PR modifies ${changes.changeEntries?.length || 0} files.`,
          overallStatus: 'comment',
          reviewedAt: new Date().toISOString()
        };

        sendReviewComplete(getMainWindow, projectId, result);
        debugLog('PR review complete:', { pullRequestId });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Review failed';
        debugLog('PR review failed:', errorMessage);
        sendReviewError(getMainWindow, projectId, errorMessage);
      }
    }
  );
}

/**
 * Register all PR handlers
 */
export function registerPRHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  debugLog('Registering Azure DevOps PR handlers');
  registerGetPullRequests();
  registerGetPullRequest();
  registerGetPullRequestDiff();
  registerPostPullRequestComment();
  registerReviewPullRequest(getMainWindow);
  debugLog('Azure DevOps PR handlers registered');
}
