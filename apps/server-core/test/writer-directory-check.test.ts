// B11 (2026-09-02, WP-6) — a machine gate against a split-brain no code
// caught before: this process's OWN env-declared role vs. what the PUBLISHED
// node directory says about the node carrying its id.
//
// SPEC-REF: apps/server-core/src/node/writer-directory-check.ts (full
//   argument); findings-crossend-multinode.md B7; audit doc §3-B B11.

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWriterDirectoryConsistency,
  assertWriterDirectoryConsistencyFromFile,
} from '../src/node/writer-directory-check';
import { NodeConfigError, type NodeConfig } from '../src/node/node-config';
import { wireNodeRuntime } from '../src/node/node-runtime';

function config(over: Partial<NodeConfig>): NodeConfig {
  return {
    role: 'single', nodeId: null, writerUrl: null, sharedSecret: null, snapshotSecret: null,
    listPath: null, outboxPath: null,
    ...over,
  };
}

describe('assertWriterDirectoryConsistency — the pure check', () => {
  it('writer + directory agrees (role:"writer") ⇒ no throw', () => {
    expect(() => assertWriterDirectoryConsistency(
      { role: 'writer', nodeId: 'srvny' },
      [{ id: 'srvny', role: 'writer' }, { id: 'srvjp' }],
    )).not.toThrow();
  });

  it('replica + directory agrees (no role, or a role that is not "writer") ⇒ no throw', () => {
    expect(() => assertWriterDirectoryConsistency(
      { role: 'replica', nodeId: 'srvjp' },
      [{ id: 'srvny', role: 'writer' }, { id: 'srvjp' }],
    )).not.toThrow();
  });

  it('🔴 THE SPLIT-BRAIN — this process says writer, the directory disagrees', () => {
    // The scene B7 names: an operator's env still says writer, but the shared
    // file has already been edited to name someone else. Every client
    // following the directory will never reach this process for first contact.
    expect(() => assertWriterDirectoryConsistency(
      { role: 'writer', nodeId: 'srvny' },
      [{ id: 'srvny' }, { id: 'srvjp', role: 'writer' }],
    )).toThrow(NodeConfigError);
  });

  it('🔴 THE OTHER SPLIT-BRAIN — this process says replica, the directory still names it writer', () => {
    // The reverse: the directory was never updated after a demotion. Every
    // registration/pairing the directory routes here is refused by
    // writer-only.ts, and nothing before this connected the symptom to the file.
    expect(() => assertWriterDirectoryConsistency(
      { role: 'replica', nodeId: 'srvjp' },
      [{ id: 'srvny' }, { id: 'srvjp', role: 'writer' }],
    )).toThrow(NodeConfigError);
  });

  it('single-node deployment ⇒ never asserts, whatever the directory says', () => {
    expect(() => assertWriterDirectoryConsistency(
      { role: 'single', nodeId: null },
      [{ id: 'srvny', role: 'writer' }],
    )).not.toThrow();
  });

  it('a nodeId the directory does not mention ⇒ nothing to compare, no throw', () => {
    // A fresh box, or a file mid-edit — a MISS is not evidence of a mismatch.
    expect(() => assertWriterDirectoryConsistency(
      { role: 'writer', nodeId: 'srvny' },
      [{ id: 'srvjp', role: 'writer' }],
    )).not.toThrow();
  });

  it('an empty directory ⇒ nothing to compare, no throw', () => {
    expect(() => assertWriterDirectoryConsistency(
      { role: 'writer', nodeId: 'srvny' },
      [],
    )).not.toThrow();
  });
});

