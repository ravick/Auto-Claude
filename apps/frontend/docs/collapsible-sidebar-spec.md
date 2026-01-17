# Collapsible Sidebar Feature Specification

## Overview
Add a collapsible sidebar that shows only icons when collapsed, providing more screen real estate for the Kanban board and other views.

## User Experience

### Behavior
- **Expanded state**: Full sidebar with icons, labels, keyboard shortcuts (256px / `w-64`)
- **Collapsed state**: Icons only with tooltips on hover (64px / `w-16`)
- **Toggle methods**:
  - Click toggle button in sidebar header
  - Keyboard shortcut: `Cmd+B` (Mac) / `Ctrl+B` (Windows/Linux)
- **Persistence**: State saved to settings, restored on app restart

### Visual Changes When Collapsed

| Element | Expanded | Collapsed |
|---------|----------|-----------|
| Sidebar width | 256px (`w-64`) | 64px (`w-16`) |
| "Auto Claude" heading | Visible | Hidden |
| Toggle button | Right of heading | Centered |
| "PROJECT" section label | Visible | Hidden |
| Navigation items | Icon + label + shortcut | Icon only (tooltip on hover) |
| ClaudeCodeStatusBadge | Visible | Hidden |
| Settings button | Icon + "Settings" text | Icon only (tooltip) |
| Help button | Icon | Icon (tooltip on right) |
| New Task button | "+ New Task" | Plus icon only (tooltip) |
| "Initialize..." message | Visible | Hidden |

## Implementation Details

### 1. Settings Type (`apps/frontend/src/shared/types/settings.ts`)

Add to `AppSettings` interface after line 285:

```typescript
// Sidebar collapsed state for compact view
sidebarCollapsed?: boolean;
```

### 2. Default Config (`apps/frontend/src/shared/constants/config.ts`)

Add to `DEFAULT_APP_SETTINGS`:

```typescript
sidebarCollapsed: false,
```

### 3. i18n Translations

**English** (`apps/frontend/src/shared/i18n/locales/en/navigation.json`):
```json
{
  "sidebar": {
    "collapse": "Collapse sidebar",
    "expand": "Expand sidebar"
  }
}
```

**French** (`apps/frontend/src/shared/i18n/locales/fr/navigation.json`):
```json
{
  "sidebar": {
    "collapse": "Reduire la barre laterale",
    "expand": "Developper la barre laterale"
  }
}
```

### 4. Sidebar Component (`apps/frontend/src/renderer/components/Sidebar.tsx`)

#### A. Add Imports (line 3-25)

Add to lucide-react imports:
```typescript
PanelLeftClose,
PanelLeft,
```

#### B. Add Collapsed State (after line 113)

```typescript
const isCollapsed = settings.sidebarCollapsed ?? false;
const updateSettings = useSettingsStore((state) => state.updateSettings);

const toggleSidebar = async () => {
  const newState = !isCollapsed;
  updateSettings({ sidebarCollapsed: newState });
  await window.electronAPI.saveSettings({ sidebarCollapsed: newState });
};
```

#### C. Update Main Container (line 311)

Replace:
```tsx
<div className="flex h-full w-64 flex-col bg-sidebar border-r border-border">
```

With:
```tsx
<div className={cn(
  "flex h-full flex-col bg-sidebar border-r border-border",
  "transition-all duration-300 ease-in-out",
  isCollapsed ? "w-16" : "w-64"
)}>
```

#### D. Update Header Section (lines 312-315)

Replace:
```tsx
<div className="electron-drag flex h-14 items-center px-4 pt-6">
  <span className="electron-no-drag text-lg font-bold text-primary">Auto Claude</span>
</div>
```

With:
```tsx
<div className={cn(
  "electron-drag flex h-14 items-center pt-6",
  isCollapsed ? "justify-center px-2" : "px-4"
)}>
  {!isCollapsed && (
    <span className="electron-no-drag text-lg font-bold text-primary">Auto Claude</span>
  )}
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "electron-no-drag h-8 w-8 shrink-0",
          isCollapsed ? "" : "ml-auto"
        )}
        onClick={toggleSidebar}
        aria-label={isCollapsed ? t('navigation:sidebar.expand') : t('navigation:sidebar.collapse')}
      >
        {isCollapsed ? (
          <PanelLeft className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="right">
      {isCollapsed ? t('navigation:sidebar.expand') : t('navigation:sidebar.collapse')}
      <kbd className="ml-2 text-xs opacity-60">
        {navigator.platform.includes('Mac') ? '⌘B' : 'Ctrl+B'}
      </kbd>
    </TooltipContent>
  </Tooltip>
</div>
```

#### E. Update PROJECT Section Heading (lines 326-329)

Replace:
```tsx
<h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
  {t('sections.project')}
</h3>
```

With:
```tsx
{!isCollapsed && (
  <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
    {t('sections.project')}
  </h3>
)}
```

#### F. Update Navigation Padding (line 324)

Replace:
```tsx
<div className="px-3 py-4">
```

With:
```tsx
<div className={cn("py-4", isCollapsed ? "px-2" : "px-3")}>
```

#### G. Update `renderNavItem` Function (lines 281-307)

