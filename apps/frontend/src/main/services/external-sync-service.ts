/**
 * External Status Sync Service
 *
 * Handles syncing task status changes to external systems (GitHub Issues, Azure DevOps Work Items)
 * when tasks move on the kanban board.
 *
 * This service is designed to be non-blocking - sync failures should never prevent
 * local status updates from completing.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Project, Task, TaskStatus, TaskMetadata } from '../../shared/types';
import type { ExecutionPhase } from '../../shared/constants/phase-protocol';
import type {
  ExternalSyncConfig,
  ExternalSyncResult,
  ADOStatusMappingConfig,
} from '../../shared/types/sync';
import { mapStatusToGitHub, mapStatusToADO } from '../../shared/types/sync';
import { getGitHubConfig, githubFetch, normalizeRepoReference } from '../ipc-handlers/github/utils';
import { getAzureDevOpsConfig, adoFetch } from '../ipc-handlers/azure-devops/utils';
import { projectStore } from '../project-store';
import type { ADOAttachmentInfo, ADOWorkItemRelation } from '../ipc-handlers/azure-devops/types';
import {
  processWorkItemAttachments,
  generateAttachmentsMarkdown,
  htmlToMarkdownWithImages,
} from '../ipc-handlers/azure-devops/attachment-utils';

/**
 * Context for sync operations - provides additional information for meaningful comments
 */
export interface SyncContext {
  /** The execution phase that triggered this sync */
  phase?: ExecutionPhase;
  /** Progress information (subtasks completed/total, etc.) */
  progress?: {
    completedSubtasks?: number;
    totalSubtasks?: number;
    currentSubtask?: string;
  };
  /** Reason for the status change (e.g., 'task_started', 'phase_complete', 'agent_exit') */
  reason?: 'task_started' | 'phase_transition' | 'agent_exit_success' | 'agent_exit_failure' | 'manual_update' | 'task_stuck';
  /** Exit code if agent process exited */
  exitCode?: number | null;
}

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data) {
      console.debug(`[ExternalSync] ${message}`, data);
    } else {
      console.debug(`[ExternalSync] ${message}`);
    }
  }
}

/**
 * Deduplication cache for ADO sync calls
 * Prevents redundant API calls when multiple handlers trigger sync for the same status change
 * Key: workItemId, Value: { state, timestamp }
 */
const adoSyncCache = new Map<number, { state: string; timestamp: number }>();
const ADO_SYNC_DEDUP_WINDOW_MS = 5000; // 5 seconds - skip duplicate syncs within this window

/**
 * Check if we should skip this ADO sync (already synced to same state recently)
 */
function shouldSkipAdoSync(workItemId: number, targetState: string): boolean {
  const cached = adoSyncCache.get(workItemId);
  if (!cached) return false;

  const now = Date.now();
  const withinWindow = (now - cached.timestamp) < ADO_SYNC_DEDUP_WINDOW_MS;
  const sameState = cached.state === targetState;

  if (withinWindow && sameState) {
    debugLog(`Skipping duplicate ADO sync for work item #${workItemId} to state '${targetState}' (synced ${now - cached.timestamp}ms ago)`);
    return true;
  }

  return false;
}

/**
 * Record a successful ADO sync for deduplication
 */
function recordAdoSync(workItemId: number, state: string): void {
  adoSyncCache.set(workItemId, { state, timestamp: Date.now() });

  // Clean up old entries periodically (keep cache from growing unbounded)
  if (adoSyncCache.size > 100) {
    const now = Date.now();
    for (const [id, entry] of adoSyncCache.entries()) {
      if (now - entry.timestamp > ADO_SYNC_DEDUP_WINDOW_MS * 2) {
        adoSyncCache.delete(id);
      }
    }
  }
}

/**
 * Generate a meaningful discussion comment based on sync context
 */
