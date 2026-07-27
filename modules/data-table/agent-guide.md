# data-table — agent guide

Tabular UI uses HarnessTable — never hand-rolled <table> loops per
slice. prepare() is pure (sort by column asc/desc, substring filter across
fields, 1-based paging); render() binds into any container using textContent
only. Column order comes from the data model, not object key order.
