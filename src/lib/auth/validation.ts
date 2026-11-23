export const STUDENT_DOMAIN = "@iluv.ums.edu.my";
export const STAFF_DOMAIN = "@ums.edu.my";

export type ExpectedUniversityRole = "student" | "staff";

export interface EmailValidationResult {
  valid: boolean;
  normalizedEmail: string;
  expectedRole?: ExpectedUniversityRole;
  error?: string;
}

/**
 * Enforces exact UMS university email domains:
 * - Student: user@iluv.ums.edu.my
 * - Staff:   user@ums.edu.my
 * Rejects lookalike or spoofed subdomains.
 */
export function validateUniversityEmail(raw: string): EmailValidationResult {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return {
      valid: false,
      normalizedEmail: normalized,
      error: "Enter a valid UMS email address.",
    };
  }

  const parts = normalized.split("@");
  if (parts.length !== 2) {
    return {
      valid: false,
      normalizedEmail: normalized,
      error: "Enter a valid email address.",
    };
  }

  const [localPart, domainPart] = parts;
  if (!localPart || !/^[a-z0-9._+-]+$/i.test(localPart)) {
    return {
      valid: false,
      normalizedEmail: normalized,
      error: "Email address contains invalid characters.",
    };
  }

  if (domainPart === "iluv.ums.edu.my") {
    return {
      valid: true,
      normalizedEmail: normalized,
      expectedRole: "student",
    };
  }

  if (domainPart === "ums.edu.my") {
    return {
      valid: true,
      normalizedEmail: normalized,
      expectedRole: "staff",
    };
  }

  return {
    valid: false,
    normalizedEmail: normalized,
    error: `Use your official UMS email (${STUDENT_DOMAIN} for students or ${STAFF_DOMAIN} for staff).`,
  };
}

/**
 * Validates standard email syntax for password recovery only.
 * Does NOT bypass university domain checks on /login or /register.
 */
export function validateAnyEmailFormat(raw: string): {
  valid: boolean;
  normalizedEmail: string;
  error?: string;
} {
  const normalized = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return {
      valid: false,
      normalizedEmail: normalized,
      error: "Enter a valid email address.",
    };
  }
  return { valid: true, normalizedEmail: normalized };
}

export function validatePassword(password: string): string | null {
  if (!password || password.length < 8) {
    return "Password must be at least 8 characters long.";
  }
  return null;
}

/**
 * Prevents open redirects by allowing only relative same-origin app paths.
 */
export function sanitizeNextPath(raw: string | null | undefined, fallback = "/marketplace"): string {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return fallback;
  }
  return trimmed;
}
