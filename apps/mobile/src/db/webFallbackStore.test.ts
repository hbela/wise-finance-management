import { isWebFallbackStorageEnabled, webFallbackStore } from "./webFallbackStore";
import type { AccountRow, TransactionRow, UserRow } from "./mappers";
import { Platform } from "react-native";

const originalWindow = global.window;
const originalSharedArrayBuffer = global.SharedArrayBuffer;
const originalCrossOriginIsolated = global.crossOriginIsolated;

const localStorageBacking = new Map<string, string>();

function installWindow() {
  localStorageBacking.clear();
  global.window = {
    localStorage: {
      getItem: (key: string) => localStorageBacking.get(key) ?? null,
      setItem: (key: string, value: string) => localStorageBacking.set(key, value),
      removeItem: (key: string) => localStorageBacking.delete(key),
      clear: () => localStorageBacking.clear(),
    },
  } as unknown as Window & typeof globalThis;
}

const user: UserRow = {
  id: "user-1",
  clerkUserId: "local",
  country: "HU",
  locale: "hu-HU",
  baseCurrency: "EUR",
  createdAt: 1,
  updatedAt: 1,
};

const account: AccountRow = {
  id: "account-1",
  userId: "user-1",
  source: "manual",
  bankId: null,
  bankKey: null,
  providerAccountId: null,
  credentialsId: null,
  name: "Everyday",
  currency: "EUR",
  type: "checking",
  currentBalance: 100,
  availableBalance: null,
  institutionName: null,
  holderName: null,
  iban: null,
  bban: null,
  lastSyncedAt: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const transaction: TransactionRow = {
  id: "transaction-1",
  userId: "user-1",
  accountId: "account-1",
  source: "manual",
  providerTransactionId: null,
  postedAt: Date.parse("2026-05-14"),
  amount: -10,
  currency: "EUR",
  baseCurrencyAmount: -10,
  description: "Coffee",
  merchant: "Cafe",
  categoryId: "Food",
  tinkCategoryCode: null,
  importBatchId: null,
  type: "expense",
  isRecurring: false,
  recurringGroupId: null,
  isExcludedFromReports: false,
  transferMatchId: null,
  dedupeHash: "hash",
  status: "booked",
  notes: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  installWindow();
  Object.defineProperty(Platform, "OS", {
    value: "web",
    configurable: true,
  });
  delete (global as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  Object.defineProperty(global, "crossOriginIsolated", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(Platform, "OS", {
    value: "ios",
    configurable: true,
  });
  global.window = originalWindow;
  if (originalSharedArrayBuffer) {
    global.SharedArrayBuffer = originalSharedArrayBuffer;
  } else {
    delete (global as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  }
  Object.defineProperty(global, "crossOriginIsolated", {
    value: originalCrossOriginIsolated,
    configurable: true,
  });
});

describe("webFallbackStore", () => {
  test("is enabled when web SQLite cannot use SharedArrayBuffer", () => {
    expect(isWebFallbackStorageEnabled()).toBe(true);
  });

  test("upserts and lists rows while keeping tables separate", async () => {
    await webFallbackStore.users.upsert([user]);
    await webFallbackStore.accounts.upsert([account]);
    await webFallbackStore.transactions.upsert([transaction]);

    await expect(webFallbackStore.users.list()).resolves.toEqual([user]);
    await expect(webFallbackStore.accounts.list()).resolves.toEqual([account]);
    await expect(webFallbackStore.transactions.list()).resolves.toEqual([transaction]);
  });

  test("upsert replaces rows by id", async () => {
    await webFallbackStore.accounts.upsert([account]);
    await webFallbackStore.accounts.upsert([{ ...account, name: "Updated", currentBalance: 250 }]);

    await expect(webFallbackStore.accounts.list()).resolves.toEqual([
      expect.objectContaining({ id: "account-1", name: "Updated", currentBalance: 250 }),
    ]);
  });

  test("deleteById and deleteWhere remove only matching rows", async () => {
    await webFallbackStore.transactions.upsert([
      transaction,
      { ...transaction, id: "transaction-2", categoryId: "Rent", amount: -900 },
      { ...transaction, id: "transaction-3", categoryId: "Food", amount: -15 },
    ]);

    await webFallbackStore.transactions.deleteById("transaction-2");
    await webFallbackStore.transactions.deleteWhere((row) => row.categoryId === "Food");

    await expect(webFallbackStore.transactions.list()).resolves.toEqual([]);
  });

  test("corrupt localStorage resets to an empty state", async () => {
    localStorageBacking.set("standalone-finance.web-fallback-store.v1", "{not-json");

    await expect(webFallbackStore.accounts.list()).resolves.toEqual([]);
    await webFallbackStore.accounts.upsert([account]);
    await expect(webFallbackStore.accounts.list()).resolves.toEqual([account]);
  });

  test("is disabled on native even when React Native provides a window global", async () => {
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    global.window = {} as Window & typeof globalThis;

    expect(isWebFallbackStorageEnabled()).toBe(false);
    await expect(webFallbackStore.accounts.list()).resolves.toEqual([]);
    await expect(webFallbackStore.accounts.upsert([account])).resolves.toBeUndefined();
  });
});
