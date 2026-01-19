/**
 * External Sync Settings IPC handlers
 *
 * Handles getting and saving external sync configuration for projects.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import { projectStore } from '../../project-store';
import { ExternalSyncService, manualSyncTask, syncFromADO } from '../../services/external-sync-service';
import type { ExternalSyncConfig, ExternalSyncResult } from '../../../shared/types/sync';

/**
 * Register sync settings IPC handlers
 */
export function registerSyncSettingsHandlers(): void {
  // Get external sync configuration for a project
  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_SYNC_GET_CONFIG,
    async (_, projectId: string): Promise<{ success: boolean; config?: ExternalSyncConfig; error?: string }> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const config = ExternalSyncService.loadConfig(project);
        return { success: true, config };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  // Save external sync configuration for a project
  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_SYNC_SAVE_CONFIG,
    async (_, projectId: string, config: ExternalSyncConfig): Promise<{ success: boolean; error?: string }> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const saved = ExternalSyncService.saveConfig(project, config);
        if (!saved) {
          return { success: false, error: 'Failed to save sync configuration' };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  // Manual sync for a specific task (syncs status and links PRs)
  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_SYNC_MANUAL,
    async (_, taskId: string): Promise<{ success: boolean; results?: ExternalSyncResult[]; error?: string }> => {
      try {
        const results = await manualSyncTask(taskId);
        const hasErrors = results.some(r => !r.success);
        if (hasErrors) {
          const errors = results.filter(r => !r.success).map(r => r.error?.message).join('; ');
          return { success: false, results, error: errors };
        }
        return { success: true, results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );

  // Sync task data FROM Azure DevOps work item (updates local task with ADO data)
  ipcMain.handle(
    IPC_CHANNELS.EXTERNAL_SYNC_FROM_ADO,
    async (_, taskId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const result = await syncFromADO(taskId);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
  );
}
