import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  // #swagger.tags = ['Health']
  // #swagger.summary = 'Service info'
  // #swagger.description = 'Returns service name'
  res.send("Postmark Service API");
});

router.get("/health", (req: Request, res: Response) => {
  // #swagger.tags = ['Health']
  // #swagger.summary = 'Health check'
  // #swagger.description = 'Returns service health status'
  res.status(200).json({ status: "ok", service: "postmark-service" });
});

export default router;
