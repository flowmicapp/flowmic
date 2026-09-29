// NR118-4. Deliberately integer-only. 点 may mean a decimal point or o'clock.
const DIGIT: Record<string, bigint> = { 零: 0n, 〇: 0n, 一: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n, 六: 6n, 七: 7n, 八: 8n, 九: 9n, 幺: 1n };
const SMALL: Record<string, bigint> = { 十: 10n, 百: 100n, 千: 1000n };
export const HAN_NUMBER = /^[零〇一二两三四五六七八九十百千万亿億幺]+$/;
export const NUMBER_CHAR = /[零〇一二两三四五六七八九十百千万亿億幺0-9]/;
export const LEX_NUM = new Set(['十分', '千万', '万一', '一一']);
export const UNIT_CJK = new Set([...'个位次年月日号分秒元块岁天周人本张条件台家米斤倍%つ個回円歳枚時冊冊辆箱公斤公里小时分钟秒钟']);

/** Reject malformed unit order, repeated units and ambiguous digit runs with units. */
export function parseHanInteger(s: string): bigint | null {
  if (!HAN_NUMBER.test(s)) return null;
  if (!/[十百千万亿億]/.test(s)) return BigInt([...s].map(c => DIGIT[c]!.toString()).join(''));
  for (const [unit, value] of [['亿', 100000000n], ['億', 100000000n], ['万', 10000n]] as const) {
    if (!s.includes(unit)) continue;
    const parts = s.split(unit);
    if (parts.length !== 2 || !parts[0]) return null;
    const left = parseHanInteger(parts[0]);
    const rightText = parts[1]!.replace(/^[零〇]/, '');
    const right = rightText ? parseHanInteger(rightText) : 0n;
    if (left === null || right === null || left <= 0n || left >= value || right >= value) return null;
    return left * value + right;
  }
  let total = 0n, pending: bigint | null = null, previousUnit = 10000n, zero = false;
  for (const [i, c] of [...s].entries()) {
    const digit = DIGIT[c];
    if (digit !== undefined) {
      if (digit === 0n) {
        if (pending !== null || zero || total === 0n) return null;
        zero = true; continue;
      }
      if (pending !== null) return null;
      pending = digit; zero = false;
    } else {
      const unit = SMALL[c];
      if (unit === undefined || unit >= previousUnit || zero) return null;
      if (pending === null && !(i === 0 && unit === 10n)) return null;
      total += (pending ?? 1n) * unit; previousUnit = unit; pending = null;
    }
  }
  if (zero) return null;
  return total + (pending ?? 0n);
}

export function numericValue(s: string): bigint | null {
  return /^[0-9]+$/.test(s) ? BigInt(s) : parseHanInteger(s);
}
