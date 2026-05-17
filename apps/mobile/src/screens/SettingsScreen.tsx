import React, { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Chip, HelperText, List, SegmentedButtons, Text, TextInput } from "react-native-paper";

import type { AppColorTheme, BankConnectionReturn } from "../../App";
import { Screen } from "../components/Screen";
import { SectionTitle } from "../components/SectionTitle";
import { StateCard } from "../components/StateCard";
import type { Country, Currency } from "../data/types";
import {
  buildTinkSandboxLink,
  clearTinkBridgeTokens,
  getTinkBridgeMissingConfig,
  getTinkBridgeTokens,
  isTinkBridgeConfigured,
  refreshTinkBridgeTokens,
  type TinkBridgeTokens
} from "../integrations/tinkBridge";
import { syncTinkToSQLite, type TinkMobileSyncResult } from "../integrations/tinkMobileSync";
import { useFinance } from "../state/FinanceContext";
import { sqliteFinanceQueryKeys } from "../state/FinanceContext";
import { useFinanceTheme, type FinanceTheme } from "../theme";

type SettingsScreenProps = {
  bankConnectionReturn?: BankConnectionReturn | null;
  colorTheme: AppColorTheme;
  onBankConnectionReturnHandled?: () => void;
  onColorThemeChange: (colorTheme: AppColorTheme) => void;
};

const currencyButtons = [
  { label: "EUR", value: "EUR" },
  { label: "HUF", value: "HUF" },
  { label: "USD", value: "USD" },
  { label: "GBP", value: "GBP" }
];

const countryButtons = [
  { label: "Hungary", value: "HU" },
  { label: "France", value: "FR" }
];

const colorThemeButtons = [
  { label: "Brown", value: "brown" },
  { label: "Blue", value: "blue" },
  { label: "Pink", value: "pink" }
];

const localeForCountry: Record<Country, string> = {
  HU: "hu-HU",
  FR: "fr-FR"
};

