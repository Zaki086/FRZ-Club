import { body, route } from "@/server/http";
import { decideApproval, decideApprovalSchema } from "@/server/services/approvals";

// v4 RN-4: inline Approve / Reject (reason required to reject); the decision is made by the kind's own service.
export const POST = route(async ({ req, actor }) => decideApproval(actor, await body(req, decideApprovalSchema)));
