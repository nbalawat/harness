# pdf-render — agent guide

Reports and letters that must be files use pdf.render — never shell
out to converters in endpoints. v0 is text-only single page (enough for
records/receipts); rich layout arrives behind the same call. The output is a
spec-valid PDF: don't post-process the bytes.
