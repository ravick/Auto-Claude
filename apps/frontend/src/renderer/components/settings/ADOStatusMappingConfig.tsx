/**
 * ADO Status Mapping Configuration Component
 * Allows users to configure how Auto-Claude statuses map to Azure DevOps work item states
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Plus,
  Trash2,
  RotateCcw,
  Loader2,
  ChevronDown,
  Check,
  AlertCircle,
  Type,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { cn } from '../../lib/utils';
import type { ADOStatusMappingConfig as ADOStatusMappingConfigType, ADOWorkItemType, ADOWorkItemState, ADOWorkItemTypeMapping } from '../../../shared/types/sync';
import { DEFAULT_ADO_STATUS_MAPPINGS } from '../../../shared/types/sync';

interface ADOStatusMappingConfigProps {
  config?: ADOStatusMappingConfigType;
  workItemTypes: ADOWorkItemType[];
  workItemStates: Record<string, ADOWorkItemState[]>;
  isLoadingTypes: boolean;
  isLoadingStates: Record<string, boolean>;
  error?: string | null;
  onSave: (config: ADOStatusMappingConfigType) => Promise<void>;
  onLoadStates: (workItemType: string) => Promise<void>;
  onRefreshTypes: () => Promise<void>;
  getDefaultMapping: (workItemType: string) => ADOWorkItemTypeMapping;
}

const AUTO_CLAUDE_STATUSES = ['backlog', 'in_progress', 'done'] as const;

/**
 * ADO Status Mapping Configuration
 * Displays a table of work item types and their state mappings
 */
