// SPEC-REF:
//   packages/protocol/src/protocol-schemas-auth.ts MobileReconnectAckNodeFieldsSchema
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-2
//
// The phone follows its PC. Rooms are per-process, so a phone on a different
// node from its PC is not in a slow room — it is in a DIFFERENT room, reporting
// the PC offline while the PC reports itself perfectly connected.

import { describe, expect, it } from 'vitest';
import { MobileReconnectAckNodeFieldsSchema } from '../src/protocol-schemas-auth';

describe('mobile:reconnect ack — the multi-node fields', () => {
  it('🔴 absence is legal, and it MEANS single-node', () => {
    // Every deployment that exists today emits neither field. If this ever stops
    // parsing, every installed phone stops reconnecting.
    expect(MobileReconnectAckNodeFieldsSchema.parse({})).toEqual({});
  });

  it('round-trips both halves', () => {
    const v = { home_node: 'srvjp', node: 'srvny' };
    expect(MobileReconnectAckNodeFieldsSchema.parse(v)).toEqual(v);
  });

  it('🔴 an EMPTY STRING is refused, because it would be a third meaning', () => {
    // "I do not know which node" and "there are no nodes" are different facts,
    // and only one of them is worth acting on. An empty string would let a
    // careless emitter express the first while every reader treats it as the
    // second — this repo's number-one shape, one value answering two questions.
    expect(MobileReconnectAckNodeFieldsSchema.safeParse({ home_node: '' }).success).toBe(false);
    expect(MobileReconnectAckNodeFieldsSchema.safeParse({ node: '' }).success).toBe(false);
  });

  it('either half may arrive without the other', () => {
    // A PC that has not reconnected since the column was added has no home_node
    // yet, while the answering node always knows its own id. That asymmetry is
    // real and the phone must cope: it can only act when it has BOTH.
    expect(MobileReconnectAckNodeFieldsSchema.parse({ node: 'srvny' })).toEqual({ node: 'srvny' });
    expect(MobileReconnectAckNodeFieldsSchema.parse({ home_node: 'srvjp' })).toEqual({ home_node: 'srvjp' });
  });

  it('unknown keys are dropped rather than rejected', () => {
    // The ack is emitted as a literal with several spreads; a schema that threw
    // on a sibling field would turn an unrelated addition into a reconnect
    // failure for every phone.
    expect(MobileReconnectAckNodeFieldsSchema.parse({ node: 'srvny', pc_online: true }))
      .toEqual({ node: 'srvny' });
  });
});
