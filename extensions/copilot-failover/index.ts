/**
 * copilot-failover — 모델 보존형(model-preserving) 자동 failover
 *
 * pi-multi-account (https://github.com/Sarrius/pi-multi-account) 의 동작을 참고하되,
 * "패밀리 로테이션"이 아니라 **현재 모델을 같은 모델의 다른 경로로 넘기는** 방식으로 동작한다.
 * github-copilot 이 Claude(claude-opus-4.8 등)와 GPT(gpt-5.5)를 모두 서빙하므로,
 * 각 1차 모델의 백업으로 copilot 의 동일 모델을 지정해 둔다.
 *
 *   anthropic/claude-opus-4-8   →  github-copilot/claude-opus-4.8
 *   anthropic/claude-sonnet-4-6 →  github-copilot/claude-sonnet-4.6
 *   openai-codex/gpt-5.5        →  github-copilot/gpt-5.5
 *   (역방향도 정의 — copilot 이 먼저 소진되면 네이티브로 복귀)
 *
 * 동작:
 *  - 응답이 quota / rate-limit / auth / 일시장애 에러로 끝나면, 그 모델의 fallbacks 목록 중
 *    쿨다운이 아닌 첫 대상으로 전환하고 중단된 작업을 이어서 진행한다.
 *  - 소진된 프로바이더는 쿨다운(Retry-After / reset 헤더 / 에러본문에서 파싱, 없으면 기본 6h).
 *    copilot 은 GitHub 계정 1개 쿼터를 claude/gpt 가 공유하므로 프로바이더 단위로 쿨다운한다.
 *  - 전환의 출발 모델(origin)을 기억해 두고, 그 프로바이더가 회복되면 새 사용자 턴에서 자동 복귀.
 *
 * 명령어: /failover  (status | next | reset | enable | disable | stop)
 * 설정:   ~/.pi/agent/copilot-failover.json
 * 상태:   ~/.pi/agent/state/copilot-failover-state.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshAnthropicToken, refreshOpenAICodexToken } from "@earendil-works/pi-ai/oauth";

type ModelRef = `${string}/${string}`;

const AGENT_DIR = join(homedir(), ".pi", "agent");
const STATE_DIR = join(AGENT_DIR, "state");
const CONFIG_PATH = join(AGENT_DIR, "copilot-failover.json");
const STATE_PATH = join(STATE_DIR, "copilot-failover-state.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const HOUR = 60 * 60 * 1000;

type Config = {
	enabled: boolean;
	autoContinue: boolean;
	restoreOnRecover: boolean;
	usageApi: {
		enabled: boolean;
		cacheTtlMs: number;
		thresholdPercent: number;
	};
	/** "provider/modelId" → 우선순위대로의 백업 "provider/modelId" 목록 */
	fallbacks: Record<string, string[]>;
	cooldownMs: number;
	transientCooldownMs: number;
	authCooldownMs: number;
	maxAutoContinuesPerPrompt: number;
	continuationPrompt: string;
};

// 모델 ID 표기 주의: anthropic 네이티브는 하이픈(claude-opus-4-8),
// github-copilot 은 점(claude-opus-4.8), openai-codex 는 gpt-5.5.
const DEFAULT_CONFIG: Config = {
	enabled: true,
	autoContinue: true,
	restoreOnRecover: true,
	usageApi: {
		enabled: true,
		cacheTtlMs: 3 * 60 * 1000,
		thresholdPercent: 99.5,
	},
	fallbacks: {
		"anthropic/claude-opus-4-8": ["github-copilot/claude-opus-4.8"],
		"anthropic/claude-sonnet-4-6": ["github-copilot/claude-sonnet-4.6"],
		"openai-codex/gpt-5.5": ["github-copilot/gpt-5.5"],
		// copilot 이 먼저 소진되면 네이티브로 복귀(반대 방향).
		"github-copilot/claude-opus-4.8": ["anthropic/claude-opus-4-8"],
		"github-copilot/claude-sonnet-4.6": ["anthropic/claude-sonnet-4-6"],
		"github-copilot/gpt-5.5": ["openai-codex/gpt-5.5"],
	},
	cooldownMs: 6 * HOUR,
	transientCooldownMs: 60 * 1000,
	authCooldownMs: 60 * 1000,
	maxAutoContinuesPerPrompt: 8,
	continuationPrompt:
		"Provider failover가 발생했습니다: 이전 모델이 사용량/rate limit/인증 한계에 도달하여 {to} 로 전환했습니다. " +
		"마지막 안전한 지점부터 중단된 작업을 계속 진행하세요. 파괴적 작업을 반복하거나 이미 끝난 작업을 중복하지 말고, " +
		"상태가 불확실하면 먼저 현재 파일/세션 상태를 확인한 뒤 이어서 진행하세요.",
};

