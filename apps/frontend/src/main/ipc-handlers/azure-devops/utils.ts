/**
 * Azure DevOps IPC handler utilities
 *
 * Shared utility functions for Azure DevOps API interactions.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { projectStore } from '../../project-store';
import type { Project } from '../../../shared/types';
import type { AzureDevOpsConfig, ADOWorkItemResponse, ADOPullRequestResponse } from './types';
import type { AzureDevOpsWorkItem, AzureDevOpsPullRequest } from '../../../shared/types/integrations';

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

export function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data) {
      console.debug(`[AzureDevOps] ${message}`, data);
    } else {
      console.debug(`[AzureDevOps] ${message}`);
    }
  }
}

/**
 * Get Azure DevOps configuration from project
 */
export function getAzureDevOpsConfig(project: Project): AzureDevOpsConfig | null {
  try {
    // Read .env from project's autoBuildPath directory
    if (!project.autoBuildPath) {
      debugLog('Project has no autoBuildPath configured');
      return null;
    }

    const envPath = join(project.path, project.autoBuildPath, '.env');

    if (!existsSync(envPath)) {
      debugLog(`No ${project.autoBuildPath}/.env file found`);
      return null;
    }

    const envContent = readFileSync(envPath, 'utf-8');
    const envVars: Record<string, string> = {};

    // Use /\r?\n/ to handle both Unix (\n) and Windows (\r\n) line endings
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex > 0) {
        const key = trimmed.substring(0, equalsIndex).trim();
        let value = trimmed.substring(equalsIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        envVars[key] = value;
      }
    }

    const enabled = envVars['AZURE_DEVOPS_ENABLED'] === 'true';
    const organization = envVars['AZURE_DEVOPS_ORGANIZATION'];
    const adoProject = envVars['AZURE_DEVOPS_PROJECT'];
    const pat = envVars['AZURE_DEVOPS_PAT'];
    const repository = envVars['AZURE_DEVOPS_REPOSITORY'];

    if (!enabled || !organization || !adoProject || !pat) {
      debugLog('Azure DevOps not configured or disabled');
      return null;
    }

    return {
      organization,
      project: adoProject,
      pat,
      repository,
    };
  } catch (error) {
    debugLog('Error reading Azure DevOps config:', error);
    return null;
  }
}

/**
 * Make authenticated request to Azure DevOps API
 */
export async function adoFetch<T>(
  config: AzureDevOpsConfig,
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  // Determine base URL based on endpoint type
  let baseUrl: string;
  let area = 'wit';

  if (endpoint.startsWith('/git/')) {
    area = 'git';
    endpoint = endpoint.replace('/git/', '/');
  }

  // Build URL
  if (endpoint.startsWith('/_apis/')) {
    // Full endpoint path
    baseUrl = `https://dev.azure.com/${config.organization}/${config.project}${endpoint}`;
  } else {
    // Build with area
    baseUrl = `https://dev.azure.com/${config.organization}/${config.project}/_apis/${area}${endpoint}`;
  }

  // Add API version
  const separator = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${separator}api-version=7.1`;

  // Build auth header
  const auth = Buffer.from(`:${config.pat}`).toString('base64');

  debugLog(`Making request: ${options.method || 'GET'} ${url}`);

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
      throw new Error('Access forbidden. Check PAT permissions.');
    }

    if (response.status === 404) {
      throw new Error('Resource not found. Check organization, project, or repository name.');
    }

    throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Strip HTML tags from text
 */
export function stripHtml(text: string): string {
  if (!text) return '';
  // Remove HTML tags
  let result = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Normalize whitespace
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Convert Azure DevOps work item to frontend type
 */
export function convertWorkItem(item: ADOWorkItemResponse, config: AzureDevOpsConfig): AzureDevOpsWorkItem {
  const fields = item.fields;

  // Parse tags (semicolon-separated)
  const tagsStr = fields['System.Tags'] || '';
  const tags = tagsStr.split(';').map(t => t.trim()).filter(Boolean);

  // Build URL
  const webUrl = `https://dev.azure.com/${config.organization}/${config.project}/_workitems/edit/${item.id}`;

  return {
    id: item.id,
    title: fields['System.Title'] || '',
    description: stripHtml(fields['System.Description'] || ''),
    state: fields['System.State'] || 'New',
    workItemType: fields['System.WorkItemType'] || 'Task',
    tags,
    assignedTo: fields['System.AssignedTo'] ? {
      displayName: fields['System.AssignedTo'].displayName,
      uniqueName: fields['System.AssignedTo'].uniqueName,
      imageUrl: fields['System.AssignedTo'].imageUrl,
    } : undefined,
    createdBy: {
      displayName: fields['System.CreatedBy']?.displayName || 'Unknown',
      uniqueName: fields['System.CreatedBy']?.uniqueName || '',
      imageUrl: fields['System.CreatedBy']?.imageUrl,
    },
    iteration: fields['System.IterationPath'],
    createdDate: fields['System.CreatedDate'],
    changedDate: fields['System.ChangedDate'],
    url: webUrl,
    organizationUrl: `https://dev.azure.com/${config.organization}`,
    project: config.project,
  };
}

/**
 * Convert Azure DevOps PR to frontend type
 */
export function convertPullRequest(pr: ADOPullRequestResponse, config: AzureDevOpsConfig): AzureDevOpsPullRequest {
  // Strip refs/heads/ prefix from branch names
  const sourceBranch = pr.sourceRefName?.replace('refs/heads/', '') || '';
  const targetBranch = pr.targetRefName?.replace('refs/heads/', '') || '';

  // Build web URL
  const webUrl = pr._links?.web?.href ||
    `https://dev.azure.com/${config.organization}/${config.project}/_git/${pr.repository.name}/pullrequest/${pr.pullRequestId}`;

  return {
    pullRequestId: pr.pullRequestId,
    title: pr.title || '',
    description: pr.description,
    status: pr.status,
    sourceBranch,
    targetBranch,
    createdBy: {
      displayName: pr.createdBy?.displayName || 'Unknown',
      uniqueName: pr.createdBy?.uniqueName || '',
      imageUrl: pr.createdBy?.imageUrl,
    },
    reviewers: pr.reviewers?.map(r => ({
      displayName: r.displayName,
      uniqueName: r.uniqueName,
      vote: r.vote,
      isRequired: r.isRequired,
    })) || [],
    labels: pr.labels?.map(l => ({ name: l.name })) || [],
    webUrl,
    creationDate: pr.creationDate,
    closedDate: pr.closedDate,
    isDraft: pr.isDraft || false,
    mergeStatus: pr.mergeStatus || 'notSet',
    repository: {
      name: pr.repository?.name || config.repository || '',
      project: { name: config.project },
    },
  };
}

/**
 * Map Azure DevOps state to normalized open/closed
 */
export function mapWorkItemState(adoState: string): 'open' | 'closed' {
  const closedStates = ['Closed', 'Removed', 'Done', 'Completed', 'Resolved'];
  return closedStates.includes(adoState) ? 'closed' : 'open';
}

/**
 * Get project from store by ID
 */
export function getProjectFromStore(projectId: string): Project | null {
  return projectStore.getProject(projectId) ?? null;
}