export function SettingsScreen({
  bankConnectionReturn,
  colorTheme,
  onBankConnectionReturnHandled,
  onColorThemeChange
}: SettingsScreenProps) {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const { addCategory, archiveCategory, categories, clearError, error, isPersisted, settings, updateSettings } = useFinance();
  const [country, setCountry] = useState<Country>(settings.country);
  const [baseCurrency, setBaseCurrency] = useState<Currency>(settings.baseCurrency);
  const [locale, setLocale] = useState(settings.locale);
  const [categoryName, setCategoryName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  const hasChanges =
    country !== settings.country || baseCurrency !== settings.baseCurrency;
  const normalizedCategoryName = categoryName.trim().replace(/\s+/g, " ");
  const categoryExists = categories.some(
    (category) => category.name.toLowerCase() === normalizedCategoryName.toLowerCase()
  );

  useEffect(() => {
    setCountry(settings.country);
    setBaseCurrency(settings.baseCurrency);
    setLocale(settings.locale);
  }, [settings]);

  return (
    <Screen>
      {error ? <StateCard title="Settings action failed" detail={error} tone="error" /> : null}

      <SectionTitle title="Settings" action={isPersisted ? "Cloud sync" : "Local"} />
      <Card mode="contained" style={styles.card}>
        <Card.Content style={styles.content}>
          <View>
            <Text variant="labelLarge">Color theme</Text>
            <SegmentedButtons
              buttons={colorThemeButtons}
              onValueChange={(value) => onColorThemeChange(value as AppColorTheme)}
              value={colorTheme}
            />
          </View>

          <View>
            <Text variant="labelLarge">Country</Text>
            <SegmentedButtons
              buttons={countryButtons}
              onValueChange={(value) => {
                clearError();
                const nextCountry = value as Country;
                setCountry(nextCountry);
                setLocale(localeForCountry[nextCountry]);
              }}
              value={country}
            />
          </View>

          <View>
            <Text variant="labelLarge">Base currency</Text>
            <SegmentedButtons
              buttons={currencyButtons}
              onValueChange={(value) => {
                clearError();
                setBaseCurrency(value as Currency);
              }}
              value={baseCurrency}
            />
          </View>

          <View>
            <TextInput
              disabled
              editable={false}
              label="Locale"
              mode="outlined"
              value={locale}
            />
            <HelperText type="info" visible>
              Implied by country. Used for dates, currencies, and regional formatting.
            </HelperText>
          </View>

          <Button
            disabled={!hasChanges || isSaving}
            loading={isSaving}
            mode="contained"
            onPress={async () => {
              setIsSaving(true);
              try {
                await updateSettings({ country, baseCurrency, locale: locale.trim() });
              } finally {
                setIsSaving(false);
              }
            }}
          >
            Save settings
          </Button>
        </Card.Content>
      </Card>

      {isPersisted ? (
        <AuthenticatedBankConnectionSection
          bankConnectionReturn={bankConnectionReturn}
          onBankConnectionReturnHandled={onBankConnectionReturnHandled}
        />
      ) : (
        <LocalBankConnectionSection />
      )}

      <SectionTitle title="Categories" action={`${categories.length} active`} />
      <Card mode="contained" style={styles.card}>
        <Card.Content style={styles.content}>
          <View style={styles.categoryInputRow}>
            <TextInput
              label="New category"
              mode="outlined"
              onChangeText={(value) => {
                clearError();
                setCategoryName(value);
              }}
              style={styles.categoryInput}
              value={categoryName}
            />
            <Button
              disabled={normalizedCategoryName.length === 0 || categoryExists || isSavingCategory}
              loading={isSavingCategory}
              mode="contained"
              onPress={async () => {
                setIsSavingCategory(true);
                try {
                  await addCategory(normalizedCategoryName);
                  setCategoryName("");
                } finally {
                  setIsSavingCategory(false);
                }
              }}
            >
              Add
            </Button>
          </View>
          <HelperText type={categoryExists ? "error" : "info"} visible>
            {categoryExists ? "That category already exists." : "New categories appear in manual entries, edits, and CSV mapping."}
          </HelperText>
          <View style={styles.categoryGrid}>
            {categories.map((category) => (
              <Chip
                key={category.id}
                compact
                icon={category.isDefault ? "lock-outline" : "tag-outline"}
                onClose={category.isDefault ? undefined : () => archiveCategory(category.name)}
              >
                {category.name}
              </Chip>
            ))}
          </View>
        </Card.Content>
      </Card>

    </Screen>
  );
}

function AuthenticatedBankConnectionSection({
  bankConnectionReturn,
  onBankConnectionReturnHandled
}: {
  bankConnectionReturn?: BankConnectionReturn | null;
  onBankConnectionReturnHandled?: () => void;
}) {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const bankConnection = useBankConnection(true, bankConnectionReturn, onBankConnectionReturnHandled);

  return (
    <>
      <SectionTitle title="Bank Connection" action={bankConnection.statusLabel} />
      <Card mode="contained" style={styles.card}>
        <Card.Content style={styles.content}>
          <List.Item
            title="Tink bank aggregation"
            description={bankConnection.detail}
            left={(props) => <List.Icon {...props} icon={bankConnection.icon} />}
          />
          {bankConnection.needsReconnect ? (
            <StateCard
              title="Reconnect required"
              detail={
                bankConnection.reconnectReason ??
                "Tink credentials need to be re-authorized to keep syncing."
              }
              tone="warning"
            />
          ) : null}
          {bankConnection.error ? (
            <StateCard title="Bank connection action failed" detail={bankConnection.error} tone="error" />
          ) : null}
          {bankConnection.tokens ? (
            <Chip compact icon="shield-key-outline">
              {formatTinkBridgeTokenChip(bankConnection.tokens)}
            </Chip>
          ) : null}
          <View style={styles.actionRow}>
            <Button
              disabled={bankConnection.isBusy}
              icon={
                bankConnection.needsReconnect
                  ? "alert"
                  : bankConnection.isConnected
                    ? "refresh"
                    : "bank-plus"
              }
              loading={bankConnection.action === "connect"}
              mode={
                bankConnection.needsReconnect || !bankConnection.isConnected
                  ? "contained"
                  : "outlined"
              }
              onPress={bankConnection.connect}
            >
              {bankConnection.needsReconnect
                ? "Reconnect now"
                : bankConnection.isConnected
                  ? "Reconnect"
                  : "Connect"}
            </Button>
            <Button
              disabled={
                !bankConnection.isConnected ||
                bankConnection.needsReconnect ||
                bankConnection.isBusy
              }
              icon="sync"
              loading={bankConnection.action === "sync"}
              mode="contained"
              onPress={bankConnection.sync}
            >
              Sync
            </Button>
            <Button
              disabled={
                !bankConnection.isConnected ||
                bankConnection.needsReconnect ||
                bankConnection.isBusy
              }
              icon="cloud-refresh"
              loading={bankConnection.action === "refreshCredentials"}
              mode="outlined"
              onPress={() => bankConnection.refreshCredentials()}
            >
              Refresh token
            </Button>
            <Button
              disabled={bankConnection.isBusy}
              icon="refresh"
              loading={bankConnection.action === "refresh"}
              mode="outlined"
              onPress={bankConnection.refresh}
            >
              Status
            </Button>
            <Button
              disabled={!bankConnection.isConnected || bankConnection.isBusy}
              icon="link-off"
              loading={bankConnection.action === "disconnect"}
              mode="outlined"
              onPress={bankConnection.disconnect}
            >
              Disconnect
            </Button>
          </View>
        </Card.Content>
      </Card>
    </>
  );
}

function LocalBankConnectionSection() {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);

  return (
    <>
      <SectionTitle title="Bank Connection" action="Local mode" />
      <Card mode="contained" style={styles.card}>
        <List.Item
          title="Tink bank aggregation"
          description="Bank connection is available when cloud sync is enabled."
          left={(props) => <List.Icon {...props} icon="bank-outline" />}
        />
      </Card>
    </>
  );
}

