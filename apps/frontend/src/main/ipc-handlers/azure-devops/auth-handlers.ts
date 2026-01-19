/**
 * Azure DevOps auth and setup IPC handlers
 *
 * Provides handlers for PAT-based authentication, repository detection,
 * and setup flow for Azure DevOps projects.
 */

import { ipcMain } from 'electron';
import { execFileSync } from 'child_process';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type {
  AzureDevOpsRepoInfo,
  AzureDevOpsOrganization,
  AzureDevOpsProject,
  AzureDevOpsRepository
} from '../../../shared/types/integrations';
import { getToolPath } from '../../cli-tool-manager';

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debugLog(message: string, data?: unknown): void {
  if (DEBUG) {
    if (data !== undefined) {
      console.debug(`[AzureDevOps Auth] ${message}`, data);
    } else {
      console.debug(`[AzureDevOps Auth] ${message}`);
    }
  }
}

/**
 * Azure DevOps URL patterns for repo detection
 * Supports:
 * - https://dev.azure.com/{org}/{project}/_git/{repo}
 * - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - https://{org}.visualstudio.com/{project}/_git/{repo} (legacy)
 */
const ADO_URL_PATTERNS = [
  // Modern Azure DevOps HTTPS URL
  /https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/,
  // SSH URL
  /git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/\s]+?)(?:\.git)?$/,
  // Legacy VisualStudio.com HTTPS URL
  /https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/\s]+?)(?:\.git)?$/,
];

/**
 * Parse Azure DevOps repository info from a remote URL
 */
function parseAzureDevOpsUrl(url: string): AzureDevOpsRepoInfo | null {
  for (const pattern of ADO_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      const [, organization, project, repository] = match;
      return {
        organization,
        project,
        repository,
        remoteUrl: url
      };
    }
  }
  return null;
}

/**
 * Build Azure DevOps remote URL from components
 */
function buildAzureDevOpsUrl(org: string, project: string, repo: string): string {
  return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
}

/**
 * Make authenticated request to Azure DevOps API using PAT
 */
