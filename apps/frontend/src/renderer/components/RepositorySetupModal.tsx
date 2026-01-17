import { useState } from 'react';
import { Github, FolderGit2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { GitHubSetupModal } from './GitHubSetupModal';
import { AzureDevOpsSetupModal } from './AzureDevOpsSetupModal';
import type { Project } from '../../shared/types';

interface RepositorySetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  onComplete: (settings: {
    // GitHub settings
    githubToken?: string;
    githubRepo?: string;
    githubAuthMethod?: 'oauth' | 'pat';
    // Azure DevOps settings
    azureDevOpsPat?: string;
    azureDevOpsOrg?: string;
    azureDevOpsProject?: string;
    azureDevOpsRepo?: string;
    // Common
    mainBranch: string;
  }) => void;
  onSkip?: () => void;
}

type GitProvider = 'github' | 'azure-devops' | null;

/**
 * Repository Setup Modal - Unified entry point for repository setup
 *
 * Shows provider selection first, then routes to the appropriate setup flow:
 * - GitHub: GitHubSetupModal (OAuth + repo setup)
 * - Azure DevOps: AzureDevOpsSetupModal (PAT + repo setup)
 */
export function RepositorySetupModal({
  open,
  onOpenChange,
  project,
  onComplete,
  onSkip
}: RepositorySetupModalProps) {
  const [selectedProvider, setSelectedProvider] = useState<GitProvider>(null);
  const [showProviderSelection, setShowProviderSelection] = useState(true);

  // Reset state when modal closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSelectedProvider(null);
      setShowProviderSelection(true);
    }
    onOpenChange(newOpen);
  };

  // Handle provider selection
  const handleProviderSelect = (provider: GitProvider) => {
    setSelectedProvider(provider);
    setShowProviderSelection(false);
  };

  // Handle going back to provider selection
  const handleBackToProviderSelection = () => {
    setSelectedProvider(null);
    setShowProviderSelection(true);
  };

  // Render provider selection UI
  if (showProviderSelection && !selectedProvider) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderGit2 className="h-5 w-5" />
              Choose Git Provider
            </DialogTitle>
            <DialogDescription>
              Select where your code repository is hosted
            </DialogDescription>
          </DialogHeader>

          <div className="py-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {/* GitHub Option */}
              <button
                onClick={() => handleProviderSelect('github')}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors group"
              >
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <Github className="h-6 w-6 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <span className="text-sm font-medium">GitHub</span>
                <span className="text-xs text-muted-foreground text-center">
                  Connect to GitHub repositories
                </span>
              </button>

              {/* Azure DevOps Option */}
              <button
                onClick={() => handleProviderSelect('azure-devops')}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-dashed hover:border-primary hover:bg-primary/5 transition-colors group"
              >
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <svg className="h-6 w-6 text-muted-foreground group-hover:text-primary transition-colors" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M0 8.899L2.91 5.499V17.711L0 14.311V8.899ZM5.072 4.899L16.147 0.031V3.199L7.271 6.199L5.072 4.899ZM21.236 3.271V20.729L5.072 19.101V13.211L16.147 16.801V6.801L5.072 10.801V4.901L21.236 3.271ZM5.072 19.099L21.236 20.729L16.147 23.971L5.072 19.099Z"/>
                  </svg>
                </div>
                <span className="text-sm font-medium">Azure DevOps</span>
                <span className="text-xs text-muted-foreground text-center">
                  Connect to Azure DevOps repositories
                </span>
              </button>
            </div>
          </div>

          <DialogFooter>
            {onSkip && (
              <Button variant="outline" onClick={onSkip}>
                Skip for now
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // Render GitHub setup modal
  if (selectedProvider === 'github') {
    return (
      <GitHubSetupModal
        open={open}
        onOpenChange={handleOpenChange}
        project={project}
        onComplete={(settings) => {
          onComplete({
            githubToken: settings.githubToken,
            githubRepo: settings.githubRepo,
            mainBranch: settings.mainBranch,
            githubAuthMethod: settings.githubAuthMethod
          });
        }}
        onSkip={onSkip}
        onBack={handleBackToProviderSelection}
      />
    );
  }

  // Render Azure DevOps setup modal
  if (selectedProvider === 'azure-devops') {
    return (
      <AzureDevOpsSetupModal
        open={open}
        onOpenChange={handleOpenChange}
        project={project}
        onComplete={(settings) => {
          onComplete({
            azureDevOpsPat: settings.azureDevOpsPat,
            azureDevOpsOrg: settings.azureDevOpsOrg,
            azureDevOpsProject: settings.azureDevOpsProject,
            azureDevOpsRepo: settings.azureDevOpsRepo,
            mainBranch: settings.mainBranch
          });
        }}
        onSkip={onSkip}
        onBack={handleBackToProviderSelection}
      />
    );
  }

  // Fallback (shouldn't reach here)
  return null;
}
