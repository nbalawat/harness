# harness dev environment — the smallest deployable slice of
# docs/DEPLOYMENT-GCP.md: distribution + gateway + telemetry + gallery.
# (VPC-SC, IAP/LB wiring, and GKE builders arrive per the rollout phases.)
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # backend "gcs" { bucket = "…-tfstate", prefix = "harness/dev" }
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-east4"
}
variable "image_tag" {
  type    = string
  default = "dev4" # deployed + smoke-tested 2026-07-29
}

provider "google" {
  project = var.project_id
  region  = var.region
}

module "distribution" {
  source     = "../../modules/distribution"
  project_id = var.project_id
  region     = var.region
}

module "gateway" {
  source        = "../../modules/gateway"
  project_id    = var.project_id
  region        = var.region
  gateway_image = "${var.region}-docker.pkg.dev/${var.project_id}/harness/gateway:${var.image_tag}"
  dev_open      = true
  min_instances = 0
}

module "telemetry" {
  source              = "../../modules/telemetry-pipeline"
  project_id          = var.project_id
  region              = var.region
  collector_image     = "${var.region}-docker.pkg.dev/${var.project_id}/harness/collector:${var.image_tag}"
  dev_open            = true
  deletion_protection = false
}

module "gallery" {
  source         = "../../modules/gallery"
  project_id     = var.project_id
  region         = var.region
  registry_image = "${var.region}-docker.pkg.dev/${var.project_id}/harness/registry:${var.image_tag}"
  dev_open       = true
  evidence_retention_days = 1
}

output "gateway_uri" { value = module.gateway.gateway_uri }
output "collector_uri" { value = module.telemetry.collector_uri }
output "registry_uri" { value = module.gallery.registry_uri }
output "evidence_bucket" { value = module.gallery.evidence_bucket }
