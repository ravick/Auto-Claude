import { useState, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { PRList } from './components/PRList';
import { PRDetail } from './components/PRDetail';
import { useAzureDevOpsPRs } from './hooks/useAzureDevOpsPRs';
import { initializePRReviewListeners } from '../../stores/azure-devops';

interface AzureDevOpsPRsProps {
  projectId: string;
  onOpenSettings?: () => void;
}

export function AzureDevOpsPRs({ projectId, onOpenSettings }: AzureDevOpsPRsProps) {
  const [stateFilter, setStateFilter] = useState<'active' | 'completed' | 'abandoned' | 'all'>('active');

  // Initialize PR review listeners on mount
  useEffect(() => {
    initializePRReviewListeners();
  }, []);

  // Use the hook for PR state management
  const {
    pullRequests,
    isLoading,
    error,
    selectedPR,
    selectedPRId,
    reviewResult,
    reviewProgress,
    isReviewing,
    selectPR,
    refresh,
    runReview,
    cancelReview,
    postComment,
  } = useAzureDevOpsPRs(projectId);

  // Filter PRs by state
  const filteredPRs = pullRequests.filter((pr) => {
    if (stateFilter === 'all') return true;
    return pr.status === stateFilter;
  });

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <AlertCircle className="h-12 w-12 text-destructive mb-4" />
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <Button variant="outline" onClick={refresh} className="mt-4">
          Try Again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* List Panel */}
      <div className="w-1/2 border-r border-border flex flex-col">
        <PRList
          pullRequests={filteredPRs}
          isLoading={isLoading}
          selectedPRId={selectedPRId}
          onSelectPR={(pr) => selectPR(pr.pullRequestId)}
          onRefresh={refresh}
          stateFilter={stateFilter}
          onStateFilterChange={setStateFilter}
        />
      </div>

      {/* Detail Panel */}
      <div className="flex-1 flex flex-col">
        {selectedPR ? (
          <PRDetail
            pr={selectedPR}
            reviewResult={reviewResult}
            reviewProgress={reviewProgress}
            isReviewing={isReviewing}
            onRunReview={() => runReview(selectedPR.pullRequestId)}
            onCancelReview={() => cancelReview(selectedPR.pullRequestId)}
            onPostComment={(content, filePath, line) =>
              postComment(selectedPR.pullRequestId, content, filePath, line)
            }
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select a pull request to view details
          </div>
        )}
      </div>
    </div>
  );
}
