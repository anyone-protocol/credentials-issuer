import { Global, Module } from '@nestjs/common';
import { ISSUER_CONFIG, loadIssuerConfig } from './issuer.config';

@Global()
@Module({
  providers: [{ provide: ISSUER_CONFIG, useFactory: () => loadIssuerConfig() }],
  exports: [ISSUER_CONFIG],
})
export class IssuerConfigModule {}