const LIMIT_PATTERNS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"usage limit",
	"usage_limit",
	"quota",
	"insufficient_quota",
	"out of budget",
	"billing",
	"exceeded your current quota",
	"capacity",
	"overloaded_error",
];
const AUTH_PATTERNS = [
	"401",
	"403",
	"unauthorized",
	"forbidden",
	"authentication_error",
	"invalid api key",
	"invalid_api_key",
	"invalid_token",
	"invalid token",
	"token has expired",
	"token expired",
	"invalid_grant",
	"revoked",
];
const TRANSIENT_PATTERNS = [
	"408",
	"500",
	"502",
	"503",
	"504",
	"529",
	"overloaded",
	"service unavailable",
	"temporarily unavailable",
	"internal server error",
	"bad gateway",
	"gateway timeout",
	"timeout",
	"timed out",
	"econnreset",
	"fetch failed",
	"network error",
	"socket hang up",
	"stream disconnected",
];
const IGNORE_PATTERNS = [
	"context overflow",
	"context window",
	"context length",
	"maximum context",
	"too many tokens",
	"token limit exceeded",
	"input is too long",
	"prompt is too long",
];

function patternMatch(text: string, patterns: string[]) {
	const lower = text.toLowerCase();
	return patterns.some((p) => lower.includes(p));
}

function ref(provider: string, id: string): ModelRef {
	return `${provider}/${id}` as ModelRef;
}

// "provider/modelId" → {provider, id}. provider 에는 슬래시가 없으므로 첫 "/" 기준 분리.
function parseRef(s: string): { provider: string; id: string } | undefined {
	const i = s.indexOf("/");
	if (i <= 0 || i >= s.length - 1) return undefined;
	return { provider: s.slice(0, i), id: s.slice(i + 1) };
}

function numeric(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function parseRetryAfterMs(headers: Record<string, unknown>): number | undefined {
	const h = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
	const ra = h.get("retry-after");
	if (ra) {
		const s = Number(ra);
		if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
		const d = Date.parse(ra);
		if (Number.isFinite(d)) return Math.max(0, d - Date.now());
	}
	for (const key of [
		"x-ratelimit-reset",
		"anthropic-ratelimit-unified-reset",
		"x-codex-primary-reset-at",
		"x-codex-secondary-reset-at",
	]) {
		const s = numeric(h.get(key));
		if (s !== undefined && s > 0) {
			const ms = s > 1_000_000 ? s * 1000 - Date.now() : s * 1000;
			if (ms > 0) return ms;
		}
	}
	return undefined;
}

function cooldownFromErrorText(text: string): number | undefined {
	const m =
		text.match(/resets?_in_seconds"?\s*[:=]\s*(\d+)/i) ??
		text.match(/try again in (\d+)\s*s/i) ??
		text.match(/try again in ~?(\d+)\s*min/i) ??
		text.match(/retry after (\d+)/i);
	if (m) {
		const n = Number(m[1]);
		if (!Number.isFinite(n)) return undefined;
		return /min/i.test(m[0]) ? n * 60 * 1000 : n * 1000;
	}
	return undefined;
}

function resetAtMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function normalizeWindow(raw: any, resetKeys: string[] = ["resets_at", "reset_at"]): UsageWindow | null {
	if (!raw) return null;
	const utilization =
		typeof raw.utilization === "number"
			? raw.utilization
			: typeof raw.used_percent === "number"
				? raw.used_percent
				: undefined;
	let resetsAt: unknown;
	for (const key of resetKeys) {
		if (raw[key] !== undefined && raw[key] !== null) {
			resetsAt = raw[key];
			break;
		}
	}
	return { utilization, resetsAt: resetsAt as string | number | null, resetAtMs: resetAtMs(resetsAt) };
}

function readJson(path: string): any | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function getNestedCredential(raw: any) {
	return raw?.claudeAiOauth && typeof raw.claudeAiOauth === "object" ? raw.claudeAiOauth : raw;
}

function writeAuthCredential(provider: string, patch: Record<string, unknown>) {
	const auth = readJson(AUTH_PATH) ?? {};
	auth[provider] = { ...(auth[provider] ?? {}), ...patch };
	writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));
}

