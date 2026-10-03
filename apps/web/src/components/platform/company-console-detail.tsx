'use client';

import type { PlatformCompanyDetail } from '@ecsi/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  StatCard,
} from '@ecsi/ui';
import { ArrowLeft, Building2, MailPlus, MapPin, Users } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { FormMessage, fieldValue } from '@/components/auth/form';
import { AuditLog } from '@/components/admin/audit-log';
import { ConfirmPanel, FieldShell, Textarea, useProblemMessage } from '@/components/admin/controls';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/client-api';

export function CompanyConsoleDetail({ id }: { id: string }) {
  const t = useTranslations('platformConsole.companies');
  const tCompany = useTranslations('company');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const problemMessage = useProblemMessage();
  const [company, setCompany] = useState<PlatformCompanyDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api<PlatformCompanyDetail>(`/platform/companies/${id}`);
    if (result.ok) setCompany(result.data);
    else if (result.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [id, problemMessage]);

  useEffect(() => {
    // Chargement de l'entreprise depuis la console plateforme.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function changeStatus(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!company) return;
    const status = company.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const result = await api<PlatformCompanyDetail>(`/platform/companies/${id}/status`, {
      method: 'PATCH',
      body: { status, reason: fieldValue(new FormData(event.currentTarget), 'reason').trim() },
    });
    if (result.ok) {
      setCompany(result.data);
      setChanging(false);
      setMessage({
        tone: 'success',
        text: status === 'SUSPENDED' ? t('suspended') : t('reactivated'),
      });
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (missing) {
    return (
      <EmptyState
        icon={<Building2 className="size-8" aria-hidden />}
        title={t('notFoundTitle')}
        description={t('notFoundDescription')}
      />
    );
  }
  if (!company) return <p className="text-sm text-muted">{tCommon('loading')}</p>;
  const suspendedNow = company.status === 'SUSPENDED';

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/plateforme"
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t('back')}
      </Link>
      <PageHeader
        title={company.name}
        subtitle={`${company.slug} · ${company.legalName ?? ''}`}
        actions={
          !changing ? (
            <Button
              variant={suspendedNow ? 'primary' : 'danger'}
              onClick={() => {
                setChanging(true);
              }}
            >
              {suspendedNow ? t('reactivate') : t('suspend')}
            </Button>
          ) : undefined
        }
      />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}

      {changing ? (
        <ConfirmPanel
          title={suspendedNow ? t('reactivateTitle') : t('suspendTitle', { name: company.name })}
          description={suspendedNow ? t('reactivateDescription') : t('suspendDescription')}
        >
          <form
            onSubmit={(event) => void changeStatus(event)}
            className="flex flex-col gap-3"
            noValidate
          >
            <FieldShell id="reason" label={t('reason')} hint={t('reasonHint')}>
              <Textarea id="reason" name="reason" required minLength={5} maxLength={500} />
            </FieldShell>
            <div className="flex gap-2">
              <Button type="submit" variant={suspendedNow ? 'primary' : 'danger'}>
                {suspendedNow ? t('reactivate') : t('suspendConfirm')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setChanging(false);
                }}
              >
                {tCommon('cancel')}
              </Button>
            </div>
          </form>
        </ConfirmPanel>
      ) : null}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={t('members')}
          value={String(company.memberCount)}
          icon={<Users className="size-5" />}
        />
        <StatCard
          label={t('sites')}
          value={String(company.siteCount)}
          icon={<MapPin className="size-5" />}
        />
        <StatCard
          label={t('pendingInvitations')}
          value={String(company.pendingInvitations)}
          icon={<MailPlus className="size-5" />}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t('profile')}
              <Badge tone={suspendedNow ? 'danger' : 'success'} dot data-testid="company-status">
                {tCompany(`statuses.${company.status}`)}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {(
                [
                  [tCompany('country'), company.country],
                  [tCompany('currency'), company.currency],
                  [tCompany('locale'), company.locale],
                  [tCompany('timezone'), company.timezone],
                  [tCompany('email'), company.email ?? '—'],
                  [tCompany('phone'), company.phone ?? '—'],
                  [
                    t('createdAt'),
                    format.dateTime(new Date(company.createdAt), { dateStyle: 'medium' }),
                  ],
                  [
                    t('suspendedAt'),
                    company.suspendedAt
                      ? format.dateTime(new Date(company.suspendedAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : '—',
                  ],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              {company.suspensionReason ? (
                <div className="col-span-2">
                  <dt className="text-muted">{t('reason')}</dt>
                  <dd>{company.suspensionReason}</dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('admins')}</CardTitle>
          </CardHeader>
          <CardContent>
            {company.admins.length === 0 ? (
              <p className="text-sm text-muted">{t('noAdmins')}</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {company.admins.map((admin) => (
                  <li key={admin.id}>
                    <span className="font-medium">{admin.fullName}</span>{' '}
                    <span className="text-muted">{admin.email}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{t('companyAudit')}</h2>
        <AuditLog endpoint="/platform/audit" companyId={company.id} />
      </section>
    </div>
  );
}
