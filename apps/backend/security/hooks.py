"""
Security Hooks
==============

Pre-tool-use hooks that validate bash commands for security.
Main enforcement point for the security system.
"""

import os
import shutil
from pathlib import Path
from typing import Any

from project_analyzer import BASE_COMMANDS, SecurityProfile, is_command_allowed

from .parser import extract_commands, get_command_for_validation, split_command_segments
from .profile import get_security_profile
from .validator import VALIDATORS


def _is_executable_available(cmd: str) -> tuple[bool, bool]:
    """
    Check if a command executable is available.

    First tries shutil.which, then on Windows also checks
    discovered tool paths.

    Args:
        cmd: Command name (e.g., "npm", "node", "python")

    Returns:
        Tuple of (is_available, is_known_tool):
        - is_available: True if executable is available
        - is_known_tool: True if this is a known tool we track (node, npm, etc.)
    """
    # Known tools we can verify
    known_tools = {"node", "npm", "npx", "python", "python3", "pip", "pip3", "uv"}

    # First check if it's in PATH
    if shutil.which(cmd):
        return True, cmd in known_tools

    # On Windows, check discovered tool paths
    if os.name == "nt":
        try:
            from core.tool_path_resolver import is_tool_available

            if is_tool_available(cmd):
                return True, cmd in known_tools
        except ImportError:
            pass

    # For unknown commands, assume available (avoid false negatives)
    # For known tools, we've checked and they're not found
    is_known = cmd in known_tools
    return not is_known, is_known


def _get_executable_not_found_message(cmd: str) -> str:
    """
    Get a helpful error message for when an executable is not found.

    Args:
        cmd: Command name (e.g., "npm", "node", "python")

    Returns:
        Helpful error message string
    """
    messages = {
        "npm": (
            f"Command '{cmd}' is allowed but not found. "
            f"Ensure Node.js is installed and npm is in PATH. "
            f"On Windows, you may need to install Node.js from nodejs.org or via nvm-windows."
        ),
        "npx": (
            f"Command '{cmd}' is allowed but not found. "
            f"Ensure Node.js is installed and npx is in PATH. "
            f"npx comes bundled with npm 5.2+."
        ),
        "node": (
            f"Command '{cmd}' is allowed but not found. "
            f"Ensure Node.js is installed and in PATH. "
            f"On Windows, you may need to install Node.js from nodejs.org or via nvm-windows."
        ),
        "python": (
            f"Command '{cmd}' is allowed but not found. "
            f"Ensure Python is installed and in PATH. "
            f"On Windows, install from python.org or the Microsoft Store."
        ),
        "pip": (
            f"Command '{cmd}' is allowed but not found. "
            f"Ensure Python and pip are installed and in PATH."
        ),
        "uv": (
            f"Command '{cmd}' is allowed but not found. "
            f"Install uv with: pip install uv, or cargo install uv."
        ),
    }
    return messages.get(
        cmd,
        f"Command '{cmd}' is allowed but executable not found. "
        f"Ensure {cmd} is installed and in PATH.",
    )


