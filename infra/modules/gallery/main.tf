# DF-4: app-registry + gallery + retention-locked evidence store.
variable "project_id" { type = string }
variable "region" { type = string }
variable "dev_open" {
  # Dev only: public ingress + unauthenticated invoker for direct smoke tests.
  type    = bool
  default = false
}
variable "registry_image" { type = string }
variable "evidence_retention_days" {
  type    = number
  default = 365
}

module "registry" {
  source     = "../run-service"
  ingress        = var.dev_open ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  public_invoker = var.dev_open
  project_id = var.project_id
  region     = var.region
  name       = "app-registry"
  image      = var.registry_image
  env = {
    REQUIRE_IDENTITY = "1"
    EVIDENCE_BUCKET  = google_storage_bucket.evidence.name
  }
}

resource "google_storage_bucket" "evidence" {
  project                     = var.project_id
  name                        = "${var.project_id}-harness-evidence"
  location                    = "US"
  uniform_bucket_level_access = true
  versioning { enabled = true }
  # Published proof cannot be quietly edited.
  retention_policy {
    retention_period = var.evidence_retention_days * 24 * 3600
  }
}

resource "google_storage_bucket_iam_member" "registry_writes" {
  bucket = google_storage_bucket.evidence.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${module.registry.service_account}"
}

resource "google_storage_bucket_iam_member" "registry_reads" {
  bucket = google_storage_bucket.evidence.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.registry.service_account}"
}

output "registry_uri" { value = module.registry.uri }
output "evidence_bucket" { value = google_storage_bucket.evidence.name }
