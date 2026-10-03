"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/components/api";
import { DataState } from "@/components/states";
import { PlansTab } from "./plans-tab";
import { PoliciesTab } from "./policies-tab";
import { TaxTab } from "./tax-tab";
import { ClubTab } from "./club-tab";
import { CourtsTab } from "./courts-tab";
import { UsersTab } from "./users-tab";
import { PaymentsTab } from "./payments-tab";
import type { SettingRow } from "./shared";

export function SettingsTabs({ selfUserId }: { selfUserId: string }) {
  const settings = useApi<SettingRow[]>("/api/settings");
  const taxUnverified = settings.data?.find((r) => r.key === "tax_rates")?.verified === false;
  return (
    <Tabs defaultValue="plans">
      <TabsList>
        <TabsTrigger value="plans">Plans & fees</TabsTrigger>
        <TabsTrigger value="policies">Hours & policies</TabsTrigger>
        <TabsTrigger value="tax">Tax rates{taxUnverified ? " ⚠" : ""}</TabsTrigger>
        <TabsTrigger value="club">Club details</TabsTrigger>
        <TabsTrigger value="payments">Payments & services</TabsTrigger>
        <TabsTrigger value="courts">Courts</TabsTrigger>
        <TabsTrigger value="users">Users & roles</TabsTrigger>
      </TabsList>
      <div className="mt-3">
        <TabsContent value="plans">
          <PlansTab />
        </TabsContent>
        <TabsContent value="policies">
          <DataState state={settings}>{(rows) => <PoliciesTab rows={rows} onSaved={() => void settings.reload()} />}</DataState>
        </TabsContent>
        <TabsContent value="tax">
          <DataState state={settings}>{(rows) => <TaxTab rows={rows} onSaved={() => void settings.reload()} />}</DataState>
        </TabsContent>
        <TabsContent value="club">
          <DataState state={settings}>{(rows) => <ClubTab rows={rows} onSaved={() => void settings.reload()} />}</DataState>
        </TabsContent>
        <TabsContent value="payments">
          <DataState state={settings}>{(rows) => <PaymentsTab rows={rows} onSaved={() => void settings.reload()} />}</DataState>
        </TabsContent>
        <TabsContent value="courts">
          <CourtsTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab selfUserId={selfUserId} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
