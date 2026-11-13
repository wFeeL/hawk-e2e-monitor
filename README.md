# hawk-e2e-monitor

Synthetic end-to-end monitoring for [Hawk](https://hawk.so). The service
periodically sends a test error event through the public integration
interface and checks that it passes the whole pipeline: accepted by the
collector, processed by the workers, visible through the API, and turned into
a notification.

The project is in active development. Setup and usage instructions will be
added once the first checks work.

## About this test assignment

This repository is a test assignment for CodeX.

- Running the service requires access to a working Hawk instance: a project
  with an integration token and an account that can read the project through
  the GraphQL API.
- Check timeouts are fixed values from the configuration. The service does not
  compute degradation thresholds from collected data.

TODO:

- [ ] send-and-receive-event
- [ ] check-notification
- [ ] continuous-monitoring
- [ ] observability: history, Prometheus metrics, Grafana dashboard, heartbeat
- [ ] telegram delivery
