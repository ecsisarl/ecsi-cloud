'use client';

import type { Member, Site } from '@ecsi/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@ecsi/ui';
import { ArrowLeft, UserX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { useMe, usePermissions } from '@/components/me-context';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/client-api';
import { ConfirmPanel, FieldShell, Textarea, useProblemMessage } from './controls';
import { describeMemberRoles } from './members-manager';
import {
  type AssignmentDraft,
  assignmentsValid,
  RoleAssignments,
  type RoleOption,
  toAssignments,
} from './role-assignments';

type Panel = 'roles' | 'remove' | 'mfa' | null;

export function MemberDetail({ id }: { id: string }) {
  const t = useTranslations('members');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const me = useMe();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [member, setMember] = useState<Member | null>(null);
  const [missing, setMissing] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<AssignmentDraft[]>([]);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const self = me.user.id === id;

  const load = useCallback(async () => {
    const result = await api<Member>(`/users/${id}`);
    if (result.ok) setMember(result.data);
    else if (result.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [id, problemMessage]);

  useEffect(() => {
    // Chargement du membre (404 s'il est hors de la portée de l'utilisateur).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void api<RoleOption[]>('/roles').then((result) => {
      if (result.ok) setRoles(result.data);
    });
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, [load]);

  function done(text: string) {
    setPanel(null);
    setMessage({ tone: 'success', text });
    void load();
  }

  async function saveRoles() {
    if (!assignmentsValid(draft)) {
      setMessage({ tone: 'error', text: t('chooseSitesError') });
      return;
    }
    const result = await api<Member>(`/users/${id}/roles`, {
      method: 'PUT',
      body: { roles: toAssignments(draft) },
    });
    if (result.ok) done(t('rolesSaved'));
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function setStatus(status: 'ACTIVE' | 'DISABLED') {
    const result = await api<Member>(`/users/${id}/status`, { method: 'PATCH', body: { status } });
    if (result.ok) done(status === 'ACTIVE' ? t('activated') : t('deactivated'));
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function remove() {
    const result = await api(`/users/${id}`, { method: 'DELETE' });
    if (result.ok) router.push('/administration/utilisateurs');
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function resetMfa(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api(`/users/${id}/mfa/reset`, {
      method: 'POST',
      body: {
        code: fieldValue(form, 'code').replace(/\s/g, ''),
        reason: fieldValue(form, 'reason').trim(),
      },
    });
    if (result.ok) done(t('mfaResetDone'));
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  if (missing) {
    return (
      <EmptyState
        icon={<UserX className="size-8" aria-hidden />}
        title={t('notFoundTitle')}
        description={t('notFoundDescription')}
      />
    );
  }
  if (!member) return <p className="text-sm text-muted">{tCommon('loading')}</p>;

  const actions = !self && (
    <div className="flex flex-wrap gap-2">
      {permissions.any('users.update') ? (
        <Button
          variant="secondary"
          onClick={() => {
            setDraft(
              member.roles.map((role) => ({
                roleId: role.id,
                scope: role.scope,
                siteIds: role.sites.map((site) => site.id),
              })),
            );
            setPanel('roles');
          }}
        >
          {t('editRoles')}
        </Button>
      ) : null}
      {permissions.any('users.disable') ? (
        member.status === 'ACTIVE' ? (
          <Button variant="secondary" onClick={() => void setStatus('DISABLED')}>
            {t('deactivate')}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => void setStatus('ACTIVE')}>
            {t('activate')}
          </Button>
        )
      ) : null}
      {permissions.any('users.mfa.reset') && member.mfaEnabled ? (
        <Button
          variant="secondary"
          onClick={() => {
            setPanel('mfa');
          }}
        >
          {t('mfaReset')}
        </Button>
      ) : null}
      {permissions.any('users.remove') ? (
        <Button
          variant="danger"
          onClick={() => {
            setPanel('remove');
          }}
        >
          {t('remove')}
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/administration/utilisateurs"
        className="flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> {t('back')}
      </Link>
      <PageHeader title={member.fullName} subtitle={member.email} actions={actions || undefined} />
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      {self ? <p className="text-sm text-muted">{t('selfNotice')}</p> : null}

      {panel === 'roles' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('editRoles')}</CardTitle>
            <CardDescription>{t('editRolesHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RoleAssignments
              roles={roles}
              sites={sites}
              value={draft}
              onChange={setDraft}
              companyWideAllowed={permissions.companyWide('users.update')}
            />
            <div className="flex gap-2">
              <Button onClick={() => void saveRoles()}>{tCommon('save')}</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setPanel(null);
                }}
              >
                {tCommon('cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {panel === 'remove' ? (
        <ConfirmPanel
          title={t('removeTitle', { name: member.fullName })}
          description={t('removeDescription')}
        >
          <div className="flex gap-2">
            <Button variant="danger" onClick={() => void remove()}>
              {t('removeConfirm')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setPanel(null);
              }}
            >
              {tCommon('cancel')}
            </Button>
          </div>
        </ConfirmPanel>
      ) : null}

      {panel === 'mfa' ? (
        <ConfirmPanel title={t('mfaResetTitle')} description={t('mfaResetDescription')}>
          {member.otherCompanies ? (
            <p className="text-sm text-warning">{t('mfaResetOtherCompanies')}</p>
          ) : (
            <form
              onSubmit={(event) => void resetMfa(event)}
              className="flex flex-col gap-3"
              noValidate
            >
              <FieldShell id="reason" label={t('mfaResetReason')} hint={t('mfaResetReasonHint')}>
                <Textarea id="reason" name="reason" required minLength={10} maxLength={500} />
              </FieldShell>
              <Field
                id="code"
                label={t('mfaResetCode')}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={6}
              />
              <div className="flex gap-2">
                <Button type="submit" variant="danger">
                  {t('mfaResetConfirm')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPanel(null);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          )}
        </ConfirmPanel>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('details')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">{t('status')}</dt>
              <dd>
                <Badge tone={member.status === 'ACTIVE' ? 'success' : 'neutral'} dot>
                  {t(`statuses.${member.status}`)}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted">{t('mfa')}</dt>
              <dd>
                <Badge tone={member.mfaEnabled ? 'success' : 'warning'}>
                  {member.mfaEnabled ? t('mfaOn') : t('mfaOff')}
                </Badge>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted">{t('roles.title')}</dt>
              <dd data-testid="member-roles">{describeMemberRoles(member) || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('joinedAt')}</dt>
              <dd>{format.dateTime(new Date(member.joinedAt), { dateStyle: 'medium' })}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('lastLogin')}</dt>
              <dd>
                {member.lastLoginAt
                  ? format.dateTime(new Date(member.lastLoginAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : t('never')}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
