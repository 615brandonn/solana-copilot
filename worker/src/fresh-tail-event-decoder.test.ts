import assert from "node:assert/strict";
import test from "node:test";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import {
  decodeFreshTailFinalizedTransaction,
  discoverFreshTailRootPumpBuys,
  finalizeFreshTailCustodyEvent,
  type FreshTailMintContract,
  type FreshTailRecipientClassification,
} from "./fresh-tail-event-decoder.js";
import { FRESH_TAIL_PARSER_ABIS } from "./fresh-tail-parser-abis.js";
import { PUMP_FUN_PROGRAM_ID, pumpFunBondingCurveAddress } from "./pump-fun-supply.js";

const EVENT_AUTHORITY = "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1";

type CompactFixture = {
  mint: string;
  creator: string;
  signature: string;
  slot: number;
  blockTime: number;
  signers: string[];
  instructionAccounts: string[];
  instructionData: string;
  eventData: string;
  balances: Array<{ address: string; owner: string; pre?: string; post?: string }>;
};

const REAL_V2_FORWARDED_BUY: CompactFixture = {
  mint: "CUfKrzGpb8cH9uLnB4tTS2Ywiz2HxZSdJtgyReqLpump",
  creator: "BnqyxTPMJoanLNkCwGRAwVctnhgrj6tfKd1QhKssTZha",
  signature:
    "535P76bebaYEEv3gEvgZ8GdfevtNMeBAeJQcEwU3rw4wbPmrrQeCBdB2W9RPXqsMd4cKs7TA12CQ74QAXcqzy3HQ",
  slot: 441_307_005,
  blockTime: 1_787_542_680,
  signers: ["7JCe3GHwkEr3feHgtLXnmuJ1yB3A7coSeyynxTBgdG8k"],
  instructionAccounts: [
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    "CUfKrzGpb8cH9uLnB4tTS2Ywiz2HxZSdJtgyReqLpump",
    "So11111111111111111111111111111111111111112",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
    "CGEWR6pxwgQvYKeX4pZDqpZtWYPvyTjiAsw86SNzJtGy",
    "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
    "6rVkF4HSgy1jrnC3HogfRgPHrq4CtLg5f11URpsC4i9D",
    "4qNVJrCVFasy9maa5jcDQhB3312qqN62JNo2opz27hD2",
    "87TzeDgig878oKTYEAgUFV253JQuDvYrpCEXJ1L23qxf",
    "F44aQhc7c4ca8WPoBUdKsuL1xFuS13y5KckgbnNA1fKQ",
    "7JCe3GHwkEr3feHgtLXnmuJ1yB3A7coSeyynxTBgdG8k",
    "GJLTcfJTuKMgWyvq4Wpzd1L1ys4Suwz4dkSpM6pSb8fp",
    "CU3RGMeZVagD3Son8ytvbumtvwvHkwwhAbPBVB9cPvQE",
    "C8W5jkHNwwwdjZU4dTjW56UxQfwYVc9WYLFdvaGAtAn4",
    "6f9B5AqC2WP1x9VPrWuDFfWkoCPUGypf2RVTLyyCQAnb",
    "3774dX98eUzkAWKGhArLKkwQFPrEGxABKCBjBLk5LJnN",
    "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y",
    "9U24zU9tviqcKfJbpmveu3SxQqDcKyPmb53yyYRupDah",
    "9YEezy2mk85BkZHYM5dar8jZ1PV4kfLzVs7TXdN7aMu4",
    "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
    "11111111111111111111111111111111",
    EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID.toBase58(),
  ],
  instructionData: "JkK5BJGr6ZH8EHG2TGGVq6wMDqas2Cfwd",
  eventData:
    "4DRpSvv25WyUKMa1NGJtcNj7A2KsthvFzjvYEqPoY2eMeNA12fgpFPGnScFvQBfDhaUEJ27gsA2n3YRtm3mf3m6jGKUhuxavJ43TpuAh12hyFZpqs3hDjfMUvGg87G4oxoQ3gt3s8bZaHbUMdTyHpctrcZtFUecKy3M78wUv2wS6PAqvHAQ43HdDghPCT6yDsJpQRvuWL7FVUZhvw2T4Kfmnh3LcaoumjgTFjo88dn3oFKhcvUNMHw125cTM661A6u3TQATvukXEJLPTRm2J6k9tzRWS6nH8Vevc1neVjkrQvvy4Tz6eyyAMxktpd8UqHGER1EoiPj9vyFsapxLRbCVTDQQeHYtYcXQogkrHGQ3hBspqxJruVKon9UN881zQtT778rBzHSioLBf2sFGXZioKcAae2363QAT3jHoGcfTmUPShNvhSnyhzcP5GGCNuGm4knNdtXxGsUypcbVCvoRR4p3FPXuDgUEaQB34pb7PrpNL8XhKnkTE7d6ouL5hcQJv4HuUeK",
  balances: [
    {
      address: "87TzeDgig878oKTYEAgUFV253JQuDvYrpCEXJ1L23qxf",
      owner: "4qNVJrCVFasy9maa5jcDQhB3312qqN62JNo2opz27hD2",
      pre: "756264811653753",
      post: "698101699536718",
    },
    {
      address: "Ey1LiWPWAXUXKz1keQ1TtRCkug5J15JiWP14ecDzWXix",
      owner: "8UAFxVEDxe3aDAmuHp9j8xwta6apawVGJU1JFei6eFJA",
      post: "58163112117035",
    },
  ],
};

