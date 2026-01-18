/**
 * Hook for managing external sync settings
 * Handles loading and saving external sync configuration for projects
 */

import { useState, useEffect, useCallback } from 'react';
import type { ExternalSyncConfig, ADOWorkItemType, ADOWorkItemState, ADOStatusMappingConfig } from '../../shared/types/sync';
import { DEFAULT_ADO_STATUS_MAPPINGS } from '../../shared/types/sync';
import { debugLog, debugError } from '../../shared/utils/debug-logger';

interface UseExternalSyncResult {
  config: ExternalSyncConfig | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  workItemTypes: ADOWorkItemType[];
  workItemStates: Record<string, ADOWorkItemState[]>;
  isLoadingTypes: boolean;
  isLoadingStates: Record<string, boolean>;
  loadConfig: () => Promise<void>;
  saveConfig: (config: ExternalSyncConfig) => Promise<boolean>;
  updateConfig: (updates: Partial<ExternalSyncConfig>) => Promise<boolean>;
  loadWorkItemTypes: () => Promise<void>;
  loadWorkItemStates: (workItemType: string) => Promise<void>;
  getDefaultMapping: (workItemType: string) => { backlog?: string; in_progress?: string; done?: string };
}

const DEFAULT_CONFIG: ExternalSyncConfig = {
  enabled: false,
  syncToGitHub: false,
  syncToAzureDevOps: false,
};

export function useExternalSync(projectId: string | null): UseExternalSyncResult {
  const [config, setConfig] = useState<ExternalSyncConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ADO work item types and states
  const [workItemTypes, setWorkItemTypes] = useState<ADOWorkItemType[]>([]);
  const [workItemStates, setWorkItemStates] = useState<Record<string, ADOWorkItemState[]>>({});
  const [isLoadingTypes, setIsLoadingTypes] = useState(false);
  const [isLoadingStates, setIsLoadingStates] = useState<Record<string, boolean>>({});

  // Load config when projectId changes
  const loadConfig = useCallback(async () => {
    if (!projectId) {
      setConfig(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.getSyncConfig(projectId);
      if (result.success && result.config) {
        setConfig(result.config);
      } else {
        // Use default config if none exists
        setConfig(DEFAULT_CONFIG);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sync configuration';
      setError(message);
      debugError('[useExternalSync] Load config failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  // Save config
  const saveConfig = useCallback(async (newConfig: ExternalSyncConfig): Promise<boolean> => {
    if (!projectId) return false;

    setIsSaving(true);
    setError(null);

    try {
      const result = await window.electronAPI.saveSyncConfig(projectId, newConfig);
      if (result.success) {
        setConfig(newConfig);
        debugLog('[useExternalSync] Config saved successfully');
        return true;
      } else {
        setError(result.error || 'Failed to save configuration');
        return false;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save sync configuration';
      setError(message);
      debugError('[useExternalSync] Save config failed:', err);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [projectId]);

  // Update config with partial changes
  const updateConfig = useCallback(async (updates: Partial<ExternalSyncConfig>): Promise<boolean> => {
    if (!config) return false;
    const newConfig = { ...config, ...updates };
    return saveConfig(newConfig);
  }, [config, saveConfig]);

  // Load work item types from ADO
  const loadWorkItemTypes = useCallback(async () => {
    if (!projectId) return;

    setIsLoadingTypes(true);
    setError(null);
    try {
      const result = await window.electronAPI.getAzureDevOpsWorkItemTypes(projectId);
      if (result.success && result.types) {
        setWorkItemTypes(result.types);
        debugLog('[useExternalSync] Loaded work item types:', result.types.length);
      } else if (result.error) {
        debugError('[useExternalSync] Failed to load work item types:', result.error);
        setError(result.error);
      }
    } catch (err) {
      debugError('[useExternalSync] Failed to load work item types:', err);
    } finally {
      setIsLoadingTypes(false);
    }
  }, [projectId]);

  // Load work item states for a specific type
  const loadWorkItemStates = useCallback(async (workItemType: string) => {
    if (!projectId) return;

    setIsLoadingStates(prev => ({ ...prev, [workItemType]: true }));
    try {
      const result = await window.electronAPI.getAzureDevOpsWorkItemStates(projectId, workItemType);
      if (result.success && result.states) {
        setWorkItemStates(prev => ({ ...prev, [workItemType]: result.states! }));
        debugLog('[useExternalSync] Loaded states for', workItemType, ':', result.states.length);
      } else if (result.error) {
        debugError('[useExternalSync] Failed to load work item states:', result.error);
      }
    } catch (err) {
      debugError('[useExternalSync] Failed to load work item states:', err);
    } finally {
      setIsLoadingStates(prev => ({ ...prev, [workItemType]: false }));
    }
  }, [projectId]);

  // Get default mapping for a work item type
  const getDefaultMapping = useCallback((workItemType: string) => {
    return DEFAULT_ADO_STATUS_MAPPINGS[workItemType] || {
      backlog: 'New',
      in_progress: 'Active',
      done: 'Closed',
    };
  }, []);

  // Load config on mount or when projectId changes
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  return {
    config,
    isLoading,
    isSaving,
    error,
    workItemTypes,
    workItemStates,
    isLoadingTypes,
    isLoadingStates,
    loadConfig,
    saveConfig,
    updateConfig,
    loadWorkItemTypes,
    loadWorkItemStates,
    getDefaultMapping,
  };
}
