import type { Metadata } from "next";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="mb-4 text-2xl font-bold">Forgot your password?</h1>
      <ForgotForm />
    </div>
  );
}
