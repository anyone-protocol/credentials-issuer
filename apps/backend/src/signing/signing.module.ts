import { Module } from '@nestjs/common';
import { KeysModule } from '../keys/keys.module';
import { BlindSigner } from './blind-signer.service';
import { SignerPool } from './signer-pool';

@Module({
  imports: [KeysModule],
  providers: [BlindSigner, SignerPool],
  exports: [BlindSigner],
})
export class SigningModule {}
