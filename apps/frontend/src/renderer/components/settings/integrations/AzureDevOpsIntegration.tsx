import { useState, useEffect } from 'react';
import { RefreshCw, Loader2, CheckCircle2, AlertCircle, GitBranch, ChevronDown, Building2 } from 'lucide-react';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { Button } from '../../ui/button';
import { PasswordInput } from '../../project-settings/PasswordInput';
import type { ProjectEnvConfig, ProjectSettings, AzureDevOpsSyncStatus } from '../../../../shared/types';

// Debug logging
const DEBUG = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';
function debugLog(message: string, data?: unknown) {
  if (DEBUG) {
    if (data !== undefined) {
      console.warn(`[AzureDevOpsIntegration] ${message}`, data);
    } else {
      console.warn(`[AzureDevOpsIntegration] ${message}`);
    }
  }
}

interface AzureDevOpsIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showAzureDevOpsPat: boolean;
  setShowAzureDevOpsPat: React.Dispatch<React.SetStateAction<boolean>>;
  azureDevOpsConnectionStatus: AzureDevOpsSyncStatus | null;
  isCheckingAzureDevOps: boolean;
  projectPath?: string;
  projectId?: string;
  // Project settings for mainBranch (used by kanban tasks and terminal worktrees)
  settings?: ProjectSettings;
  setSettings?: React.Dispatch<React.SetStateAction<ProjectSettings>>;
}

/**
 * Azure DevOps integration settings component.
 * Manages PAT, organization, project, and repository configuration.
 */