export function ADOStatusMappingConfig({
  config,
  workItemTypes,
  workItemStates,
  isLoadingTypes,
  isLoadingStates,
  error,
  onSave,
  onLoadStates,
  onRefreshTypes,
  getDefaultMapping,
}: ADOStatusMappingConfigProps) {
  const { t } = useTranslation('settings');

  // Local state for editing
  const [localMappings, setLocalMappings] = useState<Record<string, ADOWorkItemTypeMapping>>(
    config?.workItemTypeMappings || {}
  );
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Manual work item type input
  const [manualTypeName, setManualTypeName] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);
  const manualInputRef = useRef<HTMLInputElement>(null);

  // Custom states per work item type (for manual entry when API returns no states)
  const [customStates, setCustomStates] = useState<Record<string, ADOWorkItemState[]>>({});
  const [manualStateName, setManualStateName] = useState<Record<string, string>>({});
  const manualStateInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Update local state when config changes
  useEffect(() => {
    if (config?.workItemTypeMappings) {
      setLocalMappings(config.workItemTypeMappings);
    }
    // Load custom states from config
    if (config?.customStates) {
      const loadedCustomStates: Record<string, ADOWorkItemState[]> = {};
      Object.entries(config.customStates).forEach(([workItemType, stateNames]) => {
        loadedCustomStates[workItemType] = stateNames.map(name => ({ name }));
      });
      setCustomStates(loadedCustomStates);
    }
  }, [config]);

  // Get configured work item types (from config + defaults)
  const configuredTypes = useMemo(() => {
    const types = new Set<string>(Object.keys(localMappings));
    // Add types that have defaults but aren't in config yet
    Object.keys(DEFAULT_ADO_STATUS_MAPPINGS).forEach(type => {
      if (workItemTypes.some(wt => wt.name === type)) {
        types.add(type);
      }
    });
    return Array.from(types).sort();
  }, [localMappings, workItemTypes]);

  // Available types to add (not yet configured)
  const availableTypesToAdd = useMemo(() => {
    return workItemTypes.filter(
      wt => !configuredTypes.includes(wt.name)
    );
  }, [workItemTypes, configuredTypes]);

  // Toggle expand/collapse for a work item type
  const toggleExpanded = async (workItemType: string) => {
    const newExpanded = new Set(expandedTypes);
    if (newExpanded.has(workItemType)) {
      newExpanded.delete(workItemType);
    } else {
      newExpanded.add(workItemType);
      // Load states if not already loaded
      if (!workItemStates[workItemType]) {
        await onLoadStates(workItemType);
      }
    }
    setExpandedTypes(newExpanded);
  };

  // Update a single mapping
  const updateMapping = (
    workItemType: string,
    status: 'backlog' | 'in_progress' | 'done',
    adoState: string
  ) => {
    setLocalMappings(prev => ({
      ...prev,
      [workItemType]: {
        ...prev[workItemType],
        [status]: adoState,
      },
    }));
    setHasChanges(true);
  };

  // Reset a work item type to defaults
  const resetToDefaults = (workItemType: string) => {
    const defaultMapping = getDefaultMapping(workItemType);
    setLocalMappings(prev => ({
      ...prev,
      [workItemType]: defaultMapping,
    }));
    setHasChanges(true);
  };

  // Reset all mappings to defaults
  const resetAllToDefaults = () => {
    const newMappings: Record<string, ADOWorkItemTypeMapping> = {};
    configuredTypes.forEach(type => {
      newMappings[type] = getDefaultMapping(type);
    });
    setLocalMappings(newMappings);
    setHasChanges(true);
  };

  // Add a new work item type
  const addWorkItemType = async (workItemType: string) => {
    if (!workItemType.trim()) return;

    const trimmedType = workItemType.trim();
    const defaultMapping = getDefaultMapping(trimmedType);
    setLocalMappings(prev => ({
      ...prev,
      [trimmedType]: defaultMapping,
    }));
    setHasChanges(true);
    // Expand and load states
    setExpandedTypes(prev => new Set(prev).add(trimmedType));
    await onLoadStates(trimmedType);
  };

  // Add manual work item type
  const handleAddManualType = async () => {
    if (!manualTypeName.trim()) return;
    if (configuredTypes.includes(manualTypeName.trim())) {
      // Type already exists
      return;
    }
    await addWorkItemType(manualTypeName.trim());
    setManualTypeName('');
    setShowManualInput(false);
  };

  // Toggle manual input mode
  const toggleManualInput = () => {
    setShowManualInput(prev => !prev);
    if (!showManualInput) {
      // Focus the input when showing
      setTimeout(() => manualInputRef.current?.focus(), 0);
    }
  };

  // Add a custom state for a work item type
  const addCustomState = (workItemType: string, stateName: string) => {
    if (!stateName.trim()) return;
    const trimmedName = stateName.trim();

    // Check if state already exists in API states or custom states
    const existingStates = workItemStates[workItemType] || [];
    const existingCustomStates = customStates[workItemType] || [];
    const allStates = [...existingStates, ...existingCustomStates];

    if (allStates.some(s => s.name.toLowerCase() === trimmedName.toLowerCase())) {
      return; // State already exists
    }

    setCustomStates(prev => ({
      ...prev,
      [workItemType]: [...(prev[workItemType] || []), { name: trimmedName }],
    }));
    setManualStateName(prev => ({ ...prev, [workItemType]: '' }));
    setHasChanges(true);
  };

  // Get combined states (API + custom) for a work item type
  const getCombinedStates = (workItemType: string): ADOWorkItemState[] => {
    const apiStates = workItemStates[workItemType] || [];
    const custom = customStates[workItemType] || [];
    return [...apiStates, ...custom];
  };

  // Remove a work item type mapping
  const removeWorkItemType = (workItemType: string) => {
    setLocalMappings(prev => {
      const newMappings = { ...prev };
      delete newMappings[workItemType];
      return newMappings;
    });
    setExpandedTypes(prev => {
      const newExpanded = new Set(prev);
      newExpanded.delete(workItemType);
      return newExpanded;
    });
    setHasChanges(true);
  };

  // Save changes
  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Convert customStates to string arrays for persistence
      const customStatesToSave: Record<string, string[]> = {};
      Object.entries(customStates).forEach(([workItemType, states]) => {
        if (states.length > 0) {
          customStatesToSave[workItemType] = states.map(s => s.name);
        }
      });

      await onSave({
        workItemTypeMappings: localMappings,
        availableStates: config?.availableStates,
        customStates: Object.keys(customStatesToSave).length > 0 ? customStatesToSave : undefined,
      });
      setHasChanges(false);
    } finally {
      setIsSaving(false);
    }
  };

  // Get the effective mapping value (local or default)
  const getMappingValue = (workItemType: string, status: 'backlog' | 'in_progress' | 'done'): string => {
    return localMappings[workItemType]?.[status] || getDefaultMapping(workItemType)[status] || '';
  };

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('externalSync.azureDevOps.mapping.title')}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t('externalSync.azureDevOps.mapping.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefreshTypes}
            disabled={isLoadingTypes}
            className="gap-1"
          >
            {isLoadingTypes ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {t('externalSync.azureDevOps.mapping.refreshTypes')}
          </Button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        </div>
      )}

      {/* Work Item Type List */}
      {isLoadingTypes && configuredTypes.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : configuredTypes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-center">
          <p className="text-sm text-muted-foreground">
            {t('externalSync.azureDevOps.mapping.noTypesConfigured')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {configuredTypes.map(workItemType => {
            const isExpanded = expandedTypes.has(workItemType);
            const states = workItemStates[workItemType] || [];
            const isLoadingState = isLoadingStates[workItemType];

            return (
              <div
                key={workItemType}
                className="rounded-lg border border-border bg-muted/30 overflow-hidden"
              >
                {/* Header */}
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleExpanded(workItemType)}
                >
                  <div className="flex items-center gap-2">
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 text-muted-foreground transition-transform',
                        !isExpanded && '-rotate-90'
                      )}
                    />
                    <span className="text-sm font-medium">{workItemType}</span>
                    {localMappings[workItemType] && (
                      <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                        {t('externalSync.azureDevOps.mapping.customized')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => resetToDefaults(workItemType)}
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      title={t('externalSync.azureDevOps.mapping.resetToDefaults')}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeWorkItemType(workItemType)}
                      className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                      title={t('externalSync.azureDevOps.mapping.remove')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-0 border-t border-border/50 space-y-3">
                    {isLoadingState ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <>
                        {/* State mapping dropdowns - show if we have any states */}
                        {getCombinedStates(workItemType).length > 0 && (
                          <div className="grid grid-cols-3 gap-3 pt-2">
                            {AUTO_CLAUDE_STATUSES.map(status => (
                              <div key={status} className="space-y-1">
                                <div>
                                  <Label className="text-xs text-muted-foreground capitalize">
                                    {t(`externalSync.azureDevOps.mapping.${status}`)}
                                  </Label>
                                  <p className="text-[10px] text-muted-foreground/70">
                                    {t(`externalSync.azureDevOps.mapping.${status}Hint`)}
                                  </p>
                                </div>
                                <Select
                                  value={getMappingValue(workItemType, status)}
                                  onValueChange={(value) => updateMapping(workItemType, status, value)}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder={t('externalSync.azureDevOps.mapping.selectState')} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {getCombinedStates(workItemType).map(state => (
                                      <SelectItem key={state.name} value={state.name}>
                                        <div className="flex items-center gap-2">
                                          {state.color && (
                                            <div
                                              className="w-2 h-2 rounded-full"
                                              style={{ backgroundColor: `#${state.color}` }}
                                            />
                                          )}
                                          {state.name}
                                        </div>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* No states message + fetch button + manual entry */}
                        {states.length === 0 && (
                          <div className="space-y-2 pt-2">
                            {getCombinedStates(workItemType).length === 0 && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <AlertCircle className="h-3 w-3" />
                                {t('externalSync.azureDevOps.mapping.noStatesFound')}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => onLoadStates(workItemType)}
                                  className="h-6 text-xs"
                                >
                                  {t('externalSync.azureDevOps.mapping.fetchStates')}
                                </Button>
                              </div>
                            )}

                            {/* Manual state input */}
                            <div className="flex items-center gap-2">
                              <Input
                                ref={(el) => { manualStateInputRefs.current[workItemType] = el; }}
                                value={manualStateName[workItemType] || ''}
                                onChange={(e) => setManualStateName(prev => ({ ...prev, [workItemType]: e.target.value }))}
                                placeholder={t('externalSync.azureDevOps.mapping.enterStateName')}
                                className="h-7 text-xs flex-1"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    addCustomState(workItemType, manualStateName[workItemType] || '');
                                  }
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => addCustomState(workItemType, manualStateName[workItemType] || '')}
                                disabled={!(manualStateName[workItemType] || '').trim()}
                                className="h-7 px-2 gap-1 text-xs"
                              >
                                <Plus className="h-3 w-3" />
                                {t('externalSync.azureDevOps.mapping.addState')}
                              </Button>
                            </div>

                            {/* Show custom states that were added */}
                            {(customStates[workItemType]?.length || 0) > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1">
                                {customStates[workItemType].map(state => (
                                  <span
                                    key={state.name}
                                    className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded"
                                  >
                                    {state.name}
                                    <button
                                      onClick={() => {
                                        setCustomStates(prev => ({
                                          ...prev,
                                          [workItemType]: prev[workItemType].filter(s => s.name !== state.name),
                                        }));
                                        setHasChanges(true);
                                      }}
                                      className="text-muted-foreground hover:text-destructive"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Show manual state input for types with API states too */}
                        {states.length > 0 && (
                          <div className="flex items-center gap-2 pt-2 border-t border-border/30">
                            <Input
                              ref={(el) => { manualStateInputRefs.current[workItemType] = el; }}
                              value={manualStateName[workItemType] || ''}
                              onChange={(e) => setManualStateName(prev => ({ ...prev, [workItemType]: e.target.value }))}
                              placeholder={t('externalSync.azureDevOps.mapping.enterStateName')}
                              className="h-7 text-xs flex-1"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  addCustomState(workItemType, manualStateName[workItemType] || '');
                                }
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => addCustomState(workItemType, manualStateName[workItemType] || '')}
                              disabled={!(manualStateName[workItemType] || '').trim()}
                              className="h-7 px-2 gap-1 text-xs"
                            >
                              <Plus className="h-3 w-3" />
                              {t('externalSync.azureDevOps.mapping.addState')}
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Work Item Type */}
      <div className="space-y-2">
        {/* Dropdown for API-discovered types */}
        {availableTypesToAdd.length > 0 && (
          <div className="flex items-center gap-2">
            <Select onValueChange={addWorkItemType}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <div className="flex items-center gap-2">
                  <Plus className="h-3 w-3" />
                  <SelectValue placeholder={t('externalSync.azureDevOps.mapping.addWorkItemType')} />
                </div>
              </SelectTrigger>
              <SelectContent>
                {availableTypesToAdd.map(type => (
                  <SelectItem key={type.name} value={type.name}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Manual input for custom work item type */}
        {showManualInput ? (
          <div className="flex items-center gap-2">
            <Input
              ref={manualInputRef}
              value={manualTypeName}
              onChange={(e) => setManualTypeName(e.target.value)}
              placeholder={t('externalSync.azureDevOps.mapping.enterTypeName')}
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddManualType();
                } else if (e.key === 'Escape') {
                  setShowManualInput(false);
                  setManualTypeName('');
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAddManualType}
              disabled={!manualTypeName.trim() || configuredTypes.includes(manualTypeName.trim())}
              className="h-8 px-2"
            >
              <Check className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowManualInput(false);
                setManualTypeName('');
              }}
              className="h-8 px-2 text-muted-foreground"
            >
              {t('externalSync.azureDevOps.mapping.cancel')}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleManualInput}
            className="h-8 gap-1 text-xs text-muted-foreground"
          >
            <Type className="h-3 w-3" />
            {t('externalSync.azureDevOps.mapping.addManualType')}
          </Button>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-2 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={resetAllToDefaults}
          className="gap-1 text-xs"
        >
          <RotateCcw className="h-3 w-3" />
          {t('externalSync.azureDevOps.mapping.resetAllToDefaults')}
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="gap-1"
        >
          {isSaving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t('externalSync.azureDevOps.mapping.save')}
        </Button>
      </div>
    </div>
  );
}
