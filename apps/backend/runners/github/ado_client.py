"""
Azure DevOps REST API Client
=============================

HTTP client for Azure DevOps REST API with timeout, retry logic, and rate limiting.
Uses aiohttp for async HTTP requests.

API Documentation: https://learn.microsoft.com/en-us/rest/api/azure/devops/
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

try:
    import aiohttp
except ImportError:
    aiohttp = None  # type: ignore

try:
    from .rate_limiter import RateLimiter, RateLimitExceeded
except (ImportError, ValueError, SystemError):
    from rate_limiter import RateLimiter, RateLimitExceeded

# Configure logger
logger = logging.getLogger(__name__)


class ADOTimeoutError(Exception):
    """Raised when Azure DevOps API request times out after all retry attempts."""

    pass


class ADORequestError(Exception):
    """Raised when Azure DevOps API request fails."""

    pass


class ADORateLimitError(Exception):
    """Raised when Azure DevOps API rate limit is exceeded."""

    pass


class ADOAuthenticationError(Exception):
    """Raised when authentication fails (invalid PAT)."""

    pass


@dataclass
class ADOConfig:
    """Configuration for Azure DevOps API client."""

    organization: str  # Azure DevOps organization name
    project: str  # Project name within organization
    pat: str  # Personal Access Token
    base_url: str = "https://dev.azure.com"
    api_version: str = "7.2"


@dataclass
class ADOResponse:
    """Result of an Azure DevOps API request."""

    data: Any
    status_code: int
    headers: dict[str, str]
    url: str
    attempts: int
    total_time: float


@dataclass
class WorkItemQueryResult:
    """Result of a WIQL query."""

    work_items: list[dict[str, Any]]
    as_of: datetime | None = None


class ADOClient:
    """
    Async client for Azure DevOps REST API with timeout and retry protection.

    Usage:
        config = ADOConfig(
            organization="myorg",
            project="MyProject",
            pat="xxxx"
        )
        client = ADOClient(config)

        # Get work items
        items = await client.get_work_items([1, 2, 3])

        # List PRs
        prs = await client.list_pull_requests(repository="MyRepo")

        # Post PR comment
        await client.post_pr_thread(repository="MyRepo", pr_id=123, content="LGTM!")
    """

    def __init__(
        self,
        config: ADOConfig,
        default_timeout: float = 30.0,
        max_retries: int = 3,
        enable_rate_limiting: bool = True,
    ):
        """
        Initialize Azure DevOps API client.

        Args:
            config: Azure DevOps configuration
            default_timeout: Default timeout in seconds for requests
            max_retries: Maximum number of retry attempts
            enable_rate_limiting: Whether to enforce rate limiting
        """
        if aiohttp is None:
            raise ImportError("aiohttp is required for ADOClient. Install with: pip install aiohttp")

        self.config = config
        self.default_timeout = default_timeout
        self.max_retries = max_retries
        self.enable_rate_limiting = enable_rate_limiting

        # Build auth header
        auth_str = f":{config.pat}"
        self._auth_header = f"Basic {base64.b64encode(auth_str.encode()).decode()}"

        # Initialize rate limiter
        if enable_rate_limiting:
            self._rate_limiter = RateLimiter.get_instance()

        # Session will be created lazily
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={
                    "Authorization": self._auth_header,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                }
            )
        return self._session

    async def close(self) -> None:
        """Close the HTTP session."""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    def _build_url(
        self,
        endpoint: str,
        area: str = "wit",
        use_project: bool = True,
    ) -> str:
        """
        Build full API URL.

        Args:
            endpoint: API endpoint path (e.g., "/workitems/123")
            area: API area (wit, git, work, etc.)
            use_project: Whether to include project in URL

        Returns:
            Full URL with API version
        """
        base = self.config.base_url
        org = self.config.organization
        project = self.config.project

        if use_project:
            url = f"{base}/{org}/{project}/_apis/{area}{endpoint}"
        else:
            url = f"{base}/{org}/_apis/{area}{endpoint}"

        # Add API version
        separator = "&" if "?" in url else "?"
        url = f"{url}{separator}api-version={self.config.api_version}"

        return url

    async def _request(
        self,
        method: str,
        url: str,
        timeout: float | None = None,
        json_data: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> ADOResponse:
        """
        Make HTTP request with retry and timeout logic.

        Args:
            method: HTTP method (GET, POST, PATCH, etc.)
            url: Full URL
            timeout: Request timeout in seconds
            json_data: JSON body for POST/PATCH
            params: Query parameters

        Returns:
            ADOResponse with response data

        Raises:
            ADOTimeoutError: If request times out after all retries
            ADORequestError: If request fails
            ADOAuthenticationError: If authentication fails
            ADORateLimitError: If rate limited
        """
        timeout = timeout or self.default_timeout
        start_time = asyncio.get_event_loop().time()

        # Rate limit check
        if self.enable_rate_limiting:
            # Use GitHub rate limiter for now (ADO has similar limits)
            available, msg = self._rate_limiter.check_github_available()
            if not available:
                logger.info(f"Rate limited, waiting: {msg}")
                if not await self._rate_limiter.acquire_github(timeout=30.0):
                    raise ADORateLimitError(f"Azure DevOps rate limit exceeded: {msg}")
            else:
                await self._rate_limiter.acquire_github(timeout=1.0)

        session = await self._get_session()

        for attempt in range(1, self.max_retries + 1):
            try:
                logger.debug(
                    f"ADO API request (attempt {attempt}/{self.max_retries}): {method} {url}"
                )

                async with asyncio.timeout(timeout):
                    async with session.request(
                        method,
                        url,
                        json=json_data,
                        params=params,
                    ) as response:
                        total_time = asyncio.get_event_loop().time() - start_time
                        headers = dict(response.headers)

                        # Handle different status codes
                        if response.status == 401:
                            raise ADOAuthenticationError(
                                "Authentication failed. Check your Personal Access Token (PAT)."
                            )

                        if response.status == 403:
                            error_text = await response.text()
                            raise ADOAuthenticationError(
                                f"Access forbidden. Check PAT permissions: {error_text}"
                            )

                        if response.status == 429:
                            if self.enable_rate_limiting:
                                self._rate_limiter.record_github_error()
                            raise ADORateLimitError(
                                "Azure DevOps API rate limit exceeded (HTTP 429)"
                            )

                        if response.status >= 400:
                            error_text = await response.text()
                            raise ADORequestError(
                                f"Azure DevOps API error ({response.status}): {error_text}"
                            )

                        # Parse JSON response
                        try:
                            data = await response.json()
                        except Exception:
                            data = await response.text()

                        logger.debug(
                            f"ADO API request completed "
                            f"(attempt {attempt}, {total_time:.2f}s)"
                        )

                        return ADOResponse(
                            data=data,
                            status_code=response.status,
                            headers=headers,
                            url=url,
                            attempts=attempt,
                            total_time=total_time,
                        )

            except asyncio.TimeoutError:
                backoff_delay = 2 ** (attempt - 1)
                logger.warning(
                    f"ADO API request timed out after {timeout}s "
                    f"(attempt {attempt}/{self.max_retries})"
                )

                if attempt < self.max_retries:
                    logger.info(f"Retrying in {backoff_delay}s...")
                    await asyncio.sleep(backoff_delay)
                    continue
                else:
                    total_time = asyncio.get_event_loop().time() - start_time
                    raise ADOTimeoutError(
                        f"Azure DevOps API request timed out after {self.max_retries} attempts "
                        f"({timeout}s each, {total_time:.1f}s total)"
                    )

            except (ADOAuthenticationError, ADORateLimitError, ADORequestError):
                raise

            except Exception as e:
                logger.error(f"Unexpected error in ADO API request: {e}")
                if attempt == self.max_retries:
                    raise ADORequestError(f"Azure DevOps API request failed: {str(e)}")
                else:
                    backoff_delay = 2 ** (attempt - 1)
                    logger.info(f"Retrying in {backoff_delay}s after error...")
                    await asyncio.sleep(backoff_delay)
                    continue

        raise ADORequestError(f"Azure DevOps API request failed after {self.max_retries} attempts")

    # =========================================================================
    # Work Item Operations
    # =========================================================================

    async def wiql_query(
        self,
        query: str,
        top: int = 200,
    ) -> WorkItemQueryResult:
        """
        Execute a WIQL (Work Item Query Language) query.

        Args:
            query: WIQL query string
            top: Maximum number of results

        Returns:
            WorkItemQueryResult with work item references

        Example:
            result = await client.wiql_query(
                "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'"
            )
        """
        url = self._build_url("/wiql", area="wit")
        response = await self._request(
            "POST",
            url,
            json_data={"query": query},
            params={"$top": str(top)},
        )

        data = response.data
        work_items = data.get("workItems", [])
        as_of_str = data.get("asOf")
        as_of = None
        if as_of_str:
            try:
                as_of = datetime.fromisoformat(as_of_str.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                pass

        return WorkItemQueryResult(work_items=work_items, as_of=as_of)

    async def get_work_item(
        self,
        work_item_id: int,
        fields: list[str] | None = None,
        expand: str | None = None,
    ) -> dict[str, Any]:
        """
        Get a single work item by ID.

        Args:
            work_item_id: Work item ID
            fields: Optional list of fields to include
            expand: Expansion options (Relations, Fields, Links, All)

        Returns:
            Work item data dictionary
        """
        endpoint = f"/workitems/{work_item_id}"
        params: dict[str, str] = {}

        if fields:
            params["fields"] = ",".join(fields)
        if expand:
            params["$expand"] = expand

        url = self._build_url(endpoint, area="wit")
        response = await self._request("GET", url, params=params if params else None)
        return response.data

    async def get_work_items(
        self,
        work_item_ids: list[int],
        fields: list[str] | None = None,
        expand: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Get multiple work items by IDs.

        Args:
            work_item_ids: List of work item IDs (max 200)
            fields: Optional list of fields to include
            expand: Expansion options

        Returns:
            List of work item data dictionaries
        """
        if not work_item_ids:
            return []

        # ADO limits to 200 IDs per request
        ids_str = ",".join(str(id) for id in work_item_ids[:200])
        endpoint = f"/workitems?ids={ids_str}"
        params: dict[str, str] = {}

        if fields:
            params["fields"] = ",".join(fields)
        if expand:
            params["$expand"] = expand

        url = self._build_url(endpoint, area="wit")
        response = await self._request("GET", url, params=params if params else None)
        return response.data.get("value", [])

    async def list_work_items(
        self,
        state: str | None = None,
        work_item_type: str | None = None,
        assigned_to: str | None = None,
        top: int = 200,
    ) -> list[dict[str, Any]]:
        """
        List work items with filters using WIQL.

        Args:
            state: Filter by state (e.g., "Active", "New", "Closed")
            work_item_type: Filter by type (e.g., "Bug", "Task", "User Story")
            assigned_to: Filter by assignee
            top: Maximum number of results

        Returns:
            List of work item data dictionaries with full details
        """
        # Build WIQL query
        conditions = ["[System.TeamProject] = @project"]

        if state:
            conditions.append(f"[System.State] = '{state}'")
        if work_item_type:
            conditions.append(f"[System.WorkItemType] = '{work_item_type}'")
        if assigned_to:
            conditions.append(f"[System.AssignedTo] = '{assigned_to}'")

        where_clause = " AND ".join(conditions)
        query = f"SELECT [System.Id] FROM WorkItems WHERE {where_clause} ORDER BY [System.ChangedDate] DESC"

        # Get IDs from WIQL
        result = await self.wiql_query(query, top=top)
        work_item_ids = [item["id"] for item in result.work_items]

        if not work_item_ids:
            return []

        # Get full work item details
        return await self.get_work_items(work_item_ids)

    # =========================================================================
    # Pull Request Operations
    # =========================================================================

    async def list_pull_requests(
        self,
        repository: str,
        status: str = "active",
        target_branch: str | None = None,
        source_branch: str | None = None,
        creator_id: str | None = None,
        top: int = 100,
    ) -> list[dict[str, Any]]:
        """
        List pull requests for a repository.

        Args:
            repository: Repository name
            status: Filter by status (active, abandoned, completed, all)
            target_branch: Filter by target branch
            source_branch: Filter by source branch
            creator_id: Filter by creator
            top: Maximum number of results

        Returns:
            List of pull request data
        """
        endpoint = f"/repositories/{repository}/pullrequests"
        params: dict[str, str] = {
            "$top": str(top),
        }

        if status and status != "all":
            params["searchCriteria.status"] = status
        if target_branch:
            params["searchCriteria.targetRefName"] = f"refs/heads/{target_branch}"
        if source_branch:
            params["searchCriteria.sourceRefName"] = f"refs/heads/{source_branch}"
        if creator_id:
            params["searchCriteria.creatorId"] = creator_id

        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url, params=params)
        return response.data.get("value", [])

    async def get_pull_request(
        self,
        repository: str,
        pr_id: int,
    ) -> dict[str, Any]:
        """
        Get a single pull request by ID.

        Args:
            repository: Repository name
            pr_id: Pull request ID

        Returns:
            Pull request data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data

    async def get_pr_iterations(
        self,
        repository: str,
        pr_id: int,
    ) -> list[dict[str, Any]]:
        """
        Get pull request iterations (each push creates an iteration).

        Args:
            repository: Repository name
            pr_id: Pull request ID

        Returns:
            List of iteration data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}/iterations"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data.get("value", [])

    async def get_pr_changes(
        self,
        repository: str,
        pr_id: int,
        iteration_id: int | None = None,
    ) -> dict[str, Any]:
        """
        Get changes (file modifications) for a pull request.

        Args:
            repository: Repository name
            pr_id: Pull request ID
            iteration_id: Optional iteration ID (latest if not specified)

        Returns:
            Changes data including modified files
        """
        if iteration_id is None:
            # Get latest iteration
            iterations = await self.get_pr_iterations(repository, pr_id)
            if iterations:
                iteration_id = iterations[-1]["id"]
            else:
                iteration_id = 1

        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}/iterations/{iteration_id}/changes"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data

    async def get_pr_diff(
        self,
        repository: str,
        pr_id: int,
    ) -> str:
        """
        Get unified diff for a pull request.

        Note: Azure DevOps doesn't provide a direct diff endpoint.
        This reconstructs the diff from commit comparisons.

        Args:
            repository: Repository name
            pr_id: Pull request ID

        Returns:
            Unified diff string
        """
        # Get PR details for source/target commits
        pr = await self.get_pull_request(repository, pr_id)

        source_commit = pr.get("lastMergeSourceCommit", {}).get("commitId")
        target_commit = pr.get("lastMergeTargetCommit", {}).get("commitId")

        if not source_commit or not target_commit:
            return ""

        # Get diff between commits
        endpoint = f"/repositories/{repository}/diffs/commits"
        params = {
            "baseVersion": target_commit,
            "targetVersion": source_commit,
        }

        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url, params=params)

        # Build unified diff from changes
        diff_lines = []
        changes = response.data.get("changes", [])

        for change in changes:
            item = change.get("item", {})
            path = item.get("path", "")
            change_type = change.get("changeType", "")

            diff_lines.append(f"diff --git a{path} b{path}")

            if change_type == "add":
                diff_lines.append("new file")
            elif change_type == "delete":
                diff_lines.append("deleted file")

            diff_lines.append(f"--- a{path}")
            diff_lines.append(f"+++ b{path}")

        return "\n".join(diff_lines)

    async def get_pr_threads(
        self,
        repository: str,
        pr_id: int,
    ) -> list[dict[str, Any]]:
        """
        Get comment threads for a pull request.

        Args:
            repository: Repository name
            pr_id: Pull request ID

        Returns:
            List of thread data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}/threads"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data.get("value", [])

    async def post_pr_thread(
        self,
        repository: str,
        pr_id: int,
        content: str,
        status: str = "active",
        file_path: str | None = None,
        line: int | None = None,
        thread_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Post a comment thread to a pull request.

        Args:
            repository: Repository name
            pr_id: Pull request ID
            content: Comment content
            status: Thread status (active, fixed, wontFix, closed, byDesign, pending)
            file_path: Optional file path for inline comment
            line: Optional line number for inline comment
            thread_context: Optional thread context for positioning

        Returns:
            Created thread data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}/threads"

        thread_data: dict[str, Any] = {
            "comments": [
                {
                    "parentCommentId": 0,
                    "content": content,
                    "commentType": 1,  # Text comment
                }
            ],
            "status": status,
        }

        # Add thread context for inline comments
        if file_path:
            thread_data["threadContext"] = {
                "filePath": file_path,
            }
            if line:
                thread_data["threadContext"]["rightFileStart"] = {"line": line, "offset": 1}
                thread_data["threadContext"]["rightFileEnd"] = {"line": line, "offset": 1}

        if thread_context:
            thread_data["threadContext"] = thread_context

        url = self._build_url(endpoint, area="git")
        response = await self._request("POST", url, json_data=thread_data)
        return response.data

    async def update_pr_status(
        self,
        repository: str,
        pr_id: int,
        status: str,
    ) -> dict[str, Any]:
        """
        Update pull request status.

        Args:
            repository: Repository name
            pr_id: Pull request ID
            status: New status (active, abandoned, completed)

        Returns:
            Updated PR data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}"

        url = self._build_url(endpoint, area="git")
        response = await self._request(
            "PATCH",
            url,
            json_data={"status": status},
        )
        return response.data

    async def set_pr_vote(
        self,
        repository: str,
        pr_id: int,
        reviewer_id: str,
        vote: int,
    ) -> dict[str, Any]:
        """
        Set reviewer vote on a pull request.

        Args:
            repository: Repository name
            pr_id: Pull request ID
            reviewer_id: Reviewer's identity ID
            vote: Vote value (-10=rejected, -5=waiting, 0=no vote, 5=approved with suggestions, 10=approved)

        Returns:
            Reviewer data
        """
        endpoint = f"/repositories/{repository}/pullrequests/{pr_id}/reviewers/{reviewer_id}"

        url = self._build_url(endpoint, area="git")
        response = await self._request(
            "PUT",
            url,
            json_data={"vote": vote},
        )
        return response.data

    # =========================================================================
    # Repository Operations
    # =========================================================================

    async def list_repositories(self) -> list[dict[str, Any]]:
        """
        List all repositories in the project.

        Returns:
            List of repository data
        """
        endpoint = "/repositories"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data.get("value", [])

    async def get_repository(self, repository: str) -> dict[str, Any]:
        """
        Get repository details.

        Args:
            repository: Repository name or ID

        Returns:
            Repository data
        """
        endpoint = f"/repositories/{repository}"
        url = self._build_url(endpoint, area="git")
        response = await self._request("GET", url)
        return response.data

    # =========================================================================
    # Project Operations
    # =========================================================================

    async def list_projects(self) -> list[dict[str, Any]]:
        """
        List all projects in the organization.

        Returns:
            List of project data
        """
        url = f"{self.config.base_url}/{self.config.organization}/_apis/projects?api-version={self.config.api_version}"
        response = await self._request("GET", url)
        return response.data.get("value", [])

    async def get_project(self, project: str | None = None) -> dict[str, Any]:
        """
        Get project details.

        Args:
            project: Project name or ID (uses configured project if None)

        Returns:
            Project data
        """
        project = project or self.config.project
        url = f"{self.config.base_url}/{self.config.organization}/_apis/projects/{project}?api-version={self.config.api_version}"
        response = await self._request("GET", url)
        return response.data

    # =========================================================================
    # Connection Test
    # =========================================================================

    async def test_connection(self) -> dict[str, Any]:
        """
        Test the connection to Azure DevOps.

        Returns:
            Dictionary with connection status and details

        Raises:
            ADOAuthenticationError: If authentication fails
            ADORequestError: If connection fails
        """
        try:
            project = await self.get_project()
            return {
                "connected": True,
                "organization": self.config.organization,
                "project": project.get("name", self.config.project),
                "project_id": project.get("id"),
                "description": project.get("description"),
            }
        except ADOAuthenticationError:
            raise
        except Exception as e:
            return {
                "connected": False,
                "error": str(e),
            }
