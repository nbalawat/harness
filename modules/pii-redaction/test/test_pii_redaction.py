import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pii  # noqa: E402


def test_detects_and_masks_common_pii():
    text = "Mail jane.doe@firm.com or call 555-123-4567, SSN 123-45-6789, card 4242 4242 4242 4242."
    kinds = {k for k, _ in pii.detect(text)}
    assert {"email", "phone", "ssn", "card"} <= kinds
    masked = pii.redact(text)
    assert "jane.doe@firm.com" not in masked and "[email]" in masked and "[card]" in masked


def test_luhn_rejects_random_digit_runs():
    assert not any(k == "card" for k, _ in pii.detect("order id 1234 5678 9012 3456 7"))
    assert pii.redact("Refunds take 5 days.") == "Refunds take 5 days."
