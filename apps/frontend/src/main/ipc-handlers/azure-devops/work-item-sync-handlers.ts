/**
 * Azure DevOps Work Item Sync handlers
 * Handles updating work item state when tasks move on the kanban board
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import { getAzureDevOpsConfig, adoFetch, debugLog, getProjectFromStore } from './utils';
import type { ADOWorkItemType, ADOWorkItemState } from '../../../shared/types/sync';

/**
 * Response type for work item types API
 */
interface WorkItemTypesResponse {
  count: number;
  value: Array<{
    name: string;
    description?: string;
    icon?: {
      url: string;
    };
  }>;
}

/**
 * Response type for work item states API
 */
interface WorkItemStatesResponse {
  count: number;
  value: Array<{
    name: string;
    color?: string;
    category?: string;
  }>;
}

/**
 * Update a work item's state
 */
async function updateAzureDevOpsWorkItemState(
  projectId: string,
  workItemId: number,
  newState: string
): Promise<{ success: boolean; error?: string }> {
  const project = getProjectFromStore(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return { success: false, error: 'Azure DevOps not configured for this project' };
  }

  try {
    // Azure DevOps uses JSON Patch format for updates
    const patchDocument = [
      {
        op: 'replace',
        path: '/fields/System.State',
        value: newState,
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

    debugLog(`Updated work item #${workItemId} state to '${newState}'`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to update work item #${workItemId}: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Get available work item types for the project
 */
async function getAzureDevOpsWorkItemTypes(
  projectId: string
): Promise<{ success: boolean; types?: ADOWorkItemType[]; error?: string }> {
  const project = getProjectFromStore(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return { success: false, error: 'Azure DevOps not configured for this project' };
  }

  try {
    const response = await adoFetch<WorkItemTypesResponse>(
      config,
      '/workitemtypes'
    );

    const types: ADOWorkItemType[] = response.value.map(wit => ({
      name: wit.name,
      description: wit.description,
      icon: wit.icon?.url,
    }));

    debugLog(`Fetched ${types.length} work item types`);
    return { success: true, types };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to fetch work item types: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Get available states for a specific work item type
 */
async function getAzureDevOpsWorkItemStates(
  projectId: string,
  workItemType: string
): Promise<{ success: boolean; states?: ADOWorkItemState[]; error?: string }> {
  const project = getProjectFromStore(projectId);
  if (!project) {
    return { success: false, error: 'Project not found' };
  }

  const config = getAzureDevOpsConfig(project);
  if (!config) {
    return { success: false, error: 'Azure DevOps not configured for this project' };
  }

  try {
    // URL encode the work item type in case it has spaces (e.g., "User Story")
    const encodedType = encodeURIComponent(workItemType);
    const response = await adoFetch<WorkItemStatesResponse>(
      config,
      `/workitemtypes/${encodedType}/states`
    );

    const states: ADOWorkItemState[] = response.value.map(state => ({
      name: state.name,
      color: state.color,
      category: state.category,
    }));

    debugLog(`Fetched ${states.length} states for work item type '${workItemType}'`);
    return { success: true, states };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Failed to fetch states for work item type '${workItemType}': ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Register Azure DevOps work item sync IPC handlers
 */
export function registerWorkItemSyncHandlers(): void {
  debugLog('Registering work item sync handlers');

  // Update work item state
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_UPDATE_WORK_ITEM_STATE,
    async (_, projectId: string, workItemId: number, state: string) => {
      return updateAzureDevOpsWorkItemState(projectId, workItemId, state);
    }
  );

  // Get work item types
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM_TYPES,
    async (_, projectId: string) => {
      return getAzureDevOpsWorkItemTypes(projectId);
    }
  );

  // Get work item states for a type
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM_STATES,
    async (_, projectId: string, workItemType: string) => {
      return getAzureDevOpsWorkItemStates(projectId, workItemType);
    }
  );

  debugLog('Work item sync handlers registered');
}
