import { useState, useMemo } from 'react';
import {
  ExternalLink,
  User,
  Users,
  Clock,
  GitBranch,
  FileDiff,
  Sparkles,
  Send,
  XCircle,
  Loader2,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  CheckSquare,
  Square,
} from 'lucide-react';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { ScrollArea } from '../../ui/scroll-area';
import { Progress } from '../../ui/progress';
import { ErrorBoundary } from '../../ui/error-boundary';
import { cn } from '../../../lib/utils';
import type {
  AzureDevOpsPullRequest,
  AzureDevOpsPRReviewResult,
  AzureDevOpsPRReviewProgress,
  AzureDevOpsPRReviewFinding
} from '../../../../shared/types';

interface PRDetailProps {
  pr: AzureDevOpsPullRequest;
  reviewResult: AzureDevOpsPRReviewResult | null;
  reviewProgress: AzureDevOpsPRReviewProgress | null;
  isReviewing: boolean;
  onRunReview: () => void;
  onCancelReview: () => void;
  onPostComment: (content: string, filePath?: string, line?: number) => Promise<boolean>;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Format branch names by removing refs/heads/ prefix
function formatBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

function getStatusColor(status: AzureDevOpsPRReviewResult['overallStatus']): string {
  switch (status) {
    case 'approve':
      return 'bg-success/20 text-success border-success/50';
    case 'request_changes':
      return 'bg-destructive/20 text-destructive border-destructive/50';
    default:
      return 'bg-muted';
  }
}

function getPRStateColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-success/20 text-success border-success/50';
    case 'completed':
      return 'bg-purple-500/20 text-purple-500 border-purple-500/50';
    case 'abandoned':
      return 'bg-destructive/20 text-destructive border-destructive/50';
    default:
      return 'bg-muted';
  }
}

// Vote number to text mapping
function getVoteText(vote: number): string {
  if (vote >= 10) return 'Approved';
  if (vote === 5) return 'Approved with suggestions';
  if (vote === 0) return 'No response';
  if (vote === -5) return 'Waiting';
  if (vote <= -10) return 'Rejected';
  return 'Unknown';
}

function getVoteColor(vote: number): string {
  if (vote >= 10) return 'text-success';
  if (vote === 5) return 'text-info';
  if (vote === 0) return 'text-muted-foreground';
  if (vote === -5) return 'text-warning';
  if (vote <= -10) return 'text-destructive';
  return 'text-muted-foreground';
}

// Severity config
const SEVERITY_CONFIG = {
  critical: { label: 'Critical', color: 'text-red-500', bgColor: 'bg-red-500/10 border-red-500/30' },
  high: { label: 'High', color: 'text-orange-500', bgColor: 'bg-orange-500/10 border-orange-500/30' },
  medium: { label: 'Medium', color: 'text-yellow-500', bgColor: 'bg-yellow-500/10 border-yellow-500/30' },
  low: { label: 'Low', color: 'text-blue-500', bgColor: 'bg-blue-500/10 border-blue-500/30' },
};

