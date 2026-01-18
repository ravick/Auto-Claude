/**
 * External status sync types
 * Types for syncing task status changes to GitHub Issues and Azure DevOps Work Items
 */

import type { TaskStatus } from './task';

/**
 * Azure DevOps work item type mapping configuration
 * Maps Auto-Claude statuses to ADO states for a specific work item type
 */
export interface ADOWorkItemTypeMapping {
  backlog?: string;      // ADO state for 'backlog' (e.g., "New")
  in_progress?: string;  // ADO state for 'in_progress' (e.g., "Active")
  done?: string;         // ADO state for 'done' (e.g., "Closed")
}

/**
 * Azure DevOps status mapping configuration
 * Per-project configuration for mapping Auto-Claude statuses to ADO states
 */
export interface ADOStatusMappingConfig {
  // Per work item type mappings (overrides defaults)
  workItemTypeMappings: Record<string, ADOWorkItemTypeMapping>;
  // Cached available states per work item type (fetched from ADO API)
  availableStates?: Record<string, string[]>;
  // Custom states added by user (for work item types not found in API)
  customStates?: Record<string, string[]>;
}

/**
 * External sync configuration for a project
 */
export interface ExternalSyncConfig {
  enabled: boolean;
  syncToGitHub: boolean;
  syncToAzureDevOps: boolean;
  adoStatusMapping?: ADOStatusMappingConfig;
}

/**
 * Default ADO status mappings for common process templates
 * Note: These use Agile template states by default as they're most common.
 * Users should configure custom mappings if their project uses different states.
 */
export const DEFAULT_ADO_STATUS_MAPPINGS: Record<string, ADOWorkItemTypeMapping> = {
  // Agile process template defaults (most common)
  'Bug': {
    backlog: 'New',
    in_progress: 'Active',
    done: 'Resolved',
  },
  'User Story': {
    backlog: 'New',
    in_progress: 'Active',
    done: 'Closed',
  },
  'Task': {
    backlog: 'New',        // Changed from 'To Do' - 'New' is more universal
    in_progress: 'Active', // Changed from 'In Progress' - 'Active' is more universal
    done: 'Closed',        // Changed from 'Done' - 'Closed' is more universal
  },
  'Feature': {
    backlog: 'New',
    in_progress: 'Active',
    done: 'Closed',
  },
  'Epic': {
    backlog: 'New',
    in_progress: 'Active',
    done: 'Closed',
  },
  'Issue': {
    backlog: 'New',        // Basic template uses 'To Do' but 'New' is safer fallback
    in_progress: 'Active', // Basic template uses 'Doing' but 'Active' is safer
    done: 'Closed',        // Basic template uses 'Done' but 'Closed' is safer
  },
  // Scrum process template additions
  'Product Backlog Item': {
    backlog: 'New',
    in_progress: 'Committed',  // Changed from 'Approved' - more common in Scrum
    done: 'Done',
  },
  // CMMI process template additions
  'Requirement': {
    backlog: 'Proposed',
    in_progress: 'Active',
    done: 'Closed',
  },
};

/**
 * GitHub issue state mapping
 * Maps Auto-Claude statuses to GitHub issue states
 */
export type GitHubIssueState = 'open' | 'closed';

/**
 * Map Auto-Claude status to GitHub issue state
 */
export function mapStatusToGitHub(status: TaskStatus): GitHubIssueState | null {
  switch (status) {
    case 'done':
    case 'pr_created':
      // Completion states close the issue
      return 'closed';
    case 'backlog':
      // Moving back to backlog reopens the issue
      return 'open';
    default:
      // Other statuses (in_progress, ai_review, human_review, error) don't change GitHub issue state
      return null;
  }
}

/**
 * Map internal TaskStatus to the sync category key
 * Groups related statuses into the three sync categories: backlog, in_progress, done
 */
function getStatusCategory(status: TaskStatus): 'backlog' | 'in_progress' | 'done' | null {
  switch (status) {
    case 'backlog':
      return 'backlog';
    case 'in_progress':
    case 'ai_review':
    case 'human_review':
      // All "working" states map to in_progress
      return 'in_progress';
    case 'done':
    case 'pr_created':
      // Both completion states map to done
      return 'done';
    case 'error':
      // Error state doesn't sync (user might want task to stay in current ADO state)
      return null;
    default:
      return null;
  }
}

/**
 * Map Auto-Claude status to ADO work item state
 * Uses custom mapping if available, otherwise falls back to defaults
 */
export function mapStatusToADO(
  status: TaskStatus,
  workItemType: string,
  customMapping?: ADOStatusMappingConfig
): string | null {
  // Get the sync category for this status
  const statusCategory = getStatusCategory(status);
  if (!statusCategory) {
    console.debug(`[mapStatusToADO] No sync category for status '${status}'`);
    return null;
  }

  // Try custom mapping first
  if (customMapping?.workItemTypeMappings?.[workItemType]) {
    const mapping = customMapping.workItemTypeMappings[workItemType];
    const state = mapping[statusCategory];
    if (state) {
      console.debug(`[mapStatusToADO] Using CUSTOM mapping: ${workItemType}.${statusCategory} → '${state}'`);
      return state;
    }
    console.debug(`[mapStatusToADO] Custom mapping exists for '${workItemType}' but no value for '${statusCategory}'`);
  } else if (customMapping?.workItemTypeMappings) {
    console.debug(`[mapStatusToADO] Custom mappings exist but not for '${workItemType}'. Available types:`, Object.keys(customMapping.workItemTypeMappings));
  }

  // Fall back to default mapping
  const defaultMapping = DEFAULT_ADO_STATUS_MAPPINGS[workItemType];
  if (defaultMapping) {
    const state = defaultMapping[statusCategory];
    console.debug(`[mapStatusToADO] Using DEFAULT mapping: ${workItemType}.${statusCategory} → '${state}'`);
    return state || null;
  }

  // No mapping found - try generic fallback
  console.debug(`[mapStatusToADO] No mapping for '${workItemType}', using generic fallback for '${statusCategory}'`);
  switch (statusCategory) {
    case 'backlog':
      return 'New';
    case 'in_progress':
      return 'Active';
    case 'done':
      return 'Closed';
    default:
      return null;
  }
}

/**
 * Result of an external sync operation
 */
export interface ExternalSyncResult {
  success: boolean;
  taskId: string;
  externalId: string | number;
  externalType: 'github' | 'azure_devops';
  action: 'state_update' | 'comment_added' | 'no_action';
  newState?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  timestamp: string;
}

/**
 * Azure DevOps work item type info
 */
export interface ADOWorkItemType {
  name: string;
  description?: string;
  icon?: string;
}

/**
 * Azure DevOps work item state info
 */
export interface ADOWorkItemState {
  name: string;
  color?: string;
  category?: string;  // e.g., "Proposed", "InProgress", "Resolved", "Completed"
}
