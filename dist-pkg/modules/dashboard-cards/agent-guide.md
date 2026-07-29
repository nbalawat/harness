# dashboard-cards — agent guide

KPI tiles declare {metric: count|sum|avg|latest, field?, of?}; compute
handles empty data (0 / null, never NaN). Money formats with 2 decimals; large
counts get thousands separators. Cards never run their own loops over rows.
