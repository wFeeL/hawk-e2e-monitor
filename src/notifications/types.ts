/** Channels a test notification is checked on. */
export const CHANNELS = ['webhook', 'loop'] as const;

/** One of `CHANNELS`. */
export type NotificationChannel = (typeof CHANNELS)[number];

/** Settings of one channel of a rule. */
export interface ChannelSettings {
  /** Whether the channel receives notifications. */
  isEnabled: boolean;
  /** Where Hawk delivers them. */
  endpoint: string;
  /** Minimum seconds between notifications; Hawk defaults it to 60. */
  minPeriod?: number;
}

/** All channels of a rule; `webhook` is null in rules created before it existed. */
export interface NotificationChannels {
  /** Email channel. */
  email: ChannelSettings;
  /** Slack channel. */
  slack: ChannelSettings;
  /** Loop channel. */
  loop: ChannelSettings;
  /** Telegram channel. */
  telegram: ChannelSettings;
  /** Webhook channel. */
  webhook: ChannelSettings | null;
}

/** A notification rule as Hawk returns it. */
export interface NotificationRule {
  /** Rule id. */
  id: string;
  /** Whether the rule is on. */
  isEnabled: boolean;
  /** Which events trigger it. */
  whatToReceive: 'ONLY_NEW' | 'SEEN_MORE';
  /** Words of which at least one must be in the title; empty means any. */
  including: string[];
  /** Words that keep an event out. */
  excluding: string[];
  /** Channels of the rule. */
  channels: NotificationChannels;
  /** Threshold of `SEEN_MORE`. */
  threshold?: number | null;
  /** Period of `SEEN_MORE`, ms. */
  thresholdPeriod?: number | null;
}

/** What the monitor sends to create or replace a rule. */
export interface NotificationRuleInput {
  /** Project the rule belongs to. */
  projectId: string;
  /** Whether the rule is on. */
  isEnabled: boolean;
  /** Only new events, or every event once the threshold is reached. */
  whatToReceive: 'ONLY_NEW' | 'SEEN_MORE';
  /** Words of which at least one must be in the title. */
  including: string[];
  /** Words that keep an event out. */
  excluding: string[];
  /** Channels; Hawk needs all of them but the webhook, and the monitor sets the webhook. */
  channels: NotificationRuleInputChannels;
  /** Events of one group in the period that trigger a `SEEN_MORE` rule. */
  threshold?: number | null;
  /** Period of a `SEEN_MORE` rule, ms. */
  thresholdPeriod?: number | null;
}

/** Channels of a rule input: the webhook is always set. */
export type NotificationRuleInputChannels = Omit<NotificationChannels, 'webhook'> & NotificationWebhook;

/** The webhook part of the input channels. */
export interface NotificationWebhook {
  /** Webhook channel. */
  webhook: ChannelSettings;
}

/** A rule input that replaces an existing rule. */
export interface NotificationRuleUpdate extends NotificationRuleInput {
  /** Rule to replace. */
  ruleId: string;
}