const REAL_V2_DESCENDANT_SELL: CompactFixture = {
  mint: REAL_V2_FORWARDED_BUY.mint,
  creator: REAL_V2_FORWARDED_BUY.creator,
  signature:
    "2F8rVmKeWGcMjfJTpYp2T8M8jirAaSRZnvSqa9zq5wKpKCLaW4uwy621C7BD3xaVyE2SKeJhaX5xCzELHUuTebt7",
  slot: 441_307_257,
  blockTime: 1_787_542_773,
  signers: [
    "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi",
    "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm",
  ],
  instructionAccounts: [
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    REAL_V2_FORWARDED_BUY.mint,
    "So11111111111111111111111111111111111111112",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
    "BWXT6RUhit9FfJQM3pBmqeFLPYmuxgmyhMGC5sGr8RbA",
    "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
    "GAFuhgcd328SkkBYHpfadzmef9hTGAFRCi9QoCnsZQug",
    "4qNVJrCVFasy9maa5jcDQhB3312qqN62JNo2opz27hD2",
    "87TzeDgig878oKTYEAgUFV253JQuDvYrpCEXJ1L23qxf",
    "F44aQhc7c4ca8WPoBUdKsuL1xFuS13y5KckgbnNA1fKQ",
    "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm",
    "BzXro94FJ5zpaDGD7Lhk6wTsrqyu2yPY7PGAGQ53tEWT",
    "6gQPSC1Fsg1NSzVe5jrePVAw5LTrqHCXKiScWT12EG5m",
    "C8W5jkHNwwwdjZU4dTjW56UxQfwYVc9WYLFdvaGAtAn4",
    "6f9B5AqC2WP1x9VPrWuDFfWkoCPUGypf2RVTLyyCQAnb",
    "3774dX98eUzkAWKGhArLKkwQFPrEGxABKCBjBLk5LJnN",
    "5UC44i2x2GHNTH5rBTnfVrwhyMEHeQEdyuS9J1SvMFKC",
    "8AXfB7Rv2EwfYSsVzp2oRCU4p2D4yNZw1izNpu1vahwi",
    "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
    "11111111111111111111111111111111",
    EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID.toBase58(),
  ],
  instructionData: "9Zq9ZwMbe2btmkyqrHpdpYiNQXW2vEPtb",
  eventData:
    "2ytdt8TmtejZES5wWFDuEAyJBU558zYTUGFDJDwJZ8F1kbBuk2u9cidFPHCYDG4nyd8BCHS4cxpXGGid9m2whN4fRZnV8y9F1DmNoNbVKkVFZSE6k6itwqofnnxzWeqfF1VDptR3ECs4YE8Mg6MBdyuJbcorkMEAnQoG3jiU1funPMhTcHRZFLeecCXvXKCV5REgUEQhJmFaM8zX8msiCg2kZutNnSWXMA7mrSKQHixBetqcnwFJBQ4yFhKHe174V4oRj8KiNuZySdNyKSgqY6qP12hbqudneD93RZaf6T5qE1LDrSENJXTceBM1pmBB2TpiWK9dxjJeUmSVPypgqbcEwVDwqw51tWxJMMvKxviaNJnZeDW1rYhAWkgSrHeMiajL7287TpdmYdLiXiYetduav5WzPGJLTbCtFEPBFXkFn3DHQ7QrcXkfhaLQve2CrvJvcQ44KSDMxhV8iHr3ehnD6GXXydo1XyLu4JSZByBsGsk3QrnEpF",
  balances: [
    {
      address: "87TzeDgig878oKTYEAgUFV253JQuDvYrpCEXJ1L23qxf",
      owner: "4qNVJrCVFasy9maa5jcDQhB3312qqN62JNo2opz27hD2",
      pre: "593865079355592",
      post: "596340470115102",
    },
    {
      address: "BzXro94FJ5zpaDGD7Lhk6wTsrqyu2yPY7PGAGQ53tEWT",
      owner: "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm",
      pre: "2475390759510",
      post: "0",
    },
  ],
};

