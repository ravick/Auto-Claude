/**
 * GitHub Issue Sync handlers
 * Handles updating GitHub issue state when tasks move on the kanban board
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import { projectStore } from '../../project-store';
import { getGitHubConfig, githubFetch, normalizeRepoReference } from './utils';
import type { GitHubIssueState } from '../../../shared/types/sync';

/**
 * Update a GitHub issue's state (open/closed)
 */
async function updateGitHubIssueState(
  projectId: string,
  issueNumber: number,
  state: GitHubIssueState
): Promise<{ success: boolean; error?: string }> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const config = getGitHubConfig(project);
  if (!config) {
    return { success: false, error: 'GitHub not configured for this project' };
  }

  const repo = normalizeRepoReference(config.repo);
  if (!repo) {
    return { success: false, error: 'Invalid GitHub repository configuration' };
  }

  try {
    await githubFetch(config.token, `/repos/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state }),
    });

    console.log(`[GitHub Sync] Updated issue #${issueNumber} state to '${state}'`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GitHub Sync] Failed to update issue #${issueNumber}:`, message);
    return { success: false, error: message };
  }
}

/**
 * Add a comment to a GitHub issue
 */
async function addGitHubIssueComment(
  projectId: string,
  issueNumber: number,
  body: string
): Promise<{ success: boolean; error?: string; commentId?: number }> {
  const project = projectStore.getProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const config = getGitHubConfig(project);
  if (!config) {
    return { success: false, error: 'GitHub not configured for this project' };
  }

  const repo = normalizeRepoReference(config.repo);
  if (!repo) {
    return { success: false, error: 'Invalid GitHub repository configuration' };
  }

  try {
    const response = await githubFetch(config.token, `/repos/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    }) as { id: number };

    console.log(`[GitHub Sync] Added comment to issue #${issueNumber}`);
    return { success: true, commentId: response.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GitHub Sync] Failed to add comment to issue #${issueNumber}:`, message);
    return { success: false, error: message };
  }
}

/**
 * Register GitHub issue sync IPC handlers
 */
export function registerIssueSyncHandlers(): void {
  // Update issue state (open/close)
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_UPDATE_ISSUE_STATE,
    async (_, projectId: string, issueNumber: number, state: GitHubIssueState) => {
      return updateGitHubIssueState(projectId, issueNumber, state);
    }
  );

  // Add comment to issue
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_ADD_ISSUE_COMMENT,
    async (_, projectId: string, issueNumber: number, body: string) => {
      return addGitHubIssueComment(projectId, issueNumber, body);
    }
  );
}
