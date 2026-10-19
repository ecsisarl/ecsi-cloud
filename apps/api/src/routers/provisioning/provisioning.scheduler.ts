import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { safeErrorMessage } from '../../common/safe-error.js';
import type { HotspotProvisioner } from './provisioner.js';

export const HOTSPOT_PROVISIONER = Symbol('HOTSPOT_PROVISIONER');

/** Recherche des Hotspots à synchroniser. */
export const PROVISION_TICK_MS = 10_000;
/** Entretien RADIUS (radius.housekeeping) : au démarrage puis toutes les 5 minutes. */
export const HOUSEKEEPING_EVERY_MS = 300_000;

/**
 * Boucle de provisionnement Hotspot du worker, à côté de la supervision (même processus,
 * cycles indépendants, jamais deux cycles en parallèle). Sans RADIUS_NAS_KEY, le
 * provisionnement est désactivé (provisioner null) : l'entretien RADIUS tourne quand même
 * s'il est fourni par le module.
 */
@Injectable()
export class ProvisioningScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Provisionnement');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastHousekeepingAt = 0;

  constructor(
    @Inject(HOTSPOT_PROVISIONER)
    private readonly provisioner: {
      runCycle: HotspotProvisioner['runCycle'];
      housekeeping: HotspotProvisioner['housekeeping'];
      enabled: boolean;
    },
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      this.provisioner.enabled
        ? 'Provisionnement Hotspot actif (compte ecsi-cfg, REST HTTPS épinglé)'
        : 'Provisionnement Hotspot désactivé : RADIUS_NAS_KEY absente',
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, PROVISION_TICK_MS);
    void this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      if (this.provisioner.enabled) {
        try {
          await this.provisioner.runCycle();
        } catch (error) {
          this.logger.error(`Cycle de provisionnement en échec : ${safeErrorMessage(error)}`);
        }
      }
      await this.housekeepingIfDue();
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async housekeepingIfDue(): Promise<void> {
    if (Date.now() - this.lastHousekeepingAt < HOUSEKEEPING_EVERY_MS) return;
    this.lastHousekeepingAt = Date.now();
    try {
      const done = await this.provisioner.housekeeping();
      this.logger.log(
        `Entretien RADIUS : ${done.expired} ticket(s) expiré(s), ${done.staleSessions} session(s) orpheline(s) fermée(s), ${done.purgedPostauth} ligne(s) de journal purgée(s)`,
      );
    } catch (error) {
      this.logger.error(`Entretien RADIUS en échec : ${safeErrorMessage(error)}`);
    }
  }
}
