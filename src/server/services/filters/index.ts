// Registry of every filterable list (v3 §3.2). `/api/lists/<name>` and its CSV export run through here.
import { DomainError } from "../../errors";
import type { Actor } from "../../rbac/actor";
import { listCsv, runList, type ListDef } from "./core";
import { bookingsList } from "./bookings";
import { leadsList } from "./leads";
import { membersList } from "./members";
import { drawersList, myDrawerMovementsList } from "./drawers";
import { productsList } from "./products";
import { tabsList } from "./tabs";
import { barDaysList } from "./bar-days";
import { socialList } from "./social";
import { socialParticipantsList } from "./social-participants";
import { visitsList } from "./visits";
import { shiftsList } from "./shifts";
import { leaveList } from "./leave";
import { auditList } from "./audit";
import { usersList } from "./users";
import { dataRequestsList } from "./data-requests";
import { messagesList, whatsappLogList } from "./messages";
import { ordersList } from "./orders";
import { salesList } from "./sales";
import { stockList } from "./stock";
import { movementsList } from "./movements";
import { purchaseOrdersList } from "./purchase-orders";
import { stockTakesList } from "./stock-takes";
import { clientsList } from "./clients";
import { expensesList } from "./expenses";
import { invoicesList } from "./invoices";
import { ledgerList } from "./ledger";
import { payrollList } from "./payroll";
import { notificationsList, renewalsList } from "./notifications";
import { refundsList } from "./refunds";
import { attendanceList, attendanceSummaryList, employeesList } from "./staff";
import { menuItemsList } from "./menu"; // v5 §1.1 (MENU)

export const LISTS: Record<string, ListDef> = {
  [membersList.name]: membersList,
  [bookingsList.name]: bookingsList,
  [leadsList.name]: leadsList,
  [employeesList.name]: employeesList,
  [refundsList.name]: refundsList,
  [drawersList.name]: drawersList,
  [myDrawerMovementsList.name]: myDrawerMovementsList,
  [productsList.name]: productsList,
  [tabsList.name]: tabsList,
  [barDaysList.name]: barDaysList,
  [socialList.name]: socialList,
  [socialParticipantsList.name]: socialParticipantsList,
  [visitsList.name]: visitsList,
  [shiftsList.name]: shiftsList,
  [leaveList.name]: leaveList,
  [auditList.name]: auditList,
  [usersList.name]: usersList,
  [dataRequestsList.name]: dataRequestsList,
  [messagesList.name]: messagesList,
  [whatsappLogList.name]: whatsappLogList,
  [ordersList.name]: ordersList,
  [salesList.name]: salesList,
  [stockList.name]: stockList,
  [movementsList.name]: movementsList,
  [purchaseOrdersList.name]: purchaseOrdersList,
  [stockTakesList.name]: stockTakesList,
  [invoicesList.name]: invoicesList,
  [clientsList.name]: clientsList,
  [expensesList.name]: expensesList,
  [payrollList.name]: payrollList,
  [ledgerList.name]: ledgerList,
  [notificationsList.name]: notificationsList,
  [renewalsList.name]: renewalsList,
  [attendanceList.name]: attendanceList,
  [attendanceSummaryList.name]: attendanceSummaryList,
  [menuItemsList.name]: menuItemsList, // v5 §1.1 (MENU)
};

function def(name: string): ListDef {
  const d = LISTS[name];
  if (!d) throw new DomainError("NOT_FOUND", "List was not found.");
  return d;
}

export const listView = (actor: Actor, name: string, params: Record<string, string>) => runList(def(name), actor, params);
export const listExport = (actor: Actor, name: string, params: Record<string, string>) => listCsv(def(name), actor, params);
