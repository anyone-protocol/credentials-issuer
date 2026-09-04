const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Exact decimal comparison. Amounts arrive as strings and must never go through
 * a float: "1.10" and "1.1" are the same price, and 0.1 + 0.2 is not 0.3.
 */
export function decimalEquals(left: string, right: string): boolean {
  const a = scaled(left);
  const b = scaled(right);
  return a !== null && b !== null && a === b;
}

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

/** Value scaled to a fixed 18 decimal places, so trailing zeros do not matter. */
function scaled(value: string): bigint | null {
  if (!DECIMAL.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > 18) return null;
  const magnitude = BigInt(whole + fraction.padEnd(18, '0'));
  return negative ? -magnitude : magnitude;
}
