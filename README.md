# hawk-e2e-monitor

Synthetic end-to-end monitoring for [Hawk](https://hawk.so). The service
periodically sends a test error event through the public integration
interface and checks that it passes the whole pipeline: accepted by the
collector, processed by the workers, visible through the API, and turned into
a notification.

The project is in active development. The first check, send-and-receive-event,
works as a one-off command; periodic runs, alerts and notification checks come
next.

## Running one check

Requirements: Node.js 24 and a Hawk instance prepared as described in
[About this test assignment](#about-this-test-assignment).

```sh
npm ci
npm run build
cp .env.example .env   # fill in the Hawk addresses, project, token and account
node --env-file-if-exists=.env dist/main.js check send-and-receive-event
```

Options:

- `--sequence <n>`: run number, 1 by default. With `TRANSPORT_MODE=alternate`
  odd numbers use HTTP and even numbers use WebSocket.
- `--transport http|ws`: force the transport.
- `--repeat`: also send the event a second time and check that Hawk groups it.

The command prints one JSON object with the result to stdout and logs to
stderr. Exit code 0 means the run passed, 1 means it failed or the
configuration is invalid, 2 means wrong arguments. On failure the result names
the stage, the error class, who is likely at fault (`hawk`, `monitor`,
`config` or `network`) and a readable message.

Checks against a live Hawk:

```sh
set -a && . ./.env && set +a
E2E_HAWK=1 npm run test:e2e
```

Without `E2E_HAWK=1`, `npm run test:e2e` skips them. `npm test` runs the unit
tests against a fake Hawk and needs no network.

## About this test assignment

This repository is a test assignment for CodeX.

- Running the service requires access to a working Hawk instance:
  - a dedicated project for the monitor, with no grouping pattern that matches
    titles starting with `[e2e:`;
  - the integration token of that project;
  - an account that is an admin of the project's workspace, because the
    monitor removes its test events after each run.
- Which collector queue and worker processed an event is not visible from
  outside. The monitor checks that an event with the catcher type of each SDK
  goes all the way through.
- So far the checks were run only against the fake Hawk in the unit tests. A
  run against a live Hawk is still to be done.
- Check timeouts are fixed values from the configuration. The service does not
  compute degradation thresholds from collected data.

TODO:

- [x] send-and-receive-event (verified against the fake Hawk)
- [ ] check-notification
- [ ] continuous-monitoring
- [ ] observability: history, Prometheus metrics, Grafana dashboard, heartbeat
- [ ] telegram delivery