const REAL_LEGACY_BUY: CompactFixture = {
  mint: "7xxiuh4VeSqCCMGacXmYDJ6m9AgMMpnKYbpun7S3pump",
  creator: "7vhczHYZixRrLYS4XVCfag4njuBY7Jm6SshNp2TpGYrR",
  signature:
    "3EL4UAEJrv21EjYdtLtSnUz9ZcF3i6ogaBezDv9wz5AVkP53rjtd6fxrKhMtK1tz83dwNAuMUr7uaJomaRfmXzs2",
  slot: 441_302_725,
  blockTime: 1_787_541_123,
  signers: ["7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi"],
  instructionAccounts: [
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
    "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
    "7xxiuh4VeSqCCMGacXmYDJ6m9AgMMpnKYbpun7S3pump",
    "3RkS3Fk5ra3dbwgUreVqxGDPbjCk5FVFHCHi8NCd9Kdf",
    "HspRQD2yDWJ27zmDQ91mbr17g6xQy2CWq9CHAToJEqRr",
    "DNX5h7KaySS6uFLvYNyk8qSkZDuo9M1t4dBxtscoUarL",
    "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi",
    "11111111111111111111111111111111",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "6UnMCZBbMkRbihYSjuPcRt9W1d93WwarkPxWs68mFyH1",
    EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID.toBase58(),
    "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y",
    "ENPV3zgWteGvJJiueBXzPFasCTMjFJkts8o2MY6FuMko",
    "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt",
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
    "CCogHNTDBRH5TKrfMJdb83sq4xbozmhUo5c3BNzQYsCg",
    "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  ],
  instructionData: "AJTQ2h9DXrBnkBSrMyZYgPEoQpKFtfqiP",
  eventData:
    "T2jLjveMmM4gJ1fdXs3mfxZTgvGBep6tJp5jS59qBxCNGQpFCNs6B8uwh5cqvUU1mgoqkyiAoAyikYuz45LXaBs44AypTvycWFMKFHaM3dTjKciF9nBeAJF68rzphNt9acLXYUizibxJ2vSh2qAH9WqHyFi7MtAqLrPx7Ee9FDLahc8hGYA8F9XHkeWxAHc72U7D6a2ThYTaJ5gSWhGscg2zezx5gwSNoHEgCQHQSzUT2JkVJ7oEhNy8wtHqmvuY1ABox8frwy4tPHLkHWL23wtPQeMdeVHL2YFSo3KsoLUicMFGpQUapUWLuhEHHDiSFj9B9YhxscYktGr9weJe6E82U131fX8TjBWkn71NMpMW2PjHVAAn5PLZaHScrSjeqGQ8dFPe5tQBeCNoerdKhuwZbDWYLEnR4x5FNgwzVewqSRGgCyWC8fTXq3EhF5rGqLb9vNqb5MYrtjTUB2Zvr2L9sP9g5ZfiZ6GkwERZ6h1He5FMbTaF",
  balances: [
    {
      address: "HspRQD2yDWJ27zmDQ91mbr17g6xQy2CWq9CHAToJEqRr",
      owner: "3RkS3Fk5ra3dbwgUreVqxGDPbjCk5FVFHCHi8NCd9Kdf",
      pre: "998211616000000",
      post: "996417508639155",
    },
    {
      address: "9UFGbWJdLdZYabF79cfGCcsm3pA44foKXsadaUi3mZLt",
      owner: "8TaVq1PB9hwm2wBFCc4Ne26jKeWpSziWktq3iskFp8vS",
      post: "1794107360845",
    },
  ],
};

function contract(fixture: CompactFixture): FreshTailMintContract {
  const mint = new PublicKey(fixture.mint);
  return {
    mint: fixture.mint,
    bondingCurve: pumpFunBondingCurveAddress(mint).toBase58(),
    creator: fixture.creator,
    createVariant: "create_v2_token2022",
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    totalSupplyRaw: "1000000000000000",
    decimals: 6,
  };
}

function transaction(fixture: CompactFixture): ParsedTransactionWithMeta {
  const keys = [
    ...fixture.signers,
    PUMP_FUN_PROGRAM_ID.toBase58(),
    EVENT_AUTHORITY,
    ...fixture.instructionAccounts,
    ...fixture.balances.map((row) => row.address),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const indexOf = (address: string) => {
    const index = keys.indexOf(address);
    assert.ok(index >= 0);
    return index;
  };
  const balance = (row: CompactFixture["balances"][number], amount: string) => ({
    accountIndex: indexOf(row.address),
    mint: fixture.mint,
    owner: row.owner,
    programId: TOKEN_2022_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount },
  });
  return {
    slot: fixture.slot,
    blockTime: fixture.blockTime,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: keys.map(() => 0),
      postBalances: keys.map(() => 0),
      preTokenBalances: fixture.balances.flatMap((row) =>
        row.pre === undefined ? [] : [balance(row, row.pre)],
      ),
      postTokenBalances: fixture.balances.flatMap((row) =>
        row.post === undefined ? [] : [balance(row, row.post)],
      ),
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: new PublicKey(PUMP_FUN_PROGRAM_ID),
              accounts: [new PublicKey(EVENT_AUTHORITY)],
              data: fixture.eventData,
            } as any,
          ],
        },
      ],
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: keys.map((pubkey) => ({
          pubkey: new PublicKey(pubkey),
          signer: fixture.signers.includes(pubkey),
          writable: true,
        })),
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [
          {
            programId: new PublicKey(PUMP_FUN_PROGRAM_ID),
            accounts: fixture.instructionAccounts.map((address) => new PublicKey(address)),
            data: fixture.instructionData,
          } as any,
        ],
      } as any,
    },
  } as ParsedTransactionWithMeta;
}

