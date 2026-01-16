import { create } from 'zustand';
import type {
  AzureDevOpsPRReviewProgress,
  AzureDevOpsPRReviewResult
} from '../../../shared/types';

/**
 * PR review state for a single PR
 */
interface PRReviewState {
  pullRequestId: number;
  projectId: string;
  isReviewing: boolean;
  progress: AzureDevOpsPRReviewProgress | null;
  result: AzureDevOpsPRReviewResult | null;
  error: string | null;
}

interface PRReviewStoreState {
  // PR Review state - persists across navigation
  // Key: `${projectId}:${pullRequestId}`
  prReviews: Record<string, PRReviewState>;

  // Actions
  startPRReview: (projectId: string, pullRequestId: number) => void;
  setPRReviewProgress: (projectId: string, progress: AzureDevOpsPRReviewProgress) => void;
  setPRReviewResult: (projectId: string, result: AzureDevOpsPRReviewResult) => void;
  setPRReviewError: (projectId: string, pullRequestId: number, error: string) => void;
  clearPRReview: (projectId: string, pullRequestId: number) => void;

  // Selectors
  getPRReviewState: (projectId: string, pullRequestId: number) => PRReviewState | null;
  getActivePRReviews: (projectId: string) => PRReviewState[];
}

export const usePRReviewStore = create<PRReviewStoreState>((set, get) => ({
  // Initial state
  prReviews: {},

  // Actions
  startPRReview: (projectId: string, pullRequestId: number) => set((state) => {
    const key = `${projectId}:${pullRequestId}`;
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          pullRequestId,
          projectId,
          isReviewing: true,
          progress: null,
          result: null,
          error: null
        }
      }
    };
  }),

  setPRReviewProgress: (projectId: string, progress: AzureDevOpsPRReviewProgress) => set((state) => {
    const key = `${projectId}:${progress.pullRequestId}`;
    const existing = state.prReviews[key];
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          pullRequestId: progress.pullRequestId,
          projectId,
          isReviewing: true,
          progress,
          result: existing?.result ?? null,
          error: null
        }
      }
    };
  }),

  setPRReviewResult: (projectId: string, result: AzureDevOpsPRReviewResult) => set((state) => {
    const key = `${projectId}:${result.pullRequestId}`;
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          pullRequestId: result.pullRequestId,
          projectId,
          isReviewing: false,
          progress: null,
          result,
          error: null
        }
      }
    };
  }),

  setPRReviewError: (projectId: string, pullRequestId: number, error: string) => set((state) => {
    const key = `${projectId}:${pullRequestId}`;
    const existing = state.prReviews[key];
    return {
      prReviews: {
        ...state.prReviews,
        [key]: {
          pullRequestId,
          projectId,
          isReviewing: false,
          progress: null,
          result: existing?.result ?? null,
          error
        }
      }
    };
  }),

  clearPRReview: (projectId: string, pullRequestId: number) => set((state) => {
    const key = `${projectId}:${pullRequestId}`;
    const { [key]: _, ...rest } = state.prReviews;
    return { prReviews: rest };
  }),

  // Selectors
  getPRReviewState: (projectId: string, pullRequestId: number) => {
    const { prReviews } = get();
    const key = `${projectId}:${pullRequestId}`;
    return prReviews[key] ?? null;
  },

  getActivePRReviews: (projectId: string) => {
    const { prReviews } = get();
    return Object.values(prReviews).filter(
      review => review.projectId === projectId && review.isReviewing
    );
  }
}));

/**
 * Global IPC listener setup for PR reviews.
 * Call this once at app startup to ensure PR review events are captured
 * regardless of which component is mounted.
 */
let prReviewListenersInitialized = false;
let cleanupFunctions: (() => void)[] = [];

export function initializePRReviewListeners(): void {
  if (prReviewListenersInitialized) {
    return;
  }

  const store = usePRReviewStore.getState();

  // Check if Azure DevOps PR Review API is available
  if (!window.electronAPI?.onAzureDevOpsPRReviewProgress) {
    console.warn('[Azure DevOps PR Store] Azure DevOps PR Review API not available, skipping listener setup');
    return;
  }

  // Listen for PR review progress events
  const progressHandler = (projectId: string, progress: AzureDevOpsPRReviewProgress) => {
    store.setPRReviewProgress(projectId, progress);
  };
  cleanupFunctions.push(window.electronAPI.onAzureDevOpsPRReviewProgress(progressHandler));

  // Listen for PR review completion events
  const completeHandler = (projectId: string, result: AzureDevOpsPRReviewResult) => {
    store.setPRReviewResult(projectId, result);
  };
  cleanupFunctions.push(window.electronAPI.onAzureDevOpsPRReviewComplete(completeHandler));

  // Listen for PR review error events
  const errorHandler = (projectId: string, error: string) => {
    // Parse the error to get the PR ID if available
    // The error format may vary, so we need to handle this carefully
    console.error('[Azure DevOps PR Store] Review error:', error);
  };
  cleanupFunctions.push(window.electronAPI.onAzureDevOpsPRReviewError(errorHandler));

  prReviewListenersInitialized = true;
}

/**
 * Cleanup PR review listeners.
 * Call this when the app is being unmounted or during hot-reload.
 */
export function cleanupPRReviewListeners(): void {
  for (const cleanup of cleanupFunctions) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors
    }
  }
  cleanupFunctions = [];
  prReviewListenersInitialized = false;
}

/**
 * Start a PR review and track it in the store
 */
export function startPRReview(projectId: string, pullRequestId: number): void {
  const store = usePRReviewStore.getState();
  store.startPRReview(projectId, pullRequestId);
  window.electronAPI.runAzureDevOpsPRReview(projectId, pullRequestId);
}
