// v4 §5.1 WhatsApp opt-in for existing members (portal toggle). New people tick the box on the sign-up, trial or
// enquiry form (membership.ts / crm.ts store it with the time). A "STOP" reply on WhatsApp records the opt-out
// (webhook.ts). Messages about a Junior go to the guardian's login, so the guardian's own choice applies.
import { z } from "zod";
import { clock } from "@/lib/clock";
import { prisma, withTx } from "../../db";
import { DomainError } from "../../errors";
import { isMember, type Actor } from "../../rbac/actor";
import { audit } from "../audit";
import { getCapabilities } from "../capabilities";
import { isOptedIn } from "./config";

function memberOf(actor: Actor): string {
  if (!isMember(actor)) throw new DomainError("FORBIDDEN", "Only members can change this.");
  return actor.memberId;
}

/** WA-31: the member's own WhatsApp consent, as the portal shows it. */
export async function myWhatsappOptIn(actor: Actor) {
  const memberId = memberOf(actor);
  const [m, caps] = await Promise.all([
    prisma.member.findUniqueOrThrow({ where: { id: memberId }, select: { phone: true, whatsappOptInAt: true, whatsappOptOutAt: true, guardianMemberId: true } }),
    getCapabilities(),
  ]);
  const juniors = await prisma.member.count({ where: { guardianMemberId: memberId } });
  return {
    optedIn: isOptedIn(m),
    optInAt: m.whatsappOptInAt,
    optOutAt: m.whatsappOptOutAt,
    phoneLast4: m.phone.slice(-4),
    automatic: caps["whatsapp.api"].enabled,
    juniors,
  };
}

export const whatsappOptInSchema = z.object({ optIn: z.boolean() });

/** WA-32: turn automatic WhatsApp updates on (consent with the time) or off. Audited. */
export async function setMyWhatsappOptIn(actor: Actor, raw: z.input<typeof whatsappOptInSchema>) {
  const memberId = memberOf(actor);
  const { optIn } = whatsappOptInSchema.parse(raw);
  await withTx(async (tx) => {
    const before = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { userId: true, whatsappOptInAt: true, whatsappOptOutAt: true } });
    const now = clock.now();
    await tx.member.update({ where: { id: memberId }, data: optIn ? { whatsappOptInAt: now } : { whatsappOptOutAt: now } });
    // Opting in is asking for WhatsApp: the member's WhatsApp channel (v3 preference) is switched on with it.
    if (optIn && before.userId) await tx.user.update({ where: { id: before.userId }, data: { notifyWhatsapp: true } });
    await audit(tx, actor, optIn ? "whatsapp.opt_in" : "whatsapp.opt_out", "member", memberId, {
      before: { optedIn: isOptedIn(before) },
      after: { optedIn: optIn, at: now.toISOString(), via: "portal" },
    });
  });
  return myWhatsappOptIn(actor);
}
