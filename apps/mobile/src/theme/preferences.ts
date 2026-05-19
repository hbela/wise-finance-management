import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import type { FinanceColorTheme, FinanceThemeMode } from "./paperTheme";

const themePreferenceKey = "standalone-finance.theme-preferences.v1";

type ThemePreferences = {
  colorTheme: FinanceColorTheme;
  themeMode: FinanceThemeMode;
};

const colorThemes: FinanceColorTheme[] = ["brown", "blue", "pink"];
const themeModes: FinanceThemeMode[] = ["light", "dark"];

export async function loadThemePreferences(): Promise<ThemePreferences | null> {
  const raw = await readPreference(themePreferenceKey);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThemePreferences>;
    if (!isColorTheme(parsed.colorTheme) || !isThemeMode(parsed.themeMode)) {
      await clearThemePreferences();
      return null;
    }
    return {
      colorTheme: parsed.colorTheme,
      themeMode: parsed.themeMode
    };
  } catch {
    await clearThemePreferences();
    return null;
  }
}

export async function saveThemePreferences(preferences: ThemePreferences): Promise<void> {
  await writePreference(themePreferenceKey, JSON.stringify(preferences));
}

export async function clearThemePreferences(): Promise<void> {
  await removePreference(themePreferenceKey);
}

function isColorTheme(value: unknown): value is FinanceColorTheme {
  return typeof value === "string" && colorThemes.includes(value as FinanceColorTheme);
}

function isThemeMode(value: unknown): value is FinanceThemeMode {
  return typeof value === "string" && themeModes.includes(value as FinanceThemeMode);
}

async function readPreference(key: string): Promise<string | null> {
  if (canUseWebStorage()) {
    return window.localStorage.getItem(key);
  }
  ensureSecureStoreAvailable();
  return SecureStore.getItemAsync(key);
}

async function writePreference(key: string, value: string): Promise<void> {
  if (canUseWebStorage()) {
    window.localStorage.setItem(key, value);
    return;
  }
  ensureSecureStoreAvailable();
  await SecureStore.setItemAsync(key, value);
}

async function removePreference(key: string): Promise<void> {
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
      "Secure preference storage is unavailable. Install a fresh development build that includes expo-secure-store."
    );
  }
}
