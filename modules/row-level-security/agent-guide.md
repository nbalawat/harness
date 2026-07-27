# row-level-security — agent guide

Apply rls.scope() at the endpoint boundary on EVERY list/detail read
of owner-scoped tables. Policy declares the owner field and which roles bypass
scoping ({"owner_field": "user", "bypass_roles": ["admin"]}). Never re-implement
the filter inline — a missed branch is a data leak.
