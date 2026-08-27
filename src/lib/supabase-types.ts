// Placeholder types for your own Supabase project.
// Replace with generated types from `supabase gen types typescript` when you have them.

import type {
  CustodyJourneyEventRow,
  CustodyJourneyRow,
  CustodyJourneyWalletRow,
  CustodyPendingEventRow,
  CustodyWorkerHeartbeatRow,
  CustodyWalletProfileRow,
} from "./custody";

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
  additional_target_wallets: string[];
  execution_route: string;
  jito_tip_sol: number;
  fixed_buy_usd: number;
  supply_accumulation_mode_enabled: boolean;
  supply_accumulation_threshold_pct: number;
  supply_accumulation_buy_usd: number;
  supply_accumulation_min_market_cap_usd: number;
  supply_accumulation_max_market_cap_usd: number;
  supply_accumulation_window_seconds: number;
  supply_accumulation_scale_2_enabled: boolean;
  supply_accumulation_scale_2_threshold_pct: number;
  supply_accumulation_scale_2_buy_usd: number;
  supply_accumulation_scale_3_enabled: boolean;
  supply_accumulation_scale_3_threshold_pct: number;
  supply_accumulation_scale_3_buy_usd: number;
  supply_accumulation_scale_4_enabled: boolean;
  supply_accumulation_scale_4_threshold_pct: number;
  supply_accumulation_scale_4_buy_usd: number;
  custody_journey_enabled: boolean;
  revival_tracker_enabled: boolean;
  revival_market_cap_min_usd: number;
  revival_market_cap_max_usd: number;
  crew_exit_enabled?: boolean;
  crew_exit_pct?: number;
  crew_exit_min_mints?: number;
  conviction_mode_enabled: boolean;
  conviction_trading_mode: "shadow" | "live";
  conviction_rapid_follow_enabled: boolean;
  conviction_primary_window_minutes: 5 | 30 | 60;
  conviction_score_threshold: number;
  conviction_top_n: number;
  conviction_min_commitment_usd: number;
  conviction_min_recent_net_inflow_usd: number;
  conviction_min_velocity_usd_per_minute: number;
  conviction_min_acceleration_ratio: number;
  conviction_min_converged_wallets: number;
  conviction_two_wallet_window_seconds: number;
  conviction_three_wallet_window_seconds: number;
  conviction_min_individual_buy_usd: number;
  conviction_market_cap_filter_enabled: boolean;
  conviction_market_cap_min_usd: number;
  conviction_market_cap_max_usd: number;
  conviction_liquidity_filter_enabled: boolean;
  conviction_liquidity_min_usd: number;
  conviction_liquidity_max_usd: number;
  conviction_token_age_filter_enabled: boolean;
  conviction_token_age_min_minutes: number;
  conviction_token_age_max_minutes: number;
  conviction_max_position_per_token_usd: number;
  conviction_distribution_sell_ratio: number;
  conviction_distribution_min_sells_usd: number;
  conviction_distribution_wallet_count: number;
  conviction_inactivity_minutes: number;
  conviction_rank_loss_grace_seconds: number;
  conviction_weight_net_commitment: number;
  conviction_weight_velocity: number;
  conviction_weight_acceleration: number;
  conviction_weight_convergence: number;
  conviction_weight_persistence: number;
  conviction_tier_commitment_thresholds_usd: number[];
  conviction_tier_buy_amounts_usd: number[];
  coordinated_mode_enabled: boolean;
  coordinated_fixed_buy_usd: number;
  coordinated_three_wallet_buy_usd?: number;
  coordinated_target_wallet_count: number;
  coordinated_window_seconds: number;
  coordinated_mc_min_usd: number;
  coordinated_mc_max_usd: number;
  coordinated_coin_age_min_minutes: number;
  coordinated_coin_age_max_minutes: number;
  coordinated_target_buy_min_usd: number;
  coordinated_target_buy_max_usd: number;
  coordinated_first_buy_only: boolean;
  coordinated_once_per_token: boolean;
  coordinated_follower_sell_count: number;
  coordinated_follower_sell_pct: number;
  coordinated_inactivity_hours: number;
  network_scaling_enabled: boolean;
  starter_position_pct: number;
  max_position_pct: number;
  new_entry_reserve_pct: number;
  target_copy_ratio_pct: number;
  min_scale_buy_usd: number;
  min_target_buy_usd: number;
  mc_min_usd: number;
  mc_max_usd: number;
  liq_min_usd: number;
  liq_max_usd: number;
  token_age_filter_enabled: boolean;
  token_age_min_minutes: number;
  token_age_max_minutes: number;
  pump_fun_only: boolean;
  require_socials: boolean;
  require_24h_uptrend: boolean;
  large_buy_scanner_enabled: boolean;
  large_buy_scanner_max_mc_usd: number;
  large_buy_scanner_min_buy_usd: number;
  large_buy_scanner_multiplier: number;
  large_buy_scanner_history_window: number;
  only_first_buy_ever: boolean;
  only_once_per_token: boolean;
  take_profit_enabled: boolean;
  take_profit_pct: number;
  take_profit_sell_pct: number;
  stop_loss_enabled: boolean;
  stop_loss_pct: number;
  trailing_stop_enabled?: boolean;
  trailing_stop_pct?: number;
  trailing_activation_pct?: number;
  proportional_follower_sells: boolean;
  follower_seller_exit_enabled: boolean;
  follower_seller_exit_count: number;
  follower_seller_exit_pct: number;
  target_inactivity_exit_enabled: boolean;
  target_inactivity_hours: number;
  direct_target_sell_exit_mode: "off" | "proportional" | "fixed_pct" | "full";
  direct_target_sell_exit_pct: number;
  terminal_outflow_exit_enabled: boolean;
  terminal_outflow_exit_pct: number;
  target_terminal_outflow_exit_enabled: boolean;
  target_terminal_outflow_exit_pct: number;
  updated_at: string;
};

