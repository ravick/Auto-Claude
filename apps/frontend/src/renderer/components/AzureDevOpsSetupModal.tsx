import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitBranch,
  Key,
  Loader2,
  CheckCircle2,
  ChevronRight,
  Sparkles,
  Plus,
  Link,
  Building,
  FolderGit2,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Label } from './ui/label';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { AzureDevOpsPATFlow } from './project-settings/AzureDevOpsPATFlow';
import { ClaudeOAuthFlow } from './project-settings/ClaudeOAuthFlow';
import type { Project } from '../../shared/types';
import type {
  AzureDevOpsOrganization,
  AzureDevOpsProject as ADOProject,
  AzureDevOpsRepository,
  AzureDevOpsRepoInfo
} from '../../shared/types/integrations';

// Azure DevOps icon (simple representation)
function AzureDevOpsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M0 8.899L2.91 5.499V17.711L0 14.311V8.899ZM5.072 4.899L16.147 0.031V3.199L7.271 6.199L5.072 4.899ZM21.236 3.271V20.729L5.072 19.101V13.211L16.147 16.801V6.801L5.072 10.801V4.901L21.236 3.271ZM5.072 19.099L21.236 20.729L16.147 23.971L5.072 19.099Z"/>
    </svg>
  );
}

interface AzureDevOpsSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onComplete: (settings: {
    azureDevOpsPat: string;
    azureDevOpsOrg: string;
    azureDevOpsProject: string;
    azureDevOpsRepo: string;
    mainBranch: string;
  }) => void;
  onSkip?: () => void;
  onBack?: () => void; // Optional back button to return to provider selection
}

type SetupStep = 'ado-auth' | 'claude-auth' | 'repo-confirm' | 'repo' | 'branch' | 'complete';

/**
 * Azure DevOps Setup Modal - Required setup flow after Auto Claude initialization
 *
 * Flow:
 * 1. Authenticate with Azure DevOps (via PAT) - for repo operations
 * 2. Authenticate with Claude (via claude CLI OAuth) - for AI features
 * 3. Detect/confirm repository
 * 4. Select base branch for tasks (with recommended default)
 */
