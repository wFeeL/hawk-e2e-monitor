# Architecture

hawk-e2e-monitor is a standalone service that checks Hawk from the outside, the
way a user meets it. It sends test error events through the public integration
interface, then confirms through the public API and notification channels that
each event went through the whole pipeline, and records how long every stage
took.

The service talks to Hawk only through its public interfaces: the collector,
the GraphQL API and outgoing notifications. It needs no access to Hawk
databases or queues, so the same build can watch a local instance or
production.

## Modules

| Module | Responsibility | Boundary | Introduced by |
|---|---|---|---|
| `config` | Reads environment variables, validates them, produces a typed config and a log summary with secrets hidden | The only place that reads `process.env` | service skeleton |
| `log` | Structured JSON logs, to stdout by default | Never throws, so a logging failure cannot break a check. The `check` command sends logs to stderr, so stdout carries only the result | service skeleton |
| `http` | Internal port: `/healthz`, `/readyz`, later metrics and manual runs | Never exposed to the internet; answers about the monitor itself, not about Hawk | service skeleton |
| `receiver` | Public port that accepts Hawk webhooks | Serves the webhook path only, on a separate port from `http` | check-notification |
| `provisioning` | Brings the notification rule of the test project to the expected state | Idempotent, changes only what differs | check-notification |
| `clients` | Collector, GraphQL API and notification clients with timeouts | Every external call goes through a client, and every external error becomes a named error class | send-and-receive-event |
| `net` | HTTP requests and WebSocket exchanges with deadlines, classification of network failures, retries | Retries only when the request certainly did not leave the monitor | send-and-receive-event |
| `errors` | Error classes with the culprit (Hawk, monitor, configuration, network) and a human-readable text; masking of secrets | Every result and log line passes through the redactor | send-and-receive-event |
| `hawk` | Decoding of the integration token, collector addresses derived from it | Pure functions, no I/O | send-and-receive-event |
| `time` | Monotonic and wall clocks behind one interface | Passed as a parameter, so deadline tests run on a fake clock | send-and-receive-event |
| `commands` | Command-line commands, `check` runs one scenario and prints its result | Exit code 0 for ok, 1 for a failed run or a configuration error, 2 for wrong arguments | send-and-receive-event |
| `engine` | Runs scenario stages with deadlines and condition polling | Knows stages and deadlines, not Hawk specifics | send-and-receive-event |
| `scenarios` | The checks themselves: send and receive an event, notification, endpoint probe, Telegram delivery | Built from engine stages and clients | send-and-receive-event |
| `cleanup` | Removes test events; picking up events that arrive after their run comes with continuous monitoring | Touches only events created by this monitor instance; in the first version it is the last stage of the scenario | send-and-receive-event |
| `storage` | Run and stage history in SQLite | Survives container recreation through a named volume | continuous-monitoring |
| `alerting` | Telegram alerts on state changes: ok, failing, recovered | One message per transition, no repeats | continuous-monitoring |
| `metrics` | Prometheus metrics | Labels have a bounded set of values; run ids and error texts never become labels | observability |
| `heartbeat` | External ping after each run | Lets an outside service notice that the monitor itself stopped | observability |

The public webhook is served by a separate `receiver` server on its own port.
The internal server never takes routes from it, and its error log records the
request path without the query string.

## How a send-and-receive run works

A run gets a sequence number. Odd numbers send over HTTP with catcher type
`errors/nodejs`, even numbers over WebSocket with `errors/javascript`, the way
the Node and browser SDKs do. Every N-th run of a transport also sends the same
event a second time.

| Stage | What it checks |
|---|---|
| `collector_availability` | `/health` of the collector answers with both dependencies up; an unknown token sent over WebSocket is rejected with code 400 |
| `api_availability` | the monitor signs in, the project token in Hawk matches the configured one, the workspace is not blocked and has quota left |
| `collector_accept` | the collector confirms the event with code 200 |
| `event_visible` | the event shows up in the project's event list, its card has the sent title, context, catcher type and a count of 1 |
| `event_repeated` | in repeat runs, the second event is grouped with the first and the count becomes 2 |
| `cleanup` | the event is removed after a check that it belongs to this run and instance |

Each stage has its own time limit, and the whole run has one more. Cleanup has
a separate limit on top of the run limit, so a run that ran out of time still
removes its event. When the collector did not confirm an event (timeout, 5xx,
closed socket), the run keeps looking for it. If the API answered and the event
never appeared, the run is blamed on the collector, and the text names both
facts. The result is one JSON object with every stage, its duration and, on
failure, the stage, error class, culprit and text.

## Health and readiness

`/healthz` answers whether the monitor process is alive. `/readyz` answers
whether the monitor finished its own startup work. Neither depends on Hawk
being available: a broken Hawk is a check result, not a sick monitor. The
container healthcheck uses `/healthz` only.

## Fatal error policy

An unhandled promise rejection or an uncaught exception ends the process with
exit code 1. The container orchestrator restarts it. A run interrupted this
way is recorded as aborted and counts as a failed check, so a crash loop shows
up as an alert instead of hiding behind a green healthcheck.

