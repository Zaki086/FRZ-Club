// §9 data-integrity checklist, checked against the live database (`npm run verify:integrity`).
import { prisma } from "../db";
import { getSettings } from "./settings";

export type Check = { id: number; name: string; ok: boolean; detail: string };

const TRANSACTIONAL_TABLES = [
  "members", "guests", "memberships", "visits", "court_reservations", "bookings", "booking_players",
  "social_sessions", "social_session_courts", "social_participants", "counter_sales", "shop_orders",
  "shop_order_lines", "shop_order_events", "service_tickets", "tabs", "tab_lines", "kitchen_tickets",
  "bills", "payments", "invoices", "leads", "lead_activities", "quotes", "shifts", "attendance",
  "leave_requests", "payroll_runs", "payslips", "expense_bills",
  "cash_drawer_sessions", "data_requests", "refund_requests", "notification_deliveries", "purchase_orders", "purchase_order_lines", "stock_takes", "stock_take_lines",
];

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

async function q<T extends Row = Row>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

/** IST calendar date of a timestamptz column. */
const IST_DATE = (col: string) => `((${col}) AT TIME ZONE 'Asia/Kolkata')::date`;

export async function runIntegrityChecks(): Promise<Check[]> {
  const s = await getSettings();
  const checks: Check[] = [];

  // 1. No two non-cancelled reservations on the same court overlap (also guaranteed by the constraint).
  {
    const rows = await q(`
      SELECT a.id AS a, b.id AS b FROM court_reservations a JOIN court_reservations b
        ON a.court_id = b.court_id AND a.id < b.id AND a.period && b.period
      WHERE a.status <> 'CANCELLED' AND b.status <> 'CANCELLED' LIMIT 5`);
    const constraint = await q(`SELECT 1 FROM pg_constraint WHERE conname = 'no_court_overlap'`);
    checks.push({
      id: 1, name: "No overlapping court reservations",
      ok: rows.length === 0 && constraint.length === 1,
      detail: rows.length ? `${rows.length}+ overlaps, e.g. ${JSON.stringify(rows[0])}` : "exclusion constraint no_court_overlap present; 0 overlaps",
    });
  }

  // Player sessions (regular bookings + social participations), non-cancelled.
  const playerSessions = `
    SELECT bp.member_id, bp.guest_id, r.start_at, r.end_at, r.period, 'B:' || b.booking_code AS ref
      FROM booking_players bp JOIN bookings b ON b.id = bp.booking_id JOIN court_reservations r ON r.id = b.reservation_id
     WHERE bp.removed_at IS NULL AND b.status NOT IN ('CANCELLED', 'CANCELLED_BY_CLUB')
    UNION ALL
    SELECT sp.member_id, sp.guest_id, ss.start_at, ss.end_at, tstzrange(ss.start_at, ss.end_at, '[)'), 'S:' || ss.id
      FROM social_participants sp JOIN social_sessions ss ON ss.id = sp.session_id
     WHERE sp.status = 'JOINED' AND ss.status <> 'CANCELLED'`;

  // 2. No member has more than max_plays_per_day plays on any IST date.
  {
    const rows = await q(`
      SELECT member_id, ${IST_DATE("start_at")} AS d, count(*) AS c FROM (${playerSessions}) ps
       WHERE member_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > ${s.max_plays_per_day} LIMIT 5`);
    checks.push({
      id: 2, name: `No member has more than ${s.max_plays_per_day} plays on an IST date`,
      ok: rows.length === 0,
      detail: rows.length ? `violations: ${JSON.stringify(rows)}` : "0 violations",
    });
  }

  // 3. No player in two overlapping sessions.
  {
    const rows = await q(`
      WITH ps AS (${playerSessions})
      SELECT a.ref AS a, b.ref AS b, coalesce(a.member_id, a.guest_id) AS player FROM ps a JOIN ps b
        ON coalesce(a.member_id, '') = coalesce(b.member_id, '') AND coalesce(a.guest_id, '') = coalesce(b.guest_id, '')
       AND a.ref < b.ref AND a.period && b.period LIMIT 5`);
    checks.push({
      id: 3, name: "No player is in two overlapping sessions",
      ok: rows.length === 0,
      detail: rows.length ? `violations: ${JSON.stringify(rows)}` : "0 violations",
    });
  }

  // 4. Stock never negative / over-reserved.
  {
    const rows = await q(`SELECT sku FROM product_variants WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand LIMIT 5`);
    checks.push({ id: 4, name: "No negative stock or over-reservation", ok: rows.length === 0, detail: rows.length ? JSON.stringify(rows) : "all variants within bounds" });
  }

  // 5. Stock fields equal the sum of movements.
  {
    const rows = await q(`
      SELECT v.sku, v.on_hand, v.reserved, coalesce(m.oh, 0) AS mov_on_hand, coalesce(m.rs, 0) AS mov_reserved
        FROM product_variants v LEFT JOIN (
          SELECT variant_id, sum(qty_on_hand_delta) AS oh, sum(qty_reserved_delta) AS rs FROM stock_movements GROUP BY 1
        ) m ON m.variant_id = v.id
       JOIN products p ON p.id = v.product_id
       WHERE p.track_stock AND (v.on_hand <> coalesce(m.oh, 0) OR v.reserved <> coalesce(m.rs, 0)) LIMIT 5`);
    const total = await q(`SELECT count(*) AS c FROM product_variants`);
    checks.push({
      id: 5, name: "Stock levels equal the sum of stock movements",
      ok: rows.length === 0,
      detail: rows.length ? `mismatch: ${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}` : `${n(total[0]?.c)} variants reconcile`,
    });
  }

  // 6. Every bill: amount_paid − amount_refunded = sum of its ledger entries + refunds still owed (PENDING);
  //    paid/refunded = payments.
  {
    const rows = await q(`
      SELECT b.id, b.amount_paid - b.amount_refunded AS net, coalesce(l.s, 0) AS ledger, coalesce(p.owed, 0) AS owed,
             coalesce(p.paid, 0) AS paid, coalesce(p.refunded, 0) AS refunded, b.amount_paid, b.amount_refunded
        FROM bills b
        LEFT JOIN (SELECT bill_id, sum(amount) AS s FROM ledger_entries WHERE bill_id IS NOT NULL GROUP BY 1) l ON l.bill_id = b.id
        LEFT JOIN (SELECT bill_id, sum(amount) FILTER (WHERE type = 'PAYMENT' AND status = 'SUCCEEDED') AS paid,
                          sum(amount) FILTER (WHERE type = 'REFUND' AND status IN ('SUCCEEDED', 'PENDING')) AS refunded,
                          sum(amount) FILTER (WHERE type = 'REFUND' AND status = 'PENDING') AS owed
                     FROM payments GROUP BY 1) p ON p.bill_id = b.id
       WHERE b.amount_paid - b.amount_refunded <> coalesce(l.s, 0) - coalesce(p.owed, 0)
          OR b.amount_paid <> coalesce(p.paid, 0) OR b.amount_refunded <> coalesce(p.refunded, 0)
       LIMIT 5`);
    const count = await q(`SELECT count(*) AS c FROM bills`);
    checks.push({
      id: 6, name: "Every bill's paid − refunded equals its ledger entries",
      ok: rows.length === 0,
      detail: rows.length ? `mismatch: ${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}` : `${n(count[0]?.c)} bills reconcile`,
    });
  }

  // 7. Dashboard total = sum by source = sum by method (all time, and per IST month).
  {
    const rows = await q(`
      WITH m AS (SELECT to_char(occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, source, method, amount
                   FROM ledger_entries WHERE direction = 'IN'),
           t AS (SELECT month, sum(amount) AS total FROM m GROUP BY 1),
           bs AS (SELECT month, sum(s) AS total FROM (SELECT month, source, sum(amount) AS s FROM m GROUP BY 1, 2) x GROUP BY 1),
           bm AS (SELECT month, sum(s) AS total FROM (SELECT month, method, sum(amount) AS s FROM m GROUP BY 1, 2) x GROUP BY 1)
      SELECT t.month, t.total, bs.total AS by_source, bm.total AS by_method
        FROM t JOIN bs USING (month) JOIN bm USING (month)
       WHERE t.total <> bs.total OR t.total <> bm.total`);
    const pay = await q(`
      SELECT (SELECT coalesce(sum(CASE WHEN type = 'PAYMENT' THEN amount ELSE -amount END), 0) FROM payments WHERE status = 'SUCCEEDED') AS payments,
             (SELECT coalesce(sum(amount), 0) FROM ledger_entries WHERE direction = 'IN') AS ledger_in`);
    const ok = rows.length === 0 && n(pay[0]?.payments) === n(pay[0]?.ledger_in);
    checks.push({
      id: 7, name: "Collected total = sum by source = sum by method = sum of payments",
      ok,
      detail: ok ? `ledger IN ${n(pay[0]?.ledger_in)} paise = net successful payments` : `mismatch ${JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v))} payments=${n(pay[0]?.payments)} ledger=${n(pay[0]?.ledger_in)}`,
    });
  }

  // 8. Every paid membership has an invoice; invoice numbers unique per FY.
  {
    const missing = await q(`
      SELECT m.id FROM memberships m JOIN bills b ON b.id = m.bill_id
       WHERE b.status = 'PAID' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.bill_id = b.id AND i.number IS NOT NULL) LIMIT 5`);
    const dups = await q(`SELECT fy, number, count(*) FROM invoices WHERE number IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1`);
    checks.push({
      id: 8, name: "Every paid membership has an invoice; invoice numbers unique per FY",
      ok: missing.length === 0 && dups.length === 0,
      detail: missing.length || dups.length ? `missing=${JSON.stringify(missing)} duplicates=${JSON.stringify(dups)}` : "all paid memberships invoiced; numbering unique",
    });
  }

  // 9. No Junior / under-18 member has an alcoholic line on their tab.
  {
    const rows = await q(`
      SELECT t.code, mi.name, mem.name AS member FROM tab_lines tl
        JOIN tabs t ON t.id = tl.tab_id JOIN menu_items mi ON mi.id = tl.menu_item_id
        JOIN members mem ON mem.id = t.member_id
       WHERE tl.status <> 'VOID' AND mi.is_alcoholic
         AND (age(${IST_DATE("tl.created_at")}, mem.dob) < interval '18 years'
              OR EXISTS (SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id
                          WHERE ms.member_id = mem.id AND p.code = 'JUNIOR'
                            AND ms.status NOT IN ('PENDING_PAYMENT', 'CANCELLED')
                            AND ${IST_DATE("tl.created_at")} BETWEEN ms.start_date AND ms.end_date))
       LIMIT 5`);
    checks.push({ id: 9, name: "No Junior or under-18 member has an alcoholic line", ok: rows.length === 0, detail: rows.length ? JSON.stringify(rows) : "0 violations" });
  }

  // 10. No transactional record has been hard-deleted: delete-blocking triggers present on every table,
  //     and every entity the audit log says was created still exists.
  {
    const trig = await q<{ tbl: string }>(`
      SELECT c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE '%_no_delete' AND NOT t.tgisinternal`);
    const have = new Set(trig.map((r) => r.tbl));
    const missing = TRANSACTIONAL_TABLES.filter((t) => !have.has(t));
    const orphans = await q(`
      SELECT a.entity, a.entity_id FROM audit_logs a
       WHERE a.action IN ('booking.create', 'member.create', 'shop_order.create', 'tab.open', 'lead.create', 'invoice.create')
         AND NOT EXISTS (
           SELECT 1 FROM bookings WHERE id = a.entity_id UNION ALL SELECT 1 FROM members WHERE id = a.entity_id
           UNION ALL SELECT 1 FROM shop_orders WHERE id = a.entity_id UNION ALL SELECT 1 FROM tabs WHERE id = a.entity_id
           UNION ALL SELECT 1 FROM leads WHERE id = a.entity_id UNION ALL SELECT 1 FROM invoices WHERE id = a.entity_id)
       LIMIT 5`);
    checks.push({
      id: 10, name: "No transactional record has been hard-deleted",
      ok: missing.length === 0 && orphans.length === 0,
      detail: missing.length || orphans.length
        ? `tables without delete guard: ${missing.join(", ") || "none"}; audited-but-missing: ${JSON.stringify(orphans)}`
        : `delete guards on ${TRANSACTIONAL_TABLES.length} tables; every audited creation still exists`,
    });
  }

  // 11 · v3 RF-5/RF-7: every refund payment belongs to a refund request whose state matches its money.
  {
    const rows = await q(`
      WITH p AS (
        SELECT r.id, r.code, r.status, r.amount,
               COALESCE(sum(x.amount) FILTER (WHERE x.status = 'SUCCEEDED'), 0)::int AS paid,
               COALESCE(sum(x.amount) FILTER (WHERE x.status = 'PENDING'), 0)::int AS pending
          FROM refund_requests r LEFT JOIN payments x ON x.refund_request_id = r.id AND x.type = 'REFUND'
         GROUP BY r.id)
      SELECT code, status, amount, paid, pending FROM p
       WHERE (status = 'COMPLETED' AND (paid <> amount OR pending <> 0))
          OR (status = 'APPROVED' AND (paid + pending <> amount OR pending = 0) AND paid + pending <> 0)
          OR (status IN ('REQUESTED', 'REJECTED', 'CANCELLED', 'FAILED') AND (paid <> 0 OR pending <> 0))
      UNION ALL
      SELECT 'payment ' || id, 'no request', amount, 0, 0 FROM payments WHERE type = 'REFUND' AND refund_request_id IS NULL
      LIMIT 10`);
    checks.push({
      id: 11, name: "Every refund belongs to a refund request whose state matches its payments",
      ok: rows.length === 0, detail: rows.length ? JSON.stringify(rows) : "requests and refund payments agree",
    });
  }

  return checks;
}
