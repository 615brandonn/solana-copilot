export type AutomaticEntryStrategy = "regular" | "coordinated" | "conviction";

export type EntryStrategyConfig = {
  conviction_mode_enabled?: boolean;
  coordinated_mode_enabled?: boolean;
};

/**
 * Selects the one automatic entry strategy allowed to act for this config.
 *
 * Conviction Mode intentionally has the highest priority. The function is
 * pure and does not mutate either strategy's saved settings, so switching it
 * off immediately restores the previously selected legacy strategy.
 */
export function automaticEntryStrategy(config: EntryStrategyConfig): AutomaticEntryStrategy {
  if (config.conviction_mode_enabled === true) return "conviction";
  if (config.coordinated_mode_enabled === true) return "coordinated";
  return "regular";
}
