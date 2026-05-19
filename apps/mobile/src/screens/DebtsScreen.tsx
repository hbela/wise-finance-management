import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Chip, Dialog, Divider, List, Portal, ProgressBar, Text } from "react-native-paper";

import { AddLiabilityDialog } from "../components/AddLiabilityDialog";
import { EditLiabilityDialog } from "../components/EditLiabilityDialog";
import { Screen } from "../components/Screen";
import { SectionTitle } from "../components/SectionTitle";
import { StateCard } from "../components/StateCard";
import { useFinance, useFxSnapshot } from "../state/FinanceContext";
import { useFinanceTheme, type FinanceTheme } from "../theme";
import type { Liability, Transaction } from "../data/types";
import { toBaseCurrencyAmount } from "../services/fxRates";
import { formatMoney } from "../utils/money";

export function DebtsScreen() {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const {
    addSampleLiabilities,
    liabilities,
    settings,
    transactions,
    updateTransaction,
    isLoading,
    error,
    clearError
  } = useFinance();
  const fxSnapshot = useFxSnapshot(settings.baseCurrency);
  const [addLiabilityVisible, setAddLiabilityVisible] = useState(false);
  const [linkPaymentVisible, setLinkPaymentVisible] = useState(false);
  const [selectedLiability, setSelectedLiability] = useState<Liability | null>(null);
  const totalDebt = liabilities.reduce(
    (sum, liability) => sum + toBaseCurrencyAmount(liability.outstandingBalance, liability.currency, fxSnapshot),
    0
  );
  const monthlyCommitment = liabilities.reduce(
    (sum, liability) => sum + toBaseCurrencyAmount(liability.paymentAmount, liability.currency, fxSnapshot),
    0
  );

  return (
    <Screen>
      {isLoading ? (
        <StateCard title="Loading liabilities" detail="Fetching your loans and debt records from local storage." loading />
      ) : null}
      {error ? <StateCard title="Finance action failed" detail={error} tone="error" /> : null}

      <Card mode="contained" style={styles.summary}>
        <Card.Content>
          <Text variant="labelLarge" style={styles.summaryLabel}>
            Tracked liabilities
          </Text>
          <Text variant="headlineLarge" style={styles.summaryValue}>
            {formatMoney(totalDebt, settings.baseCurrency)}
          </Text>
          <Text variant="bodyMedium" style={styles.muted}>
            {formatMoney(monthlyCommitment, settings.baseCurrency)} committed each month
          </Text>
          <View style={styles.actionRow}>
            <Button mode="contained" icon="plus" onPress={() => setAddLiabilityVisible(true)}>
              Add liability
            </Button>
            <Button mode="contained-tonal" icon="database-plus" onPress={() => void addSampleLiabilities()}>
              Add samples
            </Button>
            <Button mode="outlined" icon="link-variant" onPress={() => setLinkPaymentVisible(true)}>
              Link payment
            </Button>
          </View>
        </Card.Content>
      </Card>

      <SectionTitle title="Loans And Mortgages" />
      {liabilities.length > 0 ? (
        <View style={styles.list}>
          {liabilities.map((liability) => {
            const progress =
              liability.originalPrincipal > 0
                ? 1 - liability.outstandingBalance / liability.originalPrincipal
                : 0;

            return (
              <Card
                key={liability.id}
                mode="contained"
                onPress={() => {
                  clearError();
                  setSelectedLiability(liability);
                }}
                style={styles.card}
              >
                <Card.Content style={styles.cardContent}>
                  <View style={styles.titleRow}>
                    <View style={styles.titleBlock}>
                      <Text variant="titleMedium" style={styles.title}>
                        {liability.name}
                      </Text>
                      <Text variant="bodySmall" style={styles.muted}>
                        {liability.institution}
                      </Text>
                    </View>
                    <Chip compact icon={liability.rateType === "fixed" ? "lock" : "chart-line"}>
                      {liability.rateType}
                    </Chip>
                  </View>

                  <View style={styles.balanceRow}>
                    <View>
                      <Text variant="labelMedium" style={styles.muted}>
                        Outstanding
                      </Text>
                      <Text variant="titleLarge">
                        {formatMoney(liability.outstandingBalance, liability.currency)}
                      </Text>
                    </View>
                    <View style={styles.paymentBlock}>
                      <Text variant="labelMedium" style={styles.muted}>
                        Payment
                      </Text>
                      <Text variant="titleMedium">
                        {formatMoney(liability.paymentAmount, liability.currency)}
                      </Text>
                    </View>
                  </View>

                  <ProgressBar progress={Math.max(progress, 0.02)} color={theme.colors.secondary} />
                  <View style={styles.detailGrid}>
                    <List.Item
                      title={`${liability.interestRate}%`}
                      description="Interest"
                      left={(props) => <List.Icon {...props} icon="percent" />}
                      style={styles.detailItem}
                    />
                    <Divider />
                    <List.Item
                      title={liability.nextDueDate}
                      description="Next due"
                      left={(props) => <List.Icon {...props} icon="calendar-clock" />}
                      style={styles.detailItem}
                    />
                  </View>
                </Card.Content>
              </Card>
            );
          })}
        </View>
      ) : (
        <StateCard title="No liabilities yet" detail="Add a loan, card balance, or mortgage to track debt payoff." />
      )}
      <AddLiabilityDialog visible={addLiabilityVisible} onDismiss={() => setAddLiabilityVisible(false)} />
      <LinkPaymentDialog
        liabilities={liabilities}
        transactions={transactions}
        visible={linkPaymentVisible}
        onDismiss={() => setLinkPaymentVisible(false)}
        onLink={async (transaction, liability) => {
          await updateTransaction({
            id: transaction.id,
            category: liability.type === "mortgage" ? "Mortgage payment" : "Loan payment",
            type: liability.type === "mortgage" ? "mortgage_payment" : "loan_payment",
            merchant: transaction.merchant,
            description: transaction.description,
            notes: mergePaymentLinkNote(transaction.notes, liability),
            isRecurring: true,
            isExcludedFromReports: false,
            transferMatchId: transaction.transferMatchId ?? null
          });
        }}
      />
      <EditLiabilityDialog
        liability={selectedLiability}
        visible={selectedLiability !== null}
        onDismiss={() => setSelectedLiability(null)}
      />
    </Screen>
  );
}

