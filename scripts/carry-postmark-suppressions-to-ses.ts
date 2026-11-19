/**
 * SES-EVENTS-1119: every address Postmark blocked from our product mail is blocked
 * on SES too (src/lib/ses-setup.ts planSuppressionCarry). Preview by default;
 * `--apply` writes. Idempotent. Inside the container:
 *   docker exec -w /app distribute-postmark-service-1 npx tsx scripts/carry-postmark-suppressions-to-ses.ts [--apply]
 */
import * as dotenv from "dotenv";
import { SES_MARKETING, SES_TRANSACTIONAL } from "../src/lib/ses-client";
/** `--account marketing` = the newsletter's SES account; default transactional. */
const accountArg = () => (process.argv.includes("marketing") ? SES_MARKETING : SES_TRANSACTIONAL);
dotenv.config();
import { carryPostmarkSuppressionsToSes } from "../src/lib/ses-setup";

carryPostmarkSuppressionsToSes(process.argv.includes("--apply"), accountArg())
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
