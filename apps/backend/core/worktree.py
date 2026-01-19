#!/usr/bin/env python3
"""
Git Worktree Manager - Per-Spec Architecture
=============================================

Each spec gets its own worktree:
- Worktree path: .auto-claude/worktrees/tasks/{spec-name}/
- Branch name: auto-claude/{spec-name}

This allows:
1. Multiple specs to be worked on simultaneously
2. Each spec's changes are isolated
3. Branches persist until explicitly merged
4. Clear 1:1:1 mapping: spec → worktree → branch
"""

import asyncio
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TypedDict, TypeVar

from core.git_executable import get_git_executable, run_git
from debug import debug_warning
from urllib.parse import urlparse, urlunparse

T = TypeVar("T")


def _is_retryable_network_error(stderr: str) -> bool:
    """Check if an error is a retryable network/connection issue."""
    stderr_lower = stderr.lower()
    return any(
        term in stderr_lower
        for term in ["connection", "network", "timeout", "reset", "refused"]
    )


def _is_retryable_http_error(stderr: str) -> bool:
    """
    Check if an HTTP error is retryable (5xx errors, timeouts).
    Excludes auth errors (401, 403) and client errors (404, 422).
    """
    stderr_lower = stderr.lower()
    # Check for HTTP 5xx errors (server errors are retryable)
    if re.search(r"http[s]?\s*5\d{2}", stderr_lower):
        return True
    # Check for HTTP timeout patterns
    if "http" in stderr_lower and "timeout" in stderr_lower:
        return True
    return False


def _with_retry(
    operation: Callable[[], tuple[bool, T | None, str]],
    max_retries: int = 3,
    is_retryable: Callable[[str], bool] | None = None,
    on_retry: Callable[[int, str], None] | None = None,
) -> tuple[T | None, str]:
    """
    Execute an operation with retry logic.

    Args:
        operation: Function that returns a tuple of (success: bool, result: T | None, error: str).
                   On success (success=True), result contains the value and error is empty.
                   On failure (success=False), result is None and error contains the message.
        max_retries: Maximum number of retry attempts
        is_retryable: Function to check if error is retryable based on error message
        on_retry: Optional callback called before each retry with (attempt, error)

    Returns:
        Tuple of (result, last_error) where result is T on success, None on failure
    """
    last_error = ""

    for attempt in range(1, max_retries + 1):
        try:
            success, result, error = operation()
            if success:
                return result, ""

            last_error = error

            # Check if error is retryable
            if is_retryable and attempt < max_retries and is_retryable(error):
                if on_retry:
                    on_retry(attempt, error)
                backoff = 2 ** (attempt - 1)
                time.sleep(backoff)
                continue

            break

        except subprocess.TimeoutExpired:
            last_error = "Operation timed out"
            if attempt < max_retries:
                if on_retry:
                    on_retry(attempt, last_error)
                backoff = 2 ** (attempt - 1)
                time.sleep(backoff)
                continue
            break

    return None, last_error


class PushBranchResult(TypedDict, total=False):
    """Result of pushing a branch to remote."""

    success: bool
    branch: str
    remote: str
    error: str


class PullRequestResult(TypedDict, total=False):
    """Result of creating a pull request."""

    success: bool
    pr_url: str | None  # None when PR was created but URL couldn't be extracted
    already_exists: bool
    error: str
    message: str


class PushAndCreatePRResult(TypedDict, total=False):
    """Result of push_and_create_pr operation."""

    success: bool
    pushed: bool
    remote: str
    branch: str
    pr_url: str | None  # None when PR was created but URL couldn't be extracted
    already_exists: bool
    error: str
    message: str


class WorktreeError(Exception):
    """Error during worktree operations."""

    pass


@dataclass
class WorktreeInfo:
    """Information about a spec's worktree."""

    path: Path
    branch: str
    spec_name: str
    base_branch: str
    is_active: bool = True
    commit_count: int = 0
    files_changed: int = 0
    additions: int = 0
    deletions: int = 0
    last_commit_date: datetime | None = None
    days_since_last_commit: int | None = None


