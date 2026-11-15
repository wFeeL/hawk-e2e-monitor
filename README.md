# hawk-e2e-monitor

Synthetic end-to-end monitoring for [Hawk](https://hawk.so). The service
periodically sends a test error event through the public integration
interface and checks that it passes the whole pipeline: accepted by the
collector, processed by the workers, visible through the API, and turned into
a notification.

Two checks exist: send-and-receive-event and check-notification. Each runs as
a one-off command, and `serve` runs them on a schedule, keeps the history of
every run and sends alerts to Telegram through @codex_bot. Metrics, a dashboard
and a Telegram delivery check come next.

## Running one check

Requirements: Node.js 26 and a Hawk instance prepared as described in
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

## Checking notifications

`check check-notification` sends one event and waits for the webhook and loop
notifications Hawk sends about it. Hawk accepts only public https addresses
for these channels, so the receiver needs a public address. A cloudflared quick
tunnel needs no account:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8091 --metrics 127.0.0.1:20241
```

Then set `RECEIVER_SECRET` and `TUNNEL_METRICS_URL=http://127.0.0.1:20241` (or
`PUBLIC_BASE_URL` for a fixed address) in `.env` and run:

```sh
node --env-file-if-exists=.env dist/main.js provision      # creates the rule, waits 65 s for Hawk to reload rules
node --env-file-if-exists=.env dist/main.js check check-notification
```

`provision` is optional: the check brings the rule to the expected state
itself, but a run that had to change the rule skips the notification stage
while Hawk's notifier still caches the old rules. `provision` waits out that
time before it exits; after `provision --no-wait` the next check can fail
with `notification_timeout` for about a minute. The check takes the same
`--sequence`, `--transport` and `--repeat` options. A run where only one of the two channels arrived passes
with a warning.

## Running continuously

`serve` is the default command of the container image. With an empty history
it starts the first scenario listed in `SCENARIOS` right away and each next one
`SCENARIO_STAGGER_MS` later. After that every scenario runs again
`CHECK_INTERVAL_MS` after the start of its previous run, also across restarts
of the monitor, so the first run after a restart can take up to one interval.
check-notification first waits up to `TUNNEL_READY_TIMEOUT_MS` for the tunnel
to report its address. A tick that comes while the previous run of the same scenario is
still going is recorded as skipped.

With Docker Compose the monitor starts together with a cloudflared quick
tunnel for the notification receiver:

```sh
cp .env.example .env   # fill it in; leave TUNNEL_METRICS_URL unset, compose sets it
docker compose up -d --build
docker compose ps      # monitor becomes healthy within about 15 s
```

Compose needs Docker Engine 25 or newer. When Hawk runs on the same host, point
`HAWK_API_URL` and `HAWK_COLLECTOR_URL` at `host.docker.internal` and make Hawk
listen on an address the containers can reach, not only `127.0.0.1`. Values in
`.env` that contain `$` go in single quotes.

The history lives in SQLite in the `monitor-data` volume, so it survives
`docker compose down` and image updates. Only the internal port is published,
on `127.0.0.1:8090`:

| Path | Answer |
|---|---|
| `GET /healthz` | 200 while the process and its scheduler work |
| `GET /readyz` | 200 once startup finished, while the receiver is open and no alert has waited for delivery longer than 30 minutes |
| `GET /runs?scenario=<name>&limit=<n>` | latest runs, newest first |
| `GET /runs/<runId>` | the full result of one run: every stage, its duration and details |
| `GET /stats` | success ratio, event latency percentiles and average stage durations |

The same history is available from the command line:

```sh
docker compose exec monitor node dist/main.js history --limit 20
docker compose exec monitor node dist/main.js history --stats
```

`check` and `provision` refuse to run while `serve` works on the same
database, so that two processes do not change the notification rule at once.

### Alerts

Add @codex_bot to a Telegram chat, send it `/notify_start` and put the address
it answers with into `ALERT_NOTIFY_URL`. The monitor sends a message when a
scenario starts failing (after `ALERT_AFTER_FAILURES` failed runs in a row),
when the reason of the failure changes, when it recovers, and when it becomes
degraded: a run passed but only one notification channel arrived, or the
projected event count exceeds the plan limit. A message names the stage,
the error class, the likely culprit and the time of every stage. Messages that
the bot does not accept are retried with a growing pause for up to 24 hours.
With `ALERT_NOTIFY_URL` empty, alerts go to the log only.

### Restarts and failures

- A run cut short by a restart of the monitor is recorded as aborted with
  `monitor_restarted`, a run cut short by `docker compose stop` as
  `monitor_stopped`. Neither counts as a failure of Hawk.
- A run that does not finish within `RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS +
  WATCHDOG_GRACE_MS` is cancelled and recorded as `run_hung`. After three such
  runs of one scenario in a row the process exits and the container restart
  policy starts it again.
- Restarts and deploys of Hawk show up as failed runs with the stage and the
  error class, and the next run after Hawk is back passes and sends a
  recovery message. The monitor itself keeps running.
- If the monitor container is recreated after a crash, the new container
  waits until the lease of the old process expires (up to 90 s) and shows as
  restarting meanwhile. A configuration error also keeps it restarting;
  `docker compose logs monitor` names the variable at fault.
- Every restart of cloudflared gives the quick tunnel a new address. The next
  check-notification run moves the rule to the new address and checks
  notifications through it in the same run.
- The volume is created owned by the `node` user (uid 1000) of the image. A
  bind mount or a volume created another way needs `chown 1000:1000`.
- Test events left behind by failed or interrupted runs are removed once an
  hour (`SWEEP_INTERVAL_MS`) when they are older than `SWEEP_MIN_AGE_MS`.

Every run of each scenario sends one event, two on repeat runs. One scenario
every 10 minutes is about 4,400 events a month, so the free plan of 1,000
events lasts about a week; the monitor warns when the projected count exceeds
the workspace limit. Use a bigger plan or a longer interval.

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
- The checks were run against a local Hawk built from the CodeX repositories
  (collector, API and the workers up to the webhook and loop senders) and
  against the fake Hawk in the unit tests. They were not run against
  production hawk.so.
- check-notification needs the workspace admin account to manage one
  notification rule of the monitor in the test project, and a public https
  address for the receiver (a cloudflared quick tunnel works). Whether the
  webhook and loop senders run on hawk.so is not confirmed.
- check-notification needs the notifier enabled in the grouper and the webhook
  and loop senders running in Hawk, and outgoing access to Cloudflare from the
  monitor when a quick tunnel is used.
- The receiver secret is part of the rule's channel addresses. Every member of
  the workspace can read it in the project settings, and Hawk's sender writes
  the address to its logs. Use a dedicated project and workspace.
- The monitor removes the test event when its run ends. A sender that is still
  late at that point fails to read the removed event, and Hawk reports that
  failure to its own error tracking: up to one error per missing channel in
  slow or failed runs. A notification that arrives after its run has finished
  finds no waiting run; the receiver answers it and the monitor only logs it.
- Telegram delivery is not checked yet. Alerts are sent to @codex_bot; the
  monitor sees that the bot accepted a message, not that it reached the chat.
- Docker Compose was run with podman 5.7 (`podman compose`), not with Docker.
- Check timeouts are fixed values from the configuration. The service does not
  compute degradation thresholds from collected data.

TODO:

- [x] send-and-receive-event
- [x] check-notification (webhook and loop channels)
- [x] continuous-monitoring: schedule, history, alerts, compose
- [ ] observability: Prometheus metrics, Grafana dashboard, heartbeat
- [ ] telegram delivery
