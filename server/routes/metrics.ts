import { timingSafeEqual } from "node:crypto";
import { requireAdmin } from "../auth";
import { backupStatus } from "../backup";
import { walCheckpointStatus } from "../db";
import { ApiError, ok } from "../http";
import { httpMetricsSnapshot, maintenanceMetricsSnapshot, sqliteMetricsSnapshot } from "../metrics";
import { admissionSnapshot } from "../ratelimit";
import { retentionStatus } from "../usage-rollup";
import { usageReaderStatus } from "../usage-reader";

/** Optional read-only scraper credential; never grants general administration. */
function hasMetricsToken(req: Request): boolean {
  const configured = process.env.GATEWAY_METRICS_TOKEN;
  if (!configured || configured.length < 32) return false;
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(configured);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function handleMetricsRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/api/admin/metrics") return null;
  if (!hasMetricsToken(req)) await requireAdmin(req);
  if (req.method !== "GET") throw new ApiError(405, "method not allowed");
  const result = {
    ...httpMetricsSnapshot(),
    admission: admissionSnapshot(),
    analytics: usageReaderStatus(),
    maintenance: maintenanceMetricsSnapshot(),
    storage: { ...sqliteMetricsSnapshot(), checkpoints: walCheckpointStatus() },
    retention: retentionStatus(),
    backup: backupStatus(),
  };
  const response = ok({ metrics: result }, req);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
