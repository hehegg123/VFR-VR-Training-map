import assert from "node:assert/strict";
import test from "node:test";

class FakeBroadcastChannel {
  static channels = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    const peers = FakeBroadcastChannel.channels.get(name) ?? [];
    peers.push(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer !== this) {
        peer.onmessage?.({ data });
      }
    }
  }

  close() {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? [];
    FakeBroadcastChannel.channels.set(this.name, peers.filter((peer) => peer !== this));
  }
}

globalThis.BroadcastChannel = FakeBroadcastChannel;
const { BroadcastLinkSession } = await import("../../shared/linkSession.js");

test("instruction commands are delivered only to linked peers", () => {
  const sender = new BroadcastLinkSession({ appId: "2d-test" });
  const receiver = new BroadcastLinkSession({ appId: "vr-test" });
  const received = [];

  sender.connect("instruction-test");
  receiver.connect("instruction-test", { onInstruction: (instruction) => received.push(instruction) });
  sender.publishInstruction({ action: "load", sectionId: "daytona", taskSetId: "daytona-orientation" });
  sender.publishInstruction({ action: "reset", sectionId: "daytona", taskSetId: "daytona-orientation" });
  sender.publishInstruction({ action: "clear", sectionId: "daytona", taskSetId: null });

  assert.deepEqual(received, [
    { action: "load", sectionId: "daytona", taskSetId: "daytona-orientation" },
    { action: "reset", sectionId: "daytona", taskSetId: "daytona-orientation" },
    { action: "clear", sectionId: "daytona", taskSetId: null },
  ]);
  sender.disconnect();
  receiver.disconnect();
});