type ClaudeCredentialSource =
	| { source: "env"; credential: any }
	| { source: "file"; path: string; raw: any; credential: any }
	| { source: "keychain"; service: string; raw: any; credential: any };

function saveClaudeCredential(
	source: ClaudeCredentialSource,
	refreshed: { access: string; refresh: string; expires: number },
) {
	if (source.source === "env") return;
	const update = (target: any) => {
		target.accessToken = refreshed.access;
		target.refreshToken = refreshed.refresh;
		target.expiresAt = refreshed.expires;
		// pi-ai OAuth naming도 같이 남겨두면 다른 도구가 읽기 쉽다.
		target.access = refreshed.access;
		target.refresh = refreshed.refresh;
		target.expires = refreshed.expires;
	};
	const raw = source.raw && typeof source.raw === "object" ? { ...source.raw } : {};
	if (raw.claudeAiOauth && typeof raw.claudeAiOauth === "object") {
		raw.claudeAiOauth = { ...raw.claudeAiOauth };
		update(raw.claudeAiOauth);
	} else {
		update(raw);
	}
	if (source.source === "file") {
		writeFileSync(source.path, JSON.stringify(raw, null, 2));
		return;
	}
	const securityBin = existsSync("/usr/bin/security") ? "/usr/bin/security" : "security";
	execFileSync(
		securityBin,
		[
			"add-generic-password",
			"-U",
			"-s",
			source.service,
			"-a",
			process.env.USER || "claude-code",
			"-w",
			JSON.stringify(raw),
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
}

function assistantErrorText(message: any): string {
	if (!message) return "";
	if (typeof message.error === "string") return message.error;
	if (typeof message.error?.message === "string") return message.error.message;
	if (typeof message.errorMessage === "string") return message.errorMessage;
	const parts: string[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (typeof block?.text === "string") parts.push(block.text);
		}
	}
	if (parts.length) return parts.join(" ");
	try {
		return JSON.stringify(message.error ?? message.stopReason ?? "");
	} catch {
		return String(message.stopReason ?? "");
	}
}

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		if (existsSync(CONFIG_PATH)) {
			raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		} else {
			writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
		}
	} catch {
		// 손상된 설정은 기본값으로 폴백.
	}
	return {
		...DEFAULT_CONFIG,
		...raw,
		usageApi: { ...DEFAULT_CONFIG.usageApi, ...(raw.usageApi ?? {}) },
		fallbacks: raw.fallbacks && Object.keys(raw.fallbacks).length ? raw.fallbacks : DEFAULT_CONFIG.fallbacks,
	};
}

type UsageWindow = { utilization?: number; resetsAt?: string | number | null; resetAtMs?: number };
type UsageSnapshot = { provider: string; fetchedAt: number; windows: Record<string, UsageWindow | null>; raw?: any };
type State = {
	cooldowns: Record<string, number>;
	lastSwitches: any[];
	usage?: Record<string, UsageSnapshot>;
	usageErrors?: Record<string, { at: number; reason: string }>;
};

function loadState(): State {
	try {
		if (existsSync(STATE_PATH)) {
			const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
			return {
				cooldowns: s.cooldowns ?? {},
				lastSwitches: Array.isArray(s.lastSwitches) ? s.lastSwitches : [],
				usage: s.usage ?? {},
				usageErrors: s.usageErrors ?? {},
			};
		}
	} catch {
		// ignore
	}
	return { cooldowns: {}, lastSwitches: [], usage: {}, usageErrors: {} };
}