async function adoFetchWithPat<T>(
  pat: string,
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const auth = Buffer.from(`:${pat}`).toString('base64');

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
      throw new Error('Access forbidden. Check PAT permissions (Code: Read, Write).');
    }

    if (response.status === 404) {
      throw new Error('Resource not found. Check organization, project, or repository name.');
    }

    throw new Error(`Azure DevOps API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Detect Azure DevOps repository from git remote origin
 */
export function registerDetectAzureDevOpsRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_DETECT_REPO,
    async (_event, projectPath: string): Promise<IPCResult<AzureDevOpsRepoInfo>> => {
      debugLog('detectAzureDevOpsRepo handler called', { projectPath });
      try {
        // Get the remote URL
        const remoteUrl = execFileSync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
          encoding: 'utf-8',
          cwd: projectPath,
          stdio: 'pipe'
        }).trim();

        debugLog('Remote URL:', remoteUrl);

        // Parse Azure DevOps repo from URL
        const repoInfo = parseAzureDevOpsUrl(remoteUrl);
        if (repoInfo) {
          debugLog('Detected ADO repo:', repoInfo);
          return {
            success: true,
            data: repoInfo
          };
        }

        debugLog('Could not parse Azure DevOps repo from URL');
        return {
          success: false,
          error: 'Remote URL is not an Azure DevOps repository'
        };
      } catch (error) {
        debugLog('Failed to detect repo:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to detect Azure DevOps repository'
        };
      }
    }
  );
}

/**
 * Validate Azure DevOps PAT by testing it against the API
 * If organization is provided, validates directly against that organization (better for orgs with conditional access)
 * Otherwise, validates against the global profile API
 */
export function registerValidateAzureDevOpsPat(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_VALIDATE_PAT,
    async (_event, pat: string, organization?: string): Promise<IPCResult<{ valid: boolean; username?: string; error?: string }>> => {
      debugLog('validateAzureDevOpsPat handler called', {
        organization: organization || 'auto-detect',
        patLength: pat?.length || 0
      });

      if (!pat || pat.trim().length === 0) {
        return {
          success: true,
          data: { valid: false, error: 'PAT is required' }
        };
      }

      const trimmedPat = pat.trim();
      debugLog('PAT received', { length: trimmedPat.length, startsWithChar: trimmedPat.charAt(0) });

      // If organization is provided, validate directly against the organization
      // This works better for organizations with conditional access policies
      if (organization && organization.trim()) {
        const orgName = organization.trim();
        debugLog('Validating PAT directly against organization:', orgName);

        try {
          // Try to access the organization's projects endpoint
          // This is more reliable for orgs with conditional access policies
          const orgUrl = `https://dev.azure.com/${orgName}/_apis/projects?$top=1&api-version=7.1`;
          debugLog('Trying org-specific validation URL:', orgUrl);

          const orgData = await adoFetchWithPat<{
            count: number;
            value?: Array<{ id: string; name: string }>;
          }>(trimmedPat, orgUrl);

          debugLog('Organization validation successful:', { projectCount: orgData.count });

          // Now try to get the user profile (but don't fail if this doesn't work)
          let username: string | undefined;
          try {
            const profileUrl = 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1';
            const profileData = await adoFetchWithPat<{
              displayName?: string;
              publicAlias?: string;
              emailAddress?: string;
            }>(trimmedPat, profileUrl);
            username = profileData.displayName || profileData.publicAlias || profileData.emailAddress;
            debugLog('Profile fetch succeeded:', { username });
          } catch (profileError) {
            // Profile fetch failed, but org validation worked - that's OK
            debugLog('Profile fetch failed (non-critical):', profileError instanceof Error ? profileError.message : profileError);
          }

          return {
            success: true,
            data: {
              valid: true,
              username
            }
          };
        } catch (orgError) {
          const orgErrorMsg = orgError instanceof Error ? orgError.message : 'Unknown error';
          debugLog('Organization validation failed:', orgErrorMsg);

          if (orgErrorMsg.includes('401') || orgErrorMsg.includes('Authentication failed') || orgErrorMsg.includes('Unauthorized')) {
            return {
              success: true,
              data: {
                valid: false,
                error: `Authentication failed for organization "${orgName}". This could be due to:\n• Invalid PAT token\n• PAT doesn't have access to this organization\n• Organization requires web login first (try visiting https://${orgName}.visualstudio.com or https://dev.azure.com/${orgName} in your browser)`
              }
            };
          }
          if (orgErrorMsg.includes('403') || orgErrorMsg.includes('forbidden')) {
            return {
              success: true,
              data: {
                valid: false,
                error: `Access forbidden for organization "${orgName}". Ensure your PAT has the required scopes (Code: Read & Write, Project and Team: Read).`
              }
            };
          }
          if (orgErrorMsg.includes('404') || orgErrorMsg.includes('not found')) {
            return {
              success: true,
              data: {
                valid: false,
                error: `Organization "${orgName}" not found. Check the organization name is spelled correctly.\n\nYour organization URL should be: https://dev.azure.com/${orgName} or https://${orgName}.visualstudio.com`
              }
            };
          }

          return {
            success: true,
            data: {
              valid: false,
              error: `Cannot access organization "${orgName}": ${orgErrorMsg}`
            }
          };
        }
      }

      // No organization provided - use the global profile API
      try {
        debugLog('No organization provided, using global profile API');
        const profileUrl = 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1';

        const profileData = await adoFetchWithPat<{
          id?: string;
          displayName?: string;
          publicAlias?: string;
          emailAddress?: string;
        }>(trimmedPat, profileUrl);

        debugLog('PAT validated successfully:', {
          displayName: profileData.displayName,
          publicAlias: profileData.publicAlias
        });

        const username = profileData.displayName || profileData.publicAlias || profileData.emailAddress;

        return {
          success: true,
          data: {
            valid: true,
            username
          }
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        debugLog('PAT validation failed:', errorMsg);

        // Return specific error message to help user diagnose the issue
        let friendlyError = errorMsg;
        if (errorMsg.includes('401') || errorMsg.includes('Authentication failed') || errorMsg.includes('Unauthorized')) {
          friendlyError = 'Authentication failed. Please verify your PAT is correct.\n\nIf your organization uses conditional access policies, try:\n1. Entering your organization name in the field above\n2. Visiting your Azure DevOps portal in a browser first';
        }

        return {
          success: true,
          data: {
            valid: false,
            error: friendlyError
          }
        };
      }
    }
  );
}

/**
 * List Azure DevOps organizations accessible to the PAT
 */
export function registerListAzureDevOpsOrganizations(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_LIST_ORGANIZATIONS,
    async (_event, pat: string): Promise<IPCResult<AzureDevOpsOrganization[]>> => {
      debugLog('listAzureDevOpsOrganizations handler called');

      try {
        // First get the user's profile to get the member ID
        const profileUrl = 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1';
        const profile = await adoFetchWithPat<{ id: string; publicAlias: string }>(pat, profileUrl);

        debugLog('Got profile:', { id: profile.id, alias: profile.publicAlias });

        // Then get the organizations the user has access to
        const accountsUrl = `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${profile.id}&api-version=7.1`;
        const accountsData = await adoFetchWithPat<{
          count: number;
          value: Array<{
            accountId: string;
            accountName: string;
            accountUri: string;
          }>;
        }>(pat, accountsUrl);

        const organizations: AzureDevOpsOrganization[] = accountsData.value.map(account => ({
          accountId: account.accountId,
          accountName: account.accountName,
          accountUri: account.accountUri
        }));

        debugLog(`Found ${organizations.length} organizations`);
        return {
          success: true,
          data: organizations
        };
      } catch (error) {
        debugLog('Failed to list organizations:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list organizations'
        };
      }
    }
  );
}

