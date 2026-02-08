import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas";
import * as fs from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Postmark Service API",
    description:
      "Email sending and tracking service built on Postmark. Handles email delivery via the broadcast message stream, webhook processing for delivery events, and integrates with a runs-service for cost tracking.",
    version: "1.0.0",
  },
  servers: [
    { url: "http://localhost:3010", description: "Local development" },
  ],
  tags: [
    { name: "Health", description: "Health check endpoints" },
    { name: "Email Sending", description: "Send emails via Postmark" },
    { name: "Email Status", description: "Query email delivery status" },
    { name: "Webhooks", description: "Postmark webhook handlers" },
  ],
});

fs.writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
