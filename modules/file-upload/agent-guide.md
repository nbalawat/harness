# file-upload — agent guide

User files arrive ONLY through /uploads/{name}: extension allowlist
(APP_UPLOAD_EXTS, default txt,md,csv,pdf,docx,png), size via blob-store's cap,
names sanitized by blob-store. Never accept multipart in v0; raw body keeps the
dependency surface zero. Wire virus scanning at the perimeter, not here.
