import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { ed25519 } from "@noble/curves/ed25519";

const tokenStorageKey = "tink.sandbox.tokens";
const pendingStateStorageKey = "tink.sandbox.pendingState";
const signingKeyStorageKey = "tink.sandbox.signingKey";
const refreshPath = "/oauth/tink/refresh";
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type TinkBridgeConfig = {
  bridgeUrl: string;
  clientId: string;
  redirectUri: string;
  linkBaseUrl: string;
  market: string;
  locale: string;
  scopes: string[];
  testMode: boolean;
  inputProvider: string;
  webRedirectUri: string;
};

export type TinkBridgeTokens = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scope?: string;
  receivedAt: number;
};

export type TinkBridgeCallbackResult =
  | {
      status: "authorized";
      tokens: TinkBridgeTokens;
    }
  | {
      status: "failed";
      message: string;
    }
  | null;

export const tinkBridgeConfig: TinkBridgeConfig = {
  bridgeUrl: normalizeBaseUrl(process.env.EXPO_PUBLIC_TINK_BRIDGE_URL ?? ""),
  clientId: process.env.EXPO_PUBLIC_TINK_CLIENT_ID ?? "",
  redirectUri: process.env.EXPO_PUBLIC_TINK_REDIRECT_URI ?? "",
  linkBaseUrl:
    process.env.EXPO_PUBLIC_TINK_LINK_BASE_URL ??
    "https://link.tink.com/1.0/transactions/connect-accounts",
  market: process.env.EXPO_PUBLIC_TINK_MARKET ?? "GB",
  locale: process.env.EXPO_PUBLIC_TINK_LOCALE ?? "en_US",
  scopes: parseScopes(
    process.env.EXPO_PUBLIC_TINK_SCOPES ??
      "accounts:read,balances:read,transactions:read,provider-consents:read,user:read,credentials:read,credentials:refresh"
  ),
  testMode: process.env.EXPO_PUBLIC_TINK_TEST_MODE !== "false",
  inputProvider: process.env.EXPO_PUBLIC_TINK_INPUT_PROVIDER ?? "",
  webRedirectUri: process.env.EXPO_PUBLIC_TINK_WEB_REDIRECT_URI ?? ""
};

export function isTinkBridgeConfigured(config = tinkBridgeConfig) {
  return Boolean(config.bridgeUrl && config.clientId && config.redirectUri);
}

export function getTinkBridgeMissingConfig(config = tinkBridgeConfig) {
  return [
    config.clientId ? null : "EXPO_PUBLIC_TINK_CLIENT_ID",
    config.bridgeUrl ? null : "EXPO_PUBLIC_TINK_BRIDGE_URL",
    config.redirectUri ? null : "EXPO_PUBLIC_TINK_REDIRECT_URI"
  ].filter((value): value is string => Boolean(value));
}

