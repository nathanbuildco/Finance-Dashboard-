"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, expectedToken } from "@/app/lib/auth";

const MAX_AGE = 60 * 60 * 24 * 30;

export type LoginState = { error?: string } | undefined;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const pw = formData.get("password");
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected) return { error: "Server not configured: DASHBOARD_PASSWORD is not set." };
  if (typeof pw !== "string" || pw.length === 0) return { error: "Enter the password." };
  if (pw !== expected) return { error: "Incorrect password." };

  const token = expectedToken();
  if (!token) return { error: "Server not configured." };

  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });

  redirect("/");
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE);
  redirect("/login");
}
