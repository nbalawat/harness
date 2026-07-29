# DF-3: collector (Cloud Run) -> Pub/Sub -> BigQuery fleet dataset.
variable "project_id" { type = string }
variable "region" { type = string }
variable "dev_open" {
  # Dev only: public ingress + unauthenticated invoker for direct smoke tests.
  type    = bool
  default = false
}
variable "collector_image" { type = string }

module "collector" {
  source     = "../run-service"
  ingress        = var.dev_open ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  public_invoker = var.dev_open
  project_id = var.project_id
  region     = var.region
  name       = "telemetry-collector"
  image      = var.collector_image
  env = {
    REQUIRE_IDENTITY = "1"
    PUBSUB_TOPIC     = google_pubsub_topic.events.id
  }
}

resource "google_pubsub_topic" "events" {
  project = var.project_id
  name    = "harness-fleet-events"
}

resource "google_bigquery_dataset" "fleet" {
  project    = var.project_id
  dataset_id = "harness_fleet"
  location   = "US"
}

variable "deletion_protection" {
  type    = bool
  default = true
}

resource "google_bigquery_table" "events" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.fleet.dataset_id
  table_id            = "events"
  deletion_protection = var.deletion_protection
  time_partitioning {
    type  = "DAY"
    field = "ts"
  }
  clustering = ["projectType", "version"]
  schema = jsonencode([
    { name = "ts", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "event", type = "STRING", mode = "REQUIRED" },
    { name = "projectType", type = "STRING", mode = "REQUIRED" },
    { name = "version", type = "STRING", mode = "REQUIRED" },
    { name = "identity", type = "STRING" },
    { name = "nodeId", type = "STRING" },
    { name = "costUsd", type = "FLOAT" },
    { name = "mock", type = "BOOLEAN" },
    { name = "command", type = "STRING" },
    { name = "receivedAt", type = "TIMESTAMP" },
  ])
}

data "google_project" "this" {
  project_id = var.project_id
}

# The Pub/Sub service agent writes the rows into BigQuery.
resource "google_bigquery_dataset_iam_member" "pubsub_writes" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.fleet.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# BQ subscription: Pub/Sub writes straight into the table (no Dataflow).
resource "google_pubsub_subscription" "to_bq" {
  project = var.project_id
  name    = "harness-fleet-events-bq"
  topic   = google_pubsub_topic.events.id
  bigquery_config {
    table            = "${var.project_id}.${google_bigquery_dataset.fleet.dataset_id}.${google_bigquery_table.events.table_id}"
    use_table_schema = true
  }
  depends_on = [google_bigquery_dataset_iam_member.pubsub_writes]
}

resource "google_pubsub_topic_iam_member" "collector_publishes" {
  project = var.project_id
  topic   = google_pubsub_topic.events.id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.collector.service_account}"
}

output "collector_uri" { value = module.collector.uri }
