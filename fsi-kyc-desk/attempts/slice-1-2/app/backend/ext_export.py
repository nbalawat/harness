"""export-csv module: table export from the registered data model. See agent-guide."""
import csv
import io

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from db import store
from models import TABLES

router = APIRouter()


@router.get("/export/{table}.csv")
def export_table(table: str):
    if table not in TABLES:
        raise HTTPException(status_code=404, detail="unknown table")
    columns = ["id", *[c for c in TABLES[table] if c != "id"]]
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in store.list(table):
        writer.writerow(row)
    return PlainTextResponse(out.getvalue(), media_type="text/csv")
