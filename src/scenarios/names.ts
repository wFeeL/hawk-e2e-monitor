/** Name of the scenario that sends an event and waits for it in Hawk. */
export const SEND_AND_RECEIVE_EVENT = 'send-and-receive-event';

/** Name of the scenario that also waits for the notification Hawk sends about the event. */
export const CHECK_NOTIFICATION = 'check-notification';

/** Scenarios that send a test event. */
export const SCENARIO_NAMES = [SEND_AND_RECEIVE_EVENT, CHECK_NOTIFICATION] as const;

/** Name of a scenario in titles and results. */
export type ScenarioName = typeof SCENARIO_NAMES[number];
