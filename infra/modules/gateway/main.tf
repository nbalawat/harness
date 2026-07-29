# DF-2: llm-gateway in front of Vertex AI (Claude via Model Garden).
variable "project_id" { type = string }
variable "region" { type = string }
variable "dev_open" {
  # Dev only: public ingress + unauthenticated invoker for direct smoke tests.
  type    = bool
  default = false
}
variable "gateway_image" { type = string }
variable "vertex_region" {
  type    = string
  default = "us-east5"
}
variable "quota_usd_daily" {
  type    = number
  default = 50
}
variable "min_instances" {
  # Prod keeps 1 warm (critical path); dev scales to zero.
  type    = number
  default = 1
}

module "gateway" {
  source     = "../run-service"
  ingress        = var.dev_open ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  public_invoker = var.dev_open
  project_id = var.project_id
  region     = var.region
  name       = "llm-gateway"
  image      = var.gateway_image
  min_instances = var.min_instances
  max_instances = 200
  env = {
    UPSTREAM_URL    = "https://${var.vertex_region}-aiplatform.googleapis.com"
    MODEL_ALLOWLIST = "claude-"
    QUOTA_USD_DAILY = tostring(var.quota_usd_daily)
    REQUIRE_IDENTITY = "1"
  }
}

# The gateway's SA is the ONLY principal allowed to call the models.
resource "google_project_iam_member" "vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${module.gateway.service_account}"
}

# Restricted prompt/response log dataset (30d retention, authorized views only).
resource "google_bigquery_dataset" "prompt_log" {
  project                         = var.project_id
  dataset_id                      = "harness_prompt_log"
  location                        = "US"
  default_table_expiration_ms     = 30 * 24 * 3600 * 1000
  default_partition_expiration_ms = 30 * 24 * 3600 * 1000
}

output "gateway_uri" { value = module.gateway.uri }
output "gateway_sa" { value = module.gateway.service_account }
