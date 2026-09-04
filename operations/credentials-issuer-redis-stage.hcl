job "credentials-issuer-redis-stage" {
  datacenters = ["ator-fin"]
  type        = "service"
  namespace   = "stage-services"

  constraint {
    attribute = "${meta.pool}"
    value     = "stage"
  }

  group "credentials-issuer-redis-stage-group" {
    count = 1

    network {
      mode = "bridge"
      port "redis-port" {
        host_network = "wireguard"
        to           = 6379
      }
    }

    service {
      name = "credentials-issuer-redis-stage"
      port = "redis-port"
      tags = ["logging"]

      check {
        name         = "Redis TCP check"
        type         = "tcp"
        port         = "redis-port"
        interval     = "10s"
        timeout      = "10s"
        address_mode = "alloc"

        check_restart {
          limit = 5
          grace = "30s"
        }
      }
    }

    // Deliberately ephemeral: nothing here is a source of truth. Redis holds rate-limit windows
    // and the reconciliation schedule, and both rebuild themselves after a restart. Losing it
    // costs one window of rate limiting and one reconciliation cycle, so it is not worth a host
    // volume in the sandbox. See docs/deployment.md.
    task "credentials-issuer-redis-stage-task" {
      driver = "docker"

      config {
        image = "redis:7-alpine"
        args  = ["redis-server", "--save", "", "--appendonly", "no"]
      }

      consul {}

      resources {
        cpu    = 256
        memory = 256
      }
    }
  }
}
