/**
 * Azure DevOps import handlers
 * Handles bulk importing work items as tasks
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { AzureDevOpsImportResult } from '../../../shared/types/integrations';
import type { ADOWorkItemResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, debugLog, getProjectFromStore } from './utils';
import { createSpecForWorkItem, AzureDevOpsTaskInfo } from './spec-utils';

/**
 * Import multiple Azure DevOps work items as tasks
 */
export function registerImportWorkItems(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_IMPORT_WORK_ITEMS,
    async (_event, projectId: string, workItemIds: number[]): Promise<IPCResult<AzureDevOpsImportResult>> => {
      debugLog('importAzureDevOpsWorkItems handler called', { workItemIds });

      const project = getProjectFromStore(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        return {
          success: false,
          error: 'Azure DevOps not configured'
        };
      }

      const tasks: AzureDevOpsTaskInfo[] = [];
      const errors: string[] = [];
      let imported = 0;
      let failed = 0;

      for (const workItemId of workItemIds) {
        try {
          // Fetch the work item with relations expanded to get attachments
          // Note: Azure DevOps API doesn't allow combining 'fields' with '$expand=relations'
          // When using $expand, all fields are returned automatically
          const workItem = await adoFetch<ADOWorkItemResponse>(
            config,
            `/workitems/${workItemId}?$expand=relations`
          );

          // Create a spec/task from the work item
          const task = await createSpecForWorkItem(project, workItem, config, project.settings?.mainBranch);

          if (task) {
            tasks.push(task);
            imported++;
            debugLog('Imported work item:', { id: workItemId, taskId: task.id });
          } else {
            failed++;
            errors.push(`Failed to create task for work item #${workItemId}`);
          }
        } catch (error) {
          failed++;
          const errorMessage = error instanceof Error ? error.message : `Unknown error for work item #${workItemId}`;
          errors.push(errorMessage);
          debugLog('Failed to import work item:', { id: workItemId, error: errorMessage });
        }
      }

      // Note: IPCResult.success indicates transport success (IPC call completed without system error).
      // data.success indicates operation success (at least one work item was imported).
      // This distinction allows the UI to differentiate between system failures and partial imports.
      return {
        success: true,
        data: {
          success: imported > 0,
          imported,
          failed,
          errors: errors.length > 0 ? errors : undefined
        }
      };
    }
  );
}

/**
 * Register all import handlers
 */
export function registerImportHandlers(): void {
  debugLog('Registering Azure DevOps import handlers');
  registerImportWorkItems();
  debugLog('Azure DevOps import handlers registered');
}
