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

  // Update postmark_sendings where org_id = sourceOrgId AND brand_ids has exactly one element AND that element is sourceBrandId
  // When targetBrandId is present, also rewrite the brand reference
  const result = targetBrandId
    ? await db.execute(sql`
        UPDATE postmark_sendings
        SET org_id = ${targetOrgId}, brand_ids = ARRAY[${targetBrandId}]
        WHERE org_id = ${sourceOrgId}
          AND array_length(brand_ids, 1) = 1
          AND brand_ids[1] = ${sourceBrandId}
      `)
    : await db.execute(sql`
        UPDATE postmark_sendings
        SET org_id = ${targetOrgId}
        WHERE org_id = ${sourceOrgId}
          AND array_length(brand_ids, 1) = 1
          AND brand_ids[1] = ${sourceBrandId}
      `);

  const updatedCount = Number(result.rowCount ?? 0);

  console.log(
    `[postmark-service] Transfer complete: ${updatedCount} rows updated in postmark_sendings`
  );

  res.json({
    updatedTables: [{ tableName: "postmark_sendings", count: updatedCount }],
  });
});

export default router;
