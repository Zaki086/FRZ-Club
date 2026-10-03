export default function OfflinePage() {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-2xl font-bold">You are offline</h1>
      <p className="mt-2 text-muted-foreground">Bookings, payments and stock need a live connection, so nothing is shown from memory. Reconnect and try again.</p>
    </div>
  );
}
