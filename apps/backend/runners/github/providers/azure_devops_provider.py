"""
Azure DevOps Provider Implementation
====================================

Implements the GitProvider protocol for Azure DevOps using the REST API.
Maps Azure DevOps Work Items to Issues and Pull Requests to PRData.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

# Import from parent package or direct import
try:
    from ..ado_client import ADOClient, ADOConfig
except (ImportError, ValueError, SystemError):
    from ado_client import ADOClient, ADOConfig

from .protocol import (
    IssueData,
    IssueFilters,
    LabelData,
    PRData,
    PRFilters,
    ProviderType,
    ReviewData,
)


# State mappings from Azure DevOps to normalized states
ADO_WORK_ITEM_STATE_MAP = {
    # Common states
    "New": "open",
    "Active": "open",
    "In Progress": "open",
    "Resolved": "open",  # Still needs verification
    "Closed": "closed",
    "Removed": "closed",
    "Done": "closed",
    "Completed": "closed",
    # Agile process states
    "To Do": "open",
    "Doing": "open",
    # CMMI process states
    "Proposed": "open",
    "Ready": "open",
}

ADO_PR_STATUS_MAP = {
    "active": "open",
    "abandoned": "closed",
    "completed": "merged",
}

# Vote value meanings
ADO_VOTE_MAP = {
    10: "approved",
    5: "approved_with_suggestions",
    0: "no_vote",
    -5: "waiting_for_author",
    -10: "rejected",
}


@dataclass
class AzureDevOpsProvider:
    """
    Azure DevOps implementation of the GitProvider protocol.

    Uses the Azure DevOps REST API for all operations.

    Usage:
        provider = AzureDevOpsProvider(
            organization="myorg",
            project="MyProject",
            pat="xxxxx",
            repository="MyRepo"
        )
        issue = await provider.fetch_issue(123)
        await provider.post_review(456, review)
    """

    organization: str
    project: str
    pat: str
    repository: str | None = None
    _client: ADOClient | None = None
    enable_rate_limiting: bool = True

    def __post_init__(self):
        if self._client is None:
            config = ADOConfig(
                organization=self.organization,
                project=self.project,
                pat=self.pat,
            )
            self._client = ADOClient(
                config=config,
                enable_rate_limiting=self.enable_rate_limiting,
            )

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.AZURE_DEVOPS

    @property
    def repo(self) -> str:
        """Get the repository in owner/repo format (or org/project for ADO)."""
        return f"{self.organization}/{self.project}"

    @property
    def client(self) -> ADOClient:
        """Get the underlying ADO client."""
        return self._client

    # -------------------------------------------------------------------------
    # Issue Operations (Work Items)
    # -------------------------------------------------------------------------

    async def fetch_issue(self, number: int) -> IssueData:
        """Fetch a work item by ID."""
        work_item = await self._client.get_work_item(
            number,
            expand="All",
        )
        return self._parse_work_item(work_item)

    async def fetch_issues(
        self, filters: IssueFilters | None = None
    ) -> list[IssueData]:
        """Fetch work items with optional filters."""
        filters = filters or IssueFilters()

        # Map normalized state to ADO states
        state = None
        if filters.state == "open":
            # ADO has multiple "open" states, use WIQL to handle
            state = None  # Will filter in WIQL
        elif filters.state == "closed":
            state = "Closed"

        # Build WIQL query
        conditions = ["[System.TeamProject] = @project"]

        if filters.state == "open":
            # Include all non-closed states
            conditions.append(
                "([System.State] <> 'Closed' AND [System.State] <> 'Removed' AND [System.State] <> 'Done')"
            )
        elif filters.state == "closed":
            conditions.append(
                "([System.State] = 'Closed' OR [System.State] = 'Removed' OR [System.State] = 'Done')"
            )

        if filters.author:
            conditions.append(f"[System.CreatedBy] = '{filters.author}'")

        if filters.assignee:
            conditions.append(f"[System.AssignedTo] = '{filters.assignee}'")

        if filters.labels:
            # Tags in ADO are stored as semicolon-separated string
            for label in filters.labels:
                conditions.append(f"[System.Tags] CONTAINS '{label}'")

        if filters.since:
            since_str = filters.since.strftime("%Y-%m-%dT%H:%M:%SZ")
            conditions.append(f"[System.ChangedDate] >= '{since_str}'")

        where_clause = " AND ".join(conditions)
        query = f"SELECT [System.Id] FROM WorkItems WHERE {where_clause} ORDER BY [System.ChangedDate] DESC"

        # Execute WIQL query
        result = await self._client.wiql_query(query, top=filters.limit)
        work_item_ids = [item["id"] for item in result.work_items]

        if not work_item_ids:
            return []

        # Get full work item details
        work_items = await self._client.get_work_items(work_item_ids)

        return [self._parse_work_item(wi) for wi in work_items]

    async def create_issue(
        self,
        title: str,
        body: str,
        labels: list[str] | None = None,
        assignees: list[str] | None = None,
    ) -> IssueData:
        """Create a new work item (Task by default)."""
        # Azure DevOps requires work item type - default to Task
        work_item_type = "Task"

        # Build JSON patch document
        operations = [
            {"op": "add", "path": "/fields/System.Title", "value": title},
            {"op": "add", "path": "/fields/System.Description", "value": body},
        ]

        if labels:
            # Tags are semicolon-separated
            operations.append({
                "op": "add",
                "path": "/fields/System.Tags",
                "value": "; ".join(labels),
            })

        if assignees and len(assignees) > 0:
            # ADO only supports single assignee
            operations.append({
                "op": "add",
                "path": "/fields/System.AssignedTo",
                "value": assignees[0],
            })

        # Use patch endpoint to create work item
        url = self._client._build_url(f"/workitems/${work_item_type}", area="wit")
        response = await self._client._request(
            "POST",
            url,
            json_data=operations,
        )

        return self._parse_work_item(response.data)

    async def close_issue(
        self,
        number: int,
        comment: str | None = None,
    ) -> bool:
        """Close a work item."""
        try:
            # Add comment if provided
            if comment:
                await self.add_comment(number, comment)

            # Update state to Closed
            operations = [
                {"op": "add", "path": "/fields/System.State", "value": "Closed"},
            ]

            url = self._client._build_url(f"/workitems/{number}", area="wit")
            await self._client._request(
                "PATCH",
                url,
                json_data=operations,
            )
            return True
        except Exception:
            return False

    async def add_comment(
        self,
        issue_or_pr_number: int,
        body: str,
    ) -> int:
        """Add a comment to a work item or PR."""
        # For work items, use the comments API
        url = self._client._build_url(f"/workitems/{issue_or_pr_number}/comments", area="wit")
        response = await self._client._request(
            "POST",
            url,
            json_data={"text": body},
        )
        return response.data.get("id", 0)

    # -------------------------------------------------------------------------
    # Pull Request Operations
    # -------------------------------------------------------------------------

    async def fetch_pr(self, number: int) -> PRData:
        """Fetch a pull request by ID."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        pr_data = await self._client.get_pull_request(self.repository, number)
        diff = await self._client.get_pr_diff(self.repository, number)

        return self._parse_pull_request(pr_data, diff)

    async def fetch_prs(self, filters: PRFilters | None = None) -> list[PRData]:
        """Fetch pull requests with optional filters."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        filters = filters or PRFilters()

        # Map state to ADO status
        status = "all"
        if filters.state == "open":
            status = "active"
        elif filters.state == "closed":
            status = "completed"  # Includes merged
        elif filters.state == "merged":
            status = "completed"

        prs = await self._client.list_pull_requests(
            repository=self.repository,
            status=status,
            target_branch=filters.base_branch,
            source_branch=filters.head_branch,
            top=filters.limit,
        )

        result = []
        for pr_data in prs:
            # Apply additional filters
            if filters.author:
                created_by = pr_data.get("createdBy", {})
                if created_by.get("displayName") != filters.author and created_by.get("uniqueName") != filters.author:
                    continue

            if filters.labels:
                pr_labels = [label.get("name") for label in pr_data.get("labels", [])]
                if not all(label in pr_labels for label in filters.labels):
                    continue

            # Parse to PRData (lightweight, no diff)
            result.append(self._parse_pull_request(pr_data, ""))

        return result

    async def fetch_pr_diff(self, number: int) -> str:
        """Fetch the diff for a pull request."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        return await self._client.get_pr_diff(self.repository, number)

    async def post_review(self, pr_number: int, review: ReviewData) -> int:
        """Post a review to a pull request."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        # Post main review comment as a thread
        thread = await self._client.post_pr_thread(
            repository=self.repository,
            pr_id=pr_number,
            content=review.body,
            status="active",
        )

        # Post inline comments if any
        for inline_comment in review.inline_comments:
            file_path = inline_comment.get("path")
            line = inline_comment.get("line")
            body = inline_comment.get("body", "")

            if file_path and body:
                await self._client.post_pr_thread(
                    repository=self.repository,
                    pr_id=pr_number,
                    content=body,
                    file_path=file_path,
                    line=line,
                )

        return thread.get("id", 0)

    async def merge_pr(
        self,
        pr_number: int,
        merge_method: str = "merge",
        commit_title: str | None = None,
    ) -> bool:
        """Merge a pull request."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        try:
            # Get PR details for merge info
            pr = await self._client.get_pull_request(self.repository, pr_number)

            # Build merge request
            merge_data: dict[str, Any] = {
                "status": "completed",
                "lastMergeSourceCommit": pr.get("lastMergeSourceCommit"),
            }

            if commit_title:
                merge_data["completionOptions"] = {
                    "mergeCommitMessage": commit_title,
                }

            # Set merge strategy
            if merge_method == "squash":
                merge_data.setdefault("completionOptions", {})["squashMerge"] = True
            elif merge_method == "rebase":
                # ADO doesn't have direct rebase, use merge
                pass

            endpoint = f"/repositories/{self.repository}/pullrequests/{pr_number}"
            url = self._client._build_url(endpoint, area="git")
            await self._client._request("PATCH", url, json_data=merge_data)

            return True
        except Exception:
            return False

    async def close_pr(
        self,
        pr_number: int,
        comment: str | None = None,
    ) -> bool:
        """Close a pull request without merging (abandon)."""
        if not self.repository:
            raise ValueError("Repository must be specified for PR operations")

        try:
            # Add comment if provided
            if comment:
                await self._client.post_pr_thread(
                    repository=self.repository,
                    pr_id=pr_number,
                    content=comment,
                )

            # Abandon the PR
            await self._client.update_pr_status(
                repository=self.repository,
                pr_id=pr_number,
                status="abandoned",
            )
            return True
        except Exception:
            return False

    # -------------------------------------------------------------------------
    # Label Operations
    # -------------------------------------------------------------------------

    async def apply_labels(
        self,
        issue_or_pr_number: int,
        labels: list[str],
    ) -> None:
        """Apply labels (tags) to a work item."""
        # Get current tags
        work_item = await self._client.get_work_item(issue_or_pr_number)
        current_tags = work_item.get("fields", {}).get("System.Tags", "")

        # Parse current tags
        existing_tags = [t.strip() for t in current_tags.split(";") if t.strip()]

        # Add new tags
        for label in labels:
            if label not in existing_tags:
                existing_tags.append(label)

        # Update tags
        new_tags = "; ".join(existing_tags)
        operations = [
            {"op": "add", "path": "/fields/System.Tags", "value": new_tags},
        ]

        url = self._client._build_url(f"/workitems/{issue_or_pr_number}", area="wit")
        await self._client._request("PATCH", url, json_data=operations)

    async def remove_labels(
        self,
        issue_or_pr_number: int,
        labels: list[str],
    ) -> None:
        """Remove labels (tags) from a work item."""
        # Get current tags
        work_item = await self._client.get_work_item(issue_or_pr_number)
        current_tags = work_item.get("fields", {}).get("System.Tags", "")

        # Parse current tags
        existing_tags = [t.strip() for t in current_tags.split(";") if t.strip()]

        # Remove specified tags
        existing_tags = [t for t in existing_tags if t not in labels]

        # Update tags
        new_tags = "; ".join(existing_tags)
        operations = [
            {"op": "add", "path": "/fields/System.Tags", "value": new_tags},
        ]

        url = self._client._build_url(f"/workitems/{issue_or_pr_number}", area="wit")
        await self._client._request("PATCH", url, json_data=operations)

    async def create_label(self, label: LabelData) -> None:
        """Create a label in the repository.

        Note: Azure DevOps doesn't have a concept of predefined labels/tags.
        Tags are created implicitly when added to work items.
        This method is a no-op for ADO.
        """
        pass

    async def list_labels(self) -> list[LabelData]:
        """List all labels in the repository.

        Note: Azure DevOps stores tags on work items, not as repository-level entities.
        This returns commonly used tags by querying recent work items.
        """
        # Get recent work items to collect tags
        work_items = await self._client.list_work_items(top=100)

        tags_set: set[str] = set()
        for wi in work_items:
            tags_str = wi.get("fields", {}).get("System.Tags", "")
            if tags_str:
                for tag in tags_str.split(";"):
                    tag = tag.strip()
                    if tag:
                        tags_set.add(tag)

        return [
            LabelData(name=tag, color="", description="")
            for tag in sorted(tags_set)
        ]

    # -------------------------------------------------------------------------
    # Repository Operations
    # -------------------------------------------------------------------------

    async def get_repository_info(self) -> dict[str, Any]:
        """Get repository information."""
        if not self.repository:
            # Return project info instead
            return await self._client.get_project()

        return await self._client.get_repository(self.repository)

    async def get_default_branch(self) -> str:
        """Get the default branch name."""
        if not self.repository:
            return "main"

        repo_info = await self._client.get_repository(self.repository)
        default_branch = repo_info.get("defaultBranch", "refs/heads/main")

        # Strip refs/heads/ prefix
        if default_branch.startswith("refs/heads/"):
            default_branch = default_branch[len("refs/heads/"):]

        return default_branch

    async def check_permissions(self, username: str) -> str:
        """Check a user's permission level on the repository.

        Note: Azure DevOps permissions are complex and project-based.
        This returns a simplified permission level.
        """
        # ADO doesn't have a simple permissions API like GitHub
        # Return 'write' as default for authenticated users
        return "write"

    # -------------------------------------------------------------------------
    # API Operations
    # -------------------------------------------------------------------------

    async def api_get(
        self,
        endpoint: str,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """Make a GET request to the Azure DevOps API."""
        url = self._client._build_url(endpoint, area="wit")
        response = await self._client._request("GET", url, params=params)
        return response.data

    async def api_post(
        self,
        endpoint: str,
        data: dict[str, Any] | None = None,
    ) -> Any:
        """Make a POST request to the Azure DevOps API."""
        url = self._client._build_url(endpoint, area="wit")
        response = await self._client._request("POST", url, json_data=data)
        return response.data

    # -------------------------------------------------------------------------
    # Helper Methods
    # -------------------------------------------------------------------------

    def _parse_work_item(self, data: dict[str, Any]) -> IssueData:
        """Parse Azure DevOps work item data into IssueData."""
        fields = data.get("fields", {})

        # Extract author
        created_by = fields.get("System.CreatedBy", {})
        if isinstance(created_by, dict):
            author = created_by.get("displayName", "unknown")
        else:
            author = str(created_by) if created_by else "unknown"

        # Extract assignees (ADO has single assignee)
        assigned_to = fields.get("System.AssignedTo", {})
        assignees = []
        if assigned_to:
            if isinstance(assigned_to, dict):
                assignee_name = assigned_to.get("displayName", "")
            else:
                assignee_name = str(assigned_to)
            if assignee_name:
                assignees.append(assignee_name)

        # Extract tags (semicolon-separated)
        tags_str = fields.get("System.Tags", "")
        labels = [tag.strip() for tag in tags_str.split(";") if tag.strip()]

        # Add work item type as a label
        work_item_type = fields.get("System.WorkItemType", "")
        if work_item_type and work_item_type not in labels:
            labels.insert(0, work_item_type)

        # Map state
        ado_state = fields.get("System.State", "New")
        state = ADO_WORK_ITEM_STATE_MAP.get(ado_state, "open")

        # Parse description (may be HTML)
        description = fields.get("System.Description", "") or ""
        description = self._strip_html(description)

        # Build URL
        work_item_id = data.get("id", 0)
        url = f"https://dev.azure.com/{self.organization}/{self.project}/_workitems/edit/{work_item_id}"

        return IssueData(
            number=work_item_id,
            title=fields.get("System.Title", ""),
            body=description,
            author=author,
            state=state,
            labels=labels,
            created_at=self._parse_datetime(fields.get("System.CreatedDate")),
            updated_at=self._parse_datetime(fields.get("System.ChangedDate")),
            url=url,
            assignees=assignees,
            milestone=fields.get("System.IterationPath"),
            provider=ProviderType.AZURE_DEVOPS,
            raw_data=data,
        )

    def _parse_pull_request(self, data: dict[str, Any], diff: str) -> PRData:
        """Parse Azure DevOps PR data into PRData."""
        # Extract author
        created_by = data.get("createdBy", {})
        if isinstance(created_by, dict):
            author = created_by.get("displayName", "unknown")
        else:
            author = str(created_by) if created_by else "unknown"

        # Extract labels
        labels = [label.get("name", "") for label in data.get("labels", [])]

        # Extract reviewers
        reviewers = []
        for reviewer in data.get("reviewers", []):
            if isinstance(reviewer, dict):
                reviewer_name = reviewer.get("displayName", "")
                if reviewer_name:
                    reviewers.append(reviewer_name)

        # Map status
        ado_status = data.get("status", "active")
        state = ADO_PR_STATUS_MAP.get(ado_status, "open")

        # Strip refs/heads/ from branch names
        source_branch = data.get("sourceRefName", "")
        target_branch = data.get("targetRefName", "")
        if source_branch.startswith("refs/heads/"):
            source_branch = source_branch[len("refs/heads/"):]
        if target_branch.startswith("refs/heads/"):
            target_branch = target_branch[len("refs/heads/"):]

        # Build URL
        pr_id = data.get("pullRequestId", 0)
        repository = data.get("repository", {})
        repo_name = repository.get("name", self.repository or "")
        url = data.get("url", f"https://dev.azure.com/{self.organization}/{self.project}/_git/{repo_name}/pullrequest/{pr_id}")

        # Check mergeability
        merge_status = data.get("mergeStatus", "")
        mergeable = merge_status in ("succeeded", "queued", "notSet")

        return PRData(
            number=pr_id,
            title=data.get("title", ""),
            body=data.get("description", "") or "",
            author=author,
            state=state,
            source_branch=source_branch,
            target_branch=target_branch,
            additions=0,  # ADO doesn't provide this directly
            deletions=0,  # ADO doesn't provide this directly
            changed_files=0,  # Would need separate API call
            files=[],  # Would need separate API call
            diff=diff,
            url=url,
            created_at=self._parse_datetime(data.get("creationDate")),
            updated_at=self._parse_datetime(data.get("closedDate") or data.get("creationDate")),
            labels=labels,
            reviewers=reviewers,
            is_draft=data.get("isDraft", False),
            mergeable=mergeable,
            provider=ProviderType.AZURE_DEVOPS,
            raw_data=data,
        )

    def _parse_datetime(self, dt_str: str | None) -> datetime:
        """Parse ISO datetime string."""
        if not dt_str:
            return datetime.now(timezone.utc)
        try:
            return datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            return datetime.now(timezone.utc)

    def _strip_html(self, text: str) -> str:
        """Strip HTML tags from text and decode entities."""
        if not text:
            return ""

        # Remove HTML tags
        text = re.sub(r'<[^>]+>', '', text)

        # Decode HTML entities
        text = html.unescape(text)

        # Normalize whitespace
        text = re.sub(r'\s+', ' ', text).strip()

        return text
