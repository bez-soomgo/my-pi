import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreflightFailoverModel } from "./failover-model.js";

const tempDirs: string[] = [];

function makeAgentDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-failover-model-"));
	fs.mkdirSync(path.join(dir, "state"), { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolvePreflightFailoverModel", () => {
	it("keeps the declared model when its provider is not cooled down", () => {
		const agentDir = makeAgentDir();
		writeJson(path.join(agentDir, "copilot-failover.json"), {
			enabled: true,
			fallbacks: { "openai-codex/gpt-5.5": ["github-copilot/gpt-5.5"] },
		});
		writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });

		expect(resolvePreflightFailoverModel("openai-codex/gpt-5.5", { agentDir, now: 1000 })).toEqual({
			declaredModel: "openai-codex/gpt-5.5",
			effectiveModel: "openai-codex/gpt-5.5",
		});
	});

	it("uses the first available fallback when the declared provider is cooled down", () => {
		const agentDir = makeAgentDir();
		writeJson(path.join(agentDir, "copilot-failover.json"), {
			enabled: true,
			fallbacks: { "openai-codex/gpt-5.5": ["github-copilot/gpt-5.5"] },
		});
		writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), {
			cooldowns: { "openai-codex": 2000 },
		});

		expect(resolvePreflightFailoverModel("openai-codex/gpt-5.5", { agentDir, now: 1000 })).toEqual({
			declaredModel: "openai-codex/gpt-5.5",
			effectiveModel: "github-copilot/gpt-5.5",
			modelResolutionReason: "copilot-failover preflight: openai-codex is cooled down until 1970-01-01T00:00:02.000Z",
		});
	});

	it("skips cooled fallback providers", () => {
		const agentDir = makeAgentDir();
		writeJson(path.join(agentDir, "copilot-failover.json"), {
			enabled: true,
			fallbacks: {
				"openai-codex/gpt-5.5": ["github-copilot/gpt-5.5", "anthropic/claude-sonnet-4-6"],
			},
		});
		writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), {
			cooldowns: { "openai-codex": 2000, "github-copilot": 2000 },
		});

		expect(resolvePreflightFailoverModel("openai-codex/gpt-5.5", { agentDir, now: 1000 }).effectiveModel).toBe(
			"anthropic/claude-sonnet-4-6",
		);
	});

	describe("auth expiry", () => {
		it("routes to fallback when anthropic token is expired (pi auth.json)", () => {
			const agentDir = makeAgentDir();
			writeJson(path.join(agentDir, "copilot-failover.json"), {
				enabled: true,
				fallbacks: { "anthropic/claude-opus-4-8": ["github-copilot/claude-opus-4.8"] },
			});
			writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });
			writeJson(path.join(agentDir, "auth.json"), {
				anthropics: { access: "tok", expires: 900 }, // ms: 900000 in the past
				anthropic: { access: "tok", expires: 900 }, // epoch seconds — converts to 900000ms
			});

			const result = resolvePreflightFailoverModel("anthropic/claude-opus-4-8", {
				agentDir,
				now: 1_000_000,
				claudeCredPath: path.join(agentDir, "nonexistent-cred.json"),
			});
			expect(result.effectiveModel).toBe("github-copilot/claude-opus-4.8");
			expect(result.modelResolutionReason).toMatch(/auth token is expired/);
		});

		it("routes to fallback when anthropic token is expired (claude credentials.json)", () => {
			const agentDir = makeAgentDir();
			const claudeCredPath = path.join(agentDir, "claude-cred.json");
			writeJson(path.join(agentDir, "copilot-failover.json"), {
				enabled: true,
				fallbacks: { "anthropic/claude-sonnet-4-6": ["github-copilot/claude-sonnet-4.6"] },
			});
			writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });
			writeJson(claudeCredPath, { claudeAiOauth: { expiresAt: 500 } });

			const result = resolvePreflightFailoverModel("anthropic/claude-sonnet-4-6", {
				agentDir,
				now: 1_000_000,
				claudeCredPath,
			});
			expect(result.effectiveModel).toBe("github-copilot/claude-sonnet-4.6");
			expect(result.modelResolutionReason).toMatch(/auth token is expired/);
		});

		it("keeps declared model when token has not yet expired", () => {
			const agentDir = makeAgentDir();
			const claudeCredPath = path.join(agentDir, "claude-cred.json");
			writeJson(path.join(agentDir, "copilot-failover.json"), {
				enabled: true,
				fallbacks: { "anthropic/claude-sonnet-4-6": ["github-copilot/claude-sonnet-4.6"] },
			});
			writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });
			writeJson(claudeCredPath, { expiresAt: 10_000_000_000 });

			const result = resolvePreflightFailoverModel("anthropic/claude-sonnet-4-6", {
				agentDir,
				now: 1_000_000,
				claudeCredPath,
			});
			expect(result.effectiveModel).toBe("anthropic/claude-sonnet-4-6");
		});

		it("keeps declared model when no auth file is found", () => {
			const agentDir = makeAgentDir();
			writeJson(path.join(agentDir, "copilot-failover.json"), {
				enabled: true,
				fallbacks: { "anthropic/claude-opus-4-8": ["github-copilot/claude-opus-4.8"] },
			});
			writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });

			const result = resolvePreflightFailoverModel("anthropic/claude-opus-4-8", {
				agentDir,
				now: 1_000_000,
				claudeCredPath: path.join(agentDir, "nonexistent.json"),
			});
			expect(result.effectiveModel).toBe("anthropic/claude-opus-4-8");
		});

		it("skips expired fallback and keeps declared model when all candidates are expired", () => {
			const agentDir = makeAgentDir();
			const claudeCredPath = path.join(agentDir, "claude-cred.json");
			writeJson(path.join(agentDir, "copilot-failover.json"), {
				enabled: true,
				// only fallback is also anthropic — both expired
				fallbacks: { "anthropic/claude-opus-4-8": ["anthropic/claude-sonnet-4-6"] },
			});
			writeJson(path.join(agentDir, "state", "copilot-failover-state.json"), { cooldowns: {} });
			writeJson(claudeCredPath, { expiresAt: 500 });

			const result = resolvePreflightFailoverModel("anthropic/claude-opus-4-8", {
				agentDir,
				now: 1_000_000,
				claudeCredPath,
			});
			expect(result.effectiveModel).toBe("anthropic/claude-opus-4-8");
		});
	});
});