function LinkPaymentDialog({
  liabilities,
  transactions,
  visible,
  onDismiss,
  onLink
}: {
  liabilities: Liability[];
  transactions: Transaction[];
  visible: boolean;
  onDismiss: () => void;
  onLink: (transaction: Transaction, liability: Liability) => Promise<void>;
}) {
  const theme = useFinanceTheme();
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  const candidates = React.useMemo(
    () => getPaymentLinkCandidates(transactions, liabilities),
    [liabilities, transactions]
  );
  const [selectedLiabilityId, setSelectedLiabilityId] = useState<string | null>(null);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const selectedLiability =
    liabilities.find((liability) => liability.id === selectedLiabilityId) ?? candidates[0]?.liability ?? null;
  const visibleCandidates = selectedLiability
    ? candidates.filter((candidate) => candidate.liability.id === selectedLiability.id)
    : [];

  React.useEffect(() => {
    if (!visible) {
      return;
    }
    const firstCandidate = candidates[0];
    setSelectedLiabilityId(firstCandidate?.liability.id ?? liabilities[0]?.id ?? null);
    setSelectedTransactionId(firstCandidate?.transaction.id ?? null);
  }, [candidates, liabilities, visible]);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={styles.dialog}>
        <Dialog.Title>Link Payment</Dialog.Title>
        <Dialog.ScrollArea>
          <ScrollView contentContainerStyle={styles.linkDialogContent}>
            {liabilities.length > 0 ? (
              <>
                <Text variant="labelLarge">Liability</Text>
                <View style={styles.chipGrid}>
                  {liabilities.map((liability) => (
                    <Chip
                      key={liability.id}
                      compact
                      selected={selectedLiability?.id === liability.id}
                      onPress={() => {
                        const nextTransaction = candidates.find(
                          (candidate) => candidate.liability.id === liability.id
                        )?.transaction;
                        setSelectedLiabilityId(liability.id);
                        setSelectedTransactionId(nextTransaction?.id ?? null);
                      }}
                    >
                      {liability.name}
                    </Chip>
                  ))}
                </View>
              </>
            ) : (
              <StateCard title="No liabilities" detail="Add a loan or mortgage before linking payments." />
            )}

            {selectedLiability ? (
              <>
                <Text variant="labelLarge">Likely payments</Text>
                {visibleCandidates.length > 0 ? (
                  <View style={styles.linkCandidateList}>
                    {visibleCandidates.map(({ transaction, score }) => (
                      <Card
                        key={transaction.id}
                        mode="contained"
                        style={styles.linkCandidateCard}
                        onPress={() => setSelectedTransactionId(transaction.id)}
                      >
                        <Card.Content style={styles.linkCandidateContent}>
                          <View style={styles.titleRow}>
                            <View style={styles.titleBlock}>
                              <Text variant="titleSmall">{transaction.merchant}</Text>
                              <Text variant="bodySmall" style={styles.muted}>
                                {transaction.category} . {transaction.postedAt}
                              </Text>
                            </View>
                            <Chip compact selected={selectedTransactionId === transaction.id}>
                              {formatMoney(transaction.amount, transaction.currency)}
                            </Chip>
                          </View>
                          <Text variant="bodySmall" style={styles.muted}>
                            Match score {score}
                          </Text>
                        </Card.Content>
                      </Card>
                    ))}
                  </View>
                ) : (
                  <StateCard
                    title="No likely payments"
                    detail="Look for expense transactions whose merchant or description contains the lender name, loan, or mortgage."
                  />
                )}
              </>
            ) : null}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button
            mode="contained"
            disabled={!selectedLiability || !selectedTransactionId}
            onPress={async () => {
              const transaction = transactions.find((candidate) => candidate.id === selectedTransactionId);
              if (!transaction || !selectedLiability) {
                return;
              }
              await onLink(transaction, selectedLiability);
              onDismiss();
            }}
          >
            Link
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

function getPaymentLinkCandidates(transactions: Transaction[], liabilities: Liability[]) {
  return liabilities
    .flatMap((liability) =>
      transactions
        .filter((transaction) => transaction.amount < 0)
        .filter((transaction) => !["income", "refund", "transfer"].includes(transaction.type))
        .map((transaction) => ({
          liability,
          transaction,
          score: scorePaymentMatch(transaction, liability)
        }))
        .filter((candidate) => candidate.score > 0)
    )
    .sort((left, right) => right.score - left.score || right.transaction.postedAt.localeCompare(left.transaction.postedAt))
    .slice(0, 24);
}

function scorePaymentMatch(transaction: Transaction, liability: Liability) {
  const haystack = normalizeSearchText(
    [transaction.merchant, transaction.description, transaction.category].join(" ")
  );
  const lenderTokens = normalizeSearchText(`${liability.name} ${liability.institution}`)
    .split(" ")
    .filter((token) => token.length >= 3);
  const typeTokens = liability.type === "mortgage" ? ["mortgage"] : ["loan", "credit"];
  const amountDistance = Math.abs(Math.abs(transaction.amount) - liability.paymentAmount);
  const isNearPaymentAmount = amountDistance <= Math.max(liability.paymentAmount * 0.2, 1);
  const lenderScore = lenderTokens.reduce(
    (sum, token) => sum + (haystack.includes(token) ? 2 : 0),
    0
  );
  const typeScore = typeTokens.some((token) => haystack.includes(token)) ? 4 : 0;
  const categoryScore = ["loan_payment", "mortgage_payment"].includes(transaction.type) ? 3 : 0;
  const amountScore = isNearPaymentAmount ? 2 : 0;

  return lenderScore + typeScore + categoryScore + amountScore;
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergePaymentLinkNote(notes: string | undefined, liability: Liability) {
  const linkNote = `Linked to liability: ${liability.name}`;
  if (!notes?.trim()) {
    return linkNote;
  }
  return notes.includes(linkNote) ? notes : `${notes.trim()}\n${linkNote}`;
}

function createStyles(theme: FinanceTheme) {
  return StyleSheet.create({
  dialog: {
    borderRadius: 8
  },
  summary: {
    backgroundColor: theme.colors.secondaryContainer,
    borderRadius: theme.radius.lg
  },
  summaryLabel: {
    color: theme.colors.onSecondaryContainer
  },
  summaryValue: {
    color: theme.colors.onSecondaryContainer,
    fontWeight: "800",
    marginTop: theme.spacing.sm
  },
  muted: {
    color: theme.colors.onSurfaceVariant
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.md
  },
  list: {
    gap: theme.spacing.md
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg
  },
  cardContent: {
    gap: theme.spacing.md
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.md,
    justifyContent: "space-between"
  },
  titleBlock: {
    flex: 1
  },
  title: {
    fontWeight: "700"
  },
  balanceRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  paymentBlock: {
    alignItems: "flex-end"
  },
  detailGrid: {
    borderColor: theme.colors.outlineVariant,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    overflow: "hidden"
  },
  detailItem: {
    paddingVertical: 0
  },
  chipGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm
  },
  linkDialogContent: {
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.md
  },
  linkCandidateList: {
    gap: theme.spacing.sm
  },
  linkCandidateCard: {
    backgroundColor: theme.colors.surface
  },
  linkCandidateContent: {
    gap: theme.spacing.xs
  }
});
}
