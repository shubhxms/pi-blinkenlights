export type DndValue = number | null | undefined;

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseDndValue(input: string, now = Date.now()): DndValue {
	const value = input.trim().toLowerCase();
	if (value === "off" || value === "none") return undefined;
	if (value === "forever" || value === "indefinite" || value === "on")
		return null;

	const match = /^(\d+)(s|m|h|d)$/.exec(value);
	if (!match)
		throw new Error(
			"DND duration must be off, forever, or a value like 30m or 2h",
		);
	const amount = Number(match[1]);
	const durationMs = amount * (UNIT_MS[match[2] ?? ""] ?? 0);
	if (
		!Number.isSafeInteger(durationMs) ||
		durationMs < 1 ||
		durationMs > 31_536_000_000
	) {
		throw new Error("DND duration must be between 1 second and 365 days");
	}
	return now + durationMs;
}

export function isDndActive(value: DndValue, now = Date.now()): boolean {
	return value === null || (typeof value === "number" && value > now);
}

export function describeDnd(value: DndValue, now = Date.now()): string {
	if (value === null) return "indefinite";
	if (typeof value !== "number" || value <= now) return "off";
	const seconds = Math.ceil((value - now) / 1_000);
	if (seconds % 3_600 === 0) return `${seconds / 3_600}h remaining`;
	if (seconds % 60 === 0) return `${seconds / 60}m remaining`;
	return `${seconds}s remaining`;
}
