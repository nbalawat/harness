import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import multi_env  # noqa: E402
import pytest  # noqa: E402


def test_layering_last_wins_and_env_file_parsing():
    base = multi_env.load_env_file("APP_PORT=8000\n# comment\nAPP_DEBUG=1\n")
    staging = multi_env.load_env_file("APP_PORT=9000\n")
    merged = multi_env.merge(base, staging, env_name="staging")
    assert merged == {"APP_PORT": "9000", "APP_DEBUG": "1"}


def test_prod_rails_refuse_debug_and_seed():
    with pytest.raises(multi_env.ProdGuardViolation):
        multi_env.merge({"APP_DEBUG": "1"}, {}, env_name="prod")
    with pytest.raises(multi_env.ProdGuardViolation):
        multi_env.merge({}, {"APP_ALLOW_SEED": "1"}, env_name="prod")
    assert multi_env.merge({"APP_DEBUG": "0"}, {}, env_name="prod")["APP_DEBUG"] == "0"
