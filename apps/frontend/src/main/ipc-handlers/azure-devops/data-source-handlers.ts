/**
 * Azure DevOps data source handlers
 *
 * Handlers for fetching work items from multiple sources:
 * - Teams (required for backlog access)
 * - Backlogs (team-scoped backlog items)
 * - Saved Queries (execute user-saved WIQL queries)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { AzureDevOpsWorkItem, AzureDevOpsTeam, AzureDevOpsBacklog, AzureDevOpsSavedQuery } from '../../../shared/types/integrations';
import type {
  AzureDevOpsConfig,
  ADOTeamListResponse,
  ADOBacklogListResponse,
  ADOBacklogWorkItemsResponse,
  ADOQueryListResponse,
  ADOQueryItem,
  ADOWiqlQueryResponse,
  ADOWorkItemResponse
} from './types';
import { getAzureDevOpsConfig, adoFetch, convertWorkItem, debugLog, getProjectFromStore } from './utils';

/**
 * Make authenticated request to Azure DevOps API with custom base URL
 * Used for endpoints that don't follow the standard pattern
 */
async function adoFetchCustom<T>(
  config: AzureDevOpsConfig,
  fullUrl: string,
  options: RequestInit = {}
): Promise<T> {
  // Add API version
  const separator = fullUrl.includes('?') ? '&' : '?';
  const url = `${fullUrl}${separator}api-version=7.1`;

  // Build auth header
  const auth = Buffer.from(`:${config.pat}`).toString('base64');

  debugLog(`Making custom request: ${options.method || 'GET'} ${url}`);

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    debugLog(`API error: ${response.status} ${response.statusText}`, errorText);

    if (response.status === 401) {
      throw new Error('Authentication failed. Check your Personal Access Token (PAT).');
    }

    if (response.status === 403) {
      throw new Error('Access forbidden. Check PAT permissions (requires Project and Team Read scope for backlogs).');
    }

    if (response.status === 404) {
      throw new Error('Resource not found. Check organization, project, team, or backlog name.');
    }

    throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Convert ADO query item to frontend type (recursive for children)
 */
function convertQueryItem(item: ADOQueryItem): AzureDevOpsSavedQuery {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    isFolder: item.isFolder,
    queryType: item.queryType,
    children: item.children?.map(convertQueryItem),
  };
}

/**
 * Flatten query tree to get all non-folder queries
 */
function flattenQueries(items: AzureDevOpsSavedQuery[]): AzureDevOpsSavedQuery[] {
  const result: AzureDevOpsSavedQuery[] = [];

  for (const item of items) {
    if (!item.isFolder) {
      result.push(item);
    }
    if (item.children) {
      result.push(...flattenQueries(item.children));
    }
  }

  return result;
}

// ============================================
// Teams Handler
// ============================================

/**
 * Get teams from Azure DevOps project
 * Required PAT scope: Project and Team (Read)
 */
export function registerGetTeams(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_TEAMS,
    async (_, projectId: string): Promise<IPCResult<AzureDevOpsTeam[]>> => {
      debugLog('getAzureDevOpsTeams handler called', { projectId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // Teams endpoint: https://dev.azure.com/{organization}/_apis/projects/{project}/teams
        const url = `https://dev.azure.com/${config.organization}/_apis/projects/${encodeURIComponent(config.project)}/teams`;

        const response = await adoFetchCustom<ADOTeamListResponse>(config, url);

        const teams: AzureDevOpsTeam[] = response.value.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
        }));

        debugLog(`Returning ${teams.length} teams`);
        return { success: true, data: teams };
      } catch (error) {
        debugLog('Error fetching teams:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch teams'
        };
      }
    }
  );
}

// ============================================
// Backlogs Handlers
// ============================================

/**
 * Get backlogs for a team
 * Required PAT scope: Work Items (Read), Project and Team (Read)
 */
export function registerGetBacklogs(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_BACKLOGS,
    async (_, projectId: string, teamName?: string): Promise<IPCResult<AzureDevOpsBacklog[]>> => {
      debugLog('getAzureDevOpsBacklogs handler called', { projectId, teamName });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // If no team specified, use project name as default team
        const team = teamName || config.project;

        // Backlogs endpoint: https://dev.azure.com/{organization}/{project}/{team}/_apis/work/backlogs
        const url = `https://dev.azure.com/${config.organization}/${encodeURIComponent(config.project)}/${encodeURIComponent(team)}/_apis/work/backlogs`;

        const response = await adoFetchCustom<ADOBacklogListResponse>(config, url);

        // Filter out hidden backlogs and sort by rank
        const backlogs: AzureDevOpsBacklog[] = response.value
          .filter(b => !b.isHidden)
          .sort((a, b) => a.rank - b.rank)
          .map(b => ({
            id: b.id,
            name: b.name,
            type: b.type,
            color: b.color,
          }));

        debugLog(`Returning ${backlogs.length} backlogs`);
        return { success: true, data: backlogs };
      } catch (error) {
        debugLog('Error fetching backlogs:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch backlogs'
        };
      }
    }
  );
}

/**
 * Get work items from a backlog
 * Required PAT scope: Work Items (Read), Project and Team (Read)
 */