// Simple Finding Item component
function FindingItem({
  finding,
  selected,
  posted,
  onToggle,
}: {
  finding: AzureDevOpsPRReviewFinding;
  selected: boolean;
  posted: boolean;
  onToggle: () => void;
}) {
  const config = SEVERITY_CONFIG[finding.severity];

  return (
    <div
      className={cn(
        "p-3 rounded-lg border transition-colors",
        posted ? "bg-muted/30 opacity-60" : "bg-background",
        selected && !posted && "border-primary"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <button
          type="button"
          onClick={onToggle}
          disabled={posted}
          className={cn(
            "mt-0.5 shrink-0",
            posted && "cursor-not-allowed"
          )}
        >
          {selected || posted ? (
            <CheckSquare className={cn("h-4 w-4", posted ? "text-muted-foreground" : "text-primary")} />
          ) : (
            <Square className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={cn("text-xs", config?.bgColor, config?.color)}>
              {finding.severity}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {finding.category}
            </Badge>
            {posted && (
              <Badge variant="outline" className="text-xs bg-success/10 text-success border-success/30">
                Posted
              </Badge>
            )}
          </div>

          <h4 className="text-sm font-medium">{finding.title}</h4>
          <p className="text-sm text-muted-foreground">{finding.description}</p>

          {finding.file && (
            <div className="text-xs text-muted-foreground font-mono">
              {finding.file}
              {finding.line && `:${finding.line}`}
              {finding.endLine && finding.endLine !== finding.line && `-${finding.endLine}`}
            </div>
          )}

          {finding.suggestedFix && (
            <div className="mt-2 p-2 rounded bg-muted/50 text-xs">
              <span className="font-medium">Suggested fix:</span>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-muted-foreground">
                {finding.suggestedFix}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PRDetail({
  pr,
  reviewResult,
  reviewProgress,
  isReviewing,
  onRunReview,
  onCancelReview,
  onPostComment,
}: PRDetailProps) {
  // Selection state for findings
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [postedFindingIds, setPostedFindingIds] = useState<Set<string>>(new Set());
  const [isPostingFindings, setIsPostingFindings] = useState(false);
  const [postSuccess, setPostSuccess] = useState<{ count: number; timestamp: number } | null>(null);

  // Group findings by severity
  const groupedFindings = useMemo(() => {
    if (!reviewResult?.findings) return { critical: [], high: [], medium: [], low: [] };

    const groups: Record<string, AzureDevOpsPRReviewFinding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const finding of reviewResult.findings) {
      const severity = finding.severity;
      if (groups[severity]) {
        groups[severity].push(finding);
      }
    }

    return groups;
  }, [reviewResult?.findings]);

  // Count findings
  const counts = useMemo(() => ({
    critical: groupedFindings.critical.length,
    high: groupedFindings.high.length,
    medium: groupedFindings.medium.length,
    low: groupedFindings.low.length,
    total: reviewResult?.findings?.length || 0,
    important: groupedFindings.critical.length + groupedFindings.high.length,
  }), [groupedFindings, reviewResult?.findings?.length]);

  // Selection handlers
  const toggleFinding = (id: string) => {
    setSelectedFindingIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectImportant = () => {
    const importantIds = [
      ...groupedFindings.critical.filter(f => !postedFindingIds.has(f.id)).map(f => f.id),
      ...groupedFindings.high.filter(f => !postedFindingIds.has(f.id)).map(f => f.id),
    ];
    setSelectedFindingIds(new Set(importantIds));
  };

  const selectAll = () => {
    const allIds = reviewResult?.findings
      ?.filter(f => !postedFindingIds.has(f.id))
      .map(f => f.id) || [];
    setSelectedFindingIds(new Set(allIds));
  };

  const selectNone = () => {
    setSelectedFindingIds(new Set());
  };

  // Post findings as comments
  const handlePostFindings = async () => {
    if (selectedFindingIds.size === 0 || !reviewResult?.findings) return;

    setIsPostingFindings(true);
    let successCount = 0;

    try {
      for (const findingId of selectedFindingIds) {
        const finding = reviewResult.findings.find(f => f.id === findingId);
        if (!finding) continue;

        // Format the comment content
        const content = `**[${finding.severity.toUpperCase()}] ${finding.title}**

${finding.description}

${finding.suggestedFix ? `**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`` : ''}

---
*Reviewed by Auto-Claude AI*`;

        const success = await onPostComment(content, finding.file, finding.line);
        if (success) {
          successCount++;
          setPostedFindingIds(prev => new Set([...prev, findingId]));
        }
      }

      setSelectedFindingIds(new Set());
      if (successCount > 0) {
        setPostSuccess({ count: successCount, timestamp: Date.now() });
        setTimeout(() => setPostSuccess(null), 3000);
      }
    } finally {
      setIsPostingFindings(false);
    }
  };

  // Check if MR is ready to merge based on review
  const isReadyToMerge = useMemo(() => {
    if (!reviewResult || !reviewResult.success) return false;
    return reviewResult.overallStatus === 'approve';
  }, [reviewResult]);

  // Selected count for button label
  const selectedCount = selectedFindingIds.size;

  return (
    <ErrorBoundary>
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={getPRStateColor(pr.status)}>
                  {pr.status.charAt(0).toUpperCase() + pr.status.slice(1)}
                </Badge>
                <span className="text-sm text-muted-foreground">!{pr.pullRequestId}</span>
                {pr.isDraft && (
                  <Badge variant="secondary">Draft</Badge>
                )}
              </div>
              <Button variant="ghost" size="icon" asChild>
                <a href={pr.webUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </div>
            <h2 className="text-lg font-semibold text-foreground">{pr.title}</h2>
          </div>

          {/* Meta */}
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <User className="h-4 w-4" />
              {pr.createdBy.displayName}
            </div>
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {formatDate(pr.creationDate)}
            </div>
            <div className="flex items-center gap-1">
              <GitBranch className="h-4 w-4" />
              {formatBranch(pr.sourceBranch)} → {formatBranch(pr.targetBranch)}
            </div>
          </div>

          {/* Reviewers */}
          {pr.reviewers && pr.reviewers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              {pr.reviewers.map((reviewer) => (
                <Badge
                  key={reviewer.uniqueName}
                  variant="outline"
                  className={cn("text-xs", getVoteColor(reviewer.vote))}
                >
                  {reviewer.displayName}
                  {reviewer.isRequired && ' (Required)'}
                  : {getVoteText(reviewer.vote)}
                </Badge>
              ))}
            </div>
          )}

          {/* Merge Status */}
          {pr.mergeStatus && pr.mergeStatus !== 'notSet' && (
            <div className="flex items-center gap-4">
              <Badge variant="outline" className="flex items-center gap-1">
                <FileDiff className="h-3 w-3" />
                Merge: {pr.mergeStatus}
              </Badge>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                onClick={onRunReview}
                disabled={isReviewing}
                className="flex-1"
              >
                {isReviewing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Reviewing...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Run AI Review
                  </>
                )}
              </Button>
              {isReviewing && (
                <Button onClick={onCancelReview} variant="destructive">
                  <XCircle className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              )}
              {reviewResult && reviewResult.success && selectedCount > 0 && !isReviewing && (
                <Button onClick={handlePostFindings} variant="secondary" disabled={isPostingFindings}>
                  {isPostingFindings ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Posting...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Post {selectedCount} Finding{selectedCount !== 1 ? 's' : ''}
                    </>
                  )}
                </Button>
              )}
              {/* Success message */}
              {postSuccess && (
                <div className="flex items-center gap-2 text-success text-sm">
                  <CheckCircle className="h-4 w-4" />
                  Posted {postSuccess.count} finding{postSuccess.count !== 1 ? 's' : ''} to Azure DevOps
                </div>
              )}
            </div>
          </div>

          {/* MR Review Status Banner */}
          {reviewResult && reviewResult.success && (
            <Card className={cn(
              "border-2",
              isReadyToMerge
                ? "bg-success/20 border-success/50"
                : counts.important > 0
                  ? "bg-destructive/20 border-destructive/50"
                  : "bg-muted"
            )}>
              <CardContent className="py-3">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "p-2 rounded-full",
                    isReadyToMerge
                      ? "bg-success/20 text-success"
                      : counts.important > 0
                        ? "bg-destructive/20 text-destructive"
                        : "bg-muted"
                  )}>
                    {isReadyToMerge ? (
                      <CheckCircle className="h-5 w-5" />
                    ) : counts.important > 0 ? (
                      <AlertTriangle className="h-5 w-5" />
                    ) : (
                      <AlertCircle className="h-5 w-5" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      {isReadyToMerge ? 'Ready to Merge' : counts.important > 0 ? 'Changes Requested' : 'Review Complete'}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {counts.total === 0
                        ? 'No issues found'
                        : `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Review Progress */}
          {reviewProgress && (
            <Card>
              <CardContent className="pt-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>{reviewProgress.message}</span>
                    <span className="text-muted-foreground">{reviewProgress.progress}%</span>
                  </div>
                  <Progress value={reviewProgress.progress} />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Review Result */}
          {reviewResult && reviewResult.success && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    AI Review Result
                  </span>
                  <Badge variant="outline" className={getStatusColor(reviewResult.overallStatus)}>
                    {reviewResult.overallStatus === 'approve' && 'Approve'}
                    {reviewResult.overallStatus === 'request_changes' && 'Changes Requested'}
                    {reviewResult.overallStatus === 'comment' && 'Comment'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 overflow-hidden">
                <p className="text-sm text-muted-foreground break-words">{reviewResult.summary}</p>

                {/* Quick Select Actions */}
                {reviewResult.findings && reviewResult.findings.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={selectImportant}
                      className="text-xs"
                      disabled={counts.important === 0}
                    >
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Select Critical/High ({counts.important})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={selectAll}
                      className="text-xs"
                    >
                      <CheckSquare className="h-3 w-3 mr-1" />
                      Select All
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={selectNone}
                      className="text-xs"
                      disabled={selectedFindingIds.size === 0}
                    >
                      <Square className="h-3 w-3 mr-1" />
                      Clear
                    </Button>
                  </div>
                )}

                {/* Findings by Severity */}
                {(['critical', 'high', 'medium', 'low'] as const).map((severity) => {
                  const findings = groupedFindings[severity];
                  if (findings.length === 0) return null;

                  const config = SEVERITY_CONFIG[severity];

                  return (
                    <div key={severity} className={cn("rounded-lg border", config.bgColor)}>
                      <div className="p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className={cn("font-medium text-sm", config.color)}>
                            {config.label} ({findings.length})
                          </span>
                        </div>
                        <div className="space-y-2">
                          {findings.map((finding) => (
                            <FindingItem
                              key={finding.id}
                              finding={finding}
                              selected={selectedFindingIds.has(finding.id)}
                              posted={postedFindingIds.has(finding.id)}
                              onToggle={() => toggleFinding(finding.id)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {reviewResult.reviewedAt && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed: {formatDate(reviewResult.reviewedAt)}
                    {reviewResult.reviewedCommitSha && (
                      <> at commit {reviewResult.reviewedCommitSha.substring(0, 7)}</>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Review Error */}
          {reviewResult && !reviewResult.success && (
            <Card className="border-destructive">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-destructive">
                  <XCircle className="h-4 w-4" />
                  <span className="text-sm">Review failed</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Description */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent className="overflow-hidden">
              {pr.description ? (
                <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans break-words max-w-full overflow-hidden">
                  {pr.description}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  No description provided.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Labels */}
          {pr.labels && pr.labels.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Labels</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {pr.labels.map((label) => (
                    <Badge key={label.name} variant="outline">
                      {label.name}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </ErrorBoundary>
  );
}