type BankAction =
  | "connect"
  | "sync"
  | "refresh"
  | "refreshCredentials"
  | "extendConsent"
  | "disconnect"
  | null;

type TinkRefreshCredentialsResponse = {
  provider: "tink";
  credentialsId: string;
  method: "server_refresh" | "link";
  errorCode?: string;
  url?: string;
};

type TinkStatusResponse = {
  connected: boolean;
  status: string;
  lastSyncedAt?: number;
  lastSyncStatus?: string;
  lastError?: string;
};

type TinkSyncResponse = {
  accounts: {
    fetchedCount: number;
    importedCount: number;
    skippedCount: number;
    createdCount: number;
    updatedCount: number;
  };
  transactions: {
    fetchedCount: number;
    preparedCount: number;
    skippedBeforeImportCount: number;
    importedCount: number;
    skippedDuringImportCount: number;
  };
};

function useBankConnection(
  isPersisted: boolean,
  bankConnectionReturn?: BankConnectionReturn | null,
  onBankConnectionReturnHandled?: () => void
) {
  const queryClient = useQueryClient();
  const tinkSync = useMutation({
    mutationFn: syncTinkToSQLite,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: sqliteFinanceQueryKeys.root });
      setStatusLabel("Synced to SQLite");
      setDetail(formatMobileSyncResult(result));
    }
  });
  const [statusLabel, setStatusLabel] = useState("Ready");
  const [detail, setDetail] = useState("Connect a sandbox bank through Tink. Tokens will be stored on this device.");
  const [action, setAction] = useState<BankAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [reconnectReason, setReconnectReason] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TinkBridgeTokens | null>(null);
  const isConfigured = isTinkBridgeConfigured();
  const run = React.useCallback(
    async (nextAction: BankAction, task: () => Promise<void>) => {
      setAction(nextAction);
      setError(null);

      try {
        await task();
      } catch (caught) {
        console.error("[BankConnection] action failed", nextAction, caught);
        setError(caught instanceof Error ? caught.message : "Bank connection action failed.");
      } finally {
        setAction(null);
      }
    },
    []
  );

  const loadStatus = React.useCallback(async () => {
    const stored = await getTinkBridgeTokens();
    setTokens(stored);
    setNeedsReconnect(false);
    setReconnectReason(null);
    setIsConnected(Boolean(stored));
    setStatusLabel(stored ? "Sandbox token stored" : "Ready");

    if (stored) {
      setError(null);
      setDetail(formatTinkBridgeTokenDetail(stored));
      return;
    }

    if (!isConfigured) {
      setDetail(`Set ${getTinkBridgeMissingConfig().join(", ")} in .env.local.`);
      return;
    }

    setDetail("Connect a sandbox bank through Tink. Tokens will be stored on this device.");
  }, [isConfigured]);

  React.useEffect(() => {
    if (!isPersisted) {
      return;
    }

    void loadStatus().catch(() => undefined);
  }, [isPersisted, loadStatus]);

  React.useEffect(() => {
    if (!bankConnectionReturn) {
      return;
    }

    if (bankConnectionReturn.status === "authorized") {
      setError(null);
      setStatusLabel("Syncing to SQLite");
      setIsConnected(true);
      setDetail(
        bankConnectionReturn.source === "bridge"
          ? "Tink sandbox authorization completed. Importing accounts and posted transactions now."
          : "Tink authorization completed. Importing accounts and posted transactions now."
      );
      void run("sync", async () => {
        await loadStatus();
        const result = await tinkSync.mutateAsync();
        setStatusLabel("Synced to SQLite");
        setDetail(formatMobileSyncResult(result));
      });
    } else {
      setStatusLabel("Authorization failed");
      setError(bankConnectionReturn.message ?? "Tink authorization failed.");
      void loadStatus().catch(() => undefined);
    }

    onBankConnectionReturnHandled?.();
  }, [bankConnectionReturn, loadStatus, onBankConnectionReturnHandled, run, tinkSync]);

  const refresh = React.useCallback(() => {
    void run("refresh", loadStatus);
  }, [loadStatus, run]);

  return {
    action,
    error: !isConfigured && isPersisted ? `Set ${getTinkBridgeMissingConfig().join(", ")} in .env.local.` : error,
    icon: needsReconnect ? "bank-remove" : isConnected ? "bank-check" : "bank-outline",
    isBusy: action !== null,
    isConnected,
    needsReconnect,
    reconnectReason,
    statusLabel: isConfigured ? statusLabel : "Not configured",
    detail: getBankConnectionDetail(detail, isPersisted, isConfigured),
    tokens,
    refresh,
    connect: () =>
      run("connect", async () => {
        const url = await buildTinkSandboxLink();
        setStatusLabel("Authorization started");
        setIsConnected(false);
        await Linking.openURL(url);
      }),
    sync: () =>
      run("sync", async () => {
        const result = await tinkSync.mutateAsync();
        setStatusLabel("Synced to SQLite");
        setDetail(formatMobileSyncResult(result));
      }),
    disconnect: () =>
      run("disconnect", async () => {
        await clearTinkBridgeTokens();
        setTokens(null);
        setIsConnected(false);
        setNeedsReconnect(false);
        setReconnectReason(null);
        setStatusLabel("Disconnected locally");
        setDetail("Stored Tink sandbox tokens were removed from this device.");
      }),
    refreshCredentials: () =>
      run("refreshCredentials", async () => {
        const next = await refreshTinkBridgeTokens();
        setTokens(next);
        setIsConnected(true);
        setStatusLabel("Token refreshed");
        setDetail(formatTinkBridgeTokenDetail(next));
        const response: { method: "server_refresh" | "link"; url?: string; errorCode?: string } = {
          method: "server_refresh"
        };

        if (response.method === "link" && response.url) {
          setStatusLabel("Re-authorization required");
          setDetail(
            response.errorCode
              ? `Tink needs you to re-authorize (${response.errorCode}). Opening secure flow…`
              : "Tink needs you to re-authorize. Opening secure flow…"
          );
          await Linking.openURL(response.url);
          return;
        }

        setStatusLabel("Token refreshed");
        setDetail(
          formatTinkBridgeTokenDetail(next)
        );
      }),
    extendConsent: () =>
      run("extendConsent", async () => {
        const url = await buildTinkSandboxLink();
        await Linking.openURL(url);
      })
  };
}

