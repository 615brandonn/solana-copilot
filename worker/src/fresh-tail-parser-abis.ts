import { createHash } from "node:crypto";

/**
 * Frozen, reviewable contracts for fresh-tail evidence. These hashes identify
 * parsing semantics, not a mutable RPC head or a particular event payload.
 * Any accepted instruction/layout/classification change requires a new domain
 * version and a matching SQL allow-list update.
 */
const COMMON = [
  "fresh_tail_event_decoder_v1",
  "pump_program=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pump_finalized_idl_sha256=ecf91ed5050c2c8e3e618bd330091f56d7433789eff724dfcc81fd47d1bab7d4",
  "token_programs=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "raw=unsigned_bigint_only",
  "fresh_launch_supply=1000000000000000_raw;decimals=6",
  "balance_identity=accountIndex+mint+owner+programId+decimals",
  "missing_side=zero_only_when_counterpart_identity_is_exact",
  "conservation=all_buy_sell_transfer_domains_sum_enrolled_mint_owner_deltas_zero;reviewed_terminal_burn_net_delta_equals_negative_outflow",
  "trade_event=exact_event_cpi_prefix+TradeEvent(idl_sha256_ecf91ed5050c2c8e3e618bd330091f56d7433789eff724dfcc81fd47d1bab7d4);full_borsh_consumption;mint+user+side+amount+creator+timestamp_bound",
  "head_fields=excluded_from_event_identity",
  "failed_transaction=no_event",
].join(";");

const DOMAIN_SCHEMAS = {
  pump_root_buy_v1: [
    COMMON,
    "domain=pump_root_buy_v1",
    "instructions=buy(66063d1201daebea,16|18,24|25),buy_exact_sol_in(38fc74089edfcd5f,16|18,25),buy_v2(b817ee6167c5d33d,27,24),buy_exact_quote_in_v2(c2ab1c46684d5b2f,27,24)",
    "accounts=exact_reviewed_static_pdas+mint+curve+token_program+root_signer+optional_exact_bonding_curve_v2_and_dynamic_buyback_recipient",
    "amount=curve_raw_decrease>0",
    "legacy_buy_amount=instruction_amount",
    "outputs=root_nonnegative_delta+sorted_positive_recipients=curve_decrease",
    "logical_target_buy=pre..pre+gross",
    "same_tx_transfer=logical_post..actual_post",
  ].join(";"),
  custody_target_buy_v1: [
    COMMON,
    "domain=custody_target_buy_v1",
    "source=root+transaction_signer+reviewed_pump_root_buy",
    "amount=curve_raw_decrease=gross_acquired>0",
    "logical_balance=source_pre_actual..source_pre_actual+gross",
    "same_tx_forwarding=separate_conserving_transfer_from_logical_post_to_actual_post",
    "recipients=empty",
  ].join(";"),
  supply_sell_v1: [
    COMMON,
    "domain=supply_sell_v1",
    "instructions=sell(33e685a4017f83ad,14|16,24),sell_v2(5df6823ce7e940b2,26,24)",
    "accounts=exact_reviewed_static_pdas+mint+curve+token_program+root_signer+optional_exact_bonding_curve_v2_and_dynamic_buyback_recipient",
    "amount=instruction_amount=root_raw_decrease=curve_raw_increase>0",
    "outputs=no_other_enrolled_mint_delta",
  ].join(";"),
  custody_transfer_v1: [
    COMMON,
    "domain=custody_transfer_v1",
    "source=sole_negative_owner+transaction_signer",
    "recipients=all_positive_owners_sorted_unique",
    "amount=source_pre-source_post=sum(recipient_post-recipient_pre)>0",
    "classification=exact_recipient_payload_required;unreliable_blocks;unwatchable_terminal_poison",
  ].join(";"),
  custody_sell_v1: [
    COMMON,
    "domain=custody_sell_v1",
    "instructions=sell(33e685a4017f83ad,14|16,24),sell_v2(5df6823ce7e940b2,26,24)",
    "accounts=exact_reviewed_static_pdas+mint+curve+token_program+descendant_signer+optional_exact_bonding_curve_v2_and_dynamic_buyback_recipient",
    "amount=instruction_amount=descendant_raw_decrease=curve_raw_increase>0",
    "root_role=forbidden",
  ].join(";"),
  custody_unresolved_v1: [
    COMMON,
    "domain=custody_unresolved_v1",
    "source=negative_owner",
    "condition=not_exact_reviewed_sell_and_not_single-source-conserving-transfer",
    "amount=source_pre-source_post>0",
    "classification=reliably_unresolved;watchable=false;permanent_veto",
  ].join(";"),
  custody_terminal_v1: [
    COMMON,
    "domain=custody_terminal_v1",
    "instructions=spl_burn(tag8,len9),spl_burn_checked(tag15,len10)",
    "accounts=source,mint,owner_signer",
    "amount=instruction_amount=source_raw_decrease>0",
    "classification=reviewed_token_burn;watchable=false;permanent_veto",
  ].join(";"),
} as const;

export type FreshTailParserDomain = keyof typeof DOMAIN_SCHEMAS;

function abiFingerprint(schema: string): string {
  return createHash("sha256").update(schema).digest("hex");
}

export const FRESH_TAIL_PARSER_ABIS: Readonly<Record<FreshTailParserDomain, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(DOMAIN_SCHEMAS).map(([domain, schema]) => [domain, abiFingerprint(schema)]),
    ) as Record<FreshTailParserDomain, string>,
  );

export function freshTailParserAbi(domain: FreshTailParserDomain): string {
  return FRESH_TAIL_PARSER_ABIS[domain];
}
