import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 avec en-tête Retry-After (posé par ProblemDetailsFilter). */
export class TooManyRequestsException extends HttpException {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Trop de tentatives. Réessayez plus tard.',
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