function generateSyncComment(
  oldAdoState: string | null,
  newAdoState: string,
  context?: SyncContext
): string {
  const parts: string[] = [];

  // Add header
  parts.push('<strong>Auto-Claude Agent Update:</strong>');

  // Add state change info
  if (oldAdoState && oldAdoState !== newAdoState) {
    parts.push(`<br/>📊 Status changed from '<em>${oldAdoState}</em>' to '<em>${newAdoState}</em>'`);
  } else {
    parts.push(`<br/>📊 Status: '<em>${newAdoState}</em>'`);
  }

  // Add phase-specific information
  if (context?.phase) {
    const phaseDescriptions: Record<string, string> = {
      idle: 'Task is idle',
      planning: '📋 Planning phase - AI is analyzing requirements and creating implementation plan',
      coding: '💻 Coding phase - AI is implementing the solution',
      qa_review: '🔍 QA Review phase - AI is validating the implementation',
      qa_fixing: '🔧 QA Fixing phase - AI is addressing issues found during review',
      complete: '✅ Implementation complete - ready for human review',
      failed: '❌ Task failed - requires attention',
    };
    const phaseDesc = phaseDescriptions[context.phase];
    if (phaseDesc) {
      parts.push(`<br/>${phaseDesc}`);
    }
  }

  // Add progress information
  if (context?.progress) {
    const { completedSubtasks, totalSubtasks, currentSubtask } = context.progress;
    if (totalSubtasks !== undefined && completedSubtasks !== undefined) {
      const percentage = totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0;
      parts.push(`<br/>📈 Progress: ${completedSubtasks}/${totalSubtasks} subtasks (${percentage}%)`);
    }
    if (currentSubtask) {
      parts.push(`<br/>🔹 Current: ${currentSubtask}`);
    }
  }

  // Add reason-specific information
  if (context?.reason) {
    switch (context.reason) {
      case 'task_started':
        parts.push('<br/>🚀 Task execution started');
        break;
      case 'agent_exit_success':
        parts.push('<br/>✨ Agent completed successfully - awaiting human review');
        break;
      case 'agent_exit_failure':
        parts.push(`<br/>⚠️ Agent process exited with issues (code: ${context.exitCode ?? 'unknown'}) - needs attention`);
        break;
      case 'task_stuck':
        parts.push('<br/>⚠️ Task appears stuck - marked as running but no active process found. May need manual intervention or recovery.');
        break;
    }
  }

  return parts.join('');
}

/**
 * Default sync configuration
 */
const DEFAULT_SYNC_CONFIG: ExternalSyncConfig = {
  enabled: false,
  syncToGitHub: true,
  syncToAzureDevOps: true,
};

/**
 * Get the sync configuration file path for a project
 */
function getSyncConfigPath(project: Project): string {
  const autoBuildPath = project.autoBuildPath || '.auto-claude';
  return join(project.path, autoBuildPath, 'sync-config.json');
}

/**
 * Load sync configuration for a project
 */
export function loadSyncConfig(project: Project): ExternalSyncConfig {
  const configPath = getSyncConfigPath(project);

  if (!existsSync(configPath)) {
    debugLog(`No sync config file at ${configPath}, using defaults`);
    return DEFAULT_SYNC_CONFIG;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as Partial<ExternalSyncConfig>;
    const mergedConfig = {
      ...DEFAULT_SYNC_CONFIG,
      ...config,
    };

    // Log what mappings were loaded
    if (mergedConfig.adoStatusMapping?.workItemTypeMappings) {
      const types = Object.keys(mergedConfig.adoStatusMapping.workItemTypeMappings);
      debugLog(`Loaded ADO status mappings for types: ${types.join(', ')}`);
      types.forEach(type => {
        debugLog(`  ${type}:`, mergedConfig.adoStatusMapping!.workItemTypeMappings[type]);
      });
    } else {
      debugLog('No custom ADO status mappings configured');
    }

    return mergedConfig;
  } catch (error) {
    debugLog('Failed to load sync config, using defaults:', error);
    return DEFAULT_SYNC_CONFIG;
  }
}

/**
 * Save sync configuration for a project
 */
export function saveSyncConfig(project: Project, config: ExternalSyncConfig): boolean {
  const configPath = getSyncConfigPath(project);

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    debugLog('Saved sync config');
    return true;
  } catch (error) {
    debugLog('Failed to save sync config:', error);
    return false;
  }
}

/**
 * Check if a task has an external link that can be synced
 */
function hasExternalLink(task: Task): boolean {
  const metadata = task.metadata;
  if (!metadata) return false;

  // Check for GitHub link
  if (metadata.sourceType === 'github' && metadata.githubIssueNumber) {
    return true;
  }

  // Check for Azure DevOps link
  if (metadata.sourceType === 'azure_devops' && metadata.azureDevOpsWorkItemId) {
    return true;
  }

  return false;
}