export default function piCopilotFailover(pi: ExtensionAPI) {
	const config = loadConfig();
	const state = loadState();

	// fallbacks 키/값에 등장하는 모든 프로바이더 = 우리가 관리하는 대상.
	const MANAGED = new Set<string>();
	for (const [key, arr] of Object.entries(config.fallbacks)) {
		const k = parseRef(key);
		if (k) MANAGED.add(k.provider);
		for (const v of arr) {
			const p = parseRef(v);
			if (p) MANAGED.add(p.provider);
		}
	}

	let automaticModelTarget: ModelRef | undefined; // 우리가 건 전환(수동 변경과 구분).
	let pendingContinuation: { to: ModelRef } | undefined;
	let originRef: ModelRef | undefined; // failover 출발 모델 — 회복되면 복귀 대상.
	let autoContinueCount = 0;
	let userPinned = false;
	let chainStopped = false;
	let suppressNextInputReset = false;
	const handledErrors = new Set<string>();
	const responseCooldownHints = new Map<string, number>();

	function saveState() {
		try {
			if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
			writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
		} catch {
			// 영속 실패는 치명적이지 않음.
		}
	}

	function recordUsageError(provider: string, reason: unknown) {
		state.usageErrors ??= {};
		state.usageErrors[provider] = {
			at: Date.now(),
			reason: String((reason as any)?.message ?? reason).slice(0, 500),
		};
		saveState();
	}

	function clearUsageError(provider: string) {
		if (state.usageErrors?.[provider]) {
			delete state.usageErrors[provider];
			saveState();
		}
	}

	function managed(provider: string | undefined): provider is string {
		return !!provider && MANAGED.has(provider);
	}

	function pruneCooldowns() {
		const now = Date.now();
		let changed = false;
		for (const [prov, until] of Object.entries(state.cooldowns)) {
			if (until <= now) {
				delete state.cooldowns[prov];
				changed = true;
			}
		}
		if (changed) saveState();
	}

	function isCooled(provider: string, now = Date.now()) {
		const until = state.cooldowns[provider];
		return typeof until === "number" && until > now;
	}

	function setCooldown(provider: string, ms: number, options?: { exact?: boolean }) {
		if (ms <= 0) return;
		const until = Date.now() + ms;
		state.cooldowns[provider] = options?.exact ? until : Math.max(state.cooldowns[provider] ?? 0, until);
		saveState();
	}

	function soonestCooldownNote(): string {
		const entries = Object.entries(state.cooldowns).filter(([, until]) => until > Date.now());
		if (!entries.length) return "";
		const soonest = Math.min(...entries.map(([, u]) => u));
		const mins = Math.ceil((soonest - Date.now()) / 60000);
		return ` (가장 빠른 회복: 약 ${mins}분 후)`;
	}

	async function fetchCodexUsage(force = false): Promise<UsageSnapshot | undefined> {
		const provider = "openai-codex";
		const cached = state.usage?.[provider];
		if (!force && cached && Date.now() - cached.fetchedAt < config.usageApi.cacheTtlMs) return cached;
		const auth = readJson(AUTH_PATH)?.[provider];
		if (!auth?.access) return cached;
		let access = auth.access as string;
		const accountId = typeof auth.accountId === "string" ? auth.accountId : "";
		async function request(token: string) {
			return fetch("https://chatgpt.com/backend-api/codex/usage", {
				headers: {
					Authorization: `Bearer ${token}`,
					"chatgpt-account-id": accountId,
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
					Accept: "application/json",
				},
			});
		}
		try {
			let res = await request(access);
			if ((res.status === 401 || res.status === 403) && auth.refresh) {
				const refreshed = await refreshOpenAICodexToken(auth.refresh);
				writeAuthCredential(provider, {
					type: auth.type ?? "oauth",
					access: refreshed.access,
					refresh: refreshed.refresh,
					expires: refreshed.expires,
				});
				access = refreshed.access;
				res = await request(access);
			}
			if (!res.ok) return cached;
			const data = await res.json();
			const windows: Record<string, UsageWindow | null> = {
				primary: normalizeWindow(data?.rate_limit?.primary_window),
				secondary: normalizeWindow(data?.rate_limit?.secondary_window),
			};
			for (const item of data?.additional_rate_limits ?? []) {
				const name = String(item?.limit_name ?? "additional");
				windows[`additional:${name}:primary`] = normalizeWindow(item?.rate_limit?.primary_window);
				windows[`additional:${name}:secondary`] = normalizeWindow(item?.rate_limit?.secondary_window);
			}
			const snap: UsageSnapshot = {
				provider,
				fetchedAt: Date.now(),
				windows,
				raw: {
					planType: data?.plan_type,
					rateLimitReachedType: data?.rate_limit_reached_type,
				},
			};
			state.usage ??= {};
			state.usage[provider] = snap;
			clearUsageError(provider);
			saveState();
			return snap;
		} catch (error) {
			recordUsageError(provider, error);
			return cached;
		}
	}

	function readClaudeCodeCredential(): ClaudeCredentialSource | undefined {
		const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		if (envToken) return { source: "env", credential: { accessToken: envToken } };
		const filePath = join(homedir(), ".claude", ".credentials.json");
		const fileCred = readJson(filePath);
		if (fileCred) return { source: "file", path: filePath, raw: fileCred, credential: getNestedCredential(fileCred) };
		if (process.platform === "darwin") {
			const service = "Claude Code-credentials";
			const securityBin = existsSync("/usr/bin/security") ? "/usr/bin/security" : "security";
			try {
				const rawText = execFileSync(securityBin, ["find-generic-password", "-s", service, "-w"], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}).trim();
				const raw = JSON.parse(rawText);
				return { source: "keychain", service, raw, credential: getNestedCredential(raw) };
			} catch (error) {
				recordUsageError(
					"anthropic",
					`Claude Code keychain read failed: ${(error as any)?.stderr?.toString?.() || (error as any)?.message || error}`,
				);
				return undefined;
			}
		}
		return undefined;
	}

	async function fetchAnthropicUsage(force = false): Promise<UsageSnapshot | undefined> {
		const provider = "anthropic";
		const cached = state.usage?.[provider];
		if (!force && cached && Date.now() - cached.fetchedAt < config.usageApi.cacheTtlMs) return cached;
		const piAuth = readJson(AUTH_PATH)?.[provider];
		const cc = readClaudeCodeCredential();
		const ccCredential = cc?.credential;
		let access = (piAuth?.access ?? ccCredential?.accessToken ?? ccCredential?.access) as string | undefined;
		const refresh = (piAuth?.refresh ?? ccCredential?.refreshToken ?? ccCredential?.refresh) as string | undefined;
		if (!access && !refresh) {
			recordUsageError(
				provider,
				"Claude OAuth credential not found. Tried CLAUDE_CODE_OAUTH_TOKEN, ~/.claude/.credentials.json, and macOS Keychain service 'Claude Code-credentials'.",
			);
			return cached;
		}
		async function request(token: string) {
			return fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
					"User-Agent": "claude-code/1.0.0",
					"Content-Type": "application/json",
					Accept: "application/json",
				},
			});
		}
		try {
			let res: Response | undefined;
			if (access) res = await request(access);
			if ((!res || res.status === 401 || res.status === 403) && refresh) {
				const refreshed = await refreshAnthropicToken(refresh);
				if (piAuth?.refresh) {
					writeAuthCredential(provider, {
						type: piAuth.type ?? "oauth",
						access: refreshed.access,
						refresh: refreshed.refresh,
						expires: refreshed.expires,
					});
				} else if (cc) {
					saveClaudeCredential(cc, refreshed);
				}
				access = refreshed.access;
				res = await request(refreshed.access);
			}
			if (!res?.ok) {
				let body = "";
				try {
					body = res ? await res.text() : "";
				} catch {}
				recordUsageError(provider, `Claude usage API ${res?.status} ${res?.statusText}: ${body.slice(0, 300)}`);
				return cached;
			}
			const data = await res.json();
			const snap: UsageSnapshot = {
				provider,
				fetchedAt: Date.now(),
				windows: {
					five_hour: normalizeWindow(data?.five_hour),
					seven_day: normalizeWindow(data?.seven_day),
					seven_day_opus: normalizeWindow(data?.seven_day_opus),
					seven_day_sonnet: normalizeWindow(data?.seven_day_sonnet),
				},
			};
			state.usage ??= {};
			state.usage[provider] = snap;
			clearUsageError(provider);
			saveState();
			return snap;
		} catch (error) {
			recordUsageError(provider, error);
			return cached;
		}
	}

	async function fetchUsage(provider: string, force = false): Promise<UsageSnapshot | undefined> {
		if (!config.usageApi.enabled) return undefined;
		if (provider === "openai-codex") return fetchCodexUsage(force);
		if (provider === "anthropic") return fetchAnthropicUsage(force);
		return state.usage?.[provider];
	}

	function usageCooldownMs(snapshot: UsageSnapshot | undefined, provider: string, modelId: string): number | undefined {
		if (!snapshot) return undefined;
		const threshold = config.usageApi.thresholdPercent;
		const now = Date.now();
		const relevant: (UsageWindow | null | undefined)[] = [];
		if (provider === "openai-codex") {
			relevant.push(snapshot.windows.primary, snapshot.windows.secondary);
			for (const [name, win] of Object.entries(snapshot.windows)) {
				if (name.startsWith("additional:") && name.toLowerCase().includes(modelId.toLowerCase())) relevant.push(win);
			}
		} else if (provider === "anthropic") {
			relevant.push(snapshot.windows.five_hour, snapshot.windows.seven_day);
			if (/opus/i.test(modelId)) relevant.push(snapshot.windows.seven_day_opus);
			if (/sonnet/i.test(modelId)) relevant.push(snapshot.windows.seven_day_sonnet);
		}
		const reached = relevant
			.filter((w): w is UsageWindow => !!w && typeof w.resetAtMs === "number" && w.resetAtMs > now)
			.filter((w) => (w.utilization ?? 0) >= threshold);
		if (!reached.length) return undefined;
		// 동시에 여러 window가 100%면 모두 풀릴 때까지 막히므로 가장 늦은 reset까지 기다린다.
		const until = Math.max(...reached.map((w) => w.resetAtMs!));
		return Math.max(0, until - now);
	}

	function formatUsageSnapshot(snapshot: UsageSnapshot | undefined, provider = "unknown") {
		if (!snapshot) {
			const err = state.usageErrors?.[provider];
			if (err) {
				const age = Math.max(0, Math.round((Date.now() - err.at) / 1000));
				return `${provider}: usage 조회 실패 (${age}s 전): ${err.reason}`;
			}
			return `${provider}: usage 조회 결과 없음`;
		}
		const rows = Object.entries(snapshot.windows)
			.filter(([, w]) => !!w)
			.map(([name, w]) => {
				const reset = w?.resetAtMs ? new Date(w.resetAtMs).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "?";
				const pct = typeof w?.utilization === "number" ? `${Math.round(w.utilization)}%` : "?";
				return `${name} ${pct} reset ${reset}`;
			});
		const age = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
		return `${snapshot.provider} (${age}s 전): ${rows.join("; ") || "usage 없음"}`;
	}

	function resolveModel(ctx: any, provider: string, id: string): any {
		// 등록된 모델(코파일럿 동적 모델 포함)은 modelRegistry 에서 찾고,
		// 못 찾으면 {provider, id} 원본으로 폴백한다(setModel 이 id 로 해석).
		try {
			const reg = ctx?.modelRegistry;
			const m = reg?.find?.(provider, id) ?? reg?.get?.(provider, id);
			if (m) return m;
		} catch {
			// ignore
		}
		return { provider, id };
	}

	// 주어진 모델의 fallbacks 목록을, 쿨다운이 아닌 대상만 순서대로 모델 객체로.
	function candidatesFor(ctx: any, fromRef: ModelRef, now: number) {
		const out: any[] = [];
		for (const targetStr of config.fallbacks[fromRef] ?? []) {
			const t = parseRef(targetStr);
			if (!t) continue;
			if (isCooled(t.provider, now)) continue;
			out.push(resolveModel(ctx, t.provider, t.id));
		}
		return out;
	}

	async function doSwitch(ctx: any, fromModel: any, reason: string) {
		if (!config.enabled) return false;
		if (!fromModel?.provider || !fromModel?.id) return false;
		const fromRef = ref(fromModel.provider, fromModel.id);
		const candidates = candidatesFor(ctx, fromRef, Date.now());
		if (!candidates.length) {
			ctx?.ui?.notify?.(
				`copilot-failover: ${fromRef} 의 백업 대상이 없거나 모두 쿨다운 중입니다${soonestCooldownNote()}`,
				"warning",
			);
			return false;
		}
		for (const cand of candidates) {
			const to = ref(cand.provider, cand.id);
			automaticModelTarget = to;
			let ok = false;
			try {
				ok = await pi.setModel(cand);
			} catch {
				ok = false;
			}
			if (!ok) {
				if (automaticModelTarget === to) automaticModelTarget = undefined;
				setCooldown(cand.provider, config.transientCooldownMs);
				continue;
			}
			if (!originRef) originRef = fromRef; // 체인 최초 출발점 기억(복귀용).
			const record = { from: fromRef, to, reason, at: Date.now() };
			state.lastSwitches = [record, ...state.lastSwitches].slice(0, 20);
			saveState();
			try {
				pi.appendEntry("copilot-failover", record as any);
			} catch {
				// ignore
			}
			ctx?.ui?.notify?.(`copilot-failover: ${fromRef} → ${to} (${reason})`, "warning");
			if (config.autoContinue && !chainStopped) pendingContinuation = { to };
			return true;
		}
		return false;
	}

	function classify(text: string): "ignore" | "limit" | "auth" | "transient" | null {
		if (patternMatch(text, IGNORE_PATTERNS)) return "ignore";
		if (patternMatch(text, LIMIT_PATTERNS)) return "limit";
		if (patternMatch(text, AUTH_PATTERNS)) return "auth";
		if (patternMatch(text, TRANSIENT_PATTERNS)) return "transient";
		return null;
	}

	async function handleError(ctx: any, provider: string, modelId: string, text: string) {
		if (!config.enabled || chainStopped) return;
		if (!managed(provider)) return;
		// 이 모델에 대한 백업 정의가 없으면 할 수 있는 게 없음.
		if (!config.fallbacks[ref(provider, modelId)]) return;
		const kind = classify(text);
		if (!kind || kind === "ignore") return;

		const failedModel = resolveModel(ctx, provider, modelId);
		let cooldownMs: number;
		let exactCooldown = false;
		if (kind === "limit") {
			const usageMs = usageCooldownMs(await fetchUsage(provider, true), provider, modelId);
			if (usageMs !== undefined) exactCooldown = true;
			cooldownMs = usageMs ?? responseCooldownHints.get(provider) ?? cooldownFromErrorText(text) ?? config.cooldownMs;
		} else if (kind === "auth") {
			cooldownMs = config.authCooldownMs;
		} else {
			cooldownMs = config.transientCooldownMs;
		}
		setCooldown(provider, cooldownMs, { exact: exactCooldown });
		responseCooldownHints.delete(provider);
		await doSwitch(ctx, failedModel, `${kind}: ${text.slice(0, 100)}`);
	}

	// failover 출발 모델(origin)의 프로바이더가 회복되면 그 모델로 복귀.
	async function restoreToOrigin(ctx: any) {
		if (!config.enabled || !config.restoreOnRecover) return;
		if (userPinned || chainStopped || !originRef) return;
		const o = parseRef(originRef);
		if (!o || isCooled(o.provider)) return;
		const current = ctx?.model ?? ctx?.getModel?.();
		if (current?.provider === o.provider && current?.id === o.id) {
			originRef = undefined;
			return;
		}
		const m = resolveModel(ctx, o.provider, o.id);
		const to = ref(o.provider, o.id);
		automaticModelTarget = to;
		try {
			if (await pi.setModel(m)) {
				ctx?.ui?.notify?.(`copilot-failover: ${to} 회복 → 복귀`, "info");
				originRef = undefined;
			} else if (automaticModelTarget === to) {
				automaticModelTarget = undefined;
			}
		} catch {
			if (automaticModelTarget === to) automaticModelTarget = undefined;
		}
	}

	// ---------- 명령어 ----------
	async function handleCommand(argStr: string, ctx: any) {
		const args = (argStr ?? "").trim().split(/\s+/).filter(Boolean);
		const sub = (args[0] ?? "status").toLowerCase();
		const notify = (msg: string, level: string = "info") => ctx?.ui?.notify?.(msg, level);
		if (sub === "enable") {
			config.enabled = true;
			notify("copilot-failover: 활성화됨");
			return;
		}
		if (sub === "disable") {
			config.enabled = false;
			notify("copilot-failover: 비활성화됨", "warning");
			return;
		}
		if (sub === "reset") {
			state.cooldowns = {};
			responseCooldownHints.clear();
			chainStopped = false;
			originRef = undefined;
			saveState();
			notify("copilot-failover: 모든 쿨다운/중단 상태 초기화됨");
			return;
		}
		if (sub === "stop") {
			chainStopped = true;
			pendingContinuation = undefined;
			notify("copilot-failover: 현재 작업의 자동 failover/이어가기 중단됨", "warning");
			return;
		}
		if (sub === "usage") {
			const force = ["refresh", "force", "--refresh", "-f"].includes((args[1] ?? "").toLowerCase());
			const codex = await fetchUsage("openai-codex", force);
			const claude = await fetchUsage("anthropic", force);
			notify(
				[
					`copilot-failover usage${force ? " (강제 갱신)" : " (캐시 우선)"}:`,
					formatUsageSnapshot(codex, "openai-codex"),
					formatUsageSnapshot(claude, "anthropic"),
					`강제 갱신: /failover usage refresh · 캐시 TTL: ${Math.round(config.usageApi.cacheTtlMs / 1000)}s`,
				].join("\n"),
			);
			return;
		}
		if (sub === "next") {
			const current = ctx?.model ?? ctx?.getModel?.();
			await doSwitch(ctx, current, "수동(/failover next)");
			return;
		}
		// status
		const now = Date.now();
		const cur = ctx?.model ?? ctx?.getModel?.();
		const curRef = cur?.provider ? ref(cur.provider, cur.id) : "(없음)";
		const cools =
			Object.entries(state.cooldowns)
				.filter(([, u]) => u > now)
				.map(([p, u]) => `${p}: ${Math.ceil((u - now) / 60000)}분`)
				.join(", ") || "없음";
		const chains = Object.entries(config.fallbacks)
			.map(([k, v]) => `  ${k} → ${v.join(" → ")}`)
			.join("\n");
		notify(
			[
				`copilot-failover: ${config.enabled ? "ON" : "OFF"} · auto-continue ${config.autoContinue ? "ON" : "OFF"} · restore ${config.restoreOnRecover ? "ON" : "OFF"}`,
				`현재 모델: ${curRef}`,
				`복귀 대기(origin): ${originRef ?? "없음"}`,
				`쿨다운: ${cools}`,
				`자동 이어가기: ${autoContinueCount}/${config.maxAutoContinuesPerPrompt}`,
				`failover 매핑:\n${chains}`,
				`명령: status | usage | next | reset | stop | enable | disable`,
			].join("\n"),
			"info",
		);
	}

	for (const name of ["failover", "provider-failover"]) {
		pi.registerCommand(name, {
			description: "모델 보존형 자동 failover (copilot 백업) 관리",
			handler: handleCommand,
		});
	}

	// ---------- 이벤트 ----------
	pruneCooldowns();

	pi.on("model_select", (event: any) => {
		const model = event?.model;
		if (!model?.provider || !model?.id) return;
		const selected = ref(model.provider, model.id);
		if (automaticModelTarget === selected) {
			automaticModelTarget = undefined;
			return; // 우리가 건 전환/복귀.
		}
		if (event?.source === "restore") return;
		// 사용자가 직접 모델 선택 → 자동 복귀 보류(failover 자체는 계속).
		userPinned = true;
		originRef = undefined;
		pendingContinuation = undefined;
	});

	pi.on("after_provider_response", (event: any, ctx: any) => {
		if (!config.enabled) return;
		const status = event?.status;
		const provider = ctx?.model?.provider;
		if (!managed(provider)) return;
		if (status !== undefined && status < 400) {
			responseCooldownHints.delete(provider);
			return;
		}
		if (status === 429 || status === 402 || status === 403) {
			const ms = parseRetryAfterMs(event?.headers ?? {});
			if (ms !== undefined) {
				responseCooldownHints.set(provider, Math.max(responseCooldownHints.get(provider) ?? 0, ms));
			}
		}
	});

	pi.on("message_end", async (event: any, ctx: any) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (chainStopped || ctx?.signal?.aborted) return;
		const provider = typeof message.provider === "string" ? message.provider : ctx?.model?.provider;
		const modelId = typeof message.model === "string" ? message.model : ctx?.model?.id;
		if (!provider || !modelId) return;
		if (!managed(provider)) return;
		const text = assistantErrorText(message);
		const key = `${provider}/${modelId}:${message.timestamp ?? "?"}:${text.slice(0, 60)}`;
		if (handledErrors.has(key)) return;
		handledErrors.add(key);
		await handleError(ctx, provider, modelId, text);
	});

	pi.on("input", async () => {
		// 자동 이어가기로 보낸 메시지는 카운터 리셋 대상에서 제외(루프 방지).
		if (suppressNextInputReset) {
			suppressNextInputReset = false;
			return;
		}
		autoContinueCount = 0;
		chainStopped = false;
		userPinned = false;
		pendingContinuation = undefined;
		handledErrors.clear();
	});

	pi.on("before_agent_start", async (_event: any, ctx: any) => {
		pruneCooldowns();
		await restoreToOrigin(ctx);
	});

	pi.on("agent_end", async (_event: any, ctx: any) => {
		if (!pendingContinuation) return;
		const target = pendingContinuation;
		pendingContinuation = undefined;
		if (!config.enabled || !config.autoContinue || chainStopped) return;
		if (ctx?.signal?.aborted) return;
		if (autoContinueCount >= config.maxAutoContinuesPerPrompt) {
			ctx?.ui?.notify?.(
				`copilot-failover: 자동 이어가기 한도(${config.maxAutoContinuesPerPrompt}) 도달. 수동으로 계속하세요.`,
				"warning",
			);
			return;
		}
		autoContinueCount++;
		suppressNextInputReset = true;
		const prompt = config.continuationPrompt.replace("{to}", target.to);
		try {
			if (ctx?.isIdle?.()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" } as any);
		} catch {
			suppressNextInputReset = false;
		}
	});
}
