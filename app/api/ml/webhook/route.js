import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { queryRaw } from '@/lib/db';
import { getTokenValido, sincronizarPedidoPorId } from '@/lib/ml';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * O Mercado Livre espera HTTP 200 em até 500 ms, senão desativa os tópicos.
 * Por isso respondemos primeiro e processamos depois, com after().
 */
export async function POST(req) {
  let corpo = null;
  try {
    corpo = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  after(async () => {
    try {
      await queryRaw(
        `INSERT INTO fila_webhook (notification_id, topic, resource) VALUES ($1,$2,$3)`,
        [corpo._id ?? null, corpo.topic ?? null, corpo.resource ?? null]
      );

      const m = String(corpo.resource || '').match(/^\/orders\/(\d+)/);
      if (m) {
        const { token } = await getTokenValido();
        await sincronizarPedidoPorId(m[1], token);
        await queryRaw(
          `UPDATE fila_webhook SET processado = true WHERE notification_id = $1`,
          [corpo._id ?? null]
        );
      }
    } catch (e) {
      console.error('webhook', e.message);
    }
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, info: 'Endpoint de notificações do Mercado Livre.' });
}
