"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  sanitizeNextPath,
  validatePassword,
  validateUniversityEmail,
} from "@/lib/auth/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AuthActionState {
  status: "idle" | "error" | "success";
  message?: string;
}

async function getOrigin(): Promise<string> {
  const hdrs = await headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "localhost:3000";
  const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function signInMember(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const emailRaw = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const nextPath = sanitizeNextPath(String(formData.get("next") ?? ""), "/marketplace");

  const emailCheck = validateUniversityEmail(emailRaw);
  if (!emailCheck.valid) {
    return { status: "error", message: emailCheck.error };
  }
  if (!password) {
    return { status: "error", message: "Enter your password." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      status: "error",
      message: "Supabase authentication is not configured in this environment.",
    };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: emailCheck.normalizedEmail,
    password,
  });

  if (error || !data.user) {
    return {
      status: "error",
      message:
        error?.message === "Email not confirmed"
          ? "Please verify your UMS email address using the link sent to your inbox before signing in."
          : "Invalid university email or password.",
    };
  }

  if (!data.user.email_confirmed_at) {
    await supabase.auth.signOut();
    return {
      status: "error",
      message:
        "Email verification is required before accessing Buy-U. Check your UMS inbox for the verification link.",
    };
  }

  // Verify authoritative profile status from public.profiles
  const { data: profile } = await supabase
    .from("profiles")
    .select("status, restriction_reason")
    .eq("id", data.user.id)
    .maybeSingle();

  const status = String(profile?.status ?? "").toLowerCase();
  if (profile && status && status !== "active") {
    await supabase.auth.signOut();
    return {
      status: "error",
      message: `Your account is currently ${status}. Contact Buy-U administration for assistance.`,
    };
  }

  revalidatePath("/", "layout");
  redirect(nextPath);
}

export async function registerMember(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const emailRaw = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();

  const emailCheck = validateUniversityEmail(emailRaw);
  if (!emailCheck.valid) {
    return { status: "error", message: emailCheck.error };
  }

  if (!displayName || displayName.length < 2) {
    return {
      status: "error",
      message: "Enter a display name (at least 2 characters).",
    };
  }

  const passwordErr = validatePassword(password);
  if (passwordErr) {
    return { status: "error", message: passwordErr };
  }

  if (password !== confirmPassword) {
    return { status: "error", message: "Passwords do not match." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      status: "error",
      message: "Supabase authentication is not configured in this environment.",
    };
  }

  const origin = await getOrigin();
  // Do NOT insert into profiles manually — existing handle_new_auth_user trigger owns profile creation & role assignment.
  const { error } = await supabase.auth.signUp({
    email: emailCheck.normalizedEmail,
    password,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=/account`,
      data: {
        display_name: displayName,
      },
    },
  });

  if (error) {
    return {
      status: "error",
      message: error.message || "Unable to register account right now.",
    };
  }

  return {
    status: "success",
    message:
      "Registration received. Check your UMS email inbox and click the verification link to activate your Buy-U account.",
  };
}

export async function requestPasswordReset(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const emailRaw = String(formData.get("email") ?? "");
  const emailCheck = validateUniversityEmail(emailRaw);
  if (!emailCheck.valid) {
    return { status: "error", message: emailCheck.error };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      status: "error",
      message: "Supabase authentication is not configured in this environment.",
    };
  }

  const origin = await getOrigin();
  const { error } = await supabase.auth.resetPasswordForEmail(
    emailCheck.normalizedEmail,
    {
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    }
  );

  if (error) {
    return {
      status: "error",
      message: "Unable to send password reset email right now. Try again shortly.",
    };
  }

  // Generic success message avoids enumerating registered accounts.
  return {
    status: "success",
    message:
      "If an account exists for that UMS email, a password reset link has been sent. Open it to choose a new password.",
  };
}

export async function updatePassword(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const passwordErr = validatePassword(password);
  if (passwordErr) {
    return { status: "error", message: passwordErr };
  }
  if (password !== confirmPassword) {
    return { status: "error", message: "Passwords do not match." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      status: "error",
      message: "Supabase authentication is not configured.",
    };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      status: "error",
      message:
        "Your password reset session has expired. Request a new reset link from Forgot Password.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return {
      status: "error",
      message: error.message || "Unable to update password.",
    };
  }

  revalidatePath("/", "layout");
  return {
    status: "success",
    message: "Password updated. You can now continue to your Buy-U account.",
  };
}

export async function signInAdmin(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !email.includes("@")) {
    return { status: "error", message: "Enter your administrator email." };
  }
  if (!password) {
    return { status: "error", message: "Enter your password." };
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      status: "error",
      message: "Supabase authentication is not configured.",
    };
  }

  // Preserve any existing regular member session instead of silently logging them out.
  const {
    data: { user: existingUser },
  } = await supabase.auth.getUser();
  if (existingUser) {
    const { data: existingIsAdmin } = await supabase.rpc("is_active_admin");
    if (existingIsAdmin === true) {
      revalidatePath("/", "layout");
      redirect("/admin");
    }
    return {
      status: "error",
      message:
        "You are currently signed in as a regular UMS member. Your marketplace session was kept active — sign out first if you need to switch to an administrator account.",
    };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return {
      status: "error",
      message: "Invalid administrator credentials.",
    };
  }

  // Strictly verify administrator membership via backend RPC is_active_admin().
  const { data: isAdmin, error: adminErr } = await supabase.rpc("is_active_admin");
  if (adminErr || isAdmin !== true) {
    await supabase.auth.signOut();
    return {
      status: "error",
      message:
        "Access denied. This account does not hold active Buy-U administrator privileges.",
    };
  }

  revalidatePath("/", "layout");
  redirect("/admin");
}

export async function signOutAction() {
  const supabase = await createSupabaseServerClient();
  if (supabase) {
    await supabase.auth.signOut();
  }
  revalidatePath("/", "layout");
  redirect("/");
}