function classifyRecipients(
  recipients: readonly { wallet: string; amountRaw: string; preRaw: string; postRaw: string }[],
): FreshTailRecipientClassification[] {
  return recipients.map((recipient) => ({
    ...recipient,
    classification: "post_epoch_descendant",
    classificationReliable: true,
    watchable: true,
  }));
}

function balanceOnlyTransaction(input: {
  sourceWallet: string;
  sourceAccount: string;
  sourcePreRaw: bigint;
  sourcePostRaw: bigint;
  recipients?: Array<{ wallet: string; account: string; preRaw: bigint; postRaw: bigint }>;
  burn?: boolean;
}): ParsedTransactionWithMeta {
  const recipients = input.recipients ?? [];
  const mint = REAL_V2_FORWARDED_BUY.mint;
  const keys = [
    input.sourceWallet,
    input.sourceAccount,
    mint,
    TOKEN_2022_PROGRAM_ID.toBase58(),
    ...recipients.flatMap((recipient) => [recipient.wallet, recipient.account]),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const indexOf = (address: string) => keys.indexOf(address);
  const tokenBalance = (account: string, owner: string, amount: bigint) => ({
    accountIndex: indexOf(account),
    mint,
    owner,
    programId: TOKEN_2022_PROGRAM_ID.toBase58(),
    uiTokenAmount: {
      amount: amount.toString(),
      decimals: 6,
      uiAmount: null,
      uiAmountString: amount.toString(),
    },
  });
  const outflow = input.sourcePreRaw - input.sourcePostRaw;
  const burnData = Buffer.alloc(9);
  burnData[0] = 8;
  burnData.writeBigUInt64LE(outflow, 1);
  return {
    slot: 441_400_000,
    blockTime: 1_787_576_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: keys.map(() => 0),
      postBalances: keys.map(() => 0),
      preTokenBalances: [
        tokenBalance(input.sourceAccount, input.sourceWallet, input.sourcePreRaw),
        ...recipients.map((recipient) =>
          tokenBalance(recipient.account, recipient.wallet, recipient.preRaw),
        ),
      ],
      postTokenBalances: [
        tokenBalance(input.sourceAccount, input.sourceWallet, input.sourcePostRaw),
        ...recipients.map((recipient) =>
          tokenBalance(recipient.account, recipient.wallet, recipient.postRaw),
        ),
      ],
      innerInstructions: [],
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      signatures: ["balance-only-finalized-signature"],
      message: {
        accountKeys: keys.map((pubkey) => ({
          pubkey: new PublicKey(pubkey),
          signer: pubkey === input.sourceWallet,
          writable: true,
        })),
        recentBlockhash: "11111111111111111111111111111111",
        instructions: input.burn
          ? [
              {
                programId: TOKEN_2022_PROGRAM_ID,
                accounts: [
                  new PublicKey(input.sourceAccount),
                  new PublicKey(mint),
                  new PublicKey(input.sourceWallet),
                ],
                data: bs58.encode(burnData),
              } as any,
            ]
          : [],
      } as any,
    },
  } as ParsedTransactionWithMeta;
}

