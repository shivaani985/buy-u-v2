/**
 * Phase 2 route & auth smoke check against a running local Next.js server.
 * Usage: node scripts/smoke-check.mjs [baseUrl]
 */
import assert from "node:assert/strict";

const baseUrl = process.argv[2] ?? "http://localhost:3000";

const routes = [
  {
    path: "/",
    mustInclude: [
      "The Campus",
      "for UMS Students",
      "Latest on",
      "Student Services",
      "Free Items",
      "Sign in with your UMS email",
    ],
    mustExclude: ["42501", "sb_secret_", "Trending on Campus"],
  },
  {
    path: "/marketplace",
    mustInclude: ["Campus", "Sign in with your UMS account"],
    mustExclude: ["42501", "sb_secret_"],
  },
  {
    path: "/login",
    mustInclude: ["Sign in to", "@iluv.ums.edu.my", "@ums.edu.my"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/register",
    mustInclude: ["Create UMS Account", "@iluv.ums.edu.my", "@ums.edu.my"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/forgot-password",
    mustInclude: ["Send Password Reset Link"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/reset-password",
    mustInclude: ["Recovery session required"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/admin/login",
    mustInclude: ["Admin Portal", "admin_users"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/account",
    mustInclude: ["duwwlcpdidrxkixvflag", "Yes (Public Anon Key)"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/marketplace?demo=1&q=calculator",
    mustInclude: ["Explicit Demo Mode", "Casio FX-570EX", "RM 68.00"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/seller",
    mustInclude: ["Student Sign-In Required", "@iluv.ums.edu.my"],
    mustExclude: ["sb_secret_", "account_number"],
  },
  {
    path: "/seller/storefront",
    mustInclude: ["Student Sign-In Required", "@iluv.ums.edu.my"],
    mustExclude: ["sb_secret_"],
  },
  {
    path: "/sell",
    mustInclude: ["Student Sign-In Required", "@iluv.ums.edu.my"],
    mustExclude: ["sb_secret_"],
  },
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
  for (const forbidden of route.mustExclude) {
    assert.ok(
      !html.includes(forbidden),
      `Forbidden string "${forbidden}" appeared in ${route.path}`
    );
  }
  console.log(`PASS 200 ${route.path}`);
}

// Unauthorized /admin access must redirect to /admin/login
const adminRes = await fetch(`${baseUrl}/admin`, { redirect: "manual" });
assert.ok(
  adminRes.status === 307 || adminRes.status === 302,
  `Expected redirect for unauthenticated /admin, got ${adminRes.status}`
);
const adminLoc = adminRes.headers.get("location") ?? "";
assert.ok(
  adminLoc.includes("/admin/login"),
  `Expected /admin redirect to /admin/login, got "${adminLoc}"`
);
console.log(`PASS ${adminRes.status} /admin -> ${adminLoc}`);

// /auth/callback without code must redirect safely to /login (no open redirect)
const cbRes = await fetch(`${baseUrl}/auth/callback?next=//evil.com`, {
  redirect: "manual",
});
assert.ok(
  cbRes.status === 307 || cbRes.status === 302,
  `Expected redirect for /auth/callback, got ${cbRes.status}`
);
const cbLoc = cbRes.headers.get("location") ?? "";
assert.ok(
  cbLoc.includes("/login") && !cbLoc.includes("evil.com"),
  `Unsafe callback redirect: "${cbLoc}"`
);
console.log(`PASS ${cbRes.status} /auth/callback -> ${cbLoc}`);

console.log(`All ${routes.length + 2} Phase 2 smoke & auth protection checks passed.`);
