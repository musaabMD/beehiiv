// Live event room Durable Object: chat + WebRTC signaling (owned by the events module).
export class LiveRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: unknown) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
