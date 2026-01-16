import { GitMerge, GitPullRequest, XCircle, ExternalLink, FileWarning } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { AzureDevOpsPullRequest } from '../../../../shared/types';

interface PRItemProps {
  pr: AzureDevOpsPullRequest;
  isSelected: boolean;
  onClick: () => void;
}

export function PRItem({ pr, isSelected, onClick }: PRItemProps) {
  const stateColors: Record<string, string> = {
    active: 'text-success',
    completed: 'text-info',
    abandoned: 'text-destructive'
  };

  const stateIcons: Record<string, typeof GitPullRequest> = {
    active: GitPullRequest,
    completed: GitMerge,
    abandoned: XCircle
  };

  const StateIcon = stateIcons[pr.status] || GitPullRequest;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // Format branch names by removing refs/heads/ prefix
  const formatBranch = (branch: string) => {
    return branch.replace(/^refs\/heads\//, '');
  };

  // Get reviewer vote display
  const getVoteStatus = () => {
    if (!pr.reviewers || pr.reviewers.length === 0) return null;

    const approvedCount = pr.reviewers.filter(r => r.vote >= 10).length;
    const waitingCount = pr.reviewers.filter(r => r.vote === -5).length;
    const rejectedCount = pr.reviewers.filter(r => r.vote <= -10).length;

    if (rejectedCount > 0) {
      return { text: 'Rejected', color: 'text-destructive' };
    }
    if (approvedCount === pr.reviewers.length && approvedCount > 0) {
      return { text: 'Approved', color: 'text-success' };
    }
    if (waitingCount > 0) {
      return { text: 'Waiting', color: 'text-warning' };
    }
    if (approvedCount > 0) {
      return { text: `${approvedCount}/${pr.reviewers.length} Approved`, color: 'text-info' };
    }
    return null;
  };

  const voteStatus = getVoteStatus();

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-lg border transition-colors',
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-transparent hover:bg-muted/50'
      )}
    >
      <div className="flex items-start gap-3">
        <StateIcon className={cn('h-5 w-5 mt-0.5 shrink-0', stateColors[pr.status])} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">!{pr.pullRequestId}</span>
            {pr.isDraft && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                Draft
              </span>
            )}
            <h4 className="text-sm font-medium text-foreground truncate">{pr.title}</h4>
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span>{formatBranch(pr.sourceBranch)}</span>
            <span>→</span>
            <span>{formatBranch(pr.targetBranch)}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {pr.labels && pr.labels.slice(0, 3).map((label) => (
              <span
                key={label.name}
                className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              >
                {label.name}
              </span>
            ))}
            {pr.labels && pr.labels.length > 3 && (
              <span className="text-xs text-muted-foreground">
                +{pr.labels.length - 3}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <span>by {pr.createdBy.displayName}</span>
            <span>•</span>
            <span>{formatDate(pr.creationDate)}</span>
            {voteStatus && (
              <>
                <span>•</span>
                <span className={voteStatus.color}>{voteStatus.text}</span>
              </>
            )}
            {pr.mergeStatus && pr.mergeStatus !== 'succeeded' && pr.mergeStatus !== 'notSet' && (
              <>
                <span>•</span>
                <span className="text-warning flex items-center gap-1">
                  <FileWarning className="h-3 w-3" />
                  {pr.mergeStatus}
                </span>
              </>
            )}
          </div>
        </div>
        <a
          href={pr.webUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </button>
  );
}
