# hawk-e2e-monitor

Synthetic end-to-end monitoring for [Hawk](https://hawk.so). The service runs
on its own, next to Hawk and independent of its deploys. On a schedule it sends
test error events through Hawk's public integration interface and checks that
each one goes the whole way: the collector accepts it, the workers process it,
it shows up in the right project through the API, and Hawk sends a
notification about it. Failed checks are reported to Telegram through
@codex_bot with the stage that failed, the likely culprit and the time of every
stage.

| Scenario | What it proves | Runs by default |
|---|---|---|
| send-and-receive-event | an event sent over HTTP or WebSocket is accepted, processed and visible with the expected fields; a repeated event is grouped | every 10 minutes |
| check-notification | Hawk formed a notification for the event and sent it through the webhook and loop channels; a threshold rule fires on the second occurrence | every 10 minutes |
| sourcemaps | a release with a source map is saved and an event of that release points to the original file and line | hourly |
| sentry-envelope | an event sent the way a Sentry SDK does reaches Hawk | hourly |
| telegram-delivery | a Hawk notification reaches a Telegram chat | off, needs a bot |
| endpoints-probe | the collector, the API and Garage answer, without sending events | off |
| new-project | a new project's token is accepted by the collector | off, only for a Hawk you own |

Each scenario also runs as a one-off command for diagnosis.

## What you need from Hawk

The service works against any Hawk instance, hawk.so or self-hosted, but it
needs access to a working one:

- a dedicated project for the monitor, with no grouping pattern that matches
  titles starting with `[e2e:`;
- the integration token of that project;
- an account that is an admin of the project's workspace (email and password).
  The monitor logs in to read events through the GraphQL API, to remove its
  test events after each run and to manage its own notification rules in the
  project.

In Garage (the Hawk web app): create the project, then take its id from the
address of the project page (`/project/<id>`, 24 hex characters) and its token
from the project's Settings, Integrations. Workspace admins are set in the
workspace's Settings, Team (Grant Admin).

check-notification and telegram-delivery also need:

- a public https address for the notification receiver. Hawk accepts only
  public addresses for webhook and loop channels. A cloudflared quick tunnel
  works and needs no account; compose starts one;
- the notifier and the webhook and loop senders running in Hawk (they run on
  hawk.so).

Use a dedicated project and workspace: the receiver secret is part of the
rule's channel addresses, every member of the workspace can read it in the
project settings, and Hawk's sender writes the address to its logs.

## Quick start with Docker Compose

Requirements: Docker Engine 25 or newer with Compose 2.24 or newer (or podman
5 with `podman compose`), and the Hawk access listed above.

```sh
git clone https://github.com/wFeeL/hawk-e2e-monitor.git
cd hawk-e2e-monitor
cp .env.example .env
```

Fill in `.env`. The minimum is:

| Variable | Value |
|---|---|
| `INSTANCE_ID` | a name of this monitor, 1-32 characters of `a-z`, `0-9` and `-`, at most 12 digits and no scenario name inside; it goes into every test event |
| `HAWK_API_URL` | the GraphQL address, `https://api.hawk.so/graphql` for hawk.so |
| `HAWK_COLLECTOR_URL` | empty for hawk.so (derived from the token), the collector address otherwise |
| `HAWK_PROJECT_ID`, `HAWK_INTEGRATION_TOKEN` | the dedicated project and its token |
| `HAWK_EMAIL`, `HAWK_PASSWORD` | the workspace admin account |
| `RECEIVER_SECRET` | at least 32 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, for example `openssl rand -hex 24`; needed while check-notification or telegram-delivery is in `SCENARIOS` (it is by default) |
| `ALERT_NOTIFY_URL` | the address @codex_bot gives after `/notify_start` (see [Alerts](#alerts)); empty sends alerts to the log only |

Leave `TUNNEL_METRICS_URL` and `PUBLIC_BASE_URL` unset: compose points the
monitor at its cloudflared container. Values that contain `$` go in single
quotes. Then:

```sh
docker compose up -d --build
docker compose ps                                   # monitor becomes healthy within about 15 s
docker compose logs -f monitor                      # the first runs start right away
docker compose exec monitor node dist/main.js history --limit 10
```

A configuration error stops the monitor at startup with a message that names
the variable; `docker compose logs monitor` shows it.

When Hawk runs on the same host, point `HAWK_API_URL` and `HAWK_COLLECTOR_URL`
at `host.docker.internal` and make Hawk listen on an address the containers
can reach. With Docker on Linux, `host.docker.internal` is the address of the
`docker0` bridge, so a Hawk published only on `127.0.0.1` refuses the
connection. Publish Hawk on the bridge address too, or attach the monitor to
the network of the Hawk containers with a compose override and use their
service names.

## Architecture

```
                         hawk-e2e-monitor (one Node.js process)
  +-------------------------------------------------------------------------+
  |  scheduler ---> scenario run ---> stages ---> collector client ---------+--> Hawk collector
  |      |              |                         (HTTP, WebSocket, release, |    (events, releases)
  |      |              |                          Sentry envelope)          |
  |      |              |                         Hawk API client ----------+--> Hawk API (GraphQL)
  |      |              v                                                    |
  |      |        history (SQLite) <--- internal HTTP :8090 <----------------+--- health checks, Prometheus,
  |      |              |               /healthz /readyz /runs /stats        |    manual runs
  |      |              |               /metrics POST /runs/<scenario>       |
  |      v              v                                                    |
  |  sweep, lease    alerter -----------------------------------------------+--> @codex_bot (alerts)
  |                  heartbeat ---------------------------------------------+--> heartbeat service
  |                                                                          |
  |  receiver :8091 /hooks/<channel>/<secret> <--- cloudflared <-------------+--- Hawk webhook and loop senders
  |  Telegram reader (getUpdates) <------------------------------------------+--- Telegram group with @codex_bot
  +-------------------------------------------------------------------------+
```

The monitor talks to Hawk only through its public interfaces: the collector,
the GraphQL API and the notification channels. It needs no access to Hawk's
databases or queues, so the same build runs against hawk.so and against a
local Hawk.

### One run

A run is a chain of stages. Each stage has its own timeout, records its
duration and details, and either passes or ends the run with an error class.
send-and-receive-event goes through these stages:

| Stage | What it checks |
|---|---|
| `collector_availability` | the collector's `/health` and its token check over WebSocket |
| `api_availability` | login or token refresh, the project token, the workspace is not blocked, the quota left |
| `collector_accept` | the collector accepted the event (HTTP 200 or the WebSocket answer) |
| `event_visible` | the event shows up in the project through the API with the expected fields |
| `event_repeated` | on repeat runs, a second identical event is grouped and counted |
| `cleanup` | the test event is removed |

The other scenarios reuse these stages and add their own: `notification_setup`,
`notification_formed` and `threshold_formed` for check-notification,
`release_uploaded` and `release_saved` for sourcemaps, `telegram_ready`,
`telegram_delivered` and `telegram_probe` for telegram-delivery,
`project_created` and `token_accepted` for new-project, `garage_availability`
for endpoints-probe.

Waiting is condition-based. Stages poll the API with a growing pause and a
deadline instead of sleeping a fixed time, and a poll result is one of found,
not found (the API answered, the event is not there) or API error. Network
errors and 5xx answers are retried (`RETRY_ATTEMPTS`, `RETRY_DELAYS_MS`) only
where a retry cannot change anything twice: reads of the API, mutations that
can safely repeat (login, token refresh, rule update and delete), event
removal with a recheck that the event is gone, and sends to the collector that
failed before the event could reach it. An event the
collector may have received is never sent again, and API mutations that create
something are not retried. The whole run has its
own limit (`RUN_TIMEOUT_MS`), and the configuration check refuses stage
timeouts that do not fit into it.

### How a test event is identified

Every run gets a random 16-character `runId` (`r` and 15 random letters). The
event title is `[e2e:<INSTANCE_ID>] <runId> <scenario>`, and `context` carries
`runId`, `instanceId` and the scenario. sentry-envelope events get the
exception type in front of the title (`E2eMonitorCheck: `) and carry the same
fields under `context.e2e`. Hawk groups events by title, so every run makes
a new event, runs never see each other's events, and two monitors with
different `INSTANCE_ID` can share a project. The check compares the title,
`context`, the catcher type, the count and the fields Garage shows in the event
card. Cleanup removes only the event of its own run and refuses to remove
anything else (`cleanup_refused`).

### Notification rules

check-notification and telegram-delivery manage rules of their own in the
project: each rule's including filter is exactly `[e2e:<INSTANCE_ID>]`, and
its excluding filter lists the other scenarios, so every rule fires only for
its own scenario. The monitor treats every rule whose including filter is
exactly `[e2e:<INSTANCE_ID>]` as its own and changes or deletes only those, so
do not create such rules by hand. Hawk's
notifier caches rules for about a minute, so a run that had to create or
change a rule skips the notification stage once (`RULE_CACHE_WARMUP_MS`)
instead of failing.

The receiver listens on `/hooks/<channel>/<secret>` and matches notifications
to the waiting run by `runId` in the title.

### Errors and diagnosis

A failed run ends with one of 58 error classes, for example
`collector_unavailable`, `quota_exhausted`, `event_not_found` or
`notification_timeout`. The class carries a readable message and the likely
culprit: `hawk`, `monitor`, `config` or `network`. The collector's 402 answers
are told apart by their text (quota, rate limit or a failure of its Redis).
The result keeps the details of every stage with secrets masked.

### Storage and state

History lives in SQLite (`DATABASE_PATH`, the `monitor-data` volume in compose):
runs, stages, alert state and the alert outbox. It survives restarts and image
updates, and old runs are removed after `HISTORY_RETENTION_DAYS`. A lease in
the same database makes sure only one `serve` works on it. The schedule is
counted from the last run in the history, so a restart does not reset it.

### Source layout

| Directory | Contents |
|---|---|
| `src/config` | environment variables, validated with zod at startup |
| `src/clients` | collector, Hawk API, Telegram and @codex_bot clients, each call with a timeout |
| `src/engine` | stages, deadlines, polling, run results |
| `src/scenarios` | one directory per scenario |
| `src/notifications`, `src/receiver` | notification rules and the receiver |
| `src/scheduler`, `src/serve` | the schedule and the long-running process |
| `src/storage` | SQLite history, lease and state |
| `src/alerting`, `src/heartbeat`, `src/metrics` | alerts, heartbeat and Prometheus metrics |
| `src/errors` | error classes, messages and secret masking |
| `src/commands`, `src/cli.ts`, `src/main.ts` | the CLI commands `check`, `provision`, `history` and `serve` |
| `src/cleanup` | the hourly sweep of events and projects left by interrupted runs |
| `src/net`, `src/http`, `src/hawk`, `src/time`, `src/log` | HTTP and WebSocket helpers with error classification, the internal HTTP server, token parsing, clocks and logging |
| `test/` | unit tests with the same layout, fakes in `test/support`, live checks in `test/e2e` |

Runtime dependencies are `zod` and `prom-client`; HTTP, WebSocket and SQLite
come from Node.js 26.

## Running checks by hand

Requirements: Node.js 26 and the Hawk access above.

```sh
npm ci
npm run build
cp .env.example .env   # fill it in as in the quick start
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
the stage, the error class, the culprit and a readable message.

check-notification needs a public address for the receiver. Start a quick
tunnel:

```sh
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8091 --metrics 127.0.0.1:20241
```

then set `RECEIVER_SECRET` and `TUNNEL_METRICS_URL=http://127.0.0.1:20241` (or
`PUBLIC_BASE_URL` for a fixed address) in `.env` and run:

```sh
node --env-file-if-exists=.env dist/main.js provision      # creates the rules, waits 65 s for Hawk to reload them
node --env-file-if-exists=.env dist/main.js check check-notification
```

`provision` is optional: the check brings the rules to the expected state
itself, but a run that had to change a rule skips the notification stage while
Hawk's notifier still caches the old rules. After `provision --no-wait` the
next `check check-notification` first waits out the rest of that time. The check
takes the same `--sequence`, `--transport` and `--repeat` options. A run where
only one of the two channels arrived passes with a warning.

In compose, `serve` holds the database, so `check` and `provision` refuse to
run inside the container. Start a run through `serve` instead, with
`POST /runs/<scenario>` (see [Manual runs](#manual-runs)).

`check` and `provision` refuse to run while `serve` works on the same
database, so that two processes do not change the notification rules at once.
They also refuse when the database file exists but cannot be opened, because
then they cannot tell whether `serve` is running. A `check check-notification`
started within `RULE_CACHE_WARMUP_MS` of a rule change first waits for Hawk to
reload the rules.

That guard sees only one database file. A `check` on the host next to a
monitor in compose works on another file, so nothing stops it, and with the
same `INSTANCE_ID` both processes own the same rules. The hand run points them
at its own tunnel; a monitor run waiting for a notification at that moment ends
in `notification_timeout` with Hawk to blame, and the monitor's next run moves
the rules back and skips the notification stage. While a monitor works on the
project, give hand runs their own `INSTANCE_ID`.

Tests:

```sh
npm test                                          # unit tests against a fake Hawk, no network
set -a && . ./.env && set +a
E2E_HAWK=1 npm run test:e2e                       # checks against the Hawk in .env
```

Without `E2E_HAWK=1`, `npm run test:e2e` skips the live checks.

## Scenarios in detail

Every scenario that sends an event reads it back with the same queries Garage
uses. A grouping pattern of the project that would catch the monitor's titles
is reported as degraded (`grouping_pattern`).

- **Late copies.** Before cleanup the check waits `LATE_DUPLICATE_WAIT_MS`
  (5 s) and reads the event count once more: a count that grew after the
  check means Hawk counted a late copy, and the run fails with
  `duplicate_event`. Set it to 0 to recheck at once, without the pause.
- **Threshold rule.** check-notification keeps a second rule for the instance
  that Hawk sends on the second event of the same error within an hour. On
  repeat runs (`REPEAT_EVERY_N_RUNS`) the stage `threshold_formed` waits for
  exactly one threshold webhook after the repeat. A threshold webhook before
  the repeat fails the run with `threshold_early`.
- **sourcemaps**, hourly (`SOURCEMAPS_INTERVAL_MS`). Uploads a release
  `e2e-<INSTANCE_ID>-<runId>` with a small source map to the collector, waits
  until Hawk lists the file (`RELEASE_SAVE_TIMEOUT_MS`), sends a JavaScript
  event of that release and checks that the frame points to the original file,
  line and source lines. Hawk has no API to remove a release, so these releases
  stay in the test project until Hawk's archiver removes old ones.
- **sentry-envelope**, hourly (`SENTRY_ENVELOPE_INTERVAL_MS`). Sends an event
  through the Sentry endpoint of the collector (`/api/0/envelope/`), the way a
  Sentry SDK pointed at Hawk does, and checks the event in Hawk.
- **endpoints-probe**, every `PROBE_INTERVAL_MS`, off by default. Checks the
  collector, the API and, with `GARAGE_URL`, that Garage serves its page and
  script bundle, without sending events. Its runs are hidden from `GET /runs`
  and `history` unless asked for by name, kept for `PROBE_RETENTION_DAYS`, and
  alert after `PROBE_ALERT_AFTER_FAILURES` failures in a row.
- **new-project**, daily (`NEW_PROJECT_INTERVAL_MS`), off by default. Creates
  a project in the workspace of `HAWK_PROJECT_ID`, waits until the collector
  accepts its new token (`NEW_PROJECT_TOKEN_TIMEOUT_MS`, the collector reloads
  tokens periodically), sends an event, finds it and removes the project. The
  account must be an admin of the workspace. Run it only against a Hawk you
  own: Hawk may post every created project to a team chat
  (`TELEGRAM_MAIN_CHAT_URL` of the API). Projects left by an interrupted run
  are removed by the sweep. The sweep only removes projects that the monitor
  recorded in its history, that carry its name pattern, sit in the same
  workspace and are older than `SWEEP_MIN_AGE_MS`.

### telegram-delivery

Hourly (`TELEGRAM_DELIVERY_INTERVAL_MS`), off by default. Checks that a Hawk
notification reaches a Telegram chat. It is a separate scenario so that an
outage of Telegram does not hide problems in Hawk's own pipeline.

The monitor keeps a third notification rule with two channels: Telegram,
through the @codex_bot address of a test group, and a webhook to its receiver.
After the event is sent, a bot of yours reads the group and waits for the
message of @codex_bot that starts with the run's title
(`TELEGRAM_DELIVERY_TIMEOUT_MS`). If the webhook arrived but the message did
not, the monitor posts a probe through @codex_bot itself. When the probe
arrives, Hawk's Telegram worker is at fault (`telegram_not_delivered`). When
the probe does not arrive either, @codex_bot or Telegram is
(`telegram_bot_unavailable`).

Setup:

1. Create a bot with @BotFather (`/newbot`). In its settings, enable
   Bot-to-Bot Communication Mode and turn Group Privacy off (`/setprivacy`,
   Disable). Without both, the bot does not see messages of @codex_bot.
2. Create a group for these checks only and add @codex_bot and your bot. Make
   your bot an administrator.
3. Send `/notify_start` in the group. Put the address @codex_bot answers with
   into `TELEGRAM_NOTIFY_URL`, and the bot token into `TELEGRAM_BOT_TOKEN`.
   Set `TELEGRAM_CHAT_ID` to the id of the group: then only messages of that
   group count, and every run first checks that the bot is still an
   administrator there. Without it, a bot that lost the group looks like a
   silent @codex_bot.
4. Add `telegram-delivery` to `SCENARIOS`.

Other settings: `TELEGRAM_SENDER_USERNAME` (`codex_bot`),
`TELEGRAM_DELIVERY_TIMEOUT_MS` (120000), `TELEGRAM_PROBE_TIMEOUT_MS` (30000)
and `TELEGRAM_API_URL` (`https://api.telegram.org`).

Only one process at a time may read a bot token (Telegram answers 409 to a
second reader), so do not share the bot between two monitors. The scenario
needs `RECEIVER_SECRET` and a public address, as check-notification does. On
the first deploy of a build with this scenario, the other two rules get
`telegram-delivery` in their excluding list, whether the scenario is selected
or not, so check-notification skips its notification stage once for the rule
cache warmup. A build older than this scenario deletes the telegram rule as an
extra rule when it provisions.

## Configuration

All settings come from environment variables (`.env` for the CLI, `env_file`
in compose). `.env.example` lists every variable with its default and a short
note. Under compose, `RECEIVER_PORT`, `INTERNAL_PORT`, `RECEIVER_HOST`,
`INTERNAL_HOST`, `TUNNEL_METRICS_URL` and `DATABASE_PATH` are fixed in
`compose.yaml`, and their values in `.env` are ignored; the image itself sets
both hosts to `0.0.0.0`. The configuration is validated at startup: limits, formats and the
dependencies between values (for example, the stage timeouts of a scenario
must fit into `RUN_TIMEOUT_MS`), and the error names the variable.

| Group | Variables |
|---|---|
| Hawk | `INSTANCE_ID`, `HAWK_API_URL`, `HAWK_COLLECTOR_URL`, `HAWK_PROJECT_ID`, `HAWK_INTEGRATION_TOKEN`, `HAWK_EMAIL`, `HAWK_PASSWORD` |
| Service | `LOG_LEVEL`, `INTERNAL_PORT`, `INTERNAL_HOST` and `RECEIVER_HOST` (`127.0.0.1` by default, compose sets `0.0.0.0` inside the container), `SHUTDOWN_TIMEOUT_MS`, `HEALTH_CHECK_TIMEOUT_MS` |
| Schedule | `SCENARIOS`, `CHECK_INTERVAL_MS` (10 minutes), `SOURCEMAPS_INTERVAL_MS`, `SENTRY_ENVELOPE_INTERVAL_MS`, `TELEGRAM_DELIVERY_INTERVAL_MS`, `NEW_PROJECT_INTERVAL_MS`, `PROBE_INTERVAL_MS`, `SCENARIO_STAGGER_MS` |
| Timeouts | `HTTP_TIMEOUT_MS`, `COLLECTOR_AVAILABILITY_TIMEOUT_MS`, `API_AVAILABILITY_TIMEOUT_MS`, `COLLECTOR_ACCEPT_TIMEOUT_MS`, `EVENT_VISIBLE_TIMEOUT_MS`, `EVENT_REPEATED_TIMEOUT_MS`, `NOTIFICATION_TIMEOUT_MS`, `NOTIFICATION_SETUP_TIMEOUT_MS`, `CLEANUP_TIMEOUT_MS`, `RUN_TIMEOUT_MS`, `WATCHDOG_GRACE_MS` and the scenario-specific ones |
| Retries | `RETRY_ATTEMPTS`, `RETRY_DELAYS_MS` |
| Events | `TRANSPORT_MODE` (`alternate`, `http` or `ws`), `REPEAT_EVERY_N_RUNS` |
| Notifications | `RECEIVER_PORT`, `RECEIVER_SECRET`, `PUBLIC_BASE_URL` or `TUNNEL_METRICS_URL`, `NOTIFY_LOOP`, `RULE_CACHE_WARMUP_MS` |
| Alerts | `ALERT_NOTIFY_URL`, `ALERT_AFTER_FAILURES`, `ALERT_RETRY_MS` |
| History and cleanup | `DATABASE_PATH`, `HISTORY_RETENTION_DAYS`, `SWEEP_INTERVAL_MS`, `SWEEP_MIN_AGE_MS` |
| Observability | `HEARTBEAT_URL`, `HEARTBEAT_INTERVAL_MS`, `RUN_TOKEN`, `MANUAL_MIN_INTERVAL_MS`, `GARAGE_URL` |
| Telegram | `TELEGRAM_*`, see [telegram-delivery](#telegram-delivery) |

Without `SCENARIOS`, `serve` runs send-and-receive-event, check-notification,
sourcemaps and sentry-envelope.

## Running continuously

`serve` is the default command of the container image. With an empty history
it starts the first scenario listed in `SCENARIOS` right away and each next one
`SCENARIO_STAGGER_MS` later. After that every scenario runs again one interval
after the start of its previous run, also across restarts of the monitor, so
the first run after a restart can take up to one interval. check-notification
and telegram-delivery first wait up to `TUNNEL_READY_TIMEOUT_MS` for the tunnel
to report its address (once per process; both share one receiver). A tick that
comes while the previous run of the same scenario is still going is recorded
as skipped.

Only the internal port is published, on `127.0.0.1:8090`
(`MONITOR_INTERNAL_PORT` changes the host side):

| Path | Answer |
|---|---|
| `GET /healthz` | 200 while the scheduler ticks, the history database works and no scenario is stuck busy; 503 with the reason otherwise |
| `GET /readyz` | 200 once startup finished, while the receiver is open and no alert has waited for delivery longer than 30 minutes |
| `GET /runs?scenario=<name>&limit=<n>` | latest runs, newest first |
| `GET /runs/<runId>` | the full result of one run: every stage, its duration and details |
| `GET /stats` | success ratio, event latency percentiles and average stage durations |
| `GET /metrics` | Prometheus metrics |
| `POST /runs/<scenario>` | a manual run, see [Manual runs](#manual-runs) |

The same history is available from the command line:

```sh
docker compose exec monitor node dist/main.js history --limit 20
docker compose exec monitor node dist/main.js history --stats
```

### Alerts

Add @codex_bot to a Telegram chat, send it `/notify_start` and put the address
it answers with into `ALERT_NOTIFY_URL`. The monitor sends a message when a
scenario starts failing (after `ALERT_AFTER_FAILURES` failed runs in a row;
new-project alerts on the first failure),
when the reason of the failure changes, when it recovers, and when it becomes
degraded: a run passed but only one notification channel arrived, the
collector did not confirm an event that still reached Hawk (users' SDKs would
see an error there), less than 10% of the workspace event quota is left, a
grouping pattern of the project catches the monitor's titles, or a JavaScript
event shows no trace of the JavaScript worker. A
message names the stage, the error class, the likely culprit and the time of
every stage. Messages that the bot does not accept are retried with a growing
pause for up to 24 hours.

### Restarts and failures

- Restarts and deploys of Hawk show up as failed runs with the stage and the
  error class. The monitor keeps running, and the next run after Hawk is back
  passes and sends a recovery message.
- A run cut short by a restart of the monitor is recorded as aborted with
  `monitor_restarted`, a run cut short by `docker compose stop` as
  `monitor_stopped`. Neither counts as a failure of Hawk.
- A run of send-and-receive-event or check-notification that does not finish
  within `RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS` is cancelled
  and recorded as `run_hung`. For the other scenarios the limit is the sum of
  the timeouts of their own stages plus `CLEANUP_TIMEOUT_MS` and
  `WATCHDOG_GRACE_MS`; for endpoints-probe it is the sum of its stage timeouts
  plus 10 seconds. `RUN_TIMEOUT_MS` must cover all stages of
  check-notification, including the threshold stage
  (`NOTIFICATION_TIMEOUT_MS + HTTP_TIMEOUT_MS`); the configuration check names
  the sum when it does not. After three such runs of one scenario in a row the
  process exits and the container restart policy starts it again.
- If the monitor container is recreated after a crash, the new container
  waits until the lease of the old process expires (up to 90 s) and shows as
  restarting meanwhile. A restart inside the same container waits one lease
  renewal period (35 s) to make sure the old process is gone. A `serve` that
  finds another process holding its lease exits, so two monitors never run on
  one database.
- Docker does not restart a container that is only unhealthy. When the
  tunnel shows as unhealthy and check-notification fails with
  `tunnel_unavailable`, restart it: `docker compose restart tunnel`.
- Every restart of cloudflared gives the quick tunnel a new address. The next
  check-notification run moves the rules to the new address and checks
  notifications through it in the same run.
- The volume is created owned by the `node` user (uid 1000) of the image. A
  bind mount or a volume created another way needs `chown 1000:1000`.
- With podman, containers restart after a host reboot only when the user
  services do: `loginctl enable-linger` and `systemctl --user enable
  podman-restart.service`.
- Test events left behind by failed or interrupted runs are removed once an
  hour (`SWEEP_INTERVAL_MS`) when they are older than `SWEEP_MIN_AGE_MS`.

Every run of each scenario sends one event, two on repeat runs; one scenario
every 10 minutes sends about 5,000 events a month (4,320 runs, every sixth
one repeats the event; the monitor logs its own estimate at startup). Hawk counts the quota from
the events that remain in a project, and the monitor removes its events after
each run, so they barely use the quota. They do count against the rate limits
of the collector.

## Metrics, dashboard and heartbeat

`GET /metrics` serves Prometheus metrics: runs and failures by scenario, stage,
error class and culprit, run, stage, event and notification latency
histograms, the last status and run time of every scenario, the alert queue
age and heartbeat failures.

Event latency runs from the moment the collector accepted the event to the API
read that found it. The monitor reads after 0.5, 1, 2 and 4 s and then every
5 s, each wait off by up to 20%, so the figure is an upper bound and can be
late by one wait: under a second for an event that shows up at once, up to
6 s for a slow one. Notification latency has no such step, because the
receiver stamps each webhook as it arrives.

The `observability` profile adds Prometheus and Grafana with a provisioned
dashboard and six alert rules (monitor down, scenario stale, scenario
failing, success ratio below 90% in 6 hours, only skipped runs for 6 hours,
alerts not delivered). Prometheus evaluates them and shows them on its Alerts
page and in Grafana. No Alertmanager is included, so they notify nobody: the
@codex_bot alerts and the heartbeat are the paths that notify. To start them:

```sh
cp grafana.env.example .env.grafana   # set GF_SECURITY_ADMIN_PASSWORD
docker compose --profile observability up -d
```

Prometheus listens on `127.0.0.1:9090` and Grafana on `127.0.0.1:3000`
(`PROMETHEUS_PORT` and `GRAFANA_PORT` change the host side). Grafana refuses to
start without a password; the password applies on the first start of the
`grafana-data` volume, later use `grafana cli admin reset-admin-password`.
Prometheus reads `deploy/prometheus/` at start: after a change run
`docker compose kill -s HUP prometheus`. When Grafana is upgraded, check the
`schemaVersion` of the dashboard together with it. The files under `deploy/`
must stay readable by the containers (755 for directories, 644 for files).

The heartbeat catches the case where the monitor itself stops working. Set
`HEARTBEAT_URL` to the ping address of an external service (a Cronitor
heartbeat or a healthchecks.io check, for example). The monitor pings it every
`HEARTBEAT_INTERVAL_MS` while its scheduler and history work, no scenario is
stuck, alerts are delivered, and every scenario except endpoints-probe has
ended a run with a verdict (passed or failed; an aborted run does not count)
within its interval plus its run limit. Configure the service to expect a ping
every minute and to alert after about 15 minutes without one; a default of
one day would report a dead monitor a day late. The heartbeat also stops when
alerts cannot reach codex.bot for more than 30 minutes, or as soon as
codex.bot rejects three alerts in a row (a wrong `ALERT_NOTIFY_URL`, for
example), so the external service reports the monitor as silent in those cases
too.

### Manual runs

With `RUN_TOKEN` set (at least 32 characters), `POST /runs/<scenario>` on the
internal port starts a run of a scenario listed in `SCENARIOS` at once:

```sh
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" "http://127.0.0.1:8090/runs/send-and-receive-event?wait=true"
```

The answer is 202 with the run id, or 200 with the full result when
`?wait=true` and the run ends within its limit; 409 while the scenario is
running, 429 within `MANUAL_MIN_INTERVAL_MS` of the previous manual run and 404
for a scenario that is not in `SCENARIOS`.

## About this test assignment

This repository is a test assignment for CodeX.

What was checked:

- Unit tests run against a fake Hawk on random ports, with fake clocks for
  deadlines.
- All scenarios ran against a local Hawk built from the CodeX repositories
  (collector, API, workers, notifier and senders), including stopped
  containers, restarts of the collector and the API, a killed monitor and a
  stopped Telegram worker.
- On 2026-11-15 send-and-receive-event (HTTP, WebSocket, repeat),
  check-notification (webhook, loop and threshold), sourcemaps,
  sentry-envelope, endpoints-probe and telegram-delivery passed against
  production hawk.so. new-project ran only against the local Hawk.
- Compose was run with podman 5.7 (`podman compose`), not with Docker.

Limitations:

- Check timeouts are fixed values from the configuration. The service does not
  compute degradation thresholds from collected data, although it records the
  duration of every stage for that.
- Which collector queue and worker processed an event is not visible from
  outside. The monitor checks that an event with the catcher type of each SDK
  goes all the way through.
- The monitor removes the test event when its run ends. A sender that is still
  late at that point fails to read the removed event, and Hawk reports that
  failure to its own error tracking: up to one error per missing channel in
  slow or failed runs. A notification that arrives after its run has finished
  finds no waiting run; the receiver answers it and the monitor only logs it.
- Alerts of the monitor itself go through @codex_bot. The monitor sees that the
  bot accepted an alert, not that it reached the chat. Delivery of Hawk's own
  notifications to Telegram is checked by telegram-delivery.
- telegram-delivery depends on Bot-to-Bot Communication Mode (Telegram Bot API
  10.0): without it a bot cannot read messages of another bot.
- check-notification needs outgoing access to Cloudflare from the monitor when
  a quick tunnel is used.

TODO:

- [x] send-and-receive-event
- [x] check-notification (webhook and loop channels)
- [x] continuous-monitoring: schedule, history, alerts, compose
- [x] observability: Prometheus metrics, Grafana dashboard, heartbeat, manual runs, endpoints probe
- [x] telegram delivery: Hawk notification found in a Telegram group by a bot, with a probe through @codex_bot
- [x] more scenarios: threshold rule, source maps, Sentry envelope, new project
- [ ] degradation thresholds computed from the collected stage durations
