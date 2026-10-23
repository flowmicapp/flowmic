// NR-245 (GUARD-2, 2026-10-13): a number belongs to what it counts.
//
// 「三个苹果五个梨」 -> 「三个梨五个苹果」 keeps the values in order (3, 5), every
// character count and every closed-class count, so smooth accepted it: the
// open-class budget saw a handful of changed characters. What changed is
// which noun each number counts. The QP-1 numbers gate already compares the
// values as a SEQUENCE for exactly this reason (nr118-017, 「三个苹果五个梨」 ->
// 「5个苹果3个梨」); this is the other half — the values stay, the nouns move.
//
// Each number gets the word it counts (after it: skip one measure word, then
// up to two Han characters or one Latin word) and the word it follows. A swap
// is two numbers with different values whose contexts trade places between
// input and output. An edit that only rewrites a context (「三个呃苹果」 ->
// 「三个苹果」) is not a swap, so filler removal next to a number is untouched.
import { readNumbers } from './stt-polish-guard-numbers';

const MEASURE = new RegExp(`^[${'个位只条张本件台辆家次天年月周岁块元斤米'}]`, 'u');
const STOP = /[\s，。,.!?！？；;:：、¤]/u;

function afterContext(surface: string, end: number): string {
  let rest = surface.slice(end).replace(/^\s+/u, '');
  rest = rest.replace(MEASURE, '');
  const latin = /^\p{Script=Latin}+/u.exec(rest);
  if (latin) return latin[0].toLowerCase();
  let out = '';
  for (const c of rest) {
    if (!/\p{Script=Han}/u.test(c) || STOP.test(c) || /[零〇一幺二两三四五六七八九十百千万亿]/u.test(c) || out.length >= 2) break;
    out += c;
  }
  return out;
}

function beforeContext(surface: string, at: number): string {
  const head = surface.slice(0, at).replace(/\s+$/u, '');
  const latin = /\p{Script=Latin}+$/u.exec(head);
  if (latin) return latin[0].toLowerCase();
  let out = '';
  for (const c of [...head].reverse()) {
    if (!/\p{Script=Han}/u.test(c) || STOP.test(c) || /[零〇一幺二两三四五六七八九十百千万亿第]/u.test(c) || out.length >= 2) break;
    out = c + out;
  }
  return out;
}

function swapped(values: readonly string[], a: readonly string[], b: readonly string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      if (values[i] === values[j] || !a[i] || !a[j] || a[i] === a[j]) continue;
      if (a[i] === b[j] && a[j] === b[i]) return true;
    }
  }
  return false;
}

/** True when two numbers with different values trade the nouns they count.
 *  Only meaningful once the value sequences are equal (numberDrift false). */
export function numberSubjectSwap(raw: string, polished: string, lang?: string): boolean {
  const a = readNumbers(raw, lang);
  const b = readNumbers(polished, lang);
  if (a.spans.length !== b.spans.length || a.spans.length < 2) return false;
  const values = a.spans.map((s) => s.value);
  if (!b.spans.every((s, i) => s.value === values[i])) return false;
  const afterA = a.spans.map((s) => afterContext(a.surface, s.end));
  const afterB = b.spans.map((s) => afterContext(b.surface, s.end));
  const beforeA = a.spans.map((s) => beforeContext(a.surface, s.at));
  const beforeB = b.spans.map((s) => beforeContext(b.surface, s.at));
  return swapped(values, afterA, afterB) || swapped(values, beforeA, beforeB);
}
