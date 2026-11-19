/**
 * SES-EVENTS-1119: every address Postmark blocked from our product mail is blocked
 * on SES too (src/lib/ses-setup.ts planSuppressionCarry). Preview by default;
 * `--apply` writes. Idempotent. Inside the container:
 *   docker exec -w /app distribute-postmark-service-1 npx tsx scripts/carry-postmark-suppressions-to-ses.ts [--apply]
 */
import * as dotenv from "dotenv";
dotenv.config();
import { carryPostmarkSuppressionsToSes } from "../src/lib/ses-setup";

carryPostmarkSuppressionsToSes(process.argv.includes("--apply"))
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
