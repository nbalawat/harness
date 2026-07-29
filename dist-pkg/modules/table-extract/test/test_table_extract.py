import os
import sys

os.environ["HARNESS_AGENT_MODE"] = "stub"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import table_extract  # noqa: E402


def test_html_table_with_ragged_row():
    html = "<table><tr><th>name</th><th>limit</th></tr><tr><td>basic</td><td>10</td></tr><tr><td>pro</td></tr></table>"
    tables = table_extract.from_html(html)
    assert tables[0][0] == {"name": "basic", "limit": "10"}
    assert tables[0][1] == {"name": "pro", "limit": ""}, "ragged rows padded, not dropped"


def test_csv_rows():
    rows = table_extract.from_csv("sku,price\nA,10\nB,12\n")
    assert rows[1] == {"sku": "B", "price": "12"}
