export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    { status: 'ok', service: 'ecsi-portal' },
    { headers: { 'cache-control': 'no-store' } },
  );
}
