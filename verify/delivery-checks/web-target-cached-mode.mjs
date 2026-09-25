// verify/delivery-checks/web-target-cached-mode.mjs — delivery gate stage
// `verify:web-target-cached-mode`. NOT a lint, and that is the point.
//
// The lead-maintainer ruling (owner may overturn it):
// docs/decisions/2026-09-22-inject-target-not-ready-lead-ruling-and-cached-mode-pin.md
// Old phones do not know this code. Only cached preserves their pending face
// while the existing outbox keeps retrying. Read the actual sibling producer,
// never a copied fixture.
//
// This checks the exported TargetSession.onInjectRequest admission arm and
// executes its actual payload builder. It is a source contract, not a browser
// or socket delivery proof. Refactors outside the checked shape fail explicitly.
//
// ── WHY THIS IS NOT IN `verify:lint` (moved 2026-09-23) ─────────────────────
// It was first registered in verify/lint/run-all.mjs, which pre-commit runs on
// every commit, and it answered "missing sibling" with FAIL. Its answer depends
// on whether ANOTHER repository has caught up: on a machine whose flowmic-web
// checkout sat on a branch without the producer it failed, so no commit of any
// kind (a docs-only one included) could land, and CI, which has no sibling
// checkout, could never pass it. A check that gates every commit may only ask
// about that commit. It now runs in the delivery gates only (package.json
// `verify:delivery`, the TSC lane of verify/run-delivery-fast.mjs, selected by
// verify/lane-map.mjs).
//
// ── THE THREE ANSWERS ────────────────────────────────────────────────────────
//   · No flowmic-web checkout at all (no searched place is a directory, or
//     FLOWMIC_WEB_CLIENT_REPO names one that is not) ⇒ SKIP with the reason and
//     every path looked at. Same rule as the two existing cross-repo mirrors
//     (verify/lint/spoken-langs-mirror.mjs, verify/lint/mobile-web-tokens-
//     mirror.mjs: "A MISSING SIBLING IS A SKIP, NEVER A PASS"). An explicit
//     override REPLACES the search; a wrong override skips, it never falls
//     back to another checkout and reports about a tree nobody named.
//   · A checkout is there but carries no INJECT_TARGET_NOT_READY producer
//     (session.ts missing, or no string literal of the code in it) ⇒ FAIL,
//     naming where the producer lives and what has to happen.
//   · A producer is there ⇒ inspectProducer() below, unchanged and exactly as
//     strict: wrong mode, a spread, a moved send, a builder that rewrites the
//     payload, or a stale citation in inject-verdict-authorship.ts all FAIL.
import path from 'node:path';
import { statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { ROOT } from '../lint/_util.mjs';
import { runAsCommand } from './_cli.mjs';

export const name = 'web-target-cached-mode';
const ts = createRequire(path.join(ROOT, 'packages/protocol/package.json'))('typescript');
const SESSION = 'packages/core/src/target/session.ts';
const WIRE = 'packages/core/src/target/wire.ts';
const CODE = 'INJECT_TARGET_NOT_READY';
export const PRODUCER_BRANCH = 'feat/web-mic-choice-embed';

export function clientRoots() {
  if (process.env.FLOWMIC_WEB_CLIENT_REPO) {
    return [{ dir: path.resolve(process.env.FLOWMIC_WEB_CLIENT_REPO), viaEnv: true }];
  }
  const roots = [path.resolve(ROOT, '..', 'flowmic-web')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    roots.push(path.resolve(common, '../..', 'flowmic-web'));
  } catch { /* No git discovery; the direct sibling path is still searched. */ }
  return [...new Set(roots)].map((dir) => ({ dir, viaEnv: false }));
}

const isDirectory = (dir) => {
  try { return statSync(dir).isDirectory(); } catch { return false; }
};

function branchOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return 'an unknown branch'; }
}

const named = (node, name) => node?.name?.getText() === name;
const literal = (node, value) => node && ts.isStringLiteral(node) && node.text === value;
const walk = (node, predicate) => {
  const found = [];
  function visit(n) { if (predicate(n)) found.push(n); ts.forEachChild(n, visit); }
  visit(node);
  return found;
};
function exactlyOne(nodes, label) {
  if (nodes.length !== 1) throw new Error(`${label}: expected one production node, found ${nodes.length}`);
  return nodes[0];
}

