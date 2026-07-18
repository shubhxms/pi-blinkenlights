import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDndValue,
  parsePattern,
  parsePriority,
  parseTimeoutSeconds,
  renderWaveform,
  resolveSettings,
} from "../index.ts";


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

test("priority uses positive integers where lower wins", () => {
  assert.equal(parsePriority("1"), 1);
  assert.equal(parsePriority(15), 15);
  for (const value of ["", "0", "-1", "1.5", "nope"]) {
    assert.throws(() => parsePriority(value));
  }
});

test("DND values support off, indefinite, and bounded durations", () => {
  assert.equal(parseDndValue("off", 1_000), undefined);
  assert.equal(parseDndValue("forever", 1_000), null);
  assert.equal(parseDndValue("30m", 1_000), 1_801_000);
  assert.equal(parseDndValue("2h", 1_000), 7_201_000);
  assert.throws(() => parseDndValue("later", 1_000));
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
      priority: 10,
      enabled: true,
      patterns: { Shared: "on 100ms, off 100ms", Global: "on 200ms, off 200ms" },
    },
    {
      activePattern: "Project",
      timeoutSeconds: 30,
      priority: 5,
      enabled: false,
      patterns: { Shared: "on 300ms, off 300ms", Project: "on 80ms, off 500ms" },
    },
  );

  assert.equal(settings.activePattern, "Project");
  assert.equal(settings.timeoutSeconds, 30);
  assert.equal(settings.priority, 5);
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.patterns.Shared, parsePattern("on 300ms, off 300ms"));
  assert.deepEqual(settings.patterns.Global, parsePattern("on 200ms, off 200ms"));
  assert.deepEqual(settings.patterns.Project, parsePattern("on 80ms, off 500ms"));
});

test("waveform previews phase proportions", () => {
  const waveform = renderWaveform(parsePattern("on 500ms, off 500ms"), 10);
  assert.equal(waveform, "█████·····");
});
