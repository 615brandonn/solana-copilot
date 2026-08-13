/**
 * Return only the positive balance change attributable to one landed buy.
 * The wallet's pre-existing/manual holdings are deliberately excluded.
 */
export function attributablePositiveBalanceDelta(
  preBalanceUi: number,
  postBalanceUi: number,
): number | undefined {
  if (
    !Number.isFinite(preBalanceUi) ||
    !Number.isFinite(postBalanceUi) ||
    preBalanceUi < 0 ||
    postBalanceUi < 0
  ) {
    return undefined;
  }
  const delta = postBalanceUi - preBalanceUi;
  return Number.isFinite(delta) && delta > 0 ? delta : undefined;
}
