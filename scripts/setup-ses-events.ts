/**
 * SES-EVENTS-1119: SNS topic + SES configuration set + event destination + HTTPS
 * subscription to POST /webhooks/ses. Idempotent. Inside the container:
 *   docker exec -w /app distribute-postmark-service-1 npx tsx scripts/setup-ses-events.ts
 */
import * as dotenv from "dotenv";
import { SES_MARKETING, SES_TRANSACTIONAL } from "../src/lib/ses-client";
/** `--account marketing` = the newsletter's SES account; default transactional. */
const accountArg = () => (process.argv.includes("marketing") ? SES_MARKETING : SES_TRANSACTIONAL);
dotenv.config();
import { setupSesEvents } from "../src/lib/ses-setup";

setupSesEvents(accountArg())
  .then((log) => {
    console.log(log.join("\n"));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
