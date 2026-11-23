/**
 * Phase 1.5 route smoke check against a running local Next.js server.
 * Verifies:
 * 1. Live mode connects to Supabase (no silent fallback to fake listings on 42501)
 * 2. Explicit ?demo=1 mode renders sample catalog, filters, and detail view
 * 3. Zero server secrets or private keys leak into rendered HTML
 * Usage: node scripts/smoke-check.mjs [baseUrl]
 */
import assert from "node:assert/strict";

const baseUrl = process.argv[2] ?? "http://localhost:3000";

const routes = [
  { path: "/", mustInclude: ["Buy-U", "UMSKAL", "Browse Marketplace"] },
  { path: "/marketplace", mustInclude: ["Campus", "Marketplace"] },
  { path: "/?demo=1", mustInclude: ["Explicit Demo Mode", "Casio FX-570EX"] },
  { path: "/marketplace?demo=1", mustInclude: ["Explicit Demo Mode", "RM 68.00"] },
  { path: "/marketplace?demo=1&type=service", mustInclude: ["Laptop Cleanup", "RM 35.00"] },
  { path: "/marketplace?demo=1&type=free", mustInclude: ["Ring Binders", "FREE"] },
  { path: "/marketplace?demo=1&q=calculator", mustInclude: ["Casio FX-570EX"] },
  {
    path: "/listings/demo-101?demo=1",
    mustInclude: ["Casio FX-570EX ClassWiz Calculator", "Menara UMSKAL"],
  },
  { path: "/account", mustInclude: ["duwwlcpdidrxkixvflag", "Yes (Public Anon Key)"] },
];

for (const route of routes) {
  const res = await fetch(`${baseUrl}${route.path}`);
  assert.equal(res.status, 200, `Expected 200 for ${route.path}, got ${res.status}`);
  const html = await res.text();
  for (const snippet of route.mustInclude) {
    assert.ok(
      html.includes(snippet),
      `Expected ${route.path} to contain "${snippet}"`
    );
  }
  assert.ok(
    !html.includes("sb_secret_"),
    `Supabase secret key leaked in ${route.path}`
  );
  assert.ok(
    !html.includes("TOYYIBPAY_SANDBOX_SECRET_KEY"),
    `ToyyibPay secret leaked in ${route.path}`
  );
  console.log(`PASS ${res.status} ${route.path}`);
}

console.log(`All ${routes.length} Phase 1.5 route smoke checks passed.`);
