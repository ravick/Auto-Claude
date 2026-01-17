import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  CheckCircle2,
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
  onSuccess: (pat: string, username?: string) => void;
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
  const [status, setStatus] = useState<'input' | 'validating' | 'success' | 'error'>('input');
  const [pat, setPat] = useState('');
  const [showPat, setShowPat] = useState(false);
  const [username, setUsername] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Ref to track if component is mounted
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleValidatePat = async () => {
    if (!pat.trim()) {
      setError(t('azureDevOpsSetup.patRequired'));
      return;
    }

    debugLog('Validating PAT...');
    setStatus('validating');
    setError(null);

    try {
      const result = await window.electronAPI.validateAzureDevOpsPat(pat.trim());

      if (!isMountedRef.current) return;

      debugLog('Validation result:', result);

      if (result.success && result.data?.valid) {
        setUsername(result.data.username);
        setStatus('success');
        // Notify parent after a short delay to show success state
        setTimeout(() => {
          if (isMountedRef.current) {
            onSuccess(pat.trim(), result.data?.username);
          }
        }, 500);
      } else {
        setError(t('azureDevOpsSetup.invalidPat'));
        setStatus('error');
      }
    } catch (err) {
      debugLog('Validation error:', err);
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Validation failed');
      setStatus('error');
    }
  };

  const handleOpenAzureDevOps = () => {
    window.open('https://dev.azure.com', '_blank');
  };

  const handleOpenPatHelp = () => {
    // Direct link to PAT creation in Azure DevOps
    window.open('https://dev.azure.com/_usersSettings/tokens', '_blank');
  };

  const handleRetry = () => {
    setStatus('input');
    setError(null);
  };

  return (
    <div className="space-y-4">
      {/* PAT Input */}
      {(status === 'input' || status === 'error') && (
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
                  if (e.key === 'Enter') {
                    handleValidatePat();
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
                    <p className="text-sm text-destructive">{error}</p>
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
              <Button onClick={handleValidatePat} disabled={!pat.trim()}>
                {t('common:continue')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Validating */}
      {status === 'validating' && (
        <Card className="border border-info/30 bg-info/10">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <Loader2 className="h-6 w-6 animate-spin text-info shrink-0" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-foreground">
                  Validating...
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Checking your Personal Access Token with Azure DevOps...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success */}
      {status === 'success' && (
        <Card className="border border-success/30 bg-success/10">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <CheckCircle2 className="h-6 w-6 text-success shrink-0 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-lg font-medium text-success">
                  Successfully Connected
                </h3>
                <p className="text-sm text-success/80 mt-1">
                  {username ? `Connected as ${username}` : 'Your Azure DevOps account is now connected'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
