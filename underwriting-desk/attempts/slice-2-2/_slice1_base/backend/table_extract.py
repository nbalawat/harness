"""table-extract module: structured tables out of documents. See agent-guide."""
import csv
import html.parser
import io


class _Tables(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self._row, self._cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = ""

    def handle_endtag(self, tag):
        if tag == "tr" and self._row is not None:
            self.tables[-1].append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            self._row.append(self._cell.strip())
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell += data


def from_html(raw):
    p = _Tables()
    p.feed(raw)
    out = []
    for grid in p.tables:
        if not grid:
            continue
        header, rows = grid[0], grid[1:]
        table = []
        for r in rows:
            padded = r + [""] * (len(header) - len(r))
            table.append(dict(zip(header, padded)))
        out.append(table)
    return out


def from_csv(text):
    return [dict(r) for r in csv.DictReader(io.StringIO(text))]
