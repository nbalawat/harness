Attempt 4 failed validation. Fix the following and try again:

command exited with 1:
node "$HARNESS_PROJECT_DIR/scripts/security-scan.cjs"
stdout:

stderr:
security scan BLOCKED: 2 high-severity finding(s)
  [unauthenticated-mutation] backend/ext_blobs.py: PUT /files/{name} handler carries no identity (add role check via acting_user_email, or an explicit '# public-endpoint: <reason>' marker)
  [unauthenticated-mutation] backend/ext_uploads.py: PUT /uploads/{name} handler carries no identity (add role check via acting_user_email, or an explicit '# public-endpoint: <reason>' marker)