function formatSyncResult(result: TinkSyncResponse) {
  const accountChangeCount = result.accounts.createdCount + result.accounts.updatedCount;
  const transactionSkippedCount =
    result.transactions.skippedBeforeImportCount + result.transactions.skippedDuringImportCount;

  return [
    `Sync complete ${new Date().toLocaleString()}.`,
    `${accountChangeCount} account ${accountChangeCount === 1 ? "change" : "changes"} (${result.accounts.createdCount} new, ${result.accounts.updatedCount} updated, ${result.accounts.skippedCount} skipped).`,
    `${result.transactions.importedCount} transaction${result.transactions.importedCount === 1 ? "" : "s"} imported (${result.transactions.fetchedCount} fetched, ${transactionSkippedCount} skipped).`
  ].join(" ");
}

function formatMobileSyncResult(result: TinkMobileSyncResult) {
  const skipReasonSummary = formatSkipReasons(result.transactions.skipReasons);
  return [
    `Sync complete ${new Date().toLocaleString()}.`,
    `${result.accounts.importedCount} account${result.accounts.importedCount === 1 ? "" : "s"} written to SQLite (${result.accounts.fetchedCount} fetched, ${result.accounts.skippedCount} skipped).`,
    `${result.transactions.importedCount} transaction${result.transactions.importedCount === 1 ? "" : "s"} written to SQLite (${result.transactions.fetchedCount} fetched, ${result.transactions.skippedCount} skipped).${skipReasonSummary}`
  ].join(" ");
}