/**
 * Sync task status to GitHub issue
 */
async function syncToGitHub(
  project: Project,
  task: Task,
  newStatus: TaskStatus
): Promise<ExternalSyncResult> {
  const timestamp = new Date().toISOString();
  const metadata = task.metadata as TaskMetadata;
  const issueNumber = metadata.githubIssueNumber!;

  // Map the status to GitHub state
  const githubState = mapStatusToGitHub(newStatus);

  if (!githubState) {
    debugLog(`No GitHub state mapping for status '${newStatus}', skipping sync`);
    return {
      success: true,
      taskId: task.id,
      externalId: issueNumber,
      externalType: 'github',
      action: 'no_action',
      timestamp,
    };
  }

  const config = getGitHubConfig(project);
  if (!config) {
    return {
      success: false,
      taskId: task.id,
      externalId: issueNumber,
      externalType: 'github',
      action: 'state_update',
      error: {
        code: 'NOT_CONFIGURED',
        message: 'GitHub not configured for this project',
        retryable: false,
      },
      timestamp,
    };
  }

  const repo = normalizeRepoReference(config.repo);
  if (!repo) {
    return {
      success: false,
      taskId: task.id,
      externalId: issueNumber,
      externalType: 'github',
      action: 'state_update',
      error: {
        code: 'INVALID_CONFIG',
        message: 'Invalid GitHub repository configuration',
        retryable: false,
      },
      timestamp,
    };
  }

  try {
    await githubFetch(config.token, `/repos/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: githubState }),
    });

    debugLog(`Synced GitHub issue #${issueNumber} to state '${githubState}'`);

    return {
      success: true,
      taskId: task.id,
      externalId: issueNumber,
      externalType: 'github',
      action: 'state_update',
      newState: githubState,
      timestamp,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to sync GitHub issue #${issueNumber}:`, message);

    // Determine if error is retryable
    const is401or403 = message.includes('401') || message.includes('403');
    const is429 = message.includes('429');
    const is5xx = message.includes('500') || message.includes('502') || message.includes('503');

    return {
      success: false,
      taskId: task.id,
      externalId: issueNumber,
      externalType: 'github',
      action: 'state_update',
      error: {
        code: is401or403 ? 'AUTH_ERROR' : is429 ? 'RATE_LIMIT' : is5xx ? 'SERVER_ERROR' : 'UNKNOWN',
        message,
        retryable: is429 || is5xx,
      },
      timestamp,
    };
  }
}

/**
 * Sync task status to Azure DevOps work item
 */
async function syncToAzureDevOps(
  project: Project,
  task: Task,
  oldStatus: TaskStatus | undefined,
  newStatus: TaskStatus,
  adoMapping?: ADOStatusMappingConfig,
  context?: SyncContext
): Promise<ExternalSyncResult> {
  const timestamp = new Date().toISOString();
  const metadata = task.metadata as TaskMetadata;
  const workItemId = metadata.azureDevOpsWorkItemId!;
  const workItemType = metadata.azureDevOpsWorkItemType || 'Task';

  // Map the statuses to ADO states
  const oldAdoState = oldStatus ? mapStatusToADO(oldStatus, workItemType, adoMapping) : null;
  const adoState = mapStatusToADO(newStatus, workItemType, adoMapping);

  if (!adoState) {
    debugLog(`No ADO state mapping for status '${newStatus}' and type '${workItemType}', skipping sync`);
    return {
      success: true,
      taskId: task.id,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'no_action',
      timestamp,
    };
  }

  // Check deduplication - skip if we just synced this work item to the same state
  if (shouldSkipAdoSync(workItemId, adoState)) {
    return {
      success: true,
      taskId: task.id,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'no_action', // Already synced
      timestamp,
    };
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return {
      success: false,
      taskId: task.id,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'state_update',
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Azure DevOps not configured for this project',
        retryable: false,
      },
      timestamp,
    };
  }

  // Build discussion comment - use context-aware generator for meaningful comments
  const discussionComment = generateSyncComment(oldAdoState, adoState, context);

  // Azure DevOps uses JSON Patch format for updates
  const patchDocument = [
    {
      op: 'replace',
      path: '/fields/System.State',
      value: adoState,
    },
    {
      op: 'add',
      path: '/fields/System.History',
      value: discussionComment,
    },
  ];

  // Retry logic for 409 Conflict errors (work item revision mismatch)
  // This happens when multiple concurrent updates occur - a brief delay and retry resolves it
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await adoFetch(
        config,
        `/workitems/${workItemId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json-patch+json',
          },
          body: JSON.stringify(patchDocument),
        }
      );

      debugLog(`Synced ADO work item #${workItemId} to state '${adoState}' with discussion comment`);

      // Record successful sync for deduplication
      recordAdoSync(workItemId, adoState);

      return {
        success: true,
        taskId: task.id,
        externalId: workItemId,
        externalType: 'azure_devops',
        action: 'state_update',
        newState: adoState,
        timestamp,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message;

      // Check if this is a 409 Conflict (revision mismatch) - retry with delay
      const is409Conflict = message.includes('409') || message.includes('Conflict');
      if (is409Conflict && attempt < maxRetries) {
        const delayMs = attempt * 500; // Exponential backoff: 500ms, 1000ms
        debugLog(`ADO 409 Conflict for work item #${workItemId}, retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Non-retryable error or max retries reached
      debugLog(`Failed to sync ADO work item #${workItemId}:`, message);

      // Determine error type
      const isAuthError = message.includes('401') || message.includes('403') || message.includes('Authentication');
      const is5xx = message.includes('500') || message.includes('502') || message.includes('503');

      return {
        success: false,
        taskId: task.id,
        externalId: workItemId,
        externalType: 'azure_devops',
        action: 'state_update',
        error: {
          code: isAuthError ? 'AUTH_ERROR' : is409Conflict ? 'CONFLICT' : is5xx ? 'SERVER_ERROR' : 'UNKNOWN',
          message,
          retryable: is409Conflict || is5xx,
        },
        timestamp,
      };
    }
  }

  // Should not reach here, but handle just in case
  return {
    success: false,
    taskId: task.id,
    externalId: workItemId,
    externalType: 'azure_devops',
    action: 'state_update',
    error: {
      code: 'MAX_RETRIES',
      message: lastError?.message || 'Max retries exceeded',
      retryable: false,
    },
    timestamp,
  };
}

/**
 * Main sync function - syncs task status to all configured external systems
 *
 * This function is designed to be called in a fire-and-forget manner.
 * It should never throw - all errors are logged and returned in the results.
 *
 * @param oldStatus - The previous status before the change (for discussion comments)
 * @param context - Additional context for generating meaningful sync comments
 */
export async function syncTaskStatus(
  project: Project,
  task: Task,
  oldStatus: TaskStatus | undefined,
  newStatus: TaskStatus,
  context?: SyncContext
): Promise<ExternalSyncResult[]> {
  const results: ExternalSyncResult[] = [];

  // Load sync configuration
  const syncConfig = loadSyncConfig(project);

  // Check if sync is enabled
  if (!syncConfig.enabled) {
    debugLog('External sync is disabled for this project');
    return results;
  }

  // Check if task has external link
  if (!hasExternalLink(task)) {
    debugLog(`Task ${task.id} has no external link, skipping sync`);
    return results;
  }

  const metadata = task.metadata;
  if (!metadata) return results;

  // Sync to GitHub if configured and task is from GitHub
  if (
    syncConfig.syncToGitHub &&
    metadata.sourceType === 'github' &&
    metadata.githubIssueNumber
  ) {
    try {
      const result = await syncToGitHub(project, task, newStatus);
      results.push(result);

      if (!result.success) {
        console.warn(`[ExternalSync] GitHub sync failed for task ${task.id}:`, result.error?.message);
      }
    } catch (error) {
      console.error(`[ExternalSync] Unexpected error syncing to GitHub:`, error);
    }
  }

  // Sync to Azure DevOps if configured and task is from ADO
  if (
    syncConfig.syncToAzureDevOps &&
    metadata.sourceType === 'azure_devops' &&
    metadata.azureDevOpsWorkItemId
  ) {
    try {
      const result = await syncToAzureDevOps(
        project,
        task,
        oldStatus,
        newStatus,
        syncConfig.adoStatusMapping,
        context
      );
      results.push(result);

      if (!result.success) {
        console.warn(`[ExternalSync] ADO sync failed for task ${task.id}:`, result.error?.message);
      }
    } catch (error) {
      console.error(`[ExternalSync] Unexpected error syncing to Azure DevOps:`, error);
    }
  }

  return results;
}

/**
 * Link a Pull Request to an Azure DevOps work item
 */
async function linkPRToADOWorkItem(
  project: Project,
  workItemId: number,
  prUrl: string
): Promise<ExternalSyncResult> {
  const timestamp = new Date().toISOString();

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return {
      success: false,
      taskId: '',
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'no_action',
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Azure DevOps not configured for this project',
        retryable: false,
      },
      timestamp,
    };
  }

  try {
    // First, get the current work item to check existing links
    const workItem = await adoFetch<{ relations?: Array<{ url: string; rel: string }> }>(
      config,
      `/workitems/${workItemId}?$expand=relations`
    );

    // Check if PR is already linked
    const existingLink = workItem.relations?.find(r =>
      r.rel === 'ArtifactLink' && r.url.includes(prUrl.replace('https://dev.azure.com/', 'vstfs:///Git/PullRequestId/'))
    );

    if (existingLink) {
      debugLog(`PR already linked to work item #${workItemId}`);
      return {
        success: true,
        taskId: '',
        externalId: workItemId,
        externalType: 'azure_devops',
        action: 'no_action',
        timestamp,
      };
    }

    // Extract PR ID and repository info from URL
    // URL format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
    const prMatch = prUrl.match(/\/pullrequest\/(\d+)/);
    if (!prMatch) {
      return {
        success: false,
        taskId: '',
        externalId: workItemId,
        externalType: 'azure_devops',
        action: 'no_action',
        error: {
          code: 'INVALID_PR_URL',
          message: 'Could not parse PR ID from URL',
          retryable: false,
        },
        timestamp,
      };
    }

    // Get project ID and repository ID for the artifact link
    // First, get the project info
    const projectInfo = await adoFetch<{ id: string }>(
      config,
      `/_apis/projects/${config.project}`
    );

    // Get repository info - extract repo name from PR URL or use config
    const repoMatch = prUrl.match(/_git\/([^/]+)\/pullrequest/);
    const repoName = repoMatch ? repoMatch[1] : config.repository;

    if (!repoName) {
      return {
        success: false,
        taskId: '',
        externalId: workItemId,
        externalType: 'azure_devops',
        action: 'no_action',
        error: {
          code: 'NO_REPOSITORY',
          message: 'Could not determine repository name',
          retryable: false,
        },
        timestamp,
      };
    }

    const repoInfo = await adoFetch<{ id: string }>(
      config,
      `/git/repositories/${repoName}`
    );

    // Build the artifact link URL for ADO
    // Format: vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}
    const artifactUrl = `vstfs:///Git/PullRequestId/${projectInfo.id}%2F${repoInfo.id}%2F${prMatch[1]}`;

    // Add the PR link to the work item
    const patchDocument = [
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: artifactUrl,
          attributes: {
            name: 'Pull Request',
          },
        },
      },
      {
        op: 'add',
        path: '/fields/System.History',
        value: `<strong>Auto-Claude Agent:</strong> Linked Pull Request: <a href="${prUrl}">${prUrl}</a>`,
      },
    ];

    await adoFetch(
      config,
      `/workitems/${workItemId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json-patch+json',
        },
        body: JSON.stringify(patchDocument),
      }
    );

    debugLog(`Linked PR to ADO work item #${workItemId}`);

    return {
      success: true,
      taskId: '',
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'state_update',
      newState: 'PR Linked',
      timestamp,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to link PR to ADO work item #${workItemId}:`, message);

    return {
      success: false,
      taskId: '',
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'state_update',
      error: {
        code: 'LINK_FAILED',
        message,
        retryable: true,
      },
      timestamp,
    };
  }
}

/**
 * Find task and project by task ID
 */
function findTaskAndProject(taskId: string): { task: Task | null; project: Project | null } {
  const projects = projectStore.getProjects();
  for (const project of projects) {
    const tasks = projectStore.getTasks(project.id);
    const task = tasks.find((t: Task) => t.id === taskId);
    if (task) {
      return { task, project };
    }
  }
  return { task: null, project: null };
}

/**
 * Manual sync for a specific task
 * - Syncs current status to external system
 * - Links any PRs to ADO work item
 */
export async function manualSyncTask(taskId: string): Promise<ExternalSyncResult[]> {
  const results: ExternalSyncResult[] = [];

  const { task, project } = findTaskAndProject(taskId);
  if (!task || !project) {
    const timestamp = new Date().toISOString();
    return [{
      success: false,
      taskId,
      externalId: 0,
      externalType: 'azure_devops',
      action: 'no_action',
      error: {
        code: 'NOT_FOUND',
        message: 'Task or project not found',
        retryable: false,
      },
      timestamp,
    }];
  }

  const metadata = task.metadata;
  if (!metadata) {
    const timestamp = new Date().toISOString();
    return [{
      success: false,
      taskId,
      externalId: 0,
      externalType: 'azure_devops',
      action: 'no_action',
      error: {
        code: 'NO_METADATA',
        message: 'Task has no metadata',
        retryable: false,
      },
      timestamp,
    }];
  }

  // Only sync ADO tasks for now
  if (metadata.sourceType !== 'azure_devops' || !metadata.azureDevOpsWorkItemId) {
    const timestamp = new Date().toISOString();
    return [{
      success: false,
      taskId,
      externalId: 0,
      externalType: 'azure_devops',
      action: 'no_action',
      error: {
        code: 'NOT_ADO_TASK',
        message: 'Task is not linked to an Azure DevOps work item',
        retryable: false,
      },
      timestamp,
    }];
  }

  // Load sync configuration
  const syncConfig = loadSyncConfig(project);

  // Sync status (even if sync is disabled, manual sync should work)
  try {
    const statusResult = await syncToAzureDevOps(
      project,
      task,
      undefined, // No old status for manual sync
      task.status,
      syncConfig.adoStatusMapping
    );
    results.push(statusResult);
  } catch (error) {
    console.error('[ExternalSync] Manual sync status failed:', error);
  }

  // Link PR if present
  if (metadata.prUrl) {
    try {
      const prResult = await linkPRToADOWorkItem(
        project,
        metadata.azureDevOpsWorkItemId,
        metadata.prUrl
      );
      prResult.taskId = taskId;
      results.push(prResult);
    } catch (error) {
      console.error('[ExternalSync] Manual sync PR link failed:', error);
    }
  }

  return results;
}

/**
 * Link PR to ADO work item when PR is created
 * Called automatically after PR creation
 */
export async function linkPRToADOOnCreate(
  project: Project,
  task: Task,
  prUrl: string
): Promise<ExternalSyncResult | null> {
  const metadata = task.metadata;
  if (!metadata?.azureDevOpsWorkItemId || metadata.sourceType !== 'azure_devops') {
    return null;
  }

  try {
    const result = await linkPRToADOWorkItem(project, metadata.azureDevOpsWorkItemId, prUrl);
    result.taskId = task.id;
    return result;
  } catch (error) {
    console.error('[ExternalSync] Failed to link PR on create:', error);
    return null;
  }
}

/**
 * Sync task data FROM Azure DevOps work item
 * Fetches the latest data from ADO and updates the local task
 */
export async function syncFromADO(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { task, project } = findTaskAndProject(taskId);
  if (!task || !project) {
    return { success: false, error: 'Task or project not found' };
  }

  const metadata = task.metadata;
  if (!metadata) {
    return { success: false, error: 'Task has no metadata' };
  }

  // Only sync ADO tasks
  if (metadata.sourceType !== 'azure_devops' || !metadata.azureDevOpsWorkItemId) {
    return { success: false, error: 'Task is not linked to an Azure DevOps work item' };
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return { success: false, error: 'Azure DevOps not configured for this project' };
  }

  try {
    // Fetch work item from ADO with relations (for attachments)
    const workItem = await adoFetch<{
      id: number;
      fields: {
        'System.Title'?: string;
        'System.Description'?: string;
        'System.WorkItemType'?: string;
        'System.State'?: string;
        'System.Tags'?: string;
        'Microsoft.VSTS.TCM.ReproSteps'?: string;
        'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
        'Microsoft.VSTS.TCM.SystemInfo'?: string;
        'System.AssignedTo'?: { displayName: string; uniqueName: string };
      };
      relations?: ADOWorkItemRelation[];
    }>(config, `/workitems/${metadata.azureDevOpsWorkItemId}?$expand=relations`);

    const fields = workItem.fields;
    const title = fields['System.Title'] || task.title;
    const workItemType = fields['System.WorkItemType'] || 'Task';
    const tags = fields['System.Tags']?.split(';').map(t => t.trim()).filter(Boolean) || [];

    // Find the spec path - use specsPath from task if available
    const specsBaseDir = project.autoBuildPath ? join(project.autoBuildPath, 'specs') : '.auto-claude/specs';
    const specPath = task.specsPath || join(project.path, specsBaseDir, taskId);

    if (!existsSync(specPath)) {
      return { success: false, error: `Spec directory not found: ${specPath}` };
    }

    // Load existing attachments from task_metadata.json
    const metadataPath = join(specPath, 'task_metadata.json');
    let taskMetadata: Record<string, unknown> = {};
    let existingAttachments: ADOAttachmentInfo[] = [];

    if (existsSync(metadataPath)) {
      try {
        taskMetadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        if (Array.isArray(taskMetadata.attachments)) {
          existingAttachments = taskMetadata.attachments as ADOAttachmentInfo[];
        }
      } catch {
        // Start fresh if parse fails
      }
    }

    // Process attachments (downloads new ones, skips existing)
    let allAttachments: ADOAttachmentInfo[] = [...existingAttachments];
    try {
      // Build a mock work item response for attachment processing
      const workItemForAttachments = {
        id: workItem.id,
        rev: 0,
        url: '',
        fields: fields as Record<string, unknown>,
        relations: workItem.relations,
      };

      const newAttachments = await processWorkItemAttachments(
        workItemForAttachments as never,
        config,
        specPath,
        existingAttachments
      );

      // Merge new attachments with existing ones
      if (newAttachments.length > 0) {
        allAttachments = [...existingAttachments, ...newAttachments];
        debugLog(`Downloaded ${newAttachments.length} new attachments for task ${taskId}`);
      }
    } catch (attachmentError) {
      debugLog('Error processing attachments during sync:', attachmentError);
      // Continue with sync - attachments are not critical
    }

    // Convert HTML to text while preserving inline image references as markdown
    // Use htmlToMarkdownWithImages when attachments are available to keep inline images
    // at their original positions in the text
    const convertHtml = (html: string) =>
      allAttachments.length > 0 ? htmlToMarkdownWithImages(html, allAttachments) : stripHtml(html);

    const description = convertHtml(fields['System.Description'] || '');
    const reproSteps = convertHtml(fields['Microsoft.VSTS.TCM.ReproSteps'] || '');
    const acceptanceCriteria = convertHtml(fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '');

    // Build the TASK.md content in the standard format
    const sections: string[] = [];
    sections.push(`# ${title}`);
    sections.push('');
    sections.push(`**Work Item Type:** ${workItemType}`);
    sections.push(`**ID:** ${metadata.azureDevOpsWorkItemId}`);
    if (tags.length > 0) {
      sections.push(`**Tags:** ${tags.join(', ')}`);
    }
    sections.push('');
    sections.push('---');
    sections.push('');
    sections.push('## Description');
    sections.push('');
    sections.push(description || '*No description provided*');

    if (reproSteps) {
      sections.push('');
      sections.push('## Repro Steps');
      sections.push('');
      sections.push(reproSteps);
    }

    if (acceptanceCriteria) {
      sections.push('');
      sections.push('## Acceptance Criteria');
      sections.push('');
      sections.push(acceptanceCriteria);
    }

    // Add attachments table if we have any
    if (allAttachments.length > 0) {
      sections.push(generateAttachmentsMarkdown(allAttachments));
    }

    sections.push('');
    sections.push('---');
    sections.push('');
    sections.push(`[View in Azure DevOps](${metadata.azureDevOpsUrl})`);

    // Write TASK.md
    const taskMdPath = join(specPath, 'TASK.md');
    writeFileSync(taskMdPath, sections.join('\n'), 'utf-8');

    // Update task_metadata.json with work item type and attachments
    taskMetadata.azureDevOpsWorkItemType = workItemType;
    if (allAttachments.length > 0) {
      taskMetadata.attachments = allAttachments;
    }

    writeFileSync(metadataPath, JSON.stringify(taskMetadata, null, 2), 'utf-8');

    // Update requirements.json with the new description
    const requirementsPath = join(specPath, 'requirements.json');
    let requirements: Record<string, unknown> = {};
    if (existsSync(requirementsPath)) {
      try {
        requirements = JSON.parse(readFileSync(requirementsPath, 'utf-8'));
      } catch {
        // Start fresh if parse fails
      }
    }

    // Build full task description from ADO fields (including attachments)
    const fullDescription: string[] = [];
    if (description) {
      fullDescription.push(description);
    }
    if (reproSteps) {
      fullDescription.push('');
      fullDescription.push('**Repro Steps:**');
      fullDescription.push(reproSteps);
    }
    if (acceptanceCriteria) {
      fullDescription.push('');
      fullDescription.push('**Acceptance Criteria:**');
      fullDescription.push(acceptanceCriteria);
    }
    // Include attachments in the description so they appear in the UI
    if (allAttachments.length > 0) {
      fullDescription.push(generateAttachmentsMarkdown(allAttachments));
    }

    requirements.task_description = fullDescription.join('\n') || description;
    requirements.title = title;

    writeFileSync(requirementsPath, JSON.stringify(requirements, null, 2), 'utf-8');

    // Update implementation_plan.json title if it exists
    const planPath = join(specPath, 'implementation_plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        plan.feature = title;
        plan.title = title;
        plan.description = requirements.task_description;
        plan.updated_at = new Date().toISOString();
        writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf-8');
      } catch {
        // Ignore plan update failures - not critical
      }
    }

    // Invalidate cache so UI refreshes
    projectStore.invalidateTasksCache(project.id);

    debugLog(`Synced task ${taskId} from ADO work item #${metadata.azureDevOpsWorkItemId}`);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to sync task ${taskId} from ADO:`, message);
    return { success: false, error: message };
  }
}

/**
 * Strip HTML tags from text
 */
function stripHtml(html: string): string {
  if (!html) return '';
  // Remove HTML tags
  let text = html.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
  // Normalize whitespace but preserve line breaks (convert <br> and block elements to newlines first)
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Report a task as stuck to Azure DevOps
 * This posts a discussion comment to the work item without changing its state
 *
 * @param taskId - The task ID to report as stuck
 * @param context - Optional additional context (phase, progress, etc.)
 * @returns Result of the sync operation
 */
export async function reportStuckTaskToADO(
  taskId: string,
  context?: Omit<SyncContext, 'reason'>
): Promise<ExternalSyncResult | null> {
  const { task, project } = findTaskAndProject(taskId);
  if (!task || !project) {
    debugLog(`Task ${taskId} not found for stuck reporting`);
    return null;
  }

  const metadata = task.metadata;
  if (!metadata) {
    debugLog(`Task ${taskId} has no metadata`);
    return null;
  }

  // Only report to ADO for ADO-sourced tasks
  if (metadata.sourceType !== 'azure_devops' || !metadata.azureDevOpsWorkItemId) {
    debugLog(`Task ${taskId} is not linked to ADO`);
    return null;
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    debugLog(`ADO not configured for project ${project.id}`);
    return null;
  }

  const workItemId = metadata.azureDevOpsWorkItemId;
  const timestamp = new Date().toISOString();

  // Generate stuck comment - use current ADO state (don't change it)
  const syncContext: SyncContext = {
    ...context,
    reason: 'task_stuck',
  };

  // Build the stuck notification comment
  const discussionComment = generateSyncComment(null, 'Active', syncContext);

  // Post ONLY a comment (using System.History), do NOT change the state
  // This ensures the work item stays in whatever state it was in while
  // still notifying about the stuck issue
  const patchDocument = [
    {
      op: 'add',
      path: '/fields/System.History',
      value: discussionComment,
    },
  ];

  try {
    await adoFetch(
      config,
      `/workitems/${workItemId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json-patch+json',
        },
        body: JSON.stringify(patchDocument),
      }
    );

    debugLog(`Posted stuck notification to ADO work item #${workItemId}`);

    return {
      success: true,
      taskId,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'comment_added',
      timestamp,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to post stuck notification to ADO work item #${workItemId}:`, message);

    return {
      success: false,
      taskId,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'comment_added',
      error: {
        code: 'POST_FAILED',
        message,
        retryable: true,
      },
      timestamp,
    };
  }
}

/**
 * Export the service as an object for consistent API
 */
export const ExternalSyncService = {
  loadConfig: loadSyncConfig,
  saveConfig: saveSyncConfig,
  syncTaskStatus,
  manualSyncTask,
  linkPRToADOOnCreate,
  syncFromADO,
  reportStuckTaskToADO,
};