export function inspectProducer(sessionText, wireText) {
  const source = ts.createSourceFile(SESSION, sessionText, ts.ScriptTarget.Latest, true);
  const klass = exactlyOne(source.statements.filter((n) => ts.isClassDeclaration(n) && named(n, 'TargetSession')
    && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)), 'exported TargetSession');
  const method = exactlyOne(klass.members.filter((n) => ts.isMethodDeclaration(n) && named(n, 'onInjectRequest')), 'onInjectRequest');
  const guard = exactlyOne(method.body.statements.filter((n) => ts.isIfStatement(n)
    && n.expression.getText(source).replace(/\s/g, '') === "this.admission!=='open'"), 'admission refusal guard');
  // The error literal must be a real property in the guarded, directly sent
  // payload, not a comment, a fixture object or another method's unused value.
  const code = exactlyOne(walk(source, (n) => literal(n, CODE)), CODE);
  const object = code.parent.parent;
  if (!ts.isPropertyAssignment(code.parent) || !named(code.parent, 'error') || !ts.isObjectLiteralExpression(object)) {
    throw new Error(`${CODE} must be the error property of the production payload`);
  }
  const builder = object.parent;
  const send = builder.parent;
  if (!ts.isCallExpression(builder) || builder.expression.getText(source) !== 'buildInjectResultPayload'
    || !ts.isCallExpression(send) || send.expression.getText(source) !== 'this.send'
    || !literal(send.arguments[0], 'inject:result') || send.arguments[1] !== builder
    || send.parent.parent !== guard.thenStatement) throw new Error(`${CODE} is no longer directly emitted by the admission arm`);
  const mode = exactlyOne(object.properties.filter((n) => ts.isPropertyAssignment(n) && named(n, 'mode')), 'payload mode');
  if (!literal(mode.initializer, 'cached')) throw new Error(`${CODE} must emit mode:'cached'; found ${mode.initializer.getText(source)}`);
  if (object.properties.some((n) => ts.isSpreadAssignment(n))) throw new Error('Admission payload spreads require a new mode proof');
  const ok = exactlyOne(object.properties.filter((n) => ts.isPropertyAssignment(n) && named(n, 'ok')), 'payload ok');
  if (ok.initializer.kind !== ts.SyntaxKind.FalseKeyword) throw new Error('Admission refusal must emit ok:false');

  // Run the actual builder declaration too: pinning its input alone would
  // miss a builder that rewrites mode before the transport sees the payload.
  const wire = ts.createSourceFile(WIRE, wireText, ts.ScriptTarget.Latest, true);
  const fn = exactlyOne(wire.statements.filter((n) => ts.isFunctionDeclaration(n) && named(n, 'buildInjectResultPayload')), 'payload builder');
  const javascript = ts.transpileModule(fn.getText(wire), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ exports: {} });
  vm.runInContext(javascript, context, { timeout: 1000 });
  const receipt = context.exports.buildInjectResultPayload({ ok: false, mode: 'cached', error: CODE, requestId: 'mode-pin', entryId: null });
  if (receipt.mode !== 'cached' || receipt.ok !== false || receipt.error !== CODE) throw new Error('Production payload builder rewrote the cached refusal');
  return source.getLineAndCharacterOfPosition(send.getStart(source)).line + 1;
}

/** How many string-literal nodes spell the code in the session source. Zero
 *  means the producer is absent (a comment mentioning the code is not a node,
 *  so a develop-branch note about it does not count as a producer). */
export function producerLiteralCount(sessionText) {
  const source = ts.createSourceFile(SESSION, sessionText, ts.ScriptTarget.Latest, true);
  return walk(source, (n) => literal(n, CODE)).length;
}

export default async function run() {
  const roots = clientRoots();
  const present = roots.find((r) => isDirectory(r.dir));
  if (!present) {
    return {
      status: 'SKIP',
      detail:
        `no flowmic-web checkout on this machine, so the web target's ${CODE} receipt was NOT checked `
        + "for mode:'cached' — nothing about that producer was verified here. "
        + `Looked in: ${roots.map((r) => `${r.dir}${r.viaEnv ? ' (FLOWMIC_WEB_CLIENT_REPO)' : ''}`).join(', ')}. `
        + 'Set FLOWMIC_WEB_CLIENT_REPO to the checkout that carries the producer.',
    };
  }
  const root = present.dir;
  const shown = `${root}${present.viaEnv ? ' (FLOWMIC_WEB_CLIENT_REPO)' : ''}`;
  let sessionText = null;
  try { sessionText = await readFile(path.join(root, SESSION), 'utf8'); } catch { /* absent producer: below */ }
  if (sessionText === null || producerLiteralCount(sessionText) === 0) {
    return {
      status: 'FAIL',
      detail:
        `producer not found: ${shown} is a flowmic-web checkout (on ${branchOf(root)}) but ${SESSION} `
        + `${sessionText === null ? 'does not exist' : `carries no ${CODE} producer`}. `
        + `The producer lives on flowmic-web branch ${PRODUCER_BRANCH} and must land on that repository's `
        + 'default branch before this check can pass without FLOWMIC_WEB_CLIENT_REPO; until then run the '
        + `gate with FLOWMIC_WEB_CLIENT_REPO pointing at a checkout of ${PRODUCER_BRANCH}.`,
    };
  }
  try {
    const wireText = await readFile(path.join(root, WIRE), 'utf8');
    const line = inspectProducer(sessionText, wireText);
    // coordinate-anchors resolves only this repository. The explicitly
    // named sibling citation is checked here against the actual emit node.
    const authorship = await readFile(path.join(ROOT, 'packages/protocol/src/inject-verdict-authorship.ts'), 'utf8');
    const citation = /Producer in flowmic-web: `packages\/core\/src\/target\/session\.ts`:(\d+)/.exec(authorship);
    if (!citation || Number(citation[1]) !== line) {
      throw new Error(`inject-verdict-authorship.ts producer citation must point to the actual send at ${SESSION}:${line}`);
    }
    return { status: 'PASS', detail: `${await realpath(root)}/${SESSION}:${line} emits ${CODE} with mode:'cached'; actual wire builder preserves it` };
  } catch (error) {
    return { status: 'FAIL', detail: `${shown}/${SESSION}: ${error.message}` };
  }
}

await runAsCommand(import.meta.url, name, run);
