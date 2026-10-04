'use client';

import type { EnrollmentCreated, Site } from '@ecsi/shared';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@ecsi/ui';
import { Check, Copy } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { FieldShell, Select, useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';

/**
 * Script d'enrôlement affiché UNE seule fois : il contient le jeton à usage unique. Il n'est
 * conservé que dans l'état de ce composant (jamais en stockage local) et disparaît à la
 * fermeture.
 */
export function EnrollmentScript({
  enrollment,
  onDone,
}: {
  enrollment: EnrollmentCreated;
  onDone: () => void;
}) {
  const t = useTranslations('routers.enroll');
  const format = useFormatter();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(enrollment.script);
    setCopied(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scriptTitle', { name: enrollment.router.name })}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FormMessage tone="success">
          {t('scriptOnce', {
            expiresAt: format.dateTime(new Date(enrollment.expiresAt), {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </FormMessage>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
          <li>{t('step4', { tunnelIp: enrollment.router.tunnelIp })}</li>
        </ol>
        <pre
          data-testid="enrollment-script"
          className="max-h-80 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs"
        >
          {enrollment.script}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void copy()}>
            {copied ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
            {copied ? t('copied') : t('copy')}
          </Button>
          <Button onClick={onDone}>{t('done')}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** « Ajouter un routeur » : site et nom ; le cloud attribue l'adresse tunnel. */
export function EnrollmentForm({
  onCreated,
  onCancel,
}: {
  onCreated: (enrollment: EnrollmentCreated) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('routers.enroll');
  const tCommon = useTranslations('common');
  const problemMessage = useProblemMessage();
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data.filter((site) => site.status !== 'INACTIVE'));
    });
  }, []);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await api<EnrollmentCreated>('/routers/enrollments', {
      method: 'POST',
      body: { siteId: fieldValue(form, 'siteId'), name: fieldValue(form, 'name').trim() },
    });
    setPending(false);
    if (result.ok) onCreated(result.data);
    else setError(problemMessage(result.status, result.problem));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          <p className="text-sm text-muted">{t('intro')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldShell id="siteId" label={t('site')}>
              <Select id="siteId" name="siteId" required defaultValue="">
                <option value="" disabled>
                  {t('chooseSite')}
                </option>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </Select>
            </FieldShell>
            <Field
              id="name"
              label={t('name')}
              hint={t('nameHint')}
              required
              minLength={2}
              maxLength={128}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? tCommon('saving') : t('generate')}
            </Button>
            <Button variant="secondary" onClick={onCancel}>
              {tCommon('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
