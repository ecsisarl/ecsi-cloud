'use client';

import type { PlatformCompanyPage } from '@ecsi/shared';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ecsi/ui';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AuditLog } from '@/components/admin/audit-log';
import { FieldShell, Select } from '@/components/admin/controls';
import { api } from '@/lib/client-api';

interface ChainCheck {
  chainKey: string;
  checked: number;
  valid: boolean;
  brokenSeqs: number[];
}

/** Journal global (toutes les entreprises + chaîne plateforme) et contrôle d'intégrité. */
export function PlatformAuditLog() {
  const t = useTranslations('platformConsole.audit');
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [chain, setChain] = useState('platform');
  const [check, setCheck] = useState<ChainCheck | null>(null);

  useEffect(() => {
    void api<PlatformCompanyPage>('/platform/companies?limit=100').then((result) => {
      if (result.ok) setCompanies(result.data.data.map(({ id, name }) => ({ id, name })));
    });
  }, []);

  async function verify() {
    const result = await api<ChainCheck>(`/platform/audit/verify/${chain}`);
    if (result.ok) setCheck(result.data);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('integrityTitle')}</CardTitle>
          <CardDescription>{t('integritySubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <FieldShell id="chain" label={t('chain')}>
              <Select
                id="chain"
                value={chain}
                onChange={(event) => {
                  setChain(event.target.value);
                  setCheck(null);
                }}
              >
                <option value="platform">{t('platformChain')}</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </FieldShell>
            <Button variant="secondary" onClick={() => void verify()}>
              {t('verify')}
            </Button>
          </div>
          {check ? (
            check.valid ? (
              <p className="flex items-center gap-2 text-sm text-success" role="status">
                <ShieldCheck className="size-4" aria-hidden />{' '}
                {t('valid', { count: check.checked })}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                <ShieldAlert className="size-4" aria-hidden />{' '}
                {t('broken', { seqs: check.brokenSeqs.join(', ') })}
              </p>
            )
          ) : null}
        </CardContent>
      </Card>
      <AuditLog endpoint="/platform/audit" companies={companies} />
    </div>
  );
}