export async function buildTinkSandboxLink(config = tinkBridgeConfig) {
  if (!isTinkBridgeConfigured(config)) {
    throw new Error(`Set ${getTinkBridgeMissingConfig(config).join(", ")} in .env.local.`);
  }

  const runtimeConfig = {
    ...config,
    webRedirectUri: getRuntimeWebRedirectUri(config)
  };
  const state = createState(runtimeConfig);
  await writeStorage(pendingStateStorageKey, state);

  const url = new URL(runtimeConfig.linkBaseUrl);
  url.searchParams.set("client_id", runtimeConfig.clientId);
  url.searchParams.set("redirect_uri", runtimeConfig.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", runtimeConfig.scopes.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("market", runtimeConfig.market);
  url.searchParams.set("locale", runtimeConfig.locale);
  if (runtimeConfig.testMode) {
    url.searchParams.set("test", "true");
  }
  if (runtimeConfig.inputProvider) {
    url.searchParams.set("input_provider", runtimeConfig.inputProvider);
  }
  return url.toString();
}

export async function handleTinkBridgeCallback(url: string): Promise<TinkBridgeCallbackResult> {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\/+/, "");
  const isBridgeCallback =
    (parsed.hostname === "oauth" && path === "tink") || path === "oauth/tink";
  if (!isBridgeCallback) {
    return null;
  }

  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const state = fragment.get("state");
  const pendingState = await readStorage(pendingStateStorageKey);
  if (!state || !pendingState || state !== pendingState) {
    const accessToken = fragment.get("access_token");
    const stored = await getTinkBridgeTokens();
    if (accessToken && stored?.accessToken === accessToken) {
      return { status: "authorized", tokens: stored };
    }

    if (Platform.OS === "web" && accessToken && isCurrentWebRedirectState(state)) {
      const tokens = tokensFromFragment(fragment);
      await saveTinkBridgeTokens(tokens);
      await deleteStorage(pendingStateStorageKey);
      return { status: "authorized", tokens };
    }

    return {
      status: "failed",
      message: "Tink authorization state did not match this device."
    };
  }

  await deleteStorage(pendingStateStorageKey);

  const error = fragment.get("error");
  if (error) {
    return {
      status: "failed",
      message: fragment.get("error_description") ?? error
    };
  }

  const accessToken = fragment.get("access_token");
  if (!accessToken) {
    return {
      status: "failed",
      message: "Tink authorization completed without an access token."
    };
  }

  const tokens = tokensFromFragment(fragment);
  await saveTinkBridgeTokens(tokens);
  return { status: "authorized", tokens };
}

