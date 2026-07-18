import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  BlinkController,
  parsePattern,
  parseTimeoutSeconds,
  resolveSettings,
} from "../index.ts";

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

test("pattern parses explicit on and off phases", () => {
  assert.deepEqual(parsePattern("on 120ms, off 80ms, ON 120ms, off 700ms"), [
    { on: true, durationMs: 120 },
    { on: false, durationMs: 80 },
    { on: true, durationMs: 120 },
    { on: false, durationMs: 700 },
  ]);
});

test("pattern rejects ambiguous or wasteful phases", () => {
  for (const value of [
    "on 100ms",
    "on 100ms, on 200ms, off 100ms",
    "on 100ms, off 100ms, on 100ms",
    "on 10ms, off 100ms",
    "on 100ms, off 60001ms",
    "blink 100ms, off 100ms",
  ]) {
    assert.throws(() => parsePattern(value));
  }
});

test("project settings override global settings and merge libraries", () => {
  const settings = resolveSettings(
    {
      activePattern: "Shared",
      timeoutSeconds: 60,
      patterns: { Shared: "on 100ms, off 100ms", Global: "on 200ms, off 200ms" },
    },
    {
      activePattern: "Project",
      timeoutSeconds: 30,
      patterns: { Shared: "on 300ms, off 300ms", Project: "on 80ms, off 500ms" },
    },
  );

  assert.equal(settings.activePattern, "Project");
  assert.equal(settings.timeoutSeconds, 30);
  assert.deepEqual(settings.patterns.Shared, parsePattern("on 300ms, off 300ms"));
  assert.deepEqual(settings.patterns.Global, parsePattern("on 200ms, off 200ms"));
  assert.deepEqual(settings.patterns.Project, parsePattern("on 80ms, off 500ms"));
});

test("blinker passes its selected phase sequence to one helper", () => {
  const children: FakeChild[] = [];
  const pattern = parsePattern("on 120ms, off 700ms");
  const controller = new BlinkController((timeoutSeconds, phases) => {
    assert.equal(timeoutSeconds, 60);
    assert.deepEqual(phases, pattern);
    const child = new FakeChild();
    children.push(child);
    return child;
  });

  controller.start(60, pattern);
  controller.start(60, pattern);
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
  const pattern = parsePattern("on 100ms, off 100ms");

  controller.start(10, pattern);
  children[0]?.emit("exit", 0);
  assert.equal(controller.isRunning, false);

  controller.start(10, pattern);
  assert.equal(children.length, 2);
  assert.equal(controller.isRunning, true);
});
