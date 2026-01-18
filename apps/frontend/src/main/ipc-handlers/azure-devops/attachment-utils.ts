/**
 * Azure DevOps Attachment Utilities
 *
 * Handles downloading attachments and inline images from Azure DevOps work items.
 * Includes security measures for URL validation, file size limits, and MIME type checking.
 */

import { mkdir, writeFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import type {
  AzureDevOpsConfig,
  ADOWorkItemResponse,
  ADOAttachmentInfo,
  ADOAttachmentDownloadResult,
} from './types';

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.debug(`[AzureDevOps Attachments] ${message}`, data);
    } else {
      console.debug(`[AzureDevOps Attachments] ${message}`);
    }
  }
}

// ============================================
// Security Constants
// ============================================

/** Allowed domains for attachment downloads */
const ALLOWED_DOMAINS = ['dev.azure.com', 'visualstudio.com'];

/** Maximum file size per attachment (25 MB) */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Maximum total size for all attachments per work item (100 MB) */
const MAX_TOTAL_SIZE_BYTES = 100 * 1024 * 1024;

/** Maximum number of concurrent downloads */
const MAX_CONCURRENT_DOWNLOADS = 3;

/** Allowed MIME types for attachments */
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',

  // PDF
  'application/pdf',

  // Microsoft Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

  // Microsoft Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // Microsoft PowerPoint
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // OpenDocument formats
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',

  // Text and data formats
  'text/plain',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/json',

  // Archives
  'application/zip',
]);

/** File extension to MIME type mapping for fallback */
const EXTENSION_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

// ============================================
// URL Pattern Matching
// ============================================

/**
 * Regex pattern to extract attachment GUID from Azure DevOps URLs
 * Matches:
 * - https://dev.azure.com/{org}/_apis/wit/attachments/{guid}
 * - https://dev.azure.com/{org}/{project}/_apis/wit/attachments/{guid}
 */
const ADO_ATTACHMENT_URL_PATTERN = /https:\/\/dev\.azure\.com\/[^/]+(?:\/[^/]+)?\/(?:_apis\/wit\/attachments\/)([a-f0-9-]+)/i;

/**
 * Alternative pattern for visualstudio.com URLs
 */
const VSTS_ATTACHMENT_URL_PATTERN = /https:\/\/[^.]+\.visualstudio\.com\/[^/]*\/?(?:_apis\/wit\/attachments\/)([a-f0-9-]+)/i;

// ============================================
// Security Utilities
// ============================================

/**
 * Validate that a URL is from an allowed Azure DevOps domain
 */
export function isValidAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Check if hostname ends with one of the allowed domains
    return ALLOWED_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Sanitize filename to prevent path traversal attacks
 * Removes/replaces dangerous characters and limits length
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed';

  // Replace path traversal attempts
  let sanitized = filename.replace(/\.\./g, '_');

  // Replace dangerous characters
  sanitized = sanitized.replace(/[/\\:*?"<>|]/g, '_');

  // Remove leading dots (hidden files)
  sanitized = sanitized.replace(/^\.+/, '');

  // Limit length
  if (sanitized.length > 255) {
    const ext = extname(sanitized);
    const baseName = sanitized.slice(0, 255 - ext.length);
    sanitized = baseName + ext;
  }

  // Fallback if empty after sanitization
  if (!sanitized || sanitized === '_') {
    return 'unnamed';
  }

  return sanitized;
}

/**
 * Extract attachment GUID from Azure DevOps URL
 */
export function extractAttachmentIdFromUrl(url: string): string | null {
  // Try dev.azure.com pattern
  let match = url.match(ADO_ATTACHMENT_URL_PATTERN);
  if (match) {
    return match[1];
  }

  // Try visualstudio.com pattern
  match = url.match(VSTS_ATTACHMENT_URL_PATTERN);
  if (match) {
    return match[1];
  }

  return null;
}

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromExtension(filename: string): string | null {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_MIME_MAP[ext] || null;
}

/**
 * Check if MIME type is allowed
 */
function isAllowedMimeType(mimeType: string): boolean {
  // Normalize MIME type (remove charset, etc.)
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return ALLOWED_MIME_TYPES.has(normalized);
}

// ============================================
// HTML Image Extraction
// ============================================

/**
 * Extract inline image URLs from HTML content
 * Looks for <img> tags with Azure DevOps attachment URLs
 */
export function extractInlineImageUrls(html: string): string[] {
  if (!html) return [];

  const urls: string[] = [];

  // Match <img> tags and extract src attribute
  const imgTagPattern = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imgTagPattern.exec(html)) !== null) {
    const src = match[1];
    if (src && isValidAttachmentUrl(src)) {
      urls.push(src);
    }
  }

  // Also look for background-image URLs (less common but possible)
  const bgImagePattern = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((match = bgImagePattern.exec(html)) !== null) {
    const url = match[1];
    if (url && isValidAttachmentUrl(url)) {
      urls.push(url);
    }
  }

  // Remove duplicates
  return [...new Set(urls)];
}

