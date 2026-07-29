# DF-1: the firm's only install source — npm repo + service images.
variable "project_id" { type = string }
variable "region" { type = string }
variable "install_domain" {
  # e.g. "firm.example" — grants org-wide npm read. Null skips (dev projects).
  type    = string
  default = null
}

resource "google_artifact_registry_repository" "npm" {
  project       = var.project_id
  location      = var.region
  repository_id = "harness-npm"
  format        = "NPM"
  description   = "@firm/harness — engine + certified catalog (channels via dist-tags)"
}

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "harness"
  format        = "DOCKER"
  description   = "harness platform service images (BinAuthz-attested)"
}

# Every firm identity can install; only the release pipeline can publish.
resource "google_artifact_registry_repository_iam_member" "org_read" {
  count      = var.install_domain == null ? 0 : 1
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.npm.name
  role       = "roles/artifactregistry.reader"
  member     = "domain:${var.install_domain}"
}

output "npm_repo" { value = google_artifact_registry_repository.npm.id }
output "image_repo" { value = google_artifact_registry_repository.images.id }
