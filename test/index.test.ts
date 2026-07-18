import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { BlinkController, parseTimeoutSeconds } from "../index.ts";

class FakeChild extends EventEmitter {
  readonly stdin = {
    ends: 0,
    end: () => {
      this.stdin.ends += 1;
    },
  };
}

test("timeout defaults to five minutes", () => {
  assert.equal(parseTimeoutSeconds(undefined), 300);
});

test("timeout accepts positive whole seconds", () => {
  assert.equal(parseTimeoutSeconds("45"), 45);
  assert.equal(parseTimeoutSeconds(1), 1);
  assert.equal(parseTimeoutSeconds("604800"), 604_800);
});

test("timeout rejects invalid values", () => {
  for (const value of ["", "1.5", "0", "-1", "604801", "nope"]) {
    assert.throws(() => parseTimeoutSeconds(value));
  }
});

test("blinker starts once and stops through stdin", () => {
  const children: FakeChild[] = [];
  const controller = new BlinkController((timeoutSeconds) => {
    assert.equal(timeoutSeconds, 60);
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  controller.start(60);
  controller.start(60);
  assert.equal(children.length, 1);
  assert.equal(controller.isRunning, true);

  controller.stop();
  controller.stop();
  assert.equal(children[0]?.stdin.ends, 1);
  assert.equal(controller.isRunning, false);
});

test("a finished helper can be restarted", () => {
  const children: FakeChild[] = [];
  const controller = new BlinkController(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  controller.start(10);
  children[0]?.emit("exit", 0);
  assert.equal(controller.isRunning, false);

  controller.start(10);
  assert.equal(children.length, 2);
  assert.equal(controller.isRunning, true);
});
