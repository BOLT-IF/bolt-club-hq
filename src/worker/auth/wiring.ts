import { eq } from "drizzle-orm";

import { member } from "../../../db/schema";
import { audit } from "../core/audit";
import { systemClock, type Clock } from "../core/clock";
import { memberLookup, type RequestDeps } from "../core/context";
import type { Db } from "../core/db/client";
import { createAuthenticator, envString } from "./clerk";
import { displayNameFor, isBootstrapEmail, newPaymentRef } from "./members";
import { createProfileLoader, type ProfileLoader } from "./profile";

export interface ClerkDepsOptions {
  clock?: Clock;
  fetch?: typeof fetch;
  profile?: ProfileLoader;
}

type Row = typeof member.$inferSelect;

async function findByClerkId(db: Db, clerkUserId: string): Promise<Row | undefined> {
  const [row] = await db.select().from(member).where(eq(member.clerkUserId, clerkUserId));
  return row;
}

/**
 * Production request deps for Clerk (S1.1): bearer verification, and a member port that
 * creates a pending Member on first sign-in and re-asserts the bootstrap admin.
 */
export function clerkRequestDeps(
  options: ClerkDepsOptions = {},
): Pick<RequestDeps, "authenticate" | "currentMember"> {
  const clock = options.clock ?? systemClock;
  const loadProfile = options.profile ?? createProfileLoader(options.fetch);
  const authenticate = createAuthenticator({
    clock,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  async function createPending(db: Db, env: Cloudflare.Env, clerkUserId: string): Promise<void> {
    const profile = await loadProfile(env, clerkUserId);
    const admin = isBootstrapEmail(profile.email, envString(env, "BOOTSTRAP_ADMIN_EMAIL"));
    const now = clock.now();
    for (let attempt = 1; ; attempt++) {
      try {
        // One transaction, so the audit row exists exactly when the member row does.
        // The unique clerk_user_id serialises concurrent first requests: the losers'
        // inserts wait for the winner and then do nothing.
        await db.transaction(async (tx) => {
          const id = `mem_${crypto.randomUUID()}`;
          const [created] = await tx
            .insert(member)
            .values({
              id,
              clerkUserId,
              displayName: displayNameFor(profile),
              email: profile.email,
              role: admin ? "admin" : "member",
              status: admin ? "active" : "pending",
              paymentRef: newPaymentRef(),
              joinedAt: admin ? now : null,
            })
            .onConflictDoNothing({ target: member.clerkUserId })
            .returning();
          if (created) {
            await audit(
              tx,
              clock,
              {
                actorId: null,
                action: "member.created",
                entity: "member",
                entityId: created.id,
                after: { role: created.role, status: created.status },
              },
              crypto.randomUUID(),
            );
          }
        });
        return;
      } catch (error) {
        // A payment_ref collision (about 1 in 10^9) is the only retryable failure.
        if (attempt >= 3) throw error;
      }
    }
  }

  async function reassertBootstrap(db: Db, env: Cloudflare.Env, row: Row): Promise<void> {
    if (row.status === "erased") return;
    if (!isBootstrapEmail(row.email, envString(env, "BOOTSTRAP_ADMIN_EMAIL"))) return;
    if (row.role === "admin" && row.status === "active") return;
    await db.transaction(async (tx) => {
      await tx
        .update(member)
        .set({
          role: "admin",
          status: "active",
          joinedAt: row.joinedAt ?? clock.now(),
          leftAt: null,
        })
        .where(eq(member.id, row.id));
      await audit(
        tx,
        clock,
        {
          actorId: null,
          action: "member.bootstrap_admin",
          entity: "member",
          entityId: row.id,
          before: { role: row.role, status: row.status },
          after: { role: "admin", status: "active" },
        },
        crypto.randomUUID(),
      );
    });
  }

  return {
    authenticate,
    currentMember: (db, env) => ({
      async currentMember({ clerkUserId }) {
        let row = await findByClerkId(db, clerkUserId);
        if (!row) {
          await createPending(db, env, clerkUserId);
          row = await findByClerkId(db, clerkUserId);
        }
        if (!row) return null;
        await reassertBootstrap(db, env, row);
        return memberLookup(db).currentMember({ clerkUserId });
      },
    }),
  };
}
