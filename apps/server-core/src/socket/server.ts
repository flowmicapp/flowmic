// SPEC-REF:
//   docs/rebuild/13-LESSONS-LEARNED.md §2 N5 (heartbeat threshold by the slowest
//     client: socket.io defaults ping 10s / timeout 20s), N4 (cloud polling→ws)
//   docs/rebuild/04-PROTOCOL-SPEC.md §1/§2 (transport, handshake)
//   Ported io-factory mechanism from legacy socket/server.ts.
//
// socket.io server factory over a node:http server. Just the io + auth
// middleware + a close(). Handler registration happens at the call site so this
// stays domain-free.

import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';

// N5: pingTimeout relaxed to 20s (socket.io default) — a single-Dart-loop
// mobile can stall past a 5s window under recording bursts.
export const PING_INTERVAL_MS = 10_000;
export const PING_TIMEOUT_MS = 20_000;

// R6 T-4 (image transit path): socket.io's DEFAULT maxHttpBufferSize is 1 MB, and an
// over-size frame is not a validation error — the engine CLOSES the connection
// before any handler or zod schema ever sees the payload. InjectRequestSchema
// admits an `image_b64` up to 5_500_000 chars, so with the default the protocol
// would be advertising a ceiling the transport silently shreds: the exact
// "no silent failure" red-line shape (the phone would see a link drop, not a reason).
// The engine ceiling is therefore lifted ABOVE the schema ceiling, so the zod
// boundary is the single place a payload is judged and the rejection is a
// readable error rather than a dropped socket.
export const MAX_HTTP_BUFFER_BYTES = 8_000_000;

export interface CreateSocketServerOpts {
  httpServer: HttpServer;
  authMiddleware: (socket: unknown, next: (err?: Error) => void) => void;
  cors?: { origin: string | string[] };
}

export interface SocketServerHandle {
  io: SocketIOServer;
  close(): Promise<void>;
}

export function createSocketServer(opts: CreateSocketServerOpts): SocketServerHandle {
  const io = new SocketIOServer(opts.httpServer, {
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_HTTP_BUFFER_BYTES,
    // LAN standalone: polling→websocket upgrade retained (N4 cloud lesson).
    transports: ['polling', 'websocket'],
    cors: { origin: opts.cors?.origin ?? '*' },
  });
  io.use(opts.authMiddleware);
  return {
    io,
    async close(): Promise<void> {
      io.disconnectSockets(true);
      const engine = (io as unknown as { engine?: { close?: () => void } }).engine;
      engine?.close?.();
    },
  };
}

export type { Socket };
