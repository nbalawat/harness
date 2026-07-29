# table-extract — agent guide

When a document contains tables, extract them STRUCTURED via this
module and store rows — never flatten tables into prose text. Header rows
become dict keys; ragged rows are padded, not dropped, with a warning.
