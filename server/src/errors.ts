import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** An expected failure with a stable machine-readable code, sent as `{ error, message }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorBody {
  error: string;
  message: string;
}

export function errorHandler(error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    void reply.code(error.statusCode).send({ error: error.code, message: error.message } satisfies ErrorBody);
    return;
  }
  if ('validation' in error && error.validation) {
    void reply.code(400).send({ error: 'invalid_request', message: error.message } satisfies ErrorBody);
    return;
  }
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status === 429) {
    void reply.code(429).send({ error: 'rate_limited', message: error.message } satisfies ErrorBody);
    return;
  }
  if (status >= 400 && status < 500) {
    void reply.code(status).send({ error: 'bad_request', message: error.message } satisfies ErrorBody);
    return;
  }
  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send({ error: 'internal', message: 'Internal server error' } satisfies ErrorBody);
}
