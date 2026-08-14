// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §6 (exactly two protocols; adding a
//     third means a new file here + a new LlmProtocol union member)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (exhaustive switch — an unhandled
//     protocol is a compile error, never a silent no-op)
//
// The one dispatcher: cfg.protocol → streamer. The `never` exhaustiveness guard
// makes TypeScript reject any new LlmProtocol that is not wired here.

import type { LlmProtocol } from '@flowmic/protocol';
import type { LlmStreamer } from './types';
import { streamOpenAiCompatible } from './openai-compatible';
import { streamAnthropic } from './anthropic';

export * from './types';
export { streamOpenAiCompatible } from './openai-compatible';
export { streamAnthropic } from './anthropic';

export function streamerFor(protocol: LlmProtocol): LlmStreamer {
  switch (protocol) {
    case 'openai-compatible':
      return streamOpenAiCompatible;
    case 'anthropic':
      return streamAnthropic;
    default: {
      const _exhaustive: never = protocol;
      throw new Error(`compose/llm: unknown protocol ${String(_exhaustive)}`);
    }
  }
}