/**
 * List projects in an Azure DevOps organization (using PAT directly, for setup flow)
 */
export function registerListProjectsWithPat(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_LIST_PROJECTS_WITH_PAT,
    async (_event, pat: string, organization: string): Promise<IPCResult<AzureDevOpsProject[]>> => {
      debugLog('listProjectsWithPat handler called', { organization });

      try {
        const url = `https://dev.azure.com/${organization}/_apis/projects?api-version=7.1`;
        const data = await adoFetchWithPat<{
          count: number;
          value: Array<{
            id: string;
            name: string;
            description?: string;
            url: string;
            state: 'wellFormed' | 'createPending' | 'deleted' | 'deleting' | 'new' | 'unchanged';
            visibility: 'private' | 'public';
          }>;
        }>(pat, url);

        const projects: AzureDevOpsProject[] = data.value.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          url: p.url,
          state: p.state,
          visibility: p.visibility
        }));

        debugLog(`Found ${projects.length} projects`);
        return {
          success: true,
          data: projects
        };
      } catch (error) {
        debugLog('Failed to list projects:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list projects'
        };
      }
    }
  );
}

/**
 * List repositories in an Azure DevOps project (using PAT directly, for setup flow)
 */
export function registerListReposWithPat(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_LIST_REPOS_WITH_PAT,
    async (_event, pat: string, organization: string, project: string): Promise<IPCResult<AzureDevOpsRepository[]>> => {
      debugLog('listReposWithPat handler called', { organization, project });

      try {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories?api-version=7.1`;
        const data = await adoFetchWithPat<{
          count: number;
          value: Array<{
            id: string;
            name: string;
            url: string;
            webUrl: string;
            defaultBranch?: string;
            project: {
              id: string;
              name: string;
            };
          }>;
        }>(pat, url);

        const repositories: AzureDevOpsRepository[] = data.value.map(r => ({
          id: r.id,
          name: r.name,
          url: r.url,
          webUrl: r.webUrl,
          defaultBranch: r.defaultBranch?.replace('refs/heads/', '') || 'main',
          project: {
            id: r.project.id,
            name: r.project.name
          }
        }));

        debugLog(`Found ${repositories.length} repositories`);
        return {
          success: true,
          data: repositories
        };
      } catch (error) {
        debugLog('Failed to list repositories:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list repositories'
        };
      }
    }
  );
}

/**
 * Create a new repository in Azure DevOps
 */
export function registerCreateAzureDevOpsRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_CREATE_REPO,
    async (
      _event,
      pat: string,
      organization: string,
      project: string,
      repoName: string
    ): Promise<IPCResult<{ id: string; name: string; remoteUrl: string }>> => {
      debugLog('createAzureDevOpsRepo handler called', { organization, project, repoName });

      // Validate repo name - only alphanumeric, hyphens, underscores, periods
      if (!/^[A-Za-z0-9_.-]+$/.test(repoName)) {
        return {
          success: false,
          error: 'Invalid repository name. Use only letters, numbers, hyphens, underscores, and periods.'
        };
      }

      try {
        // First get the project ID
        const projectUrl = `https://dev.azure.com/${organization}/_apis/projects/${project}?api-version=7.1`;
        const projectData = await adoFetchWithPat<{ id: string; name: string }>(pat, projectUrl);

        debugLog('Got project:', { id: projectData.id, name: projectData.name });

        // Create the repository
        const createUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories?api-version=7.1`;
        const repoData = await adoFetchWithPat<{
          id: string;
          name: string;
          remoteUrl: string;
          webUrl: string;
        }>(pat, createUrl, {
          method: 'POST',
          body: JSON.stringify({
            name: repoName,
            project: {
              id: projectData.id
            }
          })
        });

        debugLog('Repository created:', { id: repoData.id, name: repoData.name });

        return {
          success: true,
          data: {
            id: repoData.id,
            name: repoData.name,
            remoteUrl: repoData.remoteUrl || buildAzureDevOpsUrl(organization, project, repoName)
          }
        };
      } catch (error) {
        debugLog('Failed to create repository:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create repository'
        };
      }
    }
  );
}

/**
 * Add or update git remote for Azure DevOps repository
 */
export function registerAddAzureDevOpsRemote(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_ADD_REMOTE,
    async (
      _event,
      projectPath: string,
      organization: string,
      project: string,
      repo: string
    ): Promise<IPCResult<{ remoteUrl: string }>> => {
      debugLog('addAzureDevOpsRemote handler called', { projectPath, organization, project, repo });

      const remoteUrl = buildAzureDevOpsUrl(organization, project, repo);

      try {
        // Check if origin already exists
        try {
          execFileSync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
          // Origin exists, remove it first
          debugLog('Removing existing origin remote');
          execFileSync(getToolPath('git'), ['remote', 'remove', 'origin'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: 'pipe'
          });
        } catch {
          // No origin exists, which is fine
        }

        // Add the remote
        debugLog('Adding remote origin:', remoteUrl);
        execFileSync(getToolPath('git'), ['remote', 'add', 'origin', remoteUrl], {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });

        debugLog('Remote added successfully');
        return {
          success: true,
          data: { remoteUrl }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to add remote';
        debugLog('Failed to add remote:', errorMessage);
        return {
          success: false,
          error: errorMessage
        };
      }
    }
  );
}

/**
 * Get branches from Azure DevOps repository
 */
export function registerGetAzureDevOpsBranches(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_GET_BRANCHES,
    async (
      _event,
      organization: string,
      project: string,
      repo: string,
      pat: string
    ): Promise<IPCResult<string[]>> => {
      debugLog('getAzureDevOpsBranches handler called', { organization, project, repo });

      try {
        const url = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repo}/refs?filter=heads/&api-version=7.1`;
        const data = await adoFetchWithPat<{
          count: number;
          value: Array<{
            name: string;
            objectId: string;
          }>;
        }>(pat, url);

        // Extract branch names, removing the refs/heads/ prefix
        const branches = data.value
          .map(ref => ref.name.replace('refs/heads/', ''))
          .filter(name => name.length > 0);

        debugLog(`Found ${branches.length} branches`);
        return {
          success: true,
          data: branches
        };
      } catch (error) {
        debugLog('Failed to get branches:', error instanceof Error ? error.message : error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get branches'
        };
      }
    }
  );
}

