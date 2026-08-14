// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §1 (room = 1 PC + 1 owner mobile +
//     N observer; room_uuid is the key)
//   docs/rebuild/05-DATA-MODEL.md §1 (pc_devices.room_uuid)
//   Ported mechanism from legacy room/store.ts (generic over socket type so the
//   unit tests need no socket.io).
//
// In-memory map room_uuid → { pcSocket, mobileSockets }. Live socket presence
// ONLY; persistent metadata lives in the repos.

export interface RoomSocketLike {
  readonly id: string;
  readonly connected?: boolean;
}

interface Room<S extends RoomSocketLike> {
  pcSocket: S | null;
  mobileSockets: Map<string, S>; // mobile_id → socket
  // WP-R4-4 (§4.1 source ②): the PC's latest focus process_name, mirrored from
  // the focus:state relay. Transient app-scenario signal — NEVER persisted, and
  // cleared the moment the PC that reported it leaves or is replaced (a stale
  // focus must never colour a later utterance's scenario prompt).
  focusProcess?: string;
  // 2026-07-29 (owner: "the focus doesn't show above the phone's transcription
  // screen, but leaving and reconnecting makes it show again" —
  // 手机转录界面上方不显示焦点，退出重连又能显示): the last
  // focus:state payload, kept so a mobile that arrives BETWEEN two foreground
  // changes can be told what the focus is NOW instead of staring at a blank
  // header until the user happens to alt-tab. `focus:state` is change-only by
  // design (§3.5 throttled mirror), which makes it invisible to every late
  // listener — the same "can only be pushed, cannot be asked" (只能被推、不能被问)
  // shape as the 0.2.5 connection rows
  // (0.2.x wrap-up §4-A / §8-2). Same lifetime rules as focusProcess: transient,
  // never persisted, dropped when the PC leaves or is replaced.
  lastFocus?: { window_title: string; process_name: string };
}

export interface RoomSnapshot {
  room_uuid: string;
  pc_online: boolean;
  mobile_ids: string[];
}

export class RoomStore<S extends RoomSocketLike = RoomSocketLike> {
  private readonly rooms = new Map<string, Room<S>>();

  private ensure(room_uuid: string): Room<S> {
    let r = this.rooms.get(room_uuid);
    if (!r) {
      r = { pcSocket: null, mobileSockets: new Map() };
      this.rooms.set(room_uuid, r);
    }
    return r;
  }

  joinPc(room_uuid: string, socket: S): { previous: S | null } {
    const r = this.ensure(room_uuid);
    const previous = r.pcSocket;
    r.pcSocket = socket;
    // A fresh PC session starts with NO known focus (room switch / PC replaced):
    // the old PC's focus is stale until this PC sends its own focus:state.
    r.focusProcess = undefined;
    r.lastFocus = undefined;
    return { previous };
  }

  leavePc(room_uuid: string, socket_id: string): boolean {
    const r = this.rooms.get(room_uuid);
    if (!r || !r.pcSocket || r.pcSocket.id !== socket_id) return false;
    r.pcSocket = null;
    // PC gone → its focus signal is no longer live; drop it before gc so a
    // reconnect into the same room never inherits a stale process_name.
    r.focusProcess = undefined;
    r.lastFocus = undefined;
    this.gc(room_uuid);
    return true;
  }

  /** Mirror the PC's latest focus process_name (from the focus:state relay).
   *  Transient — never persisted. A blank name clears the tracked focus. */
  setFocusProcess(room_uuid: string, process_name: string): void {
    const trimmed = process_name.trim();
    const r = this.ensure(room_uuid);
    r.focusProcess = trimmed.length > 0 ? trimmed : undefined;
  }

  /** The PC's latest tracked focus process_name for the room, or undefined
   *  (no PC focus seen, or the PC left). Fed into ComposeStartArgs.processName. */
  getFocusProcess(room_uuid: string): string | undefined {
    return this.rooms.get(room_uuid)?.focusProcess;
  }

  /** Keep the whole last focus:state payload so a LATE joiner can be told the
   *  current focus (this event is change-only, so it is otherwise invisible to
   *  anyone who was not already listening). */
  setLastFocus(room_uuid: string, focus: { window_title: string; process_name: string }): void {
    this.ensure(room_uuid).lastFocus = focus;
  }

  /** The focus the PC last reported, for replay to an arriving mobile.
   *  undefined when no PC focus has been seen (or the PC left). */
  getLastFocus(room_uuid: string): { window_title: string; process_name: string } | undefined {
    return this.rooms.get(room_uuid)?.lastFocus;
  }

  joinMobile(room_uuid: string, mobile_id: string, socket: S): { previous: S | null } {
    const r = this.ensure(room_uuid);
    const previous = r.mobileSockets.get(mobile_id) ?? null;
    r.mobileSockets.set(mobile_id, socket);
    return { previous };
  }

  leaveMobile(room_uuid: string, mobile_id: string, socket_id?: string): boolean {
    const r = this.rooms.get(room_uuid);
    if (!r) return false;
    const cur = r.mobileSockets.get(mobile_id);
    if (!cur) return false;
    if (socket_id !== undefined && cur.id !== socket_id) return false;
    r.mobileSockets.delete(mobile_id);
    this.gc(room_uuid);
    return true;
  }

  getPc(room_uuid: string): S | null {
    return this.rooms.get(room_uuid)?.pcSocket ?? null;
  }

  getMobiles(room_uuid: string): S[] {
    const r = this.rooms.get(room_uuid);
    return r ? [...r.mobileSockets.values()] : [];
  }

  getMobile(room_uuid: string, mobile_id: string): S | null {
    return this.rooms.get(room_uuid)?.mobileSockets.get(mobile_id) ?? null;
  }

  mobileCount(room_uuid: string): number {
    return this.rooms.get(room_uuid)?.mobileSockets.size ?? 0;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  snapshot(room_uuid: string): RoomSnapshot | null {
    const r = this.rooms.get(room_uuid);
    if (!r) return null;
    return { room_uuid, pc_online: r.pcSocket !== null, mobile_ids: [...r.mobileSockets.keys()] };
  }

  private gc(room_uuid: string): void {
    const r = this.rooms.get(room_uuid);
    if (r && r.pcSocket === null && r.mobileSockets.size === 0) this.rooms.delete(room_uuid);
  }
}
