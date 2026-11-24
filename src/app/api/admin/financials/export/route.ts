import { NextResponse } from "next/server";
import {
  buildSanitizedFinancialCsv,
  type SanitizedFinancialCsvRow,
} from "@/lib/financials/reconciliation";
import { getSessionSummary } from "@/lib/supabase/server";
import { getServerServiceClient } from "@/lib/supabase/service";

/**
 * Admin-only sanitized CSV export of financial transactions (payments, refunds, withdrawals).
 * NEVER exports full bank account numbers, encryption secrets, pickup PINs, or raw callbacks.
 */
export async function GET() {
  const session = await getSessionSummary();
  if (!session.isAuthenticated || !session.isActiveAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const service = getServerServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const [csRes, refRes, wdrRes] = await Promise.all([
    service
      .from("checkout_sessions")
      .select("checkout_code,total_paid_sen,status,transaction_ref,paid_at,created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    service
      .from("order_refunds")
      .select("refund_code,refund_amount_sen,status,refund_ref,simulation_mode,completed_at,created_at")
      .order("created_at", { ascending: false })
      .limit(500),
    service
      .from("payout_requests")
      .select("withdrawal_code,amount_sen,status,transfer_ref,masked_bank_summary,simulation_mode,completed_at,created_at")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const rows: SanitizedFinancialCsvRow[] = [];

  for (const cs of (csRes.data ?? []) as Array<{
    checkout_code: string;
    total_paid_sen: number;
    status: string;
    transaction_ref: string | null;
    paid_at: string | null;
    created_at: string;
  }>) {
    rows.push({
      type: "payment",
      reference: cs.transaction_ref || "N/A",
      orderOrCheckoutCode: cs.checkout_code,
      status: cs.status,
      amountRm: (cs.total_paid_sen / 100).toFixed(2),
      maskedDestination: "ToyyibPay Sandbox FPX",
      simulationMode: "sandbox",
      timestamp: cs.paid_at || cs.created_at,
    });
  }

  if (!refRes.error) {
    for (const r of (refRes.data ?? []) as Array<{
      refund_code: string;
      refund_amount_sen: number;
      status: string;
      refund_ref: string | null;
      simulation_mode: boolean;
      completed_at: string | null;
      created_at: string;
    }>) {
      rows.push({
        type: "refund",
        reference: r.refund_ref || r.refund_code,
        orderOrCheckoutCode: r.refund_code,
        status: r.status,
        amountRm: (r.refund_amount_sen / 100).toFixed(2),
        maskedDestination: "Buyer Simulated Refund",
        simulationMode: r.simulation_mode ? "simulated" : "live",
        timestamp: r.completed_at || r.created_at,
      });
    }
  }

  if (!wdrRes.error) {
    for (const w of (wdrRes.data ?? []) as Array<{
      withdrawal_code: string | null;
      amount_sen: number;
      status: string;
      transfer_ref: string | null;
      masked_bank_summary: string | null;
      simulation_mode: boolean | null;
      completed_at: string | null;
      created_at: string;
    }>) {
      rows.push({
        type: "withdrawal",
        reference: w.transfer_ref || w.withdrawal_code || "N/A",
        orderOrCheckoutCode: w.withdrawal_code || "WDR",
        status: w.status,
        amountRm: (w.amount_sen / 100).toFixed(2),
        maskedDestination: w.masked_bank_summary || "Masked Bank Account",
        simulationMode: w.simulation_mode === false ? "live" : "simulated",
        timestamp: w.completed_at || w.created_at,
      });
    }
  }

  const csv = buildSanitizedFinancialCsv(rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="buyu-financials-sanitized.csv"',
      "Cache-Control": "private, no-store",
    },
  });
}
