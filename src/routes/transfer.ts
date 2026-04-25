import { Router, Request, Response } from "express";
import { db } from "../db";
import { postmarkSendings } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { TransferBrandRequestSchema } from "../schemas";

const router = Router();

/**
 * POST /internal/transfer-brand
 * Transfer solo-brand rows from one org to another.
 * Only updates postmark_sendings rows where brand_ids = [brandId] (exactly one element).
 */
router.post("/transfer-brand", async (req: Request, res: Response) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.message });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  console.log(
    `[postmark-service] Transfer brand ${sourceBrandId} from org ${sourceOrgId} to org ${targetOrgId}${targetBrandId ? ` (rewrite to ${targetBrandId})` : ""}`
  );

  // Step 1: Move solo-brand rows from sourceOrg to targetOrg
  const step1 = await db.execute(sql`
    UPDATE postmark_sendings
    SET org_id = ${targetOrgId}
    WHERE org_id = ${sourceOrgId}
      AND array_length(brand_ids, 1) = 1
      AND brand_ids[1] = ${sourceBrandId}
  `);
  const movedCount = Number(step1.rowCount ?? 0);

  // Step 2: If targetBrandId provided, rewrite all references to sourceBrandId (no org filter)
  let rewrittenCount = 0;
  if (targetBrandId) {
    const step2 = await db.execute(sql`
      UPDATE postmark_sendings
      SET brand_ids = array_replace(brand_ids, ${sourceBrandId}, ${targetBrandId})
      WHERE ${sourceBrandId} = ANY(brand_ids)
    `);
    rewrittenCount = Number(step2.rowCount ?? 0);
  }

  const updatedCount = movedCount + rewrittenCount;

  console.log(
    `[postmark-service] Transfer complete: ${updatedCount} rows updated in postmark_sendings`
  );

  res.json({
    updatedTables: [{ tableName: "postmark_sendings", count: updatedCount }],
  });
});

export default router;
