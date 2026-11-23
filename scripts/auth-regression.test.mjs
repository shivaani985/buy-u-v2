import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeNextPath,
  validatePassword,
  validateUniversityEmail,
} from "../src/lib/auth/validation.ts";
import {
  formatSenToRm,
  resolvePublicStorageUrl,
} from "../src/lib/format.ts";

test("accepts exact student @iluv.ums.edu.my email", () => {
  const res = validateUniversityEmail("  BI22110001@ILUV.UMS.EDU.MY ");
  assert.equal(res.valid, true);
  assert.equal(res.expectedRole, "student");
  assert.equal(res.normalizedEmail, "bi22110001@iluv.ums.edu.my");
});

test("accepts exact staff @ums.edu.my email", () => {
  const res = validateUniversityEmail("lecturer.name@ums.edu.my");
  assert.equal(res.valid, true);
  assert.equal(res.expectedRole, "staff");
});

test("rejects non-UMS and spoofed subdomain emails", () => {
  for (const bad of [
    "user@gmail.com",
    "user@fake.iluv.ums.edu.my",
    "user@ums.edu.my.evil.com",
    "user@student.ums.edu.my",
    "invalid-email",
    "",
  ]) {
    const res = validateUniversityEmail(bad);
    assert.equal(res.valid, false, `Should reject ${bad}`);
  }
});

test("sanitizeNextPath blocks open redirects", () => {
  assert.equal(sanitizeNextPath("/marketplace?type=service"), "/marketplace?type=service");
  assert.equal(sanitizeNextPath("//evil.com/phish"), "/marketplace");
  assert.equal(sanitizeNextPath("https://evil.com"), "/marketplace");
  assert.equal(sanitizeNextPath("/\\evil.com"), "/marketplace");
  assert.equal(sanitizeNextPath(null, "/account"), "/account");
});

test("validatePassword enforces minimum length", () => {
  assert.ok(validatePassword("short"));
  assert.equal(validatePassword("validPass123"), null);
});

test("formatSenToRm converts integer sen accurately", () => {
  assert.equal(formatSenToRm(1500), "RM 15.00");
  assert.equal(formatSenToRm(6850), "RM 68.50");
  assert.equal(formatSenToRm(0), "FREE");
  assert.equal(formatSenToRm(-100), "FREE");
});

test("resolvePublicStorageUrl allows safe public bucket paths and rejects traversal", () => {
  const base = "https://duwwlcpdidrxkixvflag.supabase.co";
  assert.equal(
    resolvePublicStorageUrl("listings", "seller-1/photo.png", base),
    "https://duwwlcpdidrxkixvflag.supabase.co/storage/v1/object/public/listings/seller-1/photo.png"
  );
  assert.equal(resolvePublicStorageUrl("listings", "../chat-media/secret.png", base), null);
  assert.equal(resolvePublicStorageUrl("listings", "https://evil.com/x.png", base), null);
});
