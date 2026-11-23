import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getPublicSupabaseEnv } from "@/lib/supabase/env";

/**
 * Refreshes Supabase SSR auth cookies on each request using the publishable key.
 * Never uses service-role credentials.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const env = getPublicSupabaseEnv();

  if (!env) {
    return response;
  }

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: Array<{
          name: string;
          value: string;
          options: CookieOptions;
        }>
      ) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Trigger token refresh safely; enforce hard HTTP redirect for unauthenticated /admin access.
  let hasUser = false;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    hasUser = Boolean(user);
  } catch {
    // Handled gracefully per route.
  }

  const pathname = request.nextUrl.pathname;
  if (
    (pathname === "/admin" || pathname.startsWith("/admin/")) &&
    pathname !== "/admin/login" &&
    !hasUser
  ) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
