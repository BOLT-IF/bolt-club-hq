import { and, eq } from "drizzle-orm";

import { member, notificationPref } from "../../../../db/schema";
import type { NotificationPolicy } from "../policy";

/**
 * Mute (PLAN §10, first in the chain). Everything is on by default: a member with no
 * `notification_pref` row gets pushes. `member.global_mute` beats any per-category setting.
 * Muting only drops the push; the inbox row is written before the chain runs.
 */
const mute: NotificationPolicy = {
  id: "mute",
  order: 10,
  async evaluate({ db, notification }) {
    const [row] = await db
      .select({ globalMute: member.globalMute, categoryMuted: notificationPref.muted })
      .from(member)
      .leftJoin(
        notificationPref,
        and(
          eq(notificationPref.memberId, member.id),
          eq(notificationPref.category, notification.category),
        ),
      )
      .where(eq(member.id, notification.memberId));
    if (row?.globalMute) return { action: "suppress", reason: "global mute" };
    if (row?.categoryMuted) return { action: "suppress", reason: "category muted" };
    return { action: "allow" };
  },
};

export default mute;