Errors inside a single HTTP request are handled locally: the request gets a
500 response, the error is logged and the process keeps running.

## Decisions

| Decision | Rejected alternative | Price |
|---|---|---|
| npm with a lockfile | yarn, used by the Hawk team | differs from the team habit |
| ESM, `module: nodenext`, compiled with `tsc` into `dist/` | CommonJS; running TypeScript directly through Node type stripping | two tsconfig files and `.js` extensions in imports |
| TypeScript 6.0 | TypeScript 7.0 (native compiler) | typescript-eslint supports TypeScript below 6.1, so 7.0 would break typed linting |
| ESLint 9 with `eslint-config-codex` | ESLint 10 | `eslint-config-codex` 2.0.3 requires ESLint 9, which is out of upstream support |
| Configuration from environment variables only; a `.env` file through `node --env-file-if-exists` in development and `env_file` in compose | a YAML file; dotenv; reading `.env` from code | nested and list settings are awkward in env variables. The code never reads files, so behaviour does not depend on what lies in the working directory |
| zod validation, visibility of each field declared in the schema, hidden by default | manual checks; a separate list of secrets | one runtime dependency; a new field must be marked public to appear in the startup log |
| `HAWK_API_URL` and `INSTANCE_ID` are required | defaults pointing to production and a shared instance id | a little more setup, but a forgotten variable cannot send requests to production or mix two monitors in one project |
| Plain `node:http` for the internal and public ports | fastify, express | routing, body parsing and limits are written by hand; no framework dependency on the public port |
| Own JSON logger | pino | no transports or pretty printing |
| Fatal errors end the process | log and continue | an interrupted run is lost; the process never keeps running in an unknown state |
| Internal port 8090 bound to `127.0.0.1`, `0.0.0.0` inside the container | port 9100; always `0.0.0.0` | 9100 belongs to node_exporter, which often runs next to Prometheus; `0.0.0.0` on a host would expose internal endpoints to the local network |
| The Hawk project is prepared by a human and passed through configuration | the service creates the project itself | one manual setup step before the first run |
| No CI pipeline for lint and tests | GitHub Actions on push | checks run locally before each commit. The monitor itself does not depend on any CI system |
| Test events go out as raw HTTP POST and raw WebSocket messages | the `@hawk.so/nodejs` and `@hawk.so/javascript` SDKs | the SDKs do not return the collector's answer; the price is that the SDK code itself is not checked |
| Transport alternates by run number, repeats happen every N-th run of each transport | HTTP only; both transports in every run | HTTP only misses the browser path, both in every run doubles the use of the collector rate limit window. Each path is checked every second interval |
| Catcher types `errors/nodejs` and `errors/javascript` | `errors/default` | matches what the real SDKs send. Which queue and worker handled the event is not visible from outside; a broken worker shows up as a missing event on its transport |
| The invalid token probe goes over WebSocket with a constant token | over HTTP; no probe | an HTTP probe would add noise to the team's own Hawk. A failed WebSocket handshake is harder to diagnose, the HTTP `/health` of the same host makes up for it |
| Run ids are 16 Latin letters | time in base36 plus randomness; UUID | digits may be masked by the grouper's card number filter and change `context.runId`. The run id carries no time, the result does |
| The project token is compared decoded (`integrationId` and `secret` without dashes) | as a string | the collector compares it the same way, a string comparison fails on a re-encoded token. Costs a token decoder in the monitor |
| Quota and the blocked flag are checked before sending | send and watch for 402 | no event is spent. The counter is refreshed by Hawk on a schedule, so the check is approximate |
| Removal by `originalEventId` after checking that the event is ours | by the event id from the list; without the check | after a repeat the list returns the id of the repeat. Costs one card request, made by the visibility stage anyway |
| A POST is retried only before it was sent | retry on network errors and 5xx | a retry after sending duplicates the event and gives a false `duplicate_event`. A one-off failure after sending gives `uncertain` instead of a successful resend |
| A failed cleanup makes the run fail, but the run keeps the class of the first failure | a warning only | left-over test events break isolation from other users of the project. Costs an alert caused by removal while the event itself passed |
| The engine supports a group of parallel stages | sequential stages only | the notification check needs to wait for the event and the webhook together. The engine is more complex already in the first version |
| The fake Hawk used in tests tells requests apart by `operationName` and validates query texts against a schema fixture | a full GraphQL server; no schema check | a typo in a field would otherwise surface only on a live Hawk. The schema fixture must follow API changes |
| Durations are measured by the monitor with a monotonic clock | the event timestamp set by Hawk | the collector sets the time itself. The latency includes the network to the collector |
| A non-`hawk.so` API with an empty `HAWK_COLLECTOR_URL` is a configuration error | a startup warning | the token would route test events of a local stand to production. Changes the behaviour of the service skeleton |
| `HAWK_PROJECT_ID` must be 24 hex characters | any non-empty string | an invalid id makes the API answer `INTERNAL_SERVER_ERROR`, a false Hawk failure |
