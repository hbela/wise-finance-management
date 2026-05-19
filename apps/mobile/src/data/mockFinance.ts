import type { Bank } from "./types";

export const baseCurrency = "EUR";

export const banks: Bank[] = [
  {
    id: "otp-hu",
    name: "OTP Bank",
    country: "Hungary",
    supportedCurrencies: ["HUF", "EUR"],
    connectionMethods: ["manual", "csv", "open_banking_future"],
    providerKey: "manual-hu-otp"
  },
  {
    id: "credit-agricole-fr",
    name: "Credit Agricole",
    country: "France",
    supportedCurrencies: ["EUR"],
    connectionMethods: ["manual", "csv", "open_banking_future"],
    providerKey: "manual-fr-ca"
  }
];
