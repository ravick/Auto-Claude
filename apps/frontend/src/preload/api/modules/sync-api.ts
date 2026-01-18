/**
 * External Sync API
 * Preload API for external status sync configuration
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import { invokeIpc } from './ipc-utils';
import type { ExternalSyncConfig, ADOWorkItemType, ADOWorkItemState } from '../../../shared/types/sync';

/**
 * External Sync API interface
 */
export interface SyncAPI {
  // Sync configuration
  getSyncConfig: (projectId: string) => Promise<{ success: boolean; config?: ExternalSyncConfig; error?: string }>;
  saveSyncConfig: (projectId: string, config: ExternalSyncConfig) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Creates the External Sync API implementation
 */
export const createSyncAPI = (): SyncAPI => ({
  getSyncConfig: (projectId: string): Promise<{ success: boolean; config?: ExternalSyncConfig; error?: string }> =>
    invokeIpc(IPC_CHANNELS.EXTERNAL_SYNC_GET_CONFIG, projectId),

  saveSyncConfig: (projectId: string, config: ExternalSyncConfig): Promise<{ success: boolean; error?: string }> =>
    invokeIpc(IPC_CHANNELS.EXTERNAL_SYNC_SAVE_CONFIG, projectId, config),
});
