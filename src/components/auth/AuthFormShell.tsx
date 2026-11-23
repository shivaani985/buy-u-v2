import Image from "next/image";
import Link from "next/link";

interface AuthFormShellProps {
  title: string;
  accentWord: string;
  subtitle: string;
  accentColor?: "purple" | "teal" | "blue";
  children: React.ReactNode;
  footer?: React.ReactNode;
}

const ACCENT_TEXT: Record<"purple" | "teal" | "blue", string> = {
  purple: "text-[#4E2A84]",
  teal: "text-[#007D80]",
  blue: "text-[#1D70B8]",
};

const ACCENT_BAR: Record<"purple" | "teal" | "blue", string> = {
  purple: "bg-[#4E2A84]",
  teal: "bg-[#00A3A6]",
  blue: "bg-[#1D70B8]",
};

export function AuthFormShell({
  title,
  accentWord,
  subtitle,
  accentColor = "purple",
  children,
  footer,
}: AuthFormShellProps) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="border-2 border-[#14121A] bg-white">
        <div className={`h-2 w-full ${ACCENT_BAR[accentColor]}`} aria-hidden="true" />

        <div className="p-6 sm:p-8">
          <div className="mb-4">
            <Link
              href="/"
              className="inline-block rounded-md press-feedback focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4E2A84]"
              aria-label="Return to Buy-U Home"
            >
              <Image
                src="/images/logo/buyu-logo.png"
                alt="Buy-U"
                width={48}
                height={54}
                className="h-11 w-auto object-contain select-none"
                priority
              />
            </Link>
          </div>

          <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-[#14121A] sm:text-3xl">
            {title}{" "}
            <span className={`font-editorial italic font-bold ${ACCENT_TEXT[accentColor]}`}>
              {accentWord}
            </span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[#4A4656]">
            {subtitle}
          </p>

          <div className="mt-6">{children}</div>

          {footer ? (
            <div className="mt-6 border-t border-[#E2E0E8] pt-5 text-sm text-[#4A4656]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-4 text-center text-xs text-[#4A4656]">
        <Link href="/" className="font-semibold text-[#1D70B8] hover:underline">
          Return to Buy-U Home
        </Link>
      </p>
    </div>
  );
}
