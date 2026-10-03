import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Logo,
  StatCard,
} from '@ecsi/ui';
import { formatMoney } from '@ecsi/shared';
import { Banknote, Inbox, Router } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Design system' };

const COLORS = [
  ['primary', 'bg-primary'],
  ['primary-soft', 'bg-primary-soft'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['surface', 'bg-surface'],
  ['surface-muted', 'bg-surface-muted'],
  ['sidebar', 'bg-sidebar'],
] as const;

/**
 * Référence visuelle du design system ECSI CLOUD (Sprint 0). Les valeurs affichées
 * ici sont des exemples d'affichage, pas des données réelles.
 */
export default function DesignSystemPage() {
  return (
    <>
      <PageHeader
        title="Design system"
        subtitle="Jetons de design et composants de base d’ECSI CLOUD. Valeurs d’exemple uniquement."
      />

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Marque</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-6">
            <Logo />
            <span className="rounded-lg bg-sidebar p-3 text-white">
              <Logo />
            </span>
            <Logo symbolOnly />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Couleurs</CardTitle>
            <CardDescription>
              Définies par variables CSS, avec thème sombre automatique.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {COLORS.map(([name, className]) => (
              <div key={name} className="flex items-center gap-3">
                <span className={`size-10 rounded-md border border-border ${className}`} />
                <code className="text-xs text-muted">{name}</code>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Boutons et statuts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-3">
              <Button>Principal</Button>
              <Button variant="secondary">Secondaire</Button>
              <Button variant="ghost">Discret</Button>
              <Button variant="danger">Action dangereuse</Button>
              <Button disabled>Désactivé</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success" dot>
                ONLINE
              </Badge>
              <Badge tone="danger" dot>
                OFFLINE
              </Badge>
              <Badge tone="warning">Stock faible</Badge>
              <Badge tone="primary">LOCAL</Badge>
              <Badge>Neutre</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Formulaire</CardTitle>
          </CardHeader>
          <CardContent className="grid max-w-md gap-2">
            <Label htmlFor="ds-site">Nom du site</Label>
            <Input id="ds-site" placeholder="Ex. Site Korhogo" />
          </CardContent>
        </Card>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            label="Exemple de montant"
            value={formatMoney(125000)}
            icon={<Banknote className="size-5" />}
            hint="Format XOF / FCFA"
          />
          <StatCard label="Exemple de compteur" value="12" icon={<Router className="size-5" />} />
          <StatCard label="Sans donnée" value={null} hint="Affiche un tiret" />
        </section>

        <EmptyState
          icon={<Inbox className="size-8" aria-hidden />}
          title="État vide"
          description="Affiché lorsqu’une liste ne contient encore aucun élément."
          action={<Button size="sm">Action principale</Button>}
        />
      </div>
    </>
  );
}
