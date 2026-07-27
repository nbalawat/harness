import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import spreadsheet_io  # noqa: E402


def test_read_coerces_conservatively():
    rows = spreadsheet_io.read_rows("sku,qty,price,note\nA,10,10.5,ok\nB,-2,1e3,007\n")
    assert rows[0] == {"sku": "A", "qty": 10, "price": 10.5, "note": "ok"}
    assert rows[1]["qty"] == -2 and rows[1]["price"] == 1000.0
    assert rows[1]["note"] == "007", "leading-zero strings stay strings"


def test_write_respects_declared_column_order():
    out = spreadsheet_io.write_csv([{"b": 2, "a": 1, "junk": 9}], columns=["a", "b"])
    assert out.splitlines()[0] == "a,b" and out.splitlines()[1] == "1,2"
