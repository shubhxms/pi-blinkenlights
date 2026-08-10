import assert from "node:assert/strict";
import test from "node:test";

import {
	matchesTerminalApplication,
	shouldSuppressForFocus,
} from "../terminal-focus.ts";

test("matches Ghostty frontmost application", () => {
	assert.equal(
		matchesTerminalApplication(
			"ghostty",
			'"LSDisplayName"="Ghostty"\n"CFBundleIdentifier"="com.mitchellh.ghostty"',
		),
		true,
	);
	assert.equal(
		matchesTerminalApplication(
			"ghostty",
			'"LSDisplayName"="Safari"\n"CFBundleIdentifier"="com.apple.Safari"',
		),
		false,
	);
});

test("matches iTerm and Terminal bundle identifiers", () => {
	assert.equal(
		matchesTerminalApplication(
			"iTerm.app",
			'"CFBundleIdentifier"="com.googlecode.iterm2"',
		),
		true,
	);
	assert.equal(
		matchesTerminalApplication(
			"Apple_Terminal",
			'"CFBundleIdentifier"="com.apple.Terminal"',
		),
		true,
	);
});

test("returns undefined for an unknown terminal", () => {
	assert.equal(
		matchesTerminalApplication(
			"custom-term",
			'"CFBundleIdentifier"="dev.example.CustomTerm"',
		),
		undefined,
	);
});

test("frontmost app corrects stale terminal focus", () => {
	assert.equal(shouldSuppressForFocus(false, true), false);
	assert.equal(shouldSuppressForFocus(true, false), false);
	assert.equal(shouldSuppressForFocus(true, true), true);
	assert.equal(shouldSuppressForFocus(true, undefined), true);
});
