/**
 * Azure DevOps repository-related IPC handlers
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { AzureDevOpsSyncStatus, AzureDevOpsProject, AzureDevOpsRepository } from '../../../shared/types/integrations';
import type { ADOProjectListResponse, ADORepositoryListResponse, ADOWiqlQueryResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, debugLog, getProjectFromStore } from './utils';

/**
 * Check Azure DevOps connection status
 */
export function registerCheckConnection(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<AzureDevOpsSyncStatus>> => {
      console.log('[AzureDevOps] CHECK_CONNECTION called with projectId:', projectId);

      const project = getProjectFromStore(projectId);
      if (!project) {
        console.log('[AzureDevOps] Project not found');
        return { success: false, error: 'Project not found' };
      }

      console.log('[AzureDevOps] Project found:', project.name, 'autoBuildPath:', project.autoBuildPath);

      const config = getAzureDevOpsConfig(project);
      console.log('[AzureDevOps] Config loaded:', config ? 'yes' : 'no', config ? { org: config.organization, project: config.project, hasPat: !!config.pat } : null);

      if (!config) {
        console.log('[AzureDevOps] No config found - returning not configured');
        return {
          success: true,
          data: {
            connected: false,
            error: 'Azure DevOps not configured'
          }
        };
      }

      try {
        debugLog('Checking Azure DevOps connection...');

        // Test connection by fetching project info
        const projectUrl = `https://dev.azure.com/${config.organization}/_apis/projects/${config.project}?api-version=7.1`;
        const auth = Buffer.from(`:${config.pat}`).toString('base64');

        const response = await fetch(projectUrl, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          debugLog(`Connection check failed: ${response.status}`, errorText);

          if (response.status === 401) {
            return {
              success: true,
              data: {
                connected: false,
                error: 'Authentication failed. Check your PAT.'
              }
            };
          }

          if (response.status === 404) {
            return {
              success: true,
              data: {
                connected: false,
                error: 'Project not found. Check organization and project names.'
              }
            };
          }

          return {
            success: true,
            data: {
              connected: false,
              error: `Connection failed: ${response.status}`
            }
          };
        }

        const projectData = await response.json();
        debugLog('Project info retrieved:', projectData.name);

        // Count work items using WIQL
        let workItemCount = 0;
        try {
          const wiqlResult = await adoFetch<ADOWiqlQueryResponse>(
            config,
            '/wiql',
            {
              method: 'POST',
              body: JSON.stringify({
                query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' AND [System.State] <> 'Removed'"
              }),
            }
          );
          workItemCount = wiqlResult.workItems?.length || 0;
        } catch (e) {
          debugLog('Could not count work items:', e);
        }

        return {
          success: true,
          data: {
            connected: true,
            organization: config.organization,
            project: projectData.name,
            repository: config.repository,
            workItemCount,
            lastSyncedAt: new Date().toISOString(),
          }
        };
      } catch (error) {
        debugLog('Connection check error:', error);
        return {
          success: true,
          data: {
            connected: false,
            error: error instanceof Error ? error.message : 'Connection failed'
          }
        };
      }
    }
  );
}

/**
 * Get list of Azure DevOps projects in the organization
 */
export function registerGetProjects(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_PROJECTS,
    async (_, projectId: string): Promise<IPCResult<AzureDevOpsProject[]>> => {
      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        debugLog('Fetching Azure DevOps projects...');

        // Fetch projects from organization
        const url = `https://dev.azure.com/${config.organization}/_apis/projects?api-version=7.1`;
        const auth = Buffer.from(`:${config.pat}`).toString('base64');

        const response = await fetch(url, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch projects: ${response.status}`);
        }

        const data: ADOProjectListResponse = await response.json();

        const projects: AzureDevOpsProject[] = data.value.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          url: p.url,
          state: p.state,
          visibility: p.visibility,
        }));

        debugLog(`Found ${projects.length} projects`);
        return { success: true, data: projects };
      } catch (error) {
        debugLog('Error fetching projects:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch projects'
        };
      }
    }
  );
}

/**
 * Get list of repositories in the project
 */
export function registerGetRepositories(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_REPOSITORIES,
    async (_, projectId: string): Promise<IPCResult<AzureDevOpsRepository[]>> => {
      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return { success: false, error: 'Azure DevOps not configured' };
      }

      try {
        debugLog('Fetching Azure DevOps repositories...');

        const data = await adoFetch<ADORepositoryListResponse>(
          config,
          '/git/repositories'
        );

        const repositories: AzureDevOpsRepository[] = data.value.map(r => ({
          id: r.id,
          name: r.name,
          url: r.url,
          webUrl: r.webUrl,
          defaultBranch: r.defaultBranch?.replace('refs/heads/', '') || 'main',
          project: {
            id: r.project.id,
            name: r.project.name,
          },
        }));

        debugLog(`Found ${repositories.length} repositories`);
        return { success: true, data: repositories };
      } catch (error) {
        debugLog('Error fetching repositories:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to fetch repositories'
        };
      }
    }
  );
}

/**
 * Register all repository-related handlers
 */
export function registerRepositoryHandlers(): void {
  registerCheckConnection();
  registerGetProjects();
  registerGetRepositories();
}
