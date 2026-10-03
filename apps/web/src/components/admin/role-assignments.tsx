'use client';

import type { Site } from '@ecsi/shared';
import { Button } from '@ecsi/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FieldShell, Select } from './controls';

export interface RoleOption {
  id: string;
  code: string;
  name: string;
  permissions: string[];
}

export interface AssignmentDraft {
  roleId: string;
  scope: 'COMPANY' | 'SITES';
  siteIds: string[];
}

/**
 * Éditeur de rôles : chaque rôle s'applique à toute l'entreprise ou à des sites choisis.
 * L'API refuse toute attribution dépassant les droits de la personne qui l'effectue
 * (anti-escalade) ; l'interface se contente de proposer les choix.
 */
export function RoleAssignments({
  roles,
  sites,
  value,
  onChange,
  companyWideAllowed,
}: {
  roles: RoleOption[];
  sites: Site[];
  value: AssignmentDraft[];
  onChange: (value: AssignmentDraft[]) => void;
  /** Faux pour un gestionnaire limité à ses sites : la portée entreprise n'est pas proposée. */
  companyWideAllowed: boolean;
}) {
  const t = useTranslations('members.roles');
  const update = (index: number, patch: Partial<AssignmentDraft>) => {
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <div className="flex flex-col gap-3">
      {value.map((assignment, index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-md border border-border p-3"
          data-testid="role-assignment"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <FieldShell id={`role-${String(index)}`} label={t('role')}>
              <Select
                id={`role-${String(index)}`}
                value={assignment.roleId}
                onChange={(event) => {
                  update(index, { roleId: event.target.value });
                }}
              >
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </FieldShell>
            <FieldShell id={`scope-${String(index)}`} label={t('scope')}>
              <Select
                id={`scope-${String(index)}`}
                value={assignment.scope}
                onChange={(event) => {
                  const scope = event.target.value === 'SITES' ? 'SITES' : 'COMPANY';
                  update(index, { scope, siteIds: scope === 'COMPANY' ? [] : assignment.siteIds });
                }}
              >
                {companyWideAllowed ? <option value="COMPANY">{t('company')}</option> : null}
                <option value="SITES">{t('sites')}</option>
              </Select>
            </FieldShell>
            {value.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('removeRole')}
                onClick={() => {
                  onChange(value.filter((_, i) => i !== index));
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
          {assignment.scope === 'SITES' ? (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-muted">{t('chooseSites')}</legend>
              {sites.length === 0 ? <p className="text-sm text-muted">{t('noSites')}</p> : null}
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                {sites.map((site) => (
                  <label key={site.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={assignment.siteIds.includes(site.id)}
                      onChange={(event) => {
                        update(index, {
                          siteIds: event.target.checked
                            ? [...assignment.siteIds, site.id]
                            : assignment.siteIds.filter((id) => id !== site.id),
                        });
                      }}
                    />
                    {site.name} <span className="font-mono text-xs text-muted">{site.code}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      ))}
      {value.length < 10 && roles[0] ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => {
            onChange([
              ...value,
              {
                roleId: roles[0]?.id ?? '',
                scope: companyWideAllowed ? 'COMPANY' : 'SITES',
                siteIds: [],
              },
            ]);
          }}
        >
          <Plus className="size-4" aria-hidden /> {t('addRole')}
        </Button>
      ) : null}
    </div>
  );
}

/** Valide localement les attributions avant envoi (l'API revalide tout). */
export function assignmentsValid(value: AssignmentDraft[]): boolean {
  return (
    value.length > 0 &&
    value.every((a) => a.roleId !== '' && (a.scope === 'COMPANY' || a.siteIds.length > 0))
  );
}

/** Corps attendu par l'API (portée entreprise : pas de sites). */
export function toAssignments(value: AssignmentDraft[]) {
  return value.map((a) =>
    a.scope === 'COMPANY'
      ? { roleId: a.roleId, scope: 'COMPANY' as const }
      : { roleId: a.roleId, scope: 'SITES' as const, siteIds: a.siteIds },
  );
}
