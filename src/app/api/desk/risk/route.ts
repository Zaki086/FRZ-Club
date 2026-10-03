import { route } from "@/server/http";
import { checkinRisks } from "@/server/services/checkin-risk";

// v4 §1.2 Check-in Risk: arrivals (today and the next 2 hours) that will hit a problem at the desk.
export const GET = route(async ({ actor }) => checkinRisks(actor));
