import type { Cta, FlowPage, FlowSession } from '@mokie/shared';
import { randomBytes } from 'node:crypto';
import type { Repos } from '../db/repos.ts';
import type { StateStore } from '../state/store.ts';
import { applyEffects } from '../engine/effects.ts';
import { render } from '../engine/template.ts';
import { renderErrorPage, renderFlowPage, renderResultPage } from './page.ts';

export const FLOW_PREFIX = '/__mokie/p/';

export type FlowResult = { status: number; headers: Record<string, string>; body: string; note: string };

export class FlowService {
  constructor(
    private repos: Repos,
    private state: StateStore,
  ) {}

  /** Create a session for page `slug` and return the absolute URL of its page. */
  createSession(slug: string, ctx: Record<string, unknown>, baseUrl: string): { token: string; url: string } {
    const page = this.repos.getFlowPageBySlug(slug);
    if (!page) throw new Error(`Pagina di flusso "${slug}" non trovata`);
    const token = randomBytes(12).toString('base64url');
    this.repos.createSession(token, slug, ctx);
    return { token, url: `${baseUrl}${FLOW_PREFIX}${token}` };
  }

  private load(token: string): { page: FlowPage; session: FlowSession } | FlowResult {
    const session = this.repos.getSession(token);
    if (!session) return html(404, renderErrorPage('Sessione non trovata', 'Il link non è valido o la sessione è stata cancellata.'), 'session not found');
    const page = this.repos.getFlowPageBySlug(session.pageSlug);
    if (!page) return html(404, renderErrorPage('Pagina non trovata', `La pagina "${session.pageSlug}" non esiste più.`), 'page not found');
    if (session.status === 'pending' && page.ttlSeconds > 0) {
      const age = (Date.now() - Date.parse(session.createdAt)) / 1000;
      if (age > page.ttlSeconds) {
        this.repos.expireSession(token);
        session.status = 'expired';
      }
    }
    if (session.status === 'expired') return html(410, renderErrorPage('Sessione scaduta', 'Questa sessione non è più valida.'), 'session expired');
    if (session.status === 'completed')
      return html(
        409,
        renderErrorPage('Sessione già completata', `È già stata scelta l'azione "${session.chosenCta}".`),
        'session already completed',
      );
    return { page, session };
  }

  /** GET /__mokie/p/:token — render the page, or act directly when `?choose=<ctaId>` is given. */
  async show(token: string, query: Record<string, string | string[]>): Promise<FlowResult> {
    const l = this.load(token);
    if ('status' in l) return l;
    const choose = typeof query.choose === 'string' ? query.choose : undefined;
    if (choose) return this.choose(token, choose);
    return html(200, renderFlowPage(l.page, l.session, `${FLOW_PREFIX}${token}`), `flow page ${l.page.slug}`);
  }

  /** POST /__mokie/p/:token/cta/:ctaId — apply CTA effects and redirect. */
  async choose(token: string, ctaId: string): Promise<FlowResult> {
    const l = this.load(token);
    if ('status' in l) return l;
    const { page, session } = l;
    const cta = page.ctas.find((c) => c.id === ctaId);
    if (!cta) return html(400, renderErrorPage('Azione non valida', `CTA "${ctaId}" non definita per la pagina "${page.slug}".`), 'unknown cta');

    const tctx = { ctx: session.context, session, cta, state: this.state.all() };
    applyEffects(cta.effects, this.state, tctx);
    this.repos.completeSession(token, cta.id);
    if (cta.delayMs) await new Promise((r) => setTimeout(r, cta.delayMs));

    const target = this.redirectTarget(page, cta, tctx);
    if (!target.url) {
      return html(200, renderResultPage(page, cta, target.error), `cta ${cta.id} (no redirect)`);
    }
    return { status: 303, headers: { location: target.url, 'cache-control': 'no-store' }, body: '', note: `cta ${cta.id} → ${target.url}` };
  }

  redirectTarget(page: FlowPage, cta: Cta, tctx: Record<string, unknown>): { url?: string; error?: string } {
    const raw = render(page.redirectTemplate || '{{ctx.redirectUrl}}', tctx).trim();
    if (!raw) return { error: 'Nessun redirect URL nel contesto della sessione.' };
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { error: `Redirect URL non valido: ${raw}` };
    }
    for (const [k, v] of Object.entries(cta.redirectParams)) {
      const val = render(v, tctx);
      if (val !== '') u.searchParams.set(k, val);
    }
    return { url: u.toString() };
  }
}

function html(status: number, body: string, note: string): FlowResult {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body, note };
}