test("real current V2 buy produces exact Supply, logical target, transfer, and TradeEvent evidence", () => {
  const decoded = decodeFreshTailFinalizedTransaction(
    transaction(REAL_V2_FORWARDED_BUY),
    contract(REAL_V2_FORWARDED_BUY),
    REAL_V2_FORWARDED_BUY.signers[0]!,
    "root",
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.supplyEvents.length, 1);
  assert.equal(decoded.supplyEvents[0]!.side, "BUY");
  assert.equal(decoded.supplyEvents[0]!.amountRaw, "58163112117035");
  assert.deepEqual(
    decoded.custodyEvents.map((event) => event.eventKind),
    ["TARGET_BUY", "TRANSFER"],
  );
  assert.deepEqual(
    {
      pre: decoded.custodyEvents[0]!.sourcePreRaw,
      post: decoded.custodyEvents[0]!.sourcePostRaw,
      amount: decoded.custodyEvents[0]!.amountRaw,
    },
    { pre: "0", post: "58163112117035", amount: "58163112117035" },
  );
  assert.equal(decoded.custodyEvents[1]!.sourcePreRaw, "58163112117035");
  assert.equal(decoded.custodyEvents[1]!.sourcePostRaw, "0");
  assert.deepEqual(decoded.custodyEvents[1]!.recipients, [
    {
      wallet: "8UAFxVEDxe3aDAmuHp9j8xwta6apawVGJU1JFei6eFJA",
      amountRaw: "58163112117035",
      preRaw: "0",
      postRaw: "58163112117035",
    },
  ]);
  assert.equal(decoded.pumpTradeEventEvidence?.instructionName, "buy_exact_quote_in");
  assert.equal(decoded.pumpTradeEventEvidence?.virtualTokenReservesRaw, "771101699536718");
  assert.equal(decoded.pumpTradeEventEvidence?.virtualSolReservesLamports, "41745466333");
  assert.equal(decoded.rootBuyEvidence?.grossAmountRaw, "58163112117035");

  const finalized = finalizeFreshTailCustodyEvent(
    decoded.custodyEvents[1]!,
    classifyRecipients(decoded.custodyEvents[1]!.recipients),
  );
  assert.ok(finalized);
  assert.match(finalized.payloadFingerprint, /^[0-9a-f]{64}$/);
});

