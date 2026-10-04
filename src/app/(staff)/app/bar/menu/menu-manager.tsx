"use client";
// v5 §1.1 the Menu screen (Bar staff, Manager, Owner): categories (drag to reorder, active), items on the standard
// FilterBar (category, status, food type, alcoholic, available, has photo), an item editor (photo, price in rupees,
// food type, alcoholic, allergens, prep time, available, status) with the item's price history (MN-2), and the links
// to "Preview as member" (MN-4), the A4 print (MN-5) and the table QR cards (MN-6).
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Eye, GripVertical, Pencil, Plus, Printer, QrCode, Wine } from "lucide-react";
import { api, ApiError, useApi } from "@/components/api";
import { ConfirmButton } from "@/components/confirm";
import { FilteredList, useListReload } from "@/components/list/filtered-list";
import { FoodTypeSymbol, MenuIcon, MenuItemImage } from "@/components/menu-view";
import { Money } from "@/components/money";
import { DataState, RejectionBanner } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import {
  ALLERGEN_LABEL, ALLERGENS, FOOD_TYPE_LABEL, FOOD_TYPES, MENU_DESCRIPTION_MAX, MENU_ICONS, MENU_NAME_MAX, MENU_NAME_MIN, MENU_PREP_MAX,
  MENU_PRICE_MAX, MENU_PRICE_MIN, MENU_STATUS_LABEL, type AllergenValue, type FoodTypeValue, type MenuKind, type MenuStatusValue,
} from "@/lib/menu";
import { formatINR, parseRupees } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";

type Rejection = { code?: string; message: string } | null;
const toErr = (e: unknown): Rejection => (e instanceof ApiError ? { code: e.code, message: e.message } : { message: String(e) });

type Category = {
  id: string; name: string; description: string | null; icon: string; sortOrder: number; active: boolean;
  items: { active: number; draft: number; archived: number };
};

type Row = {
  id: string; name: string; description: string | null; price: number; is_alcoholic: boolean; available: boolean; status: MenuStatusValue;
  food_type: FoodTypeValue | null; kind: MenuKind; allergens: AllergenValue[]; prep_minutes: number | null; photo_url: string | null;
  thumb_url: string | null; category_id: string; category_name: string; category_icon: string; category_active: boolean;
};

type Detail = {
  id: string; name: string; categoryId: string; categoryName: string; categoryIcon: string; description: string | null; price: number;
  kind: MenuKind; foodType: FoodTypeValue | null; isAlcoholic: boolean; taxCategory: string; allergens: AllergenValue[]; prepMinutes: number | null;
  available: boolean; status: MenuStatusValue; photoUrl: string | null; thumbUrl: string | null; tabLines: number; canPrice: boolean;
  priceHistory: Array<{ id: string; oldPrice: number | null; price: number; effectiveAt: string; by: string | null; note: string | null; state: "APPLIED" | "SCHEDULED" | "WITHDRAWN" }>;
};

const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PHOTO = 2 * 1024 * 1024;

async function uploadPhoto(itemId: string, file: File) {
  const fd = new FormData();
  fd.set("file", file);
  let res: Response;
  try {
    res = await fetch(`/api/bar/menu/${itemId}/photo`, { method: "POST", body: fd });
  } catch {
    throw new ApiError("NETWORK", "Could not reach the server. Check the connection and try again.", 0, null);
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) throw new ApiError(j.error?.code ?? `HTTP_${res.status}`, j.error?.message ?? "The photo could not be uploaded.", res.status, null);
}

function checkPhoto(file: File | null): string | null {
  if (!file) return null;
  if (!PHOTO_TYPES.includes(file.type)) return "Upload a PNG, JPEG or WebP image.";
  if (file.size > MAX_PHOTO) return `The photo is ${(file.size / 1_048_576).toFixed(1)} MB; the limit is 2 MB.`;
  return null;
}

// ───────── categories ─────────

