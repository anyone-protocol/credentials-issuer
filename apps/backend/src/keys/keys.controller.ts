import { Controller, Get } from '@nestjs/common';
import type { KeyDocument } from './key-document';
import { KeysService } from './keys.service';

@Controller('v1/keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  @Get('current')
  current(): KeyDocument {
    return this.keys.current();
  }
}
