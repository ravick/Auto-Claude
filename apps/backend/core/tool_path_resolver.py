#!/usr/bin/env python3
"""
Tool Path Resolver for Windows
==============================

Auto-discovers common development tool paths on Windows when they're not in PATH.
Useful for MINGW64 Git Bash environments where tools are installed but not
accessible from the subprocess PATH.

This module follows the same pattern as git_executable.py for path discovery.
"""

import glob
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# Cached tool paths (singleton pattern)
_cached_tool_paths: "ToolPaths | None" = None


@dataclass
class ToolPaths:
    """Container for discovered tool paths."""

    node: str | None = None  # Path to node.exe
    npm: str | None = None  # Path to npm.cmd
    npx: str | None = None  # Path to npx.cmd
    python: str | None = None  # Path to python.exe
    pip: str | None = None  # Path to pip.exe
    uv: str | None = None  # Path to uv.exe
    path_dirs: list[str] = field(default_factory=list)  # Dirs to add to PATH


# Common Windows installation paths for development tools
# Each key maps to a list of (glob_pattern, executable_name) tuples
WINDOWS_TOOL_PATHS: dict[str, list[tuple[str, str]]] = {
    "node": [
        (r"%PROGRAMFILES%\nodejs", "node.exe"),
        (r"%LOCALAPPDATA%\Programs\nodejs", "node.exe"),
        # NVM for Windows - check versioned directories
        (r"%NVM_HOME%\v*", "node.exe"),
        (r"%APPDATA%\nvm\v*", "node.exe"),
        (r"%LOCALAPPDATA%\nvm\v*", "node.exe"),
        # fnm (Fast Node Manager)
        (r"%LOCALAPPDATA%\fnm_multishells\*", "node.exe"),
        (r"%APPDATA%\fnm\node-versions\*\installation", "node.exe"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\nodejs\current", "node.exe"),
        # Chocolatey
        (r"C:\ProgramData\chocolatey\lib\nodejs*\tools\node-*", "node.exe"),
    ],
    "npm": [
        (r"%PROGRAMFILES%\nodejs", "npm.cmd"),
        (r"%LOCALAPPDATA%\Programs\nodejs", "npm.cmd"),
        (r"%APPDATA%\npm", "npm.cmd"),
        # NVM for Windows
        (r"%NVM_HOME%\v*", "npm.cmd"),
        (r"%APPDATA%\nvm\v*", "npm.cmd"),
        # fnm
        (r"%LOCALAPPDATA%\fnm_multishells\*", "npm.cmd"),
        (r"%APPDATA%\fnm\node-versions\*\installation", "npm.cmd"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\nodejs\current", "npm.cmd"),
    ],
    "npx": [
        (r"%PROGRAMFILES%\nodejs", "npx.cmd"),
        (r"%LOCALAPPDATA%\Programs\nodejs", "npx.cmd"),
        (r"%APPDATA%\npm", "npx.cmd"),
        # NVM for Windows
        (r"%NVM_HOME%\v*", "npx.cmd"),
        (r"%APPDATA%\nvm\v*", "npx.cmd"),
        # fnm
        (r"%LOCALAPPDATA%\fnm_multishells\*", "npx.cmd"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\nodejs\current", "npx.cmd"),
    ],
    "python": [
        (r"%LOCALAPPDATA%\Programs\Python\Python3*", "python.exe"),
        (r"%PROGRAMFILES%\Python\Python3*", "python.exe"),
        (r"%PROGRAMFILES%\Python3*", "python.exe"),
        # Python launcher
        (r"%LOCALAPPDATA%\Programs\Python\Launcher", "py.exe"),
        # pyenv-win
        (r"%USERPROFILE%\.pyenv\pyenv-win\versions\3.*", "python.exe"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\python\current", "python.exe"),
        # Chocolatey
        (r"C:\Python3*", "python.exe"),
    ],
    "pip": [
        (r"%LOCALAPPDATA%\Programs\Python\Python3*\Scripts", "pip.exe"),
        (r"%PROGRAMFILES%\Python\Python3*\Scripts", "pip.exe"),
        # pyenv-win
        (r"%USERPROFILE%\.pyenv\pyenv-win\versions\3.*\Scripts", "pip.exe"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\python\current\Scripts", "pip.exe"),
    ],
    "uv": [
        (r"%USERPROFILE%\.cargo\bin", "uv.exe"),
        (r"%LOCALAPPDATA%\uv", "uv.exe"),
        # Scoop
        (r"%USERPROFILE%\scoop\apps\uv\current", "uv.exe"),
        # pipx
        (r"%USERPROFILE%\.local\bin", "uv.exe"),
    ],
}

# Environment variable overrides for each tool
TOOL_ENV_OVERRIDES: dict[str, str] = {
    "node": "NODE_PATH",
    "npm": "NPM_PATH",
    "npx": "NPX_PATH",
    "python": "PYTHON_PATH",
    "pip": "PIP_PATH",
    "uv": "UV_PATH",
}


def convert_mingw_path(path: str) -> str:
    """
    Convert MINGW64/Git Bash Unix-style paths to Windows paths.

    Examples:
        /c/Program Files/nodejs -> C:/Program Files/nodejs
        /d/Users/test -> D:/Users/test
        C:/Windows -> C:/Windows (unchanged)

    Args:
        path: Path string that may be in Unix or Windows format

    Returns:
        Windows-style path string
    """
    # Match /x/... pattern where x is a drive letter
    match = re.match(r"^/([a-zA-Z])(/.*)?$", path)
    if match:
        drive = match.group(1).upper()
        rest = match.group(2) or ""
        return f"{drive}:{rest}"
    return path


def _expand_path_pattern(pattern: str) -> list[str]:
    """
    Expand a path pattern with environment variables and globs.

    Args:
        pattern: Path pattern like r"%PROGRAMFILES%\nodejs" or r"%NVM_HOME%\v*"

    Returns:
        List of existing directories matching the pattern
    """
    # Expand environment variables
    expanded = os.path.expandvars(pattern)

    # If pattern still contains unexpanded env var (e.g., %NVM_HOME% not set), skip
    if "%" in expanded:
        return []

    # Convert forward slashes for consistency
    expanded = expanded.replace("/", "\\")

    # Use glob to expand wildcards
    if "*" in expanded:
        matches = glob.glob(expanded)
        # Return only directories, sorted by modification time (newest first)
        dirs = [m for m in matches if os.path.isdir(m)]
        dirs.sort(key=lambda x: os.path.getmtime(x), reverse=True)
        return dirs
    elif os.path.isdir(expanded):
        return [expanded]
    return []


def _find_tool_path(tool_name: str) -> str | None:
    """
    Find the path to a specific tool.

    Search order:
    1. Check environment variable override (e.g., NODE_PATH)
    2. Use shutil.which() for PATH lookup
    3. Check common Windows installation paths
    4. Use Windows 'where' command as fallback

    Args:
        tool_name: Name of the tool (e.g., "node", "npm", "python")

    Returns:
        Full path to the executable if found, None otherwise
    """
    if tool_name not in WINDOWS_TOOL_PATHS:
        return None

    # 1. Check environment variable override
    env_var = TOOL_ENV_OVERRIDES.get(tool_name)
    if env_var:
        env_path = os.environ.get(env_var)
        if env_path and os.path.isfile(env_path):
            return env_path

    # Get the executable name for this tool
    exe_names = set()
    for _, exe_name in WINDOWS_TOOL_PATHS[tool_name]:
        exe_names.add(exe_name)

    # 2. Use shutil.which() for PATH lookup
    for exe_name in exe_names:
        found = shutil.which(exe_name.replace(".exe", "").replace(".cmd", ""))
        if found:
            return found

    # 3. Check common Windows installation paths
    for pattern, exe_name in WINDOWS_TOOL_PATHS[tool_name]:
        dirs = _expand_path_pattern(pattern)
        for dir_path in dirs:
            exe_path = os.path.join(dir_path, exe_name)
            if os.path.isfile(exe_path):
                return exe_path

    # 4. Use Windows 'where' command as fallback
    for exe_name in exe_names:
        try:
            result = subprocess.run(
                ["where.exe", exe_name],
                capture_output=True,
                text=True,
                timeout=5,
                shell=False,
            )
            if result.returncode == 0 and result.stdout.strip():
                found_path = result.stdout.strip().split("\n")[0].strip()
                if found_path and os.path.isfile(found_path):
                    return found_path
        except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
            continue

    return None


def discover_tool_paths() -> ToolPaths:
    """
    Discover paths for common development tools on Windows.

    This function caches its results for performance.

    Returns:
        ToolPaths dataclass with discovered paths and PATH directories
    """
    global _cached_tool_paths

    # Return cached result if available
    if _cached_tool_paths is not None:
        return _cached_tool_paths

    # Only run on Windows
    if os.name != "nt":
        _cached_tool_paths = ToolPaths()
        return _cached_tool_paths

    paths = ToolPaths()
    path_dirs: set[str] = set()

    # Discover each tool
    paths.node = _find_tool_path("node")
    paths.npm = _find_tool_path("npm")
    paths.npx = _find_tool_path("npx")
    paths.python = _find_tool_path("python")
    paths.pip = _find_tool_path("pip")
    paths.uv = _find_tool_path("uv")

    # Collect directories from discovered tools
    for tool_path in [paths.node, paths.npm, paths.npx, paths.python, paths.pip, paths.uv]:
        if tool_path:
            tool_dir = os.path.dirname(tool_path)
            if tool_dir:
                path_dirs.add(tool_dir)

    # Also add npm global bin directory if not already included
    npm_global = os.path.expandvars(r"%APPDATA%\npm")
    if os.path.isdir(npm_global):
        path_dirs.add(npm_global)

    # Sort directories for consistent ordering
    paths.path_dirs = sorted(path_dirs)

    _cached_tool_paths = paths
    return paths


def get_augmented_path() -> str | None:
    """
    Get augmented PATH with discovered tool directories prepended.

    Returns:
        Augmented PATH string, or None if no augmentation needed
    """
    if os.name != "nt":
        return None

    tool_paths = discover_tool_paths()

    if not tool_paths.path_dirs:
        return None

    current_path = os.environ.get("PATH", "")

    # Filter out directories already in PATH
    current_dirs = set(current_path.split(os.pathsep))
    new_dirs = [d for d in tool_paths.path_dirs if d not in current_dirs]

    if not new_dirs:
        return None

    # Prepend new directories to PATH
    augmented = os.pathsep.join(new_dirs) + os.pathsep + current_path
    return augmented


def clear_cache() -> None:
    """Clear the cached tool paths. Useful for testing."""
    global _cached_tool_paths
    _cached_tool_paths = None


def is_tool_available(tool_name: str) -> bool:
    """
    Check if a tool is available (either in PATH or discoverable).

    Args:
        tool_name: Name of the tool (e.g., "node", "npm", "python")

    Returns:
        True if the tool is available, False otherwise
    """
    # First check shutil.which
    if shutil.which(tool_name):
        return True

    # Check if we can discover it
    if os.name == "nt":
        tool_paths = discover_tool_paths()
        tool_map = {
            "node": tool_paths.node,
            "npm": tool_paths.npm,
            "npx": tool_paths.npx,
            "python": tool_paths.python,
            "pip": tool_paths.pip,
            "uv": tool_paths.uv,
        }
        return tool_map.get(tool_name) is not None

    return False


def get_tool_path(tool_name: str) -> str | None:
    """
    Get the full path to a specific tool.

    Args:
        tool_name: Name of the tool (e.g., "node", "npm", "python")

    Returns:
        Full path to the executable, or None if not found
    """
    # First check shutil.which
    which_path = shutil.which(tool_name)
    if which_path:
        return which_path

    # Check discovered paths on Windows
    if os.name == "nt":
        tool_paths = discover_tool_paths()
        tool_map = {
            "node": tool_paths.node,
            "npm": tool_paths.npm,
            "npx": tool_paths.npx,
            "python": tool_paths.python,
            "pip": tool_paths.pip,
            "uv": tool_paths.uv,
        }
        return tool_map.get(tool_name)

    return None
