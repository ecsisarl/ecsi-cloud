import { renderLoginPage } from '@/render';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return renderLoginPage(request.headers.get('accept-language'));
}
