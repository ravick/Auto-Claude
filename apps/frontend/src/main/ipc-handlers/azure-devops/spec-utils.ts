/**
 * Azure DevOps spec utilities
 * Handles creating task specs from Azure DevOps work items
 */

import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import path from 'path';
import type { Project } from '../../../shared/types';
import type { ADOWorkItemResponse, AzureDevOpsConfig } from './types';
import { stripHtml } from './utils';
import { labelMatchesWholeWord } from '../shared/label-utils';

/**
 * Simplified task info returned when creating a spec from an Azure DevOps work item.
 * This is not a full Task object - it's just the basic info needed for the UI.
 */
export interface AzureDevOpsTaskInfo {
  id: string;
  specId: string;
  title: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.debug(`[AzureDevOps Spec] ${message}`, data);
    } else {
      console.debug(`[AzureDevOps Spec] ${message}`);
    }
  }
}

/**
 * Determine task category based on Azure DevOps work item type and tags
 * Maps to TaskCategory type from shared/types/task.ts
 */
function determineCategoryFromWorkItem(
  workItemType: string,
  tags: string[]
): 'feature' | 'bug_fix' | 'refactoring' | 'documentation' | 'security' | 'performance' | 'ui_ux' | 'infrastructure' | 'testing' {
  // First check work item type
  const typeLC = workItemType.toLowerCase();
  if (typeLC === 'bug') {
    return 'bug_fix';
  }

  // Then check tags
  const lowerTags = tags.map(t => t.toLowerCase());

  if (lowerTags.some(t => t.includes('security') || t.includes('vulnerability') || t.includes('cve'))) {
    return 'security';
  }
  if (lowerTags.some(t => t.includes('performance') || t.includes('optimization') || t.includes('speed'))) {
    return 'performance';
  }
  if (lowerTags.some(t => t.includes('ui') || t.includes('ux') || t.includes('design') || t.includes('styling'))) {
    return 'ui_ux';
  }
  // Use whole-word matching for 'ci' and 'cd' to avoid false positives
  if (lowerTags.some(t =>
    t.includes('infrastructure') ||
    t.includes('devops') ||
    t.includes('deployment') ||
    labelMatchesWholeWord(t, 'ci') ||
    labelMatchesWholeWord(t, 'cd')
  )) {
    return 'infrastructure';
  }
  if (lowerTags.some(t => t.includes('test') || t.includes('testing') || t.includes('qa'))) {
    return 'testing';
  }
  if (lowerTags.some(t => t.includes('refactor') || t.includes('cleanup') || t.includes('maintenance') || t.includes('chore') || t.includes('tech-debt') || t.includes('technical debt'))) {
    return 'refactoring';
  }
  if (lowerTags.some(t => t.includes('documentation') || t.includes('docs'))) {
    return 'documentation';
  }

  return 'feature';
}

function stripControlChars(value: string, allowNewlines: boolean): string {
  let sanitized = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0A || code === 0x0D || code === 0x09) {
      if (allowNewlines) {
        sanitized += value[i];
      }
      continue;
    }
    if (code <= 0x1F || code === 0x7F) {
      continue;
    }
    sanitized += value[i];
  }
  return sanitized;
}

function sanitizeText(value: unknown, maxLength: number, allowNewlines = false): string {
  if (typeof value !== 'string') return '';
  let sanitized = stripControlChars(value, allowNewlines).trim();
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  return sanitized;
}

function sanitizeWorkItemId(value: unknown): number {
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return 0;
  }
  return id;
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const sanitized: string[] = [];
  for (const entry of value) {
    const cleanEntry = sanitizeText(entry, maxLength);
    if (cleanEntry) {
      sanitized.push(cleanEntry);
    }
    if (sanitized.length >= maxItems) {
      break;
    }
  }
  return sanitized;
}

