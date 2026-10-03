import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type CompanyProfile,
  type CompanySettings,
  companySettingsSchema,
  type UpdateCompanyProfileRequest,
  type UploadLogoRequest,
} from '@ecsi/shared';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { diff } from '../audit/sanitize.js';
import { companies } from '../database/schema/index.js';
import { StorageService } from '../storage/storage.module.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import { checkLogo, LOGO_EXTENSIONS } from './logo.js';

const PROFILE_FIELDS = [
  'name',
  'legalName',
  'phone',
  'whatsapp',
  'email',
  'address',
  'city',
  'country',
  'currency',
  'locale',
  'timezone',
] as const;

type CompanyRow = typeof companies.$inferSelect;

export function toCompanyProfile(row: CompanyRow): CompanyProfile {
  const settings = companySettingsSchema.safeParse(row.settings);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    legalName: row.legalName,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    address: row.address,
    city: row.city,
    country: row.country,
    currency: row.currency,
    locale: row.locale,
    timezone: row.timezone,
    status: row.status as CompanyProfile['status'],
    hasLogo: row.logoObjectKey !== null,
    settings: settings.success ? settings.data : companySettingsSchema.parse({}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Profil de l'entreprise courante. L'identifiant vient de la session (TenantContext) ; la
 * RLS limite en plus companies à la ligne de l'entreprise, et les privilèges par colonne
 * empêchent ecsi_app de modifier le statut ou l'identifiant (migration 0004).
 */
@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  get(ctx: TenantContext): Promise<CompanyProfile> {
    return this.tenantDb.run(ctx, async (tx) => toCompanyProfile(await this.row(tx, ctx)));
  }

  updateProfile(ctx: TenantContext, input: UpdateCompanyProfileRequest): Promise<CompanyProfile> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.row(tx, ctx);
      const [after] = await tx
        .update(companies)
        .set(input)
        .where(eq(companies.id, ctx.companyId))
        .returning();
      if (!after) throw new NotFoundException('Entreprise introuvable');
      const changes = diff(before, after, PROFILE_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.audit.write(tx, ctx.companyId, {
          action: 'company.update',
          resourceType: 'company',
          resourceId: ctx.companyId,
          details: { changes },
        });
      }
      return toCompanyProfile(after);
    });
  }

  updateSettings(ctx: TenantContext, settings: CompanySettings): Promise<CompanyProfile> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.row(tx, ctx);
      const [after] = await tx
        .update(companies)
        .set({ settings })
        .where(eq(companies.id, ctx.companyId))
        .returning();
      if (!after) throw new NotFoundException('Entreprise introuvable');
      await this.audit.write(tx, ctx.companyId, {
        action: 'company.settings_update',
        resourceType: 'company',
        resourceId: ctx.companyId,
        details: { changes: diff(before.settings, after.settings) },
      });
      return toCompanyProfile(after);
    });
  }

  async uploadLogo(ctx: TenantContext, input: UploadLogoRequest): Promise<CompanyProfile> {
    const logo = checkLogo(input.data, input.contentType);
    if (!logo.ok) throw new UnprocessableEntityException(logo.reason);
    // Nom imprévisible et nouveau à chaque envoi : pas d'écrasement, pas de cache périmé.
    const key = `companies/${ctx.companyId}/logo/${randomUUID()}.${LOGO_EXTENSIONS[logo.contentType]}`;
    await this.storage.put(key, logo.data, logo.contentType);
    try {
      const { profile, previousKey } = await this.tenantDb.run(ctx, async (tx) => {
        const before = await this.row(tx, ctx);
        const [after] = await tx
          .update(companies)
          .set({ logoObjectKey: key, logoContentType: logo.contentType })
          .where(eq(companies.id, ctx.companyId))
          .returning();
        if (!after) throw new NotFoundException('Entreprise introuvable');
        await this.audit.write(tx, ctx.companyId, {
          action: 'company.logo_update',
          resourceType: 'company',
          resourceId: ctx.companyId,
          details: { contentType: logo.contentType, bytes: logo.data.length },
        });
        return { profile: toCompanyProfile(after), previousKey: before.logoObjectKey };
      });
      if (previousKey) await this.deleteQuietly(previousKey);
      return profile;
    } catch (error) {
      await this.deleteQuietly(key);
      throw error;
    }
  }

  async deleteLogo(ctx: TenantContext): Promise<CompanyProfile> {
    const { profile, previousKey } = await this.tenantDb.run(ctx, async (tx) => {
      const before = await this.row(tx, ctx);
      const [after] = await tx
        .update(companies)
        .set({ logoObjectKey: null, logoContentType: null })
        .where(eq(companies.id, ctx.companyId))
        .returning();
      if (!after) throw new NotFoundException('Entreprise introuvable');
      if (before.logoObjectKey) {
        await this.audit.write(tx, ctx.companyId, {
          action: 'company.logo_delete',
          resourceType: 'company',
          resourceId: ctx.companyId,
        });
      }
      return { profile: toCompanyProfile(after), previousKey: before.logoObjectKey };
    });
    if (previousKey) await this.deleteQuietly(previousKey);
    return profile;
  }

  async logo(ctx: TenantContext): Promise<{ data: Buffer; contentType: string } | null> {
    const row = await this.tenantDb.run(ctx, (tx) => this.row(tx, ctx));
    if (!row.logoObjectKey || !row.logoContentType) return null;
    const data = await this.storage.get(row.logoObjectKey);
    return data ? { data, contentType: row.logoContentType } : null;
  }

  private async row(tx: TenantTransaction, ctx: TenantContext): Promise<CompanyRow> {
    // Filtre explicite EN PLUS de la RLS.
    const [row] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId));
    if (!row) throw new NotFoundException('Entreprise introuvable');
    return row;
  }

  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Suppression du logo précédent impossible');
    }
  }
}
