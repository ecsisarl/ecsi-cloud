'use client';

import type { Site } from '@ecsi/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';
import { AuditLog } from './audit-log';

/** Journal de l'entreprise courante, avec le filtre par site. */
export function CompanyAuditLog() {
  const [sites, setSites] = useState<Site[]>([]);
  useEffect(() => {
    void api<Site[]>('/sites').then((result) => {
      if (result.ok) setSites(result.data);
    });
  }, []);
  return <AuditLog endpoint="/audit" sites={sites} />;
}
