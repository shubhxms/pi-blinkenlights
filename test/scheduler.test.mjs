import assert from "node:assert/strict";
import test from "node:test";

import { Scheduler } from "../scheduler.mjs";

const phases = [
	{ on: true, durationMs: 500 },
	{ on: false, durationMs: 500 },
];

function alert(priority = 10, timeoutMs = 300_000, projectKey = "/project-a") {
	return { priority, timeoutMs, projectKey, phases };
}

test("lower positive priority wins and equal priority is FIFO", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);

	assert.equal(scheduler.upsertAlert("first", alert()).clientId, "first");
	now = 100;
	assert.equal(scheduler.upsertAlert("second", alert()).clientId, "first");
	now = 200;
	assert.equal(scheduler.upsertAlert("urgent", alert(1)).clientId, "urgent");
	assert.equal(scheduler.acknowledge("urgent").clientId, "first");
});

test("scheduler enforces native helper timeout limits", () => {
	const scheduler = new Scheduler(() => 0);
	assert.throws(() => scheduler.upsertAlert("client", alert(10, 604_800_001)));
});

test("remaining playback decays linearly with total wall time", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);

	scheduler.upsertAlert("normal", alert(10));
	now = 20_000;
	scheduler.upsertAlert("urgent", alert(1));
	now = 80_000;
	const resumed = scheduler.acknowledge("urgent");

	assert.equal(resumed.kind, "alert");
	assert.equal(resumed.clientId, "normal");
	assert.equal(resumed.remainingMs, 220_000);
});

test("an alert is discarded when less than one cycle remains", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);
	scheduler.upsertAlert("client", alert(10, 300_000));

	now = 298_000;
	assert.equal(scheduler.refresh().remainingMs, 2_000);
	now = 299_500;
	assert.equal(scheduler.refresh(), undefined);
});

test("global DND discards existing and newly arriving alerts", () => {
	const scheduler = new Scheduler(() => 0);
	scheduler.upsertAlert("existing", alert());
	assert.equal(scheduler.setDnd("global", undefined, null), undefined);
	assert.equal(scheduler.upsertAlert("blocked", alert()), undefined);
	assert.equal(scheduler.clearDnd("global"), undefined);
	assert.equal(scheduler.upsertAlert("allowed", alert()).clientId, "allowed");
});

test("project DND only discards matching project alerts", () => {
	const scheduler = new Scheduler(() => 0);
	scheduler.setDnd("project", "/project-a", null);
	assert.equal(scheduler.upsertAlert("blocked", alert()), undefined);
	assert.equal(
		scheduler.upsertAlert("other", alert(10, 300_000, "/project-b")).clientId,
		"other",
	);
});

test("timed DND expires", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);
	scheduler.setDnd("global", undefined, 1_000);
	assert.equal(scheduler.upsertAlert("blocked", alert()), undefined);
	now = 1_001;
	assert.equal(scheduler.upsertAlert("allowed", alert()).clientId, "allowed");
});

test("latest preview temporarily wins and previous output is restored", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);
	scheduler.upsertAlert("alert", alert());

	now = 1;
	assert.deepEqual(scheduler.setPreview("preview-a", phases), {
		kind: "preview",
		clientId: "preview-a",
		revision: 2,
		phases,
	});
	now = 2;
	assert.equal(scheduler.setPreview("preview-b", phases).clientId, "preview-b");
	assert.equal(scheduler.clearPreview("preview-b").clientId, "preview-a");
	assert.equal(scheduler.clearPreview("preview-a").clientId, "alert");
});

test("disconnect removes only that client's alert and preview", () => {
	let now = 0;
	const scheduler = new Scheduler(() => now);
	scheduler.upsertAlert("one", alert());
	now = 1;
	scheduler.upsertAlert("two", alert());
	scheduler.setPreview("one", phases);

	assert.equal(scheduler.removeClient("one").clientId, "two");
});
