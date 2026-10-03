import { safeColor } from './theme';

/** CSS en ligne (aucune requête supplémentaire), compatible navigateurs anciens. */
export function portalCss(primaryColor: string): string {
  const primary = safeColor(primaryColor);
  return `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f4f6fb;color:#0f172a;line-height:1.5}
.w{max-width:420px;margin:0 auto;padding:24px 16px}
.c{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
.b{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.l{width:40px;height:40px;border-radius:10px;background:${primary};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.n{font-weight:700;font-size:18px}.s{font-size:13px;color:#5b6577}
h1{font-size:22px;margin:0 0 4px}p{margin:0 0 16px;color:#334155}
label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
input{width:100%;height:48px;border:1px solid #cbd5e1;border-radius:10px;padding:0 14px;font-size:18px;letter-spacing:2px;text-transform:uppercase}
input:focus{outline:2px solid ${primary};border-color:${primary}}
button{width:100%;height:48px;margin-top:14px;border:0;border-radius:10px;background:${primary};color:#fff;font-size:16px;font-weight:600}
button[disabled]{opacity:.6}
.pr{background:#fef3c7;color:#92400e;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:16px}
.d{background:#e0e9ff;color:#1e3a8a;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:16px}
.h{margin-top:20px;font-size:14px;text-align:center}.h a{color:${primary};font-weight:600;margin:0 8px}
.f{margin-top:20px;text-align:center;font-size:12px;color:#94a3b8}`;
}
