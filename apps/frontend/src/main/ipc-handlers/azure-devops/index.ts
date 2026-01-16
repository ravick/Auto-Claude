/**
 * Azure DevOps IPC Handlers Module
 *
 * This module exports the main registration function for all Azure DevOps-related IPC handlers.
 */

import type { BrowserWindow } from 'electron';
import type { AgentManager } from '../../agent';

import { registerRepositoryHandlers } from './repository-handlers';
import { registerWorkItemHandlers } from './work-item-handlers';
import { registerInvestigationHandlers } from './investigation-handlers';
import { registerImportHandlers } from './import-handlers';
import { registerPRHandlers } from './pr-handlers';

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string): void {
  if (DEBUG) {
    console.debug(`[AzureDevOps] ${message}`);
  }
}

/**
 * Register all Azure DevOps IPC handlers
 */
export function registerAzureDevOpsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  debugLog('Registering all Azure DevOps handlers');

  // Repository/project handlers (connection check, list projects/repos)
  registerRepositoryHandlers();

  // Work item handlers (list, get work items)
  registerWorkItemHandlers();

  // Investigation handlers (AI-powered)
  registerInvestigationHandlers(agentManager, getMainWindow);

  // Import handlers (import work items as tasks)
  registerImportHandlers();

  // Pull request handlers (list, get, review)
  registerPRHandlers(getMainWindow);

  debugLog('All Azure DevOps handlers registered');
}

// Re-export individual registration functions for custom usage
export {
  registerRepositoryHandlers,
  registerWorkItemHandlers,
  registerInvestigationHandlers,
  registerImportHandlers,
  registerPRHandlers
};
