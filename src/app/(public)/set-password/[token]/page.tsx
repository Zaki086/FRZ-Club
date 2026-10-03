import { SetPasswordForm } from "./set-password-form";

export default async function SetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-12">
      <h1 className="text-2xl font-bold">Set your password</h1>
      <p className="text-sm text-muted-foreground">Choose a password for the member portal. You will log in with your phone number.</p>
      <SetPasswordForm token={token} />
    </div>
  );
}
