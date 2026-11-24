import crypto from "node:crypto";

export type SimulatedOutcomeMode =
  | "success"
  | "fail"
  | "reconciliation_required";

export interface RefundProviderRequest {
  refundCode: string;
  orderId: string;
  amountSen: number;
  idempotencyKey: string;
  /** Strictly server/QA controlled simulation mode; never from arbitrary buyer/seller input. */
  qaOutcome?: SimulatedOutcomeMode;
}

export interface RefundProviderResult {
  provider: string;
  simulationMode: boolean;
  outcome: "succeeded" | "failed" | "reconciliation_required";
  refundRef?: string;
  failureReason?: string;
}

export interface RefundExecutionProvider {
  executeRefund(req: RefundProviderRequest): Promise<RefundProviderResult>;
}

export interface BankPayoutProviderRequest {
  withdrawalCode: string;
  sellerId: string;
  amountSen: number;
  idempotencyKey: string;
  bankName: string;
  accountLast4: string;
  /** Strictly server/QA controlled simulation mode; never from arbitrary seller input. */
  qaOutcome?: SimulatedOutcomeMode;
}

export interface BankPayoutProviderResult {
  provider: string;
  simulationMode: boolean;
  outcome: "paid" | "failed" | "reconciliation_required";
  transferRef?: string;
  failureReason?: string;
}

export interface BankPayoutProvider {
  executeDisbursement(
    req: BankPayoutProviderRequest
  ): Promise<BankPayoutProviderResult>;
}

function assertNotProductionRealExecution(): void {
  if (process.env.BUYU_PAYMENT_ENV === "production") {
    throw new Error(
      "FAIL_CLOSED: Simulated financial provider cannot execute in production mode."
    );
  }
}

export class SimulatedRefundProvider implements RefundExecutionProvider {
  async executeRefund(
    req: RefundProviderRequest
  ): Promise<RefundProviderResult> {
    assertNotProductionRealExecution();
    if (!req.refundCode || req.amountSen <= 0 || !req.idempotencyKey) {
      return {
        provider: "simulated_refund",
        simulationMode: true,
        outcome: "failed",
        failureReason: "Invalid refund execution payload.",
      };
    }

    const mode = req.qaOutcome ?? "success";
    if (mode === "fail") {
      return {
        provider: "simulated_refund",
        simulationMode: true,
        outcome: "failed",
        failureReason: "Simulated refund provider declined transfer (QA fail mode).",
      };
    }
    if (mode === "reconciliation_required") {
      return {
        provider: "simulated_refund",
        simulationMode: true,
        outcome: "reconciliation_required",
        failureReason:
          "Simulated provider timeout; outcome uncertain and requires reconciliation.",
      };
    }

    const token = crypto.randomBytes(4).toString("hex").toUpperCase();
    return {
      provider: "simulated_refund",
      simulationMode: true,
      outcome: "succeeded",
      refundRef: `SIM-RFD-${req.refundCode.replace(/^RFD-/, "")}-${token}`,
    };
  }
}

export class SimulatedBankPayoutProvider implements BankPayoutProvider {
  async executeDisbursement(
    req: BankPayoutProviderRequest
  ): Promise<BankPayoutProviderResult> {
    assertNotProductionRealExecution();
    if (
      !req.withdrawalCode ||
      req.amountSen < 200 ||
      !req.idempotencyKey ||
      !req.bankName
    ) {
      return {
        provider: "simulated_bank",
        simulationMode: true,
        outcome: "failed",
        failureReason: "Invalid bank disbursement payload.",
      };
    }

    const mode = req.qaOutcome ?? "success";
    if (mode === "fail") {
      return {
        provider: "simulated_bank",
        simulationMode: true,
        outcome: "failed",
        failureReason:
          "Simulated Malaysian bank disbursement rejected (QA fail mode).",
      };
    }
    if (mode === "reconciliation_required") {
      return {
        provider: "simulated_bank",
        simulationMode: true,
        outcome: "reconciliation_required",
        failureReason:
          "Simulated bank gateway timed out; transfer status uncertain and held for reconciliation.",
      };
    }

    const token = crypto.randomBytes(4).toString("hex").toUpperCase();
    return {
      provider: "simulated_bank",
      simulationMode: true,
      outcome: "paid",
      transferRef: `SIM-TRF-${req.withdrawalCode.replace(/^WDR-/, "")}-${token}`,
    };
  }
}

export function getRefundExecutionProvider(): RefundExecutionProvider {
  assertNotProductionRealExecution();
  return new SimulatedRefundProvider();
}

export function getBankPayoutProvider(): BankPayoutProvider {
  assertNotProductionRealExecution();
  return new SimulatedBankPayoutProvider();
}
