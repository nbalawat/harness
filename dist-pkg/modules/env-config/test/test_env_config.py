import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app_config  # noqa: E402
import pytest  # noqa: E402

SPEC = {
    "APP_PORT": {"type": "int", "default": 8000},
    "APP_DEBUG": {"type": "bool", "default": False},
    "APP_NAME_REQ": {"type": "str", "required": True},
}


def test_types_defaults_and_required():
    config = app_config.load(SPEC, env={"APP_PORT": "9001", "APP_DEBUG": "true", "APP_NAME_REQ": "copilot"})
    assert config == {"APP_PORT": 9001, "APP_DEBUG": True, "APP_NAME_REQ": "copilot"}
    with pytest.raises(app_config.ConfigError, match="APP_NAME_REQ is required"):
        app_config.load(SPEC, env={})
    with pytest.raises(app_config.ConfigError, match="must be int"):
        app_config.load(SPEC, env={"APP_PORT": "many", "APP_NAME_REQ": "x"})
