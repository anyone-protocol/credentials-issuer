import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { KeysService } from '../keys/keys.service';

/**
 * Liveness for Docker and Nomad. Fails when the advertised epoch has expired:
 * an issuer whose keyring nobody rotated keeps answering requests and signs
 * nothing, so reporting ok there would hide the outage rather than raise it.
 */
@Controller('healthz')
export class HealthController {
  constructor(private readonly keys: KeysService) {}

  @Get()
  health() {
    const { epoch, usable, expiresInSeconds } = this.keys.signingHealth();
    const body = { status: usable ? 'ok' : 'degraded', epoch, expires_in_seconds: expiresInSeconds };

    if (!usable) {
      throw new ServiceUnavailableException({
        ...body,
        reason: 'no usable epoch key; the keyring needs a rotation',
      });
    }
    return body;
  }
}
