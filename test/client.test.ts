import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoordinatorClient } from "../coordinator-client.ts";
import { resolveSettings } from "../patterns.ts";

const phases = [
	{ on: true, durationMs: 100 },
	{ on: false, durationMs: 100 },
];

test("closing a client cancels an in-flight preview connection", async () => {
	const directory = mkdtempSync(join(tmpdir(), "blinkenlights-client-test-"));
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = directory;
	try {
		const client = new CoordinatorClient("/missing/helper", "/project", () => {});
		const preview = client.preview(phases);
		const alert = client.alert(resolveSettings());
		client.stopPreview();
		client.acknowledge();
		client.close();
		await assert.rejects(preview);
		await assert.rejects(alert);
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		rmSync(directory, { recursive: true, force: true });
	}
});
