import { forbidden, notFound } from "next/navigation";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/rbac/permissions";
import { isDomainError } from "@/server/errors";
import { getPayslip } from "@/server/services/payroll";
import { getSettings } from "@/server/services/settings";
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { PrintButton } from "./print-button";

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  if (!can(actor, "payroll")) forbidden();
  const { id } = await params;
  let p;
  try {
    p = await getPayslip(actor, id);
  } catch (e) {
    if (isDomainError(e, "NOT_FOUND")) notFound();
    throw e;
  }
  const s = await getSettings();
  const rows: Array<[string, string]> = [
    ["Gross monthly salary", formatINR(p.gross)],
    [`Unpaid leave (${p.unpaidDays} of ${p.daysInMonth} days)`, `− ${formatINR(p.deductions)}`],
  ];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="no-print mb-3 flex justify-end"><PrintButton /></div>
      <div className="rounded-lg border bg-white p-6 text-sm text-slate-900 print:border-0">
        <div className="flex justify-between border-b pb-3">
          <div>
            <p className="text-lg font-bold">{s.club.name}</p>
            <p>{s.club.legal_name}</p>
            <p className="max-w-xs text-xs">{s.club.address}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold">PAYSLIP</p>
            <p>Month: <strong>{p.month}</strong></p>
            <p>Run status: {p.runStatus}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 border-b py-3">
          <p>Employee: <strong>{p.name}</strong></p>
          <p>Role: {p.role.replace("_", " ")}</p>
          <p>Phone: {p.phone}</p>
          <p>Joined: {fmtDate(p.joinDate)}</p>
        </div>
        <table className="mt-3 w-full">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b"><td className="py-1">{k}</td><td className="text-right">{v}</td></tr>
            ))}
            <tr className="font-bold"><td className="py-2">Net pay</td><td className="text-right">{formatINR(p.net)}</td></tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs">{p.paidAt ? `Paid on ${new Date(p.paidAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} by ${p.method?.toLowerCase()}` : "Not yet paid"}</p>
      </div>
    </div>
  );
}
