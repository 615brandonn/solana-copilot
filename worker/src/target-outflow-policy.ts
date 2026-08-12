export function targetTerminalOutflowExitPct(input: {
  enabled: boolean;
  configuredPct: number;
  sourceLinked: boolean;
  fresh: boolean;
  classificationSucceeded: boolean;
  terminalAmount: number;
}): number {
  if (
    !input.enabled ||
    !input.sourceLinked ||
    !input.fresh ||
    !input.classificationSucceeded ||
    !(Number(input.terminalAmount) > 0)
  ) {
    return 0;
  }
  return Math.min(100, Math.max(0, Number(input.configuredPct) || 0));
}
