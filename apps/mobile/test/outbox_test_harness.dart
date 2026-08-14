// Card L8 (2026-08-02) — the fixtures + fake [OutboxDrainHost] for outbox_test.dart.
//
// 🔴 MOVED VERBATIM, and a `part` rather than a shared support library ON PURPOSE:
// every symbol here is library-private (`_FakeHost`, `_Sent`, `_outbox`,
// `_enqueueOne`) and a `part` keeps it that way, so the split renamed NOTHING and
// touched not one of the ~90 call sites in the suite. Making them public to share
// them across files would have been a bigger diff than the split it was meant to
// enable, and "move only, change nothing" is the only way a structural move stays reviewable.
//
// The cut is the 800/1200-line file-size lint (verify/lint/file-size.mjs); the
// BOUNDARY is "test doubles and constants" vs "assertions", which is a real seam — this file is
// read when you are wiring a new case, the other one when you are reading what the
// queue promises.

part of 'outbox_test.dart';

// ── Two computers, two channels. The whole point of the ruling is that ONE
// computer has a DIFFERENT pc_id per channel, so these are named to keep that
// straight: machine A is reachable as `pc-A-lan` and `pc-A-cloud`.
const String kMachineA = 'machine-uid-AAAA';
const String kMachineB = 'machine-uid-BBBB';
const String kPcALan = 'pc-A-lan';
const String kPcACloud = 'pc-A-cloud';
const String kPcBLan = 'pc-B-lan';
const String kPairALan = 'standalone|instance:inst-A-lan';
const String kPairACloud = 'saas|instance:inst-A-cloud';
const String kPairBLan = 'standalone|instance:inst-B-lan';

const LiveConnection kOnALan = LiveConnection(
  machineUid: kMachineA,
  pairingIdentity: kPairALan,
  pcId: kPcALan, channel: ServerChannel.lan,
);
const LiveConnection kOnACloud = LiveConnection(
  machineUid: kMachineA,
  pairingIdentity: kPairACloud,
  pcId: kPcACloud, channel: ServerChannel.cloudRelay,
);
const LiveConnection kOnBLan = LiveConnection(
  machineUid: kMachineB,
  pairingIdentity: kPairBLan,
  pcId: kPcBLan, channel: ServerChannel.lan,
);

class _Sent {
  _Sent(this.item, this.targetPcId, this.imageBytes);
  final OutboxItem item;
  final String targetPcId;

  /// 🔴 G-6 — what the QUEUE handed over for this send. The whole point of the
  /// bytes being pushed rather than fetched is that this is assertable: an
  /// image item that arrives here with null bytes is a frame that cannot be
  /// built, and `INJECT_FRAME_INVALID` is terminal, so the picture is lost.
  final Uint8List? imageBytes;
}

class _FakeHost implements OutboxDrainHost {
  _FakeHost(this._connection);

  LiveConnection _connection;
  set connectionIs(LiveConnection c) => _connection = c;

  bool linkOk = true;
  bool sendOk = true;
  int reseeds = 0;
  int notifies = 0;
  final List<_Sent> sends = <_Sent>[];

  /// Records the order of the two pre-drain steps so §3.5's ordering (seed
  /// BEFORE probe BEFORE send) is assertable rather than assumed.
  final List<String> trace = <String>[];

  /// 🔴 L8 — one entry per send, in order: "was this frame sent as live or as catch-up".
  final List<InjectOrigin> origins = <InjectOrigin>[];

  @override
  LiveConnection get liveConnection => _connection;

  @override
  Future<bool> ensureLink() async {
    trace.add('probe');
    return linkOk;
  }

  @override
  Future<void> reseedDestination() async {
    reseeds++;
    trace.add('reseed');
  }

  @override
  Future<bool> send(
    OutboxItem item,
    String targetPcId, {
    required InjectOrigin origin,
    Uint8List? imageBytes,
  }) async {
    trace.add('send');
    origins.add(origin);
    sends.add(_Sent(item, targetPcId, imageBytes));
    return sendOk;
  }

  @override
  void onOutboxChanged() => notifies++;
}

DeliveryOutbox _outbox(
  _FakeHost host, {
  OutboxStore? store,
  OutboxBlobStore? blobs,
  int capacity = kOutboxCapacity,
  Duration inflight = kOutboxInflightTimeout,
}) => DeliveryOutbox(
  store: store ?? InMemoryOutboxStore(),
  blobs: blobs ?? InMemoryOutboxBlobStore(),
  host: host,
  capacity: capacity,
  inflightTimeout: inflight,
);

final DateTime kSpokenAt = DateTime.utc(2026, 7, 28, 9, 15);

Future<OutboxItem?> _enqueueOne(
  DeliveryOutbox box, {
  String requestId = 'm0-1',
  DateTime? createdAt,
  // These harnesses model a single-row send (the row was built by this
  // delivery), so the frame names it. A buffered multi-row send is the null
  // case and is covered at the FRAME in outbox_stations_test.dart.
  String? wireEntryId,
}) => box.enqueueText(
  requestId: requestId,
  entryId: 'loc_$requestId',
  wireEntryId: wireEntryId ?? 'loc_$requestId',
  source: 'manual',
  text: 'hello pc',
  mode: 'realtime',
  createdAt: createdAt ?? kSpokenAt,
);

