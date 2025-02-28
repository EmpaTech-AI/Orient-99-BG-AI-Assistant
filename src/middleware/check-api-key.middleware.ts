import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class CheckApiKeyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const apiKey = req.headers['x-api-key'];
    const SECURITY_API_KEY = process.env.SECURITY_API_KEY;

    if (apiKey !== SECURITY_API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      next();
    }
  }
}