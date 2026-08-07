export function parseJupiterPrice(payload: unknown, mint: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const v3Row = root[mint];
  if (v3Row && typeof v3Row === "object") {
    const price = Number((v3Row as Record<string, unknown>).usdPrice);
    if (Number.isFinite(price) && price > 0) return price;
  }
  const legacyData = root.data;
  if (legacyData && typeof legacyData === "object") {
    const legacyRow = (legacyData as Record<string, unknown>)[mint];
    if (legacyRow && typeof legacyRow === "object") {
      const price = Number((legacyRow as Record<string, unknown>).price);
      if (Number.isFinite(price) && price > 0) return price;
    }
  }
  return undefined;
}
