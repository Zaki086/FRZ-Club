import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">The page you are looking for does not exist or was moved.</p>
      <Link href="/" className="text-primary underline">
        Go to the home page
      </Link>
    </div>
  );
}
