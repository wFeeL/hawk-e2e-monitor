/** Name of the scenario that sends an event and waits for it in Hawk. */
export const SEND_AND_RECEIVE_EVENT = 'send-and-receive-event';

/** Name of the scenario that also waits for the notification Hawk sends about the event. */
export const CHECK_NOTIFICATION = 'check-notification';

/** Name of the scenario that checks that the collector, the API and Garage answer, without sending an event. */
export const ENDPOINTS_PROBE = 'endpoints-probe';

/** All scenarios; a new one is appended at the end. */
export const SCENARIO_NAMES = [
  SEND_AND_RECEIVE_EVENT,
  CHECK_NOTIFICATION,
  ENDPOINTS_PROBE,
] as const;

/** Name of a scenario in titles and results. */
export type ScenarioName = typeof SCENARIO_NAMES[number];

/** What the rest of the service needs to know about a scenario beyond its runner. */
export interface ScenarioTraits {
  /** The scenario sends test events to Hawk, so it counts against the rate limits and leaves events for the sweep. */
  sendsEvents: boolean;
  /** A fresh verdict of the scenario is required for the heartbeat. */
  inHeartbeat: boolean;
  /** `GET /runs` and `history` leave its rows out unless the scenario is named. */
  hiddenByDefault: boolean;
}

/** One row per scenario; a new scenario is added here. */
export const SCENARIO_TRAITS: Readonly<Record<ScenarioName, ScenarioTraits>> = {
  [SEND_AND_RECEIVE_EVENT]: { sendsEvents: true,
    inHeartbeat: true,
    hiddenByDefault: false },
  [CHECK_NOTIFICATION]: { sendsEvents: true,
    inHeartbeat: true,
    hiddenByDefault: false },
  [ENDPOINTS_PROBE]: { sendsEvents: false,
    inHeartbeat: false,
    hiddenByDefault: true },
};

/** Scenarios that send test events. */
export const EVENT_SCENARIOS: readonly ScenarioName[] = SCENARIO_NAMES.filter(name => SCENARIO_TRAITS[name].sendsEvents);
