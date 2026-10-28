import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { BYOK_MONTHLY_PRICE_CENTS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService } from "./billing.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
dbTests("referrals", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const webOrigin = "https://example.test";
  const provider = new BillingEmulator({ modelCredits: true, namespace: `referrals-${stamp}` });
  const organizations: string[] = [];
  const users: string[] = [];
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof createBillingService>;

  async function newOrganization(name: string): Promise<Actor & { organizationId: string }> {
    const id = `referral-${name}-${stamp}`;
    const createdAt = new Date();
    const email = `${id}@rakazo.test`;
    await prisma.user.create({ data: { id, name, email, emailVerified: false } });
    await prisma.organization.create({ data: { id, name, slug: id, createdAt } });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    organizations.push(id);
    users.push(id);
    return { userId: id, spaceId: id, email, isDeploymentOwner: false, organizationId: id };
  }

  async function startTrial(actor: Actor & { organizationId: string }, card?: string) {
    await service.selectFunding(actor, "byok");
    const { customerId } = (await billingAccountForOrganization(prisma, actor.organizationId))!;
    provider.completeByokCheckout(customerId, card);
    await service.sync(customerId);
    return customerId;
  }

  async function inviteCode(actor: Actor) {
    const referral = (await service.status(actor)).referral;
    return new URL(referral!.url).searchParams.get("ref")!;
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    service = createBillingService({ prisma, provider, webOrigin });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("offers an invite link only once the organization has subscribed", async () => {
    const referrer = await newOrganization("early");
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: null });
    await startTrial(referrer);
    const { referral } = await service.status(referrer);
    expect(referral).toEqual({
      url: expect.stringMatching(`^${webOrigin}/sign-up\\?ref=`),
      rewards: 0,
    });
    await expect(service.status(referrer)).resolves.toMatchObject({ referral });
  });

  it("grants the referrer a free month when the friend starts a trial with a new card", async () => {
    const referrer = await newOrganization("referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    const friendCustomer = await startTrial(friend);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(BYOK_MONTHLY_PRICE_CENTS);
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(BYOK_MONTHLY_PRICE_CENTS);
    await expect(service.status(referrer)).resolves.toMatchObject({
      referral: { rewards: 1 },
    });
  });

  it("declines a friend paying with the referrer's own card or one another account used", async () => {
    const referrer = await newOrganization("self");
    const referrerCustomer = await startTrial(referrer, "shared-card");
    const code = await inviteCode(referrer);
    const sameCard = await newOrganization("same-card");
    await service.claimReferral(sameCard, code);
    await startTrial(sameCard, "shared-card");
    const earlier = await newOrganization("earlier");
    await startTrial(earlier, "reused-card");
    const reused = await newOrganization("reused");
    await service.claimReferral(reused, code);
    await startTrial(reused, "reused-card");
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 0 } });
  });

  it("remembers a card after the organization switches to another one", async () => {
    const referrer = await newOrganization("switch-referrer");
    const referrerCustomer = await startTrial(referrer);
    const switcher = await newOrganization("switcher");
    const switcherCustomer = await startTrial(switcher, "first-card");
    provider.subscriptions.find((s) => s.customerId === switcherCustomer)!.cardFingerprint =
      "second-card";
    await service.sync(switcherCustomer);
    const friend = await newOrganization("switch-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    await startTrial(friend, "first-card");
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
  });

  it("finishes a reward a restart interrupted without granting it twice", async () => {
    const referrer = await newOrganization("restart-referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("restart-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    const friendCustomer = await startTrial(friend);
    await prisma.referral.update({
      where: { organizationId: friend.organizationId },
      data: { rewardedAt: null },
    });
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(BYOK_MONTHLY_PRICE_CENTS);
    await expect(service.status(referrer)).resolves.toMatchObject({ referral: { rewards: 1 } });
  });

  it("finishes an approved reward the same way after the referrer changes funding or the card is reused", async () => {
    const referrer = await newOrganization("decided-referrer");
    const referrerCustomer = await startTrial(referrer);
    const friend = await newOrganization("decided-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    await service.selectFunding(friend, "byok");
    const friendCustomer = (await billingAccountForOrganization(prisma, friend.organizationId))!
      .customerId;
    provider.completeByokCheckout(friendCustomer, "decided-card");
    await prisma.referral.update({
      where: { organizationId: friend.organizationId },
      data: { rewardKind: "balance" },
    });
    await prisma.modelCreditAccount.update({
      where: { organizationId: referrer.organizationId },
      data: { mode: "credits" },
    });
    const other = await newOrganization("decided-other");
    await startTrial(other, "decided-card");
    await service.sync(friendCustomer);
    expect(provider.balanceCredits.get(referrerCustomer)).toBe(BYOK_MONTHLY_PRICE_CENTS);
    await expect(service.status(referrer)).resolves.toMatchObject({
      balanceUsd: 0,
      referral: { rewards: 1 },
    });
  });

  it("ignores a claim after subscribing, for its own code, or for an unknown code", async () => {
    const referrer = await newOrganization("ignored");
    const referrerCustomer = await startTrial(referrer);
    const code = await inviteCode(referrer);
    await service.claimReferral(referrer, code);
    const late = await newOrganization("late");
    await startTrial(late);
    await service.claimReferral(late, code);
    const unknown = await newOrganization("unknown");
    await service.claimReferral(unknown, "not-a-code");
    expect(
      await prisma.referral.count({
        where: {
          organizationId: {
            in: [referrer.organizationId, late.organizationId, unknown.organizationId],
          },
        },
      }),
    ).toBe(0);
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
  });

  it("pays a credits referrer in model credits, which a balance credit would not add", async () => {
    const referrer = await newOrganization("credits");
    await service.purchaseCredits(referrer, { amountCents: 2000, monthly: true });
    const referrerCustomer = (await billingAccountForOrganization(prisma, referrer.organizationId))!
      .customerId;
    provider.completeCreditCheckout(referrerCustomer);
    await service.sync(referrerCustomer);
    const before = (await service.status(referrer)).balanceUsd!;
    const friend = await newOrganization("credits-friend");
    await service.claimReferral(friend, await inviteCode(referrer));
    await startTrial(friend);
    await expect(service.status(referrer)).resolves.toMatchObject({
      balanceUsd: before + BYOK_MONTHLY_PRICE_CENTS! / 100,
      referral: { rewards: 1 },
    });
    expect(provider.balanceCredits.get(referrerCustomer)).toBeUndefined();
  });
});