class WorktreeManager:
    """
    Manages per-spec Git worktrees.

    Each spec gets its own worktree in .auto-claude/worktrees/tasks/{spec-name}/ with
    a corresponding branch auto-claude/{spec-name}.
    """

    # Timeout constants for subprocess operations
    GIT_PUSH_TIMEOUT = 120  # 2 minutes for git push (network operations)
    GH_CLI_TIMEOUT = 60  # 1 minute for gh CLI commands
    GH_QUERY_TIMEOUT = 30  # 30 seconds for gh CLI queries

    def __init__(self, project_dir: Path, base_branch: str | None = None):
        self.project_dir = project_dir
        self.base_branch = base_branch or self._detect_base_branch()
        self.worktrees_dir = project_dir / ".auto-claude" / "worktrees" / "tasks"
        self._merge_lock = asyncio.Lock()

    def _read_env_file(self) -> dict[str, str]:
        """
        Read and parse the project's .env file.

        Returns:
            Dictionary of environment variables from .env file.
        """
        env_path = self.project_dir / ".auto-claude" / ".env"
        if not env_path.exists():
            return {}

        try:
            content = env_path.read_text(encoding="utf-8")
            env_vars: dict[str, str] = {}

            for line in content.split("\n"):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, value = line.partition("=")
                    key = key.strip()
                    value = value.strip()
                    # Remove quotes if present
                    if (value.startswith('"') and value.endswith('"')) or \
                       (value.startswith("'") and value.endswith("'")):
                        value = value[1:-1]
                    env_vars[key] = value

            return env_vars
        except (OSError, UnicodeDecodeError) as e:
            debug_warning("worktree", f"Could not read .env file: {e}")
            return {}

    def _get_azure_devops_pat(self) -> str | None:
        """
        Read Azure DevOps PAT from project's .env file.

        Returns:
            PAT string if found and Azure DevOps is enabled, None otherwise.
        """
        env_vars = self._read_env_file()

        # Check if Azure DevOps is enabled
        if env_vars.get("AZURE_DEVOPS_ENABLED", "").lower() != "true":
            return None

        return env_vars.get("AZURE_DEVOPS_PAT")

    def _get_default_branch_from_settings(self) -> str | None:
        """
        Read default branch from project's .env file.

        Returns:
            Default branch name (without 'origin/' prefix), or None if not set.
        """
        env_vars = self._read_env_file()
        default_branch = env_vars.get("DEFAULT_BRANCH", "")

        if default_branch:
            # Remove 'origin/' prefix if present (settings store as "origin/master")
            if default_branch.startswith("origin/"):
                default_branch = default_branch[7:]  # Remove "origin/"
            return default_branch

        return None

    def _get_authenticated_url(self, remote_url: str, pat: str) -> str | None:
        """
        Construct an authenticated URL for Azure DevOps by embedding the PAT.

        Args:
            remote_url: The original remote URL (HTTPS format)
            pat: Personal Access Token

        Returns:
            URL with embedded credentials, or None if URL cannot be modified.

        Example:
            https://dev.azure.com/org/project/_git/repo
            -> https://x:{PAT}@dev.azure.com/org/project/_git/repo
        """
        try:
            parsed = urlparse(remote_url)

            # Only handle HTTPS URLs
            if parsed.scheme != "https":
                return None

            # Check if it's an Azure DevOps URL
            if "dev.azure.com" not in parsed.netloc and "visualstudio.com" not in parsed.netloc:
                return None

            # Construct URL with credentials embedded
            # Use "x" as username (Azure DevOps ignores it, only uses PAT as password)
            netloc_with_auth = f"x:{pat}@{parsed.netloc}"
            authenticated_url = urlunparse((
                parsed.scheme,
                netloc_with_auth,
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment
            ))

            return authenticated_url
        except Exception as e:
            debug_warning("worktree", f"Could not construct authenticated URL: {e}")
            return None

    def _is_azure_devops_url(self, url: str) -> bool:
        """Check if a URL is an Azure DevOps URL."""
        return "dev.azure.com" in url or "visualstudio.com" in url

    def _parse_azure_devops_url(self, url: str) -> dict[str, str] | None:
        """
        Parse an Azure DevOps URL to extract organization, project, and repository.

        Supports formats:
        - https://dev.azure.com/{org}/{project}/_git/{repo}
        - https://{org}.visualstudio.com/{project}/_git/{repo}

        Returns:
            Dict with 'organization', 'project', 'repository' keys, or None if parsing fails.
        """
        try:
            parsed = urlparse(url)

            # Format: dev.azure.com/{org}/{project}/_git/{repo}
            if "dev.azure.com" in parsed.netloc:
                parts = parsed.path.strip("/").split("/")
                if len(parts) >= 4 and parts[2] == "_git":
                    return {
                        "organization": parts[0],
                        "project": parts[1],
                        "repository": parts[3],
                    }

            # Format: {org}.visualstudio.com/{project}/_git/{repo}
            if "visualstudio.com" in parsed.netloc:
                org = parsed.netloc.split(".")[0]
                parts = parsed.path.strip("/").split("/")
                if len(parts) >= 3 and parts[1] == "_git":
                    return {
                        "organization": org,
                        "project": parts[0],
                        "repository": parts[2],
                    }

            return None
        except Exception as e:
            debug_warning("worktree", f"Could not parse Azure DevOps URL: {e}")
            return None

    def _create_azure_devops_pr(
        self,
        remote_url: str,
        source_branch: str,
        target_branch: str,
        title: str,
        description: str,
        draft: bool = False,
    ) -> PullRequestResult:
        """
        Create a pull request in Azure DevOps using the REST API.

        Args:
            remote_url: Azure DevOps repository URL
            source_branch: Source branch name (without refs/heads/)
            target_branch: Target branch name (without refs/heads/)
            title: PR title
            description: PR description
            draft: Whether to create as draft PR

        Returns:
            PullRequestResult with success status and PR URL
        """
        import json
        import urllib.request
        import urllib.error
        import base64

        print(f"[CREATE_PR] Creating Azure DevOps PR via REST API")

        # Parse the remote URL
        ado_config = self._parse_azure_devops_url(remote_url)
        if not ado_config:
            return PullRequestResult(
                success=False,
                error=f"Could not parse Azure DevOps URL: {remote_url}",
            )

        org = ado_config["organization"]
        project = ado_config["project"]
        repo = ado_config["repository"]
        print(f"[CREATE_PR] Azure DevOps: org={org}, project={project}, repo={repo}")

        # Get PAT from settings
        pat = self._get_azure_devops_pat()
        if not pat:
            return PullRequestResult(
                success=False,
                error=(
                    "Azure DevOps PAT not configured.\n\n"
                    "Please configure your PAT in Project Settings > Integrations > Azure DevOps"
                ),
            )

        # Build API URL
        api_url = f"https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.1"
        print(f"[CREATE_PR] API URL: {api_url}")

        # Build request body
        source_ref = f"refs/heads/{source_branch}"
        target_ref = f"refs/heads/{target_branch}"
        print(f"[CREATE_PR] Source ref: {source_ref}")
        print(f"[CREATE_PR] Target ref: {target_ref}")

        body = {
            "sourceRefName": source_ref,
            "targetRefName": target_ref,
            "title": title,
            "description": description,
        }
        if draft:
            body["isDraft"] = True

        # Make API request
        try:
            # Create Basic auth header
            auth_string = base64.b64encode(f":{pat}".encode()).decode()

            req = urllib.request.Request(
                api_url,
                data=json.dumps(body).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Basic {auth_string}",
                },
                method="POST",
            )

            print(f"[CREATE_PR] Sending PR creation request...")
            with urllib.request.urlopen(req, timeout=60) as response:
                response_data = json.loads(response.read().decode("utf-8"))
                pr_id = response_data.get("pullRequestId")
                pr_url = f"https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{pr_id}"
                print(f"[CREATE_PR] PR created successfully: {pr_url}")
                return PullRequestResult(
                    success=True,
                    pr_url=pr_url,
                    already_exists=False,
                )

        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            print(f"[CREATE_PR] HTTP Error {e.code}: {error_body[:500]}")

            # Check for "already exists" error
            if e.code == 409 or "already exists" in error_body.lower() or "TF401179" in error_body:
                # Try to find existing PR URL
                existing_url = f"https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequests?_a=active&sourceRef={source_branch}"
                return PullRequestResult(
                    success=True,
                    pr_url=existing_url,
                    already_exists=True,
                    message="A pull request already exists for this branch",
                )

            # Branch not found error (TF401398)
            if e.code == 400 and ("TF401398" in error_body or "no longer exists" in error_body.lower()):
                return PullRequestResult(
                    success=False,
                    error=(
                        f"Target branch '{target_branch}' not found in Azure DevOps.\n\n"
                        f"The PR cannot be created because the target branch doesn't exist.\n"
                        f"Please check that the target branch name is correct.\n\n"
                        f"Common branch names: main, master, develop"
                    ),
                )

            # Authentication error
            if e.code == 401 or e.code == 403:
                return PullRequestResult(
                    success=False,
                    error=(
                        "Azure DevOps authentication failed.\n\n"
                        "Please check your PAT in Project Settings > Integrations > Azure DevOps.\n"
                        "Ensure the PAT has 'Code (Read & Write)' scope."
                    ),
                )

            return PullRequestResult(
                success=False,
                error=f"Azure DevOps API error ({e.code}): {error_body[:200]}",
            )

        except urllib.error.URLError as e:
            print(f"[CREATE_PR] URL Error: {e}")
            return PullRequestResult(
                success=False,
                error=f"Network error: {e.reason}",
            )

        except Exception as e:
            print(f"[CREATE_PR] Unexpected error: {e}")
            return PullRequestResult(
                success=False,
                error=f"Failed to create PR: {e}",
            )

    def _detect_base_branch(self) -> str:
        """
        Detect the base branch for worktree creation.

        Priority order:
        1. DEFAULT_BRANCH environment variable
        2. Auto-detect main/master (if they exist)
        3. Fall back to current branch (with warning)

        Returns:
            The detected base branch name
        """
        # 1. Check for DEFAULT_BRANCH env var
        env_branch = os.getenv("DEFAULT_BRANCH")
        if env_branch:
            # Verify the branch exists
            result = run_git(
                ["rev-parse", "--verify", env_branch],
                cwd=self.project_dir,
            )
            if result.returncode == 0:
                return env_branch
            else:
                print(
                    f"Warning: DEFAULT_BRANCH '{env_branch}' not found, auto-detecting..."
                )

        # 2. Auto-detect main/master
        for branch in ["main", "master"]:
            result = run_git(
                ["rev-parse", "--verify", branch],
                cwd=self.project_dir,
            )
            if result.returncode == 0:
                return branch

        # 3. Fall back to current branch with warning
        current = self._get_current_branch()
        print("Warning: Could not find 'main' or 'master' branch.")
        print(f"Warning: Using current branch '{current}' as base for worktree.")
        print("Tip: Set DEFAULT_BRANCH=your-branch in .env to avoid this.")
        return current

    def _get_current_branch(self) -> str:
        """Get the current git branch."""
        result = run_git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd=self.project_dir,
        )
        if result.returncode != 0:
            raise WorktreeError(f"Failed to get current branch: {result.stderr}")
        return result.stdout.strip()

    def _get_default_remote(self, cwd: Path | None = None) -> str:
        """
        Detect the default git remote name.

        Priority order:
        1. Remote for current branch (git config branch.<branch>.remote) - only if it's a name, not URL
        2. First available remote (git remote)
        3. Fall back to 'origin'

        Args:
            cwd: Optional working directory to detect remote from (defaults to project_dir)

        Returns:
            The detected remote name (not a URL)
        """
        git_dir = cwd or self.project_dir

        # 1. Try to get remote for current branch
        try:
            result = run_git(
                ["rev-parse", "--abbrev-ref", "HEAD"],
                cwd=git_dir,
            )
            if result.returncode == 0:
                current_branch = result.stdout.strip()
                result = run_git(
                    ["config", f"branch.{current_branch}.remote"],
                    cwd=git_dir,
                )
                if result.returncode == 0 and result.stdout.strip():
                    remote = result.stdout.strip()
                    # Make sure it's a remote name, not a URL
                    # URLs contain :// or start with git@
                    if "://" not in remote and not remote.startswith("git@"):
                        debug_warning("worktree", f"Detected remote from current branch: {remote}")
                        return remote
                    else:
                        debug_warning("worktree", f"Branch remote is a URL, skipping: {remote[:50]}...")
        except Exception as e:
            debug_warning("worktree", f"Could not get remote from current branch: {e}")

        # 2. Get first available remote
        result = run_git(["remote"], cwd=git_dir)
        if result.returncode == 0 and result.stdout.strip():
            remotes = result.stdout.strip().split('\n')
            if remotes:
                remote = remotes[0]
                debug_warning("worktree", f"Using first available remote: {remote}")
                return remote

        # 3. Fall back to 'origin'
        debug_warning("worktree", "No remote found, falling back to 'origin'")
        return "origin"

    def _run_git(
        self, args: list[str], cwd: Path | None = None, timeout: int = 60
    ) -> subprocess.CompletedProcess:
        """Run a git command and return the result.

        Args:
            args: Git command arguments (without 'git' prefix)
            cwd: Working directory for the command
            timeout: Command timeout in seconds (default: 60)

        Returns:
            CompletedProcess with command results. On timeout, returns a
            CompletedProcess with returncode=-1 and timeout error in stderr.
        """
        return run_git(args, cwd=cwd or self.project_dir, timeout=timeout)

    def _unstage_gitignored_files(self) -> None:
        """
        Unstage any staged files that are gitignored in the current branch,
        plus any files in the .auto-claude directory which should never be merged.

        This is needed after a --no-commit merge because files that exist in the
        source branch (like spec files in .auto-claude/specs/) get staged even if
        they're gitignored in the target branch.
        """
        # Get list of staged files
        result = self._run_git(["diff", "--cached", "--name-only"])
        if result.returncode != 0 or not result.stdout.strip():
            return

        staged_files = result.stdout.strip().split("\n")

        # Files to unstage: gitignored files + .auto-claude directory files
        files_to_unstage = set()

        # 1. Check which staged files are gitignored
        # git check-ignore returns the files that ARE ignored
        result = run_git(
            ["check-ignore", "--stdin"],
            cwd=self.project_dir,
            input_data="\n".join(staged_files),
        )

        if result.stdout.strip():
            for file in result.stdout.strip().split("\n"):
                if file.strip():
                    files_to_unstage.add(file.strip())

        # 2. Always unstage .auto-claude directory files - these are project-specific
        # and should never be merged from the worktree branch
        auto_claude_patterns = [".auto-claude/", "auto-claude/specs/"]
        for file in staged_files:
            file = file.strip()
            if not file:
                continue
            # Normalize path separators for cross-platform (Windows backslash support)
            normalized = file.replace("\\", "/")
            for pattern in auto_claude_patterns:
                if normalized.startswith(pattern) or f"/{pattern}" in normalized:
                    files_to_unstage.add(file)
                    break

        if files_to_unstage:
            print(
                f"Unstaging {len(files_to_unstage)} auto-claude/gitignored file(s)..."
            )
            # Unstage each file
            for file in files_to_unstage:
                self._run_git(["reset", "HEAD", "--", file])

    def setup(self) -> None:
        """Create worktrees directory if needed."""
        self.worktrees_dir.mkdir(parents=True, exist_ok=True)

    # ==================== Per-Spec Worktree Methods ====================

    def get_worktree_path(self, spec_name: str) -> Path:
        """Get the worktree path for a spec (checks new and legacy locations)."""
        # New path first (.auto-claude/worktrees/tasks/)
        new_path = self.worktrees_dir / spec_name
        if new_path.exists():
            return new_path

        # Legacy fallback (.worktrees/ instead of .auto-claude/worktrees/tasks/)
        legacy_path = self.project_dir / ".worktrees" / spec_name
        if legacy_path.exists():
            return legacy_path

        # Return new path as default for creation
        return new_path

    def get_branch_name(self, spec_name: str) -> str:
        """Get the branch name for a spec."""
        return f"auto-claude/{spec_name}"

    def worktree_exists(self, spec_name: str) -> bool:
        """Check if a worktree exists for a spec."""
        return self.get_worktree_path(spec_name).exists()

    def get_worktree_info(self, spec_name: str) -> WorktreeInfo | None:
        """Get info about a spec's worktree."""
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return None

        # Verify the branch exists in the worktree
        result = self._run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=worktree_path)
        if result.returncode != 0:
            return None

        actual_branch = result.stdout.strip()

        # Get statistics
        stats = self._get_worktree_stats(spec_name)

        return WorktreeInfo(
            path=worktree_path,
            branch=actual_branch,
            spec_name=spec_name,
            base_branch=self.base_branch,
            is_active=True,
            **stats,
        )

    def _check_branch_namespace_conflict(self) -> str | None:
        """
        Check if a branch named 'auto-claude' exists, which would block creating
        branches in the 'auto-claude/*' namespace.

        Git stores branch refs as files under .git/refs/heads/, so a branch named
        'auto-claude' creates a file that prevents creating the 'auto-claude/'
        directory needed for 'auto-claude/{spec-name}' branches.

        Returns:
            The conflicting branch name if found, None otherwise.
        """
        result = self._run_git(["rev-parse", "--verify", "auto-claude"])
        if result.returncode == 0:
            return "auto-claude"
        return None

    def _get_worktree_stats(self, spec_name: str) -> dict:
        """Get diff statistics for a worktree."""
        worktree_path = self.get_worktree_path(spec_name)

        stats = {
            "commit_count": 0,
            "files_changed": 0,
            "additions": 0,
            "deletions": 0,
            "last_commit_date": None,
            "days_since_last_commit": None,
        }

        if not worktree_path.exists():
            return stats

        # Commit count
        result = self._run_git(
            ["rev-list", "--count", f"{self.base_branch}..HEAD"], cwd=worktree_path
        )
        if result.returncode == 0:
            stats["commit_count"] = int(result.stdout.strip() or "0")

        # Last commit date (most recent commit in this worktree)
        result = self._run_git(
            ["log", "-1", "--format=%cd", "--date=iso"], cwd=worktree_path
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                # Parse ISO date format: "2026-01-04 00:25:25 +0100"
                date_str = result.stdout.strip()
                # Convert git format to ISO format for fromisoformat()
                # "2026-01-04 00:25:25 +0100" -> "2026-01-04T00:25:25+01:00"
                parts = date_str.rsplit(" ", 1)
                if len(parts) == 2:
                    date_part, tz_part = parts
                    # Convert timezone format: "+0100" -> "+01:00"
                    if len(tz_part) == 5 and (
                        tz_part.startswith("+") or tz_part.startswith("-")
                    ):
                        tz_formatted = f"{tz_part[:3]}:{tz_part[3:]}"
                        iso_str = f"{date_part.replace(' ', 'T')}{tz_formatted}"
                        last_commit_date = datetime.fromisoformat(iso_str)
                        stats["last_commit_date"] = last_commit_date
                        # Use timezone-aware now() for accurate comparison
                        now_aware = datetime.now(last_commit_date.tzinfo)
                        stats["days_since_last_commit"] = (
                            now_aware - last_commit_date
                        ).days
                    else:
                        # Fallback for unexpected timezone format
                        last_commit_date = datetime.strptime(
                            parts[0], "%Y-%m-%d %H:%M:%S"
                        )
                        stats["last_commit_date"] = last_commit_date
                        stats["days_since_last_commit"] = (
                            datetime.now() - last_commit_date
                        ).days
                else:
                    # No timezone in output
                    last_commit_date = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
                    stats["last_commit_date"] = last_commit_date
                    stats["days_since_last_commit"] = (
                        datetime.now() - last_commit_date
                    ).days
            except (ValueError, TypeError) as e:
                # If parsing fails, silently continue without date info
                pass

        # Diff stats
        result = self._run_git(
            ["diff", "--shortstat", f"{self.base_branch}...HEAD"], cwd=worktree_path
        )
        if result.returncode == 0 and result.stdout.strip():
            # Parse: "3 files changed, 50 insertions(+), 10 deletions(-)"
            match = re.search(r"(\d+) files? changed", result.stdout)
            if match:
                stats["files_changed"] = int(match.group(1))
            match = re.search(r"(\d+) insertions?", result.stdout)
            if match:
                stats["additions"] = int(match.group(1))
            match = re.search(r"(\d+) deletions?", result.stdout)
            if match:
                stats["deletions"] = int(match.group(1))

        return stats

    def create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Create a worktree for a spec.

        Args:
            spec_name: The spec folder name (e.g., "002-implement-memory")

        Returns:
            WorktreeInfo for the created worktree

        Raises:
            WorktreeError: If a branch namespace conflict exists or worktree creation fails
        """
        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        # Check for branch namespace conflict (e.g., 'auto-claude' blocking 'auto-claude/*')
        conflicting_branch = self._check_branch_namespace_conflict()
        if conflicting_branch:
            raise WorktreeError(
                f"Branch '{conflicting_branch}' exists and blocks creating '{branch_name}'.\n"
                f"\n"
                f"Git branch names work like file paths - a branch named 'auto-claude' prevents\n"
                f"creating branches under 'auto-claude/' (like 'auto-claude/{spec_name}').\n"
                f"\n"
                f"Fix: Rename the conflicting branch:\n"
                f"  git branch -m {conflicting_branch} {conflicting_branch}-backup"
            )

        # Remove existing if present (from crashed previous run)
        if worktree_path.exists():
            self._run_git(["worktree", "remove", "--force", str(worktree_path)])

        # Delete branch if it exists (from previous attempt)
        self._run_git(["branch", "-D", branch_name])

        # Detect the default remote (handles Azure DevOps, GitHub, etc.)
        remote = self._get_default_remote()

        # Fetch latest from remote to ensure we have the most up-to-date code
        # Remote is the source of truth, not the local branch
        fetch_result = self._run_git(["fetch", remote, self.base_branch])
        if fetch_result.returncode != 0:
            print(
                f"Warning: Could not fetch {self.base_branch} from {remote}: {fetch_result.stderr}"
            )
            print("Falling back to local branch...")

        # Determine the start point for the worktree
        # Prefer remote/{base_branch} over local branch to ensure we have latest code
        remote_ref = f"{remote}/{self.base_branch}"
        start_point = self.base_branch  # Default to local branch

        # Check if remote ref exists and use it as the source of truth
        check_remote = self._run_git(["rev-parse", "--verify", remote_ref])
        if check_remote.returncode == 0:
            start_point = remote_ref
            print(f"Creating worktree from remote: {remote_ref}")
        else:
            print(
                f"Remote ref {remote_ref} not found, using local branch: {self.base_branch}"
            )

        # Create worktree with new branch from the start point (remote preferred)
        result = self._run_git(
            ["worktree", "add", "-b", branch_name, str(worktree_path), start_point]
        )

        if result.returncode != 0:
            raise WorktreeError(
                f"Failed to create worktree for {spec_name}: {result.stderr}"
            )

        print(f"Created worktree: {worktree_path.name} on branch {branch_name}")

        return WorktreeInfo(
            path=worktree_path,
            branch=branch_name,
            spec_name=spec_name,
            base_branch=self.base_branch,
            is_active=True,
        )

    def get_or_create_worktree(self, spec_name: str) -> WorktreeInfo:
        """
        Get existing worktree or create a new one for a spec.

        Args:
            spec_name: The spec folder name

        Returns:
            WorktreeInfo for the worktree
        """
        existing = self.get_worktree_info(spec_name)
        if existing:
            print(f"Using existing worktree: {existing.path}")
            return existing

        return self.create_worktree(spec_name)

    def remove_worktree(self, spec_name: str, delete_branch: bool = False) -> None:
        """
        Remove a spec's worktree.

        Args:
            spec_name: The spec folder name
            delete_branch: Whether to also delete the branch
        """
        worktree_path = self.get_worktree_path(spec_name)
        branch_name = self.get_branch_name(spec_name)

        if worktree_path.exists():
            result = self._run_git(
                ["worktree", "remove", "--force", str(worktree_path)]
            )
            if result.returncode == 0:
                print(f"Removed worktree: {worktree_path.name}")
            else:
                print(f"Warning: Could not remove worktree: {result.stderr}")
                shutil.rmtree(worktree_path, ignore_errors=True)

        if delete_branch:
            self._run_git(["branch", "-D", branch_name])
            print(f"Deleted branch: {branch_name}")

        self._run_git(["worktree", "prune"])

    def merge_worktree(
        self, spec_name: str, delete_after: bool = False, no_commit: bool = False
    ) -> bool:
        """
        Merge a spec's worktree branch back to base branch.

        Args:
            spec_name: The spec folder name
            delete_after: Whether to remove worktree and branch after merge
            no_commit: If True, merge changes but don't commit (stage only for review)

        Returns:
            True if merge succeeded
        """
        info = self.get_worktree_info(spec_name)
        if not info:
            print(f"No worktree found for spec: {spec_name}")
            return False

        if no_commit:
            print(
                f"Merging {info.branch} into {self.base_branch} (staged, not committed)..."
            )
        else:
            print(f"Merging {info.branch} into {self.base_branch}...")

        # Switch to base branch in main project, but skip if already on it
        # This avoids triggering git hooks unnecessarily
        current_branch = self._get_current_branch()
        if current_branch != self.base_branch:
            result = self._run_git(["checkout", self.base_branch])
            if result.returncode != 0:
                # Check if this is a hook failure vs actual checkout failure
                # Hook failures still change the branch but return non-zero
                new_branch = self._get_current_branch()
                if new_branch == self.base_branch:
                    # Branch did change - likely a hook failure, continue with merge
                    stderr_msg = result.stderr[:100] if result.stderr else "<no stderr>"
                    debug_warning(
                        "worktree",
                        f"Checkout succeeded but hook returned non-zero: {stderr_msg}",
                    )
                else:
                    # Actual checkout failure
                    stderr_msg = result.stderr[:100] if result.stderr else "<no stderr>"
                    print(f"Error: Could not checkout base branch: {stderr_msg}")
                    return False

        # Merge the spec branch
        merge_args = ["merge", "--no-ff", info.branch]
        if no_commit:
            # --no-commit stages the merge but doesn't create the commit
            merge_args.append("--no-commit")
        else:
            merge_args.extend(["-m", f"auto-claude: Merge {info.branch}"])

        result = self._run_git(merge_args)

        if result.returncode != 0:
            # Check if it's "already up to date" - not an error
            output = (result.stdout + result.stderr).lower()
            if "already up to date" in output or "already up-to-date" in output:
                print(f"Branch {info.branch} is already up to date.")
                if no_commit:
                    print("No changes to stage.")
                if delete_after:
                    self.remove_worktree(spec_name, delete_branch=True)
                return True
            # Check for actual conflicts
            if "conflict" in output:
                print("Merge conflict! Aborting merge...")
                self._run_git(["merge", "--abort"])
                return False
            # Other error - show details
            stderr_msg = (
                result.stderr[:200]
                if result.stderr
                else result.stdout[:200]
                if result.stdout
                else "<no output>"
            )
            print(f"Merge failed: {stderr_msg}")
            self._run_git(["merge", "--abort"])
            return False

        if no_commit:
            # Unstage any files that are gitignored in the main branch
            # These get staged during merge because they exist in the worktree branch
            self._unstage_gitignored_files()
            print(
                f"Changes from {info.branch} are now staged in your working directory."
            )
            print("Review the changes, then commit when ready:")
            print("  git commit -m 'your commit message'")
        else:
            print(f"Successfully merged {info.branch}")

        if delete_after:
            self.remove_worktree(spec_name, delete_branch=True)

        return True

    def commit_in_worktree(self, spec_name: str, message: str) -> bool:
        """Commit all changes in a spec's worktree."""
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return False

        self._run_git(["add", "."], cwd=worktree_path)
        result = self._run_git(["commit", "-m", message], cwd=worktree_path)

        if result.returncode == 0:
            return True
        elif "nothing to commit" in result.stdout + result.stderr:
            return True
        else:
            print(f"Commit failed: {result.stderr}")
            return False

    # ==================== Listing & Discovery ====================

    def list_all_worktrees(self) -> list[WorktreeInfo]:
        """List all spec worktrees (includes legacy .worktrees/ location)."""
        worktrees = []
        seen_specs = set()

        # Check new location first
        if self.worktrees_dir.exists():
            for item in self.worktrees_dir.iterdir():
                if item.is_dir():
                    info = self.get_worktree_info(item.name)
                    if info:
                        worktrees.append(info)
                        seen_specs.add(item.name)

        # Check legacy location (.worktrees/)
        legacy_dir = self.project_dir / ".worktrees"
        if legacy_dir.exists():
            for item in legacy_dir.iterdir():
                if item.is_dir() and item.name not in seen_specs:
                    info = self.get_worktree_info(item.name)
                    if info:
                        worktrees.append(info)

        return worktrees

    def list_all_spec_branches(self) -> list[str]:
        """List all auto-claude branches (even if worktree removed)."""
        result = self._run_git(["branch", "--list", "auto-claude/*"])
        if result.returncode != 0:
            return []

        branches = []
        for line in result.stdout.strip().split("\n"):
            branch = line.strip().lstrip("* ")
            if branch:
                branches.append(branch)

        return branches

    def get_changed_files(self, spec_name: str) -> list[tuple[str, str]]:
        """Get list of changed files in a spec's worktree."""
        worktree_path = self.get_worktree_path(spec_name)
        if not worktree_path.exists():
            return []

        result = self._run_git(
            ["diff", "--name-status", f"{self.base_branch}...HEAD"], cwd=worktree_path
        )

        files = []
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split("\t", 1)
            if len(parts) == 2:
                files.append((parts[0], parts[1]))

        return files

    def get_change_summary(self, spec_name: str) -> dict:
        """Get a summary of changes in a worktree."""
        files = self.get_changed_files(spec_name)

        new_files = sum(1 for status, _ in files if status == "A")
        modified_files = sum(1 for status, _ in files if status == "M")
        deleted_files = sum(1 for status, _ in files if status == "D")

        return {
            "new_files": new_files,
            "modified_files": modified_files,
            "deleted_files": deleted_files,
        }

    def cleanup_all(self) -> None:
        """Remove all worktrees and their branches."""
        for worktree in self.list_all_worktrees():
            self.remove_worktree(worktree.spec_name, delete_branch=True)

    def cleanup_stale_worktrees(self) -> None:
        """Remove worktrees that aren't registered with git."""
        if not self.worktrees_dir.exists():
            return

        # Get list of registered worktrees
        result = self._run_git(["worktree", "list", "--porcelain"])
        registered_paths = set()
        for line in result.stdout.split("\n"):
            if line.startswith("worktree "):
                registered_paths.add(Path(line.split(" ", 1)[1]))

        # Remove unregistered directories
        for item in self.worktrees_dir.iterdir():
            if item.is_dir() and item not in registered_paths:
                print(f"Removing stale worktree directory: {item.name}")
                shutil.rmtree(item, ignore_errors=True)

        self._run_git(["worktree", "prune"])

    def get_test_commands(self, spec_name: str) -> list[str]:
        """Detect likely test/run commands for the project."""
        worktree_path = self.get_worktree_path(spec_name)
        commands = []

        if (worktree_path / "package.json").exists():
            commands.append("npm install && npm run dev")
            commands.append("npm test")

        if (worktree_path / "requirements.txt").exists():
            commands.append("pip install -r requirements.txt")

        if (worktree_path / "Cargo.toml").exists():
            commands.append("cargo run")
            commands.append("cargo test")

        if (worktree_path / "go.mod").exists():
            commands.append("go run .")
            commands.append("go test ./...")

        if not commands:
            commands.append("# Check the project's README for run instructions")

        return commands

    def has_uncommitted_changes(self, spec_name: str | None = None) -> bool:
        """Check if there are uncommitted changes."""
        cwd = None
        if spec_name:
            worktree_path = self.get_worktree_path(spec_name)
            if worktree_path.exists():
                cwd = worktree_path
        result = self._run_git(["status", "--porcelain"], cwd=cwd)
        return bool(result.stdout.strip())

    # ==================== PR Creation Methods ====================

    def push_branch(self, spec_name: str, force: bool = False) -> PushBranchResult:
        """
        Push a spec's branch to the remote with retry logic.

        Args:
            spec_name: The spec folder name
            force: Whether to force push (use with caution)

        Returns:
            PushBranchResult with keys:
                - success: bool
                - branch: str (branch name)
                - remote: str (if successful)
                - error: str (if failed)
        """
        print(f"[PUSH_BRANCH] Starting push_branch for spec: {spec_name}")
        info = self.get_worktree_info(spec_name)
        if not info:
            print(f"[PUSH_BRANCH] ERROR: No worktree found for spec: {spec_name}")
            return PushBranchResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        print(f"[PUSH_BRANCH] Worktree info: path={info.path}, branch={info.branch}")
        # Detect the default remote from the worktree directory (handles Azure DevOps, GitHub, etc.)
        remote = self._get_default_remote(cwd=info.path)
        print(f"Detected remote: {remote}")

        # Verify the remote exists before attempting push
        check_remote = self._run_git(["remote", "get-url", remote], cwd=info.path)
        if check_remote.returncode != 0:
            # Get list of available remotes for error message
            list_remotes = self._run_git(["remote"], cwd=info.path)
            available_remotes = list_remotes.stdout.strip().split('\n') if list_remotes.stdout.strip() else []

            if not available_remotes:
                return PushBranchResult(
                    success=False,
                    branch=info.branch,
                    error=(
                        f"No git remote configured for this repository.\n\n"
                        f"To push your changes, you need to add a remote first:\n"
                        f"  cd {self.project_dir}\n"
                        f"  git remote add origin <your-repository-url>\n\n"
                        f"For Azure DevOps:\n"
                        f"  git remote add origin https://dev.azure.com/<org>/<project>/_git/<repo>\n\n"
                        f"For GitHub:\n"
                        f"  git remote add origin https://github.com/<owner>/<repo>.git"
                    ),
                )
            else:
                return PushBranchResult(
                    success=False,
                    branch=info.branch,
                    error=(
                        f"Remote '{remote}' not found. Available remotes: {', '.join(available_remotes)}\n\n"
                        f"Add the missing remote with:\n"
                        f"  cd {self.project_dir}\n"
                        f"  git remote add {remote} <your-repository-url>"
                    ),
                )

        # Get remote URL
        remote_url_result = self._run_git(["remote", "get-url", remote], cwd=info.path)
        remote_url = remote_url_result.stdout.strip() if remote_url_result.returncode == 0 else "unknown"
        print(f"[PUSH_BRANCH] Remote URL: {remote_url}")

        # Check if this is Azure DevOps and handle authentication
        is_azure_devops = self._is_azure_devops_url(remote_url)
        push_url = remote_url  # URL to push to (may be modified with PAT)
        pat_configured = False

        if is_azure_devops:
            print(f"[PUSH_BRANCH] Azure DevOps detected, checking for PAT in settings...")
            pat = self._get_azure_devops_pat()
            if pat:
                authenticated_url = self._get_authenticated_url(remote_url, pat)
                if authenticated_url:
                    push_url = authenticated_url
                    pat_configured = True
                    # Don't log the URL with PAT for security
                    print(f"[PUSH_BRANCH] Using PAT from project settings for authentication")
                else:
                    print(f"[PUSH_BRANCH] WARNING: Could not construct authenticated URL")
            else:
                print(f"[PUSH_BRANCH] WARNING: No PAT found in project settings")
                return PushBranchResult(
                    success=False,
                    branch=info.branch,
                    error=(
                        "Azure DevOps PAT not configured.\n\n"
                        "Please configure your Azure DevOps Personal Access Token (PAT) in Project Settings:\n"
                        "1. Go to Project Settings > Integrations > Azure DevOps\n"
                        "2. Enter your PAT with 'Code (Read & Write)' scope\n"
                        "3. Save and retry the PR creation\n\n"
                        "To create a PAT:\n"
                        "1. Go to Azure DevOps > User Settings > Personal Access Tokens\n"
                        "2. Create a token with 'Code (Read & Write)' scope"
                    ),
                )

        # Push the branch - use authenticated URL for Azure DevOps, remote name for others
        if pat_configured:
            # For Azure DevOps with PAT, push directly to the authenticated URL
            # Don't use -u flag with URL as it confuses git's remote tracking
            push_args = ["push", push_url, f"HEAD:refs/heads/{info.branch}"]
        else:
            # For GitHub and others, use the remote name with -u for tracking
            push_args = ["push", "-u", remote, info.branch]

        if force:
            push_args.insert(1, "--force")

        # Log command (hide PAT in URL for security)
        if pat_configured:
            print(f"[PUSH_BRANCH] Push command: git push <authenticated-url> HEAD:refs/heads/{info.branch}")
        else:
            print(f"[PUSH_BRANCH] Push command: git {' '.join(push_args)}")
        print(f"[PUSH_BRANCH] Working directory: {info.path}")
        print(f"[PUSH_BRANCH] Push timeout: {self.GIT_PUSH_TIMEOUT}s")

        def do_push() -> tuple[bool, PushBranchResult | None, str]:
            """Execute push operation for retry wrapper."""
            try:
                git_executable = get_git_executable()
                print(f"[PUSH_BRANCH] Executing git push...")

                # Set GIT_TERMINAL_PROMPT=0 to prevent git from hanging if it needs credentials
                # This makes git fail fast with an error instead of waiting for user input
                env = os.environ.copy()
                env["GIT_TERMINAL_PROMPT"] = "0"
                # Also set GIT_ASKPASS to empty to prevent any GUI credential helpers
                env["GIT_ASKPASS"] = ""

                result = subprocess.run(
                    [git_executable] + push_args,
                    cwd=info.path,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.GIT_PUSH_TIMEOUT,
                    env=env,
                )
                print(f"[PUSH_BRANCH] Push completed with return code: {result.returncode}")
                # Don't log stdout/stderr if they might contain PAT
                if result.stdout and not pat_configured:
                    print(f"[PUSH_BRANCH] stdout: {result.stdout[:500]}")
                if result.stderr and not pat_configured:
                    print(f"[PUSH_BRANCH] stderr: {result.stderr[:500]}")
                elif result.returncode != 0:
                    # Log a sanitized version for Azure DevOps errors
                    sanitized_stderr = result.stderr.replace(pat, "***PAT***") if pat_configured and pat else result.stderr
                    print(f"[PUSH_BRANCH] stderr (sanitized): {sanitized_stderr[:500]}")

                if result.returncode == 0:
                    return (
                        True,
                        PushBranchResult(
                            success=True,
                            branch=info.branch,
                            remote=remote,
                        ),
                        "",
                    )

                # Check for authentication errors
                stderr_lower = result.stderr.lower()
                if "authentication" in stderr_lower or "terminal prompts disabled" in stderr_lower or "could not read" in stderr_lower or "401" in result.stderr:
                    if is_azure_devops:
                        auth_error = (
                            "Azure DevOps authentication failed.\n\n"
                            "The PAT in your project settings may be invalid or expired.\n"
                            "Please check:\n"
                            "1. Go to Project Settings > Integrations > Azure DevOps\n"
                            "2. Verify your PAT is correct and not expired\n"
                            "3. Ensure the PAT has 'Code (Read & Write)' scope"
                        )
                    else:
                        auth_error = (
                            f"Authentication failed for {remote_url}.\n\n"
                            "Please configure your git credentials."
                        )
                    return (False, None, auth_error)

                return (False, None, result.stderr)
            except FileNotFoundError:
                return (False, None, "git executable not found")

        max_retries = 3
        result, last_error = _with_retry(
            operation=do_push,
            max_retries=max_retries,
            is_retryable=_is_retryable_network_error,
        )

        if result:
            return result

        # Handle timeout error message
        if last_error == "Operation timed out":
            return PushBranchResult(
                success=False,
                branch=info.branch,
                error=f"Push timed out after {max_retries} attempts.",
            )

        return PushBranchResult(
            success=False,
            branch=info.branch,
            error=f"Failed to push branch: {last_error}",
        )

    def create_pull_request(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
    ) -> PullRequestResult:
        """
        Create a GitHub pull request for a spec's branch using gh CLI with retry logic.

        NOTE: This method currently only supports GitHub via gh CLI.
        Azure DevOps PRs should be created via the Azure DevOps REST API.

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for PR (defaults to base_branch)
            title: PR title (defaults to spec name)
            draft: Whether to create as draft PR

        Returns:
            PullRequestResult with keys:
                - success: bool
                - pr_url: str (if created)
                - already_exists: bool (if PR already exists)
                - error: str (if failed)
        """
        print(f"[CREATE_PR] Starting create_pull_request for spec: {spec_name}")
        info = self.get_worktree_info(spec_name)
        if not info:
            print(f"[CREATE_PR] ERROR: No worktree found for spec: {spec_name}")
            return PullRequestResult(
                success=False,
                error=f"No worktree found for spec: {spec_name}",
            )

        print(f"[CREATE_PR] Worktree info: path={info.path}, branch={info.branch}")

        # Determine target branch
        target = target_branch or self.base_branch
        print(f"[CREATE_PR] Initial target branch: {target}")

        # Check settings for default branch (especially important for Azure DevOps)
        settings_default = self._get_default_branch_from_settings()
        if settings_default:
            print(f"[CREATE_PR] Default branch from settings: {settings_default}")
            # For Azure DevOps, prefer settings default over passed target
            # This handles the case where worktree was created with wrong base branch
            if settings_default != target:
                print(f"[CREATE_PR] Overriding target with settings default: {settings_default}")
                target = settings_default

        pr_title = title or f"auto-claude: {spec_name}"
        print(f"[CREATE_PR] Target branch: {target}, Title: {pr_title}")

        # Get PR body from spec.md if available
        pr_body = self._extract_spec_summary(spec_name)
        print(f"[CREATE_PR] PR body length: {len(pr_body)} chars")

        # Check remote URL to determine if this is Azure DevOps or GitHub
        # Try worktree first, then fall back to main project directory
        remote = self._get_default_remote(cwd=info.path)
        remote_url_result = self._run_git(["remote", "get-url", remote], cwd=info.path)
        remote_url = remote_url_result.stdout.strip() if remote_url_result.returncode == 0 else ""

        # If no remote in worktree, try main project directory
        if not remote_url:
            print(f"[CREATE_PR] No remote in worktree, checking main project directory")
            remote = self._get_default_remote(cwd=self.project_dir)
            remote_url_result = self._run_git(["remote", "get-url", remote], cwd=self.project_dir)
            remote_url = remote_url_result.stdout.strip() if remote_url_result.returncode == 0 else ""

        print(f"[CREATE_PR] Remote URL: {remote_url}")

        # Check if this is Azure DevOps - use REST API instead of gh CLI
        is_azure_devops = self._is_azure_devops_url(remote_url)
        if is_azure_devops:
            print(f"[CREATE_PR] Azure DevOps detected, using REST API for PR creation")
            return self._create_azure_devops_pr(
                remote_url=remote_url,
                source_branch=info.branch,
                target_branch=target,
                title=pr_title,
                description=pr_body,
                draft=draft,
            )

        # Build gh pr create command (GitHub only)
        gh_args = [
            "gh",
            "pr",
            "create",
            "--base",
            target,
            "--head",
            info.branch,
            "--title",
            pr_title,
            "--body",
            pr_body,
        ]
        if draft:
            gh_args.append("--draft")

        print(f"[CREATE_PR] gh command: {' '.join(gh_args[:6])}...")  # Don't log full body
        print(f"[CREATE_PR] gh CLI timeout: {self.GH_CLI_TIMEOUT}s")

        def is_pr_retryable(stderr: str) -> bool:
            """Check if PR creation error is retryable (network or HTTP 5xx)."""
            return _is_retryable_network_error(stderr) or _is_retryable_http_error(
                stderr
            )

        def do_create_pr() -> tuple[bool, PullRequestResult | None, str]:
            """Execute PR creation for retry wrapper."""
            try:
                result = subprocess.run(
                    gh_args,
                    cwd=info.path,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.GH_CLI_TIMEOUT,
                )

                # Check for "already exists" case (success, no retry needed)
                if result.returncode != 0 and "already exists" in result.stderr.lower():
                    existing_url = self._get_existing_pr_url(spec_name, target)
                    result_dict = PullRequestResult(
                        success=True,
                        pr_url=existing_url,
                        already_exists=True,
                    )
                    if existing_url is None:
                        result_dict["message"] = (
                            "PR already exists but URL could not be retrieved"
                        )
                    return (True, result_dict, "")

                if result.returncode == 0:
                    # Extract PR URL from output
                    pr_url: str | None = result.stdout.strip()
                    if not pr_url.startswith("http"):
                        # Try to find URL in output
                        # Use general pattern to support GitHub Enterprise instances
                        # Matches any HTTPS URL with /pull/<number> path
                        match = re.search(r"https://[^\s]+/pull/\d+", result.stdout)
                        if match:
                            pr_url = match.group(0)
                        else:
                            # Invalid output - no valid URL found
                            pr_url = None

                    return (
                        True,
                        PullRequestResult(
                            success=True,
                            pr_url=pr_url,
                            already_exists=False,
                        ),
                        "",
                    )

                return (False, None, result.stderr)

            except FileNotFoundError:
                # gh CLI not installed - not retryable, raise to exit retry loop
                raise

        max_retries = 3
        try:
            result, last_error = _with_retry(
                operation=do_create_pr,
                max_retries=max_retries,
                is_retryable=is_pr_retryable,
            )

            if result:
                return result

            # Handle timeout error message
            if last_error == "Operation timed out":
                return PullRequestResult(
                    success=False,
                    error=f"PR creation timed out after {max_retries} attempts.",
                )

            return PullRequestResult(
                success=False,
                error=f"Failed to create PR: {last_error}",
            )

        except FileNotFoundError:
            # gh CLI not installed
            return PullRequestResult(
                success=False,
                error="gh CLI not found. Install from https://cli.github.com/",
            )

    def _extract_spec_summary(self, spec_name: str) -> str:
        """Extract a summary from spec.md for PR body."""
        worktree_path = self.get_worktree_path(spec_name)
        spec_path = worktree_path / ".auto-claude" / "specs" / spec_name / "spec.md"

        if not spec_path.exists():
            # Try project spec path
            spec_path = (
                self.project_dir / ".auto-claude" / "specs" / spec_name / "spec.md"
            )

        if not spec_path.exists():
            return "Auto-generated PR from Auto-Claude build."

        try:
            content = spec_path.read_text(encoding="utf-8")
            # Extract first few paragraphs (skip title, get overview)
            lines = content.split("\n")
            summary_lines = []
            in_content = False

            for line in lines:
                # Skip title headers
                if line.startswith("# "):
                    continue
                # Start capturing after first content line
                if line.strip() and not line.startswith("#"):
                    in_content = True
                if in_content:
                    if line.startswith("## ") and summary_lines:
                        break  # Stop at next section
                    summary_lines.append(line)
                    if len(summary_lines) >= 10:  # Limit to ~10 lines
                        break

            summary = "\n".join(summary_lines).strip()
            if summary:
                return summary
        except (OSError, UnicodeDecodeError) as e:
            # Silently fall back to default - file read errors shouldn't block PR creation
            debug_warning(
                "worktree", f"Could not extract spec summary for PR body: {e}"
            )

        return "Auto-generated PR from Auto-Claude build."

    def _get_existing_pr_url(self, spec_name: str, target_branch: str) -> str | None:
        """Get the URL of an existing PR for this branch."""
        info = self.get_worktree_info(spec_name)
        if not info:
            return None

        try:
            result = subprocess.run(
                ["gh", "pr", "view", info.branch, "--json", "url", "--jq", ".url"],
                cwd=info.path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.GH_QUERY_TIMEOUT,
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except (
            subprocess.TimeoutExpired,
            FileNotFoundError,
            subprocess.SubprocessError,
        ) as e:
            # Silently ignore errors when fetching existing PR URL - this is a best-effort
            # lookup that may fail due to network issues, missing gh CLI, or auth problems.
            # Returning None allows the caller to handle missing URLs gracefully.
            debug_warning("worktree", f"Could not get existing PR URL: {e}")

        return None

    def push_and_create_pr(
        self,
        spec_name: str,
        target_branch: str | None = None,
        title: str | None = None,
        draft: bool = False,
        force_push: bool = False,
    ) -> PushAndCreatePRResult:
        """
        Push branch and create a pull request in one operation.

        Args:
            spec_name: The spec folder name
            target_branch: Target branch for PR (defaults to base_branch)
            title: PR title (defaults to spec name)
            draft: Whether to create as draft PR
            force_push: Whether to force push the branch

        Returns:
            PushAndCreatePRResult with keys:
                - success: bool
                - pr_url: str (if created)
                - pushed: bool (if push succeeded)
                - already_exists: bool (if PR already exists)
                - error: str (if failed)
        """
        # Step 1: Push the branch
        push_result = self.push_branch(spec_name, force=force_push)
        if not push_result.get("success"):
            return PushAndCreatePRResult(
                success=False,
                pushed=False,
                error=push_result.get("error", "Push failed"),
            )

        # Step 2: Create the PR
        pr_result = self.create_pull_request(
            spec_name=spec_name,
            target_branch=target_branch,
            title=title,
            draft=draft,
        )

        # Combine results
        return PushAndCreatePRResult(
            success=pr_result.get("success", False),
            pushed=True,
            remote=push_result.get("remote"),
            branch=push_result.get("branch"),
            pr_url=pr_result.get("pr_url"),
            already_exists=pr_result.get("already_exists", False),
            error=pr_result.get("error"),
        )

    # ==================== Worktree Cleanup Methods ====================

    def get_old_worktrees(
        self, days_threshold: int = 30, include_stats: bool = False
    ) -> list[WorktreeInfo] | list[str]:
        """
        Find worktrees that haven't been modified in the specified number of days.

        Args:
            days_threshold: Number of days without activity to consider a worktree old (default: 30)
            include_stats: If True, return full WorktreeInfo objects; if False, return just spec names

        Returns:
            List of old worktrees (either WorktreeInfo objects or spec names based on include_stats)
        """
        old_worktrees = []

        for worktree_info in self.list_all_worktrees():
            # Skip if we can't determine age
            if worktree_info.days_since_last_commit is None:
                continue

            if worktree_info.days_since_last_commit >= days_threshold:
                if include_stats:
                    old_worktrees.append(worktree_info)
                else:
                    old_worktrees.append(worktree_info.spec_name)

        return old_worktrees

    def cleanup_old_worktrees(
        self, days_threshold: int = 30, dry_run: bool = False
    ) -> tuple[list[str], list[str]]:
        """
        Remove worktrees that haven't been modified in the specified number of days.

        Args:
            days_threshold: Number of days without activity to consider a worktree old (default: 30)
            dry_run: If True, only report what would be removed without actually removing

        Returns:
            Tuple of (removed_specs, failed_specs) containing spec names
        """
        old_worktrees = self.get_old_worktrees(
            days_threshold=days_threshold, include_stats=True
        )

        if not old_worktrees:
            print(f"No worktrees found older than {days_threshold} days.")
            return ([], [])

        removed = []
        failed = []

        if dry_run:
            print(f"\n[DRY RUN] Would remove {len(old_worktrees)} old worktrees:")
            for info in old_worktrees:
                print(
                    f"  - {info.spec_name} (last activity: {info.days_since_last_commit} days ago)"
                )
            return ([], [])

        print(f"\nRemoving {len(old_worktrees)} old worktrees...")
        for info in old_worktrees:
            try:
                self.remove_worktree(info.spec_name, delete_branch=True)
                removed.append(info.spec_name)
                print(
                    f"  ✓ Removed {info.spec_name} (last activity: {info.days_since_last_commit} days ago)"
                )
            except Exception as e:
                failed.append(info.spec_name)
                print(f"  ✗ Failed to remove {info.spec_name}: {e}")

        if removed:
            print(f"\nSuccessfully removed {len(removed)} worktree(s).")
        if failed:
            print(f"Failed to remove {len(failed)} worktree(s).")

        return (removed, failed)

    def get_worktree_count_warning(
        self, warning_threshold: int = 10, critical_threshold: int = 20
    ) -> str | None:
        """
        Check worktree count and return a warning message if threshold is exceeded.

        Args:
            warning_threshold: Number of worktrees to trigger a warning (default: 10)
            critical_threshold: Number of worktrees to trigger a critical warning (default: 20)

        Returns:
            Warning message string if threshold exceeded, None otherwise
        """
        worktrees = self.list_all_worktrees()
        count = len(worktrees)

        if count >= critical_threshold:
            old_worktrees = self.get_old_worktrees(days_threshold=30)
            old_count = len(old_worktrees)
            return (
                f"CRITICAL: {count} worktrees detected! "
                f"Consider cleaning up old worktrees ({old_count} are 30+ days old). "
                f"Run cleanup to remove stale worktrees."
            )
        elif count >= warning_threshold:
            old_worktrees = self.get_old_worktrees(days_threshold=30)
            old_count = len(old_worktrees)
            return (
                f"WARNING: {count} worktrees detected. "
                f"{old_count} are 30+ days old and may be safe to clean up."
            )

        return None

    def print_worktree_summary(self) -> None:
        """Print a summary of all worktrees with age information."""
        worktrees = self.list_all_worktrees()

        if not worktrees:
            print("No worktrees found.")
            return

        print(f"\n{'=' * 80}")
        print(f"Worktree Summary ({len(worktrees)} total)")
        print(f"{'=' * 80}\n")

        # Group by age
        recent = []  # < 7 days
        week_old = []  # 7-30 days
        month_old = []  # 30-90 days
        very_old = []  # > 90 days
        unknown_age = []

        for info in worktrees:
            if info.days_since_last_commit is None:
                unknown_age.append(info)
            elif info.days_since_last_commit < 7:
                recent.append(info)
            elif info.days_since_last_commit < 30:
                week_old.append(info)
            elif info.days_since_last_commit < 90:
                month_old.append(info)
            else:
                very_old.append(info)

        def print_group(title: str, items: list[WorktreeInfo]):
            if not items:
                return
            print(f"{title} ({len(items)}):")
            for info in sorted(items, key=lambda x: x.spec_name):
                age_str = (
                    f"{info.days_since_last_commit}d ago"
                    if info.days_since_last_commit is not None
                    else "unknown"
                )
                print(f"  - {info.spec_name} (last activity: {age_str})")
            print()

        print_group("Recent (< 7 days)", recent)
        print_group("Week Old (7-30 days)", week_old)
        print_group("Month Old (30-90 days)", month_old)
        print_group("Very Old (> 90 days)", very_old)
        print_group("Unknown Age", unknown_age)

        # Print cleanup suggestions
        if month_old or very_old:
            total_old = len(month_old) + len(very_old)
            print(f"{'=' * 80}")
            print(
                f"💡 Suggestion: {total_old} worktree(s) are 30+ days old and may be safe to clean up."
            )
            print("   Review these worktrees and run cleanup if no longer needed.")
            print(f"{'=' * 80}\n")
