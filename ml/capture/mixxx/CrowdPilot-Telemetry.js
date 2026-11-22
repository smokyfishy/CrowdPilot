// CrowdPilot telemetry mapping for Mixxx (2.4.x / 2.5.x controller scripting API).
//
// Observes EFFECTIVE engine state (whatever moved it: hardware controller, keyboard,
// mouse, sync) via engine.makeConnection, and streams each change as a compact SysEx
// message to the virtual MIDI port this mapping is bound to. A Python receiver
// (ml/capture/receiver.py) timestamps and logs it. The script never writes files
// (Mixxx's JS engine has no file I/O) and never changes any control.
//
// Message: F0 7D 43 50 <ver=1> <seq_hi> <seq_lo> <ctrl_id> <5 bytes float32, 7-bit packed> F7
//   0x7D = non-commercial/educational manufacturer id (MIDI spec).

var CrowdPilotTelemetry = {};

CrowdPilotTelemetry.DECKS = ["[Channel1]", "[Channel2]", "[Channel3]", "[Channel4]"];
// Per-deck controls (documented Mixxx control names). Index = ctrl_id offset.
CrowdPilotTelemetry.DECK_KEYS = [
    "play", "volume", "pregain", "rate", "rate_dir", "rateRange", "playposition", "track_loaded",
    "duration", "bpm", "file_bpm", "sync_enabled", "keylock", "cue_indicator", "loop_enabled",
    "beatloop_size", "pfl", "orientation", "slip_enabled", "jog", "scratch2_enable", "reverse",
];
// EQ rack parameters (low/mid/high) and the quick-effect (filter) super knob per deck.
CrowdPilotTelemetry.DECK_EXTRA = [
    ["[EqualizerRack1_%D_Effect1]", "parameter1"],
    ["[EqualizerRack1_%D_Effect1]", "parameter2"],
    ["[EqualizerRack1_%D_Effect1]", "parameter3"],
    ["[EqualizerRack1_%D_Effect1]", "button_parameter1"],
    ["[EqualizerRack1_%D_Effect1]", "button_parameter2"],
    ["[EqualizerRack1_%D_Effect1]", "button_parameter3"],
    ["[QuickEffectRack1_%D]", "super1"],
    ["[QuickEffectRack1_%D]", "enabled"],
];
// Global controls. [Master] names are aliased in Mixxx 2.5 ([Main]); both are tried.
CrowdPilotTelemetry.GLOBAL = [
    ["[Master]", "crossfader"], ["[Master]", "gain"], ["[Master]", "balance"], ["[Recording]", "status"],
    ["[EffectRack1_EffectUnit1]", "mix"], ["[EffectRack1_EffectUnit1]", "super1"], ["[EffectRack1_EffectUnit1]", "enabled"],
    ["[EffectRack1_EffectUnit2]", "mix"], ["[EffectRack1_EffectUnit2]", "super1"], ["[EffectRack1_EffectUnit2]", "enabled"],
];
CrowdPilotTelemetry.HEARTBEAT_MS = 1000;
CrowdPilotTelemetry.POSITION_MS = 50; // playposition is sampled (it changes every audio callback)

CrowdPilotTelemetry.seq = 0;
CrowdPilotTelemetry.table = [];
CrowdPilotTelemetry.connections = [];
CrowdPilotTelemetry.lastPos = {};

CrowdPilotTelemetry.pack = function (id, value) {
    var buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value);
    var b = new Uint8Array(buf);
    // 32 bits → five 7-bit bytes (MSB first)
    var u = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    var s = CrowdPilotTelemetry.seq = (CrowdPilotTelemetry.seq + 1) & 0x3FFF;
    var msg = [0xF0, 0x7D, 0x43, 0x50, 0x01, (s >> 7) & 0x7F, s & 0x7F, id & 0x7F,
        (u >>> 28) & 0x0F, (u >>> 21) & 0x7F, (u >>> 14) & 0x7F, (u >>> 7) & 0x7F, u & 0x7F, 0xF7];
    midi.sendSysexMsg(msg, msg.length);
};

CrowdPilotTelemetry.watch = function (group, key) {
    var id = CrowdPilotTelemetry.table.length;
    if (id > 127) { return; }
    CrowdPilotTelemetry.table.push(group + "," + key);
    if (key === "playposition") { return; } // sampled by timer instead
    var conn = engine.makeConnection(group, key, function (value) { CrowdPilotTelemetry.pack(id, value); });
    if (conn) {
        CrowdPilotTelemetry.connections.push(conn);
        conn.trigger(); // emit the initial state
    }
};

CrowdPilotTelemetry.init = function (id, debugging) {
    var d, k, e;
    for (d = 0; d < CrowdPilotTelemetry.DECKS.length; d++) {
        for (k = 0; k < CrowdPilotTelemetry.DECK_KEYS.length; k++) { CrowdPilotTelemetry.watch(CrowdPilotTelemetry.DECKS[d], CrowdPilotTelemetry.DECK_KEYS[k]); }
        for (e = 0; e < CrowdPilotTelemetry.DECK_EXTRA.length; e++) {
            CrowdPilotTelemetry.watch(CrowdPilotTelemetry.DECK_EXTRA[e][0].replace("%D", CrowdPilotTelemetry.DECKS[d]), CrowdPilotTelemetry.DECK_EXTRA[e][1]);
        }
    }
    for (k = 0; k < CrowdPilotTelemetry.GLOBAL.length; k++) { CrowdPilotTelemetry.watch(CrowdPilotTelemetry.GLOBAL[k][0], CrowdPilotTelemetry.GLOBAL[k][1]); }
    // Control table announcement: id 127 carries the table length; the receiver ships the
    // same table (ml/capture/controls.py) and checks the length/version matches.
    CrowdPilotTelemetry.pack(127, CrowdPilotTelemetry.table.length);
    engine.beginTimer(CrowdPilotTelemetry.POSITION_MS, function () {
        for (var i = 0; i < CrowdPilotTelemetry.table.length; i++) {
            var parts = CrowdPilotTelemetry.table[i].split(",");
            if (parts[1] !== "playposition") { continue; }
            if (engine.getValue(parts[0], "play") < 0.5 && CrowdPilotTelemetry.lastPos[i] !== undefined) { continue; }
            var v = engine.getValue(parts[0], "playposition");
            if (v !== CrowdPilotTelemetry.lastPos[i]) { CrowdPilotTelemetry.lastPos[i] = v; CrowdPilotTelemetry.pack(i, v); }
        }
    });
    engine.beginTimer(CrowdPilotTelemetry.HEARTBEAT_MS, function () { CrowdPilotTelemetry.pack(126, 0); });
};

CrowdPilotTelemetry.shutdown = function () {
    for (var i = 0; i < CrowdPilotTelemetry.connections.length; i++) { CrowdPilotTelemetry.connections[i].disconnect(); }
    CrowdPilotTelemetry.pack(125, 0);
};
