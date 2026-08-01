The user reviewed this step's previous output and requested changes:

SECURITY SCAN BLOCKERS (final two): backend/ext_blobs.py PUT /files/{name} and backend/ext_uploads.py PUT /uploads/{name} still carry no identity. Bring both to the hardened module standard: add 'x_user_email: str | None = Header(default=None)' to each handler, return 401 with detail 'x-user-email header required for uploads' when missing, and include 'uploaded_by': x_user_email in the success response. Update any frontend callers or tests that PUT to these endpoints to send the x-user-email header. Change NOTHING else; every recorded acceptance check must keep passing; app.js changes stay pure appends.

The previously committed output is at: /Users/nbalawat/development/harness/underwriting-desk-v12/artifacts/slice-1
Start from it and apply ONLY the requested changes — keep everything else stable.