test("unenrolled root discovery derives and rebinds exact V2 and legacy-buy contracts", () => {
  for (const fixture of [REAL_V2_FORWARDED_BUY, REAL_LEGACY_BUY]) {
    const discovered = discoverFreshTailRootPumpBuys(
      transaction(fixture),
      fixture.signers[0]!,
    );
    assert.equal(discovered.ok, true);
    if (!discovered.ok) continue;
    assert.equal(discovered.discoveries.length, 1);
    assert.equal(discovered.discoveries[0]!.tokenMint, fixture.mint);
    assert.equal(discovered.discoveries[0]!.contract.creator, fixture.creator);
    assert.equal(discovered.discoveries[0]!.contract.createVariant, "create_v2_token2022");
    assert.equal(discovered.discoveries[0]!.decoded.ok, true);
  }
});

test("real current V2 sell is Supply-only for a root and Custody-only for a descendant", () => {
  const watched = "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm";
  const root = decodeFreshTailFinalizedTransaction(
    transaction(REAL_V2_DESCENDANT_SELL),
    contract(REAL_V2_DESCENDANT_SELL),
    watched,
    "root",
  );
  assert.equal(root.ok, true);
  if (!root.ok) return;
  assert.deepEqual(root.supplyEvents.map((event) => event.side), ["SELL"]);
  assert.deepEqual(root.custodyEvents, []);
  assert.equal(root.pumpTradeEventEvidence?.instructionName, "sell");

  const descendant = decodeFreshTailFinalizedTransaction(
    transaction(REAL_V2_DESCENDANT_SELL),
    contract(REAL_V2_DESCENDANT_SELL),
    watched,
    "descendant",
  );
  assert.equal(descendant.ok, true);
  if (!descendant.ok) return;
  assert.deepEqual(descendant.supplyEvents, []);
  assert.equal(descendant.custodyEvents[0]!.eventKind, "SELL");
  assert.equal(descendant.custodyEvents[0]!.amountRaw, "2475390759510");
});

test("real Token-2022 mint using legacy buy ABI remains exactly reviewed", () => {
  const decoded = decodeFreshTailFinalizedTransaction(
    transaction(REAL_LEGACY_BUY),
    contract(REAL_LEGACY_BUY),
    REAL_LEGACY_BUY.signers[0]!,
    "root",
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.rootBuyEvidence?.grossAmountRaw, "1794107360845");
  assert.equal(decoded.pumpTradeEventEvidence?.instructionName, "buy");
  assert.deepEqual(decoded.custodyEvents.map((event) => event.eventKind), [
    "TARGET_BUY",
    "TRANSFER",
  ]);
});

