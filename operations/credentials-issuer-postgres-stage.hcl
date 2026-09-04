job "credentials-issuer-postgres-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "credentials-issuer-postgres-stage-group" {
    count = 1

    update {
      max_parallel     = 1
      canary           = 0
      min_healthy_time = "30s"
      healthy_deadline = "5m"
      auto_revert      = true
    }

    network {
      mode = "bridge"
      port "db-port" {
        host_network = "wireguard"
        to           = 5432
      }
    }

    // Requires a client host volume of this name. See docs/deployment.md.
    volume "credentials-issuer-postgres-stage" {
      type      = "host"
      read_only = false
      source    = "credentials-issuer-postgres-stage"
    }

    service {
      name = "credentials-issuer-postgres-stage"
      port = "db-port"
      tags = ["logging"]

      check {
        name         = "Postgres TCP check"
        type         = "tcp"
        port         = "db-port"
        interval     = "10s"
        timeout      = "10s"
        address_mode = "alloc"

        check_restart {
          limit = 5
          grace = "60s"
        }
      }
    }

    task "credentials-issuer-postgres-stage-task" {
      driver = "docker"

      config {
        image      = "postgres:18-alpine"
        force_pull = false
      }

      volume_mount {
        volume      = "credentials-issuer-postgres-stage"
        destination = "/var/lib/postgresql"
        read_only   = false
      }

      env {
        POSTGRES_DB = "credentials_issuer"
      }

      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-postgres-stage" }}
        POSTGRES_USER="{{ .Data.data.DB_USER }}"
        POSTGRES_PASSWORD="{{ .Data.data.DB_PASS }}"
        {{ end }}
        EOH
        destination = "secrets/db.env"
        env         = true
      }

      consul {}
      vault { role = "any1-nomad-workloads-controller" }

      resources {
        cpu    = 256
        memory = 512
      }
    }
  }
}