function sanitizeIsoDate(value: unknown): string {
  if (typeof value !== 'string') {
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

interface SanitizedWorkItem {
  id: number;
  title: string;
  description: string;
  state: string;
  workItemType: string;
  tags: string[];
  assignedTo?: string;
  iteration?: string;
  createdDate: string;
  changedDate: string;
  webUrl: string;
}

function sanitizeWorkItemForSpec(
  workItem: ADOWorkItemResponse,
  config: AzureDevOpsConfig
): SanitizedWorkItem {
  const fields = workItem.fields;
  const id = sanitizeWorkItemId(workItem.id);
  const title = sanitizeText(fields['System.Title'], 200) || `Work Item ${id || 'unknown'}`;

  // Parse tags (semicolon-separated)
  const tagsStr = fields['System.Tags'] || '';
  const tags = sanitizeStringArray(tagsStr.split(';').map(t => t.trim()).filter(Boolean), 50, 100);

  // Build web URL
  const webUrl = `https://dev.azure.com/${config.organization}/${config.project}/_workitems/edit/${id}`;

  return {
    id,
    title,
    description: sanitizeText(stripHtml(fields['System.Description'] || ''), 20000, true),
    state: sanitizeText(fields['System.State'], 50) || 'New',
    workItemType: sanitizeText(fields['System.WorkItemType'], 50) || 'Task',
    tags,
    assignedTo: fields['System.AssignedTo']?.displayName
      ? sanitizeText(fields['System.AssignedTo'].displayName, 100)
      : undefined,
    iteration: fields['System.IterationPath']
      ? sanitizeText(fields['System.IterationPath'], 200)
      : undefined,
    createdDate: sanitizeIsoDate(fields['System.CreatedDate']),
    changedDate: sanitizeIsoDate(fields['System.ChangedDate']),
    webUrl,
  };
}

/**
 * Generate a spec directory name from work item title
 */
function generateSpecDirName(workItemId: number, title: string): string {
  // Clean title for directory name
  const cleanTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);

  // Format: 001-work-item-title (padded work item ID)
  const paddedId = String(workItemId).padStart(3, '0');
  return `${paddedId}-${cleanTitle}`;
}

/**
 * Build work item context for spec creation
 */
export function buildWorkItemContext(
  workItem: ADOWorkItemResponse,
  config: AzureDevOpsConfig
): string {
  const lines: string[] = [];
  const safeWorkItem = sanitizeWorkItemForSpec(workItem, config);

  lines.push(`# Azure DevOps Work Item #${safeWorkItem.id}: ${safeWorkItem.title}`);
  lines.push('');
  lines.push(`**Organization:** ${sanitizeText(config.organization, 200)}`);
  lines.push(`**Project:** ${sanitizeText(config.project, 200)}`);
  lines.push(`**Type:** ${safeWorkItem.workItemType}`);
  lines.push(`**State:** ${safeWorkItem.state}`);
  lines.push(`**Created:** ${new Date(safeWorkItem.createdDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`);

  if (safeWorkItem.tags.length > 0) {
    lines.push(`**Tags:** ${safeWorkItem.tags.join(', ')}`);
  }

  if (safeWorkItem.assignedTo) {
    lines.push(`**Assigned To:** ${safeWorkItem.assignedTo}`);
  }

  if (safeWorkItem.iteration) {
    lines.push(`**Iteration:** ${safeWorkItem.iteration}`);
  }

  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(safeWorkItem.description || '_No description provided_');
  lines.push('');
  lines.push(`**Web URL:** ${safeWorkItem.webUrl}`);

  return lines.join('\n');
}

/**
 * Check if a path exists (async)
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a task spec from an Azure DevOps work item
 */
export async function createSpecForWorkItem(
  project: Project,
  workItem: ADOWorkItemResponse,
  config: AzureDevOpsConfig,
  baseBranch?: string
): Promise<AzureDevOpsTaskInfo | null> {
  try {
    // Validate and sanitize network data before writing to disk
    const safeWorkItem = sanitizeWorkItemForSpec(workItem, config);
    if (!safeWorkItem.id) {
      debugLog('Skipping work item with invalid ID', { id: workItem.id });
      return null;
    }

    const specsDir = path.join(project.path, project.autoBuildPath, 'specs');

    // Ensure specs directory exists
    await mkdir(specsDir, { recursive: true });

    // Generate spec directory name
    const specDirName = generateSpecDirName(safeWorkItem.id, safeWorkItem.title);
    const specDir = path.join(specsDir, specDirName);
    const metadataPath = path.join(specDir, 'metadata.json');

    // Check if spec already exists
    if (await pathExists(specDir)) {
      debugLog('Spec already exists for work item:', { id: safeWorkItem.id, specDir });

      // Read existing metadata for accurate timestamps
      let createdAt = new Date(safeWorkItem.createdDate);
      let updatedAt = createdAt;

      if (await pathExists(metadataPath)) {
        try {
          const metadataContent = await readFile(metadataPath, 'utf-8');
          const metadata = JSON.parse(metadataContent);
          if (metadata.createdAt) {
            createdAt = new Date(metadata.createdAt);
          }
          // Use file modification time for updatedAt
          const stats = await stat(metadataPath);
          updatedAt = new Date(stats.mtimeMs);
        } catch {
          // Fallback to work item dates if metadata read fails
        }
      }

      // Return existing task info
      return {
        id: specDirName,
        specId: specDirName,
        title: safeWorkItem.title,
        description: safeWorkItem.description,
        createdAt,
        updatedAt
      };
    }

    // Create spec directory
    await mkdir(specDir, { recursive: true });

    // Create TASK.md with work item context
    const taskContent = buildWorkItemContext(workItem, config);
    await writeFile(path.join(specDir, 'TASK.md'), taskContent, 'utf-8');

    // Create metadata.json (Azure DevOps-specific data)
    const metadata = {
      source: 'azure_devops',
      azureDevOps: {
        workItemId: safeWorkItem.id,
        organization: sanitizeText(config.organization, 200),
        project: sanitizeText(config.project, 200),
        webUrl: safeWorkItem.webUrl,
        state: safeWorkItem.state,
        workItemType: safeWorkItem.workItemType,
        tags: safeWorkItem.tags,
        createdAt: safeWorkItem.createdDate
      },
      createdAt: new Date().toISOString(),
      status: 'pending'
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // Create task_metadata.json (consistent with GitHub/GitLab format for backend compatibility)
    const taskMetadata = {
      sourceType: 'azure_devops' as const,
      azureDevOpsWorkItemId: safeWorkItem.id,
      azureDevOpsUrl: safeWorkItem.webUrl,
      category: determineCategoryFromWorkItem(safeWorkItem.workItemType, safeWorkItem.tags),
      // Store baseBranch for worktree creation and QA comparison
      ...(baseBranch && { baseBranch })
    };
    await writeFile(
      path.join(specDir, 'task_metadata.json'),
      JSON.stringify(taskMetadata, null, 2),
      'utf-8'
    );

    debugLog('Created spec for work item:', { id: safeWorkItem.id, specDir });

    // Return task info
    return {
      id: specDirName,
      specId: specDirName,
      title: safeWorkItem.title,
      description: safeWorkItem.description,
      createdAt: new Date(safeWorkItem.createdDate),
      updatedAt: new Date()
    };
  } catch (error) {
    debugLog('Failed to create spec for work item:', { id: workItem.id, error });
    return null;
  }
}
