variable "commit_sha" {
  type        = string
  description = "Git commit SHA of the image to run"
  default     = "2089baf1ba0bd4f8c92b96b6b0d2f8ba0c6e0f7a"
}

# Rotates the epoch keyring in Vault. Nothing else does: without this the
# current epoch eventually expires, the issuer keeps serving a key document
# nobody can buy against, and only /healthz notices. See docs/deployment.md.
#
# The cron period is the effective epoch length, and so the anonymity set every
# credential issued in it belongs to. --epoch-seconds is the ceiling instead:
# four weeks against a weekly cron leaves three weeks of tolerance for a broken
# rotation before issuance actually stops.
job "credentials-issuer-rotate-epoch-stage" {
  datacenters = ["ator-fin"]
  type        = "batch"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  periodic {
    crons = ["@weekly"]
    // Rotation is a read-modify-write on one Vault key, guarded by a
    // compare-and-set. Overlapping runs would make one of them fail for no
    // reason.
    prohibit_overlap = true
  }

  group "credentials-issuer-rotate-epoch-stage-group" {
    count = 1

    task "credentials-issuer-rotate-epoch-stage-task" {
      driver = "docker"

      config {
        image   = "ghcr.io/anyone-protocol/credentials-issuer:${VERSION}"
        command = "bun"
        args = [
          "run", "rotate-epoch",
          "--vault-secret", "kv/stage-services/credentials-issuer-stage",
          "--root-key", "/secrets/root.pem",
          "--epoch-seconds", "2419200",
          "--grace-seconds", "86400",
        ]
      }

      env {
        VERSION = var.commit_sha
      }

      vault { role = "any1-nomad-workloads-controller" }

      // The root private key, which the issuer must never be able to read. The
      // invariant holds only if this path's policy is separate from the
      // issuer's: a compromised issuer can abuse the current epoch key, but it
      // cannot mint epochs or forge a key document.
      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-rotation-stage" }}{{ base64Decode .Data.data.ROOT_KEY_BASE64 }}{{ end }}
        EOH
        destination = "secrets/root.pem"
      }

      template {
        data        = <<-EOH
        {{ with secret "kv/stage-services/credentials-issuer-rotation-stage" }}
        VAULT_ADDR="{{ .Data.data.VAULT_ADDR }}"
        {{ end }}
        EOH
        destination = "secrets/vault.env"
        env         = true
      }

      consul {}

      resources {
        cpu    = 512
        memory = 512
      }
    }
  }
}
