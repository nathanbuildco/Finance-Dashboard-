"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/app/actions/auth";

const C = {
  bg: "#0c0f14",
  card: "#141820",
  border: "#1e2430",
  text: "#e8eaed",
  muted: "#7a8194",
  blue: "#4fc3f7",
  red: "#ef5350",
};

export default function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, undefined);

  return (
    <div
      style={{
        background: C.bg,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: C.text,
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: 24,
      }}
    >
      <form
        action={formAction}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "32px 36px",
          width: "100%",
          maxWidth: 380,
          boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: C.blue,
            marginBottom: 6,
            fontWeight: 600,
          }}
        >
          Finance Review
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          Sign in to continue
        </h1>
        <p style={{ fontSize: 13, color: C.muted, marginTop: 6, marginBottom: 24 }}>
          Enter the dashboard password to view the finance review.
        </p>

        <label
          htmlFor="password"
          style={{
            display: "block",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: C.muted,
            marginBottom: 6,
          }}
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          style={{
            background: "#1a1f2e",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 14px",
            color: C.text,
            fontFamily: "monospace",
            fontSize: 14,
            width: "100%",
            outline: "none",
            boxSizing: "border-box",
          }}
        />

        {state?.error && (
          <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>{state.error}</div>
        )}

        <button
          type="submit"
          disabled={pending}
          style={{
            marginTop: 20,
            width: "100%",
            padding: "11px 16px",
            background: C.blue,
            color: C.bg,
            border: "none",
            borderRadius: 8,
            cursor: pending ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 600,
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
