"use client";
// v3 §3.1: list state lives in the URL query string (shareable, survives refresh and back), data comes from
// /api/lists/<name>, which filters, counts and pages on the server.
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApi } from "../api";

export type FacetOption = { value: string; label: string; count: number };
export type ListData<R> = {
  list: string;
  title: string;
  query: Record<string, string>;
  range: { preset: string | null; from: string | null; to: string | null };
  total: number;
  page: number;
  pages: number;
  size: number;
  rows: R[];
  facets: Array<{ key: string; label: string; options: FacetOption[] }>;
  summary: Array<{ key: string; label: string; format: "count" | "money" | "minutes"; value: number; apply: Record<string, string> }>;
  sorts: Array<{ value: string; label: string }>;
  dateLabel: string | null;
  canExport: boolean;
};

export function useList<R>(list: string, opts: { pollMs?: number } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const state = useApi<ListData<R>>(`/api/lists/${list}${qs ? `?${qs}` : ""}`, { pollMs: opts.pollMs });
  // Keep showing the last result while the next one loads, so the filter bar never disappears mid-typing.
  const [last, setLast] = useState<ListData<R> | undefined>(undefined);
  if (state.data && state.data !== last) setLast(state.data);
  const data = state.data ?? last;

  // First visit with no parameters: show the defaults the server applied in the address bar.
  useEffect(() => {
    if (!qs && state.data && Object.keys(state.data.query).length) {
      router.replace(`${pathname}?${new URLSearchParams(state.data.query).toString()}`, { scroll: false });
    }
  }, [qs, state.data, pathname, router]);

  const params = useMemo(() => Object.fromEntries(search.entries()) as Record<string, string>, [search]);

  /** Merge changes into the query (null removes a key); any filter change goes back to page 1. */
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!("page" in patch)) next.delete("page");
      // Keep at least the sort so an emptied filter does not bring the defaults back.
      if (![...next.keys()].length) next.set("sort", data?.query.sort ?? "");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [search, pathname, router, data?.query.sort],
  );

  const replaceAll = useCallback((query: string) => router.replace(`${pathname}?${query}`, { scroll: false }), [pathname, router]);

  return { data, error: state.error, loading: state.loading && !data, reload: state.reload, params, qs, update, replaceAll };
}