export function AzureDevOpsIntegration({
  envConfig,
  updateEnvConfig,
  showAzureDevOpsPat: _showAzureDevOpsPat,
  setShowAzureDevOpsPat: _setShowAzureDevOpsPat,
  azureDevOpsConnectionStatus,
  isCheckingAzureDevOps,
  projectPath,
  projectId,
  settings,
  setSettings
}: AzureDevOpsIntegrationProps) {
  // Repositories state
  const [repositories, setRepositories] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoadingRepositories, setIsLoadingRepositories] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);

  // Branch selection state
  const [branches, setBranches] = useState<string[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  debugLog('Render - projectPath:', projectPath);
  debugLog('Render - envConfig:', envConfig ? {
    azureDevOpsEnabled: envConfig.azureDevOpsEnabled,
    hasOrganization: !!envConfig.azureDevOpsOrganization,
    hasProject: !!envConfig.azureDevOpsProject,
    hasPat: !!envConfig.azureDevOpsPat
  } : null);

  // Fetch repositories when enabled and configured
  useEffect(() => {
    if (projectId &&
        envConfig?.azureDevOpsEnabled &&
        envConfig?.azureDevOpsOrganization &&
        envConfig?.azureDevOpsProject &&
        envConfig?.azureDevOpsPat &&
        azureDevOpsConnectionStatus?.connected) {
      fetchRepositories();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    envConfig?.azureDevOpsEnabled,
    envConfig?.azureDevOpsOrganization,
    envConfig?.azureDevOpsProject,
    envConfig?.azureDevOpsPat,
    azureDevOpsConnectionStatus?.connected
  ]);

  // Fetch branches when enabled and project path is available
  // Note: This fetches LOCAL git branches, not dependent on Azure DevOps connection
  useEffect(() => {
    // Only fetch if Azure DevOps is enabled and we have a project path
    // Also re-fetch when component mounts or projectPath changes
    if (envConfig?.azureDevOpsEnabled && projectPath && branches.length === 0) {
      debugLog('Triggering branch fetch', { azureDevOpsEnabled: envConfig.azureDevOpsEnabled, projectPath });
      fetchBranches();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envConfig?.azureDevOpsEnabled, projectPath]);

  // Re-fetch branches if they were cleared (e.g., after state reset)
  useEffect(() => {
    if (envConfig?.azureDevOpsEnabled && projectPath && branches.length === 0 && !isLoadingBranches && !branchesError) {
      debugLog('Re-fetching branches after state reset');
      fetchBranches();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.length, isLoadingBranches, branchesError]);

  /**
   * Handler for branch selection changes.
   * Updates BOTH project.settings.mainBranch and envConfig.defaultBranch for CLI backward compatibility.
   */
  const handleBranchChange = (branch: string) => {
    debugLog('handleBranchChange: Updating branch to:', branch);

    // Update project settings (primary source for Electron app)
    if (setSettings) {
      setSettings(prev => ({ ...prev, mainBranch: branch }));
    }

    // Also update envConfig for CLI backward compatibility
    updateEnvConfig({ defaultBranch: branch });
  };

  const fetchRepositories = async () => {
    if (!projectId) {
      debugLog('fetchRepositories: No projectId available');
      return;
    }

    setIsLoadingRepositories(true);
    setRepositoriesError(null);

    try {
      const result = await window.electronAPI.getAzureDevOpsRepositories(projectId);
      debugLog('fetchRepositories result:', { success: result.success, count: result.data?.length });

      if (result.success && result.data) {
        setRepositories(result.data.map(r => ({ id: r.id, name: r.name })));
      } else {
        setRepositoriesError(result.error || 'Failed to load repositories');
      }
    } catch (err) {
      debugLog('fetchRepositories error:', err);
      setRepositoriesError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setIsLoadingRepositories(false);
    }
  };

  const fetchBranches = async () => {
    if (!projectPath) {
      debugLog('fetchBranches: No projectPath, skipping');
      return;
    }

    // Prevent multiple concurrent fetches
    if (isLoadingBranches) {
      debugLog('fetchBranches: Already loading, skipping');
      return;
    }

    debugLog('fetchBranches: Starting with projectPath:', projectPath);
    setIsLoadingBranches(true);
    setBranchesError(null);

    try {
      const result = await window.electronAPI.getGitBranches(projectPath);
      debugLog('fetchBranches result:', { success: result.success, count: result.data?.length, data: result.data?.slice(0, 5) });

      if (result.success && result.data && result.data.length > 0) {
        debugLog(`Setting branches state with ${result.data.length} branches`);
        setBranches(result.data);

        // Auto-detect default branch if not set
        if (!settings?.mainBranch && !envConfig?.defaultBranch) {
          const detectResult = await window.electronAPI.detectMainBranch(projectPath);
          if (detectResult.success && detectResult.data) {
            debugLog('Auto-detected default branch:', detectResult.data);
            handleBranchChange(detectResult.data);
          }
        }
      } else if (result.success && (!result.data || result.data.length === 0)) {
        debugLog('fetchBranches: No branches found');
        setBranchesError('No branches found in repository');
      } else {
        setBranchesError(result.error || 'Failed to load branches');
      }
    } catch (err) {
      debugLog('fetchBranches error:', err);
      setBranchesError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      setIsLoadingBranches(false);
    }
  };

  if (!envConfig) {
    debugLog('No envConfig, returning null');
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">Enable Azure DevOps Work Items</Label>
          <p className="text-xs text-muted-foreground">
            Sync work items from Azure DevOps and create tasks automatically
          </p>
        </div>
        <Switch
          checked={envConfig.azureDevOpsEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ azureDevOpsEnabled: checked })}
        />
      </div>

      {envConfig.azureDevOpsEnabled && (
        <>
          {/* Organization Input */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium text-foreground">Organization</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Your Azure DevOps organization name (e.g., <code className="px-1 bg-muted rounded">mycompany</code>)
            </p>
            <Input
              placeholder="mycompany"
              value={envConfig.azureDevOpsOrganization || ''}
              onChange={(e) => updateEnvConfig({ azureDevOpsOrganization: e.target.value })}
            />
          </div>

          {/* Project Input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">Project</Label>
            <p className="text-xs text-muted-foreground">
              Your Azure DevOps project name (e.g., <code className="px-1 bg-muted rounded">MyProject</code>)
            </p>
            <Input
              placeholder="MyProject"
              value={envConfig.azureDevOpsProject || ''}
              onChange={(e) => updateEnvConfig({ azureDevOpsProject: e.target.value })}
            />
          </div>

          {/* Personal Access Token */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">Personal Access Token</Label>
            <p className="text-xs text-muted-foreground">
              Create a PAT with <code className="px-1 bg-muted rounded">Work Items (Read, Write)</code> and{' '}
              <code className="px-1 bg-muted rounded">Code (Read)</code> scopes from{' '}
              <a
                href={envConfig.azureDevOpsOrganization
                  ? `https://dev.azure.com/${envConfig.azureDevOpsOrganization}/_usersSettings/tokens`
                  : 'https://dev.azure.com/_usersSettings/tokens'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                Azure DevOps Settings
              </a>
            </p>
            <PasswordInput
              value={envConfig.azureDevOpsPat || ''}
              onChange={(value) => updateEnvConfig({ azureDevOpsPat: value })}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
          </div>

          {/* Connection Status */}
          {envConfig.azureDevOpsPat && envConfig.azureDevOpsOrganization && envConfig.azureDevOpsProject && (
            <ConnectionStatus
              isChecking={isCheckingAzureDevOps}
              connectionStatus={azureDevOpsConnectionStatus}
            />
          )}

          {/* Repository Dropdown - Only show when connected */}
          {azureDevOpsConnectionStatus?.connected && (
            <RepositoryDropdown
              repositories={repositories}
              selectedRepository={envConfig.azureDevOpsRepository || ''}
              isLoading={isLoadingRepositories}
              error={repositoriesError}
              onSelect={(repo) => updateEnvConfig({ azureDevOpsRepository: repo })}
              onRefresh={fetchRepositories}
            />
          )}

          {/* Work Items Available Info */}
          {azureDevOpsConnectionStatus?.connected && <WorkItemsAvailableInfo />}

          <Separator />

          {/* Default Branch Selector */}
          {projectPath && (
            <BranchSelector
              branches={branches}
              selectedBranch={settings?.mainBranch || envConfig.defaultBranch || ''}
              isLoading={isLoadingBranches}
              error={branchesError}
              onSelect={handleBranchChange}
              onRefresh={fetchBranches}
            />
          )}

          <Separator />

          {/* Auto-Sync Toggle */}
          <AutoSyncToggle
            enabled={envConfig.azureDevOpsAutoSync || false}
            onToggle={(checked) => updateEnvConfig({ azureDevOpsAutoSync: checked })}
          />
        </>
      )}
    </div>
  );
}

// ============================================
// Sub-Components
// ============================================

interface ConnectionStatusProps {
  isChecking: boolean;
  connectionStatus: AzureDevOpsSyncStatus | null;
}

function ConnectionStatus({ isChecking, connectionStatus }: ConnectionStatusProps) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Connection Status</p>
          <p className="text-xs text-muted-foreground">
            {isChecking ? 'Checking...' :
              connectionStatus?.connected
                ? `Connected to ${connectionStatus.organization}/${connectionStatus.project}`
                : connectionStatus?.error || 'Not connected'}
          </p>
        </div>
        {isChecking ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : connectionStatus?.connected ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <AlertCircle className="h-4 w-4 text-warning" />
        )}
      </div>
    </div>
  );
}

interface RepositoryDropdownProps {
  repositories: Array<{ id: string; name: string }>;
  selectedRepository: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (repo: string) => void;
  onRefresh: () => void;
}

function RepositoryDropdown({
  repositories,
  selectedRepository,
  isLoading,
  error,
  onSelect,
  onRefresh
}: RepositoryDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredRepos = repositories.filter(repo =>
    repo.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium text-foreground">Repository (for PRs)</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="h-7 px-2"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Select the Git repository to enable Pull Request features
      </p>

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          disabled={isLoading}
          className="w-full flex items-center justify-between px-3 py-2 text-sm border border-input rounded-md bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          {isLoading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repositories...
            </span>
          ) : selectedRepository ? (
            <span>{selectedRepository}</span>
          ) : (
            <span className="text-muted-foreground">Select a repository (optional)</span>
          )}
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && !isLoading && (
          <div className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-64 overflow-hidden">
            <div className="p-2 border-b border-border">
              <Input
                placeholder="Search repositories..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            </div>

            <div className="max-h-48 overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  onSelect('');
                  setIsOpen(false);
                  setFilter('');
                }}
                className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${
                  !selectedRepository ? 'bg-accent' : ''
                }`}
              >
                <span className="text-sm text-muted-foreground italic">None (Work Items only)</span>
              </button>

              {filteredRepos.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {filter ? 'No matching repositories' : 'No repositories found'}
                </div>
              ) : (
                filteredRepos.map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => {
                      onSelect(repo.name);
                      setIsOpen(false);
                      setFilter('');
                    }}
                    className={`w-full px-3 py-2 text-left hover:bg-accent ${
                      repo.name === selectedRepository ? 'bg-accent' : ''
                    }`}
                  >
                    <span className="text-sm">{repo.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkItemsAvailableInfo() {
  return (
    <div className="rounded-lg border border-info/30 bg-info/5 p-3">
      <div className="flex items-start gap-3">
        {/* Azure DevOps Icon */}
        <svg className="h-5 w-5 text-info mt-0.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z"/>
        </svg>
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">Work Items Available</p>
          <p className="text-xs text-muted-foreground mt-1">
            Access Azure DevOps Work Items from the sidebar to view, investigate, and create tasks.
          </p>
        </div>
      </div>
    </div>
  );
}

interface AutoSyncToggleProps {
  enabled: boolean;
  onToggle: (checked: boolean) => void;
}

function AutoSyncToggle({ enabled, onToggle }: AutoSyncToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-info" />
          <Label className="font-normal text-foreground">Auto-Sync on Load</Label>
        </div>
        <p className="text-xs text-muted-foreground pl-6">
          Automatically fetch work items when the project loads
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={onToggle} />
    </div>
  );
}

interface BranchSelectorProps {
  branches: string[];
  selectedBranch: string;
  isLoading: boolean;
  error: string | null;
  onSelect: (branch: string) => void;
  onRefresh: () => void;
}

function BranchSelector({
  branches,
  selectedBranch,
  isLoading,
  error,
  onSelect,
  onRefresh
}: BranchSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredBranches = branches.filter(branch =>
    branch.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-info" />
            <Label className="text-sm font-medium text-foreground">Default Branch</Label>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            The base branch for creating task worktrees
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isLoading}
          className="h-7 px-2"
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive pl-6">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}

      <div className="relative pl-6">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          disabled={isLoading}
          className="w-full flex items-center justify-between px-3 py-2 text-sm border border-input rounded-md bg-background hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          {isLoading ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading branches...
            </span>
          ) : selectedBranch ? (
            <span className="flex items-center gap-2">
              <GitBranch className="h-3 w-3 text-muted-foreground" />
              {selectedBranch}
            </span>
          ) : (
            <span className="text-muted-foreground">Auto-detect</span>
          )}
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && !isLoading && (
          <div className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-md shadow-lg max-h-64 overflow-hidden">
            <div className="p-2 border-b border-border">
              <Input
                placeholder="Search branches..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 text-sm"
                autoFocus
              />
            </div>

            <button
              type="button"
              onClick={() => {
                onSelect('');
                setIsOpen(false);
                setFilter('');
              }}
              className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${
                !selectedBranch ? 'bg-accent' : ''
              }`}
            >
              <span className="text-sm text-muted-foreground italic">Auto-detect</span>
            </button>

            <div className="max-h-40 overflow-y-auto border-t border-border">
              {filteredBranches.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {filter ? 'No matching branches' : 'No branches found'}
                </div>
              ) : (
                filteredBranches.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => {
                      onSelect(branch);
                      setIsOpen(false);
                      setFilter('');
                    }}
                    className={`w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 ${
                      branch === selectedBranch ? 'bg-accent' : ''
                    }`}
                  >
                    <GitBranch className="h-3 w-3 text-muted-foreground" />
                    <span className="text-sm">{branch}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {selectedBranch && (
        <p className="text-xs text-muted-foreground pl-6">
          Tasks will branch from <code className="px-1 bg-muted rounded">{selectedBranch}</code>
        </p>
      )}
    </div>
  );
}
