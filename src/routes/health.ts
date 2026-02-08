import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  res.send("Postmark Service API");
});

router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "postmark-service" });
});

export default router;