async def bash_security_hook(
    input_data: dict[str, Any],
    tool_use_id: str | None = None,
    context: Any | None = None,
) -> dict[str, Any]:
    """
    Pre-tool-use hook that validates bash commands using dynamic allowlist.

    This is the main security enforcement point. It:
    1. Validates tool_input structure (must be dict with 'command' key)
    2. Extracts command names from the command string
    3. Checks each command against the project's security profile
    4. Runs additional validation for sensitive commands
    5. Blocks disallowed commands with clear error messages

    Args:
        input_data: Dict containing tool_name and tool_input
        tool_use_id: Optional tool use ID
        context: Optional context

    Returns:
        Empty dict to allow, or {"decision": "block", "reason": "..."} to block
    """
    if input_data.get("tool_name") != "Bash":
        return {}

    # Validate tool_input structure before accessing
    tool_input = input_data.get("tool_input")

    # Check if tool_input is None (malformed tool call)
    if tool_input is None:
        return {
            "decision": "block",
            "reason": "Bash tool_input is None - malformed tool call from SDK",
        }

    # Check if tool_input is a dict
    if not isinstance(tool_input, dict):
        return {
            "decision": "block",
            "reason": f"Bash tool_input must be dict, got {type(tool_input).__name__}",
        }

    # Now safe to access command
    command = tool_input.get("command", "")
    if not command:
        return {}

    # Get the working directory from context or use current directory
    # Priority:
    # 1. Environment variable PROJECT_DIR_ENV_VAR (set by agent on startup)
    # 2. input_data cwd (passed by SDK in the tool call)
    # 3. Context cwd (should be set by ClaudeSDKClient but sometimes isn't)
    # 4. Current working directory (fallback, may be incorrect in worktree mode)
    from .constants import PROJECT_DIR_ENV_VAR

    cwd = os.environ.get(PROJECT_DIR_ENV_VAR)
    if not cwd:
        cwd = input_data.get("cwd")
    if not cwd and context and hasattr(context, "cwd"):
        cwd = context.cwd
    if not cwd:
        cwd = os.getcwd()

    # Get or create security profile
    # Note: In actual use, spec_dir would be passed through context
    try:
        profile = get_security_profile(Path(cwd))
    except Exception as e:
        # If profile creation fails, fall back to base commands only
        print(f"Warning: Could not load security profile: {e}")
        profile = SecurityProfile()
        profile.base_commands = BASE_COMMANDS.copy()

    # Extract all commands from the command string
    commands = extract_commands(command)

    if not commands:
        # Could not parse - fail safe by blocking
        return {
            "decision": "block",
            "reason": f"Could not parse command for security validation: {command}",
        }

    # Split into segments for per-command validation
    segments = split_command_segments(command)

    # Get all allowed commands
    allowed = profile.get_all_allowed_commands()

    # Check each command against the allowlist
    for cmd in commands:
        # Check if command is allowed
        is_allowed, reason = is_command_allowed(cmd, profile)

        if not is_allowed:
            return {
                "decision": "block",
                "reason": reason,
            }

        # For allowed commands, check if executable is actually available
        # This provides clearer error messages for known tools like npm, node, etc.
        exec_available, is_known_tool = _is_executable_available(cmd)
        if not exec_available and is_known_tool:
            return {
                "decision": "block",
                "reason": _get_executable_not_found_message(cmd),
            }

        # Additional validation for sensitive commands
        if cmd in VALIDATORS:
            cmd_segment = get_command_for_validation(cmd, segments)
            if not cmd_segment:
                cmd_segment = command

            validator = VALIDATORS[cmd]
            allowed, reason = validator(cmd_segment)
            if not allowed:
                return {"decision": "block", "reason": reason}

    return {}


def validate_command(
    command: str,
    project_dir: Path | None = None,
) -> tuple[bool, str]:
    """
    Validate a command string (for testing/debugging).

    Args:
        command: Full command string to validate
        project_dir: Optional project directory (uses cwd if not provided)

    Returns:
        (is_allowed, reason) tuple
    """
    if project_dir is None:
        project_dir = Path.cwd()

    profile = get_security_profile(project_dir)
    commands = extract_commands(command)

    if not commands:
        return False, "Could not parse command"

    segments = split_command_segments(command)

    for cmd in commands:
        is_allowed_result, reason = is_command_allowed(cmd, profile)
        if not is_allowed_result:
            return False, reason

        if cmd in VALIDATORS:
            cmd_segment = get_command_for_validation(cmd, segments)
            if not cmd_segment:
                cmd_segment = command

            validator = VALIDATORS[cmd]
            allowed, reason = validator(cmd_segment)
            if not allowed:
                return False, reason

    return True, ""
