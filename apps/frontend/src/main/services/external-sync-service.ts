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
import type {
  ExternalSyncConfig,
  ExternalSyncResult,
  ADOStatusMappingConfig,
} from '../../shared/types/sync';
import { mapStatusToGitHub, mapStatusToADO } from '../../shared/types/sync';
import { getGitHubConfig, githubFetch, normalizeRepoReference } from '../ipc-handlers/github/utils';
import { getAzureDevOpsConfig, adoFetch } from '../ipc-handlers/azure-devops/utils';

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
  newStatus: TaskStatus,
  adoMapping?: ADOStatusMappingConfig
): Promise<ExternalSyncResult> {
  const timestamp = new Date().toISOString();
  const metadata = task.metadata as TaskMetadata;
  const workItemId = metadata.azureDevOpsWorkItemId!;
  const workItemType = metadata.azureDevOpsWorkItemType || 'Task';

  // Map the status to ADO state
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

  try {
    // Azure DevOps uses JSON Patch format for updates
    const patchDocument = [
      {
        op: 'replace',
        path: '/fields/System.State',
        value: adoState,
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

    debugLog(`Synced ADO work item #${workItemId} to state '${adoState}'`);

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
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to sync ADO work item #${workItemId}:`, message);

    // Determine if error is retryable
    const isAuthError = message.includes('401') || message.includes('403') || message.includes('Authentication');
    const is5xx = message.includes('500') || message.includes('502') || message.includes('503');

    return {
      success: false,
      taskId: task.id,
      externalId: workItemId,
      externalType: 'azure_devops',
      action: 'state_update',
      error: {
        code: isAuthError ? 'AUTH_ERROR' : is5xx ? 'SERVER_ERROR' : 'UNKNOWN',
        message,
        retryable: is5xx,
      },
      timestamp,
    };
  }
}

/**
 * Main sync function - syncs task status to all configured external systems
 *
 * This function is designed to be called in a fire-and-forget manner.
 * It should never throw - all errors are logged and returned in the results.
 */
export async function syncTaskStatus(
  project: Project,
  task: Task,
  newStatus: TaskStatus
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
        newStatus,
        syncConfig.adoStatusMapping
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
 * Export the service as an object for consistent API
 */
export const ExternalSyncService = {
  loadConfig: loadSyncConfig,
  saveConfig: saveSyncConfig,
  syncTaskStatus,
};
