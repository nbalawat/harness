# Client Risk Rating Matrix (v2.1)

(Source: risk-rating-matrix.html — extracted from HTML tables)

The case risk score is the weighted sum of factor scores. Each factor is
scored 0-100 by the mechanical rules below, then weighted.

| Factor | Weight | Scoring rule |
|---|---|---|
| Jurisdiction | 0.30 | FATF high-risk list country involved = 90; enhanced-monitoring list = 60; otherwise = 10 |
| Entity structure | 0.25 | Ownership chain depth > 3 or bearer shares = 85; nominee shareholders = 60; simple structure = 15 |
| Industry | 0.20 | Money services, gambling, defense = 80; cash-intensive retail = 55; other = 20 |
| Sanctions screening | 0.15 | Any true-positive hit = 100 (auto high risk); unresolved possible hit = 70; clear = 0 |
| Expected activity | 0.10 | Cross-border wires > $1M/month = 75; domestic only = 20 |

## Bands

| Band | Score | Review cadence |
|---|---|---|
| Low | 0-39 | 3 years |
| Medium | 40-69 | Annual |
| High | 70-100 | 6 months, Compliance Officer approval required |

A sanctions true-positive forces the case to High regardless of the weighted total.
