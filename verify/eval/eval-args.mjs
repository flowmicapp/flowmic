// verify/eval/eval-args.mjs
//
// Command-line arguments, parsed once at import time. Extracted VERBATIM from
// run-eval.mjs in the 800-line split.
//
// It reads `process.argv` at module scope, exactly as the original did at file
// scope. That is deliberate rather than lazy: making the modes take an options
// object would have required editing the body of every function that reads
// LIMIT/ONLY_SUITE/OUT/CONC, and the split commit's whole value is that no
// moved line changed.

const argv = process.argv.slice(2);
const arg = (k, d = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const MODE = arg('mode', 'selftest');
const ONLY_SUITE = arg('suite', null);
const LINE = arg('line', 'managed');
const LIMIT = Number(arg('limit', '0')) || 0;
const OUT = arg('out', null);
const CONC = Number(arg('concurrency', '4')) || 4;

export { argv, arg, MODE, ONLY_SUITE, LINE, LIMIT, OUT, CONC };