test("missing or mutated exact trade evidence fails closed", () => {
  const missingEvent = transaction(REAL_V2_FORWARDED_BUY);
  missingEvent.meta!.innerInstructions = [];
  const absent = decodeFreshTailFinalizedTransaction(
    missingEvent,
    contract(REAL_V2_FORWARDED_BUY),
    REAL_V2_FORWARDED_BUY.signers[0]!,
    "root",
  );
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.match(absent.reason, /TradeEvent/);

  const wrongAccount = structuredClone(REAL_V2_FORWARDED_BUY);
  wrongAccount.instructionAccounts[10] = REAL_V2_FORWARDED_BUY.signers[0]!;
  const mutated = decodeFreshTailFinalizedTransaction(
    transaction(wrongAccount),
    contract(wrongAccount),
    wrongAccount.signers[0]!,
    "root",
  );
  assert.equal(mutated.ok, false);
  if (!mutated.ok) assert.equal(mutated.code, "pump_instruction_conflict");

  const wrongRaw = structuredClone(REAL_V2_FORWARDED_BUY);
  wrongRaw.balances[1]!.post = "58163112117034";
  const nonConserving = decodeFreshTailFinalizedTransaction(
    transaction(wrongRaw),
    contract(wrongRaw),
    wrongRaw.signers[0]!,
    "root",
  );
  assert.equal(nonConserving.ok, false);
  if (!nonConserving.ok) assert.equal(nonConserving.code, "token_balance_invalid");
});

test("failed finalized transaction emits no evidence", () => {
  const tx = transaction(REAL_V2_FORWARDED_BUY);
  tx.meta!.err = { InstructionError: [0, "Custom"] };
  const decoded = decodeFreshTailFinalizedTransaction(
    tx,
    contract(REAL_V2_FORWARDED_BUY),
    REAL_V2_FORWARDED_BUY.signers[0]!,
    "root",
  );
  assert.deepEqual(decoded, { ok: true, supplyEvents: [], custodyEvents: [] });
});

