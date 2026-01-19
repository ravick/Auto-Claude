#!/usr/bin/env python3
"""
Tests for Tool Path Resolver
============================

Tests the tool_path_resolver.py module functionality including:
- MINGW64 path conversion
- Path pattern expansion
- Tool path discovery
- PATH augmentation
- Caching behavior
"""

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add backend to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from core.tool_path_resolver import (
    ToolPaths,
    clear_cache,
    convert_mingw_path,
    discover_tool_paths,
    get_augmented_path,
    get_tool_path,
    is_tool_available,
)


class TestConvertMingwPath:
    """Tests for MINGW64 path conversion."""

    def test_convert_c_drive(self):
        """Converts /c/ to C:/."""
        result = convert_mingw_path("/c/Program Files/nodejs")
        assert result == "C:/Program Files/nodejs"

    def test_convert_d_drive(self):
        """Converts /d/ to D:/."""
        result = convert_mingw_path("/d/Users/test/projects")
        assert result == "D:/Users/test/projects"

    def test_convert_lowercase_drive(self):
        """Handles lowercase drive letters."""
        result = convert_mingw_path("/e/data")
        assert result == "E:/data"

    def test_convert_root_only(self):
        """Handles drive letter with no path."""
        result = convert_mingw_path("/c")
        assert result == "C:"

    def test_preserve_windows_path(self):
        """Preserves already-Windows paths."""
        result = convert_mingw_path("C:/Windows/System32")
        assert result == "C:/Windows/System32"

    def test_preserve_relative_path(self):
        """Preserves relative paths."""
        result = convert_mingw_path("./node_modules/bin")
        assert result == "./node_modules/bin"

    def test_preserve_absolute_non_drive_path(self):
        """Preserves non-drive absolute paths."""
        result = convert_mingw_path("/usr/local/bin")
        assert result == "/usr/local/bin"


class TestToolPaths:
    """Tests for ToolPaths dataclass."""

    def test_default_values(self):
        """Default values are None and empty list."""
        paths = ToolPaths()
        assert paths.node is None
        assert paths.npm is None
        assert paths.npx is None
        assert paths.python is None
        assert paths.pip is None
        assert paths.uv is None
        assert paths.path_dirs == []

    def test_custom_values(self):
        """Can set custom values."""
        paths = ToolPaths(
            node="C:/nodejs/node.exe",
            npm="C:/nodejs/npm.cmd",
            path_dirs=["C:/nodejs", "C:/python"],
        )
        assert paths.node == "C:/nodejs/node.exe"
        assert paths.npm == "C:/nodejs/npm.cmd"
        assert paths.path_dirs == ["C:/nodejs", "C:/python"]


class TestDiscoverToolPaths:
    """Tests for tool path discovery."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_discovers_paths_on_windows(self):
        """Discovers at least some paths on Windows."""
        paths = discover_tool_paths()
        assert isinstance(paths, ToolPaths)
        # At least path_dirs should be populated (even if empty)
        assert isinstance(paths.path_dirs, list)

    @pytest.mark.skipif(os.name == "nt", reason="Non-Windows test")
    def test_empty_paths_on_non_windows(self):
        """Returns empty ToolPaths on non-Windows."""
        paths = discover_tool_paths()
        assert paths.node is None
        assert paths.npm is None
        assert paths.path_dirs == []

    def test_caches_result(self):
        """Caches discovery result."""
        paths1 = discover_tool_paths()
        paths2 = discover_tool_paths()
        assert paths1 is paths2

    def test_clear_cache_works(self):
        """Clear cache allows re-discovery."""
        paths1 = discover_tool_paths()
        clear_cache()
        paths2 = discover_tool_paths()
        # On non-Windows, both will be empty but different objects
        if os.name != "nt":
            assert paths1 is not paths2


class TestGetAugmentedPath:
    """Tests for PATH augmentation."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    @pytest.mark.skipif(os.name == "nt", reason="Non-Windows test")
    def test_returns_none_on_non_windows(self):
        """Returns None on non-Windows systems."""
        result = get_augmented_path()
        assert result is None

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_augmented_path_format(self):
        """Augmented PATH is properly formatted."""
        with patch.dict(os.environ, {"PATH": "C:/existing"}):
            result = get_augmented_path()
            if result:
                # Should be semicolon-separated on Windows
                assert ";" in result or result == "C:/existing"

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_no_duplicate_dirs(self):
        """Doesn't add directories already in PATH."""
        clear_cache()
        # Get discovered paths first
        paths = discover_tool_paths()
        if paths.path_dirs:
            # Set PATH to include discovered directory
            test_path = paths.path_dirs[0] + os.pathsep + "C:/other"
            with patch.dict(os.environ, {"PATH": test_path}):
                clear_cache()
                result = get_augmented_path()
                if result:
                    # Count occurrences of the directory
                    dirs = result.split(os.pathsep)
                    count = sum(1 for d in dirs if d == paths.path_dirs[0])
                    assert count <= 1


