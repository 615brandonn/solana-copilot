// Pure price-tick sanity gate. A SINGLE tick must never move money: one corrupted
// feed value once sold 60% of a live position at a fictional +497,982% "gain".
// This intentionally does NOT cap absolute moves — memecoins really do run 100x,
// and a naive cap would also block a real stop-loss during a rug. Instead an
// outlier tick must be confirmed by repeated agreeing ticks before it is trusted.

export type PriceSanityConfig = {
  maxEntryMultiple: number;
  maxTickJump: number;
  confirmTicks: number;
  agreementTolerance: number;
};

export const DEFAULT_PRICE_SANITY: PriceSanityConfig = {
  maxEntryMultiple: 100,
  maxTickJump: 20,
  confirmTicks: 3,
  agreementTolerance: 0.25,
};

export type PriceSanityState = {
  lastGood?: number;
  pending?: { price: number; count: number };
};

export type PriceSanityResult = {
  accepted: boolean;
  state: PriceSanityState;
  reason?: string;
  entryMultiple?: number;
  tickJump?: number;
  confirmedOutlier?: boolean;
};

/** Ratio of two positive numbers, always expressed as >= 1 in either direction. */
function symmetricRatio(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 1;
  return a >= b ? a / b : b / a;
}

export function checkPriceSanity(
  price: number,
  entry: number,
  state: PriceSanityState = {},
  config: PriceSanityConfig = DEFAULT_PRICE_SANITY,
): PriceSanityResult {
  if (!Number.isFinite(price) || price <= 0) {
    return { accepted: false, state, reason: "non-positive price" };
  }
  if (!Number.isFinite(entry) || entry <= 0) {
    // No baseline to judge against; pass through rather than invent one.
    return { accepted: true, state: { lastGood: price } };
  }

  const entryMultiple = price / entry;
  const tickJump = state.lastGood === undefined ? 1 : symmetricRatio(price, state.lastGood);

  if (entryMultiple <= config.maxEntryMultiple && tickJump <= config.maxTickJump) {
    return { accepted: true, state: { lastGood: price }, entryMultiple, tickJump };
  }

  // Outlier: require agreeing confirmations before it can drive an exit.
  const agrees =
    state.pending !== undefined &&
    symmetricRatio(price, state.pending.price) <= 1 + config.agreementTolerance;
  const count = agrees ? (state.pending?.count ?? 0) + 1 : 1;

  if (count >= config.confirmTicks) {
    return {
      accepted: true,
      state: { lastGood: price },
      entryMultiple,
      tickJump,
      confirmedOutlier: true,
    };
  }

  const breached =
    entryMultiple > config.maxEntryMultiple
      ? `price ${entryMultiple.toFixed(1)}x entry exceeds ${config.maxEntryMultiple}x cap`
      : `tick jump ${tickJump.toFixed(1)}x exceeds ${config.maxTickJump}x cap`;
  return {
    accepted: false,
    // Preserve the previous good price: a rejected tick must not become the baseline.
    state: { lastGood: state.lastGood, pending: { price, count } },
    reason: `${breached}; ${count}/${config.confirmTicks} confirmations`,
    entryMultiple,
    tickJump,
  };
}

type PriceSanityConfigSource = {
  price_sanity_max_entry_multiple?: number | null;
  price_sanity_max_tick_jump?: number | null;
  price_sanity_confirm_ticks?: number | null;
};

function positiveOr(value: unknown, floor: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < floor) return fallback;
  return num;
}

export function priceSanityConfigFrom(
  cfg: PriceSanityConfigSource | null | undefined,
  fallback: PriceSanityConfig = DEFAULT_PRICE_SANITY,
): PriceSanityConfig {
  return {
    maxEntryMultiple: positiveOr(
      cfg?.price_sanity_max_entry_multiple,
      1.5,
      fallback.maxEntryMultiple,
    ),
    maxTickJump: positiveOr(cfg?.price_sanity_max_tick_jump, 1.5, fallback.maxTickJump),
    confirmTicks: Math.floor(positiveOr(cfg?.price_sanity_confirm_ticks, 1, fallback.confirmTicks)),
    agreementTolerance: fallback.agreementTolerance,
  };
}
