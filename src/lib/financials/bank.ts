import crypto from "node:crypto";

export const MALAYSIAN_BANKS = [
  "Maybank",
  "CIMB Bank",
  "Public Bank",
  "RHB Bank",
  "Hong Leong Bank",
  "AmBank",
  "Bank Islam",
  "Bank Rakyat",
  "BSN",
  "Affin Bank",
  "Alliance Bank",
  "UOB Malaysia",
  "OCBC Malaysia",
  "HSBC Malaysia",
  "Standard Chartered Malaysia",
] as const;

export type MalaysianBankName = (typeof MALAYSIAN_BANKS)[number];

export interface BankAccountFormInput {
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  confirmAccountNumber: string;
}

export function isSupportedMalaysianBank(
  name: string
): name is MalaysianBankName {
  return (MALAYSIAN_BANKS as readonly string[]).includes(name.trim());
}

export function normalizeAccountNumberDigits(raw: string): string {
  return (raw ?? "").replace(/[\s-]/g, "").trim();
}

export function maskBankAccountNumber(raw: string): {
  last4: string;
  masked: string;
} {
  const digits = normalizeAccountNumberDigits(raw);
  const last4 = digits.slice(-4);
  return { last4, masked: `****${last4}` };
}

export function validateBankAccountInput(
  input: BankAccountFormInput
):
  | {
      ok: true;
      bankName: MalaysianBankName;
      accountHolderName: string;
      accountNumber: string;
      last4: string;
      masked: string;
    }
  | { ok: false; error: string } {
  const bankName = (input.bankName ?? "").trim();
  if (!isSupportedMalaysianBank(bankName)) {
    return {
      ok: false,
      error: "Select a supported Malaysian bank from the list.",
    };
  }

  const holder = (input.accountHolderName ?? "").trim();
  if (holder.length < 3 || holder.length > 100) {
    return {
      ok: false,
      error: "Account holder name must be between 3 and 100 characters.",
    };
  }
  if (!/^[A-Za-z0-9@/'.,\-\s]+$/.test(holder)) {
    return {
      ok: false,
      error: "Account holder name contains unsupported characters.",
    };
  }

  const digits = normalizeAccountNumberDigits(input.accountNumber);
  const confirmDigits = normalizeAccountNumberDigits(input.confirmAccountNumber);

  if (!/^\d{8,18}$/.test(digits)) {
    return {
      ok: false,
      error: "Bank account number must be 8 to 18 numeric digits.",
    };
  }
  if (digits !== confirmDigits) {
    return {
      ok: false,
      error: "Account number and confirmation do not match.",
    };
  }

  const { last4, masked } = maskBankAccountNumber(digits);
  return {
    ok: true,
    bankName,
    accountHolderName: holder,
    accountNumber: digits,
    last4,
    masked,
  };
}

function getServerEncryptionKey(): Buffer {
  if (typeof window !== "undefined") {
    throw new Error("Bank encryption is strictly server-only.");
  }
  const explicitKey = process.env.BUYU_BANK_ENCRYPTION_KEY?.trim();
  if (explicitKey) {
    return crypto.createHash("sha256").update(explicitKey, "utf8").digest();
  }
  if (process.env.NODE_ENV === "production" && process.env.BUYU_PAYMENT_ENV === "production") {
    throw new Error("BUYU_BANK_ENCRYPTION_KEY must be set in production.");
  }
  // Dev / FYP sandbox fallback derived from server-only service key (never hardcoded)
  const fallbackSeed = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!fallbackSeed) {
    throw new Error("Server encryption secret is not configured.");
  }
  return crypto
    .createHash("sha256")
    .update(`buyu-bank-v1:${fallbackSeed}`, "utf8")
    .digest();
}

/**
 * Encrypts a bank account number at rest using AES-256-GCM.
 * Format: `v1:<ivHex>:<tagHex>:<cipherHex>`. Never logs plaintext.
 */
export function encryptBankAccountNumber(plainDigits: string): string {
  const key = getServerEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainDigits, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}
