"""Shared fixtures for the Home Assistant integration tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Home Assistant looks for integrations in custom_components, which sits at the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

pytest_plugins = "pytest_homeassistant_custom_component"

HOST = os.environ.get("XMEYE_HOST", "")
USERNAME = os.environ.get("XMEYE_USER", "admin")
PASSWORD = os.environ.get("XMEYE_PASS", "")


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Without this Home Assistant ignores custom_components in tests."""
    yield


@pytest.fixture(autouse=True)
def allow_real_network(socket_enabled):
    """These tests deliberately talk to a real recorder.

    The Home Assistant test suite blocks sockets by default so that tests do not
    depend on the network, and ``socket_enabled`` allows only 127.0.0.1. Here the
    dependency is intentional, so the recorder's address joins the allow list.
    """
    import pytest_socket

    pytest_socket.socket_allow_hosts([HOST, "127.0.0.1", "::1"], allow_unix_socket=True)
    yield
    pytest_socket.disable_socket(allow_unix_socket=True)


@pytest.fixture
def device_credentials() -> dict[str, object]:
    if not PASSWORD:
        pytest.skip("XMEYE_PASS is unset; this test needs a real recorder")
    return {
        "host": HOST,
        "username": USERNAME,
        "password": PASSWORD,
        "port": 34567,
        "rtsp_port": 554,
    }