function formatSkipReasons(skipReasons: Record<string, number>) {
  const entries = Object.entries(skipReasons);
  if (entries.length === 0) {
    return "";
  }
  return ` Skipped because ${entries.map(([reason, count]) => `${reason} (${count})`).join(", ")}.`;
}

function formatTinkBridgeTokenChip(tokens: TinkBridgeTokens) {
  const receivedAt = new Date(tokens.receivedAt).toLocaleTimeString();
  return tokens.refreshToken ? `Sandbox token stored ${receivedAt}` : `Access token stored ${receivedAt}`;
}

function formatTinkBridgeTokenDetail(tokens: TinkBridgeTokens) {
  const receivedAt = new Date(tokens.receivedAt).toLocaleString();
  const expiry = tokens.expiresIn
    ? ` Access token expires in about ${Math.round(tokens.expiresIn / 60)} minutes.`
    : "";
  const refresh = tokens.refreshToken
    ? " Refresh is available through the Cloudflare bridge."
    : " No refresh token was returned.";
  return `Tink sandbox token stored on this device at ${receivedAt}.${expiry}${refresh}`;
}

function getBankConnectionDetail(
  detail: string,
  isPersisted: boolean,
  isConfigured: boolean
) {
  if (!isPersisted) {
    return "Bank connection is available when cloud sync is enabled.";
  }

  if (!isConfigured) {
    return `Set ${getTinkBridgeMissingConfig().join(", ")} to enable the Tink sandbox bridge.`;
  }

  return detail;
}

function createStyles(theme: FinanceTheme) {
  return StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg
  },
  content: {
    gap: theme.spacing.md
  },
  categoryInputRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm
  },
  categoryInput: {
    flex: 1
  },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm
  }
});
}
