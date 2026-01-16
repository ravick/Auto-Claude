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
  Zap,
  Database,
  Users,
  FileQuestion,
  Sparkles,
  Eye,
  CheckCircle2,
  Loader2,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight
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
  AzureDevOpsSyncStatus,
  AzureDevOpsTeam,
  AzureDevOpsBacklog,
  AzureDevOpsSavedQuery,
  AzureDevOpsInvestigationStatus,
  AzureDevOpsInvestigationResult
} from '../../shared/types/integrations';

export interface AzureDevOpsWorkItemsProps {
  onOpenSettings: () => void;
  onNavigateToTask?: (taskId: string) => void;
}

type StateFilter = 'open' | 'closed' | 'all';
type TypeFilter = 'all' | 'Bug' | 'Defect' | 'Epic' | 'Feature' | 'Issue' | 'Task' | 'Test Case' | 'User Story';
type DataSource = 'workitems' | 'backlog' | 'query';
type SortBy = 'changedDate' | 'createdDate' | 'title' | 'state' | 'priority' | 'workItemType';
type SortOrder = 'asc' | 'desc';

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

// Complexity colors for task estimation
const complexityColors: Record<string, string> = {
  'simple': 'bg-green-500/20 text-green-500',
  'standard': 'bg-yellow-500/20 text-yellow-500',
  'complex': 'bg-red-500/20 text-red-500'
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

interface WorkItemDetailProps {
  workItem: AzureDevOpsWorkItem;
  onInvestigate: () => void;
  investigationStatus: AzureDevOpsInvestigationStatus | null;
  investigationResult: AzureDevOpsInvestigationResult | null;
  linkedTaskId: string | null;
  onViewTask: (taskId: string) => void;
}

function WorkItemDetail({
  workItem,
  onInvestigate,
  investigationStatus,
  investigationResult,
  linkedTaskId,
  onViewTask
}: WorkItemDetailProps) {
  const { t } = useTranslation('azureDevOps');
  const Icon = workItemTypeIcon[workItem.workItemType] || CheckSquare;
  const colorClass = workItemTypeColor[workItem.workItemType] || 'bg-muted text-muted-foreground';

  // Determine if we have a linked task (either pre-existing or just created)
  const taskId = linkedTaskId || (investigationResult?.success ? investigationResult.taskId : undefined);
  const hasLinkedTask = !!taskId;

  // Investigation in progress
  const isInvestigating = investigationStatus?.phase === 'fetching' ||
    investigationStatus?.phase === 'analyzing' ||
    investigationStatus?.phase === 'creating_task';

  const handleViewTask = () => {
    if (taskId) {
      onViewTask(taskId);
    }
  };

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

          {/* Create Task / View Task Button */}
          <div className="flex items-center gap-2">
            {hasLinkedTask ? (
              <Button onClick={handleViewTask} className="flex-1" variant="secondary">
                <Eye className="h-4 w-4 mr-2" />
                {t('detail.viewTask', 'View Task')}
              </Button>
            ) : (
              <Button
                onClick={onInvestigate}
                className="flex-1"
                disabled={isInvestigating}
              >
                {isInvestigating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {investigationStatus?.message || t('detail.analyzing', 'Analyzing...')}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    {t('detail.createTask', 'Create Task')}
                  </>
                )}
              </Button>
            )}
          </div>

          {/* Task Linked Info */}
          {hasLinkedTask && (
            <Card className="bg-green-500/5 border-green-500/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-green-500">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('detail.taskLinked', 'Task Linked')}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                {investigationResult?.success && investigationResult.analysis ? (
                  <>
                    <p className="text-foreground">{investigationResult.analysis.summary}</p>
                    <div className="flex items-center gap-2">
                      <Badge className={complexityColors[investigationResult.analysis.estimatedComplexity]}>
                        {investigationResult.analysis.estimatedComplexity}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Task ID: {taskId}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Task ID: {taskId}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Investigation Error */}
          {investigationStatus?.phase === 'error' && investigationStatus.error && (
            <Card className="bg-destructive/5 border-destructive/30">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  <span className="text-sm">{investigationStatus.error}</span>
                </div>
              </CardContent>
            </Card>
          )}

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
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t('detail.description', 'Description')}</CardTitle>
            </CardHeader>
            <CardContent>
              {workItem.description ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <pre className="whitespace-pre-wrap text-sm text-muted-foreground font-sans">
                    {workItem.description}
                  </pre>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {t('detail.noDescription', 'No description provided.')}
                </p>
              )}
            </CardContent>
          </Card>
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

  // Sorting and pagination state
  const [sortBy, setSortBy] = useState<SortBy>('changedDate');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [totalItems, setTotalItems] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Data source state
  const [dataSource, setDataSource] = useState<DataSource>('workitems');
  const [teams, setTeams] = useState<AzureDevOpsTeam[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [backlogs, setBacklogs] = useState<AzureDevOpsBacklog[]>([]);
  const [selectedBacklogId, setSelectedBacklogId] = useState<string | null>(null);
  const [savedQueries, setSavedQueries] = useState<AzureDevOpsSavedQuery[]>([]);
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null);
  const [isLoadingDataSource, setIsLoadingDataSource] = useState(false);

  // Investigation state
  const [investigationStatus, setInvestigationStatus] = useState<AzureDevOpsInvestigationStatus | null>(null);
  const [investigationResults, setInvestigationResults] = useState<Record<number, AzureDevOpsInvestigationResult>>({});
  const [linkedTasks, setLinkedTasks] = useState<Record<number, string>>({});

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

  // Set up investigation event listeners
  useEffect(() => {
    if (!selectedProjectId) return;

    const cleanupProgress = window.electronAPI.onAzureDevOpsInvestigationProgress(
      (projectId, status) => {
        if (projectId === selectedProjectId) {
          setInvestigationStatus(status);
        }
      }
    );

    const cleanupComplete = window.electronAPI.onAzureDevOpsInvestigationComplete(
      (projectId, result) => {
        if (projectId === selectedProjectId && result.workItemId) {
          setInvestigationStatus({ phase: 'complete', progress: 100, message: 'Complete' });
          setInvestigationResults(prev => ({
            ...prev,
            [result.workItemId]: result
          }));
          // Link the task if created successfully
          if (result.success && result.taskId) {
            setLinkedTasks(prev => ({
              ...prev,
              [result.workItemId]: result.taskId!
            }));
          }
        }
      }
    );

    const cleanupError = window.electronAPI.onAzureDevOpsInvestigationError(
      (projectId, error) => {
        if (projectId === selectedProjectId) {
          setInvestigationStatus({
            phase: 'error',
            progress: 0,
            message: error,
            error
          });
        }
      }
    );

    return () => {
      cleanupProgress();
      cleanupComplete();
      cleanupError();
    };
  }, [selectedProjectId]);

  // Load teams when data source changes to 'backlog'
  useEffect(() => {
    const loadTeams = async () => {
      if (!selectedProjectId || !syncStatus?.connected || dataSource !== 'backlog') return;

      setIsLoadingDataSource(true);
      try {
        const result = await window.electronAPI.getAzureDevOpsTeams(selectedProjectId);
        if (result.success && result.data) {
          setTeams(result.data);
          // Auto-select first team if none selected
          if (result.data.length > 0 && !selectedTeam) {
            setSelectedTeam(result.data[0].name);
          }
        }
      } catch (err) {
        console.error('Failed to load teams:', err);
      } finally {
        setIsLoadingDataSource(false);
      }
    };

    loadTeams();
  }, [selectedProjectId, syncStatus?.connected, dataSource]);

  // Load backlogs when team changes
  useEffect(() => {
    const loadBacklogs = async () => {
      if (!selectedProjectId || !syncStatus?.connected || dataSource !== 'backlog' || !selectedTeam) return;

      setIsLoadingDataSource(true);
      try {
        const result = await window.electronAPI.getAzureDevOpsBacklogs(selectedProjectId, selectedTeam);
        if (result.success && result.data) {
          setBacklogs(result.data);
          // Auto-select first backlog if none selected
          if (result.data.length > 0 && !selectedBacklogId) {
            setSelectedBacklogId(result.data[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load backlogs:', err);
      } finally {
        setIsLoadingDataSource(false);
      }
    };

    loadBacklogs();
  }, [selectedProjectId, syncStatus?.connected, dataSource, selectedTeam]);

  // Load saved queries when data source changes to 'query'
  useEffect(() => {
    const loadSavedQueries = async () => {
      if (!selectedProjectId || !syncStatus?.connected || dataSource !== 'query') return;

      setIsLoadingDataSource(true);
      try {
        const result = await window.electronAPI.getAzureDevOpsSavedQueries(selectedProjectId);
        if (result.success && result.data) {
          setSavedQueries(result.data);
          // Auto-select first query if none selected
          if (result.data.length > 0 && !selectedQueryId) {
            setSelectedQueryId(result.data[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load saved queries:', err);
      } finally {
        setIsLoadingDataSource(false);
      }
    };

    loadSavedQueries();
  }, [selectedProjectId, syncStatus?.connected, dataSource]);

  // Load work items based on data source
  useEffect(() => {
    const loadWorkItems = async () => {
      if (!selectedProjectId || !syncStatus?.connected) return;

      setIsLoading(true);
      setError(null);

      try {
        if (dataSource === 'workitems') {
          // Direct WIQL query with sorting and pagination
          const result = await window.electronAPI.getAzureDevOpsWorkItems(
            selectedProjectId,
            stateFilter,
            { sortBy, sortOrder, page, pageSize }
          );

          if (result?.success && result.data) {
            setWorkItems(result.data.items);
            setTotalItems(result.data.total);
            setHasMore(result.data.hasMore);
          } else {
            setError(result?.error || 'Failed to load work items');
            setWorkItems([]);
            setTotalItems(0);
            setHasMore(false);
          }
        } else if (dataSource === 'backlog') {
          // Load from backlog (no pagination support yet)
          if (!selectedBacklogId || !selectedTeam) {
            setWorkItems([]);
            setTotalItems(0);
            setHasMore(false);
            setIsLoading(false);
            return;
          }
          const result = await window.electronAPI.getAzureDevOpsBacklogWorkItems(
            selectedProjectId,
            selectedBacklogId,
            selectedTeam,
            stateFilter
          );

          if (result?.success && result.data) {
            setWorkItems(result.data);
            setTotalItems(result.data.length);
            setHasMore(false);
          } else {
            setError(result?.error || 'Failed to load work items');
            setWorkItems([]);
            setTotalItems(0);
            setHasMore(false);
          }
        } else if (dataSource === 'query') {
          // Execute saved query (no pagination support yet)
          if (!selectedQueryId) {
            setWorkItems([]);
            setTotalItems(0);
            setHasMore(false);
            setIsLoading(false);
            return;
          }
          const result = await window.electronAPI.executeAzureDevOpsSavedQuery(
            selectedProjectId,
            selectedQueryId,
            stateFilter
          );

          if (result?.success && result.data) {
            setWorkItems(result.data);
            setTotalItems(result.data.length);
            setHasMore(false);
          } else {
            setError(result?.error || 'Failed to load work items');
            setWorkItems([]);
            setTotalItems(0);
            setHasMore(false);
          }
        }
      } catch (err) {
        setError('Failed to load work items');
        setWorkItems([]);
        setTotalItems(0);
        setHasMore(false);
      } finally {
        setIsLoading(false);
      }
    };

    loadWorkItems();
  }, [selectedProjectId, syncStatus?.connected, stateFilter, dataSource, selectedBacklogId, selectedTeam, selectedQueryId, sortBy, sortOrder, page, pageSize]);

  const handleRefresh = useCallback(async () => {
    if (!selectedProjectId) return;

    // Re-check connection
    const connResult = await window.electronAPI.checkAzureDevOpsConnection(selectedProjectId);
    if (connResult.success && connResult.data) {
      setSyncStatus(connResult.data);
    }

    // Reload work items based on data source
    if (connResult.data?.connected) {
      setIsLoading(true);
      try {
        if (dataSource === 'workitems') {
          const result = await window.electronAPI.getAzureDevOpsWorkItems(
            selectedProjectId,
            stateFilter,
            { sortBy, sortOrder, page, pageSize }
          );
          if (result?.success && result.data) {
            setWorkItems(result.data.items);
            setTotalItems(result.data.total);
            setHasMore(result.data.hasMore);
          }
        } else if (dataSource === 'backlog' && selectedBacklogId && selectedTeam) {
          const result = await window.electronAPI.getAzureDevOpsBacklogWorkItems(
            selectedProjectId,
            selectedBacklogId,
            selectedTeam,
            stateFilter
          );
          if (result?.success && result.data) {
            setWorkItems(result.data);
            setTotalItems(result.data.length);
            setHasMore(false);
          }
        } else if (dataSource === 'query' && selectedQueryId) {
          const result = await window.electronAPI.executeAzureDevOpsSavedQuery(
            selectedProjectId,
            selectedQueryId,
            stateFilter
          );
          if (result?.success && result.data) {
            setWorkItems(result.data);
            setTotalItems(result.data.length);
            setHasMore(false);
          }
        }
      } finally {
        setIsLoading(false);
      }
    }
  }, [selectedProjectId, stateFilter, dataSource, selectedBacklogId, selectedTeam, selectedQueryId, sortBy, sortOrder, page, pageSize]);

  // Handle data source change - reset dependent selections
  const handleDataSourceChange = useCallback((newSource: DataSource) => {
    setDataSource(newSource);
    setWorkItems([]);
    setSelectedWorkItemId(null);
    setError(null);
    setPage(1);
    setTotalItems(0);
    setHasMore(false);
  }, []);

  // Handle investigate work item (Create Task)
  const handleInvestigate = useCallback((workItemId: number) => {
    if (!selectedProjectId) return;

    // Reset investigation status for this work item
    setInvestigationStatus({
      phase: 'fetching',
      workItemId,
      progress: 0,
      message: 'Fetching work item details...'
    });

    // Start the investigation
    window.electronAPI.investigateAzureDevOpsWorkItem(selectedProjectId, workItemId);
  }, [selectedProjectId]);

  // Handle view task navigation
  const handleViewTask = useCallback((taskId: string) => {
    if (onNavigateToTask) {
      onNavigateToTask(taskId);
    }
  }, [onNavigateToTask]);

  // Handle sorting change
  const handleSortChange = useCallback((newSortBy: SortBy) => {
    if (newSortBy === sortBy) {
      // Toggle sort order if clicking the same field
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(newSortBy);
      setSortOrder('desc');
    }
    setPage(1); // Reset to first page when sorting changes
  }, [sortBy, sortOrder]);

  // Handle page change
  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
    setSelectedWorkItemId(null);
  }, []);

  // Calculate total pages
  const totalPages = useMemo(() => {
    return Math.ceil(totalItems / pageSize);
  }, [totalItems, pageSize]);

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
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border bg-muted/30">
        <div className="relative flex-1 max-w-xs min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('filters.search', 'Search work items...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Data Source Selector */}
        <Select value={dataSource} onValueChange={(v) => handleDataSourceChange(v as DataSource)}>
          <SelectTrigger className="w-[150px]">
            <Database className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workitems">{t('filters.workItems', 'Work Items')}</SelectItem>
            <SelectItem value="backlog">{t('filters.backlog', 'Backlog')}</SelectItem>
            <SelectItem value="query">{t('filters.savedQuery', 'Saved Query')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Team Selector (shown when backlog is selected) */}
        {dataSource === 'backlog' && (
          <Select
            value={selectedTeam || ''}
            onValueChange={(v) => {
              setSelectedTeam(v);
              setSelectedBacklogId(null); // Reset backlog when team changes
            }}
            disabled={isLoadingDataSource || teams.length === 0}
          >
            <SelectTrigger className="w-[160px]">
              <Users className="h-4 w-4 mr-2" />
              <SelectValue placeholder={t('filters.selectTeam', 'Select Team')} />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.name}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Backlog Selector (shown when backlog is selected and team is chosen) */}
        {dataSource === 'backlog' && selectedTeam && (
          <Select
            value={selectedBacklogId || ''}
            onValueChange={(v) => setSelectedBacklogId(v)}
            disabled={isLoadingDataSource || backlogs.length === 0}
          >
            <SelectTrigger className="w-[180px]">
              <Layers className="h-4 w-4 mr-2" />
              <SelectValue placeholder={t('filters.selectBacklog', 'Select Backlog')} />
            </SelectTrigger>
            <SelectContent>
              {backlogs.map((backlog) => (
                <SelectItem key={backlog.id} value={backlog.id}>
                  {backlog.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Saved Query Selector (shown when query is selected) */}
        {dataSource === 'query' && (
          <Select
            value={selectedQueryId || ''}
            onValueChange={(v) => setSelectedQueryId(v)}
            disabled={isLoadingDataSource || savedQueries.length === 0}
          >
            <SelectTrigger className="w-[200px]">
              <FileQuestion className="h-4 w-4 mr-2" />
              <SelectValue placeholder={t('filters.selectQuery', 'Select Query')} />
            </SelectTrigger>
            <SelectContent>
              {savedQueries.map((query) => (
                <SelectItem key={query.id} value={query.id}>
                  {query.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

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

        {/* Sort control - only for direct work items query */}
        {dataSource === 'workitems' && (
          <Select value={sortBy} onValueChange={(v) => handleSortChange(v as SortBy)}>
            <SelectTrigger className="w-[160px]">
              <ArrowUpDown className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="changedDate">{t('sort.changedDate', 'Changed Date')}</SelectItem>
              <SelectItem value="createdDate">{t('sort.createdDate', 'Created Date')}</SelectItem>
              <SelectItem value="title">{t('sort.title', 'Title')}</SelectItem>
              <SelectItem value="state">{t('sort.state', 'State')}</SelectItem>
              <SelectItem value="priority">{t('sort.priority', 'Priority')}</SelectItem>
              <SelectItem value="workItemType">{t('sort.workItemType', 'Type')}</SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Sort order toggle - only for direct work items query */}
        {dataSource === 'workitems' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="px-2"
            title={sortOrder === 'asc' ? t('sort.ascending', 'Ascending') : t('sort.descending', 'Descending')}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </Button>
        )}
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

          {/* Pagination controls - only for direct work items query */}
          {dataSource === 'workitems' && totalItems > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/30">
              <span className="text-xs text-muted-foreground">
                {t('pagination.showing', 'Showing')} {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, totalItems)} {t('pagination.of', 'of')} {totalItems}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page - 1)}
                  disabled={page === 1 || isLoading}
                  className="h-7 w-7 p-0"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground px-2">
                  {t('pagination.page', 'Page')} {page} {t('pagination.of', 'of')} {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(page + 1)}
                  disabled={!hasMore || isLoading}
                  className="h-7 w-7 p-0"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Work Item Detail */}
        <div className="w-1/2 flex flex-col">
          {selectedWorkItem ? (
            <WorkItemDetail
              workItem={selectedWorkItem}
              onInvestigate={() => handleInvestigate(selectedWorkItem.id)}
              investigationStatus={
                investigationStatus?.workItemId === selectedWorkItem.id
                  ? investigationStatus
                  : null
              }
              investigationResult={investigationResults[selectedWorkItem.id] || null}
              linkedTaskId={linkedTasks[selectedWorkItem.id] || null}
              onViewTask={handleViewTask}
            />
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
