/**
 * Azure DevOps work item handlers
 * Handles fetching work items (equivalent to GitHub Issues / GitLab Issues)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { AzureDevOpsWorkItem } from '../../../shared/types/integrations';
import type { ADOWorkItemResponse, ADOWiqlQueryResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, convertWorkItem, debugLog, getProjectFromStore } from './utils';

/**
 * Get work items from Azure DevOps project
 */
export function registerGetWorkItems(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS,
    async (_, projectId: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> => {
      debugLog('getAzureDevOpsWorkItems handler called', { projectId, state });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // Build WIQL query based on state filter
        let stateCondition = '';
        if (state === 'open') {
          stateCondition = " AND [System.State] NOT IN ('Closed', 'Removed', 'Done', 'Completed', 'Resolved')";
        } else if (state === 'closed') {
          stateCondition = " AND [System.State] IN ('Closed', 'Removed', 'Done', 'Completed', 'Resolved')";
        }
        // 'all' means no state filter

        const wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${stateCondition} ORDER BY [System.ChangedDate] DESC`;

        debugLog('Executing WIQL query:', wiqlQuery);

        // Execute WIQL query to get work item IDs
        const wiqlResult = await adoFetch<ADOWiqlQueryResponse>(
          config,
          '/wiql',
          {
            method: 'POST',
            body: JSON.stringify({ query: wiqlQuery }),
          }
        );

        if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) {
          debugLog('No work items found');
          return { success: true, data: [] };
        }

        // Limit to first 100 work items for performance
        const workItemIds = wiqlResult.workItems.slice(0, 100).map(wi => wi.id);

        debugLog(`Fetching ${workItemIds.length} work items`);

        // Fetch work item details in batch
        const idsParam = workItemIds.join(',');
        const fieldsParam = [
          'System.Id',
          'System.Title',
          'System.Description',
          'System.State',
          'System.WorkItemType',
          'System.Tags',
          'System.CreatedDate',
          'System.ChangedDate',
          'System.IterationPath',
          'System.CreatedBy',
          'System.AssignedTo',
        ].join(',');

        const workItemsResponse = await adoFetch<{ count: number; value: ADOWorkItemResponse[] }>(
          config,
          `/workitems?ids=${idsParam}&fields=${fieldsParam}`
        );

        const workItems = workItemsResponse.value.map(item => convertWorkItem(item, config));

        debugLog(`Returning ${workItems.length} work items`);
        return { success: true, data: workItems };
      } catch (error) {
        debugLog('Error fetching work items:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch work items'
        };
      }
    }
  );
}

/**
 * Get a single work item by ID
 */
export function registerGetWorkItem(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEM,
    async (_, projectId: string, workItemId: number): Promise<IPCResult<AzureDevOpsWorkItem>> => {
      debugLog('getAzureDevOpsWorkItem handler called', { projectId, workItemId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        const fieldsParam = [
          'System.Id',
          'System.Title',
          'System.Description',
          'System.State',
          'System.WorkItemType',
          'System.Tags',
          'System.CreatedDate',
          'System.ChangedDate',
          'System.IterationPath',
          'System.CreatedBy',
          'System.AssignedTo',
        ].join(',');

        const workItemResponse = await adoFetch<ADOWorkItemResponse>(
          config,
          `/workitems/${workItemId}?fields=${fieldsParam}`
        );

        const workItem = convertWorkItem(workItemResponse, config);

        return { success: true, data: workItem };
      } catch (error) {
        debugLog('Error fetching work item:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch work item'
        };
      }
    }
  );
}

/**
 * Register all work item handlers
 */
export function registerWorkItemHandlers(): void {
  debugLog('Registering Azure DevOps work item handlers');
  registerGetWorkItems();
  registerGetWorkItem();
  debugLog('Azure DevOps work item handlers registered');
}
