import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SecretBox } from '../auth/crypto/secret-box.js';
import { SECRET_BOX } from '../auth/secret-box.provider.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { routers, sites, type RouterTransportKind } from '../database/schema/index.js';
import { type TenantContext, TenantDatabase } from '../tenancy/tenant-database.js';
import { encryptRouterPassword } from './router-secret.js';
import {
  assertRouterTunnelIp,
  parseTunnelNetwork,
  TunnelIpError,
  type TunnelNetwork,
} from './tunnel-ip.js';

export interface RegisterRouterInput {
  siteId: string;
  name: string;
  tunnelIp: string;
  transport: RouterTransportKind;
  routerosUsername: string;
  routerosPassword: string;
  tlsFingerprint?: string | null;
}

/** Vue d'un routeur : jamais le chiffré du mot de passe. */
export type RouterView = Omit<typeof routers.$inferSelect, 'routerosPasswordEncrypted'>;

const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Routeurs de l'entreprise courante (rôle ecsi_app, RLS). Sprint 3A : enregistrement et
 * changement d'identifiants, utilisés par les tests et par le futur enrôlement ; aucune route
 * HTTP n'est exposée à ce stade. L'adresse tunnel est validée (anti-SSRF) et le mot de passe
 * chiffré avec une AAD liée à l'entreprise et au routeur (identifiant généré AVANT le
 * chiffrement, dans la même transaction).
 */
@Injectable()
export class RoutersService {
  private readonly network: TunnelNetwork;

  constructor(
    private readonly tenantDb: TenantDatabase,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(ENV) env: Env,
  ) {
    this.network = parseTunnelNetwork(env.ROUTER_TUNNEL_CIDR, env.ROUTER_TUNNEL_GATEWAY);
  }

  async register(context: TenantContext, input: RegisterRouterInput): Promise<RouterView> {
    const tunnelIp = this.validTunnelIp(input.tunnelIp);
    const name = input.name.trim();
    if (!name || name.length > 128)
      throw new UnprocessableEntityException('Nom de routeur invalide');
    this.assertCredentials(input.routerosUsername, input.routerosPassword);
    const fingerprint = input.tlsFingerprint?.toLowerCase().replace(/:/g, '') ?? null;
    if (fingerprint !== null && !FINGERPRINT.test(fingerprint)) {
      throw new UnprocessableEntityException(
        'Empreinte TLS invalide (SHA-256 hexadécimal attendu)',
      );
    }
    if (input.transport === 'REST_HTTPS' && !fingerprint) {
      throw new UnprocessableEntityException(
        'Le transport REST HTTPS exige l’empreinte TLS du routeur',
      );
    }

    return this.tenantDb.run(context, async (tx) => {
      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, input.siteId), isNull(sites.deletedAt)));
      if (!site) throw new NotFoundException('Site introuvable');

      const generated = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
      const id = generated.rows[0]?.id;
      if (!id) throw new Error('uuidv7() indisponible');
      try {
        const [row] = await tx
          .insert(routers)
          .values({
            id,
            companyId: context.companyId,
            siteId: site.id,
            name,
            transport: input.transport,
            tunnelIp,
            routerosUsername: input.routerosUsername,
            routerosPasswordEncrypted: encryptRouterPassword(
              this.box,
              { companyId: context.companyId, routerId: id },
              input.routerosPassword,
            ),
            tlsFingerprint: fingerprint,
          })
          .returning();
        if (!row) throw new Error('Insertion du routeur sans résultat');
        return toView(row);
      } catch (error) {
        if (
          (error as { cause?: { code?: string } }).cause?.code === '23505' ||
          (error as { code?: string }).code === '23505'
        ) {
          throw new ConflictException('Adresse tunnel déjà attribuée à un autre routeur');
        }
        throw error;
      }
    });
  }

  async setCredentials(
    context: TenantContext,
    routerId: string,
    credentials: { routerosUsername: string; routerosPassword: string },
  ): Promise<void> {
    this.assertCredentials(credentials.routerosUsername, credentials.routerosPassword);
    await this.tenantDb.run(context, async (tx) => {
      const updated = await tx
        .update(routers)
        .set({
          routerosUsername: credentials.routerosUsername,
          routerosPasswordEncrypted: encryptRouterPassword(
            this.box,
            { companyId: context.companyId, routerId },
            credentials.routerosPassword,
          ),
        })
        .where(and(eq(routers.id, routerId), isNull(routers.deletedAt)))
        .returning({ id: routers.id });
      if (updated.length === 0) throw new NotFoundException('Routeur introuvable');
    });
  }

  private validTunnelIp(value: string): string {
    try {
      return assertRouterTunnelIp(value, this.network);
    } catch (error) {
      if (error instanceof TunnelIpError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
  }

  private assertCredentials(username: string, password: string): void {
    if (!USERNAME.test(username))
      throw new UnprocessableEntityException('Nom du compte RouterOS invalide');
    if (password.length < 12 || password.length > 256) {
      throw new UnprocessableEntityException('Mot de passe RouterOS : 12 à 256 caractères');
    }
  }
}

function toView(row: typeof routers.$inferSelect): RouterView {
  const { routerosPasswordEncrypted: _secret, ...view } = row;
  return view;
}
