/**
 * Git Provider Detection Utility
 *
 * Detects the git hosting provider from a remote URL and extracts
 * organization/project/repository information.
 */

export type GitProvider = 'github' | 'azure-devops' | 'gitlab' | 'unknown';

export interface GitHubInfo {
  owner: string;
  repository: string;
}

export interface AzureDevOpsInfo {
  organization: string;
  project: string;
  repository: string;
}

export interface GitLabInfo {
  namespace: string;
  project: string;
}

export interface GitProviderDetectionResult {
  provider: GitProvider;
  info?: GitHubInfo | AzureDevOpsInfo | GitLabInfo;
}

/**
 * URL patterns for different git providers
 */

// GitHub patterns
const GITHUB_HTTPS_PATTERN = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/;
const GITHUB_SSH_PATTERN = /git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/;

// Azure DevOps patterns
const ADO_HTTPS_PATTERN = /https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/;
const ADO_SSH_PATTERN = /git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?$/;
const ADO_LEGACY_PATTERN = /https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/;

// GitLab patterns
const GITLAB_HTTPS_PATTERN = /gitlab\.com\/([^/]+(?:\/[^/]+)*)\/([^/\s]+?)(?:\.git)?$/;
const GITLAB_SSH_PATTERN = /git@gitlab\.com:([^/]+(?:\/[^/]+)*)\/([^/\s]+?)(?:\.git)?$/;
// Self-hosted GitLab (generic pattern - matches common gitlab domain patterns)
const GITLAB_SELFHOSTED_PATTERN = /gitlab[^/]*\/([^/]+(?:\/[^/]+)*)\/([^/\s]+?)(?:\.git)?$/;

/**
 * Detect the git provider from a remote URL
 *
 * @param remoteUrl The git remote URL to analyze
 * @returns Detection result with provider type and extracted info
 */
export function detectGitProvider(remoteUrl: string): GitProviderDetectionResult {
  if (!remoteUrl || typeof remoteUrl !== 'string') {
    return { provider: 'unknown' };
  }

  const url = remoteUrl.trim();

  // Check GitHub
  let match = url.match(GITHUB_HTTPS_PATTERN) || url.match(GITHUB_SSH_PATTERN);
  if (match) {
    return {
      provider: 'github',
      info: {
        owner: match[1],
        repository: match[2].replace(/\.git$/, '')
      } as GitHubInfo
    };
  }

  // Check Azure DevOps
  match = url.match(ADO_HTTPS_PATTERN) || url.match(ADO_SSH_PATTERN) || url.match(ADO_LEGACY_PATTERN);
  if (match) {
    return {
      provider: 'azure-devops',
      info: {
        organization: match[1],
        project: match[2],
        repository: match[3].replace(/\.git$/, '')
      } as AzureDevOpsInfo
    };
  }

  // Check GitLab (including self-hosted)
  match = url.match(GITLAB_HTTPS_PATTERN) || url.match(GITLAB_SSH_PATTERN) || url.match(GITLAB_SELFHOSTED_PATTERN);
  if (match) {
    return {
      provider: 'gitlab',
      info: {
        namespace: match[1],
        project: match[2].replace(/\.git$/, '')
      } as GitLabInfo
    };
  }

  return { provider: 'unknown' };
}

/**
 * Check if a URL is a GitHub URL
 */
export function isGitHubUrl(remoteUrl: string): boolean {
  return detectGitProvider(remoteUrl).provider === 'github';
}

/**
 * Check if a URL is an Azure DevOps URL
 */
export function isAzureDevOpsUrl(remoteUrl: string): boolean {
  return detectGitProvider(remoteUrl).provider === 'azure-devops';
}

/**
 * Check if a URL is a GitLab URL
 */
export function isGitLabUrl(remoteUrl: string): boolean {
  return detectGitProvider(remoteUrl).provider === 'gitlab';
}

/**
 * Get a human-readable provider name
 */
export function getProviderDisplayName(provider: GitProvider): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'azure-devops':
      return 'Azure DevOps';
    case 'gitlab':
      return 'GitLab';
    default:
      return 'Unknown';
  }
}
