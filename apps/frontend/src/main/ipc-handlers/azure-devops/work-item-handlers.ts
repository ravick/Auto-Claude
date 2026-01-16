/**
 * Azure DevOps work item handlers
 * Handles fetching work items (equivalent to GitHub Issues / GitLab Issues)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { AzureDevOpsWorkItem, AzureDevOpsWorkItemsResult } from '../../../shared/types/integrations';
import type { ADOWorkItemResponse, ADOWiqlQueryResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, convertWorkItem, debugLog, getProjectFromStore } from './utils';

// Sort field mapping from user-friendly names to Azure DevOps field names
const SORT_FIELD_MAP: Record<string, string> = {
  'changedDate': '[System.ChangedDate]',
  'createdDate': '[System.CreatedDate]',
  'title': '[System.Title]',
  'state': '[System.State]',
  'priority': '[Microsoft.VSTS.Common.Priority]',
  'workItemType': '[System.WorkItemType]',
};

/**
 * Work item query options for sorting and pagination
 */
export interface WorkItemQueryOptions {
  sortBy?: 'changedDate' | 'createdDate' | 'title' | 'state' | 'priority' | 'workItemType';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

/**
 * Get work items from Azure DevOps project with sorting and pagination
 */
export function registerGetWorkItems(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_WORK_ITEMS,
    async (
      _,
      projectId: string,
      state?: 'open' | 'closed' | 'all',
      options?: WorkItemQueryOptions
    ): Promise<IPCResult<AzureDevOpsWorkItemsResult>> => {
      const sortBy = options?.sortBy || 'changedDate';
      const sortOrder = options?.sortOrder || 'desc';
      const page = options?.page || 1;
      const pageSize = Math.min(options?.pageSize || 50, 100); // Max 100 items per page

      debugLog('getAzureDevOpsWorkItems handler called', { projectId, state, sortBy, sortOrder, page, pageSize });

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

        // Build sort clause
        const sortField = SORT_FIELD_MAP[sortBy] || '[System.ChangedDate]';
        const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

        const wiqlQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${stateCondition} ORDER BY ${sortField} ${sortDirection}`;

        debugLog('Executing WIQL query:', wiqlQuery);

        // Calculate how many IDs we need to fetch
        // We fetch enough IDs to get the current page plus know if there are more
        // Use $top to limit results and avoid the 20,000 item limit
        const maxIdsToFetch = Math.min((page * pageSize) + 1, 10000); // Cap at 10000 to stay well under the 20k limit

        // Execute WIQL query to get work item IDs with $top limit
        const wiqlResult = await adoFetch<ADOWiqlQueryResponse>(
          config,
          `/wiql?$top=${maxIdsToFetch}`,
          {
            method: 'POST',
            body: JSON.stringify({ query: wiqlQuery }),
          }
        );

        if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) {
          debugLog('No work items found');
          return {
            success: true,
            data: {
              items: [],
              total: 0,
              page,
              pageSize,
              hasMore: false
            }
          };
        }

        const fetchedCount = wiqlResult.workItems.length;
        // If we hit the max limit, there might be more items
        const hitLimit = fetchedCount >= maxIdsToFetch;
        // Total is either the fetched count or "at least this many" if we hit the limit
        const totalItems = hitLimit ? maxIdsToFetch : fetchedCount;

        // Apply pagination to the work item IDs
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const paginatedIds = wiqlResult.workItems.slice(startIndex, endIndex).map(wi => wi.id);

        // hasMore is true if there are more items after this page
        const hasMoreItems = endIndex < fetchedCount || hitLimit;

        if (paginatedIds.length === 0) {
          return {
            success: true,
            data: {
              items: [],
              total: totalItems,
              page,
              pageSize,
              hasMore: hitLimit // Still might have more if we hit the limit
            }
          };
        }

        debugLog(`Fetching ${paginatedIds.length} work items (page ${page}, fetched ${fetchedCount}, hitLimit: ${hitLimit})`);

        // Fetch work item details in batch
        const idsParam = paginatedIds.join(',');
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
          'Microsoft.VSTS.Common.Priority',
        ].join(',');

        const workItemsResponse = await adoFetch<{ count: number; value: ADOWorkItemResponse[] }>(
          config,
          `/workitems?ids=${idsParam}&fields=${fieldsParam}`
        );

        const workItems = workItemsResponse.value.map(item => convertWorkItem(item, config));

        debugLog(`Returning ${workItems.length} work items`);
        return {
          success: true,
          data: {
            items: workItems,
            total: totalItems,
            page,
            pageSize,
            hasMore: hasMoreItems
          }
        };
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
