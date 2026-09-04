import { HttpException, HttpStatus } from '@nestjs/common';

export type IssuerErrorCode =
  | 'REQUEST_INVALID'
  | 'BUNDLE_SIZE'
  | 'BLANK_FORMAT'
  | 'CLAIM_INVALID';

const STATUS: Record<IssuerErrorCode, HttpStatus> = {
  REQUEST_INVALID: HttpStatus.BAD_REQUEST,
  BUNDLE_SIZE: HttpStatus.BAD_REQUEST,
  BLANK_FORMAT: HttpStatus.BAD_REQUEST,
  CLAIM_INVALID: HttpStatus.PAYMENT_REQUIRED,
};

// Messages are written by hand and must never quote request payload bytes (I2).
export class IssuerException extends HttpException {
  constructor(readonly code: IssuerErrorCode, message: string) {
    super({ error: { code, message } }, STATUS[code]);
  }
}
