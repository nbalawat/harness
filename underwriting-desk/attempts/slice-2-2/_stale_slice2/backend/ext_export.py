"""export-csv module: table export from the registered data model. See agent-guide."""
import csv
import io

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from db import store
from ext_guard import SENSITIVE_FIELDS
from models import TABLES

router = APIRouter()

_CSV_FORMULA_LEADERS = ("=", "+", "-", "@", "\t", "\r")


def _cell(value):
    """Neutralise spreadsheet formula injection in an examiner-bound export."""
    if value is None or isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    return "'" + text if text.startswith(_CSV_FORMULA_LEADERS) else text


@router.get("/export/{table}.csv")
def export_table(table: str):
    if table not in TABLES:
        raise HTTPException(status_code=404, detail="unknown table")
    # Credential material is never exported, whatever the data model registers,
    # so it can never leave the app in a spreadsheet that gets emailed around.
    columns = ["id", *[c for c in TABLES[table] if c != "id" and c not in SENSITIVE_FIELDS]]
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in store.list(table):
        writer.writerow({key: _cell(row.get(key)) for key in columns})
    return PlainTextResponse(out.getvalue(), media_type="text/csv")