/**
 * Extract filename from URL query parameter or path
 */
function extractFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Check fileName query parameter (common in ADO URLs)
    const fileName = parsed.searchParams.get('fileName');
    if (fileName) {
      return sanitizeFilename(fileName);
    }

    // Fall back to path
    const pathParts = parsed.pathname.split('/');
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart !== 'attachments') {
      return sanitizeFilename(lastPart);
    }

    return 'unnamed';
  } catch {
    return 'unnamed';
  }
}

// ============================================
// Binary Download
// ============================================

/**
 * Download binary content from Azure DevOps with authentication
 */
export async function adoFetchBinary(
  config: AzureDevOpsConfig,
  url: string
): Promise<{ buffer: Buffer; mimeType: string; size: number } | null> {
  // Validate URL
  if (!isValidAttachmentUrl(url)) {
    debugLog('Invalid attachment URL (domain not allowed):', url);
    return null;
  }

  // Ensure we have download=true for attachment downloads
  const downloadUrl = url.includes('download=') ? url : `${url}${url.includes('?') ? '&' : '?'}download=true`;

  // Build auth header
  const auth = Buffer.from(`:${config.pat}`).toString('base64');

  try {
    // First, do a HEAD request to check size
    const headResponse = await fetch(downloadUrl, {
      method: 'HEAD',
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (!headResponse.ok) {
      debugLog(`HEAD request failed for attachment: ${headResponse.status}`, url);
      // Continue anyway, some servers don't support HEAD
    } else {
      const contentLength = headResponse.headers.get('content-length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > MAX_FILE_SIZE_BYTES) {
          debugLog(`Attachment too large (${size} bytes, max ${MAX_FILE_SIZE_BYTES}):`, url);
          return null;
        }
      }
    }

    // Download the file
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      debugLog(`Failed to download attachment: ${response.status} ${response.statusText}`, url);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Check size after download
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      debugLog(`Downloaded attachment too large (${buffer.length} bytes):`, url);
      return null;
    }

    // Get MIME type from response or infer from URL
    let mimeType = response.headers.get('content-type') || '';
    if (!mimeType || mimeType === 'application/octet-stream') {
      const filename = extractFilenameFromUrl(url);
      const inferred = getMimeTypeFromExtension(filename);
      if (inferred) {
        mimeType = inferred;
      }
    }

    return {
      buffer,
      mimeType: mimeType.split(';')[0].trim(),
      size: buffer.length,
    };
  } catch (error) {
    debugLog('Error downloading attachment:', { url, error });
    return null;
  }
}

// ============================================
// Attachment Download
// ============================================

/**
 * Check if attachment already exists locally
 */