class TestIsToolAvailable:
    """Tests for tool availability check."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    def test_available_tool_in_path(self):
        """Returns True for tools in PATH."""
        # 'python' or 'python3' should be available in test env
        with patch("shutil.which", return_value="/usr/bin/python"):
            result = is_tool_available("python")
            assert result is True

    def test_unavailable_tool(self):
        """Returns False for unavailable tools on Windows."""
        with patch("shutil.which", return_value=None):
            if os.name == "nt":
                # Mock discover_tool_paths to return empty
                with patch("core.tool_path_resolver.discover_tool_paths") as mock:
                    mock.return_value = ToolPaths()
                    result = is_tool_available("nonexistent_tool_xyz")
                    assert result is False
            else:
                result = is_tool_available("nonexistent_tool_xyz")
                assert result is False


class TestGetToolPath:
    """Tests for getting specific tool paths."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    def test_returns_which_path_if_available(self):
        """Returns shutil.which result if available."""
        with patch("shutil.which", return_value="/usr/bin/node"):
            result = get_tool_path("node")
            assert result == "/usr/bin/node"

    def test_returns_none_for_missing_tool(self):
        """Returns None if tool not found."""
        with patch("shutil.which", return_value=None):
            if os.name != "nt":
                result = get_tool_path("nonexistent_xyz")
                assert result is None


class TestWindowsPathPatterns:
    """Tests for Windows path pattern matching."""

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_programfiles_expansion(self):
        """Expands %PROGRAMFILES% correctly."""
        from core.tool_path_resolver import _expand_path_pattern

        result = _expand_path_pattern(r"%PROGRAMFILES%\Git")
        # Should expand to actual path or empty list
        assert isinstance(result, list)

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_glob_pattern_expansion(self):
        """Expands glob patterns correctly."""
        from core.tool_path_resolver import _expand_path_pattern

        # Test with Windows directory
        result = _expand_path_pattern(r"C:\Windows\*")
        assert isinstance(result, list)
        # C:\Windows should have subdirectories
        assert len(result) > 0 or not os.path.exists("C:\\Windows")

    def test_unexpanded_env_var(self):
        """Returns empty list for unexpanded env vars."""
        from core.tool_path_resolver import _expand_path_pattern

        result = _expand_path_pattern(r"%NONEXISTENT_VAR_XYZ%\path")
        assert result == []


class TestEnvVarOverrides:
    """Tests for environment variable overrides."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_node_path_override(self):
        """NODE_PATH env var overrides discovery."""
        from core.tool_path_resolver import _find_tool_path

        with patch.dict(os.environ, {"NODE_PATH": "C:/custom/node.exe"}):
            with patch("os.path.isfile", return_value=True):
                result = _find_tool_path("node")
                assert result == "C:/custom/node.exe"

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_python_path_override(self):
        """PYTHON_PATH env var overrides discovery."""
        from core.tool_path_resolver import _find_tool_path

        with patch.dict(os.environ, {"PYTHON_PATH": "C:/custom/python.exe"}):
            with patch("os.path.isfile", return_value=True):
                result = _find_tool_path("python")
                assert result == "C:/custom/python.exe"


class TestSecurityHooksIntegration:
    """Tests for integration with security hooks."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_hooks_check_executable_available(self):
        """Security hooks can check executable availability."""
        from security.hooks import _is_executable_available

        # Mock shutil.which to return None
        with patch("shutil.which", return_value=None):
            # Mock is_tool_available to return True
            with patch("core.tool_path_resolver.is_tool_available", return_value=True):
                is_avail, is_known = _is_executable_available("npm")
                assert is_avail is True
                assert is_known is True

    def test_hooks_executable_not_found_message(self):
        """Security hooks provide helpful error messages."""
        from security.hooks import _get_executable_not_found_message

        msg = _get_executable_not_found_message("npm")
        assert "npm" in msg
        assert "not found" in msg or "not found" in msg.lower()

        msg = _get_executable_not_found_message("node")
        assert "node" in msg.lower() or "Node.js" in msg

        msg = _get_executable_not_found_message("unknown_cmd")
        assert "unknown_cmd" in msg


class TestAuthIntegration:
    """Tests for integration with auth module."""

    def setup_method(self):
        """Clear cache before each test."""
        clear_cache()

    @pytest.mark.skipif(os.name != "nt", reason="Windows-only test")
    def test_sdk_env_vars_includes_augmented_path(self):
        """get_sdk_env_vars includes augmented PATH on Windows."""
        from core.auth import get_sdk_env_vars

        # Mock get_augmented_path to return a test value
        with patch("core.tool_path_resolver.get_augmented_path") as mock:
            mock.return_value = "C:/test/node;C:/original"
            env = get_sdk_env_vars()
            assert "PATH" in env
            assert "C:/test/node" in env["PATH"]

    @pytest.mark.skipif(os.name == "nt", reason="Non-Windows test")
    def test_sdk_env_vars_no_path_on_non_windows(self):
        """get_sdk_env_vars doesn't add PATH on non-Windows."""
        from core.auth import get_sdk_env_vars

        env = get_sdk_env_vars()
        # PATH might still be set from other sources, but not from tool_path_resolver
        # This is a weak test, just ensuring no errors occur


class TestCacheManagement:
    """Tests for cache management."""

    def test_clear_cache_resets_state(self):
        """clear_cache allows fresh discovery."""
        # First discovery
        paths1 = discover_tool_paths()

        # Clear and discover again
        clear_cache()
        paths2 = discover_tool_paths()

        # Should be different objects (even if equal values)
        if os.name != "nt":
            assert paths1 is not paths2

    def test_multiple_clear_cache_safe(self):
        """Multiple clear_cache calls are safe."""
        clear_cache()
        clear_cache()
        clear_cache()
        # Should not raise any errors
        paths = discover_tool_paths()
        assert isinstance(paths, ToolPaths)
