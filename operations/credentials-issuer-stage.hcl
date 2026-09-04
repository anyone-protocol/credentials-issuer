variable "commit_sha" {
  type        = string
  description = "Git commit SHA of the image to run"
  // Pinned so the jobspec can be run by hand without passing -var. Deploying is manual, so
  // nothing substitutes this for us; bump it deliberately when promoting a build, or override
  // with -var=commit_sha=... for a one-off.
  default     = "5675a0e99fe6e8823e33dba1e8a8c2463c9993df"
}

job "credentials-issuer-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "credentials-issuer-stage-group" {
    // Single instance. Postgres and Redis hold all shared state, so scaling out is safe, but the
    // migration prestart task would have to move to a job of its own first.
    count = 1

    update {
      max_parallel     = 1
      canary           = 1
      min_healthy_time = "30s"
      healthy_deadline = "5m"
      auto_revert      = true
      auto_promote     = true
    }

    network {
      mode = "bridge"
      port "http-port" {
        host_network = "wireguard"
        to           = 3000
      }
    }

    service {
      name = "credentials-issuer-stage"
      port = "http-port"
      tags = ["logging"]

      check {
        name         = "Credentials issuer health check"
        type         = "http"
        port         = "http-port"
        path         = "/healthz"
        interval     = "10s"
        timeout      = "10s"
        address_mode = "alloc"

        check_restart {
          limit = 10
          grace = "30s"
        }
      }
    }

    task "credentials-issuer-migrations-stage-task" {
      driver = "docker"

      lifecycle {
        hook    = "prestart"
        sidecar = false
      }

      config {
        image   = "ghcr.io/anyone-protocol/credentials-issuer:${VERSION}"
        command = "bun"
        // --cwd rather than the driver's work_dir: the script lives in the backend workspace,
        // and this runs the same `bun run migration:run` the README documents.
        args    = ["run", "--cwd", "apps/backend", "migration:run"]
      }

      env {
        VERSION      = var.commit_sha
        NODE_ENV     = "production"
        POSTGRES_DB  = "credentials_issuer"
      }

      template {
        data        = <<-EOH
        {{- range service "credentials-issuer-postgres-stage" }}
        POSTGRES_HOST="{{ .Address }}"
        POSTGRES_PORT="{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/db.env"
        env         = true
      }

      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-stage" }}
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

    task "credentials-issuer-stage-task" {
      driver       = "docker"
      kill_timeout = "30s"

      config {
        image = "ghcr.io/anyone-protocol/credentials-issuer:${VERSION}"
      }

      env {
        VERSION     = var.commit_sha
        NODE_ENV    = "production"
        PORT        = "3000"
        POSTGRES_DB = "credentials_issuer"

        // Provisional until the 0.3 credential spec lands. See the README.
        BUNDLE_SIZE          = "10"
        BLANK_SIZE_BYTES     = "256"
        SIGNATURE_SIZE_BYTES = "256"
        BUNDLE_PRICE         = "1.00"

        // Rendered below from Vault. Paths are absolute: the docker driver mounts the task's
        // secrets directory at /secrets.
        KEYRING_PATH           = "/secrets/keyring.json"
        KEYRING_RELOAD_SECONDS = "30"
        PROXY_PUBLIC_KEY_PATH  = "/secrets/proxy.pub.pem"

        RECONCILIATION_INTERVAL_SECONDS   = "60"
        ENTITLEMENT_DRIP_INTERVAL_SECONDS = "86400"
        RATE_LIMIT_MAX                    = "60"
        RATE_LIMIT_WINDOW_SECONDS         = "60"

        // Blind signing is CPU-bound; size the pool to the cores this alloc actually gets, not
        // to the host. 0 signs inline and starts no threads. See the README.
        SIGNING_WORKERS    = "2"
        SIGNING_NATIVE_RSA = "true"
        SIGNING_TIMEOUT_MS = "10000"
      }

      consul {}

      template {
        data        = <<-EOH
        {{- range service "credentials-issuer-postgres-stage" }}
        POSTGRES_HOST="{{ .Address }}"
        POSTGRES_PORT="{{ .Port }}"
        {{- end }}
        {{- range service "credentials-issuer-redis-stage" }}
        REDIS_HOST="{{ .Address }}"
        REDIS_PORT="{{ .Port }}"
        {{- end }}
        EOH
        destination = "local/config.env"
        env         = true
      }

      vault { role = "any1-nomad-workloads-controller" }

      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-stage" }}
        POSTGRES_USER="{{ .Data.data.DB_USER }}"
        POSTGRES_PASSWORD="{{ .Data.data.DB_PASS }}"
        {{ end }}
        EOH
        destination = "secrets/db.env"
        env         = true
      }

      // The epoch keyring: every usable epoch, its published document and its private key, in one
      // file because a rotation must never be seen half-applied. noop, not restart: the issuer
      // re-reads this every KEYRING_RELOAD_SECONDS, so rotations land without dropping requests.
      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-stage" }}{{ base64Decode .Data.data.KEYRING_BASE64 }}{{ end }}
        EOH
        destination = "secrets/keyring.json"
        change_mode = "noop"
      }

      // Read once at boot, unlike the keyring, so a new proxy key needs a restart.
      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-stage" }}{{ base64Decode .Data.data.PROXY_PUBLIC_KEY_BASE64 }}{{ end }}
        EOH
        destination = "secrets/proxy.pub.pem"
        change_mode = "restart"
      }

      resources {
        cpu    = 2048
        memory = 1024
      }
    }
  }
}
