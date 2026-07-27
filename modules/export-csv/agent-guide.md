# export-csv — agent guide

Data leaves the app through this module. If a slice needs "download as
CSV/Excel", link to `/export/<table>.csv` — do not hand-roll serialization in
new endpoints. Columns come from the approved data model (models.TABLES); the
export never includes columns outside it.