function CategoryForm({ category, onDone }: { category: Category | null; onDone: () => void }) {
  const [f, setF] = useState({ name: category?.name ?? "", description: category?.description ?? "", icon: category?.icon ?? "UtensilsCrossed", active: category?.active ?? true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="menu-category-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const name = f.name.trim();
        if (name.length < 2 || name.length > 40) return setError({ message: "A category name is 2–40 characters." });
        setBusy(true);
        try {
          const body = { name, description: f.description.trim() || null, icon: f.icon, active: f.active };
          if (category) await api(`/api/bar/menu/categories/${category.id}`, { method: "PATCH", body });
          else await api("/api/bar/menu/categories", { body });
          onDone();
        } catch (err) {
          setError(toErr(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Category name"><Input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
      <Field label={`Description (optional, ${f.description.length}/${MENU_DESCRIPTION_MAX})`}>
        <Textarea rows={2} maxLength={MENU_DESCRIPTION_MAX} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">Icon (shown for items without a photo)</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
          {MENU_ICONS.map((i) => (
            <button
              key={i} type="button" role="radio" aria-checked={f.icon === i} aria-label={i} title={i}
              onClick={() => setF({ ...f, icon: i })}
              className={cn("flex h-10 w-10 items-center justify-center rounded-lg border", f.icon === i ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-secondary")}
            >
              <MenuIcon name={i} className="h-5 w-5" />
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (shown to members and on the bar grid)</label>
      <RejectionBanner error={error} />
      <Button type="submit" disabled={busy} className="self-start">{category ? "Save category" : "Add category"}</Button>
    </form>
  );
}

function CategoryDialog({ category, trigger, onDone }: { category: Category | null; trigger: ReactNode; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={category ? `Edit “${category.name}”` : "New category"} description="Members see categories in this order, each with its items.">
        {open ? <CategoryForm category={category} onDone={() => { setOpen(false); onDone(); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Categories({ categories, onChange }: { categories: Category[]; onChange: () => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const [error, setError] = useState<Rejection>(null);
  const order = async (ids: string[]) => {
    setError(null);
    try { await api("/api/bar/menu/categories/order", { method: "PUT", body: { ids } }); onChange(); } catch (e) { setError(toErr(e)); }
  };
  const move = (i: number, by: number) => {
    const ids = categories.map((c) => c.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void order(ids);
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Categories</CardTitle>
        <CategoryDialog category={null} onDone={onChange} trigger={<Button size="sm" data-testid="new-category"><Plus className="h-4 w-4" /> New category</Button>} />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {categories.length ? (
          <ol className="flex flex-col divide-y rounded-lg border" data-testid="menu-categories">
            {categories.map((c, i) => (
              <li
                key={c.id}
                draggable
                onDragStart={() => setDrag(c.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!drag || drag === c.id) return;
                  const ids = categories.map((x) => x.id).filter((x) => x !== drag);
                  ids.splice(i, 0, drag);
                  setDrag(null);
                  void order(ids);
                }}
                className={cn("flex flex-wrap items-center gap-2 px-3 py-2", drag === c.id && "opacity-50")}
                data-testid="menu-category-row"
              >
                <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" aria-hidden />
                <MenuIcon name={c.icon} className="h-5 w-5 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.items.active} active{c.items.draft ? ` · ${c.items.draft} draft` : ""}{c.items.archived ? ` · ${c.items.archived} archived` : ""}
                    {c.description ? ` · ${c.description}` : ""}
                  </span>
                </span>
                {c.active ? null : <Badge tone="neutral">Inactive</Badge>}
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Move ${c.name} down`} disabled={i === categories.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <CategoryDialog category={c} onDone={onChange} trigger={<Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`}><Pencil className="h-4 w-4" /> Edit</Button>} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No categories yet. Add the first one (e.g. “Snacks” or “Coffee & tea”), then add items to it.</p>
        )}
        <p className="text-xs text-muted-foreground">Drag a category (or use the arrows) to change the order members see.</p>
        <RejectionBanner error={error} />
      </CardContent>
    </Card>
  );
}

// ───────── items ─────────

type FormState = {
  name: string; categoryId: string; description: string; price: string; kind: MenuKind; foodType: FoodTypeValue | ""; isAlcoholic: boolean;
  allergens: AllergenValue[]; prepMinutes: string; available: boolean; status: "DRAFT" | "ACTIVE";
};

function initialForm(detail: Detail | null, categories: Category[]): FormState {
  if (detail) {
    return {
      name: detail.name, categoryId: detail.categoryId, description: detail.description ?? "", price: String(detail.price / 100), kind: detail.kind,
      foodType: detail.foodType ?? "", isAlcoholic: detail.isAlcoholic, allergens: detail.allergens, prepMinutes: detail.prepMinutes ? String(detail.prepMinutes) : "",
      available: detail.available, status: detail.status === "DRAFT" ? "DRAFT" : "ACTIVE",
    };
  }
  return {
    name: "", categoryId: (categories.find((c) => c.active) ?? categories[0])?.id ?? "", description: "", price: "", kind: "FOOD", foodType: "", isAlcoholic: false,
    allergens: [], prepMinutes: "", available: true, status: "ACTIVE",
  };
}

/** The same rules the server applies, checked before sending (the server stays authoritative). */
function validate(f: FormState): { message: string } | { price: number; prep: number | null } {
  const name = f.name.trim();
  if (name.length < MENU_NAME_MIN || name.length > MENU_NAME_MAX) return { message: "The name is 2–60 characters." };
  if (!f.categoryId) return { message: "Choose a category." };
  if (f.description.trim().length > MENU_DESCRIPTION_MAX) return { message: "The description is at most 300 characters." };
  const price = parseRupees(f.price);
  if (price === null || price < MENU_PRICE_MIN || price > MENU_PRICE_MAX) return { message: "The price is ₹1 – ₹50,000." };
  if (f.kind === "FOOD" && !f.foodType) return { message: "Choose Veg, Non-veg or Egg for a food item." };
  let prep: number | null = null;
  if (f.prepMinutes.trim()) {
    prep = Number(f.prepMinutes);
    if (!Number.isInteger(prep) || prep < 1 || prep > MENU_PREP_MAX) return { message: "Prep time is 1–240 minutes." };
  }
  return { price, prep };
}

function PriceHistory({ rows }: { rows: Detail["priceHistory"] }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="menu-price-history">
      <p className="text-sm font-semibold">Price history (price book)</p>
      <ul className="max-h-40 overflow-y-auto rounded-lg border text-xs">
        {rows.map((r) => (
          <li key={r.id} className={cn("flex flex-wrap justify-between gap-2 px-2 py-1.5", r.state === "WITHDRAWN" && "text-muted-foreground line-through")}>
            <span className="tabular">{r.oldPrice === null ? "Opening price" : formatINR(r.oldPrice)} → <b>{formatINR(r.price)}</b>{r.state === "SCHEDULED" ? " (scheduled)" : ""}</span>
            <span className="text-muted-foreground">{r.by ?? "Before v5"} · {fmtDateTime(r.effectiveAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemForm({ detail, categories, canPrice, onSaved }: { detail: Detail | null; categories: Category[]; canPrice: boolean; onSaved: () => void }) {
  const [f, setF] = useState<FormState>(() => initialForm(detail, categories));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Rejection>(null);
  const archived = detail?.status === "ARCHIVED";
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleAllergen = (a: AllergenValue) => set("allergens", f.allergens.includes(a) ? f.allergens.filter((x) => x !== a) : [...f.allergens, a]);

  const submit = async () => {
    setError(null);
    const v = validate(f);
    if ("message" in v) return setError(v);
    const photoError = checkPhoto(file);
    if (photoError) return setError({ message: photoError });
    const body = {
      name: f.name.trim(), categoryId: f.categoryId, description: f.description.trim() || null, kind: f.kind, foodType: f.kind === "FOOD" ? f.foodType || null : null,
      isAlcoholic: f.isAlcoholic, allergens: f.allergens, prepMinutes: v.prep, available: f.available,
    };
    setBusy(true);
    try {
      let id = detail?.id;
      if (!detail) {
        const created = await api<{ id: string }>("/api/bar/menu", { body: { ...body, price: v.price, status: f.status } });
        id = created.id;
      } else {
        await api(`/api/bar/menu/${detail.id}`, { method: "PATCH", body: v.price !== detail.price ? { ...body, price: v.price } : body });
      }
      if (file && id) {
        try {
          await uploadPhoto(id, file);
        } catch (e) {
          // The item is saved; only the photo failed — say so plainly (and don't offer to create it twice).
          setSaved(true);
          setError({ code: toErr(e)?.code, message: `The item is saved, but the photo was not: ${toErr(e)?.message ?? ""} Open the item to try the photo again.` });
          return;
        }
      }
      onSaved();
    } catch (e) {
      setError(toErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" data-testid="menu-item-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {archived ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm">This item is archived. Restore it to edit it; its history and old tab lines are kept.</p> : null}
      <fieldset disabled={archived || busy} className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} maxLength={MENU_NAME_MAX} onChange={(e) => set("name", e.target.value)} required /></Field>
        <Field label="Category">
          <Select aria-label="Category" value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)} required>
            {!categories.length ? <option value="">Add a category first</option> : null}
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (inactive)"}</option>)}
          </Select>
        </Field>
        <Field label="Price (₹)" hint={detail && canPrice ? "A new price applies to new orders now; it is kept in the price book history." : "₹1 – ₹50,000"}>
          <Input inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} disabled={!!detail && !canPrice} placeholder="e.g. 180" required />
        </Field>
        <Field label="Food or drink">
          <Select aria-label="Food or drink" value={f.kind} onChange={(e) => set("kind", e.target.value as MenuKind)}>
            <option value="FOOD">Food</option>
            <option value="DRINK">Drink</option>
          </Select>
        </Field>
        {f.kind === "FOOD" ? (
          <Field label="Food type">
            <Select aria-label="Food type" value={f.foodType} onChange={(e) => set("foodType", e.target.value as FoodTypeValue | "")} required>
              <option value="">Choose…</option>
              {FOOD_TYPES.map((t) => <option key={t} value={t}>{FOOD_TYPE_LABEL[t]}</option>)}
            </Select>
          </Field>
        ) : (
          <p className="flex items-end pb-2 text-sm text-muted-foreground">Food type: not applicable for drinks.</p>
        )}
        <Field label={`Description (optional, ${f.description.length}/${MENU_DESCRIPTION_MAX})`} className="sm:col-span-2">
          <Textarea rows={2} maxLength={MENU_DESCRIPTION_MAX} value={f.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.isAlcoholic} onChange={(e) => set("isAlcoholic", e.target.checked)} />
          <span>Alcoholic <span className="text-muted-foreground">— 18+ only (never for Juniors or under-18s); billed outside GST</span></span>
        </label>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-semibold">Allergens (optional)</span>
          <div className="flex flex-wrap gap-3">
            {ALLERGENS.map((a) => (
              <label key={a} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.allergens.includes(a)} onChange={() => toggleAllergen(a)} /> {ALLERGEN_LABEL[a]}</label>
            ))}
          </div>
        </div>
        <Field label="Prep time (minutes, optional)"><Input inputMode="numeric" value={f.prepMinutes} onChange={(e) => set("prepMinutes", e.target.value)} placeholder="e.g. 10" /></Field>
        {!detail ? (
          <Field label="Status">
            <Select aria-label="Status" value={f.status} onChange={(e) => set("status", e.target.value as "DRAFT" | "ACTIVE")}>
              <option value="ACTIVE">Active — on the menu now</option>
              <option value="DRAFT">Draft — not shown yet</option>
            </Select>
          </Field>
        ) : <span />}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.available} onChange={(e) => set("available", e.target.checked)} /> Available now (untick when sold out)</label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          {detail ? <MenuItemImage url={detail.thumbUrl} icon={detail.categoryIcon} name={detail.name} className="h-20 w-20" /> : null}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">{detail?.photoUrl ? "Replace photo" : "Photo"} (optional · PNG, JPEG or WebP, up to 2 MB)</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Photo" data-testid="menu-item-photo-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span className="text-xs text-muted-foreground">No photo → members see the category icon.</span>
          </label>
        </div>
      </fieldset>
      <RejectionBanner error={error} />
      {!archived && !saved ? <Button type="submit" disabled={busy || !categories.length} className="self-start">{detail ? "Save item" : "Create item"}</Button> : null}
    </form>
  );
}

function StatusActions({ detail, onDone }: { detail: Detail; onDone: () => void }) {
  const [error, setError] = useState<Rejection>(null);
  const set = async (status: MenuStatusValue) => {
    setError(null);
    try { await api(`/api/bar/menu/${detail.id}/status`, { body: { status } }); onDone(); } catch (e) { setError(toErr(e)); }
  };
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">Status: <b>{MENU_STATUS_LABEL[detail.status]}</b></span>
        {detail.status === "DRAFT" ? <Button size="sm" onClick={() => void set("ACTIVE")}>Publish to the menu</Button> : null}
        {detail.status === "ACTIVE" ? <Button size="sm" variant="outline" onClick={() => void set("DRAFT")}>Move to drafts</Button> : null}
        {detail.status === "ARCHIVED" ? <Button size="sm" variant="outline" onClick={() => void set("DRAFT")}><ArchiveRestore className="h-4 w-4" /> Restore as draft</Button> : null}
        {detail.status !== "ARCHIVED" ? (
          <ConfirmButton
            trigger={<><Archive className="h-4 w-4" /> Archive</>}
            title={`Archive ${detail.name}?`}
            description="It leaves the menu and the bar grid. Nothing is deleted: tabs that already have it and its price history keep working, and you can restore it."
            confirmLabel="Archive"
            onConfirm={() => api(`/api/bar/menu/${detail.id}/status`, { body: { status: "ARCHIVED" } }).then(onDone)}
          />
        ) : null}
        {detail.photoUrl && detail.status !== "ARCHIVED" ? (
          <Button size="sm" variant="ghost" onClick={async () => { setError(null); try { await api(`/api/bar/menu/${detail.id}/photo`, { method: "DELETE" }); onDone(); } catch (e) { setError(toErr(e)); } }}>Remove photo</Button>
        ) : null}
      </div>
      {detail.tabLines ? <p className="text-xs text-muted-foreground">On {detail.tabLines} tab line{detail.tabLines === 1 ? "" : "s"} so far (they keep the price they were added at).</p> : null}
      <RejectionBanner error={error} />
    </div>
  );
}

function EditItem({ id, categories, canPrice, onSaved }: { id: string; categories: Category[]; canPrice: boolean; onSaved: () => void }) {
  const detail = useApi<Detail>(`/api/bar/menu/${id}`);
  const refresh = () => { void detail.reload(); onSaved(); };
  return (
    <DataState state={detail}>
      {(d) => (
        <div className="flex flex-col gap-3">
          <ItemForm key={[d.id, d.status, d.price, d.name, d.available, d.photoUrl].join("|")} detail={d} categories={categories} canPrice={canPrice} onSaved={refresh} />
          <StatusActions detail={d} onDone={refresh} />
          <PriceHistory rows={d.priceHistory} />
        </div>
      )}
    </DataState>
  );
}

/** Lives inside the list (toolbar), so saving reloads the list. */
function ItemDialogs({ categories, canPrice, editing, setEditing }: { categories: Category[]; canPrice: boolean; editing: string | null; setEditing: (id: string | null) => void }) {
  const reload = useListReload();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogTrigger asChild>
          <Button data-testid="new-menu-item" disabled={!categories.length}><Plus className="h-4 w-4" /> New item</Button>
        </DialogTrigger>
        <DialogContent title="New menu item" description="Members see it as soon as it is Active and available." wide>
          {creating ? <ItemForm detail={null} categories={categories} canPrice={canPrice} onSaved={() => { setCreating(false); reload(); }} /> : null}
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent title="Edit menu item" wide>
          {editing ? <EditItem id={editing} categories={categories} canPrice={canPrice} onSaved={reload} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AvailabilityToggle({ row }: { row: Row }) {
  const reload = useListReload();
  const [busy, setBusy] = useState(false);
  if (row.status === "ARCHIVED") return null;
  return (
    <Button
      size="sm" variant="ghost" disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try { await api(`/api/bar/menu/${row.id}`, { method: "PATCH", body: { available: !row.available } }); reload(); } finally { setBusy(false); }
      }}
    >
      {row.available ? "Mark sold out" : "Back on"}
    </Button>
  );
}

export function MenuManager({ canPrice }: { canPrice: boolean }) {
  const categories = useApi<Category[]>("/api/bar/menu/categories");
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline"><Link href="/app/bar/menu/preview" data-testid="menu-preview-link"><Eye className="h-4 w-4" /> Preview as member</Link></Button>
        <Button asChild variant="outline"><a href="/print/menu" target="_blank" rel="noopener" data-testid="menu-print-link"><Printer className="h-4 w-4" /> Print menu (A4)</a></Button>
        <Button asChild variant="outline"><a href="/print/menu/tables" target="_blank" rel="noopener" data-testid="menu-qr-link"><QrCode className="h-4 w-4" /> Table QR cards</a></Button>
      </div>
      <DataState state={categories}>
        {(cats) => (
          <>
            <Categories categories={cats} onChange={() => void categories.reload()} />
            <FilteredList<Row>
              list="menu"
              searchPlaceholder="Item, description or category"
              toolbar={<ItemDialogs categories={cats} canPrice={canPrice} editing={editing} setEditing={setEditing} />}
              onRowClick={(r) => setEditing(r.id)}
              columns={[
                { key: "photo", header: "", cell: (r) => <MenuItemImage url={r.thumb_url} icon={r.category_icon} name={r.name} className="h-12 w-12" /> },
                {
                  key: "name", header: "Item", cell: (r) => (
                    <span className="flex flex-col" data-testid="menu-row">
                      <span className="flex items-center gap-1.5 font-semibold">
                        <FoodTypeSymbol type={r.food_type} />
                        {r.name}
                        {r.is_alcoholic ? <Wine className="h-3.5 w-3.5 text-purple-700" aria-label="Alcoholic" /> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{r.category_name}{r.kind === "DRINK" ? " · drink" : ""}{r.prep_minutes ? ` · ${r.prep_minutes} min` : ""}</span>
                    </span>
                  ),
                },
                { key: "price", header: "Price", className: "text-right", cell: (r) => <Money paise={r.price} /> },
                {
                  key: "status", header: "", cell: (r) => (
                    <span className="flex flex-wrap gap-1">
                      {r.status !== "ACTIVE" ? <Badge tone={r.status === "DRAFT" ? "blue" : "neutral"}>{MENU_STATUS_LABEL[r.status]}</Badge> : null}
                      {r.status === "ACTIVE" && !r.available ? <Badge tone="amber">Sold out</Badge> : null}
                      {r.kind === "FOOD" && !r.food_type && r.status !== "ARCHIVED" ? <Badge tone="red">Food type not set</Badge> : null}
                      {!r.category_active ? <Badge tone="neutral">Category inactive</Badge> : null}
                    </span>
                  ),
                },
                { key: "actions", header: "", className: "text-right", cell: (r) => <AvailabilityToggle row={r} /> },
              ]}
              empty={{ title: "No menu items match these filters", hint: cats.length ? "Add an item with “New item”, or clear a filter." : "Add a category first, then its items." }}
            />
          </>
        )}
      </DataState>
    </div>
  );
}
