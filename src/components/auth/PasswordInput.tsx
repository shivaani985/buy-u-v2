"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

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
  placeholder = "Enter password",
  required = true,
  minLength,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-bold uppercase tracking-wider text-[#14121A]"
      >
        {label}
      </label>
      <div className="mt-1.5 flex items-center border border-[#14121A] bg-white focus-within:border-[#4E2A84]">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          className="w-full bg-transparent px-3.5 py-2.5 text-sm text-[#14121A] placeholder:text-[#5B5668] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="flex h-10 w-10 shrink-0 items-center justify-center text-[#4A4656] hover:text-[#4E2A84]"
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
