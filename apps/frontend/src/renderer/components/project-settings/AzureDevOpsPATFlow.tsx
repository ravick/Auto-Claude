import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Info,
  ExternalLink,
  Key,
  Eye,
  EyeOff
} from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

interface AzureDevOpsPATFlowProps {
  onSuccess: (pat: string, username?: string, organization?: string) => void;
  onCancel?: () => void;
}

// Debug logging helper
const DEBUG = process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true';

function debugLog(message: string, data?: unknown) {
  if (DEBUG) {
    if (data !== undefined) {
      console.debug(`[AzureDevOpsPAT] ${message}`, data);
    } else {
      console.debug(`[AzureDevOpsPAT] ${message}`);
    }
  }
}

/**
 * Azure DevOps PAT authentication flow component
 * Guides users through authenticating with Azure DevOps using a Personal Access Token
 */
export function AzureDevOpsPATFlow({ onSuccess, onCancel }: AzureDevOpsPATFlowProps) {
  const { t } = useTranslation('dialogs');
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [organization, setOrganization] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Ref to track if component is mounted
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Continue without validation - validation happens in subsequent steps when loading projects
  const handleContinue = () => {
    if (!pat.trim()) {
      setError(t('azureDevOpsSetup.patRequired'));
      return;
    }

    if (!organization.trim()) {
      setError(t('azureDevOpsSetup.organizationRequired'));
      return;
    }

    debugLog('Continuing with PAT and organization (validation skipped)', {
      hasOrganization: true,
      organization: organization.trim()
    });

    // Pass PAT and organization to next step - validation will happen when loading projects
    onSuccess(pat.trim(), undefined, organization.trim());
  };

  const handleOpenAzureDevOps = () => {
    window.open('https://dev.azure.com', '_blank');
  };

  const handleOpenPatHelp = () => {
    // Direct link to PAT creation in Azure DevOps
    window.open('https://dev.azure.com/_usersSettings/tokens', '_blank');
  };

  return (
    <div className="space-y-4">
      <Card className="border border-info/30 bg-info/10">
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <Key className="h-6 w-6 text-info shrink-0 mt-0.5" />
            <div className="flex-1 space-y-3">
              <h3 className="text-lg font-medium text-foreground">
                {t('azureDevOpsSetup.patTitle')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('azureDevOpsSetup.patHelp')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Label htmlFor="ado-pat">{t('azureDevOpsSetup.patTitle')}</Label>
        <div className="relative">
          <Input
            id="ado-pat"
            type={showPat ? 'text' : 'password'}
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder={t('azureDevOpsSetup.patPlaceholder')}
            className="pr-10"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                handleContinue();
              }
            }}
          />
          <button
            type="button"
            onClick={() => setShowPat(!showPat)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={showPat ? 'Hide PAT' : 'Show PAT'}
          >
            {showPat ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ado-org">
          {t('azureDevOpsSetup.organizationLabelRequired')}
          <span className="text-destructive ml-1">*</span>
        </Label>
        <Input
          id="ado-org"
          type="text"
          value={organization}
          onChange={(e) => setOrganization(e.target.value)}
          placeholder={t('azureDevOpsSetup.organizationPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              handleContinue();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t('azureDevOpsSetup.organizationHintRequired')}
        </p>
      </div>

      <Card className="border border-muted bg-muted/30">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="flex-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground mb-2">
                {t('azureDevOpsSetup.patHelp')}
              </p>
              <ol className="space-y-1 list-decimal list-inside">
                <li>
                  <Button
                    variant="link"
                    onClick={handleOpenPatHelp}
                    className="text-info hover:text-info/80 p-0 h-auto"
                  >
                    {t('azureDevOpsSetup.createPatLink')}
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </li>
                <li>Select <code className="px-1 py-0.5 bg-muted rounded">Code</code> scope with Read & Write</li>
                <li>Set expiration (recommended: 90 days)</li>
                <li>Copy the generated token</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border border-destructive/30 bg-destructive/10">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-destructive whitespace-pre-line">{error}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={handleOpenAzureDevOps}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Azure DevOps
        </Button>
        <div className="flex gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              {t('common:cancel')}
            </Button>
          )}
          <Button onClick={handleContinue} disabled={!pat.trim() || !organization.trim()}>
            {t('common:continue')}
          </Button>
        </div>
      </div>
    </div>
  );
}
