/**
 * SES-EVENTS-1119: SNS topic + SES configuration set + event destination + HTTPS
 * subscription to POST /webhooks/ses. Idempotent. Inside the container:
 *   docker exec -w /app distribute-postmark-service-1 npx tsx scripts/setup-ses-events.ts
 */
import * as dotenv from "dotenv";
dotenv.config();
import { setupSesEvents } from "../src/lib/ses-setup";

setupSesEvents()
  .then((log) => {
    console.log(log.join("\n"));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