/**
 * Initialize an empty Azure DevOps repository with a README and default branch
 */
export function registerInitializeAzureDevOpsRepo(): void {
  ipcMain.handle(
    IPC_CHANNELS.AZURE_DEVOPS_INITIALIZE_REPO,
    async (
      _event,
      organization: string,
      project: string,
      repo: string,
      branchName: string,
      pat: string
    ): Promise<IPCResult<{ branchName: string }>> => {
      debugLog('initializeAzureDevOpsRepo handler called', { organization, project, repo, branchName });

      try {
        // Create initial commit with README using the Push API
        const pushUrl = `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repo}/pushes?api-version=7.1`;

        const readmeContent = `# ${repo}\n\nThis repository was initialized by Auto Claude.\n`;
        const base64Content = Buffer.from(readmeContent).toString('base64');

        const pushPayload = {
          refUpdates: [
            {
              name: `refs/heads/${branchName}`,
              oldObjectId: '0000000000000000000000000000000000000000' // Empty repo marker
            }
          ],
          commits: [
            {
              comment: 'Initial commit - Repository initialized by Auto Claude',
              changes: [
                {
                  changeType: 'add',
                  item: {
                    path: '/README.md'
                  },
                  newContent: {
                    content: base64Content,
                    contentType: 'base64encoded'
                  }
                }
              ]
            }
          ]
        };

        await adoFetchWithPat<unknown>(pat, pushUrl, {
          method: 'POST',
          body: JSON.stringify(pushPayload)
        });

        debugLog(`Repository initialized with branch: ${branchName}`);
        return {
          success: true,
          data: { branchName }
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to initialize repository';
        debugLog('Failed to initialize repository:', errorMessage);
        return {
          success: false,
          error: errorMessage
        };
      }
    }
  );
}

/**
 * Register all Azure DevOps auth handlers
 */
export function registerAuthHandlers(): void {
  debugLog('Registering Azure DevOps auth handlers');
  registerDetectAzureDevOpsRepo();
  registerValidateAzureDevOpsPat();
  registerListAzureDevOpsOrganizations();
  registerListProjectsWithPat();
  registerListReposWithPat();
  registerCreateAzureDevOpsRepo();
  registerAddAzureDevOpsRemote();
  registerGetAzureDevOpsBranches();
  registerInitializeAzureDevOpsRepo();
  debugLog('Azure DevOps auth handlers registered');
}
