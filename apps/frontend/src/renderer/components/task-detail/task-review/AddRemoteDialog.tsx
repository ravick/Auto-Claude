import { useState, useEffect } from 'react';
import { GitBranch, Loader2, AlertTriangle, Link2, CheckCircle2, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';
import { Label } from '../../ui/label';
import type {
  AzureDevOpsOrganization,
  AzureDevOpsProject,
  AzureDevOpsRepository
} from '../../../../shared/types/integrations';

interface AddRemoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  // Azure DevOps settings from project config
  azureDevOpsPat?: string;
  azureDevOpsOrg?: string;
  azureDevOpsProject?: string;
  azureDevOpsRepo?: string;
  onSuccess: () => void;
}

type ViewMode = 'choice' | 'select';

/**
 * Dialog for adding a git remote when PR creation fails due to missing remote
 * Smart flow that uses configured Azure DevOps settings or lets user select different repo
 */
export function AddRemoteDialog({
  open,
  onOpenChange,
  projectPath,
  azureDevOpsPat,
  azureDevOpsOrg,
  azureDevOpsProject,
  azureDevOpsRepo,
  onSuccess
}: AddRemoteDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);

  // View mode: 'choice' shows configured settings, 'select' shows dropdowns
  const [viewMode, setViewMode] = useState<ViewMode>('choice');

  // Selection state
  const [organizations, setOrganizations] = useState<AzureDevOpsOrganization[]>([]);
  const [projects, setProjects] = useState<AzureDevOpsProject[]>([]);
  const [repositories, setRepositories] = useState<AzureDevOpsRepository[]>([]);

  const [selectedOrg, setSelectedOrg] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');

  // Loading states
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if we have configured settings
  const hasConfiguredSettings = !!(azureDevOpsOrg && azureDevOpsProject && azureDevOpsRepo);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setViewMode(hasConfiguredSettings ? 'choice' : 'select');
      setSelectedOrg('');
      setSelectedProject('');
      setSelectedRepo('');
      setOrganizations([]);
      setProjects([]);
      setRepositories([]);
      setError(null);

      // If no configured settings, load organizations immediately
      // Always call loadOrganizations to show proper error if PAT is missing
      if (!hasConfiguredSettings) {
        loadOrganizations();
      }
    }
  }, [open, hasConfiguredSettings, azureDevOpsPat]);

  // Load organizations from Azure DevOps
  const loadOrganizations = async () => {
    if (!azureDevOpsPat) {
      setError('Azure DevOps PAT not configured. Please configure in project settings.');
      return;
    }

    setIsLoadingOrgs(true);
    setError(null);

    try {
      const result = await window.electronAPI.listAzureDevOpsOrganizations(azureDevOpsPat);

      if (result.success && result.data) {
        setOrganizations(result.data);

        // Pre-select configured org if available
        if (azureDevOpsOrg && result.data.some(org => org.accountName === azureDevOpsOrg)) {
          setSelectedOrg(azureDevOpsOrg);
          loadProjects(azureDevOpsOrg);
        }
      } else {
        setError(result.error || 'Failed to load organizations');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organizations');
    } finally {
      setIsLoadingOrgs(false);
    }
  };

  // Load projects for selected organization
  const loadProjects = async (orgName: string) => {
    if (!azureDevOpsPat || !orgName) return;

    setIsLoadingProjects(true);
    setError(null);

    try {
      const result = await window.electronAPI.listAzureDevOpsProjectsWithPat(azureDevOpsPat, orgName);

      if (result.success && result.data) {
        setProjects(result.data);

        // Pre-select configured project if available
        if (azureDevOpsProject && result.data.some(proj => proj.name === azureDevOpsProject)) {
          setSelectedProject(azureDevOpsProject);
          loadRepositories(orgName, azureDevOpsProject);
        }
      } else {
        setError(result.error || 'Failed to load projects');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setIsLoadingProjects(false);
    }
  };

  // Load repositories for selected project
  const loadRepositories = async (orgName: string, projectName: string) => {
    if (!azureDevOpsPat || !orgName || !projectName) return;

    setIsLoadingRepos(true);
    setError(null);

    try {
      const result = await window.electronAPI.listAzureDevOpsReposWithPat(
        azureDevOpsPat,
        orgName,
        projectName
      );

      if (result.success && result.data) {
        setRepositories(result.data);

        // Pre-select configured repo if available
        if (azureDevOpsRepo && result.data.some(repo => repo.name === azureDevOpsRepo)) {
          setSelectedRepo(azureDevOpsRepo);
        }
      } else {
        setError(result.error || 'Failed to load repositories');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      setIsLoadingRepos(false);
    }
  };

  // Handle organization selection change
  const handleOrgChange = (orgName: string) => {
    setSelectedOrg(orgName);
    setSelectedProject('');
    setSelectedRepo('');
    setProjects([]);
    setRepositories([]);
    loadProjects(orgName);
  };

  // Handle project selection change
  const handleProjectChange = (projectName: string) => {
    setSelectedProject(projectName);
    setSelectedRepo('');
    setRepositories([]);
    loadRepositories(selectedOrg, projectName);
  };

  // Use configured settings
  const handleUseConfigured = async () => {
    if (!azureDevOpsOrg || !azureDevOpsProject || !azureDevOpsRepo) return;

    await addRemote(azureDevOpsOrg, azureDevOpsProject, azureDevOpsRepo);
  };

  // Use selected settings
  const handleUseSelected = async () => {
    if (!selectedOrg || !selectedProject || !selectedRepo) return;

    await addRemote(selectedOrg, selectedProject, selectedRepo);
  };

  // Add git remote
  const addRemote = async (org: string, project: string, repo: string) => {
    setIsAdding(true);
    setError(null);

    try {
      const result = await window.electronAPI.addAzureDevOpsRemote(
        projectPath,
        org,
        project,
        repo
      );

      if (result.success) {
        onSuccess();
        onOpenChange(false);
      } else {
        setError(result.error || 'Failed to add remote');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add remote');
    } finally {
      setIsAdding(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            Add Azure DevOps Remote
          </DialogTitle>
          <DialogDescription>
            Configure the git remote to enable pull request creation
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Info box */}
          <div className="rounded-lg border border-info/30 bg-info/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-info mt-0.5 flex-shrink-0" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground">What this does</p>
                <p className="mt-1">
                  This will add a git remote named "origin" pointing to your Azure DevOps repository,
                  allowing you to push branches and create pull requests.
                </p>
              </div>
            </div>
          </div>

          {/* Choice View - Show configured settings */}
          {viewMode === 'choice' && hasConfiguredSettings && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/50 p-4">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium mb-2">Configured Repository</p>
                    <div className="space-y-1 text-sm text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Organization:</span>
                        <span className="font-mono">{azureDevOpsOrg}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Project:</span>
                        <span className="font-mono">{azureDevOpsProject}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Repository:</span>
                        <span className="font-mono">{azureDevOpsRepo}</span>
                      </div>
                    </div>
                    <div className="mt-3 p-2 bg-muted rounded text-xs font-mono break-all">
                      https://dev.azure.com/{azureDevOpsOrg}/{azureDevOpsProject}/_git/{azureDevOpsRepo}
                    </div>
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="space-y-2">
                <Button
                  className="w-full"
                  onClick={handleUseConfigured}
                  disabled={isAdding}
                >
                  {isAdding ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Adding Remote...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Use This Repository
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setViewMode('select');
                    loadOrganizations();
                  }}
                  disabled={isAdding}
                >
                  Select Different Repository
                  <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Select View - Show dropdowns */}
          {viewMode === 'select' && (
            <div className="space-y-4">
              {/* Organization dropdown */}
              <div className="space-y-2">
                <Label>Organization</Label>
                {isLoadingOrgs ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-lg">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading organizations...
                  </div>
                ) : (
                  <Select value={selectedOrg} onValueChange={handleOrgChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((org) => (
                        <SelectItem key={org.accountId} value={org.accountName}>
                          {org.accountName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Project dropdown */}
              {selectedOrg && (
                <div className="space-y-2">
                  <Label>Project</Label>
                  {isLoadingProjects ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-lg">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading projects...
                    </div>
                  ) : (
                    <Select value={selectedProject} onValueChange={handleProjectChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.name}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* Repository dropdown */}
              {selectedProject && (
                <div className="space-y-2">
                  <Label>Repository</Label>
                  {isLoadingRepos ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border rounded-lg">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading repositories...
                    </div>
                  ) : (
                    <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {repositories.map((repo) => (
                          <SelectItem key={repo.id} value={repo.name}>
                            {repo.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* Preview URL */}
              {selectedOrg && selectedProject && selectedRepo && (
                <div className="rounded-lg bg-muted/50 p-3 text-sm">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Link2 className="h-3.5 w-3.5" />
                    Remote URL:
                  </div>
                  <code className="text-xs break-all">
                    https://dev.azure.com/{selectedOrg}/{selectedProject}/_git/{selectedRepo}
                  </code>
                </div>
              )}

              {/* Back button if we had configured settings */}
              {hasConfiguredSettings && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewMode('choice')}
                  className="w-full"
                >
                  ← Back to configured repository
                </Button>
              )}
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isAdding}>
            {t('common:buttons.cancel')}
          </Button>
          {viewMode === 'select' && (
            <Button
              onClick={handleUseSelected}
              disabled={isAdding || !selectedOrg || !selectedProject || !selectedRepo}
            >
              {isAdding ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Adding Remote...
                </>
              ) : (
                <>
                  <Link2 className="mr-2 h-4 w-4" />
                  Add Remote
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
