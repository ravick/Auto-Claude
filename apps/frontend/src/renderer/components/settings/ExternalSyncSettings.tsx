/**
 * External Sync Settings Component
 * Manages configuration for syncing task status changes to GitHub Issues and Azure DevOps Work Items
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Settings2,
  GitBranch,
  AlertCircle,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { ADOStatusMappingConfig } from './ADOStatusMappingConfig';
import { useExternalSync } from '../../hooks/useExternalSync';
import { useToast } from '../../hooks/use-toast';
import type { ProjectEnvConfig } from '../../../shared/types';

interface ExternalSyncSettingsProps {
  projectId: string | null;
  envConfig: ProjectEnvConfig | null;
  isOpen: boolean;
}

/**
 * External Sync Settings - Configure status sync to GitHub Issues and Azure DevOps Work Items
 */
export function ExternalSyncSettings({ projectId, envConfig, isOpen }: ExternalSyncSettingsProps) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();

  const {
    config,
    isLoading,
    isSaving,
    error,
    workItemTypes,
    workItemStates,
    isLoadingTypes,
    isLoadingStates,
    loadConfig,
    updateConfig,
    saveConfig,
    loadWorkItemTypes,
    loadWorkItemStates,
    getDefaultMapping,
  } = useExternalSync(projectId);

  // UI state
  const [showADOMapping, setShowADOMapping] = useState(false);

  // Load config when section becomes visible
  useEffect(() => {
    if (isOpen && projectId) {
      loadConfig();
    }
  }, [isOpen, projectId, loadConfig]);

  // Check if GitHub is configured
  const isGitHubConfigured = Boolean(envConfig?.githubEnabled && envConfig?.githubToken);

  // Check if Azure DevOps is configured
  const isADOConfigured = Boolean(
    envConfig?.azureDevOpsEnabled &&
    envConfig?.azureDevOpsPat &&
    envConfig?.azureDevOpsOrganization &&
    envConfig?.azureDevOpsProject
  );

  // Handle toggle changes
  const handleEnabledChange = async (enabled: boolean) => {
    const success = await updateConfig({ enabled });
    if (success) {
      toast({
        title: enabled
          ? t('externalSync.toast.enabled')
          : t('externalSync.toast.disabled'),
      });
    }
  };

  const handleGitHubChange = async (syncToGitHub: boolean) => {
    const success = await updateConfig({ syncToGitHub });
    if (success) {
      toast({
        title: syncToGitHub
          ? t('externalSync.toast.githubEnabled')
          : t('externalSync.toast.githubDisabled'),
      });
    }
  };

  const handleADOChange = async (syncToAzureDevOps: boolean) => {
    const success = await updateConfig({ syncToAzureDevOps });
    if (success && syncToAzureDevOps) {
      // Load work item types when enabling ADO sync
      loadWorkItemTypes();
    }
  };

  // Handle ADO mapping configuration toggle
  const handleToggleMapping = () => {
    if (!showADOMapping && workItemTypes.length === 0) {
      loadWorkItemTypes();
    }
    setShowADOMapping(!showADOMapping);
  };

  // Handle saving ADO mapping
  const handleSaveMapping = async (mapping: Parameters<typeof saveConfig>[0]['adoStatusMapping']) => {
    if (!config) return;
    const success = await saveConfig({ ...config, adoStatusMapping: mapping });
    if (success) {
      toast({
        title: t('externalSync.toast.mappingSaved'),
      });
    }
  };

  if (isLoading) {
    return (
      <SettingsSection
        title={t('externalSync.title')}
        description={t('externalSync.description')}
      >
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t('externalSync.title')}
      description={t('externalSync.description')}
    >
      <div className="space-y-6">
        {/* Master Toggle */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium flex items-center gap-2">
                <RefreshCw className="h-4 w-4" />
                {t('externalSync.enabled')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('externalSync.enabledDescription')}
              </p>
            </div>
            <Switch
              checked={config?.enabled ?? false}
              onCheckedChange={handleEnabledChange}
              disabled={isSaving || (!isGitHubConfigured && !isADOConfigured)}
            />
          </div>

          {!isGitHubConfigured && !isADOConfigured && (
            <div className="rounded-lg bg-warning/10 border border-warning/30 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  {t('externalSync.noIntegrationsConfigured')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Individual Provider Settings */}
        {config?.enabled && (
          <div className="space-y-4 pl-6 border-l-2 border-primary/20">
            {/* GitHub Issues */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-semibold text-foreground">
                  {t('externalSync.github.title')}
                </h4>
              </div>

              <div className="rounded-lg bg-muted/30 border border-border p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">
                      {t('externalSync.github.syncEnabled')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('externalSync.github.description')}
                    </p>
                  </div>
                  <Switch
                    checked={config?.syncToGitHub ?? false}
                    onCheckedChange={handleGitHubChange}
                    disabled={isSaving || !isGitHubConfigured}
                  />
                </div>

                {!isGitHubConfigured && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <AlertCircle className="h-3 w-3" />
                    {t('externalSync.github.notConfigured')}
                  </div>
                )}
              </div>
            </div>

            {/* Azure DevOps Work Items */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-semibold text-foreground">
                  {t('externalSync.azureDevOps.title')}
                </h4>
              </div>

              <div className="rounded-lg bg-muted/30 border border-border p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">
                      {t('externalSync.azureDevOps.syncEnabled')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('externalSync.azureDevOps.description')}
                    </p>
                  </div>
                  <Switch
                    checked={config?.syncToAzureDevOps ?? false}
                    onCheckedChange={handleADOChange}
                    disabled={isSaving || !isADOConfigured}
                  />
                </div>

                {!isADOConfigured && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <AlertCircle className="h-3 w-3" />
                    {t('externalSync.azureDevOps.notConfigured')}
                  </div>
                )}

                {/* Configure Status Mapping button */}
                {isADOConfigured && config?.syncToAzureDevOps && (
                  <div className="pt-2 border-t border-border/50">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleToggleMapping}
                      className="gap-2"
                    >
                      {showADOMapping ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      <Settings2 className="h-3 w-3" />
                      {t('externalSync.azureDevOps.configureMapping')}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* ADO Status Mapping Configuration */}
            {showADOMapping && config?.syncToAzureDevOps && (
              <ADOStatusMappingConfig
                config={config.adoStatusMapping}
                workItemTypes={workItemTypes}
                workItemStates={workItemStates}
                isLoadingTypes={isLoadingTypes}
                isLoadingStates={isLoadingStates}
                error={error}
                onSave={handleSaveMapping}
                onLoadStates={loadWorkItemStates}
                onRefreshTypes={loadWorkItemTypes}
                getDefaultMapping={getDefaultMapping}
              />
            )}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
