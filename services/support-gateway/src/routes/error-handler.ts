import { z } from 'zod';
import type { ErrorRequestHandler } from 'express';
import { SupportProviderError } from '../domain/types.js';

// Appendix A.2 error translation, shared across every router that can throw a
// SupportProviderError or fail zod validation. Mounted once, at the app level.
export const supportErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ code: 'SUPPORT_REQUEST_INVALID', message: error.issues.map((i) => i.message).join(', ') });
    return;
  }
  if (error instanceof SupportProviderError) {
    const statusByCode: Record<string, number> = {
      SUPPORT_PROVIDER_IDENTITY_INVALID: 401,
      SUPPORT_PROVIDER_ACCESS_DENIED: 403,
      SUPPORT_CONVERSATION_NOT_FOUND: 404,
      SUPPORT_STATE_CONFLICT: 409,
      SUPPORT_PROVIDER_RATE_LIMITED: 429,
      SUPPORT_PROVIDER_UNAVAILABLE: 503,
      SUPPORT_PROVIDER_CONTRACT_ERROR: 502,
    };
    res.status(statusByCode[error.code] ?? 500).json({ code: error.code, message: error.message });
    return;
  }
  res.status(500).json({ code: 'SUPPORT_PROVIDER_CONTRACT_ERROR', message: 'Unexpected gateway error' });
};
