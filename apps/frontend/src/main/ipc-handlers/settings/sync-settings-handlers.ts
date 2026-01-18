/**
 * External Sync Settings IPC handlers
 *
 * Handles getting and saving external sync configuration for projects.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import { projectStore } from '../../project-store';
import { ExternalSyncService } from '../../services/external-sync-service';
import type { ExternalSyncConfig } from '../../../shared/types/sync';

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
}
