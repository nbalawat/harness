"""spreadsheet-io module: tabular text one way. See agent-guide."""
import csv
import io


def _coerce(value):
    v = value.strip()
    is_intlike = v.isdigit() or (v.startswith("-") and v[1:].isdigit())
    if v and is_intlike and str(int(v)) == v:  # leading zeros = identifier, not number
        return int(v)
    try:
        if v and any(c in v for c in ".eE") :
            return float(v)
    except ValueError:
        pass
    return value


def read_rows(text, delimiter=","):
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    return [{k: _coerce(v) for k, v in row.items()} for row in reader]


def write_csv(rows, columns):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return out.getvalue()
