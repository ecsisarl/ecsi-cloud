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
  Input,
} from '@ecsi/ui';
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type SubmitEvent, useCallback, useEffect, useState } from 'react';
import { Field, FormMessage, fieldValue } from '@/components/auth/form';
import { usePermissions } from '@/components/me-context';
import { api } from '@/lib/client-api';
import { DataTable, FieldShell, Select, Td, Th, Toolbar, useProblemMessage } from './controls';
import {
  type AssignmentDraft,
  assignmentsValid,
  RoleAssignments,
  type RoleOption,
  toAssignments,
} from './role-assignments';

interface Invitation {
  id: string;
  email: string;
  status: string;
  expired: boolean;
  expiresAt: string;
  roles: { code: string; name: string; scope: string; siteIds: string[] }[];
}

export function describeMemberRoles(member: Member): string {
  return member.roles
    .map((role) =>
      role.scope === 'COMPANY'
        ? role.name
        : `${role.name} (${role.sites.map((s) => s.code).join(', ')})`,
    )
    .join(' · ');
}

export function MembersManager() {
  const t = useTranslations('members');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const permissions = usePermissions();
  const problemMessage = useProblemMessage();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [filters, setFilters] = useState({ q: '', status: '', roleId: '', siteId: '' });
  const [inviting, setInviting] = useState(false);
  const [draft, setDraft] = useState<AssignmentDraft[]>([]);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const canInvite = permissions.any('users.invite');
  const companyWideInvite = permissions.companyWide('users.invite');

  const loadMembers = useCallback(async () => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value.trim()) params.set(key, value.trim());
    const query = params.toString();
    const result = await api<Member[]>(`/users${query ? `?${query}` : ''}`);
    if (result.ok) setMembers(result.data);
    else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }, [filters, problemMessage]);

  const loadInvitations = useCallback(async () => {
    const result = await api<Invitation[]>('/invitations');
    if (result.ok) setInvitations(result.data.filter((i) => i.status === 'PENDING'));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadMembers(), 250);
    return () => {
      clearTimeout(timer);
    };
  }, [loadMembers]);

  useEffect(() => {
    // Chargement initial : invitations, rôles et sites proposés dans les formulaires.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInvitations();
    void api<RoleOption[]>('/roles').then((result) => {
      if (result.ok) setRoles(result.data);
    });
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, [loadInvitations]);

  function startInvite() {
    const vendeur = roles.find((role) => role.code === 'VENDEUR') ?? roles[0];
    setDraft([
      { roleId: vendeur?.id ?? '', scope: companyWideInvite ? 'COMPANY' : 'SITES', siteIds: [] },
    ]);
    setInviting(true);
  }

  async function invite(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!assignmentsValid(draft)) {
      setMessage({ tone: 'error', text: t('chooseSitesError') });
      return;
    }
    const email = fieldValue(new FormData(event.currentTarget), 'email').trim();
    const result = await api('/invitations', {
      method: 'POST',
      body: { email, roles: toAssignments(draft) },
    });
    if (result.ok) {
      setInviting(false);
      setMessage({ tone: 'success', text: t('invited', { email }) });
      await loadInvitations();
    } else setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
  }

  async function revokeInvitation(id: string) {
    const result = await api(`/invitations/${id}`, { method: 'DELETE' });
    if (!result.ok)
      setMessage({ tone: 'error', text: problemMessage(result.status, result.problem) });
    await loadInvitations();
  }

  return (
    <div className="flex flex-col gap-6">
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      <Toolbar>
        <div className="col-span-2 flex-1 sm:max-w-xs">
          <FieldShell id="member-search" label={t('search')}>
            <Input
              id="member-search"
              type="search"
              placeholder={t('searchPlaceholder')}
              value={filters.q}
              onChange={(event) => {
                setFilters({ ...filters, q: event.target.value });
              }}
            />
          </FieldShell>
        </div>
        <FieldShell id="member-status" label={t('status')}>
          <Select
            id="member-status"
            value={filters.status}
            onChange={(event) => {
              setFilters({ ...filters, status: event.target.value });
            }}
          >
            <option value="">{t('allStatuses')}</option>
            <option value="ACTIVE">{t('statuses.ACTIVE')}</option>
            <option value="DISABLED">{t('statuses.DISABLED')}</option>
          </Select>
        </FieldShell>
        <FieldShell id="member-role" label={t('role')}>
          <Select
            id="member-role"
            value={filters.roleId}
            onChange={(event) => {
              setFilters({ ...filters, roleId: event.target.value });
            }}
          >
            <option value="">{t('allRoles')}</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        </FieldShell>
        <FieldShell id="member-site" label={t('site')}>
          <Select
            id="member-site"
            value={filters.siteId}
            onChange={(event) => {
              setFilters({ ...filters, siteId: event.target.value });
            }}
          >
            <option value="">{t('allSites')}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </FieldShell>
        {canInvite && !inviting ? (
          <Button className="col-span-2 sm:ml-auto" onClick={startInvite}>
            <UserPlus className="size-4" aria-hidden /> {t('invite')}
          </Button>
        ) : null}
      </Toolbar>

      {inviting ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('inviteTitle')}</CardTitle>
            <CardDescription>{t('inviteSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => void invite(event)}
              className="flex flex-col gap-4"
              noValidate
            >
              <Field id="email" label={tCommon('email')} type="email" required autoComplete="off" />
              <RoleAssignments
                roles={roles}
                sites={sites}
                value={draft}
                onChange={setDraft}
                companyWideAllowed={companyWideInvite}
              />
              <div className="flex gap-2">
                <Button type="submit">{t('sendInvitation')}</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setInviting(false);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {members ? (
        <DataTable testId="members-table">
          <thead>
            <tr>
              <Th>{t('name')}</Th>
              <Th>{t('roles.title')}</Th>
              <Th>{t('status')}</Th>
              <Th>{t('mfa')}</Th>
              <Th>{t('lastLogin')}</Th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr>
                <Td className="text-muted">{t('empty')}</Td>
              </tr>
            ) : null}
            {members.map((member) => (
              <tr key={member.id}>
                <Td>
                  <Link
                    href={`/administration/utilisateurs/${member.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {member.fullName}
                  </Link>
                  <p className="text-xs text-muted">{member.email}</p>
                </Td>
                <Td className="text-xs">{describeMemberRoles(member) || '—'}</Td>
                <Td>
                  <Badge tone={member.status === 'ACTIVE' ? 'success' : 'neutral'} dot>
                    {t(`statuses.${member.status}`)}
                  </Badge>
                </Td>
                <Td>
                  <Badge tone={member.mfaEnabled ? 'success' : 'warning'}>
                    {member.mfaEnabled ? t('mfaOn') : t('mfaOff')}
                  </Badge>
                </Td>
                <Td className="text-xs text-muted">
                  {member.lastLoginAt
                    ? format.dateTime(new Date(member.lastLoginAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })
                    : t('never')}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-sm text-muted">{tCommon('loading')}</p>
      )}

      {invitations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('pendingInvitations')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y divide-border" data-testid="invitations-list">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted">
                      {invitation.roles.map((role) => role.name).join(' · ')} ·{' '}
                      {invitation.expired
                        ? t('expired')
                        : t('expires', {
                            date: format.dateTime(new Date(invitation.expiresAt), {
                              dateStyle: 'medium',
                            }),
                          })}
                    </p>
                  </div>
                  {canInvite ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void revokeInvitation(invitation.id)}
                    >
                      {t('revokeInvitation')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
