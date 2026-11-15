# hawk-e2e-monitor

Synthetic end-to-end monitoring for [Hawk](https://hawk.so). The service
periodically sends a test error event through the public integration
interface and checks that it passes the whole pipeline: accepted by the
collector, processed by the workers, visible through the API, and turned into
a notification.

Three checks exist: send-and-receive-event, check-notification and
endpoints-probe (the collector, the API and Garage without events). Each runs
as a one-off command, and `serve` runs them on a schedule, keeps the history of
every run and sends alerts to Telegram through @codex_bot. It also exposes
Prometheus metrics, ships a Grafana dashboard and pings an external heartbeat.

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
notifications Hawk sends about it. Hawk accepts only public addresses for these
channels (https for loop), so the receiver needs a public address. A
cloudflared quick tunnel needs no account:

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

## More scenarios

Every scenario that sends an event reads it back with the same queries Garage
uses and compares the fields a user sees in the event card. A grouping pattern
of the project that would catch the monitor's titles is reported as degraded
(`grouping_pattern`).

- **Threshold rule.** check-notification keeps a second notification rule for
  the instance: Hawk sends it on the second event of the same error within an
  hour. On repeat runs
  (`REPEAT_EVERY_N_RUNS`) the stage `threshold_formed` waits for exactly one
  threshold webhook after the repeat. A threshold webhook before the repeat
  fails the run with `threshold_early`.
- **sourcemaps**, hourly (`SOURCEMAPS_INTERVAL_MS`). Uploads a release
  `e2e-<INSTANCE_ID>-<runId>` with a small source map to the collector, waits
  until Hawk lists the file (`RELEASE_SAVE_TIMEOUT_MS`), sends a JavaScript
  event of that release and checks that the frame points to the original file,
  line and source lines. Hawk has no API to remove a release, so these releases
  stay in the test project until Hawk's archiver removes old ones.
- **sentry-envelope**, hourly (`SENTRY_ENVELOPE_INTERVAL_MS`). Sends an event
  through the Sentry endpoint of the collector (`/api/0/envelope/`), the way a
  Sentry SDK pointed at Hawk does, and checks the event in Hawk.
- **new-project**, daily (`NEW_PROJECT_INTERVAL_MS`), off by default. Creates
  a project in the workspace of `HAWK_PROJECT_ID`, waits until the collector
  accepts its new token (`NEW_PROJECT_TOKEN_TIMEOUT_MS`, the collector reloads
  tokens periodically), sends an event, finds it and removes the project. The
  account must be an admin of the workspace. Run it only against a Hawk you
  own. Hawk may post every created project to a team chat
  (`TELEGRAM_MAIN_CHAT_URL` of the API). Projects left by an interrupted run
  are removed by the sweep. The sweep only removes projects that the monitor
  recorded in its history, that carry its name pattern, sit in the same
  workspace and are older than `SWEEP_MIN_AGE_MS`.

Without `SCENARIOS`, `serve` runs send-and-receive-event, check-notification,
sourcemaps and sentry-envelope. check-notification then needs
`RECEIVER_SECRET` and a public address, as above.

## Running continuously

`serve` is the default command of the container image. With an empty history
it starts the first scenario listed in `SCENARIOS` right away and each next one
`SCENARIO_STAGGER_MS` later. After that every scenario runs again one interval
after the start of its previous run, also across restarts of the monitor, so
the first run after a restart can take up to one interval. The interval is
`CHECK_INTERVAL_MS` for send-and-receive-event and check-notification, and the
scenario's own variable for the others.
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

Compose needs Docker Engine 25 or newer with Compose 2.24 or newer. When Hawk runs on the same host, point
`HAWK_API_URL` and `HAWK_COLLECTOR_URL` at `host.docker.internal` and make Hawk
listen on an address the containers can reach, not only `127.0.0.1`. With
Docker on Linux, `host.docker.internal` is the address of the `docker0`
bridge, so a Hawk published on `127.0.0.1` refuses the connection. Publish
Hawk on the bridge address too, or attach the monitor to the network of the
Hawk containers with a compose override and use their service names. Values in
`.env` that contain `$` go in single quotes.

The history lives in SQLite in the `monitor-data` volume, so it survives
`docker compose down` and image updates. Only the internal port is published,
on `127.0.0.1:8090`:

| Path | Answer |
|---|---|
| `GET /healthz` | 200 while the scheduler ticks, the history database works and no scenario is stuck busy; 503 with the reason otherwise |
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
They also refuse when the database file exists but cannot be opened, because
then they cannot tell whether `serve` is running. A `check check-notification`
started within `RULE_CACHE_WARMUP_MS` of a rule change first waits for Hawk to
reload the notification rules.

### Alerts

Add @codex_bot to a Telegram chat, send it `/notify_start` and put the address
it answers with into `ALERT_NOTIFY_URL`. The monitor sends a message when a
scenario starts failing (after `ALERT_AFTER_FAILURES` failed runs in a row),
when the reason of the failure changes, when it recovers, and when it becomes
degraded: a run passed but only one notification channel arrived, the
collector did not confirm an event that still reached Hawk (users' SDKs would
see an error there), or less than 10% of the workspace event quota is left. A message names the stage,
the error class, the likely culprit and the time of every stage. Messages that
the bot does not accept are retried with a growing pause for up to 24 hours.
With `ALERT_NOTIFY_URL` empty, alerts go to the log only.

### Restarts and failures

- A run cut short by a restart of the monitor is recorded as aborted with
  `monitor_restarted`, a run cut short by `docker compose stop` as
  `monitor_stopped`. Neither counts as a failure of Hawk.
- A run of send-and-receive-event or check-notification that does not finish
  within `RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS` is cancelled
  and recorded as `run_hung`. For the other scenarios the limit is the sum of
  the timeouts of their own stages plus `CLEANUP_TIMEOUT_MS` and
  `WATCHDOG_GRACE_MS`. `RUN_TIMEOUT_MS` must cover all stages of
  check-notification, including the threshold stage
  (`NOTIFICATION_TIMEOUT_MS + HTTP_TIMEOUT_MS`); the configuration check names
  the sum when it does not. After three such
  runs of one scenario in a row the process exits and the container restart
  policy starts it again.
- Restarts and deploys of Hawk show up as failed runs with the stage and the
  error class, and the next run after Hawk is back passes and sends a
  recovery message. The monitor itself keeps running.
- If the monitor container is recreated after a crash, the new container
  waits until the lease of the old process expires (up to 90 s) and shows as
  restarting meanwhile. A restart inside the same container waits one lease
  renewal period (35 s) to make sure the old process is gone. A `serve` that
  finds another process holding its lease exits, so two monitors never run on
  one database. A configuration error also keeps it restarting;
  `docker compose logs monitor` names the variable at fault.
- Docker does not restart a container that is only unhealthy. When the
  tunnel shows as unhealthy and check-notification fails with
  `tunnel_unavailable`, restart it: `docker compose restart tunnel`.
- Every restart of cloudflared gives the quick tunnel a new address. The next
  check-notification run moves the rule to the new address and checks
  notifications through it in the same run.
- The volume is created owned by the `node` user (uid 1000) of the image. A
  bind mount or a volume created another way needs `chown 1000:1000`.
- `endpoints-probe` has its own run limit: the sum of its stage timeouts plus
  10 seconds.
- With podman, containers restart after a host reboot only when the user
  services do: `loginctl enable-linger` and `systemctl --user enable
  podman-restart.service`.
- Test events left behind by failed or interrupted runs are removed once an
  hour (`SWEEP_INTERVAL_MS`) when they are older than `SWEEP_MIN_AGE_MS`.

Every run of each scenario sends one event, two on repeat runs; one scenario
every 10 minutes sends about 4,700 events a month. Hawk counts the quota from
the events that remain in a project, and the monitor removes its events after
each run, so they barely use the quota. They do count against the rate limits
of the collector.

## Metrics, dashboard and heartbeat

`GET /metrics` on the internal port serves Prometheus metrics: runs and
failures by scenario, stage, error class and culprit, run, stage, event and
notification latency histograms, the last status and run time of every
scenario, the alert queue age and heartbeat failures.

The `observability` profile adds Prometheus and Grafana with a provisioned
dashboard and six alert rules (monitor down, scenario stale, scenario
failing, success ratio below 90% in 6 hours, only skipped runs for 6 hours,
alerts not delivered):

```sh
cp grafana.env.example .env.grafana   # set GF_SECURITY_ADMIN_PASSWORD
docker compose --profile observability up -d
```

Prometheus listens on `127.0.0.1:9090` and Grafana on `127.0.0.1:3000`
(`PROMETHEUS_PORT` and `GRAFANA_PORT` change the host side). Grafana refuses to
start without a password; the password applies on the first start of the
`grafana-data` volume, later use `grafana cli admin reset-admin-password`. Prometheus
reads `deploy/prometheus/` at start: after a change run `docker compose kill -s HUP
prometheus`. When Grafana is upgraded, check the `schemaVersion` of the
dashboard together with it. The
files under `deploy/` must stay readable by the containers (755 for
directories, 644 for files).

With `HEARTBEAT_URL` set (for example a healthchecks.io check), the monitor
pings it every `HEARTBEAT_INTERVAL_MS` while its scheduler and history work, no
scenario is stuck, alerts are delivered, and every scenario except
`endpoints-probe` has ended a run with a verdict (passed or failed; an aborted
run does not count) within its interval plus its run limit (run, cleanup and
grace time). Configure the check with a period of 1 minute and a grace time of
15 minutes; the defaults of healthchecks.io (1 day, 1 hour) would report a dead
monitor a day late. The heartbeat also stops when alerts cannot reach codex.bot
for more than 30 minutes, so healthchecks reports the monitor as silent in that
case too.

### Running a check by hand

With `RUN_TOKEN` set, `POST /runs/<scenario>` on the internal port starts a run
at once:

```sh
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" "http://127.0.0.1:8090/runs/send-and-receive-event?wait=true"
```

The answer is 202 with the run id, or 200 with the full result when
`?wait=true` and the run ends within its limit; 409 while the scenario is
running and 429 within `MANUAL_MIN_INTERVAL_MS` of the previous manual run.

### Endpoints probe

`endpoints-probe` checks the collector, the API and, with `GARAGE_URL`, that
Garage serves its page and script bundle, every `PROBE_INTERVAL_MS`, without
sending events. Its runs are hidden from `GET /runs` and `history` unless
asked for by name, kept for `PROBE_RETENTION_DAYS`, and alert after
`PROBE_ALERT_AFTER_FAILURES` failures in a row.

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
- [x] observability: Prometheus metrics, Grafana dashboard, heartbeat, manual runs, endpoints probe
- [ ] telegram delivery
