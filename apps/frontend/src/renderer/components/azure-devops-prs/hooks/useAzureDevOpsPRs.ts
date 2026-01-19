import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  AzureDevOpsPullRequest,
  AzureDevOpsPRReviewResult,
  AzureDevOpsPRReviewProgress
} from '../../../../shared/types';
import {
  usePRReviewStore,
  startPRReview as storeStartPRReview
} from '../../../stores/azure-devops';

// Re-export types for consumers
export type { AzureDevOpsPullRequest, AzureDevOpsPRReviewResult, AzureDevOpsPRReviewProgress };
export type { AzureDevOpsPRReviewFinding } from '../../../../shared/types';

interface UseAzureDevOpsPRsResult {
  pullRequests: AzureDevOpsPullRequest[];
  isLoading: boolean;
  error: string | null;
  selectedPR: AzureDevOpsPullRequest | null;
  selectedPRId: number | null;
  reviewResult: AzureDevOpsPRReviewResult | null;
  reviewProgress: AzureDevOpsPRReviewProgress | null;
  isReviewing: boolean;
  isConnected: boolean;
  activePRReviews: number[]; // PR IDs currently being reviewed
  selectPR: (prId: number | null) => void;
  refresh: () => Promise<void>;
  runReview: (pullRequestId: number) => Promise<void>;
  cancelReview: (pullRequestId: number) => Promise<boolean>;
  postComment: (pullRequestId: number, content: string, filePath?: string, line?: number) => Promise<boolean>;
  getReviewStateForPR: (pullRequestId: number) => {
    isReviewing: boolean;
    progress: AzureDevOpsPRReviewProgress | null;
    result: AzureDevOpsPRReviewResult | null;
    error: string | null;
  } | null;
}

export function useAzureDevOpsPRs(projectId?: string): UseAzureDevOpsPRsResult {
  const [pullRequests, setPullRequests] = useState<AzureDevOpsPullRequest[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPRId, setSelectedPRId] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [stateFilter] = useState<'active' | 'completed' | 'abandoned' | 'all'>('active');

  // Get PR review state from the global store
  const prReviews = usePRReviewStore((state) => state.prReviews);
  const getPRReviewState = usePRReviewStore((state) => state.getPRReviewState);
  const getActivePRReviews = usePRReviewStore((state) => state.getActivePRReviews);

  // Get review state for the selected PR from the store
  const selectedPRReviewState = useMemo(() => {
    if (!projectId || selectedPRId === null) return null;
    return getPRReviewState(projectId, selectedPRId);
  }, [projectId, selectedPRId, prReviews, getPRReviewState]);

  // Derive values from store state
  const reviewResult = selectedPRReviewState?.result ?? null;
  const reviewProgress = selectedPRReviewState?.progress ?? null;
  const isReviewing = selectedPRReviewState?.isReviewing ?? false;

  // Get list of PR IDs currently being reviewed
  const activePRReviews = useMemo(() => {
    if (!projectId) return [];
    return getActivePRReviews(projectId).map(review => review.pullRequestId);
  }, [projectId, prReviews, getActivePRReviews]);

  // Helper to get review state for any PR
  const getReviewStateForPR = useCallback((pullRequestId: number) => {
    if (!projectId) return null;
    const state = getPRReviewState(projectId, pullRequestId);
    if (!state) return null;
    return {
      isReviewing: state.isReviewing,
      progress: state.progress,
      result: state.result,
      error: state.error
    };
  }, [projectId, prReviews, getPRReviewState]);

  const selectedPR = pullRequests.find(pr => pr.pullRequestId === selectedPRId) || null;

  // Check connection and fetch PRs
  const fetchPRs = useCallback(async () => {
    if (!projectId) return;

    setIsLoading(true);
    setError(null);

    try {
      // First check connection
      const connectionResult = await window.electronAPI.checkAzureDevOpsConnection(projectId);
      if (connectionResult.success && connectionResult.data) {
        setIsConnected(connectionResult.data.connected);

        if (connectionResult.data.connected) {
          // Fetch PRs
          const result = await window.electronAPI.getAzureDevOpsPullRequests(projectId, stateFilter);
          if (result.success && result.data) {
            setPullRequests(result.data);
          }
        }
      } else {
        setIsConnected(false);
        setError(connectionResult.error || 'Failed to check connection');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch PRs');
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, stateFilter]);

  useEffect(() => {
    fetchPRs();
  }, [fetchPRs]);

  const selectPR = useCallback((prId: number | null) => {
    setSelectedPRId(prId);
  }, []);

  const refresh = useCallback(async () => {
    await fetchPRs();
  }, [fetchPRs]);

  const runReview = useCallback(async (pullRequestId: number) => {
    if (!projectId) return;
    storeStartPRReview(projectId, pullRequestId);
  }, [projectId]);

  const cancelReview = useCallback(async (pullRequestId: number): Promise<boolean> => {
    if (!projectId) return false;
    // Cancel functionality would need to be implemented in the backend
    // For now, just update the store state
    usePRReviewStore.getState().setPRReviewError(projectId, pullRequestId, 'Review cancelled by user');
    return true;
  }, [projectId]);

  const postComment = useCallback(async (
    pullRequestId: number,
    content: string,
    filePath?: string,
    line?: number
  ): Promise<boolean> => {
    if (!projectId) return false;

    try {
      const result = await window.electronAPI.postAzureDevOpsPRComment(
        projectId,
        pullRequestId,
        content,
        filePath,
        line
      );
      return result.success && result.data === true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
      return false;
    }
  }, [projectId]);

  return {
    pullRequests,
    isLoading,
    error,
    selectedPR,
    selectedPRId,
    reviewResult,
    reviewProgress,
    isReviewing,
    isConnected,
    activePRReviews,
    selectPR,
    refresh,
    runReview,
    cancelReview,
    postComment,
    getReviewStateForPR,
  };
}
