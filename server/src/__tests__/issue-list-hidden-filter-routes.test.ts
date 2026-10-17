import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes hiddenOnly filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-hidden-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor: "board" | "agent" = "board") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor === "board"
        ? {
          type: "board",
          userId: "cloud-user-1",
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "owner", status: "active" }],
          source: "cloud_tenant",
          isInstanceAdmin: false,
        }
        : {
          type: "agent",
          source: "agent_key",
          agentId: randomUUID(),
          companyId,
        };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithIssues() {
    const companyId = randomUUID();
    const visibleIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(issues).values([
      { id: visibleIssueId, companyId, title: "Visible issue", status: "todo", priority: "medium" },
      {
        id: hiddenIssueId,
        companyId,
        title: "Hidden issue",
        status: "todo",
        priority: "medium",
        hiddenAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    return { companyId, visibleIssueId, hiddenIssueId };
  }

  it("leaves hidden issues out of the default list", async () => {
    const { companyId, visibleIssueId } = await seedCompanyWithIssues();

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([visibleIssueId]);
  });

  it("lists only hidden issues with hiddenOnly=true", async () => {
    const { companyId, hiddenIssueId } = await seedCompanyWithIssues();

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ hiddenOnly: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([hiddenIssueId]);
  });

  it("supports hiddenOnly in the compact view the inbox uses", async () => {
    const { companyId, hiddenIssueId } = await seedCompanyWithIssues();

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues`)
      .query({ hiddenOnly: "true", view: "compact", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([hiddenIssueId]);
  });

  it("rejects hiddenOnly for non-board actors", async () => {
    const { companyId } = await seedCompanyWithIssues();

    const res = await request(createApp(companyId, "agent"))
      .get(`/api/companies/${companyId}/issues`)
      .query({ hiddenOnly: "true", limit: "20" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "hiddenOnly=true requires board authentication" });
  });
});