async function attachmentExists(localPath: string): Promise<boolean> {
  try {
    await stat(localPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a single attachment and save to local filesystem
 */
export async function downloadAttachment(
  config: AzureDevOpsConfig,
  url: string,
  specDir: string,
  source: 'inline' | 'attached',
  existingAttachments?: ADOAttachmentInfo[]
): Promise<ADOAttachmentDownloadResult> {
  // Validate URL
  if (!isValidAttachmentUrl(url)) {
    return {
      success: false,
      skipped: true,
      skipReason: 'invalid_url',
      error: 'URL is not from an allowed Azure DevOps domain',
    };
  }

  // Extract attachment ID
  const attachmentId = extractAttachmentIdFromUrl(url);
  if (!attachmentId) {
    return {
      success: false,
      skipped: true,
      skipReason: 'invalid_url',
      error: 'Could not extract attachment ID from URL',
    };
  }

  // Extract filename
  const originalFilename = extractFilenameFromUrl(url);
  const sanitizedFilename = sanitizeFilename(originalFilename);

  // Build local filename with GUID prefix for uniqueness
  const localFilename = `${attachmentId}-${sanitizedFilename}`;
  const attachmentsDir = join(specDir, 'attachments');
  const localPath = join(attachmentsDir, localFilename);

  // Check if already downloaded (by ID in existing attachments)
  if (existingAttachments?.some(a => a.id === attachmentId)) {
    debugLog(`Attachment ${attachmentId} already exists, skipping`);
    return {
      success: true,
      skipped: true,
      skipReason: 'already_exists',
    };
  }

  // Check if file exists on disk
  if (await attachmentExists(localPath)) {
    debugLog(`Attachment file already exists: ${localPath}`);
    return {
      success: true,
      skipped: true,
      skipReason: 'already_exists',
    };
  }

  // Download the file
  const downloadResult = await adoFetchBinary(config, url);
  if (!downloadResult) {
    return {
      success: false,
      skipped: true,
      skipReason: 'download_failed',
      error: 'Failed to download attachment',
    };
  }

  // Validate MIME type
  if (!isAllowedMimeType(downloadResult.mimeType)) {
    debugLog(`Invalid MIME type ${downloadResult.mimeType} for attachment:`, url);
    return {
      success: false,
      skipped: true,
      skipReason: 'invalid_mime_type',
      error: `MIME type ${downloadResult.mimeType} is not allowed`,
    };
  }

  // Ensure attachments directory exists
  await mkdir(attachmentsDir, { recursive: true });

  // Write file to disk
  await writeFile(localPath, downloadResult.buffer);

  debugLog(`Downloaded attachment: ${localFilename} (${downloadResult.size} bytes)`);

  return {
    success: true,
    attachment: {
      id: attachmentId,
      filename: sanitizedFilename,
      originalUrl: url,
      localPath: `attachments/${localFilename}`,
      mimeType: downloadResult.mimeType,
      size: downloadResult.size,
      source,
    },
  };
}

// ============================================
// Work Item Attachment Processing
// ============================================

/**
 * Process all attachments from a work item (inline images and file attachments)
 * Downloads attachments and returns metadata for TASK.md and task_metadata.json
 */
export async function processWorkItemAttachments(
  workItem: ADOWorkItemResponse,
  config: AzureDevOpsConfig,
  specDir: string,
  existingAttachments?: ADOAttachmentInfo[]
): Promise<ADOAttachmentInfo[]> {
  const attachments: ADOAttachmentInfo[] = [];
  const urls: Array<{ url: string; source: 'inline' | 'attached' }> = [];
  let totalSize = 0;

  // Extract inline images from HTML fields
  const htmlFields = [
    workItem.fields['System.Description'],
    workItem.fields['Microsoft.VSTS.TCM.ReproSteps'],
    workItem.fields['Microsoft.VSTS.Common.AcceptanceCriteria'],
    workItem.fields['Microsoft.VSTS.TCM.SystemInfo'],
  ];

  for (const field of htmlFields) {
    if (typeof field === 'string') {
      const inlineUrls = extractInlineImageUrls(field);
      for (const url of inlineUrls) {
        urls.push({ url, source: 'inline' });
      }
    }
  }

  // Extract attached files from relations
  if (workItem.relations) {
    for (const relation of workItem.relations) {
      if (relation.rel === 'AttachedFile' && relation.url) {
        // Check size from attributes if available
        const size = relation.attributes?.resourceSize;
        if (size && size > MAX_FILE_SIZE_BYTES) {
          debugLog(`Skipping large attachment (${size} bytes):`, relation.url);
          continue;
        }
        urls.push({ url: relation.url, source: 'attached' });
      }
    }
  }

  // Remove duplicate URLs
  const uniqueUrls = Array.from(
    new Map(urls.map(u => [u.url, u])).values()
  );

  debugLog(`Found ${uniqueUrls.length} attachments to process for work item #${workItem.id}`);

  // Download attachments with concurrency limit
  const downloadBatches: Array<Array<{ url: string; source: 'inline' | 'attached' }>> = [];
  for (let i = 0; i < uniqueUrls.length; i += MAX_CONCURRENT_DOWNLOADS) {
    downloadBatches.push(uniqueUrls.slice(i, i + MAX_CONCURRENT_DOWNLOADS));
  }

  for (const batch of downloadBatches) {
    // Check total size limit
    if (totalSize >= MAX_TOTAL_SIZE_BYTES) {
      debugLog(`Total attachment size limit reached (${totalSize} bytes), skipping remaining`);
      break;
    }

    const results = await Promise.allSettled(
      batch.map(({ url, source }) =>
        downloadAttachment(config, url, specDir, source, existingAttachments)
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success && result.value.attachment) {
        const attachment = result.value.attachment;
        totalSize += attachment.size;
        attachments.push(attachment);
      } else if (result.status === 'rejected') {
        debugLog('Attachment download failed:', result.reason);
      }
    }
  }

  debugLog(`Successfully processed ${attachments.length} attachments (${totalSize} bytes total)`);

  return attachments;
}

/**
 * Replace ADO attachment URLs with local paths in text content
 */
export function replaceAttachmentUrls(
  content: string,
  attachments: ADOAttachmentInfo[]
): string {
  if (!content || attachments.length === 0) return content;

  let result = content;

  for (const attachment of attachments) {
    // Replace the original URL with the local path
    // Handle both quoted and unquoted URLs
    const escapedUrl = attachment.originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlPattern = new RegExp(escapedUrl, 'g');
    result = result.replace(urlPattern, attachment.localPath);
  }

  return result;
}

/**
 * Convert HTML to text while preserving inline image references as markdown.
 * This function converts <img> tags to markdown image syntax BEFORE stripping
 * other HTML tags, ensuring inline image positions are preserved.
 *
 * Must be called AFTER attachments are downloaded so we have the local paths.
 *
 * @param html - The HTML content from Azure DevOps
 * @param attachments - Downloaded attachments with URL → local path mapping
 * @returns Plain text with markdown image references at their original positions
 */
export function htmlToMarkdownWithImages(
  html: string,
  attachments: ADOAttachmentInfo[]
): string {
  if (!html) return '';

  // Build URL → attachment mapping for quick lookup
  const urlToAttachment = new Map<string, ADOAttachmentInfo>();
  for (const att of attachments) {
    urlToAttachment.set(att.originalUrl, att);
  }

  let result = html;

  // Replace <img> tags with markdown image syntax
  // Match various img tag formats:
  // - <img src="url">
  // - <img src="url" />
  // - <img src="url" alt="text" width="100" />
  result = result.replace(
    /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*\/?>/gi,
    (match, src) => {
      const attachment = urlToAttachment.get(src);
      if (attachment) {
        // Use markdown image syntax: ![filename](path)
        return `\n\n![${attachment.filename}](${attachment.localPath})\n\n`;
      }
      // Unknown image URL - leave a placeholder for manual resolution
      return `\n\n[image: ${src}]\n\n`;
    }
  );

  // Now strip remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  result = result
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');

  // Normalize whitespace but preserve intentional newlines around images
  result = result.replace(/[ \t]+/g, ' '); // Collapse horizontal whitespace only
  result = result.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
  result = result.trim();

  return result;
}

/**
 * Generate markdown for attachments table
 */
export function generateAttachmentsMarkdown(attachments: ADOAttachmentInfo[]): string {
  if (attachments.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push('## Attachments');
  lines.push('');
  lines.push('| File | Type | Size |');
  lines.push('|------|------|------|');

  for (const attachment of attachments) {
    const sizeStr = formatFileSize(attachment.size);
    lines.push(`| [${attachment.filename}](${attachment.localPath}) | ${attachment.mimeType} | ${sizeStr} |`);
  }

  return lines.join('\n');
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check if content contains ADO attachment URLs
 */
export function hasAdoAttachmentUrls(content: string): boolean {
  if (!content) return false;
  return ADO_ATTACHMENT_URL_PATTERN.test(content) || VSTS_ATTACHMENT_URL_PATTERN.test(content);
}
