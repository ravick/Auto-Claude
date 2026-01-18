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
 * Field mapping configuration for Azure DevOps work item types.
 * Each work item type can have multiple detail fields that should be included
 * when importing work items as tasks.
 */
export interface ADOFieldMapping {
  /** Field reference name (e.g., 'Microsoft.VSTS.TCM.ReproSteps') */
  field: string;
  /** Display label for the field (e.g., 'Repro Steps') */
  label: string;
  /** Whether the field contains HTML content that needs to be stripped */
  isHtml?: boolean;
}

/**
 * Default field mappings per work item type.
 * These are common fields used in Azure DevOps Agile, Scrum, and Basic process templates.
 * Users can override these via project configuration.
 */
export const DEFAULT_WORK_ITEM_FIELD_MAPPINGS: Record<string, ADOFieldMapping[]> = {
  // Bug-specific fields
  Bug: [
    { field: 'Microsoft.VSTS.TCM.ReproSteps', label: 'Repro Steps', isHtml: true },
    { field: 'Microsoft.VSTS.TCM.SystemInfo', label: 'System Info', isHtml: true },
    { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria', isHtml: true },
  ],
  // User Story fields (Agile template)
  'User Story': [
    { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria', isHtml: true },
  ],
  // Product Backlog Item fields (Scrum template)
  'Product Backlog Item': [
    { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria', isHtml: true },
  ],
  // Feature fields
  Feature: [
    { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria', isHtml: true },
  ],
  // Epic fields
  Epic: [
    { field: 'Microsoft.VSTS.Common.AcceptanceCriteria', label: 'Acceptance Criteria', isHtml: true },
  ],
  // Task - usually just uses Description
  Task: [],
  // Issue (Basic template)
  Issue: [],
};

/**
 * Get all fields that should be fetched for a work item based on its type.
 * Includes both standard fields and type-specific detail fields.
 */
export function getFieldsForWorkItemType(workItemType?: string): string[] {
  // Standard fields that all work items have
  const standardFields = [
    'System.Id',
    'System.Title',
    'System.Description',
    'System.State',
    'System.WorkItemType',
    'System.Tags',
    'System.CreatedDate',
    'System.ChangedDate',
    'System.IterationPath',
    'System.AreaPath',
    'System.CreatedBy',
    'System.AssignedTo',
  ];

  // If we know the work item type, add type-specific fields
  if (workItemType) {
    const mappings = DEFAULT_WORK_ITEM_FIELD_MAPPINGS[workItemType] || [];
    const typeSpecificFields = mappings.map(m => m.field);
    return [...new Set([...standardFields, ...typeSpecificFields])];
  }

  // If we don't know the type yet, fetch all possible detail fields
  // This is used for initial fetch before we know the work item type
  const allDetailFields = new Set<string>();
  for (const mappings of Object.values(DEFAULT_WORK_ITEM_FIELD_MAPPINGS)) {
    for (const mapping of mappings) {
      allDetailFields.add(mapping.field);
    }
  }

  return [...new Set([...standardFields, ...allDetailFields])];
}

/**
 * Get field mappings for a specific work item type
 */
export function getFieldMappingsForType(workItemType: string): ADOFieldMapping[] {
  return DEFAULT_WORK_ITEM_FIELD_MAPPINGS[workItemType] || [];
}

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

/**
 * Represents a detail field with its label and content
 */
interface DetailField {
  label: string;
  content: string;
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
  areaPath?: string;
  createdDate: string;
  changedDate: string;
  webUrl: string;
  /** Type-specific detail fields (e.g., Repro Steps for Bugs) */
  detailFields: DetailField[];
}

function sanitizeWorkItemForSpec(
  workItem: ADOWorkItemResponse,
  config: AzureDevOpsConfig
): SanitizedWorkItem {
  const fields = workItem.fields;
  const id = sanitizeWorkItemId(workItem.id);
  const title = sanitizeText(fields['System.Title'], 200) || `Work Item ${id || 'unknown'}`;
  const workItemType = sanitizeText(fields['System.WorkItemType'], 50) || 'Task';

  // Parse tags (semicolon-separated)
  const tagsStr = fields['System.Tags'] || '';
  const tags = sanitizeStringArray(tagsStr.split(';').map(t => t.trim()).filter(Boolean), 50, 100);

  // Build web URL
  const webUrl = `https://dev.azure.com/${config.organization}/${config.project}/_workitems/edit/${id}`;

  // Extract type-specific detail fields (e.g., Repro Steps for Bugs, Acceptance Criteria for User Stories)
  // Note: Fields that don't exist on the work item are safely skipped - the Azure DevOps API
  // simply omits fields that aren't present, so fields[mapping.field] returns undefined.
  // This allows us to define mappings for fields that may or may not exist on a given work item.
  const detailFields: DetailField[] = [];
  const fieldMappings = getFieldMappingsForType(workItemType);

  for (const mapping of fieldMappings) {
    const rawValue = fields[mapping.field];
    // Skip if field doesn't exist, is null, undefined, or empty
    if (rawValue != null && rawValue !== '') {
      const content = mapping.isHtml
        ? sanitizeText(stripHtml(String(rawValue)), 20000, true)
        : sanitizeText(String(rawValue), 20000, true);

      // Only add if there's actual content after sanitization
      if (content.trim()) {
        detailFields.push({
          label: mapping.label,
          content,
        });
      }
    }
  }

  return {
    id,
    title,
    description: sanitizeText(stripHtml(fields['System.Description'] || ''), 20000, true),
    state: sanitizeText(fields['System.State'], 50) || 'New',
    workItemType,
    tags,
    assignedTo: fields['System.AssignedTo']?.displayName
      ? sanitizeText(fields['System.AssignedTo'].displayName, 100)
      : undefined,
    iteration: fields['System.IterationPath']
      ? sanitizeText(fields['System.IterationPath'], 200)
      : undefined,
    areaPath: fields['System.AreaPath']
      ? sanitizeText(fields['System.AreaPath'], 200)
      : undefined,
    createdDate: sanitizeIsoDate(fields['System.CreatedDate']),
    changedDate: sanitizeIsoDate(fields['System.ChangedDate']),
    webUrl,
    detailFields,
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

  if (safeWorkItem.areaPath) {
    lines.push(`**Area:** ${safeWorkItem.areaPath}`);
  }

  // Add Description section
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(safeWorkItem.description || '_No description provided_');

  // Add type-specific detail fields (e.g., Repro Steps for Bugs, Acceptance Criteria for User Stories)
  // Note: If no detail fields exist (field not on work item type or empty), this loop is safely skipped
  for (const detailField of safeWorkItem.detailFields) {
    lines.push('');
    lines.push(`## ${detailField.label}`);
    lines.push('');
    lines.push(detailField.content);
  }

  lines.push('');
  lines.push('---');
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
 * Build a full task description including type-specific detail fields
 */
function buildFullTaskDescription(safeWorkItem: SanitizedWorkItem): string {
  const parts: string[] = [];

  // Start with the main description
  if (safeWorkItem.description) {
    parts.push(safeWorkItem.description);
  }

  // Add type-specific detail fields (e.g., Repro Steps for Bugs)
  // Note: If no detail fields exist (field not on work item type or empty), this loop is safely skipped
  for (const detailField of safeWorkItem.detailFields) {
    parts.push('');
    parts.push(`**${detailField.label}:**`);
    parts.push(detailField.content);
  }

  return parts.join('\n').trim() || '_No description provided_';
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

      // Return existing task info with full description including detail fields
      return {
        id: specDirName,
        specId: specDirName,
        title: safeWorkItem.title,
        description: buildFullTaskDescription(safeWorkItem),
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
      azureDevOpsWorkItemType: safeWorkItem.workItemType,  // Store work item type for status mapping
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

    // Return task info with full description including detail fields
    return {
      id: specDirName,
      specId: specDirName,
      title: safeWorkItem.title,
      description: buildFullTaskDescription(safeWorkItem),
      createdAt: new Date(safeWorkItem.createdDate),
      updatedAt: new Date()
    };
  } catch (error) {
    debugLog('Failed to create spec for work item:', { id: workItem.id, error });
    return null;
  }
}
