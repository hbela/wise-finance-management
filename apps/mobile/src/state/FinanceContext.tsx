import React, { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { eq } from "drizzle-orm";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { defaultCategories } from "../data/categories";
import type { Account, Category, Country, Currency, ImportBatch, Liability, Transaction, TransactionType } from "../data/types";
import { ensureMirrorDatabaseReady } from "../db/client";
import type { AccountRow, CategoryRow, ImportBatchRow, LiabilityRow, TransactionRow, UserRow } from "../db/mappers";
import { isWebFallbackStorageEnabled, webFallbackStore } from "../db/webFallbackStore";
import {
  accountsRepo,
  categoriesRepo,
  importBatchesRepo,
  liabilitiesRepo,
  transactionsRepo,
  usersRepo
} from "../db/repositories";
import * as schema from "../db/schema";
import {
  buildStaticSnapshot,
  ensureFxSnapshot,
  FX_CACHE_TTL_MS,
  type FxSnapshot,
  normalizeFxCurrency,
  toBaseCurrencyAmount
} from "../services/fxRates";
import { runSQLitePFMDetection } from "../services/sqlitePfm";
import {
  arePotentialDuplicateTransactions,
  createTransactionDedupeHash,
  type DedupeTransaction,
  type ParsedCsvTransaction
} from "../utils/csvImport";
import { toBaseCurrency } from "../utils/finance";

export type NewAccountInput = {
  name: string;
  source: Account["source"];
  currency: Currency;
  type: Account["type"];
  currentBalance: number;
  bankId?: string;
};

export type UpdateAccountInput = NewAccountInput & {
  id: string;
};

export type NewTransactionInput = {
  accountId: string;
  amount: number;
  description: string;
  merchant: string;
  category: string;
  type: TransactionType;
  postedAt: string;
  isRecurring: boolean;
};

export type NewLiabilityInput = {
  name: string;
  institution: string;
  type: Liability["type"];
  currency: Currency;
  originalPrincipal: number;
  outstandingBalance: number;
  interestRate: number;
  paymentAmount: number;
  nextDueDate: string;
  rateType: Liability["rateType"];
};

export type UpdateLiabilityInput = NewLiabilityInput & {
  id: string;
  paymentFrequency: Liability["paymentFrequency"];
};

export type UpdateTransactionInput = {
  id: string;
  category: string;
  type: TransactionType;
  merchant: string;
  description: string;
  notes?: string;
  isRecurring: boolean;
  isExcludedFromReports: boolean;
  transferMatchId?: string | null;
};

type FinanceContextValue = {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  liabilities: Liability[];
  importBatches: ImportBatch[];
  settings: {
    country: Country;
    baseCurrency: Currency;
    locale: string;
  };
  isPersisted: boolean;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  addAccount: (input: NewAccountInput) => Promise<void>;
  updateAccount: (input: UpdateAccountInput) => Promise<void>;
  archiveAccount: (accountId: string) => Promise<void>;
  addCategory: (name: string) => Promise<void>;
  archiveCategory: (name: string) => Promise<void>;
  addTransaction: (input: NewTransactionInput) => Promise<void>;
  importTransactions: (
    accountId: string,
    rows: ParsedCsvTransaction[],
    metadata?: {
      rowCount: number;
      columnMapping: Record<string, string>;
      dateFormat: string;
      sourceName?: string;
    }
  ) => Promise<{ imported: number; skipped: number; batchId?: string }>;
  updateTransaction: (input: UpdateTransactionInput) => Promise<void>;
  archiveTransaction: (transactionId: string) => Promise<void>;
  revertImportBatch: (importBatchId: string) => Promise<void>;
  addLiability: (input: NewLiabilityInput) => Promise<void>;
  addSampleLiabilities: () => Promise<void>;
  updateLiability: (input: UpdateLiabilityInput) => Promise<void>;
  archiveLiability: (liabilityId: string) => Promise<void>;
  updateSettings: (input: { country: Country; baseCurrency: Currency; locale: string }) => Promise<void>;
};

const FinanceContext = createContext<FinanceContextValue | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  return <SQLiteFinanceProvider>{children}</SQLiteFinanceProvider>;
}


function SQLiteFinanceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.accounts,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.accounts.list()
        : accountsRepo.list(await ensureMirrorDatabaseReady())
  });
  const categoriesQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.categories,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.categories.list()
        : categoriesRepo.list(await ensureMirrorDatabaseReady())
  });
  const transactionsQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.transactions,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.transactions.list()
        : transactionsRepo.list(await ensureMirrorDatabaseReady())
  });
  const liabilitiesQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.liabilities,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.liabilities.list()
        : liabilitiesRepo.list(await ensureMirrorDatabaseReady())
  });
  const importBatchesQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.importBatches,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.importBatches.list()
        : importBatchesRepo.list(await ensureMirrorDatabaseReady())
  });
  const usersQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.users,
    queryFn: async () =>
      isWebFallbackStorageEnabled()
        ? webFallbackStore.users.list()
        : usersRepo.list(await ensureMirrorDatabaseReady())
  });
  const [error, setError] = useState<string | null>(null);
  const settings = useMemo(() => {
    const row = (usersQuery.data ?? []).find((candidate) => candidate.id === localSQLiteUserId);
    return rowToSettings(row);
  }, [usersQuery.data]);
  const isLoading =
    accountsQuery.isLoading ||
    categoriesQuery.isLoading ||
    transactionsQuery.isLoading ||
    liabilitiesQuery.isLoading ||
    importBatchesQuery.isLoading ||
    usersQuery.isLoading;

  const accounts = useMemo<Account[]>(
    () =>
      (accountsQuery.data ?? [])
        .filter((account) => !account.archivedAt)
        .map(accountRowToAccount),
    [accountsQuery.data]
  );

  const transactions = useMemo<Transaction[]>(
    () =>
      (transactionsQuery.data ?? [])
        .filter((transaction) => !transaction.archivedAt)
        .map(transactionRowToTransaction)
        .sort((left, right) => right.postedAt.localeCompare(left.postedAt)),
    [transactionsQuery.data]
  );

  const categories = useMemo<Category[]>(
    () => mergeDefaultAndSQLiteCategories(categoriesQuery.data ?? []),
    [categoriesQuery.data]
  );

  const liabilities = useMemo<Liability[]>(
    () =>
      (liabilitiesQuery.data ?? [])
        .filter((liability) => !liability.archivedAt)
        .map(liabilityRowToLiability)
        .sort((left, right) => left.nextDueDate.localeCompare(right.nextDueDate)),
    [liabilitiesQuery.data]
  );

  const importBatches = useMemo<ImportBatch[]>(
    () =>
      (importBatchesQuery.data ?? [])
        .map(importBatchRowToImportBatch)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [importBatchesQuery.data]
  );

  const refreshSQLiteQueries = React.useCallback(
    async () => {
      await queryClient.invalidateQueries({ queryKey: sqliteFinanceQueryKeys.root });
    },
    [queryClient]
  );

  const value = useMemo<FinanceContextValue>(
    () => ({
      accounts,
      categories,
      transactions,
      liabilities,
      importBatches,
      settings,
      isPersisted: true,
      isLoading,
      error,
      clearError: () => setError(null),
      addAccount: async (input) => {
        await runMutation(setError, async () => {
          const now = Date.now();
          const row: AccountRow = {
            id: `account-${now}`,
            userId: localSQLiteUserId,
            source: input.source,
            bankId: input.bankId ?? null,
            bankKey: input.bankId ?? null,
            providerAccountId: null,
            credentialsId: null,
            name: input.name,
            currency: input.currency,
            type: input.type,
            currentBalance: input.currentBalance,
            availableBalance: null,
            institutionName: null,
            holderName: null,
            iban: null,
            bban: null,
            lastSyncedAt: now,
            archivedAt: null,
            createdAt: now,
            updatedAt: now
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.accounts.upsert([row]);
          } else {
            await accountsRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await refreshSQLiteQueries();
        });
      },
      updateAccount: async (input) => {
        await runMutation(setError, async () => {
          const current = accountsQuery.data?.find((account) => account.id === input.id);
          const now = Date.now();
          const row: AccountRow = {
            id: input.id,
            userId: current?.userId ?? localSQLiteUserId,
            source: input.source,
            bankId: input.bankId ?? current?.bankId ?? null,
            bankKey: input.bankId ?? current?.bankKey ?? null,
            providerAccountId: current?.providerAccountId ?? null,
            credentialsId: current?.credentialsId ?? null,
            name: input.name,
            currency: input.currency,
            type: input.type,
            currentBalance: input.currentBalance,
            availableBalance: current?.availableBalance ?? null,
            institutionName: current?.institutionName ?? null,
            holderName: current?.holderName ?? null,
            iban: current?.iban ?? null,
            bban: current?.bban ?? null,
            lastSyncedAt: current?.lastSyncedAt ?? null,
            archivedAt: current?.archivedAt ?? null,
            createdAt: current?.createdAt ?? now,
            updatedAt: now
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.accounts.upsert([row]);
          } else {
            await accountsRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await refreshSQLiteQueries();
        });
      },
      archiveAccount: async (accountId) => {
        await runMutation(setError, async () => {
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.transactions.deleteWhere((row) => row.accountId === accountId);
            await webFallbackStore.accounts.deleteById(accountId);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await db.delete(schema.transactions).where(eq(schema.transactions.accountId, accountId));
            await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
          }
          await refreshSQLiteQueries();
        });
      },
      addCategory: async (name) => {
        const normalizedName = name.trim().replace(/\s+/g, " ");
        if (!normalizedName) return;
        await runMutation(setError, async () => {
          const now = Date.now();
          const row: CategoryRow = {
            id: `category-${normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            userId: localSQLiteUserId,
            name: normalizedName,
            tinkCategoryCode: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.categories.upsert([row]);
          } else {
            await categoriesRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await refreshSQLiteQueries();
        });
      },
      archiveCategory: async (name) => {
        await runMutation(setError, async () => {
          const row = categoriesQuery.data?.find((category) => category.name === name);
          if (!row) return;
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.categories.deleteById(row.id);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await db.delete(schema.categories).where(eq(schema.categories.id, row.id));
          }
          await refreshSQLiteQueries();
        });
      },
      addTransaction: async (input) => {
        const account = accounts.find((candidate) => candidate.id === input.accountId);
        if (!account) {
          return;
        }

        const signedAmount = normalizeAmount(input.amount, input.type);
        await runMutation(setError, async () => {
          const now = Date.now();
          const useFallback = isWebFallbackStorageEnabled();
          const fxSnapshot = useFallback
            ? buildStaticSnapshot("EUR", now)
            : await ensureFxSnapshot(await ensureMirrorDatabaseReady(), "EUR", now);
          const row: TransactionRow = {
            id: `transaction-${now}`,
            userId: localSQLiteUserId,
            accountId: account.id,
            source: account.source,
            providerTransactionId: null,
            postedAt: Date.parse(input.postedAt),
            amount: signedAmount,
            currency: account.currency,
            baseCurrencyAmount: toBaseCurrencyAmount(signedAmount, account.currency, fxSnapshot),
            description: input.description,
            merchant: input.merchant,
            categoryId: input.category,
            tinkCategoryCode: null,
            importBatchId: null,
            type: input.type,
            isRecurring: input.isRecurring,
            recurringGroupId: null,
            isExcludedFromReports: input.type === "transfer",
            transferMatchId: null,
            dedupeHash: createTransactionDedupeHash({
              accountId: account.id,
              postedAt: input.postedAt,
              amount: signedAmount,
              currency: account.currency,
              description: input.description,
              merchant: input.merchant
            }),
            status: "booked",
            notes: null,
            archivedAt: null,
            createdAt: now,
            updatedAt: now
          };
          if (useFallback) {
            await webFallbackStore.transactions.upsert([row]);
          } else {
            await transactionsRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await runSQLitePFMDetection();
          await refreshSQLiteQueries();
        });
      },
      importTransactions: async (accountId, rows, metadata) => {
        const account = accounts.find((candidate) => candidate.id === accountId);
        if (!account) {
          return { imported: 0, skipped: rows.length };
        }

        return await runMutation(setError, async () => {
          const now = Date.now();
          const batchId = `import-${now}`;
          const useFallback = isWebFallbackStorageEnabled();
          const fxSnapshot = useFallback
            ? buildStaticSnapshot("EUR", now)
            : await ensureFxSnapshot(await ensureMirrorDatabaseReady(), "EUR", now);
          const batchRow: ImportBatchRow = {
            id: batchId,
            userId: localSQLiteUserId,
            accountId: account.id,
            source: "csv",
            status: "completed",
            sourceName: metadata?.sourceName ?? null,
            rowCount: metadata?.rowCount ?? rows.length,
            importedCount: rows.length,
            skippedCount: 0,
            columnMapping: JSON.stringify(metadata?.columnMapping ?? {}),
            dateFormat: metadata?.dateFormat ?? "auto",
            createdAt: now,
            updatedAt: now
          };
          const transactionRows: TransactionRow[] = rows.map((row, index) => ({
            id: `transaction-${now}-${index}`,
            userId: localSQLiteUserId,
            accountId: account.id,
            source: account.source,
            providerTransactionId: null,
            postedAt: Date.parse(row.postedAt),
            amount: row.amount,
            currency: row.currency,
            baseCurrencyAmount: toBaseCurrencyAmount(row.amount, row.currency, fxSnapshot),
            description: row.description,
            merchant: row.merchant,
            categoryId: row.category,
            tinkCategoryCode: null,
            importBatchId: batchId,
            type: row.type,
            isRecurring: false,
            recurringGroupId: null,
            isExcludedFromReports: row.type === "transfer",
            transferMatchId: null,
            dedupeHash: row.dedupeHash,
            status: "booked",
            notes: "Imported from CSV",
            archivedAt: null,
            createdAt: now,
            updatedAt: now
          }));
          if (useFallback) {
            await webFallbackStore.importBatches.upsert([batchRow]);
            await webFallbackStore.transactions.upsert(transactionRows);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await importBatchesRepo.upsert(db, [batchRow]);
            await transactionsRepo.upsert(db, transactionRows);
          }
          await runSQLitePFMDetection();
          await refreshSQLiteQueries();
          return { imported: rows.length, skipped: 0, batchId };
        });
      },
      updateTransaction: async (input) => {
        await runMutation(setError, async () => {
          const current = transactionsQuery.data?.find((transaction) => transaction.id === input.id);
          if (!current) return;
          const row: TransactionRow = {
            ...current,
            categoryId: input.transferMatchId ? "Internal transfer" : input.category,
            type: input.transferMatchId ? "transfer" : input.type,
            merchant: input.merchant,
            description: input.description,
            notes: input.notes ?? null,
            isRecurring: input.isRecurring,
            isExcludedFromReports: input.transferMatchId ? true : input.isExcludedFromReports,
            transferMatchId: input.transferMatchId ?? null,
            updatedAt: Date.now()
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.transactions.upsert([row]);
          } else {
            await transactionsRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await runSQLitePFMDetection();
          await refreshSQLiteQueries();
        });
      },
      archiveTransaction: async (transactionId) => {
        await runMutation(setError, async () => {
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.transactions.deleteById(transactionId);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await db.delete(schema.transactions).where(eq(schema.transactions.id, transactionId));
          }
          await runSQLitePFMDetection();
          await refreshSQLiteQueries();
        });
      },
      revertImportBatch: async (importBatchId) => {
        await runMutation(setError, async () => {
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.transactions.deleteWhere((row) => row.importBatchId === importBatchId);
            await webFallbackStore.importBatches.deleteById(importBatchId);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await db.delete(schema.transactions).where(eq(schema.transactions.importBatchId, importBatchId));
            await db.delete(schema.importBatches).where(eq(schema.importBatches.id, importBatchId));
          }
          await runSQLitePFMDetection();
          await refreshSQLiteQueries();
        });
      },
      addLiability: async (input) => {
        await runMutation(setError, async () => {
          const now = Date.now();
          const row: LiabilityRow = {
            id: `liability-${now}`,
            userId: localSQLiteUserId,
            linkedAccountId: null,
            ...input,
            paymentFrequency: "monthly",
            archivedAt: null,
            createdAt: now,
            updatedAt: now
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.liabilities.upsert([row]);
          } else {
            await liabilitiesRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await refreshSQLiteQueries();
        });
      },
      addSampleLiabilities: async () => {
        await runMutation(setError, async () => {
          const now = Date.now();
          const rows: LiabilityRow[] = sampleLiabilityRows(now);
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.liabilities.upsert(rows);
          } else {
            await liabilitiesRepo.upsert(await ensureMirrorDatabaseReady(), rows);
          }
          await refreshSQLiteQueries();
        });
      },
      updateLiability: async (input) => {
        await runMutation(setError, async () => {
          const current = liabilitiesQuery.data?.find((liability) => liability.id === input.id);
          const row: LiabilityRow = {
            id: input.id,
            userId: current?.userId ?? localSQLiteUserId,
            linkedAccountId: current?.linkedAccountId ?? null,
            name: input.name,
            institution: input.institution,
            type: input.type,
            currency: input.currency,
            originalPrincipal: input.originalPrincipal,
            outstandingBalance: input.outstandingBalance,
            interestRate: input.interestRate,
            paymentAmount: input.paymentAmount,
            paymentFrequency: input.paymentFrequency,
            nextDueDate: input.nextDueDate,
            rateType: input.rateType,
            archivedAt: current?.archivedAt ?? null,
            createdAt: current?.createdAt ?? Date.now(),
            updatedAt: Date.now()
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.liabilities.upsert([row]);
          } else {
            await liabilitiesRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await refreshSQLiteQueries();
        });
      },
      archiveLiability: async (liabilityId) => {
        await runMutation(setError, async () => {
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.liabilities.deleteById(liabilityId);
          } else {
            const db = await ensureMirrorDatabaseReady();
            await db.delete(schema.liabilities).where(eq(schema.liabilities.id, liabilityId));
          }
          await refreshSQLiteQueries();
        });
      },
      updateSettings: async (input) => {
        await runMutation(setError, async () => {
          const now = Date.now();
          const existing = (usersQuery.data ?? []).find((row) => row.id === localSQLiteUserId);
          const row: UserRow = {
            id: localSQLiteUserId,
            clerkUserId: existing?.clerkUserId ?? localSQLiteClerkId,
            country: input.country,
            locale: input.locale,
            baseCurrency: input.baseCurrency,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
          };
          if (isWebFallbackStorageEnabled()) {
            await webFallbackStore.users.upsert([row]);
          } else {
            await usersRepo.upsert(await ensureMirrorDatabaseReady(), [row]);
          }
          await queryClient.invalidateQueries({ queryKey: sqliteFinanceQueryKeys.users });
        });
      }
    }),
    [
      accounts,
      accountsQuery.data,
      categories,
      categoriesQuery.data,
      error,
      importBatches,
      isLoading,
      liabilitiesQuery.data,
      liabilities,
      queryClient,
      refreshSQLiteQueries,
      settings,
      transactions,
      transactionsQuery.data,
      usersQuery.data
    ]
  );

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export const sqliteFinanceQueryKeys = {
  root: ["sqlite-finance"] as const,
  users: ["sqlite-finance", "users"] as const,
  accounts: ["sqlite-finance", "accounts"] as const,
  categories: ["sqlite-finance", "categories"] as const,
  transactions: ["sqlite-finance", "transactions"] as const,
  liabilities: ["sqlite-finance", "liabilities"] as const,
  importBatches: ["sqlite-finance", "import-batches"] as const,
  recurringSubscriptions: ["sqlite-finance", "recurring-subscriptions"] as const,
  incomeStreams: ["sqlite-finance", "income-streams"] as const,
  expenseProfiles: ["sqlite-finance", "expense-profiles"] as const,
  forecast: ["sqlite-finance", "forecast"] as const,
  fxSnapshot: ["sqlite-finance", "fx-snapshot"] as const
};

export function useFxSnapshot(base: Currency): FxSnapshot {
  const placeholder = useMemo<FxSnapshot>(
    () => buildStaticSnapshot(normalizeFxCurrency(base), Date.now()),
    [base]
  );
  const query = useQuery<FxSnapshot>({
    queryKey: [...sqliteFinanceQueryKeys.fxSnapshot, base],
    queryFn: async () => {
      if (isWebFallbackStorageEnabled()) {
        return buildStaticSnapshot(normalizeFxCurrency(base), Date.now());
      }
      return ensureFxSnapshot(await ensureMirrorDatabaseReady(), base, Date.now());
    },
    placeholderData: placeholder,
    staleTime: FX_CACHE_TTL_MS
  });
  return query.data ?? placeholder;
}

const localSQLiteUserId = "device-local-user";
// Legacy column from the Clerk era; the schema still has it NOT NULL. We write a
// sentinel so the row inserts cleanly. Dropping the column is a separate cleanup.
const localSQLiteClerkId = "local";

const DEFAULT_SETTINGS = {
  country: "HU" as Country,
  baseCurrency: "EUR" as Currency,
  locale: "hu-HU"
};

function rowToSettings(row: UserRow | undefined) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    country: row.country as Country,
    baseCurrency: row.baseCurrency as Currency,
    locale: row.locale
  };
}

function accountRowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    source: row.source as Account["source"],
    bankId: row.bankKey ?? row.bankId ?? undefined,
    providerAccountId: row.providerAccountId ?? undefined,
    name: row.name,
    currency: row.currency as Currency,
    type: row.type as Account["type"],
    currentBalance: row.currentBalance,
    lastSyncedAt: row.lastSyncedAt ? formatSyncLabel(row.lastSyncedAt) : undefined
  };
}

function transactionRowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    source: row.source as Account["source"],
    postedAt: new Date(row.postedAt).toISOString().slice(0, 10),
    amount: row.amount,
    currency: row.currency as Currency,
    baseCurrencyAmount: row.baseCurrencyAmount ?? toBaseCurrency(row.amount, row.currency as Currency),
    description: row.description,
    merchant: row.merchant ?? row.description,
    category: row.categoryId ?? "Other",
    type: row.type as TransactionType,
    isRecurring: row.isRecurring,
    isExcludedFromReports: row.isExcludedFromReports,
    transferMatchId: row.transferMatchId ?? undefined,
    dedupeHash: row.dedupeHash,
    status: row.status === "pending" ? "pending" : "booked",
    notes: row.notes ?? undefined
  };
}

function mergeDefaultAndSQLiteCategories(rows: CategoryRow[]): Category[] {
  const archivedNames = new Set(
    rows.filter((row) => row.archivedAt).map((row) => normalizeCategoryName(row.name))
  );
  const custom = rows
    .filter((row) => !row.archivedAt)
    .map((row) => ({
      id: row.id,
      name: row.name,
      isDefault: false
    }));
  const customNames = new Set(custom.map((category) => normalizeCategoryName(category.name)));

  return [
    ...defaultCategories.filter(
      (category) =>
        !archivedNames.has(normalizeCategoryName(category.name)) &&
        !customNames.has(normalizeCategoryName(category.name))
    ),
    ...custom
  ];
}

function liabilityRowToLiability(row: LiabilityRow): Liability {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type as Liability["type"],
    currency: row.currency as Currency,
    originalPrincipal: row.originalPrincipal,
    outstandingBalance: row.outstandingBalance,
    interestRate: row.interestRate,
    paymentAmount: row.paymentAmount,
    paymentFrequency: row.paymentFrequency as Liability["paymentFrequency"],
    nextDueDate: row.nextDueDate,
    rateType: row.rateType as Liability["rateType"]
  };
}

function sampleLiabilityRows(now: number): LiabilityRow[] {
  return [
    {
      id: "sample-liability-personal-loan",
      userId: localSQLiteUserId,
      linkedAccountId: null,
      name: "Sample personal loan",
      institution: "Demo Credit Union",
      type: "personal_loan",
      currency: "EUR",
      originalPrincipal: 7500,
      outstandingBalance: 4320,
      interestRate: 6.2,
      paymentAmount: 185,
      paymentFrequency: "monthly",
      nextDueDate: "2026-05-24",
      rateType: "fixed",
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "sample-liability-mortgage",
      userId: localSQLiteUserId,
      linkedAccountId: null,
      name: "Sample mortgage",
      institution: "OTP Bank",
      type: "mortgage",
      currency: "HUF",
      originalPrincipal: 42000000,
      outstandingBalance: 31750000,
      interestRate: 5.1,
      paymentAmount: 245000,
      paymentFrequency: "monthly",
      nextDueDate: "2026-05-15",
      rateType: "variable",
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    }
  ];
}

function importBatchRowToImportBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    accountId: row.accountId,
    source: "csv",
    status: row.status as ImportBatch["status"],
    sourceName: row.sourceName ?? undefined,
    rowCount: row.rowCount,
    importedCount: row.importedCount,
    skippedCount: row.skippedCount,
    columnMapping: parseJsonRecord(row.columnMapping),
    dateFormat: row.dateFormat,
    createdAt: new Date(row.createdAt).toISOString()
  };
}

function parseJsonRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function useFinance() {
  const value = useContext(FinanceContext);
  if (!value) {
    throw new Error("useFinance must be used inside FinanceProvider");
  }
  return value;
}

function normalizeAmount(amount: number, type: TransactionType) {
  if (["income", "refund"].includes(type)) {
    return Math.abs(amount);
  }
  if (type === "transfer") {
    return amount;
  }
  return -Math.abs(amount);
}

function formatSyncLabel(timestamp: number) {
  return `Synced ${new Date(timestamp).toLocaleDateString()}`;
}

function normalizeCategoryName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function runMutation<T>(setError: (message: string | null) => void, mutation: () => Promise<T>) {
  try {
    setError(null);
    return await mutation();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Finance action failed";
    setError(message);
    throw caught;
  }
}
