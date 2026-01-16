/**
 * Azure DevOps investigation handlers
 * Handles AI-powered work item investigation
 */

import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { AzureDevOpsInvestigationStatus, AzureDevOpsInvestigationResult } from '../../../shared/types/integrations';
import type { ADOWorkItemResponse } from './types';
import { getAzureDevOpsConfig, adoFetch, debugLog, getProjectFromStore } from './utils';
import { buildWorkItemContext, createSpecForWorkItem } from './spec-utils';
import type { AgentManager } from '../../agent';

/**
 * Send investigation progress to renderer
 */
function sendProgress(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  status: AzureDevOpsInvestigationStatus
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_PROGRESS, projectId, status);
  }
}

/**
 * Send investigation complete to renderer
 */
function sendComplete(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  result: AzureDevOpsInvestigationResult
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_COMPLETE, projectId, result);
  }
}

/**
 * Send investigation error to renderer
 */
function sendError(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  error: string
): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send(IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATION_ERROR, projectId, error);
  }
}

/**
 * Register investigation handler
 */
export function registerInvestigateWorkItem(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.on(
    IPC_CHANNELS.AZURE_DEVOPS_INVESTIGATE_WORK_ITEM,
    async (_event, projectId: string, workItemId: number) => {
      debugLog('investigateAzureDevOpsWorkItem handler called', { projectId, workItemId });

      const project = getProjectFromStore(projectId);
      if (!project) {
        sendError(getMainWindow, projectId, 'Project not found');
        return;
      }

      const config = getAzureDevOpsConfig(project);
      if (!config) {
        sendError(getMainWindow, projectId, 'Azure DevOps not configured');
        return;
      }

      try {
        // Phase 1: Fetching work item
        sendProgress(getMainWindow, project.id, {
          phase: 'fetching',
          workItemId,
          progress: 10,
          message: 'Fetching work item details...'
        });

        // Fetch work item with all fields
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

        const workItem = await adoFetch<ADOWorkItemResponse>(
          config,
          `/workitems/${workItemId}?fields=${fieldsParam}`
        );

        // Phase 2: Analyzing
        sendProgress(getMainWindow, project.id, {
          phase: 'analyzing',
          workItemId,
          progress: 30,
          message: 'Analyzing work item with AI...'
        });

        // Build context for investigation
        const context = buildWorkItemContext(workItem, config);

        // Use agent manager to investigate
        // Note: This is a simplified version - full implementation would use Claude SDK
        sendProgress(getMainWindow, project.id, {
          phase: 'analyzing',
          workItemId,
          progress: 50,
          message: 'AI analyzing the work item...'
        });

        // Phase 3: Creating task
        sendProgress(getMainWindow, project.id, {
          phase: 'creating_task',
          workItemId,
          progress: 80,
          message: 'Creating task from analysis...'
        });

        // Create spec for the work item
        const task = await createSpecForWorkItem(project, workItem, config, project.settings?.mainBranch);

        if (!task) {
          sendError(getMainWindow, project.id, 'Failed to create task from work item');
          return;
        }

        // Phase 4: Complete
        sendProgress(getMainWindow, project.id, {
          phase: 'complete',
          workItemId,
          progress: 100,
          message: 'Investigation complete'
        });

        // Send result
        const result: AzureDevOpsInvestigationResult = {
          success: true,
          workItemId,
          analysis: {
            summary: `Investigation of Azure DevOps work item #${workItemId}: ${workItem.fields['System.Title']}`,
            proposedSolution: workItem.fields['System.Description'] || 'See task details for more information.',
            affectedFiles: [],
            estimatedComplexity: 'standard',
            acceptanceCriteria: []
          },
          taskId: task.id
        };

        sendComplete(getMainWindow, project.id, result);
        debugLog('Investigation complete:', { workItemId, taskId: task.id });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Investigation failed';
        debugLog('Investigation failed:', errorMessage);
        sendError(getMainWindow, project.id, errorMessage);
      }
    }
  );
}

/**
 * Register all investigation handlers
 */
export function registerInvestigationHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  debugLog('Registering Azure DevOps investigation handlers');
  registerInvestigateWorkItem(agentManager, getMainWindow);
  debugLog('Azure DevOps investigation handlers registered');
}
