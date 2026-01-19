import { useState } from 'react';
import { Loader2, RefreshCw, GitPullRequest } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { ScrollArea } from '../../ui/scroll-area';
import { PRItem } from './PRItem';
import type { AzureDevOpsPullRequest } from '../../../../shared/types';

interface PRListProps {
  pullRequests: AzureDevOpsPullRequest[];
  isLoading: boolean;
  selectedPRId: number | null;
  onSelectPR: (pr: AzureDevOpsPullRequest) => void;
  onRefresh: () => void;
  stateFilter: 'active' | 'completed' | 'abandoned' | 'all';
  onStateFilterChange: (state: 'active' | 'completed' | 'abandoned' | 'all') => void;
}

export function PRList({
  pullRequests,
  isLoading,
  selectedPRId,
  onSelectPR,
  onRefresh,
  stateFilter,
  onStateFilterChange
}: PRListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredPRs = pullRequests.filter((pr) => {
    const matchesSearch =
      pr.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pr.sourceBranch.toLowerCase().includes(searchQuery.toLowerCase()) ||
      pr.targetBranch.toLowerCase().includes(searchQuery.toLowerCase()) ||
      String(pr.pullRequestId).includes(searchQuery) ||
      pr.createdBy.displayName.toLowerCase().includes(searchQuery.toLowerCase());

    return matchesSearch;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <GitPullRequest className="h-4 w-4" />
            Pull Requests
          </h3>
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

        <Input
          placeholder="Search pull requests..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-sm"
        />

        <div className="flex gap-1">
          {(['active', 'completed', 'abandoned', 'all'] as const).map((state) => (
            <Button
              key={state}
              variant={stateFilter === state ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onStateFilterChange(state)}
              className="h-7 text-xs capitalize"
            >
              {state}
            </Button>
          ))}
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {isLoading && pullRequests.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredPRs.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {searchQuery ? 'No matching pull requests' : 'No pull requests found'}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {filteredPRs.map((pr) => (
              <PRItem
                key={pr.pullRequestId}
                pr={pr}
                isSelected={pr.pullRequestId === selectedPRId}
                onClick={() => onSelectPR(pr)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
