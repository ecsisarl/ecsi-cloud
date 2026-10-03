'use client';

import { DEFAULT_TIMEZONE, type Site } from '@ecsi/shared';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@ecsi/ui';
import { ArrowLeft, MapPinOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { ConfirmPanel, useProblemMessage } from '@/components/admin/controls';
import { usePermissions } from '@/components/me-context';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/client-api';
import { SiteForm } from './site-form';
import { SITE_STATUS_TONE } from './sites-manager';

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 text-foreground">{value && value !== '' ? value : '—'}</dd>
    </div>
  );
}

export function SiteDetail({ id }: { id: string }) {
  const t = useTranslations('sites');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [site, setSite] = useState<Site | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const result = await api<Site>(`/sites/${id}`);
    if (result.ok) setSite(result.data);
    else if (result.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [id, problemMessage]);

  useEffect(() => {
    // Chargement du site depuis l'API (404 si hors de la portée de l'utilisateur).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function remove() {
    const result = await api(`/sites/${id}`, { method: 'DELETE' });
    if (result.ok) router.push('/sites');
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (missing) {
    return (
      <EmptyState
        icon={<MapPinOff className="size-8" aria-hidden />}
        title={t('notFoundTitle')}
        description={t('notFoundDescription')}
      />
    );
  }
  if (!site) return <p className="text-sm text-muted">{tCommon('loading')}</p>;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/sites" className="flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> {t('back')}
      </Link>
      <PageHeader
        title={site.name}
        subtitle={`${site.code} · ${site.city ?? ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {permissions.any('sites.update') && !editing ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {tCommon('edit')}
              </Button>
            ) : null}
            {permissions.any('sites.delete') ? (
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                {tCommon('delete')}
              </Button>
            ) : null}
          </div>
        }
      />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {confirmDelete ? (
        <ConfirmPanel
          title={t('deleteTitle', { name: site.name })}
          description={t('deleteDescription')}
        >
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void remove()}>
              {t('deleteConfirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

      {editing ? (
        <Card>
          <CardContent className="pt-5">
            <SiteForm
              site={site}
              defaultTimezone={DEFAULT_TIMEZONE}
              onCancel={() => {
                setEditing(false);
              }}
              onSaved={(saved) => {
                setSite(saved);
                setEditing(false);
                setMessage({ tone: 'success', text: tCommon('saved') });
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t('information')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border">
                <div className="grid grid-cols-3 gap-2 py-2 text-sm">
                  <dt className="text-muted">{t('form.status')}</dt>
                  <dd className="col-span-2">
                    <Badge tone={SITE_STATUS_TONE[site.status]} dot>
                      {t(`form.statuses.${site.status}`)}
                    </Badge>
                  </dd>
                </div>
                <Row label={t('form.address')} value={site.address} />
                <Row label={t('form.city')} value={site.city} />
                <Row label={t('form.country')} value={site.country} />
                <Row label={t('form.timezone')} value={site.timezone} />
                <Row label={t('form.phone')} value={site.phone} />
                <Row label={t('form.contactName')} value={site.contactName} />
                <Row
                  label={t('coordinates')}
                  value={
                    site.latitude !== null && site.longitude !== null
                      ? `${String(site.latitude)}, ${String(site.longitude)}`
                      : null
                  }
                />
                <Row label={t('form.description')} value={site.description} />
                <Row
                  label={t('createdAt')}
                  value={format.dateTime(new Date(site.createdAt), { dateStyle: 'medium' })}
                />
              </dl>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('groups')}</CardTitle>
              </CardHeader>
              <CardContent>
                {site.groups.length === 0 ? (
                  <p className="text-sm text-muted">{t('noGroups')}</p>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {site.groups.map((group) => (
                      <li key={group.id}>
                        <Badge tone="primary">{group.name}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('upcomingTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted">{t('upcomingDescription')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