describe('assertWriterDirectoryConsistencyFromFile — the IO wrapper', () => {
  it('no listPath ⇒ never reads a file, never throws', () => {
    const warn = vi.fn();
    expect(() => assertWriterDirectoryConsistencyFromFile(
      config({ role: 'writer', nodeId: 'srvny', listPath: null }),
      { warn },
    )).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a missing file degrades to a WARNING, never a boot failure', () => {
    const warn = vi.fn();
    expect(() => assertWriterDirectoryConsistencyFromFile(
      config({ role: 'writer', nodeId: 'srvny', listPath: join(tmpdir(), 'flowmic-does-not-exist-9a8b7c.json') }),
      { warn },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a malformed file degrades to a WARNING, never a boot failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-wdc-'));
    const listPath = join(dir, 'nodes.json');
    writeFileSync(listPath, 'not json at all {{{');
    try {
      const warn = vi.fn();
      expect(() => assertWriterDirectoryConsistencyFromFile(
        config({ role: 'writer', nodeId: 'srvny', listPath }),
        { warn },
      )).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 REAL FILE, REAL MISMATCH — throws, and does NOT warn instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-wdc-'));
    const listPath = join(dir, 'nodes.json');
    writeFileSync(listPath, JSON.stringify({
      nodes: [
        { id: 'srvny', url: 'https://srvny.flowmic.app' },
        { id: 'srvjp', url: 'https://srvjp.flowmic.app', role: 'writer' },
      ],
    }));
    try {
      const warn = vi.fn();
      expect(() => assertWriterDirectoryConsistencyFromFile(
        config({ role: 'writer', nodeId: 'srvny', listPath }),
        { warn },
      )).toThrow(NodeConfigError);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REAL FILE, REAL AGREEMENT ⇒ no throw, no warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-wdc-'));
    const listPath = join(dir, 'nodes.json');
    writeFileSync(listPath, JSON.stringify({
      nodes: [
        { id: 'srvny', url: 'https://srvny.flowmic.app', role: 'writer' },
        { id: 'srvjp', url: 'https://srvjp.flowmic.app' },
      ],
    }));
    try {
      const warn = vi.fn();
      expect(() => assertWriterDirectoryConsistencyFromFile(
        config({ role: 'writer', nodeId: 'srvny', listPath }),
        { warn },
      )).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('🔴 wireNodeRuntime — the check really is wired into the boot path, not only exported', () => {
  // Same env-mutation pattern node-forwarding.test.ts's own
  // "home_node is recorded on WHICHEVER node admits the PC" describe block
  // uses: this repo's node-runtime tests read real process.env because
  // wireNodeRuntime calls readNodeConfig() with no arguments by design (the
  // ONE place a role is resolved, node-runtime.ts's own header states).
  function boot(env: NodeJS.ProcessEnv): () => ReturnType<typeof wireNodeRuntime> {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    return () => {
      try {
        return wireNodeRuntime({
          db: { usage: {}, usageEvents: {}, raw: {} } as never,
          config: { mode: 'standalone', usageEventsEnabled: false } as never,
          log: { info: () => {}, warn: () => {}, error: () => {} },
          periodKeyFor: () => 'p',
        });
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      }
    };
  }

  it('boot THROWS on a real mismatched file — this is what an operator sees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowmic-wdc-boot-'));
    const listPath = join(dir, 'nodes.json');
    writeFileSync(listPath, JSON.stringify({
      nodes: [
        { id: 'srvny', url: 'https://srvny.flowmic.app' }, // demoted in the file
        { id: 'srvjp', url: 'https://srvjp.flowmic.app', role: 'writer' },
      ],
    }));
    try {
      const run = boot({
        FLOWMIC_NODE_ROLE: 'writer', FLOWMIC_NODE_ID: 'srvny',
        FLOWMIC_NODE_SHARED_SECRET: 's', FLOWMIC_NODE_LIST_PATH: listPath,
      });
      expect(run).toThrow(NodeConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boot succeeds when the file agrees (or there is none)', () => {
    const run = boot({
      FLOWMIC_NODE_ROLE: 'writer', FLOWMIC_NODE_ID: 'srvny',
      FLOWMIC_NODE_SHARED_SECRET: 's',
    });
    expect(run).not.toThrow();
  });
});
