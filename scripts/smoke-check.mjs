/**
 * Phase 1 route smoke check against a running local Next.js server.
 * Usage: node scripts/smoke-check.mjs [baseUrl]
 */
import assert from "node:assert/strict";

const baseUrl = process.argv[2] ?? "http://localhost:3000";

const routes = [
  { path: "/", mustInclude: ["Buy-U", "UMSKAL", "Browse Marketplace", "Explore by"] },
  { path: "/marketplace", mustInclude: ["Campus", "Demo Data Mode", "RM 68.00"] },
  { path: "/marketplace?type=service", mustInclude: ["Laptop Cleanup", "RM 35.00"] },
  { path: "/marketplace?type=free", mustInclude: ["Ring Binders", "FREE"] },
  { path: "/marketplace?q=calculator", mustInclude: ["Casio FX-570EX"] },
  {
    path: "/listings/casio-fx-570ex-scientific-calculator",
    mustInclude: ["Casio FX-570EX ClassWiz Calculator", "UMSKAL Main Block"],
  },
  { path: "/account", mustInclude: ["duwwlcpdidrxkixvflag", "UMS Role Separation"] },
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
    !html.includes("SUPABASE_SERVICE_ROLE_KEY"),
    `Secret key reference leaked in ${route.path}`
  );
  console.log(`PASS ${res.status} ${route.path}`);
}

console.log(`All ${routes.length} Phase 1 route smoke checks passed.`);
