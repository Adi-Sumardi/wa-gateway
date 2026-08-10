// Thin wrapper around NATS core pub/sub, shared (via file copy - no private
// npm registry here) by every service. Subjects are dot-separated and mirror
// the event catalog from the architecture review, e.g. "ai.escalation.created".
import { connect, NatsConnection, StringCodec, Subscription } from 'nats';

const sc = StringCodec();
let conn: NatsConnection | null = null;

export async function getEventBus(): Promise<NatsConnection> {
  if (conn) return conn;
  const servers = process.env.NATS_URL || 'nats://localhost:4222';
  conn = await connect({ servers });
  console.log(`[events] connected to NATS at ${servers}`);
  return conn;
}

export async function publish(subject: string, payload: unknown): Promise<void> {
  const nc = await getEventBus();
  nc.publish(subject, sc.encode(JSON.stringify(payload)));
}

// subject supports NATS wildcards ("ai.escalation.*", "device.>")
export async function subscribe(subject: string, handler: (payload: any, subject: string) => void | Promise<void>): Promise<Subscription> {
  const nc = await getEventBus();
  const sub = nc.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data));
        await handler(payload, msg.subject);
      } catch (err) {
        console.error(`[events] handler error for ${msg.subject}:`, err);
      }
    }
  })();
  return sub;
}
