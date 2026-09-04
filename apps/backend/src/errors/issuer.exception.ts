import { HttpException, HttpStatus } from '@nestjs/common';

export type IssuerErrorCode =
  | 'REQUEST_INVALID'
  | 'BUNDLE_SIZE'
  | 'BLANK_FORMAT'
  | 'CLAIM_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'WRONG_EPOCH'
  | 'RECEIPT_INVALID'
  | 'ENTITLEMENT_UNKNOWN'
  | 'NOT_DUE';

const STATUS: Record<IssuerErrorCode, HttpStatus> = {
  REQUEST_INVALID: HttpStatus.BAD_REQUEST,
  BUNDLE_SIZE: HttpStatus.BAD_REQUEST,
  BLANK_FORMAT: HttpStatus.BAD_REQUEST,
  CLAIM_INVALID: HttpStatus.PAYMENT_REQUIRED,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  WRONG_EPOCH: HttpStatus.BAD_REQUEST,
  RECEIPT_INVALID: HttpStatus.BAD_REQUEST,
  ENTITLEMENT_UNKNOWN: HttpStatus.NOT_FOUND,
  NOT_DUE: HttpStatus.CONFLICT,
};

// Messages are written by hand and must never quote request payload bytes (I2).
export class IssuerException extends HttpException {
  constructor(readonly code: IssuerErrorCode, message: string) {
    super({ error: { code, message } }, STATUS[code]);
  }
}