export function AzureDevOpsSetupModal({
  open,
  onOpenChange,
  project,
  onComplete,
  onSkip,
  onBack
}: AzureDevOpsSetupModalProps) {
  const { t } = useTranslation('dialogs');
  const [step, setStep] = useState<SetupStep>('ado-auth');
  const [pat, setPat] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [detectedRepo, setDetectedRepo] = useState<AzureDevOpsRepoInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [recommendedBranch, setRecommendedBranch] = useState<string | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [manualBranchName, setManualBranchName] = useState<string>('master');
  const [isLoadingRepo, setIsLoadingRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repo setup state (for when no remote is detected)
  const [repoAction, setRepoAction] = useState<'create' | 'link' | null>(null);
  const [newRepoName, setNewRepoName] = useState('');
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);

  // Organization/Project/Repository selection state (3-level hierarchy)
  const [organizations, setOrganizations] = useState<AzureDevOpsOrganization[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [projects, setProjects] = useState<ADOProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<AzureDevOpsRepository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [isLoadingOrgs, setIsLoadingOrgs] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setPat(null);
      setUsername(null);
      setDetectedRepo(null);
      setBranches([]);
      setSelectedBranch(null);
      setRecommendedBranch(null);
      setManualBranchName('master');
      setError(null);
      setRepoAction(null);
      setNewRepoName(project.name.replace(/[^A-Za-z0-9_.-]/g, '-'));
      setIsCreatingRepo(false);
      setOrganizations([]);
      setSelectedOrg(null);
      setProjects([]);
      setSelectedProject(null);
      setRepositories([]);
      setSelectedRepo(null);
      setStep('ado-auth');
    }
  }, [open, project.name]);

  // Load organizations when PAT is validated
  const loadOrganizations = async (patToken: string) => {
    setIsLoadingOrgs(true);
    try {
      const result = await window.electronAPI.listAzureDevOpsOrganizations(patToken);
      if (result.success && result.data) {
        setOrganizations(result.data);
        if (result.data.length === 1) {
          // Auto-select if only one org
          setSelectedOrg(result.data[0].accountName);
          await loadProjects(patToken, result.data[0].accountName);
        }
      }
    } catch (err) {
      console.error('Failed to load organizations:', err);
    } finally {
      setIsLoadingOrgs(false);
    }
  };

  // Load projects when organization is selected
  const loadProjects = async (patToken: string, org: string) => {
    setIsLoadingProjects(true);
    setProjects([]);
    setSelectedProject(null);
    setRepositories([]);
    setSelectedRepo(null);
    try {
      const result = await window.electronAPI.listAzureDevOpsProjectsWithPat(patToken, org);
      if (result.success && result.data) {
        setProjects(result.data);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setIsLoadingProjects(false);
    }
  };

  // Load repositories when project is selected
  const loadRepositories = async (patToken: string, org: string, proj: string) => {
    setIsLoadingRepos(true);
    setRepositories([]);
    setSelectedRepo(null);
    try {
      const result = await window.electronAPI.listAzureDevOpsReposWithPat(patToken, org, proj);
      if (result.success && result.data) {
        setRepositories(result.data);
      }
    } catch (err) {
      console.error('Failed to load repositories:', err);
    } finally {
      setIsLoadingRepos(false);
    }
  };

  // Detect repository from git remote
  const detectRepository = async (patToken?: string, validatedOrg?: string) => {
    setIsLoadingRepo(true);
    setError(null);

    const currentPat = patToken || pat;

    try {
      const result = await window.electronAPI.detectAzureDevOpsRepo(project.path);
      if (result.success && result.data) {
        setDetectedRepo(result.data);
        setStep('repo-confirm');
      } else {
        // No remote detected, load orgs and show repo setup step
        if (currentPat) {
          // If organization was pre-validated, load its projects directly
          if (validatedOrg) {
            // Set single org in list and load projects
            setOrganizations([{ accountId: '', accountName: validatedOrg, accountUri: '' }]);
            await loadProjects(currentPat, validatedOrg);
          } else {
            await loadOrganizations(currentPat);
          }
        }
        setStep('repo');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect repository');
      if (currentPat) {
        if (validatedOrg) {
          setOrganizations([{ accountId: '', accountName: validatedOrg, accountUri: '' }]);
          await loadProjects(currentPat, validatedOrg);
        } else {
          await loadOrganizations(currentPat);
        }
      }
      setStep('repo');
    } finally {
      setIsLoadingRepo(false);
    }
  };

  // Load branches from Azure DevOps
  const loadBranches = async (org: string, proj: string, repo: string) => {
    if (!pat) return;

    setIsLoadingBranches(true);
    setError(null);

    try {
      const result = await window.electronAPI.getAzureDevOpsBranches(org, proj, repo, pat);
      if (result.success && result.data) {
        setBranches(result.data);
        const recommended = detectRecommendedBranch(result.data);
        setRecommendedBranch(recommended);
        setSelectedBranch(recommended);
      } else {
        setError(result.error || 'Failed to load branches');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branches');
    } finally {
      setIsLoadingBranches(false);
    }
  };

  // Detect recommended branch from list
  const detectRecommendedBranch = (branchList: string[]): string | null => {
    const priorities = ['main', 'master', 'develop', 'dev'];
    for (const priority of priorities) {
      if (branchList.includes(priority)) {
        return priority;
      }
    }
    return branchList[0] || null;
  };

  // Handle refresh branches button click
  const handleRefreshBranches = async () => {
    if (detectedRepo) {
      await loadBranches(detectedRepo.organization, detectedRepo.project, detectedRepo.repository);
    } else if (selectedOrg && selectedProject && selectedRepo) {
      await loadBranches(selectedOrg, selectedProject, selectedRepo);
    }
  };

  // Handle creating/initializing a branch (for empty repos)
  const handleCreateBranch = async () => {
    if (!pat || !manualBranchName.trim()) return;

    const org = detectedRepo?.organization || selectedOrg;
    const proj = detectedRepo?.project || selectedProject;
    const repo = detectedRepo?.repository || selectedRepo;

    if (!org || !proj || !repo) {
      setError('Repository information is missing');
      return;
    }

    setIsCreatingBranch(true);
    setError(null);

    try {
      const result = await window.electronAPI.initializeAzureDevOpsRepo(
        org,
        proj,
        repo,
        manualBranchName.trim(),
        pat
      );

      if (result.success && result.data) {
        // Branch created successfully, refresh the branch list
        setBranches([result.data.branchName]);
        setSelectedBranch(result.data.branchName);
        setRecommendedBranch(result.data.branchName);
      } else {
        setError(result.error || 'Failed to create branch');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create branch');
    } finally {
      setIsCreatingBranch(false);
    }
  };

  // Handle PAT auth success
  const handleAdoAuthSuccess = async (patToken: string, user?: string, validatedOrg?: string) => {
    setPat(patToken);
    if (user) setUsername(user);

    // If organization was validated, pre-select it
    if (validatedOrg) {
      setSelectedOrg(validatedOrg);
    }

    // Check if Claude is already authenticated
    try {
      const profilesResult = await window.electronAPI.getClaudeProfiles();
      if (profilesResult.success && profilesResult.data) {
        const activeProfile = profilesResult.data.profiles.find(
          (p) => p.id === profilesResult.data!.activeProfileId
        );
        if (activeProfile?.oauthToken || (activeProfile?.isDefault && activeProfile?.configDir)) {
          await detectRepository(patToken, validatedOrg);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to check Claude profiles:', err);
    }

    setStep('claude-auth');
  };

  // Handle Claude auth success
  const handleClaudeAuthSuccess = async () => {
    await detectRepository();
  };

  // Handle confirming detected repository
  const handleConfirmRepo = async () => {
    if (detectedRepo && pat) {
      setStep('branch');
      await loadBranches(detectedRepo.organization, detectedRepo.project, detectedRepo.repository);
    }
  };

  // Handle changing repository
  const handleChangeRepo = async () => {
    // If we already have an org selected (from PAT flow or detected repo), use it directly
    // instead of trying to load organizations (which can fail due to auth issues)
    const orgToUse = selectedOrg || detectedRepo?.organization;

    if (orgToUse && pat) {
      // Set the single org in the list and load its projects
      setOrganizations([{ accountId: '', accountName: orgToUse, accountUri: '' }]);
      setSelectedOrg(orgToUse);
      await loadProjects(pat, orgToUse);
    } else if (pat) {
      // Fallback: try to load organizations (may fail)
      await loadOrganizations(pat);
    }

    setStep('repo');
  };

  // Handle organization selection
  const handleOrgChange = async (org: string) => {
    setSelectedOrg(org);
    if (pat) {
      await loadProjects(pat, org);
    }
  };

  // Handle project selection
  const handleProjectChange = async (proj: string) => {
    setSelectedProject(proj);
    if (pat && selectedOrg) {
      await loadRepositories(pat, selectedOrg, proj);
    }
  };

  // Handle creating a new repository
  const handleCreateRepo = async () => {
    if (!newRepoName.trim() || !pat || !selectedOrg || !selectedProject) {
      setError('Please fill in all required fields');
      return;
    }

    setIsCreatingRepo(true);
    setError(null);

    try {
      const result = await window.electronAPI.createAzureDevOpsRepo(
        pat,
        selectedOrg,
        selectedProject,
        newRepoName.trim()
      );

      if (result.success && result.data) {
        // Add remote to local git repo
        const remoteResult = await window.electronAPI.addAzureDevOpsRemote(
          project.path,
          selectedOrg,
          selectedProject,
          result.data.name
        );

        if (remoteResult.success) {
          setDetectedRepo({
            organization: selectedOrg,
            project: selectedProject,
            repository: result.data.name,
            remoteUrl: result.data.remoteUrl
          });
          setStep('branch');
          await loadBranches(selectedOrg, selectedProject, result.data.name);
        } else {
          setError(remoteResult.error || 'Failed to add remote');
        }
      } else {
        setError(result.error || 'Failed to create repository');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create repository');
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // Handle linking to existing repository
  const handleLinkRepo = async () => {
    if (!selectedRepo || !pat || !selectedOrg || !selectedProject) {
      setError('Please select a repository');
      return;
    }

    setIsCreatingRepo(true);
    setError(null);

    try {
      const result = await window.electronAPI.addAzureDevOpsRemote(
        project.path,
        selectedOrg,
        selectedProject,
        selectedRepo
      );

      if (result.success) {
        setDetectedRepo({
          organization: selectedOrg,
          project: selectedProject,
          repository: selectedRepo,
          remoteUrl: result.data!.remoteUrl
        });
        setStep('branch');
        await loadBranches(selectedOrg, selectedProject, selectedRepo);
      } else {
        setError(result.error || 'Failed to add remote');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add remote');
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // Handle completion
  const handleComplete = () => {
    // Determine the branch to use: selected from dropdown or manually entered
    const branchToUse = branches.length > 0 ? selectedBranch : manualBranchName.trim();

    console.debug('[AzureDevOpsSetup] handleComplete called', {
      hasPat: !!pat,
      hasDetectedRepo: !!detectedRepo,
      hasSelectedBranch: !!selectedBranch,
      branchesCount: branches.length,
      manualBranchName,
      branchToUse,
      detectedRepo
    });

    if (!pat) {
      setError('PAT token is missing. Please go back and enter your PAT.');
      return;
    }

    if (!detectedRepo) {
      // Try to use selected org/project/repo if detectedRepo is not set
      if (selectedOrg && selectedProject && selectedRepo) {
        console.debug('[AzureDevOpsSetup] Using manually selected repo instead of detectedRepo');
        onComplete({
          azureDevOpsPat: pat,
          azureDevOpsOrg: selectedOrg,
          azureDevOpsProject: selectedProject,
          azureDevOpsRepo: selectedRepo,
          mainBranch: branchToUse || 'main'
        });
        return;
      }
      setError('Repository information is missing. Please go back and select a repository.');
      return;
    }

    if (!branchToUse) {
      setError('Please select or enter a branch name.');
      return;
    }

    console.debug('[AzureDevOpsSetup] Calling onComplete with settings');
    onComplete({
      azureDevOpsPat: pat,
      azureDevOpsOrg: detectedRepo.organization,
      azureDevOpsProject: detectedRepo.project,
      azureDevOpsRepo: detectedRepo.repository,
      mainBranch: branchToUse
    });
  };

  // Render step content
  const renderStepContent = () => {
    switch (step) {
      case 'ado-auth':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AzureDevOpsIcon className="h-5 w-5" />
                {t('azureDevOpsSetup.connectTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('azureDevOpsSetup.connectDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <AzureDevOpsPATFlow
                onSuccess={handleAdoAuthSuccess}
                onCancel={onSkip}
              />
            </div>
          </>
        );

      case 'claude-auth':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                {t('githubSetup.claudeTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('githubSetup.claudeDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4">
              <ClaudeOAuthFlow
                onSuccess={handleClaudeAuthSuccess}
                onCancel={onSkip}
              />
            </div>
          </>
        );

      case 'repo-confirm':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AzureDevOpsIcon className="h-5 w-5" />
                {t('azureDevOpsSetup.repositoryTitle')}
              </DialogTitle>
              <DialogDescription>
                We detected an Azure DevOps repository for this project. Please confirm or change it.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              <div className="rounded-lg border bg-muted/50 p-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-6 w-6 text-green-500" />
                  <div>
                    <p className="font-medium">Repository Detected</p>
                    <p className="text-sm text-muted-foreground font-mono">
                      {detectedRepo?.organization}/{detectedRepo?.project}/{detectedRepo?.repository}
                    </p>
                  </div>
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleChangeRepo}>
                Use Different Repository
              </Button>
              <Button onClick={handleConfirmRepo}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Confirm & Continue
              </Button>
            </DialogFooter>
          </>
        );

      case 'repo':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AzureDevOpsIcon className="h-5 w-5" />
                {t('azureDevOpsSetup.repositoryTitle')}
              </DialogTitle>
              <DialogDescription>
                Your project needs an Azure DevOps repository. Create a new one or link to an existing repository.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {/* Action selection */}
              {!repoAction && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setRepoAction('create')}
                    className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors"
                    aria-label={t('azureDevOpsSetup.createRepo')}
                  >
                    <Plus className="h-8 w-8 text-muted-foreground" />
                    <span className="text-sm font-medium">{t('azureDevOpsSetup.createRepo')}</span>
                    <span className="text-xs text-muted-foreground text-center">
                      Create a new repository in Azure DevOps
                    </span>
                  </button>
                  <button
                    onClick={() => setRepoAction('link')}
                    className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors"
                    aria-label={t('azureDevOpsSetup.linkRepo')}
                  >
                    <Link className="h-8 w-8 text-muted-foreground" />
                    <span className="text-sm font-medium">{t('azureDevOpsSetup.linkRepo')}</span>
                    <span className="text-xs text-muted-foreground text-center">
                      Connect to an existing repository
                    </span>
                  </button>
                </div>
              )}

              {/* Create or Link forms share the same org/project selection */}
              {repoAction && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <button
                      onClick={() => setRepoAction(null)}
                      className="text-primary hover:underline"
                      aria-label="Go back"
                    >
                      ← Back
                    </button>
                    <span>
                      {repoAction === 'create' ? 'Create a new repository' : 'Link to existing repository'}
                    </span>
                  </div>

                  {/* Organization - show as read-only if we already have it from PAT flow */}
                  <div className="space-y-2">
                    <Label>{t('azureDevOpsSetup.organizationTitle')}</Label>
                    {isLoadingOrgs ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading organizations...
                      </div>
                    ) : selectedOrg && organizations.length === 1 ? (
                      // Show read-only when org was provided in PAT flow
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-md border">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{selectedOrg}</span>
                        <CheckCircle2 className="h-4 w-4 text-success ml-auto" />
                      </div>
                    ) : (
                      <Select value={selectedOrg || ''} onValueChange={handleOrgChange}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select organization" />
                        </SelectTrigger>
                        <SelectContent>
                          {organizations.map((org) => (
                            <SelectItem key={org.accountId || org.accountName} value={org.accountName}>
                              <div className="flex items-center gap-2">
                                <Building className="h-4 w-4" />
                                {org.accountName}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  {/* Project selection */}
                  {selectedOrg && (
                    <div className="space-y-2">
                      <Label>{t('azureDevOpsSetup.projectTitle')}</Label>
                      {isLoadingProjects ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading projects...
                        </div>
                      ) : (
                        <Select value={selectedProject || ''} onValueChange={handleProjectChange}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select project" />
                          </SelectTrigger>
                          <SelectContent>
                            {projects.map((proj) => (
                              <SelectItem key={proj.id} value={proj.name}>
                                <div className="flex items-center gap-2">
                                  <FolderGit2 className="h-4 w-4" />
                                  {proj.name}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}

                  {/* Create new repo form */}
                  {repoAction === 'create' && selectedOrg && selectedProject && (
                    <div className="space-y-2">
                      <Label htmlFor="repo-name">{t('azureDevOpsSetup.repoNameLabel')}</Label>
                      <Input
                        id="repo-name"
                        value={newRepoName}
                        onChange={(e) => setNewRepoName(e.target.value)}
                        placeholder={t('azureDevOpsSetup.repoNamePlaceholder')}
                        disabled={isCreatingRepo}
                      />
                    </div>
                  )}

                  {/* Link existing repo form */}
                  {repoAction === 'link' && selectedOrg && selectedProject && (
                    <div className="space-y-2">
                      <Label>{t('azureDevOpsSetup.repositoryTitle')}</Label>
                      {isLoadingRepos ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading repositories...
                        </div>
                      ) : (
                        <Select value={selectedRepo || ''} onValueChange={setSelectedRepo}>
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
                </div>
              )}

              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              {onSkip && (
                <Button variant="outline" onClick={onSkip} disabled={isCreatingRepo}>
                  Skip for now
                </Button>
              )}
              {repoAction === 'create' && (
                <Button
                  onClick={handleCreateRepo}
                  disabled={isCreatingRepo || !newRepoName.trim() || !selectedOrg || !selectedProject}
                >
                  {isCreatingRepo ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Repository
                    </>
                  )}
                </Button>
              )}
              {repoAction === 'link' && (
                <Button
                  onClick={handleLinkRepo}
                  disabled={isCreatingRepo || !selectedRepo || !selectedOrg || !selectedProject}
                >
                  {isCreatingRepo ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Linking...
                    </>
                  ) : (
                    <>
                      <Link className="mr-2 h-4 w-4" />
                      Link Repository
                    </>
                  )}
                </Button>
              )}
              {!repoAction && (
                <Button variant="outline" onClick={() => detectRepository()} disabled={isLoadingRepo}>
                  {isLoadingRepo ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    'Retry Detection'
                  )}
                </Button>
              )}
            </DialogFooter>
          </>
        );

      case 'branch':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                {t('azureDevOpsSetup.branchTitle')}
              </DialogTitle>
              <DialogDescription>
                {t('azureDevOpsSetup.branchDescription')}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {/* Show detected repo */}
              {detectedRepo && (
                <div className="flex items-center gap-2 text-sm">
                  <AzureDevOpsIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Repository:</span>
                  <code className="px-2 py-0.5 bg-muted rounded font-mono text-xs">
                    {detectedRepo.organization}/{detectedRepo.project}/{detectedRepo.repository}
                  </code>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                </div>
              )}

              {/* Branch selector */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('azureDevOpsSetup.baseBranchLabel')}</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshBranches}
                    disabled={isLoadingBranches}
                    className="h-7 px-2 text-xs"
                  >
                    <RefreshCw className={`h-3 w-3 mr-1 ${isLoadingBranches ? 'animate-spin' : ''}`} />
                    {t('azureDevOpsSetup.refreshBranches')}
                  </Button>
                </div>

                {/* Show dropdown when branches exist */}
                {branches.length > 0 ? (
                  <>
                    <Select
                      value={selectedBranch || ''}
                      onValueChange={setSelectedBranch}
                      disabled={isLoadingBranches}
                    >
                      <SelectTrigger>
                        {isLoadingBranches ? (
                          <div className="flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>{t('azureDevOpsSetup.loadingBranches')}</span>
                          </div>
                        ) : (
                          <SelectValue placeholder={t('azureDevOpsSetup.selectBranchPlaceholder')} />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map((branch) => (
                          <SelectItem key={branch} value={branch}>
                            <div className="flex items-center gap-2">
                              <span>{branch}</span>
                              {branch === recommendedBranch && (
                                <span className="flex items-center gap-1 text-xs text-success">
                                  <Sparkles className="h-3 w-3" />
                                  {t('azureDevOpsSetup.recommendedBadge')}
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t('azureDevOpsSetup.branchHelpText')}{' '}
                      <code className="px-1 bg-muted rounded">auto-claude/task-name</code>
                      {selectedBranch && (
                        <> {t('azureDevOpsSetup.basedOn')} <code className="px-1 bg-muted rounded">{selectedBranch}</code></>
                      )}
                    </p>
                  </>
                ) : (
                  /* Show manual input when no branches exist (new/empty repo) */
                  <>
                    {isLoadingBranches || isCreatingBranch ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>
                          {isCreatingBranch
                            ? t('azureDevOpsSetup.creatingBranch')
                            : t('azureDevOpsSetup.loadingBranches')}
                        </span>
                      </div>
                    ) : (
                      <>
                        {/* Empty repo info */}
                        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="h-4 w-4 text-warning mt-0.5" />
                            <div className="text-xs text-muted-foreground">
                              <p className="font-medium text-foreground">{t('azureDevOpsSetup.noBranchesTitle')}</p>
                              <p className="mt-1">
                                {t('azureDevOpsSetup.noBranchesDescriptionWithCreate')}
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Branch name input with create button */}
                        <div className="space-y-2">
                          <Label htmlFor="manual-branch" className="text-xs">{t('azureDevOpsSetup.branchNameLabel')}</Label>
                          <div className="flex gap-2">
                            <Input
                              id="manual-branch"
                              value={manualBranchName}
                              onChange={(e) => setManualBranchName(e.target.value)}
                              placeholder="master"
                              className="h-9 flex-1"
                              disabled={isCreatingBranch}
                            />
                            <Button
                              onClick={handleCreateBranch}
                              disabled={isCreatingBranch || !manualBranchName.trim()}
                              size="sm"
                              className="h-9"
                            >
                              <Plus className="h-4 w-4 mr-1" />
                              {t('azureDevOpsSetup.createBranch')}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t('azureDevOpsSetup.createBranchHelpText')}
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Info about branch selection */}
              <div className="rounded-lg border border-info/30 bg-info/5 p-3">
                <div className="flex items-start gap-2">
                  <Sparkles className="h-4 w-4 text-info mt-0.5" />
                  <div className="text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{t('azureDevOpsSetup.whySelectBranch')}</p>
                    <p className="mt-1">
                      {t('azureDevOpsSetup.whySelectBranchDescription')}
                    </p>
                  </div>
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              {onSkip && (
                <Button variant="outline" onClick={onSkip} disabled={isCreatingBranch}>
                  {t('azureDevOpsSetup.skipForNow')}
                </Button>
              )}
              <Button
                onClick={handleComplete}
                disabled={isLoadingBranches || isCreatingBranch || (branches.length > 0 ? !selectedBranch : !manualBranchName.trim())}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {t('azureDevOpsSetup.completeSetup')}
              </Button>
            </DialogFooter>
          </>
        );

      case 'complete':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-success" />
                Setup Complete
              </DialogTitle>
            </DialogHeader>

            <div className="py-8 flex flex-col items-center justify-center">
              <div className="h-16 w-16 rounded-full bg-success/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="h-8 w-8 text-success" />
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {t('azureDevOpsSetup.ready', { branchName: selectedBranch })}
              </p>
            </div>
          </>
        );
    }
  };

  // Progress indicator
  const renderProgress = () => {
    const steps = [
      { label: 'Authenticate' },
      { label: 'Configure' },
    ];

    if (step === 'complete') return null;

    const currentIndex =
      step === 'ado-auth' ? 0 :
      step === 'claude-auth' ? 0 :
      step === 'repo' ? 0 :
      step === 'repo-confirm' ? 0 :
      1;

    return (
      <div className="flex items-center justify-center gap-2 mb-4">
        {steps.map((s, index) => (
          <div key={index} className="flex items-center">
            <div
              className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium ${
                index < currentIndex
                  ? 'bg-success text-success-foreground'
                  : index === currentIndex
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {index < currentIndex ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                index + 1
              )}
            </div>
            <span className={`ml-2 text-xs ${
              index === currentIndex ? 'text-foreground font-medium' : 'text-muted-foreground'
            }`}>
              {s.label}
            </span>
            {index < steps.length - 1 && (
              <ChevronRight className="h-4 w-4 mx-2 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {renderProgress()}
        {renderStepContent()}
      </DialogContent>
    </Dialog>
  );
}