test("recipient finalization is exact, sorted, and fail-closed", () => {
  const decoded = decodeFreshTailFinalizedTransaction(
    transaction(REAL_V2_FORWARDED_BUY),
    contract(REAL_V2_FORWARDED_BUY),
    REAL_V2_FORWARDED_BUY.signers[0]!,
    "root",
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  const transfer = decoded.custodyEvents[1]!;
  const classified = classifyRecipients(transfer.recipients);
  const stable = finalizeFreshTailCustodyEvent(transfer, classified);
  assert.ok(stable);
  assert.equal(finalizeFreshTailCustodyEvent(transfer, []), null);
  assert.equal(
    finalizeFreshTailCustodyEvent(transfer, [
      { ...classified[0]!, amountRaw: (BigInt(classified[0]!.amountRaw) + 1n).toString() },
    ]),
    null,
  );
  const unwatchable = finalizeFreshTailCustodyEvent(transfer, [
    { ...classified[0]!, watchable: false },
  ]);
  assert.ok(unwatchable);
  assert.equal(unwatchable.watchable, false);
});

test("large raw multi-recipient transfer conserves exactly without Number conversion", () => {
  const source = "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm";
  const tx = balanceOnlyTransaction({
    sourceWallet: source,
    sourceAccount: "BzXro94FJ5zpaDGD7Lhk6wTsrqyu2yPY7PGAGQ53tEWT",
    sourcePreRaw: 1n << 61n,
    sourcePostRaw: 0n,
    recipients: [
      {
        wallet: "8UAFxVEDxe3aDAmuHp9j8xwta6apawVGJU1JFei6eFJA",
        account: "Ey1LiWPWAXUXKz1keQ1TtRCkug5J15JiWP14ecDzWXix",
        preRaw: 7n,
        postRaw: 7n + (1n << 60n),
      },
      {
        wallet: "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi",
        account: "DNX5h7KaySS6uFLvYNyk8qSkZDuo9M1t4dBxtscoUarL",
        preRaw: 11n,
        postRaw: 11n + (1n << 60n),
      },
    ],
  });
  const decoded = decodeFreshTailFinalizedTransaction(
    tx,
    contract(REAL_V2_FORWARDED_BUY),
    source,
    "descendant",
  );
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(decoded.custodyEvents[0]!.eventKind, "TRANSFER");
  assert.equal(decoded.custodyEvents[0]!.amountRaw, (1n << 61n).toString());
  assert.deepEqual(
    decoded.custodyEvents[0]!.recipients.map((recipient) => recipient.wallet),
    [
      "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi",
      "8UAFxVEDxe3aDAmuHp9j8xwta6apawVGJU1JFei6eFJA",
    ],
  );
});

test("exact token burn is terminal while unexplained loss is unresolved", () => {
  const source = "B4ns9ybQL3deaLZdSzv8j412MiudXp3L5LcvFPkCHQcm";
  const sourceAccount = "BzXro94FJ5zpaDGD7Lhk6wTsrqyu2yPY7PGAGQ53tEWT";
  const burned = decodeFreshTailFinalizedTransaction(
    balanceOnlyTransaction({
      sourceWallet: source,
      sourceAccount,
      sourcePreRaw: 999n,
      sourcePostRaw: 0n,
      burn: true,
    }),
    contract(REAL_V2_FORWARDED_BUY),
    source,
    "descendant",
  );
  assert.equal(burned.ok, true);
  if (!burned.ok) return;
  assert.equal(burned.custodyEvents[0]!.eventKind, "TERMINAL_OUTFLOW");
  assert.equal(burned.custodyEvents[0]!.watchable, false);

  const unresolved = decodeFreshTailFinalizedTransaction(
    balanceOnlyTransaction({
      sourceWallet: source,
      sourceAccount,
      sourcePreRaw: 999n,
      sourcePostRaw: 0n,
    }),
    contract(REAL_V2_FORWARDED_BUY),
    source,
    "descendant",
  );
  assert.equal(unresolved.ok, true);
  if (!unresolved.ok) return;
  assert.equal(unresolved.custodyEvents[0]!.eventKind, "UNRESOLVED_OUTFLOW");
  assert.equal(unresolved.custodyEvents[0]!.watchable, false);
});

test("all frozen parser domains have explicit stable 64-hex identities", () => {
  assert.deepEqual(FRESH_TAIL_PARSER_ABIS, {
    pump_root_buy_v1: "b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d",
    custody_target_buy_v1:
      "bd230909bd66718382a71c387324fefc840aa108089afcc01b61cb7115948f0c",
    supply_sell_v1: "d6a4aa7b14969befcfa858192c539b2cbb4738db4a739f1230b4c82c001c4412",
    custody_transfer_v1:
      "c50f0e09f75de355db936a95832046bc61f1d5b16eff81040528eadfc305422d",
    custody_sell_v1: "f39f4582dbe8bd04f91375a61be0b83b750658cca7c51354cbeb335a86dab401",
    custody_unresolved_v1:
      "8e6fe7600bfc983a35faa7cf1f6c79cdac5337080c551fa8accca4d62856995c",
    custody_terminal_v1:
      "0858d3736e2eb29b82a1a9ef17b51246880561047aeb1ce8a12b701e3529aac4",
  });
});

test("fixture instruction and event data are canonical base58", () => {
  for (const fixture of [REAL_V2_FORWARDED_BUY, REAL_V2_DESCENDANT_SELL, REAL_LEGACY_BUY]) {
    assert.equal(bs58.encode(bs58.decode(fixture.instructionData)), fixture.instructionData);
    assert.equal(bs58.encode(bs58.decode(fixture.eventData)), fixture.eventData);
  }
});
