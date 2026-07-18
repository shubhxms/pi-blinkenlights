function validatePhases(phases) {
	if (!Array.isArray(phases) || phases.length < 2 || phases.length > 64) {
		throw new Error("phases must contain 2-64 entries");
	}
	for (let index = 0; index < phases.length; index++) {
		const phase = phases[index];
		if (
			!phase ||
			typeof phase.on !== "boolean" ||
			!Number.isInteger(phase.durationMs) ||
			phase.durationMs < 20 ||
			phase.durationMs > 60_000
		) {
			throw new Error(`invalid phase ${index + 1}`);
		}
		if (index > 0 && phase.on === phases[index - 1].on) {
			throw new Error("phases must alternate on/off");
		}
	}
	if (phases[0].on === phases.at(-1).on) {
		throw new Error("first and last phases must alternate");
	}
	return phases.map(({ on, durationMs }) => ({ on, durationMs }));
}

export class Scheduler {
	#now;
	#sequence = 0;
	#alerts = new Map();
	#previews = new Map();
	#globalDnd;
	#projectDnd = new Map();

	constructor(now = Date.now) {
		this.#now = now;
	}

	upsertAlert(clientId, request) {
		if (!Number.isInteger(request.priority) || request.priority < 1) {
			throw new Error("priority must be a positive integer");
		}
		if (
			!Number.isInteger(request.timeoutMs) ||
			request.timeoutMs < 1 ||
			request.timeoutMs > 604_800_000
		) {
			throw new Error("timeoutMs must be between 1 and 604800000");
		}
		if (typeof request.projectKey !== "string" || !request.projectKey) {
			throw new Error("projectKey must be a non-empty string");
		}
		if (this.#isDndActive(request.projectKey)) {
			this.#alerts.delete(clientId);
			return this.refresh();
		}
		this.#alerts.set(clientId, {
			clientId,
			priority: request.priority,
			timeoutMs: request.timeoutMs,
			projectKey: request.projectKey,
			phases: validatePhases(request.phases),
			createdAt: this.#now(),
			order: ++this.#sequence,
		});
		return this.refresh();
	}

	acknowledge(clientId) {
		this.#alerts.delete(clientId);
		return this.refresh();
	}

	setPreview(clientId, phases) {
		this.#previews.set(clientId, {
			clientId,
			phases: validatePhases(phases),
			revision: ++this.#sequence,
		});
		return this.refresh();
	}

	clearPreview(clientId) {
		this.#previews.delete(clientId);
		return this.refresh();
	}

	removeClient(clientId) {
		this.#alerts.delete(clientId);
		this.#previews.delete(clientId);
		return this.refresh();
	}

	setDnd(scope, projectKey, until) {
		if (until !== null && (!Number.isInteger(until) || until < 1)) {
			throw new Error("DND expiry must be null or a positive timestamp");
		}
		if (scope === "global") {
			this.#globalDnd = until;
			this.#alerts.clear();
		} else if (scope === "project" && typeof projectKey === "string" && projectKey) {
			this.#projectDnd.set(projectKey, until);
			for (const alert of this.#alerts.values()) {
				if (alert.projectKey === projectKey) this.#alerts.delete(alert.clientId);
			}
		} else {
			throw new Error("invalid DND scope or project key");
		}
		return this.refresh();
	}

	clearDnd(scope, projectKey) {
		if (scope === "global") this.#globalDnd = undefined;
		else if (scope === "project" && typeof projectKey === "string" && projectKey) {
			this.#projectDnd.delete(projectKey);
		} else throw new Error("invalid DND scope or project key");
		return this.refresh();
	}

	#isDndActive(projectKey) {
		const now = this.#now();
		if (typeof this.#globalDnd === "number" && this.#globalDnd <= now) {
			this.#globalDnd = undefined;
		}
		const projectValue = this.#projectDnd.get(projectKey);
		if (typeof projectValue === "number" && projectValue <= now) {
			this.#projectDnd.delete(projectKey);
		}
		return (
			this.#globalDnd === null ||
			typeof this.#globalDnd === "number" ||
			projectValue === null ||
			(typeof projectValue === "number" && projectValue > now)
		);
	}

	refresh() {
		const preview = [...this.#previews.values()].sort(
			(left, right) => right.revision - left.revision,
		)[0];
		if (preview) {
			return {
				kind: "preview",
				clientId: preview.clientId,
				revision: preview.revision,
				phases: preview.phases,
			};
		}

		const now = this.#now();
		const eligible = [];
		for (const alert of this.#alerts.values()) {
			const remainingMs = alert.timeoutMs - (now - alert.createdAt);
			const cycleMs = alert.phases.reduce(
				(total, phase) => total + phase.durationMs,
				0,
			);
			if (remainingMs < cycleMs) {
				this.#alerts.delete(alert.clientId);
				continue;
			}
			eligible.push({ alert, remainingMs });
		}

		eligible.sort(
			(left, right) =>
				left.alert.priority - right.alert.priority ||
				left.alert.order - right.alert.order,
		);
		const selected = eligible[0];
		if (!selected) return undefined;
		return {
			kind: "alert",
			clientId: selected.alert.clientId,
			revision: selected.alert.order,
			phases: selected.alert.phases,
			remainingMs: selected.remainingMs,
		};
	}
}
