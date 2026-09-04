import { Module } from '@nestjs/common';
import { KeysModule } from '../keys/keys.module';
import { BlindSigner } from './blind-signer.service';

@Module({
  imports: [KeysModule],
  providers: [BlindSigner],
  exports: [BlindSigner],
})
export class SigningModule {}
