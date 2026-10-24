/**
 * LEDGER-HISTORY-1024: mark SUPPORT every past send run that named nobody and
 * rides no outcome (src/lib/send-support.ts). Preview by default; `--apply`
 * writes. Idempotent: a second run marks nothing.
 *
 * On the box, inside the container:
 *   docker exec distribute-postmark-service-1 npx tsx scripts/backfill-support-marks.ts [--apply]
 */
import * as dotenv from "dotenv";
dotenv.config();
import { backfillSendSupportMarks } from "../src/lib/send-support";

backfillSendSupportMarks(process.argv.includes("--apply"))
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
