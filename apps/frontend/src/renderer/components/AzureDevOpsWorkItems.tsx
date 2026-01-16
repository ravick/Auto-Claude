import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Search,
  Filter,
  Bug,
  CheckSquare,
  BookOpen,
  Layers,
  Star,
  ExternalLink,
  AlertCircle,
  Settings,
  User,
  Calendar,
  CircleDot,
  FlaskConical,
  Zap
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { cn } from '../lib/utils';
import { useProjectStore } from '../stores/project-store';
import type {
  AzureDevOpsWorkItem,
  AzureDevOpsSyncStatus
} from '../../shared/types/integrations';

export interface AzureDevOpsWorkItemsProps {
  onOpenSettings: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

type StateFilter = 'open' | 'closed' | 'all';
type TypeFilter = 'all' | 'Bug' | 'Defect' | 'Epic' | 'Feature' | 'Issue' | 'Task' | 'Test Case' | 'User Story';

// Work item type to icon mapping
const workItemTypeIcon: Record<string, React.ElementType> = {
  'Bug': Bug,
  'Defect': Bug,
  'Epic': Layers,
  'Feature': Star,
  'Issue': CircleDot,
  'Task': CheckSquare,
  'Test Case': FlaskConical,
  'User Story': BookOpen
};

// Work item type to color mapping (matching Azure DevOps colors)
const workItemTypeColor: Record<string, string> = {
  'Bug': 'bg-red-500/10 text-red-500 border-red-500/20',
  'Defect': 'bg-red-400/10 text-red-400 border-red-400/20',
  'Epic': 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  'Feature': 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  'Issue': 'bg-pink-500/10 text-pink-500 border-pink-500/20',
  'Task': 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  'Test Case': 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  'User Story': 'bg-blue-500/10 text-blue-500 border-blue-500/20'
};

function NotConnectedState({
  error,
  onOpenSettings
}: {
  error: string | null;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation('azureDevOps');

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-muted-foreground" />
            {t('notConnected.title', 'Azure DevOps Not Connected')}
          </CardTitle>
          <CardDescription>
            {error || t('notConnected.description', 'Configure Azure DevOps integration to view work items.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onOpenSettings} className="w-full">
            <Settings className="h-4 w-4 mr-2" />
            {t('notConnected.configure', 'Configure Azure DevOps')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function WorkItemListItem({
  workItem,
  isSelected,
  onSelect
}: {
  workItem: AzureDevOpsWorkItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = workItemTypeIcon[workItem.workItemType] || CheckSquare;
  const colorClass = workItemTypeColor[workItem.workItemType] || 'bg-muted text-muted-foreground';

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left p-3 border-b border-border hover:bg-muted/50 transition-colors',
        isSelected && 'bg-muted'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('p-1.5 rounded border', colorClass)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">#{workItem.id}</span>
            <Badge variant="outline" className="text-xs">
              {workItem.state}
            </Badge>
          </div>
          <h4 className="font-medium text-sm mt-1 truncate">{workItem.title}</h4>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <User className="h-3 w-3" />
              {workItem.createdBy?.displayName || 'Unknown'}
            </span>
            {workItem.tags && workItem.tags.length > 0 && (
              <div className="flex gap-1 overflow-hidden">
                {workItem.tags.slice(0, 2).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs px-1">
                    {tag}
                  </Badge>
                ))}
                {workItem.tags.length > 2 && (
                  <span className="text-muted-foreground">+{workItem.tags.length - 2}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function WorkItemDetail({ workItem }: { workItem: AzureDevOpsWorkItem }) {
  const { t } = useTranslation('azureDevOps');
  const Icon = workItemTypeIcon[workItem.workItemType] || CheckSquare;
  const colorClass = workItemTypeColor[workItem.workItemType] || 'bg-muted text-muted-foreground';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={cn('p-2 rounded border', colorClass)}>
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground font-mono">#{workItem.id}</span>
                <Badge variant="outline">{workItem.workItemType}</Badge>
                <Badge variant="secondary">{workItem.state}</Badge>
              </div>
              <h2 className="text-lg font-semibold mt-1">{workItem.title}</h2>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(workItem.url, '_blank')}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            {t('detail.openInADO', 'Open in Azure DevOps')}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          {/* Metadata */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">{t('detail.createdBy', 'Created by')}</div>
              <div className="flex items-center gap-2 mt-1">
                <User className="h-4 w-4 text-muted-foreground" />
                {workItem.createdBy?.displayName || 'Unknown'}
              </div>
            </div>
            {workItem.assignedTo && (
              <div>
                <div className="text-muted-foreground">{t('detail.assignedTo', 'Assigned to')}</div>
                <div className="flex items-center gap-2 mt-1">
                  <User className="h-4 w-4 text-muted-foreground" />
                  {workItem.assignedTo.displayName}
                </div>
              </div>
            )}
            {workItem.iteration && (
              <div>
                <div className="text-muted-foreground">{t('detail.iteration', 'Iteration')}</div>
                <div className="mt-1">{workItem.iteration}</div>
              </div>
            )}
            <div>
              <div className="text-muted-foreground">{t('detail.created', 'Created')}</div>
              <div className="flex items-center gap-2 mt-1">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                {new Date(workItem.createdDate).toLocaleDateString()}
              </div>
            </div>
          </div>

          {/* Tags */}
          {workItem.tags && workItem.tags.length > 0 && (
            <div>
              <div className="text-sm text-muted-foreground mb-2">{t('detail.tags', 'Tags')}</div>
              <div className="flex flex-wrap gap-2">
                {workItem.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          {workItem.description && (
            <div>
              <div className="text-sm text-muted-foreground mb-2">{t('detail.description', 'Description')}</div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <p className="whitespace-pre-wrap">{workItem.description}</p>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function AzureDevOpsWorkItems({ onOpenSettings, onNavigateToTask }: AzureDevOpsWorkItemsProps) {
  const { t } = useTranslation('azureDevOps');
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  // State
  const [syncStatus, setSyncStatus] = useState<AzureDevOpsSyncStatus | null>(null);
  const [workItems, setWorkItems] = useState<AzureDevOpsWorkItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  // Check connection on mount or when project changes
  useEffect(() => {
    const checkConnection = async () => {
      if (!selectedProjectId) return;

      try {
        const result = await window.electronAPI.checkAzureDevOpsConnection(selectedProjectId);
        if (result.success && result.data) {
          setSyncStatus(result.data);
        } else {
          setSyncStatus({ connected: false, error: result.error });
        }
      } catch (err) {
        setSyncStatus({ connected: false, error: 'Failed to check connection' });
      }
    };

    checkConnection();
  }, [selectedProjectId]);

  // Load work items when connected or filter changes
  useEffect(() => {
    const loadWorkItems = async () => {
      if (!selectedProjectId || !syncStatus?.connected) return;

      setIsLoading(true);
      setError(null);

      try {
        const result = await window.electronAPI.getAzureDevOpsWorkItems(selectedProjectId, stateFilter);
        if (result.success && result.data) {
          setWorkItems(result.data);
        } else {
          setError(result.error || 'Failed to load work items');
          setWorkItems([]);
        }
      } catch (err) {
        setError('Failed to load work items');
        setWorkItems([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadWorkItems();
  }, [selectedProjectId, syncStatus?.connected, stateFilter]);

  const handleRefresh = useCallback(async () => {
    if (!selectedProjectId) return;

    // Re-check connection
    const connResult = await window.electronAPI.checkAzureDevOpsConnection(selectedProjectId);
    if (connResult.success && connResult.data) {
      setSyncStatus(connResult.data);
    }

    // Reload work items
    if (connResult.data?.connected) {
      setIsLoading(true);
      try {
        const result = await window.electronAPI.getAzureDevOpsWorkItems(selectedProjectId, stateFilter);
        if (result.success && result.data) {
          setWorkItems(result.data);
        }
      } finally {
        setIsLoading(false);
      }
    }
  }, [selectedProjectId, stateFilter]);

  // Filter work items by search and type
  const filteredWorkItems = useMemo(() => {
    let items = workItems;

    // Filter by type
    if (typeFilter !== 'all') {
      items = items.filter((item) => item.workItemType === typeFilter);
    }

    // Filter by search
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.description?.toLowerCase().includes(query) ||
          item.id.toString().includes(query) ||
          item.tags?.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    return items;
  }, [workItems, typeFilter, searchQuery]);

  const selectedWorkItem = useMemo(() => {
    return workItems.find((item) => item.id === selectedWorkItemId) || null;
  }, [workItems, selectedWorkItemId]);

  const openWorkItemsCount = useMemo(() => {
    return workItems.filter(
      (item) => !['Closed', 'Removed', 'Done', 'Completed', 'Resolved'].includes(item.state)
    ).length;
  }, [workItems]);

  // Not connected state
  if (!syncStatus?.connected) {
    return <NotConnectedState error={syncStatus?.error || null} onOpenSettings={onOpenSettings} />;
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div>
          <h1 className="text-lg font-semibold">
            {t('header.title', 'Azure DevOps Work Items')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {syncStatus.organization}/{syncStatus.project}
            {' - '}
            {openWorkItemsCount} {t('header.openItems', 'open items')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading}>
            <RefreshCw className={cn('h-4 w-4 mr-2', isLoading && 'animate-spin')} />
            {t('header.refresh', 'Refresh')}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 p-4 border-b border-border bg-muted/30">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('filters.search', 'Search work items...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
          <SelectTrigger className="w-[140px]">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t('filters.open', 'Open')}</SelectItem>
            <SelectItem value="closed">{t('filters.closed', 'Closed')}</SelectItem>
            <SelectItem value="all">{t('filters.all', 'All')}</SelectItem>
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder={t('filters.type', 'Type')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.allTypes', 'All Types')}</SelectItem>
            <SelectItem value="Bug">{t('filters.bug', 'Bug')}</SelectItem>
            <SelectItem value="Defect">{t('filters.defect', 'Defect')}</SelectItem>
            <SelectItem value="Epic">{t('filters.epic', 'Epic')}</SelectItem>
            <SelectItem value="Feature">{t('filters.feature', 'Feature')}</SelectItem>
            <SelectItem value="Issue">{t('filters.issue', 'Issue')}</SelectItem>
            <SelectItem value="Task">{t('filters.task', 'Task')}</SelectItem>
            <SelectItem value="Test Case">{t('filters.testCase', 'Test Case')}</SelectItem>
            <SelectItem value="User Story">{t('filters.userStory', 'User Story')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* Work Item List */}
        <div className="w-1/2 border-r border-border flex flex-col">
          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="flex items-center justify-center p-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" className="mt-4" onClick={handleRefresh}>
                  {t('error.retry', 'Retry')}
                </Button>
              </div>
            ) : filteredWorkItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <CheckSquare className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery || typeFilter !== 'all'
                    ? t('empty.noMatches', 'No work items match your filters')
                    : t('empty.noItems', 'No work items found')}
                </p>
              </div>
            ) : (
              filteredWorkItems.map((workItem) => (
                <WorkItemListItem
                  key={workItem.id}
                  workItem={workItem}
                  isSelected={workItem.id === selectedWorkItemId}
                  onSelect={() => setSelectedWorkItemId(workItem.id)}
                />
              ))
            )}
          </ScrollArea>
        </div>

        {/* Work Item Detail */}
        <div className="w-1/2 flex flex-col">
          {selectedWorkItem ? (
            <WorkItemDetail workItem={selectedWorkItem} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <p>{t('detail.selectItem', 'Select a work item to view details')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
