# Reusable Cloud Run service in the harness pattern: dedicated SA, no public
# ingress (LB+IAP in front), CMEK-ready, scale-to-zero.
variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "image" { type = string }
variable "env" {
  type    = map(string)
  default = {}
}
variable "min_instances" {
  type    = number
  default = 0
}
variable "max_instances" {
  type    = number
  default = 20
}
variable "ingress" {
  # Prod: internal LB behind IAP. Dev: INGRESS_TRAFFIC_ALL for direct smoke tests.
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
}
variable "public_invoker" {
  # Dev-only: allow unauthenticated invocation (the service still enforces
  # its own identity header). Prod keeps IAP as the authenticator.
  type    = bool
  default = false
}

resource "google_service_account" "svc" {
  project      = var.project_id
  account_id   = "sa-${var.name}"
  display_name = "harness ${var.name}"
}

resource "google_cloud_run_v2_service" "svc" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  ingress             = var.ingress
  deletion_protection = false # env promotion replaces services; state is external (GCS/BQ)

  template {
    service_account = google_service_account.svc.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    containers {
      image = var.image
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public_invoker ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.svc.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_account" { value = google_service_account.svc.email }
output "uri" { value = google_cloud_run_v2_service.svc.uri }
output "name" { value = google_cloud_run_v2_service.svc.name }