export type PositionRow = {
  id: string;
  user_id: string;
  token_mint: string;
  entry_price_usd: number;
  amount_tokens: number;
  amount_remaining: number;
  amount_remaining_raw: string | null;
  entry_tx_sig: string;
  entry_slot: number | null;
  opened_at: string;
  closed_at: string | null;
  network_target_spend_usd: number;
  bot_cost_basis_usd: number;
  campaign_bankroll_usd: number;
  root_buy_count: number;
  last_root_buy_at: string | null;
  last_root_buy_wallet: string | null;
  entry_mode: "regular" | "coordinated";
  coordinated_exit_triggered: boolean;
  follower_seller_exit_triggered: boolean;
};

export type EntrySignalClaimRow = {
  id: string;
  user_id: string;
  source_tx_sig: string;
  source_wallet: string;
  token_mint: string;
  planned_position_id: string;
  entry_mode: "regular" | "coordinated";
  entry_strategy: "supply_accumulation" | "regular" | "coordinated" | "conviction" | null;
  source_slot: number | null;
  token_decimals: number | null;
  contributing_wallets: string[] | null;
  planned_buy_usd: number | null;
  last_valid_block_height: number | null;
  fresh_tail_epoch_id: string | null;
  fresh_tail_request_id: string | null;
  fresh_tail_monitoring_armed_at: string | null;
  received_amount_raw: string | null;
  received_token_decimals: number | null;
  amount_lamports: number;
  status: "claimed" | "submitted" | "landed" | "persisted" | "failed_pre_submit" | "uncertain";
  bot_tx_sig: string | null;
  error_code: string | null;
  submission_started_at: string | null;
  landed_at: string | null;
  persisted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TradeRow = {
  id: string;
  user_id: string;
  position_id: string | null;
  side: "buy" | "sell";
  token_mint: string;
  amount_tokens: number;
  amount_usd: number | null;
  price_usd: number | null;
  pnl_pct: number | null;
  tx_sig: string;
  reason: string | null;
  latency_ms: number | null;
  route: string | null;
  valuation_source: string | null;
  created_at: string;
};

export type FundingKeyRow = {
  id: string;
  user_id: string;
  wallet_pubkey: string;
  ciphertext: string;
  created_at: string;
};

export type WorkerHeartbeatRow = {
  user_id: string;
  target_wallet: string | null;
  started_at: string;
  updated_at: string;
  geyser_connected: boolean;
  last_geyser_message_at: string | null;
  decoded_event_count: number;
  rpc_last_poll_at: string | null;
  rpc_last_success_at: string | null;
  rpc_backlog_wallet_count: number;
  monitoring_degraded: boolean;
  follower_balance_last_checked_at: string | null;
  follower_balance_candidate_count: number;
  follower_balance_mismatch_count: number;
  follower_balance_reconciliation_degraded: boolean;
  follower_balance_last_error: string | null;
  funding_key_ready: boolean;
  funding_key_checked_at: string | null;
  funding_wallet_pubkey: string | null;
  last_error: string | null;
  wallet_holdings: Array<{ token_mint: string; amount: number; decimals: number }>;
  observed_follower_holdings: Array<{
    token_mint: string;
    wallet: string;
    amount: number;
    decimals: number;
    source_target_count: number;
    last_updated: string;
  }>;
};

export type FollowerBalanceAlertRow = {
  id: string;
  user_id: string;
  wallet: string;
  token_mint: string;
  expected_amount: number;
  observed_amount: number;
  shortfall_amount: number;
  active_position_count: number;
  occurrence_count: number;
  first_detected_at: string;
  last_detected_at: string;
  confirmed_at: string | null;
  resolved_at: string | null;
  resolution_reason: "balance_recovered" | "no_longer_active" | null;
  resolution_observed_amount: number | null;
};

export type StrategyObservationRow = {
  id: string;
  user_id: string;
  target_wallet: string;
  event_key: string;
  tx_sig: string;
  slot: number | null;
  source: "geyser" | "rpc" | "unknown";
  event_at: string;
  detected_at: string;
  updated_at: string;
  relationship: "target" | "follower" | "observed";
  event_kind: "swap" | "transfer";
  side: "buy" | "sell" | null;
  actor_wallet: string;
  from_wallet: string | null;
  to_wallet: string | null;
  token_mint: string;
  amount_tokens: number;
  decimals: number;
  sol_delta: number | null;
  amount_usd: number | null;
  is_pump_fun: boolean | null;
  position_id: string | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  has_socials: boolean | null;
  bot_decision:
    | "filtered"
    | "skipped"
    | "copy_submitted"
    | "copied"
    | "mirror_submitted"
    | "mirrored"
    | "tracked"
    | "failed"
    | null;
  bot_reason: string | null;
  bot_tx_sig: string | null;
  reaction_ms: number | null;
  execution_ms: number | null;
  metadata: Record<string, unknown>;
};

export type StrategyRecentObservation = Pick<
  StrategyObservationRow,
  | "event_key"
  | "tx_sig"
  | "event_at"
  | "relationship"
  | "event_kind"
  | "side"
  | "actor_wallet"
  | "from_wallet"
  | "to_wallet"
  | "token_mint"
  | "amount_tokens"
  | "amount_usd"
  | "market_cap_usd"
  | "liquidity_usd"
  | "bot_decision"
  | "bot_reason"
  | "source"
>;

export type StrategyReasonCount = {
  reason: string;
  count: number;
};

export type StrategyInsights = {
  since: string;
  generated_at: string;
  total_observations: number;
  target_buys: number;
  target_sells: number;
  target_transfers: number;
  follower_sells: number;
  unique_mints: number;
  copied_buys: number;
  filtered_buys: number;
  failed_actions: number;
  median_buy_reaction_ms: number | null;
  median_buy_execution_ms: number | null;
  median_sell_reaction_ms: number | null;
  median_sell_execution_ms: number | null;
  learning_confidence_pct: number;
  top_filter_reasons: StrategyReasonCount[];
  median_target_buy_usd: number | null;
  median_entry_market_cap_usd: number | null;
  median_entry_liquidity_usd: number | null;
  average_transfer_recipients: number | null;
  most_active_hour_utc: number | null;
  recent: StrategyRecentObservation[];
};

export type ConvictionEventRow = {
  id: string;
  user_id: string;
  event_key: string;
  tx_sig: string;
  slot: number | null;
  source: "geyser" | "rpc" | "unknown";
  event_at: string;
  recorded_at: string;
  wallet: string;
  from_wallet: string | null;
  to_wallet: string | null;
  token_mint: string;
  classification:
    | "DEX_BUY"
    | "DEX_SELL"
    | "INTERNAL_CLUSTER_TRANSFER"
    | "EXTERNAL_TRANSFER_IN"
    | "EXTERNAL_TRANSFER_OUT"
    | "UNKNOWN";
  classification_reliable: boolean;
  amount_tokens: number;
  amount_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  metadata: Record<string, unknown>;
};

export type ConvictionTokenStateRow = {
  user_id: string;
  token_mint: string;
  symbol: string | null;
  first_seen_at: string;
  last_activity_at: string;
  gross_cluster_buys_usd: number;
  gross_cluster_sells_usd: number;
  net_cluster_investment_usd: number;
  wallet_net_usd: Record<string, number>;
  buy_count: number;
  sell_count: number;
  largest_buy_usd: number;
  last_buy_usd: number;
  average_buy_usd: number;
  median_buy_usd: number;
  wallets_that_bought: string[];
  wallets_currently_accumulating: string[];
  wallet_convergence_count: number;
  market_cap_usd: number | null;
  market_cap_at_first_cluster_buy_usd: number | null;
  liquidity_usd: number | null;
  our_current_position_usd: number;
  net_flow_1m_usd: number;
  net_flow_5m_usd: number;
  net_flow_30m_usd: number;
  net_flow_60m_usd: number;
  capital_velocity_usd_per_minute: number;
  capital_acceleration_ratio: number;
  buy_size_acceleration_ratio: number;
  conviction_score: number;
  conviction_state:
    | "TESTING"
    | "WATCHING"
    | "ACCUMULATING"
    | "BETTING"
    | "HIGH_CONVICTION"
    | "DISTRIBUTING";
  score_reasons: unknown[];
  current_rank: number | null;
  previous_rank: number | null;
  rank_direction: "up" | "down" | "flat" | "new" | "unranked";
  time_in_top_10_seconds: number;
  time_in_top_3_seconds: number;
  time_at_rank_one_seconds: number;
  rapid_follow_status: "inactive" | "active" | "stopped";
  data_reliable: boolean;
  rolling_metrics: Record<string, unknown>;
  last_ranked_at: string | null;
  updated_at: string;
};

export type CustodyFreshTailEpochRow = {
  id: string;
  user_id: string;
  status: "active" | "retired" | "invalidated";
  activation_slot: number;
  activation_blockhash: string;
  activation_block_time: string;
  root_wallets: string[];
  root_fingerprint: string;
  scope_revision: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailMintRow = {
  epoch_id: string;
  user_id: string;
  token_mint: string;
  enrollment_event_key: string;
  enrollment_tx_sig: string;
  enrollment_slot: number;
  enrollment_blockhash: string;
  enrollment_block_time: string;
  enrollment_target_wallet: string;
  creation_tx_sig: string;
  creation_slot: number;
  creation_blockhash: string;
  bonding_curve: string;
  creator: string;
  create_variant: "classic_v1" | "create_v2_token2022";
  token_program: string;
  mint_layout_fingerprint: string;
  parser_abi_fingerprint: string;
  total_supply_raw: string;
  decimals: number;
  attested_head_slot: number;
  attested_head_blockhash: string;
  status: "active" | "retired";
  scope_revision: number;
  poisoned: boolean;
  poison_reason: string | null;
  retire_reason: string | null;
  retired_at: string | null;
  attested_at: string;
  updated_at: string;
};

export type CustodyFreshTailSupplyEventRow = {
  id: string;
  epoch_id: string;
  user_id: string;
  event_key: string;
  payload_fingerprint: string;
  tx_sig: string;
  slot: number;
  block_time: string;
  target_wallet: string;
  token_mint: string;
  side: "buy" | "sell";
  amount_raw: string;
  total_supply_raw: string;
  decimals: number;
  market_cap_usd: number | null;
  valuation_slot: number | null;
  market_data_reliable: boolean;
  pump_fun_verified: boolean;
  classification_reliable: boolean;
  parser_domain: string;
  parser_abi_fingerprint: string;
  finalized_head_slot: number;
  finalized_head_blockhash: string;
  quarantined: boolean;
  conflict_count: number;
  first_conflict_at: string | null;
  recorded_at: string;
};

export type CustodyFreshTailRecipient = {
  wallet: string;
  amountRaw: string;
  preRaw: string;
  postRaw: string;
  classification: string;
  classificationReliable: boolean;
  watchable: boolean;
};

export type CustodyFreshTailCustodyEventRow = {
  id: string;
  epoch_id: string;
  user_id: string;
  event_key: string;
  payload_fingerprint: string;
  tx_sig: string;
  slot: number;
  block_time: string;
  source_wallet: string;
  token_mint: string;
  event_kind: "TARGET_BUY" | "TRANSFER" | "SELL" | "UNRESOLVED_OUTFLOW" | "TERMINAL_OUTFLOW";
  amount_raw: string;
  source_pre_raw: string;
  source_post_raw: string;
  decimals: number;
  recipients: CustodyFreshTailRecipient[];
  classification: string;
  classification_reliable: boolean;
  watchable: boolean;
  parser_domain: string;
  parser_abi_fingerprint: string;
  finalized_head_slot: number;
  finalized_head_blockhash: string;
  classification_pending: boolean;
  terminal_poison: boolean;
  quarantined: boolean;
  conflict_count: number;
  first_conflict_at: string | null;
  recorded_at: string;
};

export type CustodyFreshTailRequestRow = {
  id: string;
  epoch_id: string;
  user_id: string;
  token_mint: string;
  status: "pending" | "settled" | "expired" | "invalidated";
  window_started_at: string;
  trigger_supply_event_id: string;
  trigger_event_key: string;
  trigger_tx_sig: string;
  trigger_slot: number;
  trigger_target_wallet: string;
  trigger_block_time: string;
  expires_at: string;
  requested_head_slot: number;
  requested_head_blockhash: string;
  requested_head_block_time: string;
  head_snapshot_parser_abi_fingerprint: string;
  head_curve_state_fingerprint: string;
  head_curve_observed_slot: number;
  head_curve_complete: false;
  head_virtual_token_reserves_raw: string;
  head_virtual_sol_reserves_lamports: string;
  head_real_token_reserves_raw: string;
  head_real_sol_reserves_lamports: string;
  head_curve_total_supply_raw: string;
  head_mint_layout_fingerprint: string;
  head_token_program: string;
  head_mint_supply_raw: string;
  head_mint_decimals: number;
  scope_revision: number;
  settled_revision: number | null;
  settled_lease_generation: number | null;
  settled_at: string | null;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailCursorRow = {
  epoch_id: string;
  user_id: string;
  scope_mint: string;
  wallet: string;
  cursor_role: "root" | "descendant";
  floor_slot: number;
  initial_boundary_kind: "exclusive_slot" | "inclusive_slot";
  current_boundary_kind: "exclusive_slot" | "inclusive_slot" | "exact_signature";
  last_processed_signature: string | null;
  last_processed_slot: number | null;
  last_block_time: number | null;
  first_available_block: number | null;
  history_floor_proven: boolean;
  covered_through_slot: number | null;
  covered_through_blockhash: string | null;
  coverage_revision: number;
  backlog_detected: boolean;
  last_error: string | null;
  last_success_at: string | null;
  last_lease_generation: number;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailExitIntentRow = {
  id: string;
  user_id: string;
  epoch_id: string;
  request_id: string;
  token_mint: string;
  entry_claim_id: string;
  position_id: string;
  source_domain: "supply" | "custody";
  supply_event_id: string | null;
  custody_event_id: string | null;
  trigger_kind: "direct_target_sell" | "mirror_custody_sell" | "terminal_outflow";
  status: "pending" | "claimed" | "retry" | "uncertain" | "resolved" | "dismissed";
  disposition: string | null;
  worker_id: string | null;
  claim_token: string | null;
  claim_generation: number;
  claim_expires_at: string | null;
  sell_claim_id: string | null;
  bot_tx_sig: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type CustodyFreshTailRootRow = {
  epoch_id: string;
  user_id: string;
  wallet: string;
  ordinal: number;
  floor_slot: number;
  boundary_kind: "exclusive_slot";
  created_at: string;
};

export type CustodyFreshTailFinalizedHeadRow = {
  epoch_id: string;
  user_id: string;
  slot: number;
  blockhash: string;
  block_time: string;
  first_lease_generation: number;
  last_lease_generation: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type CustodyFreshTailMintRejectionRow = {
  epoch_id: string;
  user_id: string;
  token_mint: string;
  source_tx_sig: string;
  source_slot: number;
  rejection_code: string;
  parser_abi_fingerprint: string;
  proof_fingerprint: string;
  finalized_head_slot: number;
  finalized_head_blockhash: string;
  quarantined: boolean;
  conflict_count: number;
  first_conflict_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailEdgeRow = {
  epoch_id: string;
  user_id: string;
  token_mint: string;
  custody_event_id: string;
  source_wallet: string;
  destination_wallet: string;
  discovery_slot: number;
  amount_raw: string;
  classification: string;
  classification_reliable: boolean;
  watchable: boolean;
  applied_revision: number | null;
  scope_applied_at: string | null;
  recorded_at: string;
};

export type CustodyFreshTailWalletRow = {
  epoch_id: string;
  user_id: string;
  token_mint: string;
  wallet: string;
  parent_wallet: string;
  discovery_event_id: string;
  discovery_event_key: string;
  discovery_slot: number;
  floor_slot: number;
  boundary_kind: "inclusive_slot";
  watch_status: "active" | "released" | "unwatchable";
  classification: string;
  classification_reliable: boolean;
  added_revision: number;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailBackscanRangeRow = {
  id: string;
  epoch_id: string;
  user_id: string;
  token_mint: string;
  wallet: string;
  source_edge_event_id: string;
  floor_slot: number;
  boundary_kind: "inclusive_slot";
  current_boundary_kind: "inclusive_slot" | "exact_signature";
  last_processed_signature: string | null;
  last_processed_slot: number | null;
  last_block_time: number | null;
  first_available_block: number | null;
  history_floor_proven: boolean;
  covered_through_slot: number | null;
  covered_through_blockhash: string | null;
  coverage_revision: number;
  backlog_detected: boolean;
  last_error: string | null;
  last_success_at: string | null;
  last_lease_generation: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CustodyFreshTailCoverageAttestationRow = {
  id: string;
  epoch_id: string;
  user_id: string;
  lane_kind: "main" | "backscan";
  scope_mint: string | null;
  wallet: string | null;
  range_id: string | null;
  covered_head_slot: number;
  covered_head_blockhash: string;
  coverage_revision: number;
  lease_generation: number;
  attested_at: string;
};

export type CustodyFreshTailWorkerHeartbeatRow = {
  user_id: string;
  epoch_id: string;
  worker_id: string;
  lease_token: string;
  lease_generation: number;
  lease_expires_at: string;
  enabled: boolean;
  shadow: boolean;
  latest_head_slot: number;
  latest_head_blockhash: string;
  latest_head_block_time: string;
  root_required_count: 3;
  root_covered_count: number;
  root_backlog_count: number;
  max_root_lag_slots: number;
  active_mint_count: number;
  poisoned_mint_count: number;
  retired_mint_count: number;
  pending_candidate_count: number;
  oldest_pending_candidate_age_seconds: number | null;
  descendant_required_count: number;
  descendant_covered_count: number;
  incomplete_backscan_count: number;
  exit_pending_count: number;
  exit_retry_count: number;
  exit_uncertain_count: number;
  last_success_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export type ConvictionRankHistoryRow = {
  id: string;
  user_id: string;
  token_mint: string;
  window_minutes: 5 | 30 | 60;
  rank: number;
  previous_rank: number | null;
  rank_direction: "up" | "down" | "flat" | "new";
  conviction_score: number;
  net_cluster_investment_usd: number;
  net_flow_usd: number;
  capital_velocity_usd_per_minute: number;
  capital_acceleration_ratio: number;
  buy_size_acceleration_ratio: number;
  wallet_convergence_count: number;
  continuing_accumulation: boolean;
  distribution_penalty: number;
  ranking_at: string;
  metadata: Record<string, unknown>;
};

export type ConvictionTransitionRow = {
  id: string;
  user_id: string;
  transition_key: string;
  token_mint: string | null;
  event_type: string;
  previous_state: ConvictionTokenStateRow["conviction_state"] | null;
  new_state: ConvictionTokenStateRow["conviction_state"] | null;
  previous_score: number | null;
  new_score: number | null;
  net_cluster_investment_usd: number | null;
  capital_velocity_usd_per_minute: number | null;
  wallet_convergence_count: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  reasons: unknown[];
  metadata: Record<string, unknown>;
  occurred_at: string;
  recorded_at: string;
};

export type ConvictionTierRow = {
  id: string;
  user_id: string;
  token_mint: string;
  tier_number: number;
  trading_mode: "shadow" | "live";
  status:
    | "eligible"
    | "shadowed"
    | "claimed"
    | "submitted"
    | "landed"
    | "persisted"
    | "failed_pre_submit"
    | "uncertain"
    | "skipped";
  planned_position_id: string | null;
  position_id: string | null;
  source_event_key: string;
  commitment_threshold_usd: number;
  buy_usd: number;
  score: number;
  received_tokens: number | null;
  bot_tx_sig: string | null;
  reason: string | null;
  error_code: string | null;
  claimed_at: string | null;
  submission_started_at: string | null;
  landed_at: string | null;
  persisted_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type SupplyAccumulationScaleClaimRow = {
  id: string;
  user_id: string;
  token_mint: string;
  position_id: string;
  tier_number: 2 | 3 | 4;
  status: "claimed" | "submitted" | "landed" | "persisted" | "failed_pre_submit" | "uncertain";
  source_event_key: string;
  source_tx_sig: string;
  source_wallet: string;
  source_slot: string;
  token_decimals: number;
  threshold_pct: number;
  planned_buy_usd: number;
  amount_lamports: string;
  config_fingerprint: string;
  bot_tx_sig: string | null;
  last_valid_block_height: string | null;
  received_amount_raw: string | null;
  trade_id: string | null;
  error_code: string | null;
  submission_started_at: string | null;
  landed_at: string | null;
  persisted_at: string | null;
  applied_at: string | null;
  post_apply_repaired_at: string | null;
  created_at: string;
  updated_at: string;
};

// Minimal Database shape for createClient<Database>
export type Database = {
  public: {
    Tables: {
      bot_config: {
        Row: BotConfigRow;
        Insert: Omit<BotConfigRow, "id" | "updated_at">;
        Update: Partial<BotConfigRow>;
        Relationships: [];
      };
      funding_keys: {
        Row: FundingKeyRow;
        Insert: Omit<FundingKeyRow, "id" | "created_at">;
        Update: Partial<FundingKeyRow>;
        Relationships: [];
      };
      positions: {
        Row: PositionRow;
        Insert: Omit<PositionRow, "id" | "opened_at" | "amount_remaining_raw"> & {
          amount_remaining_raw?: string | null;
        };
        Update: Partial<PositionRow>;
        Relationships: [];
      };
      entry_signal_claims: {
        Row: EntrySignalClaimRow;
        Insert: Partial<EntrySignalClaimRow>;
        Update: Partial<EntrySignalClaimRow>;
        Relationships: [];
      };
      trades: {
        Row: TradeRow;
        Insert: Omit<TradeRow, "id" | "created_at">;
        Update: Partial<TradeRow>;
        Relationships: [];
      };
      worker_heartbeat: {
        Row: WorkerHeartbeatRow;
        Insert: WorkerHeartbeatRow;
        Update: Partial<WorkerHeartbeatRow>;
        Relationships: [];
      };
      follower_balance_alerts: {
        Row: FollowerBalanceAlertRow;
        Insert: Omit<FollowerBalanceAlertRow, "id" | "first_detected_at" | "last_detected_at">;
        Update: Partial<FollowerBalanceAlertRow>;
        Relationships: [];
      };
      strategy_observations: {
        Row: StrategyObservationRow;
        Insert: Omit<StrategyObservationRow, "id" | "updated_at">;
        Update: Partial<StrategyObservationRow>;
        Relationships: [];
      };
      custody_journeys: {
        Row: CustodyJourneyRow;
        Insert: Partial<CustodyJourneyRow>;
        Update: Partial<CustodyJourneyRow>;
        Relationships: [];
      };
      custody_journey_wallets: {
        Row: CustodyJourneyWalletRow;
        Insert: Partial<CustodyJourneyWalletRow>;
        Update: Partial<CustodyJourneyWalletRow>;
        Relationships: [];
      };
      custody_journey_events: {
        Row: CustodyJourneyEventRow;
        Insert: Partial<CustodyJourneyEventRow>;
        Update: Partial<CustodyJourneyEventRow>;
        Relationships: [];
      };
      custody_wallet_profiles: {
        Row: CustodyWalletProfileRow;
        Insert: Omit<CustodyWalletProfileRow, "created_at" | "updated_at">;
        Update: Partial<CustodyWalletProfileRow>;
        Relationships: [];
      };
      custody_worker_heartbeat: {
        Row: CustodyWorkerHeartbeatRow;
        Insert: CustodyWorkerHeartbeatRow;
        Update: Partial<CustodyWorkerHeartbeatRow>;
        Relationships: [];
      };
      custody_pending_events: {
        Row: CustodyPendingEventRow;
        Insert: CustodyPendingEventRow;
        Update: Partial<CustodyPendingEventRow>;
        Relationships: [];
      };
      custody_fresh_tail_epochs: {
        Row: CustodyFreshTailEpochRow;
        Insert: Partial<CustodyFreshTailEpochRow>;
        Update: Partial<CustodyFreshTailEpochRow>;
        Relationships: [];
      };
      custody_fresh_tail_roots: {
        Row: CustodyFreshTailRootRow;
        Insert: Partial<CustodyFreshTailRootRow>;
        Update: Partial<CustodyFreshTailRootRow>;
        Relationships: [];
      };
      custody_fresh_tail_finalized_heads: {
        Row: CustodyFreshTailFinalizedHeadRow;
        Insert: Partial<CustodyFreshTailFinalizedHeadRow>;
        Update: Partial<CustodyFreshTailFinalizedHeadRow>;
        Relationships: [];
      };
      custody_fresh_tail_mints: {
        Row: CustodyFreshTailMintRow;
        Insert: Partial<CustodyFreshTailMintRow>;
        Update: Partial<CustodyFreshTailMintRow>;
        Relationships: [];
      };
      custody_fresh_tail_mint_rejections: {
        Row: CustodyFreshTailMintRejectionRow;
        Insert: Partial<CustodyFreshTailMintRejectionRow>;
        Update: Partial<CustodyFreshTailMintRejectionRow>;
        Relationships: [];
      };
      custody_fresh_tail_supply_events: {
        Row: CustodyFreshTailSupplyEventRow;
        Insert: Partial<CustodyFreshTailSupplyEventRow>;
        Update: Partial<CustodyFreshTailSupplyEventRow>;
        Relationships: [];
      };
      custody_fresh_tail_custody_events: {
        Row: CustodyFreshTailCustodyEventRow;
        Insert: Partial<CustodyFreshTailCustodyEventRow>;
        Update: Partial<CustodyFreshTailCustodyEventRow>;
        Relationships: [];
      };
      custody_fresh_tail_edges: {
        Row: CustodyFreshTailEdgeRow;
        Insert: Partial<CustodyFreshTailEdgeRow>;
        Update: Partial<CustodyFreshTailEdgeRow>;
        Relationships: [];
      };
      custody_fresh_tail_wallets: {
        Row: CustodyFreshTailWalletRow;
        Insert: Partial<CustodyFreshTailWalletRow>;
        Update: Partial<CustodyFreshTailWalletRow>;
        Relationships: [];
      };
      custody_fresh_tail_requests: {
        Row: CustodyFreshTailRequestRow;
        Insert: Partial<CustodyFreshTailRequestRow>;
        Update: Partial<CustodyFreshTailRequestRow>;
        Relationships: [];
      };
      custody_fresh_tail_cursors: {
        Row: CustodyFreshTailCursorRow;
        Insert: Partial<CustodyFreshTailCursorRow>;
        Update: Partial<CustodyFreshTailCursorRow>;
        Relationships: [];
      };
      custody_fresh_tail_backscan_ranges: {
        Row: CustodyFreshTailBackscanRangeRow;
        Insert: Partial<CustodyFreshTailBackscanRangeRow>;
        Update: Partial<CustodyFreshTailBackscanRangeRow>;
        Relationships: [];
      };
      custody_fresh_tail_coverage_attestations: {
        Row: CustodyFreshTailCoverageAttestationRow;
        Insert: Partial<CustodyFreshTailCoverageAttestationRow>;
        Update: Partial<CustodyFreshTailCoverageAttestationRow>;
        Relationships: [];
      };
      custody_fresh_tail_exit_intents: {
        Row: CustodyFreshTailExitIntentRow;
        Insert: Partial<CustodyFreshTailExitIntentRow>;
        Update: Partial<CustodyFreshTailExitIntentRow>;
        Relationships: [];
      };
      custody_fresh_tail_worker_heartbeat: {
        Row: CustodyFreshTailWorkerHeartbeatRow;
        Insert: Partial<CustodyFreshTailWorkerHeartbeatRow>;
        Update: Partial<CustodyFreshTailWorkerHeartbeatRow>;
        Relationships: [];
      };
      conviction_events: {
        Row: ConvictionEventRow;
        Insert: Omit<ConvictionEventRow, "id" | "recorded_at">;
        Update: Partial<ConvictionEventRow>;
        Relationships: [];
      };
      conviction_token_state: {
        Row: ConvictionTokenStateRow;
        Insert: Omit<ConvictionTokenStateRow, "updated_at">;
        Update: Partial<ConvictionTokenStateRow>;
        Relationships: [];
      };
      conviction_rank_history: {
        Row: ConvictionRankHistoryRow;
        Insert: Omit<ConvictionRankHistoryRow, "id">;
        Update: Partial<ConvictionRankHistoryRow>;
        Relationships: [];
      };
      conviction_transitions: {
        Row: ConvictionTransitionRow;
        Insert: Omit<ConvictionTransitionRow, "id" | "recorded_at">;
        Update: Partial<ConvictionTransitionRow>;
        Relationships: [];
      };
      conviction_tiers: {
        Row: ConvictionTierRow;
        Insert: Omit<ConvictionTierRow, "id" | "created_at" | "updated_at">;
        Update: Partial<ConvictionTierRow>;
        Relationships: [];
      };
      supply_accumulation_scale_claims: {
        Row: SupplyAccumulationScaleClaimRow;
        Insert: Omit<SupplyAccumulationScaleClaimRow, "id" | "created_at" | "updated_at">;
        Update: Partial<SupplyAccumulationScaleClaimRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