Replace entire function:
```tsx
const renderNavItem = (item: NavItem) => {
  const isActive = activeView === item.id;
  const Icon = item.icon;

  const button = (
    <button
      key={item.id}
      onClick={() => handleNavClick(item.id)}
      disabled={!selectedProjectId}
      aria-keyshortcuts={item.shortcut}
      className={cn(
        'flex w-full items-center rounded-lg text-sm transition-all duration-200',
        'hover:bg-accent hover:text-accent-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        isActive && 'bg-accent text-accent-foreground',
        isCollapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!isCollapsed && (
        <>
          <span className="flex-1 text-left">{t(item.labelKey)}</span>
          {item.shortcut && (
            <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded-md border border-border bg-secondary px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:flex">
              {item.shortcut}
            </kbd>
          )}
        </>
      )}
    </button>
  );

  // Wrap in tooltip when collapsed
  if (isCollapsed) {
    return (
      <Tooltip key={item.id}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {t(item.labelKey)}
          {item.shortcut && (
            <kbd className="rounded border border-border bg-secondary px-1 font-mono text-[10px]">
              {item.shortcut}
            </kbd>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
};
```

#### H. Update Bottom Section (lines 342-392)

Replace:
```tsx
{/* Bottom section with Settings, Help, and New Task */}
<div className="p-4 space-y-3">
  {/* Claude Code Status Badge */}
  <ClaudeCodeStatusBadge />

  {/* Settings and Help row */}
  <div className="flex items-center gap-2">
```

With:
```tsx
{/* Bottom section with Settings, Help, and New Task */}
<div className={cn("p-4 space-y-3", isCollapsed && "px-2")}>
  {/* Claude Code Status Badge - hide when collapsed */}
  {!isCollapsed && <ClaudeCodeStatusBadge />}

  {/* Settings and Help row */}
  <div className={cn("flex items-center", isCollapsed ? "flex-col gap-2" : "gap-2")}>
```

Update Settings button (lines 349-362):
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size={isCollapsed ? "icon" : "sm"}
      className={cn(
        isCollapsed ? "w-full justify-center" : "flex-1 justify-start gap-2"
      )}
      onClick={onSettingsClick}
    >
      <Settings className="h-4 w-4" />
      {!isCollapsed && t('actions.settings')}
    </Button>
  </TooltipTrigger>
  <TooltipContent side={isCollapsed ? "right" : "top"}>
    {t('tooltips.settings')}
  </TooltipContent>
</Tooltip>
```

Update Help button (lines 363-375):
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size="icon"
      className={isCollapsed ? "w-full" : ""}
      onClick={() => window.open('https://github.com/AndyMik90/Auto-Claude/issues', '_blank')}
      aria-label={t('tooltips.help')}
    >
      <HelpCircle className="h-4 w-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent side={isCollapsed ? "right" : "top"}>
    {t('tooltips.help')}
  </TooltipContent>
</Tooltip>
```

Update New Task button (lines 378-386):
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      className={cn("w-full", isCollapsed && "px-0")}
      onClick={onNewTaskClick}
      disabled={!selectedProjectId || !selectedProject?.autoBuildPath}
      size={isCollapsed ? "icon" : "default"}
    >
      <Plus className={isCollapsed ? "h-4 w-4" : "mr-2 h-4 w-4"} />
      {!isCollapsed && t('actions.newTask')}
    </Button>
  </TooltipTrigger>
  {isCollapsed && (
    <TooltipContent side="right">
      {t('actions.newTask')}
    </TooltipContent>
  )}
</Tooltip>
```

Update initialize message (lines 387-391):
```tsx
{!isCollapsed && selectedProject && !selectedProject.autoBuildPath && (
  <p className="mt-2 text-xs text-muted-foreground text-center">
    {t('messages.initializeToCreateTasks')}
  </p>
)}
```

### 5. App Keyboard Shortcut (`apps/frontend/src/renderer/App.tsx`)

Add import at top:
```typescript
import { useSettingsStore, loadSettings, loadProfiles, saveSettings } from './stores/settings-store';
```

Add useEffect for keyboard shortcut (around line 327, after other useEffects):
```typescript
// Global keyboard shortcut: Cmd/Ctrl+B to toggle sidebar
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Skip if in input fields
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target as HTMLElement)?.isContentEditable
    ) {
      return;
    }

    // Cmd/Ctrl+B: Toggle sidebar
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      const currentState = useSettingsStore.getState().settings.sidebarCollapsed ?? false;
      const newState = !currentState;
      useSettingsStore.getState().updateSettings({ sidebarCollapsed: newState });
      saveSettings({ sidebarCollapsed: newState });
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

## Testing Checklist

- [ ] Toggle button works in expanded state (collapses sidebar)
- [ ] Toggle button works in collapsed state (expands sidebar)
- [ ] `Cmd+B` / `Ctrl+B` toggles sidebar
- [ ] Keyboard shortcut doesn't trigger when typing in inputs
- [ ] Tooltips appear on hover for all nav items when collapsed
- [ ] Tooltips appear for Settings, Help, New Task buttons when collapsed
- [ ] State persists after app restart
- [ ] Smooth transition animation (300ms)
- [ ] Works in light theme
- [ ] Works in dark theme
- [ ] All color themes render correctly when collapsed
- [ ] RateLimitIndicator still visible when collapsed (it's icon-based)
- [ ] Navigation keyboard shortcuts (K, A, N, etc.) still work when collapsed

## Animation Details

- **Property**: `transition-all`
- **Duration**: 300ms
- **Easing**: `ease-in-out`
- **Affected properties**: width, padding

## Accessibility

- Toggle button has `aria-label` based on current state
- Tooltips provide context for icon-only buttons
- Navigation shortcuts remain functional
- `aria-keyshortcuts` attribute preserved on nav items
