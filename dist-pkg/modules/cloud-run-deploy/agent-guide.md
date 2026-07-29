# cloud-run-deploy — agent guide

Cloud Run deploys use these scripts verbatim (region/project/service
from env: GCP_PROJECT, GCP_REGION, APP_SERVICE). cloud-run.sh builds with
Cloud Build, deploys with --no-traffic, then shifts traffic — so a bad revision
never takes traffic. rollback.sh shifts traffic back to the previous revision.
