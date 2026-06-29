import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ModelResolution = {
	declaredModel?: string;
	effectiveModel?: string;
	modelResolutionReason?: string;
};

type ModelRef = {
	provider: string;
	id: string;
};

type ResolveOptions = {
	now?: number;
	agentDir?: string;
	configPath?: string;
	statePath?: string;
	/** Override path to ~/.claude/.credentials.json for testing. */
	claudeCredPath?: string;
};

type CopilotFailoverConfig = {
	enabled?: boolean;
	fallbacks?: Record<string, string[]>;
};

type CopilotFailoverState = {
	cooldowns?: Record<string, number>;
	// Legacy provider-failover state used this name; supporting it keeps preflight robust.
	exhaustedUntilByProvider?: Record<string, number>;
};

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function parseModelRef(model: string | undefined): ModelRef | undefined {
	const value = model?.trim();
	if (!value) return undefined;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return {
		provider: value.slice(0, slash),
		id: value.slice(slash + 1),
	};
}

function getProviderCooldownUntil(state: CopilotFailoverState | undefined, provider: string): number | undefined {
	const direct = state?.cooldowns?.[provider];
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	const legacy = state?.exhaustedUntilByProvider?.[provider];
	if (typeof legacy === "number" && Number.isFinite(legacy)) return legacy;
	return undefined;
}

function isProviderCooled(state: CopilotFailoverState | undefined, provider: string, now: number): boolean {
	const until = getProviderCooldownUntil(state, provider);
	return typeof until === "number" && until > now;
}

function formatCooldownReason(provider: string, until: number | undefined): string {
	if (typeof until !== "number" || !Number.isFinite(until)) return `${provider} is cooled down`;
	return `${provider} is cooled down until ${new Date(until).toISOString()}`;
}

const AUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function toMs(value: number): number {
	return value > 1_000_000_000_000 ? value : value * 1000;
}

function readAnthropicExpiresAt(agentDir: string, claudeCredPath?: string): number | undefined {
	const piAuth = readJsonFile<Record<string, any>>(path.join(agentDir, "auth.json"));
	const piExpires = piAuth?.anthropic?.expires ?? piAuth?.anthropic?.expiresAt;
	if (typeof piExpires === "number" && Number.isFinite(piExpires)) {
		return toMs(piExpires);
	}
	const credPath = claudeCredPath ?? path.join(os.homedir(), ".claude", ".credentials.json");
	const cred = readJsonFile<any>(credPath);
	const nested = isRecord(cred?.claudeAiOauth) ? cred.claudeAiOauth : cred;
	const credExpires = nested?.expiresAt ?? nested?.expires;
	if (typeof credExpires === "number" && Number.isFinite(credExpires)) {
		return toMs(credExpires);
	}
	return undefined;
}

function isProviderAuthExpired(
	provider: string,
	agentDir: string,
	now: number,
	claudeCredPath?: string,
): boolean {
	if (provider !== "anthropic") return false;
	const expiresAt = readAnthropicExpiresAt(agentDir, claudeCredPath);
	if (expiresAt === undefined) return false;
	return expiresAt < now + AUTH_EXPIRY_BUFFER_MS;
}

function getFallbacks(config: CopilotFailoverConfig | undefined, declaredModel: string): string[] {
	const fallbacks = config?.fallbacks;
	if (!isRecord(fallbacks)) return [];
	const exact = fallbacks[declaredModel];
	return Array.isArray(exact)
		? exact.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: [];
}

export function resolvePreflightFailoverModel(
	declaredModel: string | undefined,
	options: ResolveOptions = {},
): ModelResolution {
	const declared = declaredModel?.trim() || undefined;
	if (!declared) return {};

	const agentDir = options.agentDir ?? DEFAULT_AGENT_DIR;
	const configPath = options.configPath ?? path.join(agentDir, "copilot-failover.json");
	const statePath = options.statePath ?? path.join(agentDir, "state", "copilot-failover-state.json");
	const now = options.now ?? Date.now();

	const config = readJsonFile<CopilotFailoverConfig>(configPath);
	if (config?.enabled === false) return { declaredModel: declared, effectiveModel: declared };

	const source = parseModelRef(declared);
	if (!source) return { declaredModel: declared, effectiveModel: declared };

	const state = readJsonFile<CopilotFailoverState>(statePath);
	const cooled = isProviderCooled(state, source.provider, now);
	const authExpired = isProviderAuthExpired(source.provider, agentDir, now, options.claudeCredPath);

	if (!cooled && !authExpired) {
		return { declaredModel: declared, effectiveModel: declared };
	}

	const reason = authExpired
		? `${source.provider} auth token is expired or expiring soon`
		: formatCooldownReason(source.provider, getProviderCooldownUntil(state, source.provider));

	for (const candidate of getFallbacks(config, declared)) {
		const target = parseModelRef(candidate);
		if (!target) continue;
		if (isProviderCooled(state, target.provider, now)) continue;
		if (isProviderAuthExpired(target.provider, agentDir, now, options.claudeCredPath)) continue;
		return {
			declaredModel: declared,
			effectiveModel: candidate,
			modelResolutionReason: `copilot-failover preflight: ${reason}`,
		};
	}

	return { declaredModel: declared, effectiveModel: declared };
}
