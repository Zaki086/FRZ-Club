"use client";
import { useState } from "react";
import { api, ApiError, useApi } from "@/components/api";
import { DataState, Empty, RejectionBanner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDateTime } from "@/lib/time";

type Data = {
  last: { at: string; file: string; bytes: number; ok: boolean; error: string | null } | null;
  keepDays: number;
  files: Array<{ file: string; bytes: number; at: string }>;
};

const size = (b: number) => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

export function BackupsView() {
  const state = useApi<Data>("/api/backups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  return (
    <DataState state={state}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Last backup</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {!d.last ? (
                <p className="text-amber-700">No backup has run yet.</p>
              ) : d.last.ok ? (
                <p className="text-green-700" data-testid="last-backup">{fmtDateTime(d.last.at)} · {d.last.file} · {size(d.last.bytes)}</p>
              ) : (
                <p className="text-red-700">Failed at {fmtDateTime(d.last.at)}: {d.last.error}</p>
              )}
              <RejectionBanner error={error} />
              <Button
                className="self-start"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api("/api/backups", { body: {} });
                    await state.reload();
                  } catch (e) {
                    setError(e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Backing up…" : "Back up now"}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Kept backups ({d.keepDays} days)</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {d.files.length === 0 ? (
                <Empty title="No backup files" />
              ) : (
                <div className="divide-y">
                  {d.files.map((f) => (
                    <div key={f.file} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="font-mono text-xs">{f.file}</span>
                      <span className="flex items-center gap-3 text-xs">
                        {fmtDateTime(f.at)} · {size(f.bytes)}
                        <a className="text-primary underline" href={`/api/backups/${f.file}`} download>Download</a>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                To restore, an administrator runs on the server: <code>docker exec -i champions-postgres pg_restore -U champions -d champions --clean --if-exists &lt; FILE.dump</code> (stop the app first).
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </DataState>
  );
}
