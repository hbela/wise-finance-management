import type {
  AccountRow,
  CategoryRow,
  ExpenseProfileRow,
  ImportBatchRow,
  IncomeStreamRow,
  LiabilityRow,
  RecurringSubscriptionRow,
  TransactionRow,
  UserRow,
} from "./mappers";
import { Platform } from "react-native";

const storageKey = "standalone-finance.web-fallback-store.v1";

type WebFallbackState = {
  users: UserRow[];
  accounts: AccountRow[];
  categories: CategoryRow[];
  transactions: TransactionRow[];
  liabilities: LiabilityRow[];
  importBatches: ImportBatchRow[];
  recurringSubscriptions: RecurringSubscriptionRow[];
  incomeStreams: IncomeStreamRow[];
  expenseProfiles: ExpenseProfileRow[];
};

const emptyState: WebFallbackState = {
  users: [],
  accounts: [],
  categories: [],
  transactions: [],
  liabilities: [],
  importBatches: [],
  recurringSubscriptions: [],
  incomeStreams: [],
  expenseProfiles: [],
};

export function isWebFallbackStorageEnabled() {
  // Force localStorage fallback on all web contexts. wa-sqlite's worker times out
  // on this dev setup even when crossOriginIsolated reports true (see error
  // "Sync operation timeout" thrown from openDatabaseSync). Native is unaffected.
  return canUseWebStorage();
}

export const webFallbackStore = {
  users: createCollection("users"),
  accounts: createCollection("accounts"),
  categories: createCollection("categories"),
  transactions: createCollection("transactions"),
  liabilities: createCollection("liabilities"),
  importBatches: createCollection("importBatches"),
  recurringSubscriptions: createCollection("recurringSubscriptions"),
  incomeStreams: createCollection("incomeStreams"),
  expenseProfiles: createCollection("expenseProfiles"),
};

function createCollection<K extends keyof WebFallbackState>(key: K) {
  return {
    list: async () => readState()[key],
    upsert: async (rows: WebFallbackState[K]) => {
      const state = readState();
      const existing = new Map(
        (state[key] as Array<{ id: string }>).map((row) => [row.id, row])
      );
      for (const row of rows as Array<{ id: string }>) {
        existing.set(row.id, row);
      }
      writeState({
        ...state,
        [key]: [...existing.values()],
      });
    },
    deleteById: async (id: string) => {
      const state = readState();
      writeState({
        ...state,
        [key]: (state[key] as Array<{ id: string }>).filter((row) => row.id !== id),
      });
    },
    deleteWhere: async (predicate: (row: WebFallbackState[K][number]) => boolean) => {
      const state = readState();
      writeState({
        ...state,
        [key]: (state[key] as WebFallbackState[K]).filter((row) => !predicate(row)),
      });
    },
  };
}

function readState(): WebFallbackState {
  if (!canUseWebStorage()) {
    return emptyState;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return emptyState;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WebFallbackState>;
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      liabilities: Array.isArray(parsed.liabilities) ? parsed.liabilities : [],
      importBatches: Array.isArray(parsed.importBatches) ? parsed.importBatches : [],
      recurringSubscriptions: Array.isArray(parsed.recurringSubscriptions)
        ? parsed.recurringSubscriptions
        : [],
      incomeStreams: Array.isArray(parsed.incomeStreams) ? parsed.incomeStreams : [],
      expenseProfiles: Array.isArray(parsed.expenseProfiles) ? parsed.expenseProfiles : [],
    };
  } catch {
    return emptyState;
  }
}

function writeState(state: WebFallbackState) {
  if (!canUseWebStorage()) {
    return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

function canUseWebStorage() {
  return (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof window.localStorage?.getItem === "function" &&
    typeof window.localStorage?.setItem === "function"
  );
}