export async function getTinkBridgeTokens() {
  const raw = await readStorage(tokenStorageKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as TinkBridgeTokens;
    if (typeof parsed.accessToken !== "string" || typeof parsed.receivedAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveTinkBridgeTokens(tokens: TinkBridgeTokens) {
  await writeStorage(tokenStorageKey, JSON.stringify(tokens));
}

export async function clearTinkBridgeTokens() {
  await deleteStorage(tokenStorageKey);
  await deleteStorage(pendingStateStorageKey);
}

export async function refreshTinkBridgeTokens(config = tinkBridgeConfig) {
  if (!isTinkBridgeConfigured(config)) {
    throw new Error(`Set ${getTinkBridgeMissingConfig(config).join(", ")} in .env.local.`);
  }

  const current = await getTinkBridgeTokens();
  if (!current?.refreshToken) {
    throw new Error("No Tink refresh token is stored on this device.");
  }

  const body = JSON.stringify({ refresh_token: current.refreshToken });
  const headers = await buildSignedHeaders("POST", refreshPath, body);
  const response = await fetch(`${config.bridgeUrl}${refreshPath}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload.message === "string"
        ? payload.message
        : "Tink token refresh failed."
    );
  }

  if (!payload || typeof payload.access_token !== "string") {
    throw new Error("Tink token refresh returned an invalid response.");
  }

  const next: TinkBridgeTokens = {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : current.refreshToken,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : current.tokenType,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : current.expiresIn,
    scope: typeof payload.scope === "string" ? payload.scope : current.scope,
    receivedAt: Date.now()
  };
  await saveTinkBridgeTokens(next);
  return next;
}

async function buildSignedHeaders(method: string, path: string, body: string) {
  const keyPair = await getOrCreateSigningKeyPair();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = await sha256Hex(body);
  const message = new TextEncoder().encode(
    `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`
  );
  const signature = ed25519.sign(message, keyPair.secretKey);
  return {
    "X-Public-Key": base64Encode(keyPair.publicKey),
    "X-Timestamp": timestamp,
    "X-Signature": base64Encode(signature)
  };
}

async function getOrCreateSigningKeyPair() {
  const existing = await readStorage(signingKeyStorageKey);
  if (existing) {
    const secretKey = base64Decode(existing);
    return {
      secretKey,
      publicKey: ed25519.getPublicKey(secretKey)
    };
  }

  const secretKey = ed25519.utils.randomSecretKey(await Crypto.getRandomBytesAsync(32));
  const publicKey = ed25519.getPublicKey(secretKey);
  await writeStorage(signingKeyStorageKey, base64Encode(secretKey));
  return { secretKey, publicKey };
}

async function sha256Hex(input: string) {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createState(config = tinkBridgeConfig) {
  const bytes = Crypto.getRandomBytes(32);
  const nonce = base64UrlEncode(bytes);
  if (Platform.OS !== "web" || !config.webRedirectUri) {
    return nonce;
  }

  const payload = new TextEncoder().encode(
    JSON.stringify({ web_redirect_uri: config.webRedirectUri })
  );
  return `${nonce}.${base64UrlEncode(payload)}`;
}

function getRuntimeWebRedirectUri(config = tinkBridgeConfig) {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return config.webRedirectUri;
  }

  return new URL("/oauth/tink", window.location.origin).toString();
}

function isCurrentWebRedirectState(state: string | null) {
  if (!state || typeof window === "undefined") {
    return false;
  }

  const [, encodedPayload] = state.split(".", 2);
  if (!encodedPayload) {
    return false;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as {
      web_redirect_uri?: unknown;
    };
    if (typeof payload.web_redirect_uri !== "string") {
      return false;
    }

    const expected = new URL("/oauth/tink", window.location.origin);
    const actual = new URL(payload.web_redirect_uri);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function tokensFromFragment(fragment: URLSearchParams): TinkBridgeTokens {
  return {
    accessToken: fragment.get("access_token") ?? "",
    refreshToken: fragment.get("refresh_token") ?? undefined,
    tokenType: fragment.get("token_type") ?? undefined,
    expiresIn: parseInteger(fragment.get("expires_in")),
    scope: fragment.get("scope") ?? undefined,
    receivedAt: Date.now()
  };
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function parseScopes(value: string) {
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseInteger(value: string | null) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function base64UrlEncode(bytes: Uint8Array) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Encode(bytes: Uint8Array) {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    output += base64Alphabet[(chunk >> 18) & 63];
    output += base64Alphabet[(chunk >> 12) & 63];
    output += i + 1 < bytes.length ? base64Alphabet[(chunk >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? base64Alphabet[chunk & 63] : "=";
  }
  return output;
}

function base64Decode(value: string) {
  return base64UrlDecode(value);
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));
  const clean = padded.replace(/=+$/, "");
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i += 4) {
    const a = base64Alphabet.indexOf(clean[i]);
    const b = base64Alphabet.indexOf(clean[i + 1]);
    const c = base64Alphabet.indexOf(clean[i + 2] ?? "A");
    const d = base64Alphabet.indexOf(clean[i + 3] ?? "A");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("Invalid base64 value.");
    }

    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((chunk >> 16) & 255);
    if (i + 2 < clean.length) {
      bytes.push((chunk >> 8) & 255);
    }
    if (i + 3 < clean.length) {
      bytes.push(chunk & 255);
    }
  }

  return new Uint8Array(bytes);
}

async function readStorage(key: string) {
  if (canUseWebStorage()) {
    return window.localStorage.getItem(key);
  }
  ensureSecureStoreAvailable();
  return SecureStore.getItemAsync(key);
}

async function writeStorage(key: string, value: string) {
  if (canUseWebStorage()) {
    window.localStorage.setItem(key, value);
    return;
  }
  ensureSecureStoreAvailable();
  await SecureStore.setItemAsync(key, value);
}

async function deleteStorage(key: string) {
  if (canUseWebStorage()) {
    window.localStorage.removeItem(key);
    return;
  }
  ensureSecureStoreAvailable();
  await SecureStore.deleteItemAsync(key);
}

function canUseWebStorage() {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof window.localStorage?.getItem === "function" &&
    typeof window.localStorage?.setItem === "function" &&
    typeof window.localStorage?.removeItem === "function"
  );
}

function ensureSecureStoreAvailable() {
  if (
    typeof SecureStore.getItemAsync !== "function" ||
    typeof SecureStore.setItemAsync !== "function" ||
    typeof SecureStore.deleteItemAsync !== "function"
  ) {
    throw new Error(
      "Secure token storage is unavailable. Install a fresh development build that includes expo-secure-store."
    );
  }
}
