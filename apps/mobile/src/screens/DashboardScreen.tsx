import React, { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Card, Chip, Divider, List, ProgressBar, Text } from "react-native-paper";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { AddAccountDialog } from "../components/AddAccountDialog";
import { EditAccountDialog } from "../components/EditAccountDialog";
import { MetricCard } from "../components/MetricCard";
import { Screen } from "../components/Screen";
import { SectionTitle } from "../components/SectionTitle";
import { StateCard } from "../components/StateCard";
import type { ExpenseProfileRow, IncomeStreamRow } from "../db/mappers";
import {
  archiveExpenseProfile,
  archiveIncomeStream,
  confirmIncomeStream,
  dismissExpenseProfile,
  dismissIncomeStream,
  getSQLiteBalanceForecast,
  listActiveExpenseProfiles,
  listActiveIncomeStreams,
} from "../services/sqlitePfm";
import type { Account, Alert, Currency, Liability } from "../data/types";
import { sqliteFinanceQueryKeys, useFinance, useFxSnapshot } from "../state/FinanceContext";
import { useFinanceTheme, type FinanceTheme } from "../theme";
import { getAccountBalanceReconciliations, getCurrencyExposure, getDashboardSummary } from "../utils/finance";
import { formatMoney } from "../utils/money";

export function DashboardScreen() {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const [addAccountVisible, setAddAccountVisible] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const { accounts, transactions, liabilities, settings, isLoading, error, clearError } = useFinance();
  const queryClient = useQueryClient();
  const fxSnapshot = useFxSnapshot(settings.baseCurrency);
  const summary = getDashboardSummary(accounts, transactions, liabilities, fxSnapshot);
  const exposure = getCurrencyExposure(accounts, fxSnapshot);
  const reconciliations = getAccountBalanceReconciliations(accounts, transactions);
  const exposureDenominator = Math.max(Math.abs(summary.cash), 1);
  const alerts = useMemo(() => buildLiabilityAlerts(liabilities), [liabilities]);

  const incomeStreamQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.incomeStreams,
    queryFn: () => listActiveIncomeStreams()
  });
  const incomeStreamDocs = incomeStreamQuery.data as IncomeStreamRow[] | undefined;
  const incomeStreams = useMemo(
    () =>
      (incomeStreamDocs ?? [])
        .filter((stream) => !stream.archivedAt && !stream.dismissedAt)
        .sort((left, right) => (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)),
    [incomeStreamDocs]
  );
  const totalEstimatedMonthlyIncome = useMemo(
    () => incomeStreams.reduce((sum, stream) => sum + stream.monthlyAverage, 0),
    [incomeStreams]
  );
  const expenseProfileQuery = useQuery({
    queryKey: sqliteFinanceQueryKeys.expenseProfiles,
    queryFn: () => listActiveExpenseProfiles()
  });
  const expenseProfileDocs = expenseProfileQuery.data as ExpenseProfileRow[] | undefined;
  const expenseProfiles = useMemo(
    () =>
      (expenseProfileDocs ?? [])
        .filter((profile) => !profile.archivedAt && !profile.dismissedAt)
        .sort((left, right) => left.monthlyAverage - right.monthlyAverage),
    [expenseProfileDocs]
  );
  const totalEstimatedMonthlyExpenses = useMemo(
    () => expenseProfiles.reduce((sum, profile) => sum + Math.abs(profile.monthlyAverage), 0),
    [expenseProfiles]
  );
  const forecastQuery = useQuery({
    queryKey: [...sqliteFinanceQueryKeys.forecast, settings.baseCurrency, 30],
    queryFn: () => getSQLiteBalanceForecast({ horizonDays: 30, baseCurrency: settings.baseCurrency })
  });
  const forecast = forecastQuery.data;
  const forecastHasContent = Boolean(
    forecast && (forecast.points.length > 0 || forecast.startingBalance !== 0)
  );
  const forecastDelta = forecast ? forecast.endingBalance - forecast.startingBalance : 0;

  return (
    <Screen>
      {isLoading ? (
        <StateCard title="Loading finance data" detail="Fetching your accounts, ledger, and liabilities from SQLite." loading />
      ) : null}
      {error ? <StateCard title="Finance action failed" detail={error} tone="error" /> : null}
      <Card mode="contained" style={styles.hero}>
        <Card.Content>
          <Text variant="labelLarge" style={styles.heroLabel}>
            Net position in {settings.baseCurrency}
          </Text>
          <Text variant="headlineLarge" style={styles.heroValue}>
            {formatMoney(summary.netWorth, settings.baseCurrency)}
          </Text>
          <Text variant="bodyMedium" style={styles.heroCopy}>
            {formatMoney(summary.cash, settings.baseCurrency)} cash minus {formatMoney(summary.debt, settings.baseCurrency)} tracked debt
          </Text>
          <View style={styles.heroActions}>
            <Button mode="contained-tonal" icon="bank-plus" onPress={() => setAddAccountVisible(true)}>
              Add account
            </Button>
          </View>
        </Card.Content>
      </Card>

      <View style={styles.metricGrid}>
        <MetricCard label="Income" value={formatMoney(summary.income, settings.baseCurrency)} helper="Current month" tone="primary" />
        <MetricCard label="Expenses" value={formatMoney(summary.expenses, settings.baseCurrency)} helper="Excluding debt" />
        <MetricCard label="Debt paid" value={formatMoney(summary.debtPayments, settings.baseCurrency)} helper="Loans and mortgage" />
        <MetricCard label="Cash flow" value={formatMoney(summary.cashFlow, settings.baseCurrency)} helper="After commitments" />
      </View>

      {forecast && forecastHasContent ? (
        <Card mode="contained" style={styles.forecastCard}>
          <Card.Content>
            <View style={styles.forecastHeader}>
              <View>
                <Text variant="labelLarge" style={styles.forecastLabel}>
                  Projected balance in {forecast.horizonDays} days
                </Text>
                <Text variant="headlineLarge" style={styles.forecastValue}>
                  {formatMoney(forecast.endingBalance, asCurrency(forecast.currency))}
                </Text>
              </View>
              <Chip
                compact
                icon={forecastDelta >= 0 ? "trending-up" : "trending-down"}
                style={forecastDelta >= 0 ? styles.forecastUpChip : styles.forecastDownChip}
              >
                {`${forecastDelta >= 0 ? "+" : ""}${formatMoney(forecastDelta, asCurrency(forecast.currency))}`}
              </Chip>
            </View>
            <Text variant="bodyMedium" style={styles.forecastCopy}>
              Today {formatMoney(forecast.startingBalance, asCurrency(forecast.currency))} . expected{" "}
              <Text style={styles.positive}>+{formatMoney(forecast.totalInflow, asCurrency(forecast.currency))}</Text> in,{" "}
              <Text style={styles.negative}>-{formatMoney(forecast.totalOutflow, asCurrency(forecast.currency))}</Text> out
            </Text>
            <Text variant="bodySmall" style={styles.muted}>
              Forecast uses SQLite FX rates for multi-currency rollup.
            </Text>
          </Card.Content>
        </Card>
      ) : null}

      {incomeStreams.length > 0 ? (
        <>
          <SectionTitle
            title="Income Streams"
            action={`${formatMoney(totalEstimatedMonthlyIncome, settings.baseCurrency)} / mo est.`}
          />
          <Card mode="contained" style={styles.card}>
            {incomeStreams.map((stream, index) => (
              <View key={stream.id}>
                <List.Item
                  title={stream.employerName}
                  description={`${formatStreamFrequency(stream.frequency)} . ${stream.transactionCount} payments . next around ${formatStreamDate(stream.nextExpectedAt ?? undefined)}`}
                  left={(props) => <List.Icon {...props} icon="cash-multiple" />}
                  right={() => (
                    <View style={styles.amountBlock}>
                      <Text variant="titleSmall" style={styles.incomeAmount}>
                        {formatMoney(stream.averageAmount, asCurrency(stream.currency))}
                      </Text>
                      <Text variant="bodySmall" style={styles.muted}>
                        {formatMoney(stream.monthlyAverage, asCurrency(stream.currency))} / mo
                      </Text>
                    </View>
                  )}
                />
                <View style={styles.streamMetaRow}>
                  <Chip compact icon={stream.confidence === "high" ? "check-circle-outline" : "help-circle-outline"}>
                    {stream.confidence} confidence
                  </Chip>
                  {stream.confirmedAt ? <Chip compact icon="check">Confirmed</Chip> : null}
                  {!stream.confirmedAt ? (
                    <Button
                      compact
                      mode="contained-tonal"
                      icon="check"
                      onPress={() => void runPFMAction(() => confirmIncomeStream(stream.id), queryClient)}
                    >
                      Confirm
                    </Button>
                  ) : null}
                  <Button
                    compact
                    mode="outlined"
                    icon="archive-outline"
                    onPress={() => void runPFMAction(() => archiveIncomeStream(stream.id), queryClient)}
                  >
                    Archive
                  </Button>
                  <Button
                    compact
                    mode="text"
                    icon="close"
                    onPress={() => void runPFMAction(() => dismissIncomeStream(stream.id), queryClient)}
                  >
                    Dismiss
                  </Button>
                </View>
                {index < incomeStreams.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {expenseProfiles.length > 0 ? (
        <>
          <SectionTitle
            title="Expense Profile"
            action={`${formatMoney(totalEstimatedMonthlyExpenses, settings.baseCurrency)} / mo est.`}
          />
          <Card mode="contained" style={styles.card}>
            {expenseProfiles.map((profile, index) => (
              <View key={profile.id}>
                <List.Item
                  title={profile.category}
                  description={`${profile.monthsObserved} ${profile.monthsObserved === 1 ? "month" : "months"} . ${profile.transactionCount} payments`}
                  left={(props) => <List.Icon {...props} icon="chart-pie" />}
                  right={() => (
                    <View style={styles.amountBlock}>
                      <Text variant="titleSmall" style={styles.expenseAmount}>
                        {formatMoney(Math.abs(profile.monthlyAverage), asCurrency(profile.currency))}
                      </Text>
                      <Text variant="bodySmall" style={styles.muted}>
                        avg / mo
                      </Text>
                    </View>
                  )}
                />
                <View style={styles.streamMetaRow}>
                  <Chip compact icon={profile.confidence === "high" ? "check-circle-outline" : "help-circle-outline"}>
                    {profile.confidence} confidence
                  </Chip>
                  <Button
                    compact
                    mode="outlined"
                    icon="archive-outline"
                    onPress={() => void runPFMAction(() => archiveExpenseProfile(profile.id), queryClient)}
                  >
                    Archive
                  </Button>
                  <Button
                    compact
                    mode="text"
                    icon="close"
                    onPress={() => void runPFMAction(() => dismissExpenseProfile(profile.id), queryClient)}
                  >
                    Dismiss
                  </Button>
                </View>
                {index < expenseProfiles.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title="Cash By Account" action="Manage" />
      {accounts.length > 0 ? (
        <Card mode="contained" style={styles.card}>
          {reconciliations.map((reconciliation, index) => (
            <View key={reconciliation.account.id}>
              <List.Item
                title={reconciliation.account.name}
                description={reconciliation.account.lastSyncedAt ?? "Manual balance"}
                onPress={() => {
                  clearError();
                  setSelectedAccount(reconciliation.account);
                }}
                left={(props) => (
                  <List.Icon
                    {...props}
                    icon="bank"
                  />
                )}
                right={() => (
                  <View style={styles.amountBlock}>
                    <Text variant="titleMedium">
                      {formatMoney(reconciliation.account.currentBalance, reconciliation.account.currency)}
                    </Text>
                    <Text variant="bodySmall" style={styles.muted}>
                      {reconciliation.account.source.replace("_", " ")}
                    </Text>
                  </View>
                )}
              />
              <View style={styles.reconciliationRow}>
                <Chip compact icon={reconciliation.isBalanced ? "check-circle-outline" : "alert-circle-outline"}>
                  {reconciliation.isProviderSnapshot
                    ? "Bank snapshot"
                    : reconciliation.isBalanced
                      ? "Reconciled"
                      : "Needs reconciliation"}
                </Chip>
                <Text variant="bodySmall" style={reconciliation.isBalanced ? styles.muted : styles.warningText}>
                  Ledger {formatMoney(reconciliation.computedBalance, reconciliation.account.currency)}
                </Text>
                {!reconciliation.isBalanced ? (
                  <Text variant="bodySmall" style={styles.warningText}>
                    Difference {formatMoney(reconciliation.difference, reconciliation.account.currency)}
                  </Text>
                ) : null}
              </View>
              {index < reconciliations.length - 1 ? <Divider /> : null}
            </View>
          ))}
        </Card>
      ) : (
        <StateCard title="No accounts yet" detail="Add a manual account or import a CSV to start tracking balances." />
      )}

      <SectionTitle title="Currency Exposure" />
      {exposure.length > 0 ? (
        <Card mode="contained" style={styles.card}>
          <Card.Content style={styles.exposureList}>
            {exposure.map((item) => (
              <View key={`${item.currency}-${item.amount}`} style={styles.exposureRow}>
                <View style={styles.exposureLabel}>
                  <Chip compact>{item.currency}</Chip>
                  <Text variant="bodyMedium">{formatMoney(item.amount, item.currency)}</Text>
                </View>
                <View style={styles.exposureValue}>
                  <Text variant="labelLarge">{formatMoney(item.baseAmount, settings.baseCurrency)}</Text>
                  <ProgressBar
                    progress={Math.min(Math.abs(item.baseAmount) / exposureDenominator, 1)}
                    color={theme.colors.primary}
                  />
                </View>
              </View>
            ))}
          </Card.Content>
        </Card>
      ) : (
        <StateCard title="No currency exposure" detail="Currency exposure appears after at least one account is tracked." />
      )}

      <SectionTitle title="Alerts" />
      {alerts.length > 0 ? (
        <View style={styles.alerts}>
          {alerts.map((alert) => (
            <Card key={alert.id} mode="contained" style={styles.alertCard}>
              <Card.Content style={styles.alertContent}>
                <List.Icon icon={getAlertIcon(alert.tone)} />
                <View style={styles.alertText}>
                  <Text variant="titleSmall">{alert.title}</Text>
                  <Text variant="bodySmall" style={styles.muted}>
                    {alert.detail}
                  </Text>
                </View>
              </Card.Content>
            </Card>
          ))}
        </View>
      ) : (
        <StateCard title="No alerts" detail="No tracked liability payments are due in the next week." />
      )}
      <AddAccountDialog visible={addAccountVisible} onDismiss={() => setAddAccountVisible(false)} />
      <EditAccountDialog
        account={selectedAccount}
        visible={selectedAccount !== null}
        onDismiss={() => setSelectedAccount(null)}
      />
    </Screen>
  );
}

function createStyles(theme: FinanceTheme) {
  return StyleSheet.create({
  hero: {
    backgroundColor: theme.colors.primaryContainer,
    borderRadius: theme.radius.lg
  },
  heroLabel: {
    color: theme.colors.onPrimaryContainer,
    fontSize: 13,
    lineHeight: 18
  },
  heroValue: {
    color: theme.colors.onPrimaryContainer,
    fontSize: 34,
    fontWeight: "800",
    lineHeight: 40,
    marginTop: theme.spacing.sm
  },
  heroCopy: {
    color: theme.colors.onPrimaryContainer,
    fontSize: 13,
    lineHeight: 18,
    marginTop: theme.spacing.xs
  },
  heroActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg
  },
  amountBlock: {
    alignItems: "flex-end",
    justifyContent: "center"
  },
  reconciliationRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    paddingHorizontal: theme.spacing.md
  },
  muted: {
    color: theme.colors.onSurfaceVariant
  },
  warningText: {
    color: theme.finance.warning
  },
  exposureList: {
    gap: theme.spacing.md
  },
  exposureRow: {
    gap: theme.spacing.sm
  },
  exposureLabel: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    justifyContent: "space-between"
  },
  exposureValue: {
    gap: theme.spacing.xs
  },
  alerts: {
    gap: theme.spacing.sm
  },
  alertCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg
  },
  alertContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm
  },
  alertText: {
    flex: 1
  },
  streamMetaRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    paddingHorizontal: theme.spacing.md
  },
  incomeAmount: {
    color: theme.finance.income,
    fontWeight: "700"
  },
  expenseAmount: {
    color: theme.finance.expense,
    fontWeight: "700"
  },
  forecastCard: {
    backgroundColor: theme.colors.surfaceVariant,
    borderRadius: theme.radius.lg
  },
  forecastHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  forecastLabel: {
    color: theme.colors.onSurfaceVariant,
    fontSize: 13,
    lineHeight: 18
  },
  forecastValue: {
    color: theme.colors.onSurface,
    fontSize: 34,
    fontWeight: "800",
    lineHeight: 40,
    marginTop: theme.spacing.xs
  },
  forecastCopy: {
    color: theme.colors.onSurfaceVariant,
    fontSize: 13,
    lineHeight: 18,
    marginTop: theme.spacing.sm
  },
  forecastUpChip: {
    backgroundColor: theme.finance.incomeContainer
  },
  forecastDownChip: {
    backgroundColor: theme.finance.expenseContainer
  },
  positive: {
    color: theme.finance.income,
    fontWeight: "700"
  },
  negative: {
    color: theme.finance.expense,
    fontWeight: "700"
  }
});
}

async function runPFMAction(action: () => Promise<void>, queryClient: QueryClient) {
  await action();
  await queryClient.invalidateQueries({ queryKey: sqliteFinanceQueryKeys.root });
}

function buildLiabilityAlerts(liabilities: Liability[]): Alert[] {
  const today = startOfUtcDay(Date.now());
  const soonestFirst = liabilities
    .map((liability) => {
      const dueAt = parseIsoDate(liability.nextDueDate);
      return dueAt === null ? null : { liability, dueAt };
    })
    .filter((item): item is { liability: Liability; dueAt: number } => Boolean(item))
    .filter(({ dueAt }) => dueAt <= today + 7 * DAY_MS)
    .sort((left, right) => left.dueAt - right.dueAt);

  return soonestFirst.map(({ liability, dueAt }) => {
    const daysUntilDue = Math.round((dueAt - today) / DAY_MS);
    const isOverdue = daysUntilDue < 0;
    const title = isOverdue
      ? `${formatLiabilityType(liability.type)} overdue`
      : `${formatLiabilityType(liability.type)} due soon`;
    const dueText =
      daysUntilDue === 0
        ? "today"
        : isOverdue
          ? `${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? "" : "s"} ago`
          : `in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}`;

    return {
      id: `liability-alert-${liability.id}`,
      title,
      detail: `${liability.institution} payment of ${formatMoney(
        liability.paymentAmount,
        liability.currency
      )} is due ${dueText} (${liability.nextDueDate}).`,
      tone: isOverdue ? "error" : "warning"
    };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(epochMs: number) {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function formatLiabilityType(type: Liability["type"]) {
  switch (type) {
    case "mortgage":
      return "Mortgage";
    case "student_loan":
      return "Student loan";
    case "car_loan":
      return "Car loan";
    case "credit_card_debt":
      return "Card debt";
    case "personal_loan":
      return "Loan";
    default:
      return "Liability";
  }
}

function getAlertIcon(tone: Alert["tone"]) {
  switch (tone) {
    case "error":
      return "alert-circle-outline";
    case "warning":
      return "calendar-alert";
    default:
      return "check-circle-outline";
  }
}

function formatStreamFrequency(frequency: IncomeStreamRow["frequency"]) {
  switch (frequency) {
    case "weekly":
      return "Weekly";
    case "biweekly":
      return "Every 2 weeks";
    case "quarterly":
      return "Quarterly";
    case "yearly":
      return "Yearly";
    default:
      return "Monthly";
  }
}

function formatStreamDate(epochMs: number | undefined) {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) {
    return "—";
  }
  return new Date(epochMs).toISOString().slice(0, 10);
}

function asCurrency(value: string): Currency {
  return value === "HUF" || value === "USD" || value === "GBP" ? value : "EUR";
}
