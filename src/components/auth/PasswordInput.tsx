"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

interface PasswordInputProps {
  id: string;
  name: string;
  label: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
}

export function PasswordInput({
  id,
  name,
  label,
  autoComplete = "current-password",
  placeholder = "Enter your password",
  required = true,
  minLength,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#3C3744] mb-1.5"
      >
        <Lock className="h-3.5 w-3.5 text-[#4E2A84]" aria-hidden="true" />
        <span>{label}</span>
      </label>
      <div className="relative rounded-xl border border-[#D5D0E0] bg-[#FAF9FD] transition-all duration-150 focus-within:border-[#4E2A84] focus-within:bg-white focus-within:ring-2 focus-within:ring-[#4E2A84]/20">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          className="w-full bg-transparent px-4 py-3 pr-11 text-sm text-[#14121A] placeholder:text-[#8E889B] outline-none"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-[#6B6578] transition-all hover:bg-black/5 hover:text-[#4E2A84] active:scale-95"
        >
          {visible ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