export function registerGetBacklogWorkItems(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_BACKLOG_WORK_ITEMS,
    async (_, projectId: string, backlogId: string, teamName?: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> => {
      debugLog('getAzureDevOpsBacklogWorkItems handler called', { projectId, backlogId, teamName, state });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // If no team specified, use project name as default team
        const team = teamName || config.project;

        // Backlog work items endpoint: https://dev.azure.com/{organization}/{project}/{team}/_apis/work/backlogs/{backlogId}/workitems
        const url = `https://dev.azure.com/${config.organization}/${encodeURIComponent(config.project)}/${encodeURIComponent(team)}/_apis/work/backlogs/${encodeURIComponent(backlogId)}/workitems`;

        const response = await adoFetchCustom<ADOBacklogWorkItemsResponse>(config, url);

        if (!response.workItems || response.workItems.length === 0) {
          debugLog('No work items found in backlog');
          return { success: true, data: [] };
        }

        // Extract work item IDs (limit to first 100 for performance)
        const workItemIds = response.workItems
          .slice(0, 100)
          .map(wi => wi.target.id);

        debugLog(`Fetching ${workItemIds.length} work items from backlog`);

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

        let workItems = workItemsResponse.value.map(item => convertWorkItem(item, config));

        // Apply state filter if specified
        if (state && state !== 'all') {
          const closedStates = ['Closed', 'Removed', 'Done', 'Completed', 'Resolved'];
          if (state === 'open') {
            workItems = workItems.filter(wi => !closedStates.includes(wi.state));
          } else if (state === 'closed') {
            workItems = workItems.filter(wi => closedStates.includes(wi.state));
          }
        }

        debugLog(`Returning ${workItems.length} work items from backlog`);
        return { success: true, data: workItems };
      } catch (error) {
        debugLog('Error fetching backlog work items:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch backlog work items'
        };
      }
    }
  );
}

// ============================================
// Saved Queries Handlers
// ============================================

/**
 * Get saved queries from Azure DevOps project
 * Required PAT scope: Work Items (Read)
 */
export function registerGetSavedQueries(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_SAVED_QUERIES,
    async (_, projectId: string): Promise<IPCResult<AzureDevOpsSavedQuery[]>> => {
      debugLog('getAzureDevOpsSavedQueries handler called', { projectId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // Queries endpoint with depth to get folder children
        // Using $depth=2 to get queries nested in folders
        const response = await adoFetch<ADOQueryListResponse>(
          config,
          '/_apis/wit/queries?$depth=2&$expand=all'
        );

        // Convert to frontend type
        const queries = response.value.map(convertQueryItem);

        // Flatten to get all executable queries (non-folders)
        const flatQueries = flattenQueries(queries);

        // Filter to only include flat queries (tree and oneHop queries need different handling)
        const executableQueries = flatQueries.filter(q => q.queryType === 'flat' || !q.queryType);

        debugLog(`Returning ${executableQueries.length} executable saved queries`);
        return { success: true, data: executableQueries };
      } catch (error) {
        debugLog('Error fetching saved queries:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch saved queries'
        };
      }
    }
  );
}

/**
 * Execute a saved query and return work items
 * Required PAT scope: Work Items (Read)
 */
export function registerExecuteSavedQuery(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_EXECUTE_SAVED_QUERY,
    async (_, projectId: string, queryId: string, state?: 'open' | 'closed' | 'all'): Promise<IPCResult<AzureDevOpsWorkItem[]>> => {
      debugLog('executeAzureDevOpsSavedQuery handler called', { projectId, queryId, state });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        // Execute saved query by ID
        // GET /_apis/wit/wiql/{id}
        const wiqlResult = await adoFetch<ADOWiqlQueryResponse>(
          config,
          `/_apis/wit/wiql/${queryId}`
        );

        if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) {
          debugLog('No work items found from saved query');
          return { success: true, data: [] };
        }

        // Limit to first 100 work items for performance
        const workItemIds = wiqlResult.workItems.slice(0, 100).map(wi => wi.id);

        debugLog(`Fetching ${workItemIds.length} work items from saved query`);

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

        let workItems = workItemsResponse.value.map(item => convertWorkItem(item, config));

        // Apply state filter if specified (since saved queries might not have state filters)
        if (state && state !== 'all') {
          const closedStates = ['Closed', 'Removed', 'Done', 'Completed', 'Resolved'];
          if (state === 'open') {
            workItems = workItems.filter(wi => !closedStates.includes(wi.state));
          } else if (state === 'closed') {
            workItems = workItems.filter(wi => closedStates.includes(wi.state));
          }
        }

        debugLog(`Returning ${workItems.length} work items from saved query`);
        return { success: true, data: workItems };
      } catch (error) {
        debugLog('Error executing saved query:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to execute saved query'
        };
      }
    }
  );
}

// ============================================
// Registration
// ============================================

/**
 * Register all data source handlers
 */
export function registerDataSourceHandlers(): void {
  debugLog('Registering Azure DevOps data source handlers');
  registerGetTeams();
  registerGetBacklogs();
  registerGetBacklogWorkItems();
  registerGetSavedQueries();
  registerExecuteSavedQuery();
  debugLog('Azure DevOps data source handlers registered');
}
